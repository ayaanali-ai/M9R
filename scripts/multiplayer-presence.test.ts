import assert from "node:assert/strict";
import test from "node:test";
import {
  createPresenceStore,
  presenceColor,
  snapshotFromRecords,
} from "../src/lib/native/multiplayer-presence";

const roster = {
  runId: "run-8",
  agents: [
    { agentId: "claude", branchId: "claude-branch", provider: "Claude Code", handle: "claude" },
    { agentId: "codex", branchId: "codex-branch", provider: "Codex", handle: "codex" },
  ],
};

test("presence identity is deterministic and bounded", () => {
  assert.equal(presenceColor("claude"), presenceColor("claude"));
  const snapshot = snapshotFromRecords(Array.from({ length: 16 }, (_, i) => ({ agentId: `agent-${i}`, provider: "agent", state: "acting" as const })));
  assert.equal(snapshot.agents.length, 16);
  assert.equal(snapshot.featuredAgentIds.length, 3);
  assert.equal(snapshot.overflowCount, 13);
});
test("presence store accepts only newer events for the matching run and branch", () => {
  const store = createPresenceStore(roster, { now: () => 100 });
  const base = { schemaVersion: 1 as const, runId: "run-8", branchId: "claude-branch", agentId: "claude", presenceId: "presence-1", revision: 1, occurredAt: 100 };
  assert.equal(store.apply({ ...base, state: "acting" }).accepted, true);
  assert.equal(store.apply({ ...base, presenceId: "presence-0", state: "waiting" }).accepted, false);
  assert.equal(store.apply({ ...base, presenceId: "presence-2", revision: 2, branchId: "codex-branch", state: "acting" }).accepted, false);
  assert.equal(store.apply({ ...base, presenceId: "presence-3", revision: 3, runId: "other-run", state: "acting" }).accepted, false);
  assert.equal(store.snapshot().agents.find((agent) => agent.agentId === "claude")?.state, "acting");
});
