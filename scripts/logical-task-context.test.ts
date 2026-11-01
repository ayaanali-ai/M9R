import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalStore } from "../src/lib/native/local-store";
import { logicalTaskHandoff } from "../src/lib/native/logical-task-context";
import { codexWorkerArgs, writeWebMcpConfig } from "../src/lib/native/web-live-sessions";

test("logical handoff survives store reload and never replays the paused receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-logical-"));
  try {
    let store = createLocalStore(root);
    const first = store.addTask({ from: "you", to: "codex", goal: "Prepare a report", origin: "human_typed", idempotencyKey: "a" }).task;
    store.prepareLogicalTaskContext(first.id);
    store.pauseTask(first.id);
    store = createLocalStore(root);
    const next = store.addTask({ from: "you", to: "codex", goal: "Only inspect the title", origin: "human_typed", idempotencyKey: "b" }).task;
    const task = store.prepareLogicalTaskContext(next.id, first.id)!;
    assert.equal(task.logicalContext?.workId, first.id);
    assert.equal(task.logicalContext?.planRevision, 1);
    assert.equal(task.logicalContext?.latestInstruction, "Only inspect the title");
    assert.equal(store.getTask(first.id)?.receipt?.state, "paused");
    assert.equal(store.getTask(first.id)?.logicalContext?.supersededByTaskId, next.id);
    const third = store.addTask({ from: "you", to: "codex", goal: "continue", origin: "human_typed", idempotencyKey: "c" }).task;
    assert.equal(store.prepareLogicalTaskContext(third.id, first.id, true), undefined, "a consumed handoff cannot be replayed");
    assert.ok(logicalTaskHandoff(task).length < 10000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy Codex thread selectors cannot resume a provider and MCP keeps internal identity", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-no-resume-"));
  try {
    const args = codexWorkerArgs({ prompt: "next", folder: root, launcher: "L", storeRoot: root, brokerPort: 1, roomStartedAt: 1, threadId: "vendor-thread", sessionId: "m9r-internal" });
    assert.deepEqual(args.slice(0, 4), ["exec", "next", "--cd", root]);
    assert.equal(args.includes("resume"), false);
    assert.equal(args.includes("vendor-thread"), false);
    const { configPath } = writeWebMcpConfig(root, { repoRoot: root, storeRoot: root, brokerPort: 1, roomStartedAt: 1, sessionId: "m9r-internal" });
    const env = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.m9r.env;
    assert.equal(env.M9R_SESSION_ID, "m9r-internal");
    assert.equal(env.M9R_PROVIDER_SESSION_ID, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
