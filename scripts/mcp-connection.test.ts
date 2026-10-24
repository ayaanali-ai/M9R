import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { CONNECTION_CLAIM_TTL_MS, PROVIDER_TURN_TTL_MS, newConnectionId, sameConnectionCwd, usableConnectionClaim } from "@/lib/native/mcp-connection-core";
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

test("a new logical session sharing a provider process keeps its own identity and binding", () => {
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
    const nextSessionInput = {
      handle: "claude",
      provider: "claude-code",
      sessionId: "session-new",
      cwd: "C:/work",
      ownerProcessId: 4242,
    };
    const newClaim = store.issueConnectionClaim(nextSessionInput);

    const claims = persistedClaims(store.root);
    assert.deepEqual(claims.map((claim) => claim.sessionId), ["session-old", "session-new"]);
    assert.notEqual(newClaim.claimId, oldClaim.claimId, "a shared host PID must not merge distinct provider conversation identities");
    assert.equal(newClaim.bindingId, undefined);
    assert.deepEqual(store.verifyConnectionBinding(oldBinding!.bindingId), {
      handle: "claude",
      provider: "claude-code",
      sessionId: "session-old",
    });
    assert.ok(store.identityTokenFor("claude", "session-old"), "publishing a second session must not revoke the first session");
    assert.ok(store.identityTokenFor("claude", "session-new"));
  } finally { done(); }
});

test("active-turn binding selects the exact prompted session when several sessions share one provider process", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    for (const sessionId of ["session-a", "session-b"]) {
      store.issueIdentity("codex", "codex", sessionId);
      store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId, cwd: "C:/work", ownerProcessId: 5151 });
    }

    assert.equal(store.bindConnectionForProcess({ provider: "codex", processId: 5151 }), null,
      "process-only discovery remains fail-closed when the host owns multiple sessions");
    assert.equal(store.beginProviderTurn({ provider: "codex", sessionId: "session-b", cwd: "C:/work", processId: 5151 }), true);

    const resolution = store.bindActiveProviderTurn({ provider: "codex", processId: 5151 });
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.binding?.sessionId, "session-b");
    assert.equal(store.verifyConnectionBinding(resolution.binding!.bindingId)?.sessionId, "session-b");
    assert.deepEqual(persistedClaims(store.root).map((claim) => claim.sessionId), ["session-a", "session-b"],
      "selecting the active turn must not delete or rewrite the other session's claim");
  } finally { done(); }
});

test("project-folder binding selects the exact provider connection before shared-PID evidence", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    for (const [sessionId, cwd] of [["session-a", "C:/project-a"], ["session-b", "C:/project-b"]] as const) {
      store.issueIdentity("claude", "claude-code", sessionId);
      store.issueConnectionClaim({ handle: "claude", provider: "claude-code", sessionId, cwd, ownerProcessId: 8181 });
    }

    const binding = store.bindConnectionForProcess({ provider: "claude-code", processId: 8181, cwd: "c:\\project-b\\" });
    assert.equal(binding?.sessionId, "session-b");
    assert.equal(sameConnectionCwd(binding?.cwd, "c:\\project-b\\"), true);
  } finally { done(); }
});

test("overlapping provider turns on one host fail closed, and Stop releases only its exact turn", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    for (const sessionId of ["session-a", "session-b"]) {
      store.issueIdentity("codex", "codex", sessionId);
      store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId, cwd: "C:/work", ownerProcessId: 6161 });
    }

    store.beginProviderTurn({ provider: "codex", sessionId: "session-a", cwd: "C:/work", processId: 6161 });
    store.beginProviderTurn({ provider: "codex", sessionId: "session-b", cwd: "C:/work", processId: 6161 });
    assert.equal(store.bindActiveProviderTurn({ provider: "codex", processId: 6161 }).status, "ambiguous");

    store.endProviderTurn({ provider: "codex", sessionId: "session-a", processId: 6161 });
    const resolution = store.bindActiveProviderTurn({ provider: "codex", processId: 6161 });
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.binding?.sessionId, "session-b");
  } finally { done(); }
});

test("a delayed Codex Stop or Interrupt cannot close a newer turn in the same session", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    store.issueIdentity("codex", "codex", "session-one");
    store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-one", ownerProcessId: 6171 });
    assert.equal(store.beginProviderTurn({ provider: "codex", sessionId: "session-one", turnId: "turn-old", processId: 6171 }), true);
    assert.equal(store.beginProviderTurn({ provider: "codex", sessionId: "session-one", turnId: "turn-current", processId: 6171 }), true);

    store.endProviderTurn({ provider: "codex", sessionId: "session-one", turnId: "turn-old", processId: 6171 });
    const stillCurrent = store.bindActiveProviderTurn({ provider: "codex", processId: 6171 });
    assert.equal(stillCurrent.status, "resolved");
    assert.equal(stillCurrent.status === "resolved" ? stillCurrent.binding.sessionId : null, "session-one");

    store.endProviderTurn({ provider: "codex", sessionId: "session-one", turnId: "turn-current", processId: 6171 });
    assert.equal(store.bindActiveProviderTurn({ provider: "codex", processId: 6171 }).status, "none");
  } finally { done(); }
});

test("an abandoned provider turn expires without revoking its durable session identity", () => {
  let current = new Date("2026-10-15T18:00:00.000Z");
  const { store, done } = tempStore(() => current, () => true);
  try {
    store.issueIdentity("codex", "codex", "session-a");
    store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-a", ownerProcessId: 6262 });
    assert.equal(store.beginProviderTurn({ provider: "codex", sessionId: "session-a", processId: 6262 }), true);
    current = new Date(current.getTime() + PROVIDER_TURN_TTL_MS + 1);
    assert.equal(store.bindActiveProviderTurn({ provider: "codex", processId: 6262 }).status, "none");
    assert.ok(store.identityTokenFor("codex", "session-a"), "turn expiry is not session revocation");
  } finally { done(); }
});

test("an explicit provider session selector binds only that session when the host owns several", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    for (const sessionId of ["session-a", "session-b"]) {
      store.issueIdentity("codex", "codex", sessionId);
      store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId, ownerProcessId: 7272 });
    }
    const server = createM9rMcpServer({
      store,
      connectionProvider: "codex",
      connectionProcessId: 7272,
      connectionSessionId: "session-b",
      connectionWaitMs: 0,
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const result = await tools.m9r_whoami.handler({});
    assert.equal(result.content[0]!.text, "You are @codex (codex).");
    const claims = persistedClaims(store.root);
    assert.equal(claims.find((claim) => claim.sessionId === "session-b")?.bindingId !== undefined, true);
    assert.equal(claims.find((claim) => claim.sessionId === "session-a")?.bindingId, undefined);
  } finally { done(); }
});

test("one already-running MCP process follows successive exact provider turns instead of caching the first session", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    let firstClaim: ReturnType<typeof store.issueConnectionClaim> | undefined;
    for (const sessionId of ["session-a", "session-b"]) {
      store.issueIdentity("codex", "codex", sessionId);
      const claim = store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId, cwd: "C:/work", ownerProcessId: 7171 });
      if (sessionId === "session-a") firstClaim = claim;
    }
    assert.ok(firstClaim);
    const staleLaunchBinding = store.bindConnectionClaim(firstClaim!.claimId, { provider: "codex", processId: 7171 });
    assert.ok(staleLaunchBinding);
    const server = createM9rMcpServer({
      store,
      connectionProvider: "codex",
      connectionProcessId: 7171,
      connectionBindingId: staleLaunchBinding!.bindingId,
      connectionWaitMs: 0,
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    store.beginProviderTurn({ provider: "codex", sessionId: "session-a", cwd: "C:/work", processId: 7171 });
    const first = await tools.m9r_whoami.handler({});
    assert.equal(first.content[0]!.text, "You are @codex (codex).");
    const firstBinding = store.bindActiveProviderTurn({ provider: "codex", processId: 7171 });
    assert.equal(firstBinding.status, "resolved");
    assert.equal(firstBinding.status === "resolved" ? firstBinding.binding.sessionId : null, "session-a");

    store.endProviderTurn({ provider: "codex", sessionId: "session-a", processId: 7171 });
    store.beginProviderTurn({ provider: "codex", sessionId: "session-b", cwd: "C:/work", processId: 7171 });
    await tools.m9r_whoami.handler({});
    const secondBinding = store.bindActiveProviderTurn({ provider: "codex", processId: 7171 });
    assert.equal(secondBinding.status, "resolved");
    assert.equal(secondBinding.status === "resolved" ? secondBinding.binding.sessionId : null, "session-b",
      "the shared MCP process must resolve the active conversation afresh on every tool call");
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

test("an existing provider MCP connection reconciles its exact live host session when hooks did not publish a claim", async () => {
  const { store, done } = tempStore();
  try {
    let reconciliationCalls = 0;
    const deps = {
      store,
      connectionProvider: "codex",
      connectionProcessId: 4547,
      connectionCwd: "C:/repo",
      reconcileProviderConnection: async (input: { provider: string; processId?: number; sessionId?: string; cwd?: string }) => {
        reconciliationCalls += 1;
        assert.deepEqual(input, { provider: "codex", processId: 4547, cwd: "C:/repo" });
        // Test adapter: the production observer must supply this exact live
        // session/PID pair before the store is allowed to create a binding.
        store.reconcileLiveProviderConnection({
          provider: input.provider,
          sessionId: "current-provider-session",
          processId: input.processId,
          cwd: input.cwd,
        });
        return { healthy: true, detail: "live session matched the exact host process" };
      },
    };
    const server = createM9rMcpServer(deps as Parameters<typeof createM9rMcpServer>[0]);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    const result = await tools.m9r_whoami.handler({});

    assert.equal(result.content[0]!.text, "You are @codex (codex).");
    assert.equal(reconciliationCalls, 1, "one failed direct lookup triggers one live-session reconciliation");
    assert.deepEqual(persistedClaims(store.root).map((claim) => claim.sessionId), ["current-provider-session"]);
    assert.equal(persistedClaims(store.root)[0]?.ownerProcessId, 4547);
  } finally { done(); }
});

test("an exact live-session result resolves the current turn when process-wide claims are ambiguous", async () => {
  const { store, done } = tempStore();
  try {
    const processId = 4548;
    for (const sessionId of ["inactive-sibling", "current-provider-session"]) {
      store.registerEndpoint({ provider: "codex", sessionId, cwd: "C:/repo" });
      store.issueIdentity("codex", "codex", sessionId);
      const claim = store.issueConnectionClaim({
        handle: "codex",
        provider: "codex",
        sessionId,
        cwd: "C:/repo",
        ownerProcessId: processId,
      });
      assert.ok(store.bindConnectionClaim(claim.claimId, { provider: "codex", processId }));
    }

    const exactBinding = store.reconcileLiveProviderConnection({
      provider: "codex",
      sessionId: "current-provider-session",
      cwd: "C:/repo",
      processId,
    });
    assert.ok(exactBinding);
    const bindByProcess = store.bindConnectionForProcess.bind(store);
    store.bindConnectionForProcess = (expected) => expected.provider === "codex" && expected.processId === processId
      ? null
      : bindByProcess(expected);
    store.recoverProviderConnection = () => null;
    const verifiedSessions: string[] = [];
    const verify = store.verifyConnectionBinding.bind(store);
    store.verifyConnectionBinding = (bindingId) => {
      const identity = verify(bindingId);
      if (identity) verifiedSessions.push(identity.sessionId);
      return identity;
    };

    let reconciliationCalls = 0;
    const server = createM9rMcpServer({
      store,
      connectionProvider: "codex",
      connectionProcessId: processId,
      connectionCwd: "C:/repo",
      connectionWaitMs: 0,
      reconcileProviderConnection: async () => {
        reconciliationCalls += 1;
        return { healthy: true, detail: "exact live Codex session and owning process verified", binding: exactBinding! };
      },
    } as unknown as Parameters<typeof createM9rMcpServer>[0]);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    const result = await tools.m9r_whoami.handler({});

    assert.equal(result.content[0]!.text, "You are @codex (codex).");
    assert.equal(reconciliationCalls, 1);
    assert.ok(verifiedSessions.includes("current-provider-session"),
      "MCP must use the exact binding returned by the provider observer, not rerun an ambiguous process-only lookup");
    assert.equal(persistedClaims(store.root).length, 2, "resolving the exact session must preserve the sibling session claim");
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

test("live provider reconciliation binds each exact session instead of returning another session's provider-wide binding", () => {
  const { store, done } = tempStore();
  try {
    const first = store.reconcileLiveProviderConnection({
      provider: "opencode",
      sessionId: "session-a",
      cwd: "C:/work",
    });
    assert.equal(first?.sessionId, "session-a");

    const second = store.reconcileLiveProviderConnection({
      provider: "opencode",
      sessionId: "session-b",
      cwd: "C:/work",
    });

    assert.equal(second?.sessionId, "session-b", "an exact live session observation must never resolve through another session's provider-wide binding");
    assert.deepEqual(store.verifyConnectionBinding(first!.bindingId), {
      handle: "opencode",
      provider: "opencode",
      sessionId: "session-a",
    });
    assert.deepEqual(store.verifyConnectionBinding(second!.bindingId), {
      handle: "opencode",
      provider: "opencode",
      sessionId: "session-b",
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

test("trusted provider prompt hooks select their exact session and Stop clears only that turn", () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    const context = { provider: "codex", store, providerProcessId: 8181 };
    for (const sessionId of ["session-a", "session-b"]) {
      handleHookEvent({ hook_event_name: "SessionStart", session_id: sessionId, cwd: "C:/work" }, context);
    }

    handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session-b", cwd: "C:/work", prompt: "continue" }, context);
    let resolution = store.bindActiveProviderTurn({ provider: "codex", processId: 8181 });
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.binding?.sessionId, "session-b");

    handleHookEvent({ hook_event_name: "Stop", session_id: "session-b" }, context);
    assert.equal(store.bindActiveProviderTurn({ provider: "codex", processId: 8181 }).status, "none");

    handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session-a", cwd: "C:/work", prompt: "next turn" }, context);
    resolution = store.bindActiveProviderTurn({ provider: "codex", processId: 8181 });
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.binding?.sessionId, "session-a");
    assert.ok(store.identityTokenFor("codex", "session-b"), "finishing a turn must not revoke the provider session identity");
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

test("an exact in-flight task receipt resolves Codex binding when its shared process owns several sessions", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    const processId = 9811;
    const sessions = ["sibling-session", "task-session"];
    for (const sessionId of sessions) {
      store.registerEndpoint({ provider: "codex", sessionId, cwd: "C:/repo" });
      store.issueIdentity("codex", "codex", sessionId);
      const claim = store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId, cwd: "C:/repo", ownerProcessId: processId });
      assert.ok(store.bindConnectionClaim(claim.claimId, { provider: "codex", processId }));
    }
    const task = store.addTask({
      from: "you", to: "codex", goal: "the task addressed to this exact Codex turn", origin: "human_typed",
      idempotencyKey: "exact-task-binding",
    }).task;
    store.setDelivery(task.id, { state: "sending", threadId: "task-session" });

    const bindingSelectors: Array<{ provider?: string; processId?: number; sessionId?: string }> = [];
    const bind = store.bindConnectionForProcess.bind(store);
    store.bindConnectionForProcess = (expected) => {
      bindingSelectors.push(expected);
      return bind(expected);
    };
    const verifiedSessions: string[] = [];
    const verify = store.verifyConnectionBinding.bind(store);
    store.verifyConnectionBinding = (bindingId) => {
      const identity = verify(bindingId);
      if (identity) verifiedSessions.push(identity.sessionId);
      return identity;
    };
    const server = createM9rMcpServer({ store, connectionProcessId: processId, connectionProvider: "codex", connectionWaitMs: 0, now: () => new Date("2026-10-15T18:00:00.000Z") });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    const result = await tools.m9r_whoami.handler({});

    assert.equal(result.content[0]!.text, "You are @codex (codex).");
    assert.ok(bindingSelectors.some((selector) => selector.sessionId === "task-session"), "MCP must pass the delivered task's exact session selector to the store");
    assert.ok(verifiedSessions.includes("task-session"), "the binding must verify the exact session recorded on the delivered task");
    assert.equal(verifiedSessions.includes("sibling-session"), false, "the sibling session must never be selected by recency or process order");
  } finally { done(); }
});

test("different in-flight task sessions remain fail-closed when they share a provider process", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    const processId = 9812;
    for (const sessionId of ["task-session-a", "task-session-b"]) {
      store.registerEndpoint({ provider: "codex", sessionId, cwd: "C:/repo" });
      store.issueIdentity("codex", "codex", sessionId);
      const claim = store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId, cwd: "C:/repo", ownerProcessId: processId });
      assert.ok(store.bindConnectionClaim(claim.claimId, { provider: "codex", processId }));
      const task = store.addTask({
        from: "you", to: "codex", goal: `task for ${sessionId}`, origin: "human_typed",
        idempotencyKey: `ambiguous-${sessionId}`,
      }).task;
      store.setDelivery(task.id, { state: "queued", threadId: sessionId, queuedAt: new Date().toISOString() });
    }

    const bindingSelectors: Array<{ provider?: string; processId?: number; sessionId?: string }> = [];
    const bind = store.bindConnectionForProcess.bind(store);
    store.bindConnectionForProcess = (expected) => {
      bindingSelectors.push(expected);
      return bind(expected);
    };
    let reconciliationCalls = 0;
    const server = createM9rMcpServer({
      store,
      connectionProcessId: processId,
      connectionProvider: "codex",
      connectionWaitMs: 0,
      now: () => new Date("2026-10-15T18:00:00.000Z"),
      reconcileProviderConnection: async () => {
        reconciliationCalls += 1;
        return { healthy: true, detail: "must not run for ambiguous task receipts" };
      },
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    await assert.rejects(() => tools.m9r_whoami.handler({}), /multiple.*sessions|ambiguous/i);
    assert.equal(bindingSelectors.some((selector) => selector.sessionId), false, "M9R must not guess between different task-bound sessions");
    assert.equal(reconciliationCalls, 0, "a process-only live observer must not bypass task-session ambiguity");
  } finally { done(); }
});

test("Codex tool-call thread metadata binds each call to its exact session in a shared process", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    const processId = 9814;
    const sessions = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    for (const sessionId of sessions) {
      store.registerEndpoint({ provider: "codex", sessionId, cwd: "C:/repo" });
      store.issueIdentity("codex", "codex", sessionId);
      const claim = store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId, cwd: "C:/repo", ownerProcessId: processId });
      assert.ok(store.bindConnectionClaim(claim.claimId, { provider: "codex", processId }));
    }

    const selected: string[] = [];
    const bind = store.bindConnectionForProcess.bind(store);
    store.bindConnectionForProcess = (expected) => {
      if (expected.sessionId) selected.push(expected.sessionId);
      return bind(expected);
    };
    const server = createM9rMcpServer({ store, connectionProcessId: processId, connectionProvider: "codex", connectionWaitMs: 0 });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra?: { _meta?: Record<string, unknown> }) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    for (const sessionId of sessions) {
      const result = await tools.m9r_whoami.handler({}, { _meta: { threadId: sessionId } });
      assert.equal(result.content[0]!.text, "You are @codex (codex).");
    }

    assert.deepEqual(selected, sessions, "each call must use its host-provided thread id, not a process-wide cached session");
  } finally { done(); }
});

test("invalid or unknown Codex thread metadata never falls back to another process session", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    const processId = 9815;
    const knownSession = "33333333-3333-4333-8333-333333333333";
    store.registerEndpoint({ provider: "codex", sessionId: knownSession, cwd: "C:/repo" });
    store.issueIdentity("codex", "codex", knownSession);
    const claim = store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: knownSession, cwd: "C:/repo", ownerProcessId: processId });
    assert.ok(store.bindConnectionClaim(claim.claimId, { provider: "codex", processId }));

    const selected: string[] = [];
    const bind = store.bindConnectionForProcess.bind(store);
    store.bindConnectionForProcess = (expected) => {
      if (expected.sessionId) selected.push(expected.sessionId);
      return bind(expected);
    };
    const server = createM9rMcpServer({ store, connectionProcessId: processId, connectionProvider: "codex", connectionWaitMs: 0 });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra?: { _meta?: Record<string, unknown> }) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    await assert.rejects(
      () => tools.m9r_whoami.handler({}, { _meta: { threadId: "not-a-codex-thread" } }),
      /invalid Codex thread selector/i,
    );
    await assert.rejects(
      () => tools.m9r_whoami.handler({}, { _meta: { threadId: "44444444-4444-4444-8444-444444444444" } }),
      /exact tool-call session|exact process/i,
    );
    assert.equal(selected.includes(knownSession), false, "invalid or unowned metadata must not bind a known sibling session");
  } finally { done(); }
});

test("simultaneous Codex calls reconcile independently by their exact thread metadata", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    const processId = 9816;
    const sessions = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
    for (const sessionId of sessions) {
      store.registerEndpoint({ provider: "codex", sessionId, cwd: "C:/repo" });
      store.issueIdentity("codex", "codex", sessionId);
    }

    const reconciled: string[] = [];
    const server = createM9rMcpServer({
      store,
      connectionProcessId: processId,
      connectionProvider: "codex",
      connectionCwd: "C:/repo",
      connectionWaitMs: 0,
      reconcileProviderConnection: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (input.sessionId) reconciled.push(input.sessionId);
        const binding = input.sessionId
          ? store.reconcileLiveProviderConnection({ provider: input.provider, sessionId: input.sessionId, cwd: input.cwd, processId: input.processId })
          : null;
        return { healthy: Boolean(binding), detail: "exact-session test observation", ...(binding ? { binding } : {}) };
      },
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra?: { _meta?: Record<string, unknown> }) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    const results = await Promise.all(sessions.map((sessionId) =>
      tools.m9r_whoami.handler({}, { _meta: { threadId: sessionId } }),
    ));

    assert.deepEqual(results.map((result) => result.content[0]!.text), ["You are @codex (codex).", "You are @codex (codex)."]);
    assert.deepEqual(reconciled.sort(), [...sessions].sort(), "each concurrent call must reconcile its own exact thread");
    for (const sessionId of sessions) assert.ok(store.bindConnectionForProcess({ provider: "codex", processId, sessionId }));
  } finally { done(); }
});

test("live reconciliation follows the exact delivered task session and refreshes when that session changes", async () => {
  const { store, done } = tempStore(undefined, () => true);
  try {
    const processId = 9813;
    for (const sessionId of ["task-session-a", "task-session-b"]) {
      store.registerEndpoint({ provider: "codex", sessionId, cwd: "C:/repo" });
      store.issueIdentity("codex", "codex", sessionId);
    }

    const firstTask = store.addTask({
      from: "you", to: "codex", goal: "deliver to session A", origin: "human_typed", idempotencyKey: "observer-session-a",
    }).task;
    store.setDelivery(firstTask.id, { state: "queued", threadId: "task-session-a" });
    const observed: string[] = [];
    const server = createM9rMcpServer({
      store,
      connectionProcessId: processId,
      connectionProvider: "codex",
      connectionCwd: "C:/repo",
      connectionWaitMs: 0,
      now: () => new Date("2026-10-15T18:00:00.000Z"),
      reconcileProviderConnection: async (input) => {
        observed.push(input.sessionId!);
        const binding = store.reconcileLiveProviderConnection({
          provider: input.provider,
          sessionId: input.sessionId!,
          cwd: input.cwd,
          processId: input.processId,
        });
        return { healthy: Boolean(binding), detail: "observed the exact task session", ...(binding ? { binding } : {}) };
      },
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;

    const first = await tools.m9r_whoami.handler({});
    assert.equal(first.content[0]!.text, "You are @codex (codex).");
    store.setDelivery(firstTask.id, { state: "done", threadId: "task-session-a" });
    const secondTask = store.addTask({
      from: "you", to: "codex", goal: "deliver to session B", origin: "human_typed", idempotencyKey: "observer-session-b",
    }).task;
    store.setDelivery(secondTask.id, { state: "queued", threadId: "task-session-b" });

    const second = await tools.m9r_whoami.handler({});

    assert.equal(second.content[0]!.text, "You are @codex (codex).");
    assert.deepEqual(observed, ["task-session-a", "task-session-b"], "a cached observer result for an older session must not be reused for a new task");
  } finally { done(); }
});
