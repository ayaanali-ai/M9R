import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { CONNECTION_CLAIM_TTL_MS, newConnectionId, usableConnectionClaim } from "@/lib/native/mcp-connection-core";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { handleHookEvent } from "@/lib/native/hook-handler";

function tempStore(
  now: () => Date = () => new Date("2026-10-15T18:00:00.000Z"),
  isProcessAlive?: (pid: number) => boolean,
) {
  const testRoot = join(process.cwd(), ".test-tmp");
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, "m9r-connection-test-"));
  const deps = { now, ...(isProcessAlive ? { isProcessAlive } : {}) };
  return { root, store: createLocalStore(root, deps), done: () => rmSync(root, { recursive: true, force: true }) };
}

function persistedClaims(root: string): Array<{ sessionId: string; handle: string; provider: string; cwd?: string; ownerProcessId?: number; bindingId?: string }> {
  return (JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as { connectionClaims: Array<{ sessionId: string; handle: string; provider: string; cwd?: string; ownerProcessId?: number; bindingId?: string }> }).connectionClaims;
}

test("connection claims are opaque and reject expiry, provider mismatch, and process mismatch", () => {
  const claim = {
    claimId: newConnectionId(),
    handle: "codex",
    provider: "codex",
    sessionId: "session-1",
    ownerProcessId: 1234,
    issuedAt: "2026-10-15T18:00:00.000Z",
    expiresAt: new Date(Date.parse("2026-10-15T18:00:00.000Z") + CONNECTION_CLAIM_TTL_MS).toISOString(),
  };
  assert.match(claim.claimId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(usableConnectionClaim(claim, Date.parse("2026-10-15T18:00:01.000Z"), { provider: "codex", processId: 1234 }), true);
  assert.equal(usableConnectionClaim(claim, Date.parse("2026-10-15T18:00:01.000Z"), { provider: "claude-code", processId: 1234 }), false);
  assert.equal(usableConnectionClaim(claim, Date.parse("2026-10-15T18:00:01.000Z"), { provider: "codex", processId: 4321 }), false);
  assert.equal(usableConnectionClaim(claim, Date.parse("2026-10-15T18:20:00.000Z"), { provider: "codex", processId: 1234 }), false);
});

test("malformed persisted claims fail closed instead of crashing future providers", () => {
  assert.equal(usableConnectionClaim({ provider: undefined } as never, Date.now()), false);
  assert.equal(usableConnectionClaim({
    claimId: "claim",
    handle: "provider",
    provider: "provider",
    sessionId: "session",
    issuedAt: "not-a-date",
    expiresAt: new Date(Date.now() + CONNECTION_CLAIM_TTL_MS).toISOString(),
  }, Date.now()), false);
  assert.doesNotThrow(() => usableConnectionClaim({ provider: undefined } as never, Date.now(), { provider: "future-provider" }));
});

test("a private claim binds only to its exact active provider session and is idempotent", () => {
  const { store, done } = tempStore();
  try {
    store.issueIdentity("codex", "codex", "session-1");
    const claim = store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-1", cwd: "C:/work", ownerProcessId: 1234 });
    const binding = store.bindConnectionClaim(claim.claimId, { provider: "codex", processId: 1234 });
    assert.ok(binding);
    assert.deepEqual(store.verifyConnectionBinding(binding!.bindingId), { handle: "codex", provider: "codex", sessionId: "session-1" });
    assert.equal(store.bindConnectionClaim(claim.claimId, { provider: "codex", processId: 1234 })?.bindingId, binding!.bindingId);
    assert.equal(store.bindConnectionClaim(claim.claimId, { provider: "codex", processId: 4321 })?.bindingId, binding!.bindingId, "an already-bound explicit claim remains restart-safe");
  } finally { done(); }
});

test("a durable binding survives claim expiry and a later SessionStart refresh", () => {
  let current = new Date("2026-10-15T18:00:00.000Z");
  const { store, done } = tempStore(() => current);
  try {
    store.issueIdentity("agent", "future-provider", "session-1");
    const claim = store.issueConnectionClaim({
      handle: "agent",
      provider: "future-provider",
      sessionId: "session-1",
      ownerProcessId: 1234,
    });
    const binding = store.bindConnectionClaim(claim.claimId, { provider: "future-provider", processId: 1234 });
    assert.ok(binding);

    current = new Date(Date.parse(claim.expiresAt) + 1);
    assert.deepEqual(
      store.verifyConnectionBinding(binding!.bindingId),
      { handle: "agent", provider: "future-provider", sessionId: "session-1" },
      "an active identity keeps its durable binding usable after the private claim TTL",
    );
    assert.equal(
      store.bindConnectionForProcess({ provider: "future-provider", processId: 1234 })?.bindingId,
      binding!.bindingId,
      "worker reconnect must reuse the durable binding rather than require a new credential",
    );

    const refreshed = store.issueConnectionClaim({
      handle: "agent",
      provider: "future-provider",
      sessionId: "session-1",
      ownerProcessId: 5678,
    });
    assert.equal(refreshed.claimId, claim.claimId, "SessionStart refreshes the existing session claim");
    assert.equal(refreshed.bindingId, binding!.bindingId, "refresh preserves the durable binding identity");
    assert.equal(
      store.bindConnectionForProcess({ provider: "future-provider", processId: 5678 })?.bindingId,
      binding!.bindingId,
      "a provider parent replacement can reattach without manual token copying",
    );
  } finally { done(); }
});

test("process discovery fails closed when two sessions share one provider process", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    store.issueIdentity("codex", "codex", "session-a");
    store.issueIdentity("codex", "codex", "session-b");
    store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-a", ownerProcessId: 999 });
    store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-b", ownerProcessId: 999 });
    assert.equal(store.bindConnectionForProcess({ provider: "codex", processId: 999 }), null);
  } finally { done(); }
});

test("a provider continuation reuses the existing claim and binding for the same process", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    store.issueIdentity("claude", "claude-code", "session-old");
    const oldClaim = store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "session-old",
      cwd: "C:/work",
      ownerProcessId: 4242,
    });
    const oldBinding = store.bindConnectionClaim(oldClaim.claimId, { provider: "claude-code", processId: 4242 });
    assert.ok(oldBinding);

    store.issueIdentity("claude", "claude-code", "session-new");
    const continuationInput = {
      handle: "claude",
      provider: "claude-code",
      sessionId: "session-new",
      cwd: "C:/work",
      ownerProcessId: 4242,
      continuation: true,
    };
    const newClaim = store.issueConnectionClaim(continuationInput as Parameters<typeof store.issueConnectionClaim>[0]);

    const claims = persistedClaims(store.root);
    assert.deepEqual(claims.map((claim) => claim.sessionId), ["session-new"]);
    assert.equal(newClaim.bindingId, oldBinding!.bindingId);
    assert.deepEqual(store.verifyConnectionBinding(oldBinding!.bindingId), {
      handle: "claude",
      provider: "claude-code",
      sessionId: "session-new",
    });
    assert.equal(store.identityTokenFor("claude", "session-old"), null, "the superseded session identity is retired");
  } finally { done(); }
});

test("a new SessionStart retires a dead unbound claim in the same provider/project scope", () => {
  const { store, done } = tempStore(undefined, (pid) => pid === 1002);
  try {
    store.issueIdentity("claude", "claude-code", "old-session");
    store.issueIdentity("claude", "claude-code", "new-session");
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "old-session", cwd: "C:/work", ownerProcessId: 1001 });
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "new-session", cwd: "C:/work", ownerProcessId: 1002 });

    const claims = persistedClaims(store.root);
    assert.deepEqual(claims.map((claim) => claim.sessionId), ["new-session"]);
  } finally { done(); }
});

test("claim reconciliation preserves a genuinely live competing session", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    store.issueIdentity("claude", "claude-code", "old-session");
    store.issueIdentity("claude", "claude-code", "new-session");
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "old-session", cwd: "C:/work", ownerProcessId: 2001 });
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "new-session", cwd: "C:/work", ownerProcessId: 2002 });

    assert.deepEqual(persistedClaims(store.root).map((claim) => claim.sessionId), ["old-session", "new-session"]);
  } finally { done(); }
});

test("claim reconciliation does not retire a dead claim from another project scope", () => {
  const { store, done } = tempStore(undefined, (pid) => pid === 3002);
  try {
    store.issueIdentity("claude", "claude-code", "other-project-session");
    store.issueIdentity("claude", "claude-code", "current-project-session");
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "other-project-session", cwd: "C:/other", ownerProcessId: 3001 });
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "current-project-session", cwd: "C:/work", ownerProcessId: 3002 });

    assert.deepEqual(persistedClaims(store.root).map((claim) => claim.sessionId), ["other-project-session", "current-project-session"]);
  } finally { done(); }
});

test("a new provider session does not inherit a dead prior session's binding", () => {
  const { store, done } = tempStore(undefined, (pid) => pid === 9002);
  try {
    store.issueIdentity("claude", "claude-code", "old-session");
    const oldClaim = store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "old-session",
      cwd: "C:/work",
      ownerProcessId: 9001,
    });
    const oldBinding = store.bindConnectionClaim(oldClaim.claimId, {
      provider: "claude-code",
      processId: 9001,
    });
    assert.ok(oldBinding);

    store.issueIdentity("claude", "claude-code", "new-session");
    store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "new-session",
      cwd: "C:/work",
      ownerProcessId: 9002,
    });

    const recovered = store.bindConnectionForProcess({ provider: "claude-code", processId: 9002 });
    assert.ok(recovered);
    assert.notEqual(recovered!.bindingId, oldBinding!.bindingId, "a new session must not inherit a prior session binding");
    assert.equal(store.verifyConnectionBinding(oldBinding!.bindingId), null, "a dead prior session binding must be retired when the replacement session starts");
    assert.deepEqual(store.verifyConnectionBinding(recovered!.bindingId), {
      handle: "claude",
      provider: "claude-code",
      sessionId: "new-session",
    });
  } finally { done(); }
});

test("revoking a provider identity invalidates its existing connection binding", () => {
  const { store, done } = tempStore();
  try {
    store.issueIdentity("claude", "claude-code", "session-1");
    const claim = store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "session-1" });
    const binding = store.bindConnectionClaim(claim.claimId, { provider: "claude-code" });
    assert.ok(binding);
    store.revokeIdentity("session-1");
    assert.equal(store.verifyConnectionBinding(binding!.bindingId), null);
  } finally { done(); }
});

test("a bound MCP connection answers without a tool-call credential, even though the token field stays present (optional, uniform across every connection)", async () => {
  const { store, done } = tempStore();
  try {
    store.issueIdentity("codex", "codex", "session-1");
    store.registerEndpoint({ provider: "codex", sessionId: "session-1", cwd: "C:/repo" });
    const claim = store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-1" });
    const binding = store.bindConnectionClaim(claim.claimId, { provider: "codex" });
    assert.ok(binding);
    const server = createM9rMcpServer({ store, connectionBindingId: binding!.bindingId });
    const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema: { shape?: Record<string, { optional?: unknown }> }; handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    // The native MCP surface must never re-expose the retired browser-extension
    // route. The implementation remains in the repository for explicit legacy
    // fixtures, but no active provider connection may discover or call it.
    assert.deepEqual(Object.keys(tools).filter((toolName) => toolName.startsWith("m9r_web_")), []);
    for (const toolName of ["m9r_whoami", "m9r_stage_app", "m9r_stage_action", "m9r_computer_observe", "m9r_computer_action"]) {
      // The field itself is always present now (one uniform schema for every connection, see
      // mcp-server.ts's OPTIONAL_TOKEN_FIELD) -- what must hold is that it is never required.
      const tokenSchema = tools[toolName]?.inputSchema.shape?.token;
      assert.ok(tokenSchema, `${toolName} must still declare a token field`);
      assert.equal((tokenSchema as { type?: string }).type, "optional", `${toolName}'s token field must be optional, not required`);
    }
    const result = await tools.m9r_whoami.handler({});
    assert.equal(result.content[0]!.text, "You are @codex (codex).");
    assert.doesNotMatch(result.content[0]!.text, /session|token/i);
  } finally { done(); }
});

test("a provider that starts MCP before its hook binds later without guessing", async () => {
  const { store, done } = tempStore();
  try {
    const server = createM9rMcpServer({ store, connectionProcessId: 4545, connectionProvider: "local-provider" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    await assert.rejects(() => tools.m9r_whoami.handler({}), /Automatic M9R provider binding did not become ready/);

    // This is the normal ordering race: the provider child exists first, then
    // its verified SessionStart hook issues the claim. The exact PID is the
    // only selector; a second claim would be rejected instead of guessed.
    store.issueIdentity("local-provider", "Local-Provider", "session-1");
    store.issueConnectionClaim({ handle: "local-provider", provider: "local-provider", sessionId: "session-1", ownerProcessId: 4545 });
    const result = await tools.m9r_whoami.handler({});
    assert.equal(result.content[0]!.text, "You are @local-provider (Local-Provider).");
  } finally { done(); }
});

test("a delayed provider binding wait does not block unrelated local work", async () => {
  const { store, done } = tempStore();
  try {
    const server = createM9rMcpServer({
      store,
      connectionProcessId: 4546,
      connectionProvider: "local-provider",
      connectionWaitMs: 120,
      connectionPollMs: 20,
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 10);
    await assert.rejects(() => tools.m9r_whoami.handler({}), /Automatic M9R provider binding did not become ready/);
    clearTimeout(timer);
    assert.equal(timerFired, true, "the async binding wait must yield the event loop");
  } finally { done(); }
});

test("an existing provider-only MCP connection self-heals a dead competing claim without a new SessionStart", async () => {
  const livePids = new Set([31384, 28328]);
  const { store, done } = tempStore(undefined, (pid) => livePids.has(pid));
  try {
    store.issueIdentity("claude", "claude-code", "old-session");
    store.issueIdentity("claude", "claude-code", "current-session");
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "old-session", cwd: "C:/work", ownerProcessId: 31384 });
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "current-session", cwd: "C:/work", ownerProcessId: 28328 });

    // The provider process that issued the old claim has exited, but the
    // current MCP transport is still alive and has no explicit PID in its
    // environment. Recovery must prune only the provably dead claim and bind
    // the one remaining session; opening a new provider session is forbidden.
    livePids.delete(31384);
    const server = createM9rMcpServer({ store, connectionProvider: "claude-code" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});
    assert.equal(result.content[0]!.text, "You are @claude (claude-code).");
    assert.deepEqual(persistedClaims(store.root).map((claim) => claim.sessionId), ["current-session"]);
  } finally { done(); }
});

test("a provider update recovers the sole recent session without a new SessionStart or manual token", async () => {
  const { store, done } = tempStore();
  try {
    // The provider process survived or was replaced while its updated
    // plugin skipped the hook. One fresh endpoint makes recovery
    // deterministic and keeps all identity material inside the host.
    store.registerEndpoint({ provider: "opencode", sessionId: "existing-session", cwd: "C:/work" });
    const server = createM9rMcpServer({
      store,
      connectionProvider: "opencode",
      connectionProcessId: 7777,
      connectionCwd: "C:/work",
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});
    assert.equal(result.content[0]!.text, "You are @opencode (opencode).");
    assert.ok(store.identityTokenFor("opencode", "existing-session"), "recovery creates a private identity, never a provider-visible token");
    assert.ok(persistedClaims(store.root)[0]?.bindingId, "recovery binds the current MCP worker");
  } finally { done(); }
});

test("a provider update recovers a sole session older than the claim window without a fresh session", async () => {
  let current = new Date("2026-10-15T18:00:00.000Z");
  const { store, done } = tempStore(() => current);
  try {
    store.registerEndpoint({ provider: "opencode", sessionId: "surviving-session", cwd: "C:/work" });
    current = new Date("2026-10-15T19:00:00.000Z");
    const server = createM9rMcpServer({
      store,
      connectionProvider: "opencode",
      connectionProcessId: 7780,
      connectionCwd: "C:/work",
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});
    assert.equal(result.content[0]!.text, "You are @opencode (opencode).");
    assert.ok(persistedClaims(store.root)[0]?.bindingId);
  } finally { done(); }
});

test("a live provider adapter rebinds the same durable session after a long outage and PID change", () => {
  let current = new Date("2026-10-15T18:00:00.000Z");
  const { store, done } = tempStore(() => current, (pid) => pid === 9002);
  try {
    store.registerEndpoint({ provider: "opencode", sessionId: "same-session", cwd: "C:/work" });
    store.issueIdentity("opencode", "opencode", "same-session");
    const claim = store.issueConnectionClaim({
      handle: "opencode",
      provider: "opencode",
      sessionId: "same-session",
      cwd: "C:/work",
      ownerProcessId: 9001,
    });
    const binding = store.bindConnectionClaim(claim.claimId, { provider: "opencode", processId: 9001 });
    assert.ok(binding);

    // The conversation is still the same, but the old provider process has
    // gone away and the machine was offline longer than the conservative
    // stored-session recovery window.
    current = new Date("2026-10-30T18:00:00.000Z");
    const rebound = store.reconcileLiveProviderConnection({
      provider: "opencode",
      sessionId: "same-session",
      cwd: "C:/work",
      processId: 9002,
    });

    assert.ok(rebound);
    assert.equal(rebound!.bindingId, binding!.bindingId, "the durable binding remains the same");
    assert.equal(rebound!.ownerProcessId, 9002, "only the current verified provider process is attached");
    assert.deepEqual(store.verifyConnectionBinding(rebound!.bindingId), {
      handle: "opencode",
      provider: "opencode",
      sessionId: "same-session",
    });
  } finally { done(); }
});

test("provider reconnect refuses to guess when more than one recent session is eligible", async () => {
  const { store, done } = tempStore();
  try {
    store.registerEndpoint({ provider: "opencode", sessionId: "session-a", cwd: "C:/work" });
    store.registerEndpoint({ provider: "opencode", sessionId: "session-b", cwd: "C:/work" });
    const server = createM9rMcpServer({ store, connectionProvider: "opencode", connectionProcessId: 7778, connectionCwd: "C:/work" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    await assert.rejects(() => tools.m9r_whoami.handler({}), /Automatic M9R provider binding did not become ready/);
    assert.equal(persistedClaims(store.root).length, 0, "ambiguous recovery must not issue a claim");
  } finally { done(); }
});

test("provider reconnect does not revive an explicitly revoked session", async () => {
  const { store, done } = tempStore();
  try {
    store.registerEndpoint({ provider: "opencode", sessionId: "revoked-session", cwd: "C:/work" });
    store.issueIdentity("opencode", "opencode", "revoked-session");
    store.revokeIdentity("revoked-session");
    const server = createM9rMcpServer({ store, connectionProvider: "opencode", connectionProcessId: 7779, connectionCwd: "C:/work" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    await assert.rejects(() => tools.m9r_whoami.handler({}), /Automatic M9R provider binding did not become ready/);
    assert.equal(persistedClaims(store.root).length, 0);
  } finally { done(); }
});

test("a provider-only connection adopts its sole active claim after the previous provider owner exits", async () => {
  const { store, done } = tempStore(undefined, (pid) => pid === 9002);
  try {
    store.issueIdentity("claude", "claude-code", "continued-session");
    store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "continued-session",
      ownerProcessId: 9001,
    });

    const server = createM9rMcpServer({
      store,
      connectionProvider: "claude-code",
      connectionProcessId: 9002,
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});

    assert.match(result.content[0]!.text, /@claude \(claude-code\)\./);
    const claims = persistedClaims(store.root);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.ownerProcessId, 9002);
    assert.ok(claims[0]!.bindingId, "the adopted claim must receive a durable binding");
  } finally { done(); }
});

test("a provider MCP worker reassigns a durable binding after its recorded owner exits", () => {
  const { store, done } = tempStore(undefined, (pid) => pid === 9002);
  try {
    store.issueIdentity("claude", "claude-code", "durable-session");
    const claim = store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "durable-session",
      ownerProcessId: 9001,
    });
    const original = store.bindConnectionClaim(claim.claimId, { provider: "claude-code", processId: 9001 });
    assert.ok(original);

    const recovered = store.bindConnectionForProcess({ provider: "claude-code", processId: 9002 });
    assert.ok(recovered);
    assert.equal(recovered!.bindingId, original!.bindingId, "recovery must preserve the durable binding identity");
    const state = JSON.parse(readFileSync(join(store.root, "state.json"), "utf8")) as {
      connectionClaims: Array<{ ownerProcessId?: number }>;
      connectionBindings: Array<{ ownerProcessId?: number }>;
    };
    assert.equal(state.connectionClaims[0]!.ownerProcessId, 9002);
    assert.equal(state.connectionBindings[0]!.ownerProcessId, 9002);
  } finally { done(); }
});

test("a legacy null owner on a durable binding is treated as unowned during reconnect", () => {
  const { root, store, done } = tempStore(undefined, () => false);
  try {
    store.issueIdentity("claude", "claude-code", "legacy-null-owner");
    const claim = store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "legacy-null-owner",
      ownerProcessId: 9001,
    });
    const original = store.bindConnectionClaim(claim.claimId, { provider: "claude-code", processId: 9001 });
    assert.ok(original);

    // Older builds serialized an absent optional process id as JSON null. The
    // TypeScript model calls that field optional, but reconnect must explicitly
    // normalize the legacy representation before testing ownership.
    const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as {
      connectionClaims: Array<{ ownerProcessId?: number | null }>;
      connectionBindings: Array<{ ownerProcessId?: number | null }>;
    };
    state.connectionClaims[0]!.ownerProcessId = null;
    state.connectionBindings[0]!.ownerProcessId = null;
    writeFileSync(join(root, "state.json"), JSON.stringify(state), "utf8");

    const recovered = createLocalStore(root, { isProcessAlive: () => false })
      .bindConnectionForProcess({ provider: "claude-code", processId: 9002 });
    assert.ok(recovered);
    assert.equal(recovered!.bindingId, original!.bindingId);
    const repaired = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as {
      connectionClaims: Array<{ ownerProcessId?: number }>;
      connectionBindings: Array<{ ownerProcessId?: number }>;
    };
    assert.equal(repaired.connectionClaims[0]!.ownerProcessId, 9002);
    assert.equal(repaired.connectionBindings[0]!.ownerProcessId, 9002);
  } finally { done(); }
});

test("a fresh endpoint reconciles an older duplicate binding from the same provider process", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    store.issueIdentity("opencode", "opencode", "old-session");
    store.issueIdentity("opencode", "opencode", "current-session");
    const oldClaim = store.issueConnectionClaim({ handle: "opencode", provider: "opencode", sessionId: "old-session", cwd: "C:/work", ownerProcessId: 9001 });
    const currentClaim = store.issueConnectionClaim({ handle: "opencode", provider: "opencode", sessionId: "current-session", cwd: "C:/work", ownerProcessId: 9001 });
    store.bindConnectionClaim(oldClaim.claimId, { provider: "opencode", processId: 9001 });
    store.bindConnectionClaim(currentClaim.claimId, { provider: "opencode", processId: 9001 });
    store.registerEndpoint({ provider: "opencode", sessionId: "current-session", cwd: "C:/work" });

    const recovered = store.bindConnectionForProcess({ provider: "opencode", processId: 9001 });
    assert.ok(recovered);
    assert.equal(recovered!.sessionId, "current-session");
    const state = JSON.parse(readFileSync(join(store.root, "state.json"), "utf8")) as {
      connectionClaims: Array<{ sessionId: string }>;
      connectionBindings: Array<{ sessionId: string }>;
    };
    assert.deepEqual(state.connectionClaims.map((claim) => claim.sessionId), ["current-session"]);
    assert.deepEqual(state.connectionBindings.map((binding) => binding.sessionId), ["current-session"]);
  } finally { done(); }
});

test("a provider-only MCP connection adopts its sole unbound claim after the owner exits", async () => {
  const { store, done } = tempStore(undefined, () => false);
  try {
    store.issueIdentity("claude", "claude-code", "provider-only-restart");
    store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "provider-only-restart",
      ownerProcessId: 9001,
    });

    const server = createM9rMcpServer({ store, connectionProvider: "claude-code" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});
    assert.match(result.content[0]!.text, /@claude \(claude-code\)\./);
    assert.ok(persistedClaims(store.root)[0]!.bindingId);
  } finally { done(); }
});

test("an already-running worker with lost launch metadata adopts only one unbound claim", async () => {
  const { store, done } = tempStore(undefined, () => false);
  try {
    store.issueIdentity("claude", "claude-code", "worker-recovery");
    store.issueConnectionClaim({
      handle: "claude",
      provider: "claude-code",
      sessionId: "worker-recovery",
      ownerProcessId: 9001,
    });

    // This models a provider-owned MCP supervisor that was launched by an
    // older M9R image without provider env, while its private worker has
    // already been refreshed to the current image. The worker may recover
    // only the sole active claim; it must not invent a provider identity or
    // ask the user to copy a legacy token.
    const server = createM9rMcpServer({ store, connectionWorkerFallback: true });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});
    assert.match(result.content[0]!.text, /@claude \(claude-code\)\./);
    assert.ok(persistedClaims(store.root)[0]!.bindingId);
  } finally { done(); }
});

test("worker fallback stays fail-closed when more than one provider claim is active", async () => {
  const { store, done } = tempStore(undefined, () => false);
  try {
    store.issueIdentity("claude", "claude-code", "worker-a");
    store.issueIdentity("opencode", "opencode", "worker-b");
    store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "worker-a", ownerProcessId: 9001 });
    store.issueConnectionClaim({ handle: "opencode", provider: "opencode", sessionId: "worker-b", ownerProcessId: 9002 });

    const server = createM9rMcpServer({ store, connectionWorkerFallback: true });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    await assert.rejects(() => tools.m9r_whoami.handler({}), /Automatic M9R provider binding did not become ready/);
    assert.equal(persistedClaims(store.root).filter((claim) => claim.bindingId).length, 0);
  } finally { done(); }
});

test("the first provider tool call waits for a SessionStart claim published after MCP startup", async () => {
  const { store, done } = tempStore();
  try {
    store.issueIdentity("claude", "claude-code", "late-session");
    const bind = store.bindConnectionForProcess.bind(store);
    let attempts = 0;
    const delayedStore = {
      ...store,
      bindConnectionForProcess: (expected: Parameters<typeof store.bindConnectionForProcess>[0]) => {
        attempts += 1;
        if (attempts === 2) {
          store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId: "late-session", ownerProcessId: 9101 });
        }
        return bind(expected);
      },
    } as typeof store;

    const server = createM9rMcpServer({
      store: delayedStore,
      connectionProvider: "claude-code",
      connectionProcessId: 9101,
      connectionWaitMs: 100,
      connectionPollMs: 1,
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});

    assert.match(result.content[0]!.text, /@claude \(claude-code\)\./);
    assert.ok(attempts >= 2, "the connection must be retried after the hook has time to publish its claim");
  } finally { done(); }
});

test("managed SessionStart creates a private claim and keeps credentials out of the provider card", async () => {
  const { store, done } = tempStore();
  try {
    const output = handleHookEvent({ hook_event_name: "SessionStart", session_id: "session-1", cwd: "C:/repo" }, {
      provider: "codex",
      store,
      providerProcessId: 4545,
    });
    assert.ok(output);
    const card = output!.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(card, /M9R session token/i);
    assert.ok(store.identityTokenFor("codex", "session-1"));

    const binding = store.bindConnectionForProcess({ provider: "codex", processId: 4545 });
    assert.ok(binding);
    assert.deepEqual(store.verifyConnectionBinding(binding!.bindingId), { handle: "codex", provider: "codex", sessionId: "session-1" });

    const server = createM9rMcpServer({ store, connectionProcessId: 4545, connectionProvider: "codex" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});
    assert.equal(result.content[0]!.text, "You are @codex (codex).");
  } finally { done(); }
});
