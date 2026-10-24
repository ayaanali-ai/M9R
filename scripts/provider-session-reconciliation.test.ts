import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createLocalStore } from "../src/lib/native/local-store.ts";
import { reconcileProviderSessions } from "../src/lib/native/provider-session-reconciliation.ts";

const scratchRoot = join(process.cwd(), ".test-tmp");
mkdirSync(scratchRoot, { recursive: true });
const fixtureRoot = mkdtempSync(join(scratchRoot, "m9r-provider-session-reconcile-"));
test.after(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });

function tempStore() {
  const root = mkdtempSync(join(fixtureRoot, "store-"));
  return { root, store: createLocalStore(root) };
}

test("Claude reconciliation binds and verifies the exact session reported by its live registry", async () => {
  const { root, store } = tempStore();
  try {
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "claude-code",
      readClaudeSessions: () => [{ sessionId: "claude-live", pid: process.pid, cwd: "C:/project", status: "idle" }],
    });

    assert.equal(result.healthy, true);
    assert.match(result.detail, /verified 1\/1 exact live session/);
    assert.ok(store.identityTokenFor("claude", "claude-live"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation selects the exact provider project folder before any process evidence", async () => {
  const { root, store } = tempStore();
  try {
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "claude-code",
      expectedCwd: "c:\\project\\",
      readClaudeSessions: () => [
        { sessionId: "claude-other-project", pid: 9011, cwd: "C:/other", status: "idle" },
        { sessionId: "claude-selected-project", pid: 9011, cwd: "C:/project", status: "idle" },
      ],
    });

    assert.equal(result.healthy, true);
    assert.match(result.detail, /exact provider project folder c:\/project/);
    assert.ok(store.identityTokenFor("claude", "claude-selected-project"));
    assert.equal(store.identityTokenFor("claude", "claude-other-project"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation refuses to guess between two live sessions in the selected project folder", async () => {
  const { root, store } = tempStore();
  try {
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "claude-code",
      expectedCwd: "C:/project",
      readClaudeSessions: () => [
        { sessionId: "claude-a", pid: 9012, cwd: "C:/project", status: "idle" },
        { sessionId: "claude-b", pid: 9013, cwd: "C:/project", status: "idle" },
      ],
    });

    assert.equal(result.healthy, false);
    assert.match(result.detail, /multiple live sessions match the provider project folder/);
    assert.equal(store.identityTokenFor("claude", "claude-a"), null);
    assert.equal(store.identityTokenFor("claude", "claude-b"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode reconciliation ignores stale heartbeats and binds only the fresh exact session", async () => {
  const { root, store } = tempStore();
  try {
    const nowMs = Date.now();
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-old", cwd: "C:/project", seenAt: new Date(nowMs - 31_000).toISOString() });
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-live", cwd: "C:/project", seenAt: new Date(nowMs - 1_500).toISOString() });

    const result = await reconcileProviderSessions({ root, store, providerId: "opencode", nowMs: () => nowMs });

    assert.equal(result.healthy, true);
    assert.match(result.detail, /verified 1\/1 exact live session/);
    assert.equal(store.identityTokenFor("opencode", "opencode-old"), null);
    assert.ok(store.identityTokenFor("opencode", "opencode-live"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode exact-process recovery uses only the exact session's active owner claim", async () => {
  const { root, store } = tempStore();
  try {
    const nowMs = Date.now();
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-current", cwd: "C:/project", seenAt: new Date(nowMs - 1_000).toISOString() });
    store.issueIdentity("opencode", "opencode", "opencode-current");
    store.issueConnectionClaim({
      handle: "opencode",
      provider: "opencode",
      sessionId: "opencode-current",
      cwd: "C:/project",
      ownerProcessId: process.pid,
    });

    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "opencode",
      expectedSessionId: "opencode-current",
      expectedProcessId: process.pid,
      nowMs: () => nowMs,
    });

    assert.equal(result.healthy, true);
    assert.equal(result.binding?.sessionId, "opencode-current");
    assert.equal(result.binding?.ownerProcessId, process.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode exact-process recovery refuses an exact heartbeat without a verified process claim", async () => {
  const { root, store } = tempStore();
  try {
    const nowMs = Date.now();
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-unowned", cwd: "C:/project", seenAt: new Date(nowMs - 1_000).toISOString() });

    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "opencode",
      expectedSessionId: "opencode-unowned",
      expectedProcessId: process.pid,
      nowMs: () => nowMs,
    });

    assert.equal(result.healthy, false);
    assert.match(result.detail, /could not verify the owning process for the exact session/);
    assert.equal(result.binding, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex reconciliation binds only sessions whose rollout files are positively live", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-live", cwd: "C:/project" });
    store.registerEndpoint({ provider: "codex", sessionId: "codex-free", cwd: "C:/project" });
    store.registerEndpoint({ provider: "codex", sessionId: "codex-unknown", cwd: "C:/project" });

    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      codexSessionLiveness: async () => ({ "codex-live": "live", "codex-free": "free", "codex-unknown": "unknown" }),
      codexSessionProcessIds: async () => ({ "codex-live": 9101 }),
    });

    assert.equal(result.healthy, false, "unknown live sessions prevent a false all-clear");
    assert.match(result.detail, /verified 1\/1 exact live session/);
    assert.ok(store.identityTokenFor("codex", "codex-live"));
    assert.equal(store.identityTokenFor("codex", "codex-free"), null);
    assert.equal(store.identityTokenFor("codex", "codex-unknown"), null);
    const binding = store.bindConnectionForProcess({ provider: "codex", processId: 9101 });
    assert.equal(binding?.sessionId, "codex-live");
    assert.equal(binding?.ownerProcessId, 9101);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex reconciliation does not publish a live session without one exact owning process", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-live", cwd: "C:/project" });
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      codexSessionLiveness: async () => ({ "codex-live": "live" }),
      codexSessionProcessIds: async () => ({}),
    });

    assert.equal(result.healthy, false);
    assert.match(result.detail, /unique owning process/);
    assert.equal(store.identityTokenFor("codex", "codex-live"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex reconciliation binds an exact session when the shared host process owns sibling sessions", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-a", cwd: "C:/project" });
    store.registerEndpoint({ provider: "codex", sessionId: "codex-b", cwd: "C:/project" });
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      expectedProcessId: 9201,
      expectedSessionId: "codex-b",
      codexSessionLiveness: async () => ({ "codex-a": "live", "codex-b": "live" }),
      codexSessionProcessIds: async () => ({ "codex-a": 9201, "codex-b": 9201 }),
    });

    assert.equal(result.healthy, true);
    assert.equal(result.binding?.sessionId, "codex-b");
    assert.equal(result.binding?.ownerProcessId, 9201);
    assert.equal(store.identityTokenFor("codex", "codex-b") !== null, true);
    assert.equal(store.identityTokenFor("codex", "codex-a"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex exact-session reconciliation is not blocked by an unverifiable sibling", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-current", cwd: "C:/project" });
    store.registerEndpoint({ provider: "codex", sessionId: "codex-sibling", cwd: "C:/project" });
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      expectedProcessId: 9202,
      expectedSessionId: "codex-current",
      codexSessionLiveness: async () => ({ "codex-current": "live", "codex-sibling": "unknown" }),
      codexSessionProcessIds: async () => ({ "codex-current": 9202 }),
    });

    assert.equal(result.healthy, true);
    assert.equal(result.binding?.sessionId, "codex-current");
    assert.ok(store.identityTokenFor("codex", "codex-current"));
    assert.equal(store.identityTokenFor("codex", "codex-sibling"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex exact-session recovery refuses to borrow the MCP caller PID when session ownership is unknown", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-current", cwd: "C:/project" });
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      expectedProcessId: 9205,
      expectedSessionId: "codex-current",
      codexSessionLiveness: async () => ({ "codex-current": "live" }),
      codexSessionProcessIds: async () => ({}),
    });

    assert.equal(result.healthy, false);
    assert.match(result.detail, /could not verify the owning process for the exact session/);
    assert.equal(store.identityTokenFor("codex", "codex-current"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex reconciliation treats an omitted liveness result as unknown", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-unreported", cwd: "C:/project" });
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      codexSessionLiveness: async () => ({}),
      codexSessionProcessIds: async () => ({}),
    });

    assert.equal(result.healthy, false);
    assert.match(result.detail, /could not be verified/);
    assert.equal(store.identityTokenFor("codex", "codex-unreported"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex provider reconciliation treats one host owning multiple live sessions as valid session state", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-a", cwd: "C:/project" });
    store.registerEndpoint({ provider: "codex", sessionId: "codex-b", cwd: "C:/project" });
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      codexSessionLiveness: async () => ({ "codex-a": "live", "codex-b": "live" }),
      codexSessionProcessIds: async () => ({ "codex-a": 9203, "codex-b": 9203 }),
    });

    assert.equal(result.healthy, true);
    assert.ok(store.identityTokenFor("codex", "codex-a"));
    assert.ok(store.identityTokenFor("codex", "codex-b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex process-only reconciliation still refuses to choose between sessions sharing that process", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-a", cwd: "C:/project" });
    store.registerEndpoint({ provider: "codex", sessionId: "codex-b", cwd: "C:/project" });
    const result = await reconcileProviderSessions({
      root,
      store,
      providerId: "codex",
      expectedProcessId: 9204,
      codexSessionLiveness: async () => ({ "codex-a": "live", "codex-b": "live" }),
      codexSessionProcessIds: async () => ({ "codex-a": 9204, "codex-b": 9204 }),
    });

    assert.equal(result.healthy, false);
    assert.match(result.detail, /provider process maps to multiple live sessions; an exact session selector is required/);
    assert.equal(store.identityTokenFor("codex", "codex-a"), null);
    assert.equal(store.identityTokenFor("codex", "codex-b"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP recovery reconciles only the Codex session owned by its exact provider process", async () => {
  const { root, store } = tempStore();
  try {
    store.registerEndpoint({ provider: "codex", sessionId: "codex-current", cwd: "C:/project" });
    store.registerEndpoint({ provider: "codex", sessionId: "codex-other", cwd: "C:/project" });
    const options = {
      root,
      store,
      providerId: "codex",
      expectedProcessId: 9101,
      codexSessionLiveness: async () => ({ "codex-current": "live", "codex-other": "live" }),
      codexSessionProcessIds: async () => ({ "codex-current": 9101, "codex-other": 9102 }),
    };

    const result = await reconcileProviderSessions(options as Parameters<typeof reconcileProviderSessions>[0]);

    assert.equal(result.healthy, true);
    assert.match(result.detail, /exact provider process 9101/);
    assert.equal(result.binding?.sessionId, "codex-current");
    assert.equal(result.binding?.ownerProcessId, 9101);
    assert.ok(store.identityTokenFor("codex", "codex-current"));
    assert.equal(store.identityTokenFor("codex", "codex-other"), null, "a provider MCP child must not reconcile a sibling session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode process-only recovery fails closed because its local heartbeat has no process owner", async () => {
  const { root, store } = tempStore();
  try {
    const nowMs = Date.now();
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-a", cwd: "C:/project", seenAt: new Date(nowMs - 500).toISOString() });
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-b", cwd: "C:/project", seenAt: new Date(nowMs - 500).toISOString() });

    const options = { root, store, providerId: "opencode", expectedProcessId: 9201, nowMs: () => nowMs };
    const result = await reconcileProviderSessions(options as Parameters<typeof reconcileProviderSessions>[0]);

    assert.equal(result.healthy, false);
    assert.match(result.detail, /does not identify the owning process/);
    assert.equal(store.identityTokenFor("opencode", "opencode-a"), null);
    assert.equal(store.identityTokenFor("opencode", "opencode-b"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit live OpenCode session ID scopes recovery even when other sessions are present", async () => {
  const { root, store } = tempStore();
  try {
    const nowMs = Date.now();
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-current", cwd: "C:/project", seenAt: new Date(nowMs - 500).toISOString() });
    store.registerEndpoint({ provider: "opencode", sessionId: "opencode-other", cwd: "C:/project", seenAt: new Date(nowMs - 500).toISOString() });

    const options = {
      root,
      store,
      providerId: "opencode",
      expectedSessionId: "opencode-current",
      nowMs: () => nowMs,
    };
    const result = await reconcileProviderSessions(options as Parameters<typeof reconcileProviderSessions>[0]);

    assert.equal(result.healthy, true);
    assert.match(result.detail, /exact session opencode-current/);
    assert.ok(store.identityTokenFor("opencode", "opencode-current"));
    assert.equal(store.identityTokenFor("opencode", "opencode-other"), null);
    const claim = JSON.parse(readFileSync(join(root, "state.json"), "utf8")).connectionClaims[0];
    assert.equal(claim.ownerProcessId, undefined, "an exact session selector does not fabricate process ownership");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unregistered providers fail closed instead of treating an installed route as a session", async () => {
  const { root, store } = tempStore();
  try {
    const result = await reconcileProviderSessions({ root, store, providerId: "future-provider" });
    assert.equal(result.healthy, false);
    assert.match(result.detail, /no live-session observer is registered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
