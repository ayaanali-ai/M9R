import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalStore } from "../src/lib/native/local-store";
import { logicalTaskHandoff, shouldReusePausedTask } from "../src/lib/native/logical-task-context";
import { codexWorkerArgs, writeWebMcpConfig } from "../src/lib/native/web-live-sessions";
import { workingContextRetentionIds, workingContextSchema, workingContextView } from "../src/lib/native/task-working-context";
import { pruneTasks } from "../src/lib/native/inbox-core";
import { handleHookEvent } from "../src/lib/native/hook-handler";
import { deliveredTaskContext } from "../src/lib/native/task-execution-context";

const checkpoint = { decisions: ["Use a blue house"], currentEditor: "codex", artifacts: [{ label: "Drawing", locator: "C:/work/house.png" }],
  observedState: [{ summary: "Save is not confirmed", outcome: "unknown" as const, evidence: null }], unresolved: ["Verify the saved image"], nextStep: "Inspect the saved artifact" };

test("working snapshots survive reload, preserve unknowns, reject stale writers and recover through real session hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-working-"));
  try {
    let store = createLocalStore(root);
    const token = store.issueIdentity("codex", "codex", "one").token;
    const other = store.issueIdentity("codex", "codex", "two").token;
    const task = store.addTask({ from: "you", to: "codex", goal: "Draw a house", origin: "human_typed", idempotencyKey: "snapshot" }).task;
    store.markDelivered([task.id], "one");
    store.setDelivery(task.id, { state: "queued", threadId: "one", correlation: "internal-context" });
    assert.equal(store.saveWorkingContext(token, task.id, 0, checkpoint).revision, 1);
    assert.equal(store.saveWorkingContext(token, task.id, 0, checkpoint).revision, 1, "lost-response retry is idempotent");
    assert.throws(() => store.saveWorkingContext(token, task.id, 0, { ...checkpoint, nextStep: "Different" }), /changed/);
    assert.throws(() => store.saveWorkingContext(other, task.id, 1, checkpoint), /exact session/);
    store = createLocalStore(root);
    const view = store.readWorkingContext(token, task.id);
    assert.ok("checkpoints" in view);
    assert.equal(view.checkpoints[0].snapshot.observedState[0].outcome, "unknown");
    assert.equal(store.getTask(task.id)?.resultSummary, undefined, "checkpoint does not complete work");
    const hook = handleHookEvent({ hook_event_name: "SessionStart", session_id: "one", cwd: root }, { provider: "codex", store });
    assert.match(JSON.stringify(hook), /Use a blue house/);
    assert.match(deliveredTaskContext(store, { handle: "codex", provider: "codex", sessionId: "one", prompt: task.goal }) ?? "", /Save is not confirmed/);
    assert.throws(() => workingContextSchema.parse({ ...checkpoint, observedState: [{ summary: "Saved", outcome: "verified", evidence: null }] }), /evidence locator/);
    assert.throws(() => workingContextSchema.parse({ ...checkpoint, nextStep: "x".repeat(241) }));
    store.cancelTask(task.id);
    assert.throws(() => store.saveWorkingContext(token, task.id, 1, { ...checkpoint, nextStep: "New" }), /no longer/);
    assert.ok("checkpoints" in store.readWorkingContext(token, task.id), "canceled history remains readable without reviving it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("checkpoint views join broadcast/child/continuation lineage, retain independent reports and isolate unrelated work", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-working-lineage-"));
  try {
    const store = createLocalStore(root);
    const make = (to: string, key: string, broadcastId?: string) => store.addTask({ from: "you", to, goal: "Draw a house", origin: "human_typed", idempotencyKey: key, ...(broadcastId ? { broadcastId } : {}) }).task;
    const first = make("codex", "first", "joint"), peer = make("claude", "peer", "joint"), unrelated = make("codex", "unrelated");
    const token = store.issueIdentity("codex", "codex", "c").token, peerToken = store.issueIdentity("claude", "claude-code", "p").token;
    store.markDelivered([first.id, unrelated.id], "c"); store.markDelivered([peer.id], "p");
    store.prepareLogicalTaskContext(first.id);
    store.saveWorkingContext(token, first.id, 0, checkpoint);
    store.saveWorkingContext(peerToken, peer.id, 0, { ...checkpoint, currentEditor: "codex", nextStep: "Independently verify" });
    store.pauseTask(first.id);
    const next = make("codex", "next"); store.prepareLogicalTaskContext(next.id, first.id, true); store.markDelivered([next.id], "c");
    const view = store.readWorkingContext(token, next.id);
    assert.ok("checkpoints" in view); assert.equal(view.checkpoints.length, 2);
    assert.equal(view.revision, 1, "child/continuation shares this author's workflow CAS revision");
    assert.equal(store.saveWorkingContext(token, next.id, 1, { ...checkpoint, nextStep: "Verify roof" }).revision, 2);
    const updated = store.readWorkingContext(token, next.id);
    assert.ok("revision" in updated); assert.equal(updated.revision, 2);
    assert.ok("evidence" in store.readWorkingContext(token, next.id, { evidenceTaskId: first.id }));
    assert.throws(() => store.readWorkingContext(token, next.id, { evidenceTaskId: unrelated.id }), /outside/);
    store.pauseTask(next.id);
    const redirect = make("codex", "redirect"); store.prepareLogicalTaskContext(redirect.id, next.id, false); store.markDelivered([redirect.id], "c");
    const redirected = store.readWorkingContext(token, redirect.id);
    assert.ok("checkpoints" in redirected);
    assert.ok(redirected.checkpoints.every(report => !report.matchesCurrentPlan), "earlier-plan reports are historical, not current-plan proof");
    const tasks = store.snapshot().tasks;
    const child = { ...tasks.find(item => item.id === peer.id)!, id: "T999", seq: 999, broadcastId: undefined, parentTaskId: peer.id };
    assert.equal(workingContextView([...tasks, child], child).checkpoints.length, 2);
    const cycle = { ...child, parentTaskId: "T999" };
    assert.equal(workingContextView([...tasks, cycle], cycle).checkpoints.length, 1, "malformed lineage cannot join the broadcast");
    const completedPeer = { ...tasks.find(item => item.id === peer.id)!, resultSummary: "Peer finished", resultShownAt: new Date().toISOString() };
    const withPeerResult = tasks.map(item => item.id === peer.id ? completedPeer : item);
    const retained = pruneTasks(withPeerResult, { maxCount: 1, maxAgeMs: 0, now: Date.now() + 1000,
      preserveIds: workingContextRetentionIds(withPeerResult) });
    assert.ok(retained.some(item => item.id === peer.id), "open workflow retains completed peer's evidence");
    const finished = withPeerResult.map(item => item.id === first.id ? item
      : { ...item, resultSummary: "Done", resultShownAt: new Date().toISOString() });
    assert.equal(workingContextRetentionIds(finished).size, 0, "normal retention resumes when work is complete");
    const manyReports = Array.from({ length: 60 }, (_, index) => ({ ...tasks.find(item => item.id === first.id)!,
      id: `T${1000 + index}`, seq: 1000 + index, broadcastId: "joint", logicalContext: undefined,
      goal: "Historical evidence ".repeat(1000), workingContext: { ...tasks.find(item => item.id === first.id)!.workingContext!, revision: index + 1 } }));
    const bounded = workingContextView([...tasks, ...manyReports], tasks.find(item => item.id === next.id)!);
    assert.equal(bounded.checkpoints.length, 2, "one latest report per author, not the entire task history");
    assert.ok(JSON.stringify(bounded).length < 6000);
    const contributors = manyReports.slice(0, 6).map((item, index) => ({ ...item,
      workingContext: { ...item.workingContext, author: `agent-${index}` } }));
    const page = workingContextView(contributors, contributors[0]);
    assert.equal(page.checkpoints.length, 4); assert.equal(page.nextOffset, 4);
    assert.equal(workingContextView(contributors, contributors[0], 4).checkpoints.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("paused work is carried only by explicit continuation or redirect wording", () => {
  assert.equal(shouldReusePausedTask("Continue where you left off"), true);
  assert.equal(shouldReusePausedTask("Try that again"), true);
  assert.equal(shouldReusePausedTask("Actually, use Chrome instead"), true);
  assert.equal(shouldReusePausedTask("No, use the existing Chrome window"), true);
  assert.equal(shouldReusePausedTask("Open Calculator and compute 17 times 23"), false);
  assert.equal(shouldReusePausedTask("Open Chrome and search YouTube"), false);
  assert.equal(shouldReusePausedTask("Start a new task: inspect the browser"), false);
  // Pill routing mentions are part of the stored message body in some paths.
  // They must not make an unrelated new request inherit the latest paused work.
  assert.equal(shouldReusePausedTask("@codex go to Chrome and search YouTube"), false);
  assert.equal(shouldReusePausedTask("@codex continue where you left off"), true);
  assert.equal(shouldReusePausedTask("@codex actually, use Chrome instead"), true);
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
