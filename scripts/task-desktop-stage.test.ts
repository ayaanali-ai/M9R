import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameStateFile } from "../src/lib/native/atomic-file";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService, readTaskStagePolicy, resolveLaunchTarget, setTaskStagePermission, stageAccessMode, TASK_STAGE_POLICY_FILE } from "../src/lib/native/task-desktop-stage";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { resolveUnlistedStageApp, isStageAppReference, stageAppLaunchCwd, stageWindowMatchesApp, type StageAppLaunchSpec } from "../src/lib/native/task-stage-apps";
import { windowsAppSearchNames, WINDOWS_APP_DISCOVERY_SCRIPT } from "../src/lib/native/windows-installed-apps";
import type { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import type { StageApprovalRequest } from "../src/lib/native/web-broker-core";
import { DesktopInputNotDispatchedError } from "../src/lib/native/desktop-input-errors";

function fixture(control = false, resolveStageAppForTest?: (root: string, appId: string) => StageAppLaunchSpec,
  resolveWindowExecutable?: (executable: string) => Promise<string | undefined>) {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-stage-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "session-one");
  const { task } = store.addTask({ from: "you", to: "codex", goal: "Use a stage", origin: "human_typed", idempotencyKey: "stage-one", targetSession: "session-one" });
  let creations = 0;
  const desktopActions: Array<{ kind: string; x?: number; y?: number }> = [];
  const cursorPrepares: Array<{ stageName: string; handle: string; sessionId: string }> = [];
  const currentDesktopId = "33333333-3333-4333-8333-333333333333";
  // Lets a test swap in a different "inspect" native response after setup,
  // without touching every other test's default always-fresh behavior.
  let inspectOverride: (() => { ok: false; error: string } | { ok: true; window: { pid: number; windowId: string; desktopId: string; onCurrentDesktop: boolean } }) | undefined;
  const previewCapture = { dataUrl: "data:image/png;base64,eA==", width: 1280, height: 720, capturedAt: new Date(0).toISOString() };
  const driver = {
    capture: async () => previewCapture,
    captureDesktop: async () => { desktopActions.push({ kind: "capture" }); return previewCapture; },
    showAgentCursor: async (stageName: string, cursorIdentity: { handle: string; sessionId: string }) => {
      cursorPrepares.push({ stageName, handle: cursorIdentity.handle, sessionId: cursorIdentity.sessionId });
      return { label: "Codex", visible: true as const };
    },
    moveDesktopCursor: async (_name: string, x: number, y: number) => {
      desktopActions.push({ kind: "cursor", x, y });
      return { capture: previewCapture, outcome: { status: "confirmed" as const } };
    },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const recreateService = () => createTaskDesktopStageService({ store, readPolicy: () => ({ handles: ["codex"], ...(control ? { controlHandles: ["codex"] } : {}) }), driver,
    ...(resolveWindowExecutable ? { resolveWindowExecutable } : {}),
    ...(resolveStageAppForTest ? { resolveStageAppForTest: (appId: string) => resolveStageAppForTest(root, appId) } : {}), stage: {
    platform: "win32", env: {}, invokeNative: async (request) => {
      if (request.op === "currentDesktop") return { ok: true, desktop: { desktopId: currentDesktopId, isCurrent: true } };
      if (request.op === "createDesktop") {
        creations++;
        return { ok: true, desktop: { desktopId: "11111111-1111-4111-8111-111111111111", isCurrent: false, returnDesktopId: "22222222-2222-4222-8222-222222222222" } };
      }
      if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: String(request.desktopId) === currentDesktopId } };
      if (request.op === "presentOwnerWindow") return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId: currentDesktopId, onCurrentDesktop: true } };
      if (request.op === "inspect") return inspectOverride?.() ?? { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId: currentDesktopId, onCurrentDesktop: true } };
      throw new Error("Unexpected native operation; preparation must not move or activate windows.");
    },
  } });
  const service = recreateService();
  return { root, store, identity, task, service, recreateService, driver, creations: () => creations, desktopActions, cursorPrepares,
    setInspectOverride: (fn: typeof inspectOverride) => { inspectOverride = fn; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

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

test("owner-preview repairs a saved zero desktop ID and refuses zero IDs from the native helper", async () => {
  const testTemp = join(process.cwd(), ".test-tmp");
  mkdirSync(testTemp, { recursive: true });
  const root = mkdtempSync(join(testTemp, "m9r-zero-desktop-id-"));
  const stageName = "preview-agent-test";
  const emptyId = "00000000-0000-0000-0000-000000000000";
  const currentId = "33333333-3333-4333-8333-333333333333";
  const roomDesktopId = "44444444-4444-4444-8444-444444444444";
  writeFileSync(join(root, "windows-stages.json"), JSON.stringify({
    version: 3,
    stages: [{
      name: stageName,
      desktopId: emptyId,
      roomDesktopId,
      returnToDesktopId: null,
      anchor: null,
      roomWindowId: null,
      agentAssignment: { handle: "codex", sessionTag: "12345678" },
      registeredAt: "2026-10-06T19:12:50.290Z",
    }],
  }));
  let reportedDesktopId = currentId;
  const manager = createWindowsDesktopStageManager({
    platform: "win32",
    root,
    env: {},
    terminal: true,
    invokeNative: async (request) => {
      if (request.op === "currentDesktop") return { ok: true, desktop: { desktopId: reportedDesktopId, isCurrent: true } };
      if (request.op === "inspect") return { ok: true, window: {
        pid: Number(request.pid), windowId: String(request.windowId), desktopId: reportedDesktopId, onCurrentDesktop: true,
      } };
      throw new Error("Unexpected native operation.");
    },
  });

  try {
    const adopted = await manager.adoptCurrentDesktop(stageName);
    assert.equal(adopted.desktopId, currentId, "a valid current desktop repairs the legacy zero mapping");
    assert.equal(adopted.agentAssignment?.sessionTag, "12345678", "repair preserves the agent assignment");
    assert.equal(adopted.roomDesktopId, roomDesktopId, "repair preserves the room coordination identity");

    reportedDesktopId = emptyId;
    await assert.rejects(manager.adoptCurrentDesktop(stageName), /invalid desktop result/);
    await assert.rejects(manager.inspectWindow("123", "456"), /invalid window result/);
    assert.equal(manager.list()[0]?.desktopId, currentId, "invalid native data must not overwrite the repaired mapping");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      (error) => error === failure);
    assert.equal(f.desktopActions.some((action) => action.kind === "click"), false);
  } finally { f.cleanup(); }
});

test("approved task preparation is idempotent and does not expose desktop GUIDs", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.service.prepare(f.identity.token, f.task.id, "background"), f.service.prepare(f.identity.token, f.task.id, "background")]);
    assert.deepEqual(a, b);
    assert.equal(f.creations(), 1);
    assert.equal(JSON.stringify(a).includes("11111111-1111"), false);
    assert.equal(a.hasAnchor, false);
  } finally { f.cleanup(); }
});

test("each staged request durably records its queue and execution timing on the task", async () => {
  const f = fixture(true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "desktop" }, "owner-preview", "timing-capture-1");

    const persisted = f.store.getTask(f.task.id);
    assert.ok(persisted?.stageTiming, "stage timing must be stored on the task record");
    assert.ok(persisted.stageTiming.some((event) => event.phase === "prepare" && event.status === "ok"));
    assert.ok(persisted.stageTiming.some((event) => event.phase === "action" && event.operationId === "timing-capture-1" && event.status === "ok"));
    for (const event of persisted.stageTiming) {
      assert.ok(Date.parse(event.startedAt) <= Date.parse(event.endedAt));
      assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    }
  } finally { f.cleanup(); }
});

test("durable task timing accepts the inner Cua phases used for latency reconciliation", async () => {
  const f = fixture(true);
  try {
    const startedAt = new Date().toISOString();
    const endedAt = new Date(Date.now() + 3).toISOString();
    for (const phase of ["sdk-load", "host-connect", "runtime-acquire", "session-start", "cursor-motion"] as const) {
      assert.equal(f.store.recordStageTiming(f.task.id, {
        phase, startedAt, endedAt, durationMs: 3, status: "ok",
      }), true);
    }
    const persisted = f.store.getTask(f.task.id);
    assert.deepEqual(persisted?.stageTiming?.map((event) => event.phase), [
      "sdk-load", "host-connect", "runtime-acquire", "session-start", "cursor-motion",
    ]);
  } finally { f.cleanup(); }
});

test("omitted mode stays on the owner's current desktop for preparation and cursor actions", async () => {
  const f = fixture(true);
  try {
    const prepared = await f.service.prepare(f.identity.token, f.task.id);
    assert.equal(prepared.mode, "owner-preview");
    assert.match(prepared.name, /^preview-agent-[a-f0-9]{24}$/);
    assert.equal(f.creations(), 0, "normal task preparation must not create a virtual desktop");

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

test("a typed pre-dispatch refusal releases its claim instead of turning it uncertain", async () => {
  const f = fixture(true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    const refusal = new DesktopInputNotDispatchedError("No text was sent.");
    f.driver.typeTextDesktop = async () => { throw refusal; };
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "type", text: "safe" }, "owner-preview", "refused-op"), (error) => error === refusal);
    f.driver.typeTextDesktop = async () => ({ capture: { dataUrl: "", width: 1, height: 1, capturedAt: new Date().toISOString() }, outcome: { status: "confirmed" } });
    const result = await f.service.act(f.identity.token, f.task.id, { kind: "type", text: "safe" }, "owner-preview", "refused-op") as { operationReceipt: { status: string } };
    assert.equal(result.operationReceipt.status, "applied");
  } finally { f.cleanup(); }
});

test("explicit stop bypasses the occupied stage queue and aborts its in-flight text call", async () => {
  const f = fixture(true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    let activeSignal: AbortSignal | undefined;
    f.driver.typeTextDesktop = async (_name, _text, _identity, options) => {
      assert.ok(options?.signal);
      activeSignal = options.signal;
      started();
      return new Promise<never>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    };
    const pending = assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "type", text: "long" }, "owner-preview"), /stop requested/);
    await dispatched;
    const other = f.store.addTask({ from: "you", to: "codex", goal: "Other task", origin: "human_typed", idempotencyKey: "other-stop", targetSession: "session-one" }).task;
    const otherStop = await f.service.act(f.identity.token, other.id, { kind: "stop" }, "owner-preview");
    assert.equal((otherStop as { stopped: boolean }).stopped, false);
    assert.equal(activeSignal?.aborted, false, "stopping another task must not abort this task's input");
    const result = await f.service.act(f.identity.token, f.task.id, { kind: "stop" }, "owner-preview");
    assert.equal((result as { stopped: boolean }).stopped, true);
    await pending;
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "type", text: "queued" }, "owner-preview"), /explicitly stopped/);
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
    f.driver.listVisibleWindows = async () => [{ pid: 123, windowId: "456", appName: "chrome.exe", title: "Personal Chrome", width: 1280, height: 720 }];
    const opened = await f.service.launch(f.identity.token, f.task.id, "chrome");
    assert.equal(opened.reused, true);
    const prepared = await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    assert.equal(prepared.hasAnchor, true, "repeat preparation must retain the same live task's selected app");
    await f.service.act(f.identity.token, f.task.id, { kind: "capture" }, "owner-preview");
    assert.equal(f.desktopActions.length, 0, "omitted view follows the selected app, not a conflicting desktop mapping");
    await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "desktop" }, "owner-preview");
    assert.equal(f.desktopActions.length, 1);
    await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview");
    // A real agent session naturally issues a fresh taskId for a follow-up request even
    // when continuing the exact same piece of work. The stage (one per identity/session,
    // see authorize()) already has a selected app; a new task in the *same* session
    // continues using it rather than being rejected for not being the exact task that
    // originally selected it.
    const next = f.store.addTask({ from: "you", to: "codex", goal: "Next app task", origin: "human_typed", targetSession: "session-one", idempotencyKey: "next-app" }).task;
    assert.equal((await f.service.prepare(f.identity.token, next.id, "owner-preview")).hasAnchor, true, "a new task in the same session continues using the already-selected app");
    await f.service.act(f.identity.token, next.id, { kind: "capture", view: "app" }, "owner-preview");
    // The reuse check previously only ran for background-mode launches --
    // owner-preview launch() skipped it entirely, so a follow-up launch of the
    // same app under a new taskId (the normal case for a continuing session)
    // always opened a second window instead of reusing the one already open.
    const relaunched = await f.service.launch(f.identity.token, next.id, "chrome");
    assert.equal(relaunched.running, true, "launch() of the same already-running app under a new taskId reuses it instead of opening a duplicate");
    assert.equal(f.creations(), 0, "launch without an explicit background mode must not create a desktop or process");
  } finally { f.cleanup(); }
});

test("owner-preview launch presents an existing app without stealing the owner's foreground", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "paint");
    return { executable: join(root, "mspaint.exe"), args: [] };
  });
  let focusCalls = 0;
  try {
    f.driver.listVisibleWindows = async () => [{ pid: 321, windowId: "654", appName: "mspaint.exe", title: "Paint", width: 1000, height: 700 }];
    f.driver.focusWindow = async () => {
      focusCalls += 1;
      return { capture: { dataUrl: "data:image/png;base64,eA==", width: 1, height: 1, capturedAt: new Date(0).toISOString() }, outcome: { status: "confirmed" as const } };
    };
    const launched = await f.service.launch(f.identity.token, f.task.id, "paint", "owner-preview");
    assert.equal(launched.reused, true);
    assert.equal(focusCalls, 0, "launch must not activate a window; focus is an explicit leased action");
  } finally { f.cleanup(); }
});

test("same-intent owner-preview stages join one native app window instead of launching duplicates", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "calculator");
    return { executable: join(root, "calculator.exe"), args: [] };
  }, async () => "CalculatorApp.exe");
  try {
    const visible = [{ pid: 123, windowId: "456", appName: "CalculatorApp.exe", title: "Calculator", width: 500, height: 700 }];
    f.driver.listVisibleWindows = async () => visible;
    const first = await f.service.launch(f.identity.token, f.task.id, "calculator", "owner-preview");
    assert.equal(first.reused, true, "the first owner-preview stage adopts the already-open Calculator");

    const secondIdentity = f.store.issueIdentity("codex", "codex", "session-two");
    const secondTask = f.store.addTask({ from: "you", to: "codex", goal: f.task.goal, origin: "human_typed",
      idempotencyKey: "same-calculator-intent-second", targetSession: "session-two" }).task;
    const second = await f.service.launch(secondIdentity.token, secondTask.id, "calculator", "owner-preview");
    assert.equal(second.reused, true, "a second provider stage with the same owner intent joins the existing window");
    const stages = createWindowsDesktopStageManager({ root: f.root, platform: "win32", terminal: true, env: {} }).list();
    assert.equal(stages.length, 2, "the providers retain separate stage identities");
    assert.equal(stages[0]?.coordinationKey, stages[1]?.coordinationKey, "the shared coordination key is durable");
    assert.deepEqual(stages.map((stage) => stage.anchor), [{ pid: 123, windowId: "456" }, { pid: 123, windowId: "456" }]);
  } finally { f.cleanup(); }
});

test("a stage launch operation id prevents a lost response from launching or adopting twice", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "chrome");
    return { executable: join(root, "chrome.exe"), args: [] };
  });
  try {
    f.driver.listVisibleWindows = async () => [{ pid: 123, windowId: "456", appName: "chrome.exe", title: "Personal Chrome", width: 1280, height: 720 }];
    const first = await f.service.launch(f.identity.token, f.task.id, "chrome", "owner-preview", "mcp-test:launch-1");
    const replay = await f.service.launch(f.identity.token, f.task.id, "chrome", "owner-preview", "mcp-test:launch-1");
    assert.equal(first.reused, true);
    assert.equal(first.operationReceipt?.status, "applied");
    assert.equal(replay.operationReceipt?.status, "already_applied");
    assert.equal(replay.actionExecuted, false);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("background launch adopts a delegated window after its launcher exits and a fresh service recovers it", async () => {
  const root = mkdtempSync(join(process.cwd(), ".m9r-stage-handoff-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "session-handoff");
  const { task } = store.addTask({ from: "you", to: "codex", goal: "Launch a hand-off app", origin: "human_typed", idempotencyKey: "handoff-launch", targetSession: "session-handoff" });
  const stageDesktop = "11111111-1111-4111-8111-111111111111";
  const ownerDesktop = "22222222-2222-4222-8222-222222222222";
  let visibleCalls = 0;
  const delegatedWindow = { pid: 9876, windowId: "8765", appName: "node.exe", title: "Delegated app", width: 900, height: 700 };
  const previewCapture = { dataUrl: "data:image/png;base64,eA==", width: 900, height: 700, capturedAt: new Date(0).toISOString() };
  const fakeDriver = {
    listVisibleWindows: async () => {
      visibleCalls += 1;
      if (visibleCalls === 1) return [];
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [delegatedWindow];
    },
    capture: async () => previewCapture,
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const stage = {
    platform: "win32" as const, env: {},
    invokeNative: async (request: Record<string, unknown>) => {
      if (request.op === "createDesktop") return { ok: true as const, desktop: { desktopId: stageDesktop, isCurrent: false, returnDesktopId: ownerDesktop } };
      if (request.op === "inspectDesktop") return { ok: true as const, desktop: { desktopId: String(request.desktopId), isCurrent: false } };
      if (request.op === "listOwnedWindows") return { ok: true as const, windows: [] };
      if (request.op === "showAndMoveOwnedWindow" || request.op === "showOwnedWindow") {
        return { ok: true as const, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId: stageDesktop, onCurrentDesktop: false } };
      }
      if (request.op === "inspect") {
        return { ok: true as const, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId: stageDesktop, onCurrentDesktop: false } };
      }
      throw new Error(`Unexpected native operation in hand-off fixture: ${String(request.op)}`);
    },
  };
  const createService = () => createTaskDesktopStageService({
    store,
    driver: fakeDriver,
    stage,
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    resolveStageAppForTest: () => ({ executable: process.execPath, args: ["-e", ""] }),
  });
  try {
    const first = createService();
    await first.prepare(identity.token, task.id, "background");
    const launched = await first.launch(identity.token, task.id, "handoff-app", "background");
    assert.equal(launched.running, true, "a delegated window is sufficient ownership proof after the launcher exits");
    assert.equal(launched.appId, "handoff-app");

    const reloaded = createService();
    await reloaded.prepare(identity.token, task.id, "background");
    const recovered = await reloaded.act(identity.token, task.id, { kind: "capture", view: "app" }, "background");
    assert.deepEqual((recovered as { capture?: unknown }).capture, previewCapture, "a fresh broker must recover the selected window from the durable registry anchor");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid stage modes fail closed instead of becoming background mode", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id, "unexpected" as never), /Invalid task stage mode/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("owner-preview preparation does not create or switch to a background desktop", async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    assert.equal(prepared.mode, "owner-preview");
    assert.match(prepared.name, /^preview-agent-[a-f0-9]{24}$/);
    assert.equal(prepared.hasAnchor, false);
    assert.equal("roomDesktopId" in prepared, false);
    assert.equal(f.creations(), 0, "preview preparation must not call createDesktop");
  } finally { f.cleanup(); }
});

test("approved preparation makes the labeled cursor visible before any app action and keeps session metadata private", async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    assert.deepEqual(f.cursorPrepares, [{ stageName: prepared.name, handle: "codex", sessionId: "session-one" }]);
    assert.equal(JSON.stringify(prepared).includes("sessionTag"), false);
    assert.equal(JSON.stringify(prepared).includes("session-one"), false, "provider session IDs must not enter stage responses");
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
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id), /revoked/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("a stage broker with a different identity store explains the M9R_HOME mismatch without echoing the token", async () => {
  const f = fixture();
  const foreignRoot = mkdtempSync(join(tmpdir(), "m9r-stage-other-store-"));
  const foreignToken = createLocalStore(foreignRoot).issueIdentity("codex", "codex", "session-one").token;
  try {
    await assert.rejects(f.service.prepare(foreignToken, f.task.id), (error: unknown) => {
      const message = String(error);
      assert.match(message, /stage broker cannot verify this session identity/);
      assert.match(message, /different M9R_HOME values/);
      assert.match(message, /synchronize their M9R_HOME settings/);
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
    await assert.rejects(f.service.prepare(f.identity.token, pending.id), /approved, unfinished/);
    f.store.setResult(f.task.id, "Done");
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id), /approved, unfinished/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("a stale permission lock from a killed process self-heals; a genuinely fresh one still blocks", async () => {
  // Before this fix, a lock directory with no PID, no age limit, and no
  // staleness check meant a process killed while holding it (a forced
  // broker restart, in particular -- this happened many times in one real
  // session) permanently broke every future permission change until a human
  // deleted the lock directory by hand, with only a raw EEXIST to show for it.
  const f = fixture();
  try {
    const lock = join(f.root, `${TASK_STAGE_POLICY_FILE}.lock`);
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    // A 60-second-old lock is self-healed: the permission change still succeeds.
    setTaskStagePermission(f.root, "codex", true, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(f.root), { handles: ["codex"] });

    mkdirSync(lock);
    // A genuinely fresh lock (just created, well under the staleness window)
    // still correctly blocks -- this is not a blanket bypass of the lock.
    assert.throws(() => setTaskStagePermission(f.root, "codex", false, { terminal: true, env: {} }), /already running/);
    rmSync(lock, { recursive: true, force: true });
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
        if (request.op === "createDesktop") return { ok: true, desktop: { desktopId: "11111111-1111-4111-8111-111111111111", isCurrent: false, returnDesktopId: "22222222-2222-4222-8222-222222222222" } };
        if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: false } };
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
  return { root, store, identity, task, service, seen, clicks, setControl: (value: boolean) => { control = value; }, release: () => releaseApproval?.(), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a money-like stage click waits for the owner and never executes on deny", async () => {
  const f = moneyFixture("Pay $49 now", false);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background"), /did not approve/);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].agent, "codex");
    assert.equal(f.seen[0].targetLabel, "Pay $49 now");
    assert.match(f.seen[0].step, /Pay \$49 now/);
    assert.equal(f.clicks.length, 0, "a denied purchase click must not reach the driver");
  } finally { f.cleanup(); }
});

test("an approved money-like stage click executes once with the approval on record", async () => {
  const f = moneyFixture("Subscribe", true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    const result = await f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background") as { outcome: { status: string } };
    assert.equal(result.outcome.status, "confirmed");
    assert.equal(f.seen.length, 1);
    assert.deepEqual(f.clicks, [{ x: 10, y: 10 }]);
  } finally { f.cleanup(); }
});

test("a benign stage click never bothers the owner", async () => {
  const f = moneyFixture("Next", true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background");
    assert.equal(f.seen.length, 0, "standing approval covers non-money clicks without a hold");
    assert.deepEqual(f.clicks, [{ x: 10, y: 10 }]);
  } finally { f.cleanup(); }
});

test("an undescribed click target refuses before dispatch instead of becoming an approval wait", async () => {
  const f = moneyFixture(undefined, false);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background"), (error) => {
      assert.ok(error instanceof DesktopInputNotDispatchedError);
      assert.match(error.message, /could not be resolved/);
      assert.match(error.message, /No input was sent/);
      return true;
    });
    assert.equal(f.seen.length, 0, "an unresolved target must not create a misleading owner-approval request");
    assert.equal(f.clicks.length, 0);
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

test("owner-preview adopts only the fresh renderer identified by Windows after a differently named launcher", async () => {
  let lookups = 0;
  const f = fixture(true, () => ({ executable: process.execPath, args: ["-e", "process.exit(0)"] }), async () => { lookups++; return "Renderer.exe"; });
  try {
    let reads = 0;
    f.driver.listVisibleWindows = async () => ++reads === 1 ? [] : [
      { pid: 321, windowId: "654", appName: "Renderer.exe", title: "Target", width: 1280, height: 720 },
      { pid: 999, windowId: "999", appName: "Unrelated.exe", title: "Renderer.exe", width: 1280, height: 720 },
    ];
    const launched = await f.service.launch(f.identity.token, f.task.id, "generic-launcher", "owner-preview");
    assert.equal(launched.running, true);
    assert.equal(lookups, 1);
    const stage = createWindowsDesktopStageManager({ root: f.root, platform: "win32", terminal: true, env: {} }).list()[0];
    assert.deepEqual(stage?.anchor, { pid: 321, windowId: "654" });
  } finally { f.cleanup(); }
});

test("prepare preserves the durable recovery anchor across repeated missing-window observations", async () => {
  const f = fixture(true, (root) => ({ executable: join(root, "chrome.exe"), args: [] }));
  try {
    f.driver.listVisibleWindows = async () => [{ pid: 123, windowId: "456", appName: "chrome.exe", title: "Chrome", width: 1280, height: 720 }];
    await f.service.launch(f.identity.token, f.task.id, "chrome");
    let service = f.service;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) service = f.recreateService();
      let absent = true;
      f.driver.listVisibleWindows = async () => { absent = false; return [{ pid: 123, windowId: "456", appName: "chrome.exe", title: "Chrome", width: 1280, height: 720 }]; };
      f.setInspectOverride(() => absent ? { ok: false, error: "window closed" } : { ok: true, window: { pid: 123, windowId: "456", desktopId: "33333333-3333-4333-8333-333333333333", onCurrentDesktop: true } });
      await service.prepare(f.identity.token, f.task.id, "owner-preview");
      const persisted = createWindowsDesktopStageManager({ root: f.root, platform: "win32", terminal: true, env: {} }).list();
      assert.ok(persisted.some((stage) => stage.appId === "chrome" && stage.anchor?.windowId === "456"), "prepare must not erase on-disk recovery evidence");
      await service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview");
    }
  } finally { f.cleanup(); }
});

test("act() recovery relaunches only when the window is genuinely gone, not on other inspection failures", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "chrome");
    return { executable: join(root, "chrome.exe"), args: [] };
  });
  try {
    f.driver.listVisibleWindows = async () => [{ pid: 123, windowId: "456", appName: "chrome.exe", title: "Personal Chrome", width: 1280, height: 720 }];
    await f.service.launch(f.identity.token, f.task.id, "chrome");
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");

    // A genuinely closed/gone window ("anchor is unavailable") must still trigger
    // the existing one-shot relaunch-and-retry recovery.
    let failOnce = true;
    f.setInspectOverride(() => {
      if (failOnce) { failOnce = false; return { ok: false, error: "window closed" }; }
      return { ok: true, window: { pid: 123, windowId: "456", desktopId: "33333333-3333-4333-8333-333333333333", onCurrentDesktop: true } };
    });
    const recovered = await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview");
    assert.ok(recovered, "a genuinely closed window must still recover via the existing relaunch path");

    // An anchor that simply resolved to a different desktop ("anchor moved to
    // another desktop") is NOT a closed window -- relaunching here would leave a
    // needless second instance running alongside a window that is still alive.
    f.setInspectOverride(() => ({ ok: true, window: { pid: 123, windowId: "456", desktopId: "99999999-9999-4999-8999-999999999999", onCurrentDesktop: false } }));
    const creationsBefore = f.creations();
    await assert.rejects(
      f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview"),
      /anchor moved to another desktop/,
    );
    assert.equal(f.creations(), creationsBefore, "a non-'gone' inspection failure must not trigger a relaunch");
  } finally { f.cleanup(); }
});

test("a relaunch recovery honestly reports the lost window state instead of pretending nothing happened", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "chrome");
    return { executable: join(root, "chrome.exe"), args: [] };
  });
  try {
    f.driver.listVisibleWindows = async () => [{ pid: 123, windowId: "456", appName: "chrome.exe", title: "Personal Chrome", width: 1280, height: 720 }];
    await f.service.launch(f.identity.token, f.task.id, "chrome");
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");

    // A read_structure result carries the real window title (CuaStageStructure.windowTitle);
    // it is stashed opportunistically -- no dedicated fetch, just a field already present
    // in a result the caller already got.
    f.driver.readStructure = async () => ({ status: "complete" as const, capturedAt: new Date(0).toISOString(),
      windowTitle: "report.docx - Google Chrome", elements: [] });
    const beforeClose = await f.service.act(f.identity.token, f.task.id, { kind: "read_structure", view: "app" }, "owner-preview");
    assert.equal((beforeClose as Record<string, unknown>).recoveryNotice, undefined, "a normal read has no recovery notice");

    let failOnce = true;
    f.setInspectOverride(() => {
      if (failOnce) { failOnce = false; return { ok: false, error: "window closed" }; }
      return { ok: true, window: { pid: 123, windowId: "456", desktopId: "33333333-3333-4333-8333-333333333333", onCurrentDesktop: true } };
    });
    const recovered = await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview") as Record<string, unknown>;
    assert.match(String(recovered.recoveryNotice), /relaunched/);
    assert.match(String(recovered.recoveryNotice), /report\.docx - Google Chrome/,
      "the notice must name the actual lost state, not a generic message, when a title was known");
  } finally { f.cleanup(); }
});

test("a relaunch recovery with no previously observed title still reports the loss honestly, just without specifics", async () => {
  const f = fixture(true, (root, appId) => {
    assert.equal(appId, "chrome");
    return { executable: join(root, "chrome.exe"), args: [] };
  });
  try {
    f.driver.listVisibleWindows = async () => [{ pid: 123, windowId: "456", appName: "chrome.exe", title: "Personal Chrome", width: 1280, height: 720 }];
    await f.service.launch(f.identity.token, f.task.id, "chrome");
    await f.service.prepare(f.identity.token, f.task.id, "owner-preview");

    let failOnce = true;
    f.setInspectOverride(() => {
      if (failOnce) { failOnce = false; return { ok: false, error: "window closed" }; }
      return { ok: true, window: { pid: 123, windowId: "456", desktopId: "33333333-3333-4333-8333-333333333333", onCurrentDesktop: true } };
    });
    const recovered = await f.service.act(f.identity.token, f.task.id, { kind: "capture", view: "app" }, "owner-preview") as Record<string, unknown>;
    assert.match(String(recovered.recoveryNotice), /was not restored/);
  } finally { f.cleanup(); }
});

test("one agent session's long owner-approval wait does not block a different session's action", async () => {
  // Two different sessions under the same handle get two different stage names
  // (name = hash(handle, sessionId)); before the per-stage queue fix, both shared
  // one broker-wide queue, so session B's benign click would have waited behind
  // session A's up-to-55s money-gate approval hold.
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-concurrency-"));
  const store = createLocalStore(root);
  const identityA = store.issueIdentity("codex", "codex", "session-a");
  const identityB = store.issueIdentity("codex", "codex", "session-b");
  const { task: taskA } = store.addTask({ from: "you", to: "codex", goal: "Use a stage", origin: "human_typed", idempotencyKey: "concurrency-a", targetSession: "session-a" });
  const { task: taskB } = store.addTask({ from: "you", to: "codex", goal: "Use a stage", origin: "human_typed", idempotencyKey: "concurrency-b", targetSession: "session-b" });
  const clicks: Array<{ x: number; y: number }> = [];
  const release: { current: (() => void) | null } = { current: null };
  const seen: StageApprovalRequest[] = [];
  const fakeDriver = {
    // Session B's target is explicitly described as benign. The shared stage layer
    // still fails closed for an unresolved target, but does not turn that lookup
    // failure into a misleading owner-approval wait.
    describeTarget: async (_name: string, x: number) => (x === 1 ? { label: "Pay now" } : { label: "Next" }),
    click: async (_name: string, x: number, y: number) => {
      clicks.push({ x, y });
      return { capture: { dataUrl: "data:image/png;base64,x", width: 8, height: 8, capturedAt: new Date(0).toISOString() }, outcome: { status: "confirmed" as const } };
    },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  let desktopCounter = 0;
  const service = createTaskDesktopStageService({
    store,
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    stage: {
      platform: "win32", env: {}, invokeNative: async (request) => {
        if (request.op === "createDesktop") {
          desktopCounter += 1;
          return { ok: true, desktop: { desktopId: `1111111${desktopCounter}-1111-4111-8111-111111111111`, isCurrent: false, returnDesktopId: "22222222-2222-4222-8222-222222222222" } };
        }
        if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: false } };
        throw new Error(`Unexpected native operation in concurrency fixture: ${request.op}`);
      },
    },
    driver: fakeDriver,
    approvals: () => ({
      requestApproval: async (request: StageApprovalRequest) => {
        seen.push(request);
        await new Promise<void>((resolve) => { release.current = resolve; });
        return true;
      },
    }),
  });
  try {
    await service.prepare(identityA.token, taskA.id, "background");
    await service.prepare(identityB.token, taskB.id, "background");
    const held = service.act(identityA.token, taskA.id, { kind: "click", x: 1, y: 1 }, "background");
    for (let i = 0; i < 200 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(seen.length, 1, "session A's money click must be waiting on the owner");
    // Session B's benign click must complete without waiting on session A's hold.
    const started = Date.now();
    await service.act(identityB.token, taskB.id, { kind: "click", x: 2, y: 2 }, "background");
    assert.ok(Date.now() - started < 2_000, "session B's action must not queue behind session A's pending approval");
    assert.deepEqual(clicks, [{ x: 2, y: 2 }]);
    release.current?.();
    await held;
    assert.deepEqual(clicks, [{ x: 2, y: 2 }, { x: 1, y: 1 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
