import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { CONNECTION_CLAIM_TTL_MS, newConnectionId, usableConnectionClaim } from "@/lib/native/mcp-connection-core";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { handleHookEvent } from "@/lib/native/hook-handler";

function tempStore(now: () => Date = () => new Date("2026-10-15T18:00:00.000Z")) {
  const root = mkdtempSync(join(process.cwd(), ".m9r-connection-test-"));
  return { store: createLocalStore(root, { now }), done: () => rmSync(root, { recursive: true, force: true }) };
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
  const { store, done } = tempStore();
  try {
    store.issueIdentity("codex", "codex", "session-a");
    store.issueIdentity("codex", "codex", "session-b");
    store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-a", ownerProcessId: 999 });
    store.issueConnectionClaim({ handle: "codex", provider: "codex", sessionId: "session-b", ownerProcessId: 999 });
    assert.equal(store.bindConnectionForProcess({ provider: "codex", processId: 999 }), null);
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
    for (const toolName of ["m9r_whoami", "m9r_stage_app", "m9r_stage_action", "m9r_computer_observe", "m9r_computer_action", "m9r_web_open"]) {
      // The field itself is always present now (one uniform schema for every connection, see
      // mcp-server.ts's OPTIONAL_TOKEN_FIELD) -- what must hold is that it is never required.
      const tokenSchema = tools[toolName]?.inputSchema.shape?.token;
      assert.ok(tokenSchema, `${toolName} must still declare a token field`);
      assert.equal((tokenSchema as { type?: string }).type, "optional", `${toolName}'s token field must be optional, not required`);
    }
    const result = await tools.m9r_whoami.handler({});
    assert.match(result.content[0]!.text, /@codex \(codex\), session session-1/);
  } finally { done(); }
});

test("a provider that starts MCP before its hook binds later without guessing", async () => {
  const { store, done } = tempStore();
  try {
    const server = createM9rMcpServer({ store, connectionProcessId: 4545, connectionProvider: "local-provider" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    await assert.rejects(() => tools.m9r_whoami.handler({}), /has no provider-session binding yet/);

    // This is the normal ordering race: the provider child exists first, then
    // its verified SessionStart hook issues the claim. The exact PID is the
    // only selector; a second claim would be rejected instead of guessed.
    store.issueIdentity("local-provider", "Local-Provider", "session-1");
    store.issueConnectionClaim({ handle: "local-provider", provider: "local-provider", sessionId: "session-1", ownerProcessId: 4545 });
    const result = await tools.m9r_whoami.handler({});
    assert.match(result.content[0]!.text, /@local-provider \(Local-Provider\), session session-1/);
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
    assert.match(result.content[0]!.text, /@codex \(codex\), session session-1/);
  } finally { done(); }
});
