import { serializeStageFailure } from "../src/lib/native/stage-errors";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameStateFile } from "../src/lib/native/atomic-file";
import { createLocalStore } from "../src/lib/native/local-store";
import { coordinationRootKey, createTaskDesktopStageService, ownerPreviewLaunchQueueKey, readTaskStagePolicy, resolveLaunchTarget, setTaskStagePermission, stageAccessMode } from "../src/lib/native/task-desktop-stage";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "../src/lib/native/windows-desktop-stage";
import { DesktopInputNotDispatchedError } from "../src/lib/native/desktop-input-errors";
import { resolveUnlistedStageApp, isStageAppReference, stageAppLaunchCwd, stageWindowMatchesApp, type StageAppLaunchSpec } from "../src/lib/native/task-stage-apps";
import { windowsAppSearchNames, WINDOWS_APP_DISCOVERY_SCRIPT, discoverInstalledWindowsApp } from "../src/lib/native/windows-installed-apps";
import type { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import type { StageApprovalRequest } from "../src/lib/native/web-broker-core";
import { createMultiplayerDispatchFence } from "../src/lib/native/multiplayer-dispatch-fence";
import { setOwnerWorkMode } from "../src/lib/native/owner-work-mode";

type TestVisibleWindow = { pid: number; windowId: string; title: string; width: number; height: number;
  appName?: string; processName?: string | null; className?: string; zOrder?: number; processPath?: string | null; appUserModelId?: string | null };

test("owner-preview launch queues coalesce same-app joins without blocking different apps", () => {
  const goal = "Work together: Codex handles Calculator while Claude handles Edge";
  assert.equal(ownerPreviewLaunchQueueKey(goal, "Calculator"), ownerPreviewLaunchQueueKey(goal, "calculator"),
    "Windows app references are case-insensitive for duplicate-launch coordination");
  assert.notEqual(ownerPreviewLaunchQueueKey(goal, "Calculator"), ownerPreviewLaunchQueueKey(goal, "Edge"),
    "independent apps in one multiplayer task must have independent launch queues");
  assert.notEqual(ownerPreviewLaunchQueueKey(goal, "Calculator"), ownerPreviewLaunchQueueKey(`${goal} follow-up`, "Calculator"),
    "different task intents must not share a launch queue");
});

test("coordinationRootKey keys shared A2A work by lineage, not by each hop's own goal wording", () => {
  const broadcastRecipientA = { id: "T1", broadcastId: "bcast-1" };
  const broadcastRecipientB = { id: "T2", broadcastId: "bcast-1" };
  assert.equal(coordinationRootKey(broadcastRecipientA), coordinationRootKey(broadcastRecipientB),
    "every per-recipient task from one owner broadcast must resolve to the same root key");

  const delegateMessage = { id: "T3", a2a: { conversationId: "conv-1" } };
  const replyMessage = { id: "T4", a2a: { conversationId: "conv-1" } };
  assert.equal(coordinationRootKey(delegateMessage), coordinationRootKey(replyMessage),
    "every reply in one A2A conversation thread must resolve to the same root key, even though each hop's goal text is unique");

  const conversationLinkedTask = { id: "T5", broadcastId: "bcast-2", a2a: { conversationId: "conv-2" } };
  assert.equal(coordinationRootKey(conversationLinkedTask), "bcast-2",
    "an explicit owner broadcast remains the root even after conversation metadata is added");

  const soloTask = { id: "T6" };
  assert.equal(coordinationRootKey(soloTask), "T6",
    "a task with no lineage falls back to its own id, isolating it exactly like before");

  const unrelatedTask = { id: "T7" };
  assert.notEqual(coordinationRootKey(soloTask), coordinationRootKey(unrelatedTask),
    "two unrelated solo tasks must never share a root key");
});

test("owner broadcast, A2A handoffs, and plain result replies keep one window and launch group", () => {
  const tasks = [
    { id: "T1", broadcastId: "owner-broadcast" },
    { id: "T2", broadcastId: "owner-broadcast" },
    { id: "T3", a2a: { taskId: "T1", conversationId: "conversation-a" } },
    { id: "T4", a2a: { taskId: "T2", conversationId: "conversation-b" } },
    { id: "T5", parentTaskId: "T3", replyToTaskId: "T3" },
    { id: "T6", parentTaskId: "T5" },
  ];
  const lookup = (id: string) => tasks.find(task => task.id === id);
  for (const task of tasks) {
    assert.equal(coordinationRootKey(task, lookup), "owner-broadcast");
    assert.equal(ownerPreviewLaunchQueueKey(coordinationRootKey(task, lookup), "Paint"),
      ownerPreviewLaunchQueueKey("owner-broadcast", "Paint"));
  }
  assert.notEqual(coordinationRootKey({ id: "T7", broadcastId: "unrelated-broadcast" }, lookup), "owner-broadcast");
  assert.equal(coordinationRootKey({ id: "T8", replyToTaskId: "missing" }, lookup), "T8");
  const cycle = [{ id: "T9", parentTaskId: "T10" }, { id: "T10", parentTaskId: "T9" }];
  assert.equal(coordinationRootKey(cycle[0], id => cycle.find(task => task.id === id)), "T9");
});

function fixture(control = false, resolveStageAppForTest?: (root: string, appId: string) => StageAppLaunchSpec,
  readPolicyOverride?: () => ReturnType<typeof readTaskStagePolicy>, fenced = false,
  managerHooks?: { onCloseInputStream?: (streamId: string) => void; processAlive?: (pid: number) => boolean }, cursorMaxLifetimeMsForTest?: number) {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-stage-"));
  setOwnerWorkMode(root, "agents-free"); // legacy-path regression fixture; safe-default coverage is separate
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "session-one");
  const { task } = store.addTask({ from: "you", to: "codex", goal: "Use a stage", origin: "human_typed", idempotencyKey: "stage-one", targetSession: "session-one" });
  const desktopActions: Array<{ kind: string; x?: number; y?: number }> = [];
  const retiredDesktopOps = new Set(["currentDesktop", "createDesktop", "inspectDesktop", "activateDesktop", "moveWindowToDesktop"]);
  let retiredDesktopOpCount = 0;
  let foregroundWindow = { pid: 123, windowId: "456" };
  const nativeOps: string[] = [];
  const presentedWindows: Array<{ pid: number; windowId: string }> = [];
  const cursorEvents: string[] = [];
  const sayEvents: Array<{ from: string; to: string; text: string }> = [];
  let visibleWindows: TestVisibleWindow[] = [];
  const previewCapture = { dataUrl: "data:image/png;base64,eA==", width: 1280, height: 720, capturedAt: new Date(0).toISOString() };
  const driver = {
    capture: async () => previewCapture,
    captureDesktop: async () => { desktopActions.push({ kind: "capture" }); return previewCapture; },
    moveDesktopCursor: async (_name: string, x: number, y: number) => {
      desktopActions.push({ kind: "cursor", x, y });
      return { capture: previewCapture, outcome: { status: "confirmed" as const } };
    },
    focusWindow: async () => ({ capture: previewCapture, outcome: { status: "confirmed" as const } }),
    showAgentCursor: async (_stageName: string, cursorIdentity: { handle: string; sessionId: string }) => { cursorEvents.push(`show:${cursorIdentity.sessionId}`); },
    closeAgentCursor: async (cursorIdentity: { handle: string; sessionId: string }) => { cursorEvents.push(`close:${cursorIdentity.sessionId}`); },
    sayAgentCursor: async (sender: { handle: string }, recipient: { handle: string }, text: string) => {
      sayEvents.push({ from: sender.handle, to: recipient.handle, text });
      return true;
    },
    shutdown: async () => undefined,
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const mutationFence = fenced ? createMultiplayerDispatchFence({ store }) : undefined;
  const stage: WindowsStageDependencies = {
    platform: "win32", env: {}, invokeNative: async (request) => {
      nativeOps.push(String(request.op));
      if (retiredDesktopOps.has(String(request.op))) { retiredDesktopOpCount++; return { ok: false, error: "Windows desktop operations are retired." }; }
      if (request.op === "currentForegroundWindow") return { ok: true, foregroundWindow: { ...foregroundWindow,
        title: "Active window", className: "Chrome_WidgetWin_1", visible: true, minimized: false } };
      if (request.op === "listVisibleWindows") return { ok: true, windows: visibleWindows };
      if (request.op === "listOwnedWindows") return { ok: true, windows: visibleWindows.filter((window) => window.pid === Number(request.pid)) };
      if (request.op === "windowStatus") return { ok: true, windowState: "visible" };
      if (request.op === "windowRect") return { ok: true, rect: { x: -120, y: 40, width: 640, height: 480 } };
      if (request.op === "presentOwnerWindow") { presentedWindows.push({ pid: Number(request.pid), windowId: String(request.windowId) });
        return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } }; }
      if (request.op === "inspect") return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } };
      throw new Error("Unexpected native operation; preparation must not move or activate windows.");
    },
  };
  const manager = managerHooks ? createWindowsDesktopStageManager({ ...stage, root, terminal: true,
    ...(managerHooks.processAlive ? { processAlive: managerHooks.processAlive } : {}),
    sharedWindowFence: mutationFence,
    taskActive: (taskId) => {
      const current = store.getTask(taskId);
      return Boolean(current) && current!.resultSummary === undefined && current!.receipt?.state !== "canceled"
        && current!.lifecycle?.state !== "completed" && current!.lifecycle?.state !== "failed";
    } }) : undefined;
  if (manager && managerHooks?.onCloseInputStream) {
    const closeInputStream = manager.closeInputStream.bind(manager);
    manager.closeInputStream = (streamId) => { managerHooks.onCloseInputStream!(streamId); closeInputStream(streamId); };
  }
  const service = createTaskDesktopStageService({ store, ...(mutationFence ? { mutationFence } : {}), ...(manager ? { manager } : {}),
    readPolicy: readPolicyOverride ?? (() => ({ handles: ["codex"], ...(control ? { controlHandles: ["codex"] } : {}) })), driver,
    ...(resolveStageAppForTest ? { resolveStageAppForTest: (appId: string) => resolveStageAppForTest(root, appId) } : {}),
    ...(cursorMaxLifetimeMsForTest !== undefined ? { cursorMaxLifetimeMsForTest } : {}), stage });
  return { root, store, identity, task, service, driver, nativeOps, presentedWindows,
    cursorEvents, sayEvents,
    setForegroundWindow: (pid: number, windowId: string) => { foregroundWindow = { pid, windowId }; },
    setVisibleWindows: (windows: TestVisibleWindow[]) => { visibleWindows = windows; },
    retiredDesktopOpCount: () => retiredDesktopOpCount, creations: () => retiredDesktopOpCount, desktopActions, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("production desktop lifecycle retains one input stream across tasks and delivery modes", async () => {
  const f = fixture(true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    const first = f.service.inputStreamSnapshot()[0];
    const followup = f.store.addTask({ from: "you", to: "codex", goal: "Follow-up desktop task", origin: "human_typed", idempotencyKey: "stream-followup", targetSession: "session-one" }).task;
    await f.service.prepare(f.identity.token, followup.id, "owner-preview");
    const second = f.service.inputStreamSnapshot()[0];
    assert.equal(second?.streamId, first?.streamId);
    assert.equal(second?.nextSequence, 3);
    assert.equal(f.service.inputStreamSnapshot().length, 1);
    f.store.flushStageTiming();
    assert.ok(f.store.getTask(followup.id)?.stageTiming?.some((event) => event.detail?.includes(`input-stream=${first?.streamId};sequence=2`)));
  } finally { await f.service.close(); f.cleanup(); }
});

test("explicit background foreground-binding only observes and shares the exact HWND under the real fence", async () => {
  const f = fixture(true, undefined, undefined, true);
  try {
    const first = await f.service.prepare(f.identity.token, f.task.id, "background", { bindForeground: true });
    const peer = f.store.issueIdentity("codex", "codex", "session-two");
    const task = f.store.addTask({ from: "you", to: "codex", goal: "Other field", origin: "human_typed", idempotencyKey: "shared-field", targetSession: "session-two" }).task;
    const second = await f.service.prepare(peer.token, task.id, "background", { bindForeground: true });
    assert.equal(first.hasAnchor, true); assert.equal(second.hasAnchor, true);
    assert.notEqual(first.name, second.name);
    assert.deepEqual(f.presentedWindows, [], "observation never raises or presents the app");
    assert.ok(f.nativeOps.every((op) => op === "currentForegroundWindow" || op === "inspect"));
    const registry = JSON.parse(readFileSync(join(f.root, "windows-stages.json"), "utf8")) as { stages: Array<{ fencedBinding?: boolean }> };
    assert.ok(registry.stages.every((stage) => stage.fencedBinding));
    const unfenced = createTaskDesktopStageService({ store: f.store, driver: f.driver,
      readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
      stage: { platform: "win32", env: {}, invokeNative: async (request) => ({ ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } }) } });
    try {
      await assert.rejects(unfenced.act(f.identity.token, f.task.id, { kind: "type", text: "must not dispatch", view: "app" }, "background"),
        (error) => error instanceof DesktopInputNotDispatchedError && error.message.includes("mutation fence"));
    } finally { await unfenced.close(); }
  } finally { await f.service.close(); f.cleanup(); }
});

test("native stage revisions stay scoped to the observed surface and reject another agent's unseen edit", async () => {
  const f = fixture(true, undefined, undefined, true, { processAlive: () => true });
  let edits = 0;
  const proof = () => ({ capture: { dataUrl: "data:image/png;base64,eA==", width: 1280, height: 720, capturedAt: new Date().toISOString() },
    outcome: { status: "confirmed" as const } });
  f.driver.typeText = async () => { edits++; return proof(); };
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview", { bindForeground: true });
    const capture = () => f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview");
    const edit = () => f.service.act(f.identity.token, f.task.id, { kind: "type", view: "app", text: "x" }, "owner-preview");
    await capture();
    await edit();
    await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "desktop" }, "owner-preview");
    await edit(); // the desktop's revision must not replace the app's revision
    const peer = f.store.issueIdentity("codex", "codex", "revision-peer");
    const task = f.store.addTask({ from: "you", to: "codex", goal: "Edit the shared app", origin: "human_typed",
      targetSession: "revision-peer", idempotencyKey: "revision-peer" }).task;
    await f.service.prepare(peer.token, task.id, "owner-preview", { bindForeground: true });
    await f.service.act(peer.token, task.id, { kind: "capture", view: "app" }, "owner-preview");
    await f.service.act(peer.token, task.id, { kind: "type", view: "app", text: "peer" }, "owner-preview");
    await assert.rejects(edit(), /revision is stale/);
    assert.equal(edits, 3, "the unseen peer edit must refuse before dispatch");
    await capture();
    await edit();
    assert.equal(edits, 4, "a fresh app observation enables the next action");
  } finally { await f.service.close(); f.cleanup(); }
});

test("transient cursor policy reads do not close the agent overlay until three consecutive failures", async () => {
  let policyUnavailable = false;
  const f = fixture(false, undefined, () => {
    if (policyUnavailable) throw new Error("transient policy read failure");
    return { handles: ["codex"] };
  });
  // The cursor-hide reconcile loop runs on its own 250ms timer (split from the
  // unrelated, slower reapRevokedGrants() timer), so one 300ms wait reliably
  // spans exactly one reconcile tick here.
  const waitForReaperTick = () => new Promise((resolve) => setTimeout(resolve, 300));
  try {
    f.store.registerEndpoint({ provider: "codex", sessionId: "session-one" });
    const shown = await f.service.primeCursor(f.identity.token, f.task.id);
    assert.equal(shown.shown, true);
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);
    policyUnavailable = true;
    await waitForReaperTick();
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);
    await waitForReaperTick();
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);
    await waitForReaperTick();
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"]);
  } finally {
    await f.service.close();
    f.cleanup();
  }
});

test("sayAgentCursor resolves sender and recipient by handle alone when given no M9R task id", async () => {
  // A teammate message's own taskId is the sender's free-form A2A room label, never a real "T<number>"
  // M9R task id -- subscribeA2ACursorChatter never passes it through for exactly that reason, so this
  // must resolve correctly on handle alone when both agents have exactly one active cursor each.
  const f = fixture(false, undefined, () => ({ handles: ["codex", "claude"] }));
  try {
    f.store.registerEndpoint({ provider: "codex", sessionId: "session-one" });
    const claudeIdentity = f.store.issueIdentity("claude", "claude-code", "session-claude");
    f.store.registerEndpoint({ provider: "claude-code", sessionId: "session-claude" });
    const claudeTask = f.store.addTask({ from: "you", to: "claude", goal: "Other stage", origin: "human_typed", idempotencyKey: "claude-stage-one", targetSession: "session-claude" }).task;
    const primedCodex = await f.service.primeCursor(f.identity.token, f.task.id);
    const primedClaude = await f.service.primeCursor(claudeIdentity.token, claudeTask.id);
    assert.deepEqual(primedCodex, { shown: true, agent: "codex" }, "codex cursor must prime");
    assert.deepEqual(primedClaude, { shown: true, agent: "claude" }, "claude cursor must prime");
    const ok = await f.service.sayAgentCursor("codex", "claude", "Pick a number");
    assert.equal(ok, true);
    assert.deepEqual(f.sayEvents, [{ from: "codex", to: "claude", text: "Pick a number" }]);
  } finally { await f.service.close(); f.cleanup(); }
});

test("a cursor is force-reaped once it outlives the safety-net bound even if its task never reaches a terminal state", async () => {
  // A task stuck forever in a non-terminal lifecycle state (e.g. "acknowledged" with no further
  // provider activity) never makes taskActive() go false, so the ordinary reap path above never fires.
  // The safety net must still close the cursor once it has clearly outlived any legitimate task.
  const f = fixture(true, undefined, undefined, false, undefined, 300);
  const waitPastBound = () => new Promise((resolve) => setTimeout(resolve, 600));
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 12, y: 15 }, "owner-preview");
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);
    // The task is left deliberately unfinished: no markDelivered/recordTaskResult, so taskActive() stays true.
    await waitPastBound();
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"],
      "the stuck task's cursor is reaped by age alone, independent of its lifecycle state");
  } finally { await f.service.close(); f.cleanup(); }
});

test("a cursor is reaped promptly once its receipt is paused/failed/uncertain, without waiting for the age safety net", async () => {
  // Before this fix, taskActive() only excluded a "canceled" receipt, so a task whose receipt moved to
  // "paused"/"failed"/"uncertain" (none of which RECEIPT_TRANSITIONS ever lets resume active work --
  // inbox-core.ts) kept its cursor until the unrelated age-based safety net fired. The safety-net bound
  // here is deliberately huge so only the receipt-state check below can explain a prompt reap.
  const f = fixture(true, undefined, undefined, false, undefined, 10_000_000);
  const waitForReaperTick = () => new Promise((resolve) => setTimeout(resolve, 600));
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 12, y: 15 }, "owner-preview");
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);
    f.store.pauseTask(f.task.id);
    await waitForReaperTick();
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"],
      "a paused receipt alone must reap the cursor well before the huge age safety net could ever fire");
  } finally { await f.service.close(); f.cleanup(); }
});

test("a cursor is reaped promptly when its task authorization is revoked after priming", async () => {
  const f = fixture(true, undefined, undefined, false, undefined, 10_000_000);
  const waitForReaperTick = () => new Promise((resolve) => setTimeout(resolve, 600));
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 12, y: 15 }, "owner-preview");
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);

    f.store.setApproval(f.task.id, "denied");
    await waitForReaperTick();
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"],
      "revoking task approval must remove its presentation promptly instead of leaving it until the age safety net");
  } finally { await f.service.close(); f.cleanup(); }
});

test("a cursor is never primed in the first place for a task whose receipt is already paused/failed/uncertain", async () => {
  // resolveCursorTarget() only excluded a "canceled" receipt, while taskActive() in this same file (the
  // reaper's own reference predicate, confirmed correct by the two tests above) also excludes "failed",
  // "uncertain", and "paused". Priming could show a cursor/chatter bubble for a task every other part of
  // the system -- window claims, action routing, the reaper itself -- already treated as dead.
  const f = fixture(false);
  try {
    f.store.registerEndpoint({ provider: "codex", sessionId: "session-one" });
    f.store.markDelivered([f.task.id], f.identity.sessionId);
    f.store.pauseTask(f.task.id);
    const paused = await f.service.primeCursor(f.identity.token, f.task.id);
    assert.equal(paused.shown, false);
    assert.deepEqual(f.cursorEvents, [], "a paused receipt must refuse the prime outright, not show then immediately reap");

    const uncertainTask = f.store.addTask({ from: "you", to: "codex", goal: "Second stage", origin: "human_typed",
      idempotencyKey: "uncertain-prime", targetSession: "session-one" }).task;
    f.store.markDelivered([uncertainTask.id], f.identity.sessionId);
    f.store.recordTaskResult(f.identity.token, uncertainTask.id, "Partial check.", { status: "incomplete", remainingWork: ["Finish."] });
    assert.equal(f.store.getTask(uncertainTask.id)?.receipt?.state, "uncertain");
    const uncertain = await f.service.primeCursor(f.identity.token, uncertainTask.id);
    assert.equal(uncertain.shown, false);
    assert.deepEqual(f.cursorEvents, [], "an uncertain receipt must refuse the prime the same way");
  } finally { await f.service.close(); f.cleanup(); }
});

test("re-priming the same still-running task does not reset the safety-net age, but a genuinely new task does", async () => {
  const f = fixture(true, undefined, undefined, false, undefined, 300);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 12, y: 15 }, "owner-preview");
    await wait(200);
    // Re-priming the same task (e.g. a second action in the same turn) must not push its age back out.
    await f.service.primeCursor(f.identity.token, f.task.id);
    await wait(400);
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"],
      "re-priming the same task does not reset the age the safety net measures against");
  } finally { await f.service.close(); f.cleanup(); }
});

test("task completion removes the persistent cursor but preserves the agent-session native input stream", async () => {
  const closedInputStreams: string[] = [];
  const f = fixture(true, undefined, undefined, false, { onCloseInputStream: (streamId) => closedInputStreams.push(streamId) });
  const waitForReaperTick = () => new Promise((resolve) => setTimeout(resolve, 2_100));
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 12, y: 15 }, "owner-preview");
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);
    assert.equal(f.service.inputStreamSnapshot().length, 1);

    f.store.markDelivered([f.task.id], f.identity.sessionId);
    assert.equal(f.store.recordTaskResult(f.identity.token, f.task.id, "Done", { status: "completed", remainingWork: [] }).ok, true);
    await waitForReaperTick();

    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"],
      "a terminal task reaps its marker instead of leaving it on screen");
    assert.deepEqual(closedInputStreams, [], "task completion must not tear down the agent's persistent native stream");
    assert.equal(f.service.inputStreamSnapshot().length, 1, "the logical session lane remains reusable for the agent's next task");
  } finally { await f.service.close(); f.cleanup(); }
});

test("an old task's pending cursor hide cannot discard a follow-up task's cleanup ownership", async () => {
  const f = fixture(true);
  let release = () => {};
  let hiding = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  f.driver.closeAgentCursor = async identity => {
    if (first) { first = false; hiding = true; await gate; }
    f.cursorEvents.push(`close:${identity.sessionId}`);
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 600));
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await new Promise(resolve => setImmediate(resolve));
    f.store.markDelivered([f.task.id], "session-one");
    assert.equal(f.store.recordTaskResult(f.identity.token, f.task.id, "Done", { status: "completed", remainingWork: [] }).ok, true);
    for (let i = 0; i < 100 && !hiding; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(hiding, true);
    const next = f.store.addTask({ from: "you", to: "codex", goal: "Follow-up", origin: "human_typed", targetSession: "session-one", idempotencyKey: "hide-race" }).task;
    await f.service.prepare(f.identity.token, next.id, "owner-preview");
    await new Promise(resolve => setImmediate(resolve));
    release();
    await settle();
    assert.ok(f.cursorEvents.filter(event => event === "show:session-one").length >= 3, "a late hide reasserts the newer task's marker");
    assert.equal(f.cursorEvents.filter(event => event === "close:session-one").length, 1, "the active follow-up is not reaped");
    f.store.markDelivered([next.id], "session-one");
    assert.equal(f.store.recordTaskResult(f.identity.token, next.id, "Follow-up done", { status: "completed", remainingWork: [] }).ok, true);
    await settle();
    assert.equal(f.cursorEvents.filter(event => event === "close:session-one").length, 2, "the follow-up remains tracked and clears on completion");
  } finally { release(); await f.service.close(); f.cleanup(); }
});

test("one agent's completion clears only its cursor while its teammate continues", async () => {
  const f = fixture(true, undefined, () => ({ handles: ["codex", "claude"], controlHandles: ["codex", "claude"] }));
  try {
    const peer = f.store.issueIdentity("claude", "claude-code", "claude-working");
    const task = f.store.addTask({ from: "you", to: "claude", goal: "Keep working", origin: "human_typed", targetSession: "claude-working", idempotencyKey: "peer-working" }).task;
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.prepare(peer.token, task.id, "owner-preview");
    await new Promise(resolve => setImmediate(resolve));
    f.store.markDelivered([f.task.id], "session-one");
    f.store.recordTaskResult(f.identity.token, f.task.id, "Done", { status: "completed", remainingWork: [] });
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok(f.cursorEvents.includes("close:session-one"));
    assert.equal(f.cursorEvents.includes("close:claude-working"), false);
    f.store.markDelivered([task.id], "claude-working");
    f.store.recordTaskResult(peer.token, task.id, "Done", { status: "completed", remainingWork: [] });
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok(f.cursorEvents.includes("close:claude-working"));
  } finally { await f.service.close(); f.cleanup(); }
});

test("a follow-up task re-shows its cursor after the prior task cleaned it up", async () => {
  const f = fixture(true);
  const waitForReaperTick = () => new Promise((resolve) => setTimeout(resolve, 2_100));
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);

    f.store.markDelivered([f.task.id], f.identity.sessionId);
    assert.equal(f.store.recordTaskResult(f.identity.token, f.task.id, "Done", { status: "completed", remainingWork: [] }).ok, true);
    await waitForReaperTick();
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"]);

    const next = f.store.addTask({ from: "you", to: "codex", goal: "Next task", origin: "human_typed",
      idempotencyKey: "cursor-follow-up", targetSession: "session-one" }).task;
    await f.service.prepare(f.identity.token, next.id, "owner-preview");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one", "show:session-one"],
      "the next task is not suppressed by the previous task's presentation cache");
  } finally { await f.service.close(); f.cleanup(); }
});

test("task timing persists native subphase labels, operation correlation, and fractional duration", () => {
  const f = fixture();
  try {
    const accepted = f.store.recordStageTiming(f.task.id, {
      phase: "input-dispatch",
      startedAt: "2026-11-05T12:00:00.000Z",
      endedAt: "2026-11-05T12:00:00.004Z",
      durationMs: 4.37,
      status: "ok",
      operationId: "action-7",
      stageName: "agent-abcdef0123456789abcdef01",
      cached: true,
      detail: "route=native",
    });
    assert.equal(accepted, true);
    f.store.flushStageTiming();
    assert.deepEqual(f.store.getTask(f.task.id)?.stageTiming?.at(-1), {
      phase: "input-dispatch",
      startedAt: "2026-11-05T12:00:00.000Z",
      endedAt: "2026-11-05T12:00:00.004Z",
      durationMs: 4.37,
      status: "ok",
      operationId: "action-7",
      stageName: "agent-abcdef0123456789abcdef01",
      cached: true,
      detail: "route=native",
    });
  } finally { f.cleanup(); }
});

test("task timing persists cursor overlay host timings", () => {
  const f = fixture();
  try {
    assert.equal(f.store.recordStageTiming(f.task.id, {
      phase: "cursor-overlay",
      startedAt: "2026-11-09T12:00:00.000Z",
      endedAt: "2026-11-09T12:00:00.012Z",
      durationMs: 12,
      status: "ok",
      detail: "renderer=m9r;screenPoint=verified;visible=true",
    }), true);
    f.store.flushStageTiming();
    assert.equal(f.store.getTask(f.task.id)?.stageTiming?.at(-1)?.phase, "cursor-overlay");
    assert.equal(f.store.getTask(f.task.id)?.stageTimingSummary?.["cursor-overlay"]?.totalDurationMs, 12);
  } finally { f.cleanup(); }
});

test("task timing keeps full per-phase aggregates after raw event history reaches its cap", () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 300; i++) {
      assert.equal(f.store.recordStageTiming(f.task.id, {
        phase: "input-dispatch",
        startedAt: new Date(Date.UTC(2026, 10, 5, 12, 0, i)).toISOString(),
        endedAt: new Date(Date.UTC(2026, 10, 5, 12, 0, i)).toISOString(),
        durationMs: i,
        status: i % 10 === 0 ? "error" : "ok",
      }), true);
    }
    f.store.flushStageTiming();

    const recorded = f.store.getTask(f.task.id)!;
    assert.equal(recorded.stageTiming?.length, 256, "raw event retention remains bounded");
    assert.equal(recorded.stageTiming?.[0]?.durationMs, 45, "raw events retain the most recent tail");
    assert.deepEqual(recorded.stageTimingSummary?.["input-dispatch"], {
      count: 300,
      totalDurationMs: 45_150,
      maxDurationMs: 300,
      errorCount: 30,
    });
    assert.equal(recorded.stageTimingSummaryStartedAt, "2026-11-05T12:00:01.000Z");
    assert.equal(recorded.stageTimingSummaryMayBeIncomplete, false);
  } finally { f.cleanup(); }
});

test("a stalled cursor compositor cannot delay stage preparation or dispatch", async () => {
  const f = fixture(true);
  try {
    f.driver.showAgentCursor = async () => new Promise<never>(() => {});
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 12, y: 15 }, "owner-preview");
    assert.equal(f.desktopActions.filter((action) => action.kind === "cursor").length, 1);
  } finally { f.cleanup(); }
});

test("a cursor the reaper deletes while ensureCursorPrimed's own show() is still pending does not linger untracked forever", async () => {
  // prepare()'s authorize() call adds the activeAgentCursors entry, then ensureCursorPrimed starts
  // showAgentCursor without awaiting it to completion before prepare() itself returns. The 250ms
  // reaper runs concurrently and, once taskActive() goes false, deletes that entry and hides the
  // cursor -- even if showAgentCursor is still mid-flight. Before this fix, show()'s own completion
  // handler only acted when an activeAgentCursors entry for this key still existed; with none left
  // (the reaper already deleted it), it recorded nothing at all, leaving the cursor that just came
  // back visible from this call with no entry anywhere and nothing to ever reap it again -- the
  // reaper only iterates keys present in activeAgentCursors. Reproduce exactly that interleaving.
  const f = fixture(true, undefined, undefined, false, undefined, 10_000_000);
  let resolveShow: (() => void) | undefined;
  f.driver.showAgentCursor = async (_stageName: string, cursorIdentity: { handle: string; sessionId: string }) => {
    f.cursorEvents.push(`show:${cursorIdentity.sessionId}`);
    await new Promise<void>((resolve) => { resolveShow = resolve; });
    return { label: "", visible: true };
  };
  try {
    // prepare() primes the cursor as an un-awaited background side effect (proven by the
    // "a stalled cursor compositor cannot delay stage preparation or dispatch" test above,
    // where prepare() itself resolves even though showAgentCursor hangs forever).
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.cursorEvents, ["show:session-one"]);
    // Task completes while showAgentCursor is still awaiting resolveShow above.
    f.store.markDelivered([f.task.id], f.identity.sessionId);
    assert.equal(f.store.recordTaskResult(f.identity.token, f.task.id, "Done", { status: "completed", remainingWork: [] }).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"],
      "the reaper reaps the completed task's entry while show() is still in flight");
    resolveShow?.();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one", "close:session-one"],
      "the cursor that came back visible from the stale show() must still be reaped on the next tick, not left untracked");
  } finally { await f.service.close(); f.cleanup(); }
});

test("state file replacement retries transient Windows sharing errors, but surfaces persistent failures", () => {
  let calls = 0;
  const waits: number[] = [];
  renameStateFile("stage.tmp", "stage.json", {
    platform: "win32",
    rename: () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("temporary sharing lock"), { code: "EPERM" });
    },
    wait: (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 30]);

  assert.throws(() => renameStateFile("stage.tmp", "stage.json", {
    platform: "win32",
    rename: () => { throw Object.assign(new Error("missing source"), { code: "ENOENT" }); },
    wait: () => assert.fail("permanent failures must not be retried"),
  }), /missing source/);
});

test("app names and renderer aliases are targeting references, not an app catalog", () => {
  for (const value of ["terminal", "MSI Center", "Microsoft PowerPoint", "C:\\Windows\\System32\\cmd.exe"]) assert.equal(isStageAppReference(value), true);
  for (const value of ["cmd && echo bad", "chrome\n--flag", "", "cmd;whoami"]) assert.equal(isStageAppReference(value), false);
  assert.equal(stageWindowMatchesApp({ pid: 1, windowId: "2", appName: "WindowsTerminal.exe", title: "Windows PowerShell" }, { executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: [] }), true);
  assert.equal(stageWindowMatchesApp({ pid: 1, windowId: "2", appName: "Other.exe", title: "Windows PowerShell" }, { executable: "powershell.exe", args: [] }), false);
});

test("common terminal and browser names search Windows' friendly installed-app registrations", () => {
  assert.deepEqual(windowsAppSearchNames("terminal"), ["Terminal"]);
  assert.deepEqual(windowsAppSearchNames("Windows Terminal"), ["Terminal"]);
  assert.deepEqual(windowsAppSearchNames("wt"), ["Terminal"]);
  assert.deepEqual(windowsAppSearchNames("Google Chrome"), ["Google Chrome", "chrome"]);
  assert.deepEqual(windowsAppSearchNames("MSI Center"), ["MSI Center"]);
});

test("Windows app discovery searches pinned taskbar shortcuts", () => {
  assert.ok(WINDOWS_APP_DISCOVERY_SCRIPT.includes("User Pinned\\TaskBar"));
});

test("incomplete packaged renderer metadata stays ambiguous instead of crashing or guessing an executable", async () => {
  await assert.rejects(discoverInstalledWindowsApp("Editor", async () => JSON.stringify([
    { executable: "C:\\Windows\\explorer.exe", args: ["shell:AppsFolder\\Family!App"] },
    { executable: "C:\\Windows\\System32\\editor.exe", args: [] },
  ])), /multiple installed apps/);
});

test("app launches use the task project cwd and never inherit Windows System32", () => {
  const home = join(tmpdir(), "m9r-app-home");
  const project = join(home, "project");
  const isDirectory = (path: string) => path === home || path === project;
  assert.equal(stageAppLaunchCwd(project, { env: { M9R_PROJECT_ROOT: home }, fallback: home, isDirectory }), project);
  assert.equal(stageAppLaunchCwd("relative-project", { env: { M9R_PROJECT_ROOT: home }, fallback: home, isDirectory }), home);
  assert.equal(stageAppLaunchCwd("C:\\Windows\\System32", { env: { M9R_PROJECT_ROOT: "C:\\Windows\\System32" }, fallback: home, isDirectory }), home);
  assert.equal(stageAppLaunchCwd(undefined, { env: {}, fallback: home, isDirectory }), home);
});

test("a native target inspection failure is returned immediately instead of becoming an approval wait", async () => {
  const f = fixture(true);
  const failure = new Error("get_window_state: native inspection failed");
  f.driver.describeDesktopTarget = async () => { throw failure; };
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "owner-preview"),
      (error) => error instanceof Error && error.cause === failure && serializeStageFailure(error, "failed").dispatchState === "not-dispatched");
    assert.equal(f.desktopActions.some((action) => action.kind === "click"), false);
  } finally { f.cleanup(); }
});

test("approved task preparation is idempotent and does not invoke Windows desktop APIs", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.service.prepare(f.identity.token, f.task.id, "background"), f.service.prepare(f.identity.token, f.task.id, "background")]);
    assert.deepEqual(a, b);
    assert.equal(f.creations(), 0);
    assert.equal(f.retiredDesktopOpCount(), 0);
    assert.equal(JSON.stringify(a).includes("desktopId"), false);
    assert.equal(a.hasAnchor, false);
  } finally { f.cleanup(); }
});

test("omitted mode prepares owner-visible work without Windows desktop queries", async () => {
  const f = fixture(true);
  try {
    const prepared = await f.service.prepare(f.identity.token, f.task.id);
    assert.equal(prepared.mode, "owner-preview");
    assert.match(prepared.name, /^preview-agent-[a-f0-9]{24}$/);
    assert.equal(f.creations(), 0, "normal task preparation must not create or query a Windows desktop");

    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 88, y: 144 });
    assert.deepEqual(f.desktopActions, [{ kind: "cursor", x: 88, y: 144 }], "an omitted action mode must use the owner-visible desktop driver");
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("a stage operation id makes a replay return its durable receipt without moving the cursor twice", async () => {
  const f = fixture(true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    const first = await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 88, y: 144 }, "owner-preview", "mcp-test:cursor-1") as {
      operationReceipt?: { status?: string };
    };
    const replay = await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 88, y: 144 }, "owner-preview", "mcp-test:cursor-1") as {
      operationReceipt?: { status?: string };
      actionExecuted?: boolean;
    };

    assert.equal(f.desktopActions.filter((action) => action.kind === "cursor").length, 1);
    assert.equal(first.operationReceipt?.status, "applied");
    assert.equal(replay.operationReceipt?.status, "already_applied");
    assert.equal(replay.actionExecuted, false);
  } finally { f.cleanup(); }
});

test("same-size atomic state replacement cannot hide a settled operation behind a cached running receipt", () => {
  const f = fixture(true);
  try {
    const operation = { handle: "codex", sessionId: "session-one", taskId: f.task.id,
      operationId: "same-size-receipt", fingerprint: "a".repeat(64) };
    f.store.claimStageOperation(operation);
    const path = join(f.root, "state.json");
    const fixedTime = new Date("2026-11-16T00:00:00Z");
    utimesSync(path, fixedTime, fixedTime);
    assert.equal(f.store.inspectStageOperation(operation)?.state, "in_progress");
    const before = statSync(path);
    const next = JSON.parse(readFileSync(path, "utf8"));
    next.stageOperations[0].state = "applied"; // running/applied have equal byte lengths
    const replacement = join(f.root, "replacement.json");
    writeFileSync(replacement, JSON.stringify(next));
    utimesSync(replacement, fixedTime, fixedTime);
    renameStateFile(replacement, path);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    assert.equal(statSync(path).size, before.size);
    assert.equal(f.store.inspectStageOperation(operation)?.state, "applied");
    f.store.claimStageOperation(operation);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).stageOperations[0].state, "applied",
      "a subsequent write must not resurrect the cached running state");
  } finally { f.cleanup(); }
});

test("a stage operation id cannot be reused for a different action", async () => {
  const f = fixture(true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 88, y: 144 }, "owner-preview", "mcp-test:conflict");
    await assert.rejects(
      f.service.act(f.identity.token, f.task.id, { kind: "cursor", x: 89, y: 144 }, "owner-preview", "mcp-test:conflict"),
      /already belongs to a different stage action/,
    );
    assert.equal(f.desktopActions.filter((action) => action.kind === "cursor").length, 1);
  } finally { f.cleanup(); }
});

test("an owner desktop app request reuses personal Chrome without creating another process or desktop", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "chrome");
    return { executable: join(root, "chrome.exe"), args: [] };
  });
  try {
    f.setVisibleWindows([
      { pid: 123, windowId: "456", appName: "chrome.exe", title: "Work Chrome", width: 1280, height: 720 },
      { pid: 321, windowId: "789", appName: "chrome.exe", title: "Active Personal Chrome", width: 960, height: 640 },
    ].map(({ appName, ...window }) => ({ ...window, processName: appName })));
    f.setForegroundWindow(321, "789");
    const opened = await f.service.launch(f.identity.token, f.task.id, "chrome");
    assert.equal(opened.reused, true);
    assert.deepEqual(f.presentedWindows.at(-1), { pid: 321, windowId: "789" }, "the exact foreground HWND wins over other eligible Chrome windows");
    assert.ok(f.nativeOps.includes("currentForegroundWindow"));
    const prepared = await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    assert.equal(prepared.hasAnchor, true, "repeat preparation must retain the same live task's selected app");
    await f.service.act(f.identity.token, f.task.id, { kind: "capture" }, "owner-preview");
    assert.equal(f.desktopActions.length, 0, "omitted view follows the selected app, not a conflicting desktop mapping");
    await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "desktop" }, "owner-preview");
    assert.equal(f.desktopActions.length, 1);
    await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview");
    const next = f.store.addTask({ from: "you", to: "codex", goal: "Next app task", origin: "human_typed", targetSession: "session-one", idempotencyKey: "next-app" }).task;
    assert.equal((await f.service.prepare(f.identity.token, next.id, "owner-preview")).hasAnchor, true,
      "a newly authorized task in the same authenticated session retains its exact selected window");
    await f.service.act(f.identity.token, next.id, { kind: "capture", view: "app" }, "owner-preview");
    assert.equal(f.creations(), 0, "launch reuse must not create or query a Windows desktop");
  } finally { f.cleanup(); }
});

test("a handoff and its plain result can join the owner's exact window across sessions", async () => {
  const f = fixture(true, (root) => ({ executable: join(root, "chrome.exe"), args: [] }), undefined, true, { processAlive: () => true });
  try {
    f.setVisibleWindows([{ pid: 123, windowId: "456", processName: "chrome.exe", title: "Shared Chrome", width: 1280, height: 720 }]);
    await f.service.launch(f.identity.token, f.task.id, "chrome");
    const peer = f.store.issueIdentity("codex", "codex", "handoff-session");
    const handoff = f.store.addTask({ from: "claude", to: "codex", goal: "Continue on the shared window",
      origin: "agent_initiated", targetSession: "handoff-session", standingRuleApplies: true, idempotencyKey: "window-handoff",
      a2a: { taskId: f.task.id, conversationId: "shared-conversation", messageId: "handoff-message",
        senderAgentId: "agent-claude", recipientAgentId: "agent-codex", replyDepth: 0, kind: "surface-handoff", summary: "Your turn" } }).task;
    await f.service.launch(peer.token, handoff.id, "chrome");
    const resultIdentity = f.store.issueIdentity("codex", "codex", "result-session");
    const result = f.store.addTask({ from: "claude", to: "codex", goal: "The edit is ready to inspect",
      origin: "agent_initiated", targetSession: "result-session", standingRuleApplies: true, idempotencyKey: "window-result",
      parentTaskId: handoff.id, replyToTaskId: handoff.id }).task;
    await f.service.launch(resultIdentity.token, result.id, "chrome");
    await f.service.act(resultIdentity.token, result.id, { kind: "capture", view: "app" }, "owner-preview");
    assert.deepEqual(f.presentedWindows, Array(3).fill({ pid: 123, windowId: "456" }));
    assert.equal(f.creations(), 0);
    const unrelatedIdentity = f.store.issueIdentity("codex", "codex", "unrelated-session");
    const unrelated = f.store.addTask({ from: "you", to: "codex", goal: "Unrelated work",
      origin: "human_typed", targetSession: "unrelated-session", idempotencyKey: "unrelated-window-work" }).task;
    await assert.rejects(f.service.launch(unrelatedIdentity.token, unrelated.id, "chrome"), /claimed/);
  } finally { f.cleanup(); }
});

test("window_status reports native bounds for the exact selected window without relaunching it", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "chrome");
    return { executable: join(root, "chrome.exe"), args: [] };
  });
  try {
    f.setVisibleWindows([{ pid: 321, windowId: "789", processName: "chrome.exe", title: "Personal Chrome", width: 960, height: 640 }]);
    f.setForegroundWindow(321, "789");
    await f.service.launch(f.identity.token, f.task.id, "chrome");
    const status = await f.service.act(f.identity.token, f.task.id, { kind: "window_status", view: "app" }, "owner-preview") as {
      windowState: string; frame?: { x: number; y: number; width: number; height: number };
    };
    assert.equal(status.windowState, "visible");
    assert.deepEqual(status.frame, { x: -120, y: 40, width: 640, height: 480 });
    assert.ok(f.nativeOps.includes("windowStatus"));
    assert.ok(f.nativeOps.includes("windowRect"));
    assert.equal(f.nativeOps.filter((op) => op === "launch").length, 0, "reading bounds does not launch or replace a window");
  } finally { f.cleanup(); }
});

test("invalid stage modes fail closed instead of becoming background mode", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id, "unexpected" as never), /Invalid task stage mode/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("owner-preview preparation uses only an M9R stage mapping", async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    assert.equal(prepared.mode, "owner-preview");
    assert.match(prepared.name, /^preview-agent-[a-f0-9]{24}$/);
    assert.equal(prepared.hasAnchor, false);
    assert.equal("roomDesktopId" in prepared, false);
    assert.equal(f.creations(), 0, "preview preparation must not call retired Windows desktop operations");
  } finally { f.cleanup(); }
});

test("app view cannot use another task's stale registered window", async () => {
  const f = fixture(true);
  try {
    await f.service.prepare(f.identity.token, f.task.id);
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }), /no selected application window/);
  } finally { f.cleanup(); }
});

test("revoked identities and different target sessions cannot provision stages", async () => {
  const f = fixture();
  try {
    const other = f.store.issueIdentity("codex", "codex", "session-two");
    await assert.rejects(f.service.prepare(other.token, f.task.id), /does not belong/);
    f.store.revokeIdentity("session-one");
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id), /M9R could not authorize this desktop action/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("a stage broker with an unknown identity reports a safe authorization failure without echoing credentials", async () => {
  const f = fixture();
  const foreignRoot = mkdtempSync(join(tmpdir(), "m9r-stage-other-store-"));
  const foreignToken = createLocalStore(foreignRoot).issueIdentity("codex", "codex", "session-one").token;
  try {
    await assert.rejects(f.service.prepare(foreignToken, f.task.id), (error: unknown) => {
      const message = String(error);
      assert.match(message, /M9R could not authorize this desktop action/);
      assert.match(message, /No desktop input was sent/);
      assert.doesNotMatch(message, /session token|M9R_HOME|synchronize|restart/i);
      assert.equal((error as { code?: string }).code, "agent_identity_unavailable");
      assert.ok(!message.includes(foreignToken), "identity tokens must not be echoed in diagnostics");
      return true;
    });
    assert.equal(f.creations(), 0);
  } finally {
    rmSync(foreignRoot, { recursive: true, force: true });
    f.cleanup();
  }
});

test("pending and finished tasks cannot provision stages", async () => {
  const f = fixture();
  try {
    const { task: pending } = f.store.addTask({ from: "claude", to: "codex", goal: "Pending", origin: "agent_initiated", idempotencyKey: "pending" });
    await assert.rejects(f.service.prepare(f.identity.token, pending.id), /unfinished owner-authorized or approved/);
    f.store.markDelivered([f.task.id], f.identity.sessionId);
    assert.equal(f.store.recordTaskResult(f.identity.token, f.task.id, "Done", { status: "completed", remainingWork: [] }).ok, true);
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id), /unfinished owner-authorized or approved/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("stage permission is separate from task approval and denied by default", async () => {
  const f = fixture();
  try {
    assert.deepEqual(readTaskStagePolicy(f.root), { handles: [] });
    const denied = createTaskDesktopStageService({ store: f.store, stage: { env: {}, platform: "win32" } });
    await assert.rejects(denied.prepare(f.identity.token, f.task.id), /has not enabled/);
    assert.throws(() => setTaskStagePermission(f.root, "codex", true, { terminal: true, env: { CODEX_THREAD_ID: "agent" } }), /Only the owner/);
    setTaskStagePermission(f.root, "@codex", true, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(f.root), { handles: ["codex"] });
    setTaskStagePermission(f.root, "codex", false, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(f.root), { handles: [] });
  } finally { f.cleanup(); }
});

test("an agent process cannot host the stage broker", async () => {
  const f = fixture();
  try {
    const service = createTaskDesktopStageService({ store: f.store, stage: { env: { CODEX_THREAD_ID: "agent" } } });
    await assert.rejects(service.prepare(f.identity.token, f.task.id), /owner-launched/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

function moneyFixture(label: string | undefined, verdict: boolean, manualRelease = false) {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-money-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "session-money");
  const { task } = store.addTask({ from: "you", to: "codex", goal: "Use a stage", origin: "human_typed", idempotencyKey: `money-${label ?? "none"}-${verdict}-${Math.random()}` });
  let control = true;
  const seen: StageApprovalRequest[] = [];
  const clicks: Array<{ x: number; y: number }> = [];
  let releaseApproval: (() => void) | null = null;
  const nativeOps: string[] = [];
  const fakeDriver = {
    describeTarget: async () => (label === undefined ? undefined : { label }),
    click: async (_name: string, x: number, y: number) => {
      clicks.push({ x, y });
      return { capture: { dataUrl: "data:image/png;base64,x", width: 8, height: 8, capturedAt: new Date(0).toISOString() }, outcome: { status: "confirmed" as const } };
    },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const service = createTaskDesktopStageService({
    store,
    readPolicy: () => (control ? { handles: ["codex"], controlHandles: ["codex"] } : { handles: ["codex"] }),
    stage: {
      platform: "win32", env: {}, invokeNative: async (request) => {
        nativeOps.push(String(request.op));
        throw new Error(`Unexpected native operation in money-gate fixture: ${request.op}`);
      },
    },
    driver: fakeDriver,
    approvals: () => ({
      requestApproval: async (request: StageApprovalRequest) => {
        seen.push(request);
        if (manualRelease) await new Promise<void>((resolve) => { releaseApproval = resolve; });
        return verdict;
      },
    }),
  });
  return { root, store, identity, task, service, seen, clicks, nativeOps, setControl: (value: boolean) => { control = value; }, release: () => releaseApproval?.(), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a money-like stage click waits for the owner and never executes on deny", async () => {
  const f = moneyFixture("Pay $49 now", false);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    assert.equal(f.nativeOps.some((op) => ["currentDesktop", "createDesktop", "inspectDesktop", "activateDesktop", "moveWindowToDesktop"].includes(op)), false,
      "a task stage is a local mapping, not a Windows desktop operation");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background"),
      (error: unknown) => error instanceof DesktopInputNotDispatchedError && /did not approve/.test(error.message));
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].agent, "codex");
    assert.equal(f.seen[0].targetLabel, "Pay $49 now");
    assert.match(f.seen[0].step, /Pay \$49 now/);
    assert.equal(f.clicks.length, 0, "a denied purchase click must not reach the driver");
  } finally { f.cleanup(); }
});

test("an unlabeled visual control carries no money signal, but background coordinates still cannot inject input", async () => {
  const f = moneyFixture("", false);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 2, y: 3 }, "background", "unlabeled-control"), /background-only delivery/);
    assert.equal(f.seen.length, 0, "icons, thumbnails and canvases are ordinary controls, not purchases");
    assert.deepEqual(f.clicks, [], "background mode must not inject the shared physical mouse");
  } finally { f.cleanup(); }
});

test("an approved money-like stage click still requires explicit foreground confirmation", async () => {
  const f = moneyFixture("Subscribe", true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    const result = await f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10, confirmFocusForeground: true }, "background") as { outcome: { status: string } };
    assert.equal(result.outcome.status, "confirmed");
    assert.equal(f.seen.length, 1);
    assert.deepEqual(f.clicks, [{ x: 10, y: 10 }]);
  } finally { f.cleanup(); }
});

test("a benign coordinate click in background mode never takes foreground input", async () => {
  const f = moneyFixture("Next", true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background"), /background-only delivery/);
    assert.equal(f.seen.length, 0, "a benign coordinate click does not need a money review");
    assert.deepEqual(f.clicks, [], "background mode must not inject the shared physical mouse");
  } finally { f.cleanup(); }
});

test("an unlabeled coordinate click in background mode does not inject physical input", async () => {
  const f = moneyFixture(undefined, false);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background"), /background-only delivery/);
    assert.equal(f.seen.length, 0, "a missing description is not a money signal");
    assert.deepEqual(f.clicks, [], "background mode must not inject the shared physical mouse");
  } finally { f.cleanup(); }
});

test("revoking control while the owner decides stops the click even after approve", async () => {
  const f = moneyFixture("Pay now", true, true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    const pending = f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background");
    for (let i = 0; i < 200 && f.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.seen.length, 1, "the money click must be waiting on the owner before revocation lands");
    f.setControl(false);
    f.release();
    await assert.rejects(pending, /revoked/);
    assert.equal(f.clicks.length, 0, "a revoked agent must not click even with an approval in flight");
  } finally { f.cleanup(); }
});

test("enabled agents use any installed app; legacy access modes do not restore per-app gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-modes-"));
  try {
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true, "full");
    assert.deepEqual(readTaskStagePolicy(root), { handles: ["codex"], controlHandles: ["codex"] });
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "full");
    // Re-granting without a legacy mode preserves unrestricted app access.
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true);
    assert.deepEqual(readTaskStagePolicy(root), { handles: ["codex"], controlHandles: ["codex"] });
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "full");
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true, "request");
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "full");
    setTaskStagePermission(root, "codex", false, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(root), { handles: [] });
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "scoped");
    assert.equal(stageAccessMode({ handles: ["codex"], modes: { codex: "scoped" } }, "codex"), "full");
    assert.throws(() => setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true, "everything" as never), /Invalid stage access mode/);
    assert.throws(() => setTaskStagePermission(root, "codex", true, { terminal: true, env: { OPENCODE: "1" } }, true, "full"), /Only the owner/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed app resolution probes standard locations and explicitly supplied executable paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-resolve-"));
  try {
    const exe = join(root, "app.exe");
    writeFileSync(exe, "fake exe bytes");
    const env = { ProgramFiles: root, "ProgramFiles(x86)": root, LocalAppData: root };
    assert.throws(() => resolveUnlistedStageApp("chrome", { allowAbsolutePath: true, env, exists: () => false }), /not installed at any of its standard locations/);
    assert.throws(() => resolveUnlistedStageApp("notepad", { allowAbsolutePath: true, env }), /not installed or could not be resolved/);
    assert.throws(() => resolveUnlistedStageApp(exe, { allowAbsolutePath: false, env }), /not installed or could not be resolved/, "the broker controls whether absolute paths are resolved");
    const resolved = resolveUnlistedStageApp(exe, { allowAbsolutePath: true, env });
    assert.equal(resolved.wellKnown, false);
    assert.deepEqual(resolved.args, []);
    assert.equal(resolved.executable, exe, "direct app resolution does not require a catalog entry or hash");
    assert.throws(() => resolveUnlistedStageApp(join(root, "app.txt"), { allowAbsolutePath: true, env }), /not installed or could not be resolved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an enabled agent resolves any named or absolute app without per-app approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-launch-"));
  try {
    const exe = join(root, "toollauncher.exe");
    writeFileSync(exe, "fake exe bytes");
    const chromeExe = join(root, "Google", "Chrome", "Application", "chrome.exe");
    const full = { handles: ["codex"], controlHandles: ["codex"], modes: { codex: "full" as const } };
    const scoped = { handles: ["codex"], controlHandles: ["codex"], modes: { codex: "scoped" as const } };
    const request = { handles: ["codex"], controlHandles: ["codex"], modes: { codex: "request" as const } };
    const decided = resolveLaunchTarget(full, "codex", exe);
    assert.equal(decided.app.executable, exe);
    assert.deepEqual(resolveLaunchTarget(scoped, "codex", exe).app, decided.app);
    assert.deepEqual(resolveLaunchTarget(request, "codex", exe).app, decided.app);
    // Legacy policy modes are read for migration but never restore app-level gates.
    mkdirSync(join(root, "Google", "Chrome", "Application"), { recursive: true });
    writeFileSync(chromeExe, "fake chrome bytes");
    const installed = (p: string) => p === chromeExe;
    const held = resolveLaunchTarget(request, "codex", "chrome", { env: { ProgramFiles: root }, exists: installed });
    assert.equal(held.app.executable, chromeExe);
    assert.equal("needsApproval" in held, false);
    const direct = resolveLaunchTarget(full, "codex", "chrome", { env: { ProgramFiles: root }, exists: installed });
    assert.equal(direct.app.executable, chromeExe);
    assert.equal("needsApproval" in direct, false);
    assert.throws(() => resolveLaunchTarget({ handles: [] }, "codex", exe), /not been granted task-stage access/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owner-preview reuses the exact durable HWND without querying a Windows desktop", async () => {
  const f = fixture(true, (root) => ({ executable: join(root, "chrome.exe"), args: [] }));
  try {
    f.setVisibleWindows([{ pid: 123, windowId: "456", processName: "chrome.exe", title: "Personal Chrome", width: 1280, height: 720 }]);
    await f.service.launch(f.identity.token, f.task.id, "chrome");
    f.nativeOps.length = 0;
    await f.service.prepare(f.identity.token, f.task.id);
    assert.equal(f.nativeOps.includes("inspect"), false, "preparation keeps the durable HWND without an extra native round trip");
    assert.equal(f.retiredDesktopOpCount(), 0);
    f.nativeOps.length = 0;
    const reused = await f.service.launch(f.identity.token, f.task.id, "chrome");
    assert.equal(reused.reused, true);
    assert.ok(f.nativeOps.includes("inspect"), "launch reuse validates the exact anchored HWND");
    assert.equal(f.retiredDesktopOpCount(), 0, "no physical desktop identity participates in HWND selection");
    assert.deepEqual(f.presentedWindows.at(-1), { pid: 123, windowId: "456" });
  } finally { f.cleanup(); }
});

test("background launch attaches one exact existing app window without presenting or starting another", async () => {
  const f = fixture(true, (root) => ({ executable: join(root, "notepad.exe"), args: [] }));
  try {
    f.setVisibleWindows([{ pid: 321, windowId: "789", processName: "notepad.exe", title: "bilateral-native.txt - Notepad", width: 900, height: 600 }]);
    const result = await f.service.launch(f.identity.token, f.task.id, "notepad", "background", "reuse-exact-window");
    assert.equal(result.reused, true);
    assert.deepEqual(f.presentedWindows, [], "background binding must not raise the existing target");
    const registry = JSON.parse(readFileSync(join(f.root, "windows-stages.json"), "utf8")) as {
      stages: Array<{ appId?: string; anchor?: { pid: number; windowId: string } }>;
    };
    assert.equal(registry.stages[0]?.appId, "notepad");
    assert.deepEqual(registry.stages[0]?.anchor, { pid: 321, windowId: "789" });
    const state = JSON.parse(readFileSync(join(f.root, "state.json"), "utf8")) as { stageOperations: Array<{ taskId: string; state: string }> };
    assert.equal(state.stageOperations.find((operation) => operation.taskId === f.task.id)?.state, "applied");
  } finally { f.cleanup(); }
});

test("a session can switch background app targets without closing the previously attached window", async () => {
  const f = fixture(true, (root, appId) => ({ executable: join(root, `${appId}.exe`), args: [] }));
  try {
    f.setVisibleWindows([
      { pid: 321, windowId: "789", processName: "notepad.exe", title: "bilateral-native.txt - Notepad", width: 900, height: 600 },
      { pid: 322, windowId: "790", processName: "chrome.exe", title: "Bilateral owner document - Google Chrome", width: 1200, height: 800 },
    ]);
    await f.service.launch(f.identity.token, f.task.id, "notepad", "background", "switch-notepad");
    const followup = f.store.addTask({ from: "you", to: "codex", goal: "Continue in the existing browser", origin: "human_typed",
      idempotencyKey: "switch-to-chrome", targetSession: "session-one" }).task;
    await f.service.prepare(f.identity.token, followup.id, "background");
    const switched = await f.service.launch(f.identity.token, followup.id, "chrome", "background", "switch-chrome");
    assert.equal(switched.reused, true);
    assert.deepEqual(f.presentedWindows, [], "background app switching must not focus either window");
    const registry = JSON.parse(readFileSync(join(f.root, "windows-stages.json"), "utf8")) as {
      stages: Array<{ appId?: string; anchor?: { pid: number; windowId: string } | null }>;
    };
    assert.equal(registry.stages[0]?.appId, "chrome");
    assert.deepEqual(registry.stages[0]?.anchor, { pid: 322, windowId: "790" });
  } finally { f.cleanup(); }
});

test("background launch refuses to guess among multiple existing app windows", async () => {
  const f = fixture(true, (root) => ({ executable: join(root, "notepad.exe"), args: [] }));
  try {
    f.setVisibleWindows([
      { pid: 321, windowId: "789", processName: "notepad.exe", title: "first.txt - Notepad", width: 900, height: 600 },
      { pid: 322, windowId: "790", processName: "notepad.exe", title: "second.txt - Notepad", width: 900, height: 600 },
    ]);
    await assert.rejects(f.service.launch(f.identity.token, f.task.id, "notepad", "background", "ambiguous-target"),
      (error) => error instanceof DesktopInputNotDispatchedError && error.code === "target-identity" && /More than one existing notepad window/.test(error.message));
    assert.deepEqual(f.presentedWindows, [], "an ambiguous background target must not be presented or launched");
    assert.equal(Boolean(f.store.getTask(f.task.id)?.stageTiming?.some((event) => event.phase === "launch-discovery")), false,
      "ambiguity must be resolved before process launch or new-window polling");
    const state = JSON.parse(readFileSync(join(f.root, "state.json"), "utf8")) as { stageOperations: Array<{ taskId: string }> };
    assert.equal(state.stageOperations.some((operation) => operation.taskId === f.task.id), false,
      "a pre-dispatch target refusal releases its receipt instead of leaving an uncertain operation");
  } finally { f.cleanup(); }
});

test("background launch refuses before process start when no exact existing app window is visible", async () => {
  const f = fixture(true, (root) => ({ executable: join(root, "notepad.exe"), args: [] }));
  try {
    await assert.rejects(f.service.launch(f.identity.token, f.task.id, "notepad", "background", "missing-target"),
      (error) => error instanceof DesktopInputNotDispatchedError && error.code === "target-identity" && /No existing notepad window/.test(error.message));
    assert.deepEqual(f.presentedWindows, [], "a missing background target must not be presented or launched");
    assert.equal(Boolean(f.store.getTask(f.task.id)?.stageTiming?.some((event) => event.phase === "launch-discovery")), false,
      "a missing target must be reported before process launch or new-window polling");
    const state = JSON.parse(readFileSync(join(f.root, "state.json"), "utf8")) as { stageOperations: Array<{ taskId: string }> };
    assert.equal(state.stageOperations.some((operation) => operation.taskId === f.task.id), false,
      "a pre-dispatch target refusal releases its receipt instead of leaving an uncertain operation");
  } finally { f.cleanup(); }
});

test("a persisted ApplicationFrameHost HWND is not reused after Windows changes its app identity", async () => {
  const settingsAumid = "Microsoft.Windows.Settings_8wekyb3d8bbwe!App";
  const calculatorAumid = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
  const app: StageAppLaunchSpec = { executable: "C:\\Windows\\explorer.exe",
    args: [`shell:AppsFolder\\${settingsAumid}`], windowExecutable: "ApplicationFrameHost.exe", appUserModelId: settingsAumid };
  const f = fixture(true, () => app);
  const frame = (windowId: string, appUserModelId: string): TestVisibleWindow => ({ pid: 123, windowId,
    appName: "ApplicationFrameHost.exe", processName: "ApplicationFrameHost.exe", className: "ApplicationFrameWindow",
    appUserModelId, title: "Settings", width: 900, height: 700, zOrder: 0 });
  try {
    f.setVisibleWindows([frame("456", settingsAumid)]);
    await f.service.launch(f.identity.token, f.task.id, "settings");

    // Windows may keep the same ApplicationFrameHost process and numeric HWND
    // while changing the packaged view it hosts. A persisted PID/HWND is not
    // enough to establish app identity.
    f.setVisibleWindows([frame("456", calculatorAumid), frame("789", settingsAumid)]);
    const selected = await f.service.launch(f.identity.token, f.task.id, "settings");
    assert.equal(selected.reused, true);
    assert.deepEqual(f.presentedWindows.at(-1), { pid: 123, windowId: "789" },
      "the launch reuses the exact live Settings HWND, never the stale frame now hosting Calculator");
  } finally { f.cleanup(); }
});

test("an unconfirmed cursor remains tracked for terminal-task cleanup", async () => {
  const f = fixture(true);
  try {
    f.store.registerEndpoint({ provider: "codex", sessionId: "session-one" });
    f.store.markDelivered([f.task.id], f.identity.sessionId);
    f.driver.showAgentCursor = (async () => {
      f.cursorEvents.push("show:session-one");
      return { label: "Codex", visible: false };
    }) as never;
    assert.equal((await f.service.primeCursor(f.identity.token, f.task.id)).shown, false);
    f.store.pauseTask(f.task.id);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(f.cursorEvents, ["show:session-one", "close:session-one"]);
  } finally { await f.service.close(); f.cleanup(); }
});
