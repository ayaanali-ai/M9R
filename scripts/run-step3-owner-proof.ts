import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isAgentContext } from "../src/lib/native/approval-core";
import { defaultStoreRoot } from "../src/lib/native/local-store";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService, setTaskStagePermission } from "../src/lib/native/task-desktop-stage";
import { approveStageApp } from "../src/lib/native/task-stage-apps";

type FixtureState = { pid: number; windowId: string; clicks: number; text: string; scroll: number; drags: number };

async function main() {
  if (process.platform !== "win32" || isAgentContext(process.env) || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this acceptance check in your normal Windows terminal. It cannot run inside an agent shell, and does not bypass that boundary.");
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const folder = join(repo, ".workcache", "step3-owner-proof", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(folder, { recursive: true });
  const executable = join(folder, "stage-native-fixture.exe");
  const compiled = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), [
    "/nologo", "/target:winexe", `/out:${executable}`, "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll", join(repo, "scripts", "fixtures", "stage-native-fixture.cs"),
  ], { encoding: "utf8", windowsHide: true });
  if (compiled.status !== 0) throw new Error(`The local fixture did not compile: ${compiled.stdout}${compiled.stderr}`);
  const root = defaultStoreRoot(homedir(), process.env);
  const stage = { root, terminal: true, nativeHostPath: join(repo, "engine", "dist", "m9r-native-input-host.exe") };
  const manager = createWindowsDesktopStageManager(stage);
  const driver = createCuaStageDriver({ stage });
  const name = "m9r-step3-proof";
  const children: ChildProcess[] = [];
  const report: { at: string; lifecycle: string[]; phases: { phase: string; status: string; detail?: string }[]; stage?: unknown; cursor?: unknown; actions: unknown[]; snapshots: unknown[]; desktopTransitions: unknown[]; failedPhase?: string; error?: string; cleanupError?: string; passed?: boolean } = { at: new Date().toISOString(), lifecycle: [], phases: [], actions: [], snapshots: [], desktopTransitions: [] };
  let activePhase = "startup";
  let primaryFailurePhase: string | undefined;
  const beginPhase = (phase: string) => {
    activePhase = phase;
    report.phases.push({ phase, status: "started" });
  };
  const finishPhase = (phase: string, detail?: string) => {
    const started = [...report.phases].reverse().find((entry) => entry.phase === phase && entry.status === "started");
    if (started) {
      started.status = "passed";
      if (detail) started.detail = detail;
    }
  };
  let taskManager: ReturnType<typeof createWindowsDesktopStageManager> | undefined;
  let taskStageName: string | undefined;
  let sentinelWindow: FixtureState | undefined;
  const readState = (path: string): FixtureState => JSON.parse(readFileSync(path, "utf8")) as FixtureState;
  const waitForState = async (path: string, predicate: (state: FixtureState) => boolean = () => true) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { const state = readState(path); if (predicate(state)) return state; } catch { /* bounded wait for the fixture's atomic write */ }
      await delay(100);
    }
    throw new Error("The fixture did not show the requested state change within three seconds.");
  };
  let shouldReturn = false;
  try {
    const launch = (path: string, title: string) => {
      const child = spawn(executable, [path, title], { stdio: "ignore", windowsHide: false });
      child.on("error", () => undefined);
      children.push(child);
      return child;
    };
    const targetPath = join(folder, "target.json");
    const sentinelPath = join(folder, "sentinel.json");
    const targetProcess = launch(targetPath, "M9R stage target fixture");
    const sentinelProcess = launch(sentinelPath, "M9R owner isolation fixture");
    const target = await waitForState(targetPath);
    const sentinel = await waitForState(sentinelPath);
    sentinelWindow = sentinel;
    if (target.pid !== targetProcess.pid || sentinel.pid !== sentinelProcess.pid) throw new Error("Fixture process custody could not be verified.");
    const snapshotDiagnostic = async (phase: string) => {
      const { CuaDriver } = await import("@trycua/cua-driver");
      const diagnostic = CuaDriver.create(undefined);
      const session = "m9r-step3-capture-diagnostic";
      await diagnostic.startSession({ session });
      try {
        const state = await diagnostic.getWindowState({ pid: target.pid, windowId: BigInt(target.windowId), session,
          includeAccessibilityTree: true, includeScreenshot: true, maxImageDimension: 1024, timeoutMs: 3000 });
        report.snapshots.push({ phase, pidMatches: state.pid === target.pid, windowMatches: state.windowId === BigInt(target.windowId),
          valid: state.screenshotFrameValid, width: state.screenshotWidth, height: state.screenshotHeight,
          imageCount: state.images.length, imageBytes: state.images.map((image) => Buffer.from(image.dataBase64, "base64").length),
          elements: (state.elements ?? []).slice(0, 30).map((element) => ({ role: element.role, label: element.label,
            frame: element.frame, hasToken: Boolean(element.elementToken), actions: element.actions })) });
      } catch (error) { report.snapshots.push({ phase, error: error instanceof Error ? error.message : String(error) }); }
      finally { await diagnostic.endSession({ session }); }
    };
    await snapshotDiagnostic("before move");
    beginPhase("verify owner desktop before stage work");
    const original = await manager.inspectWindow(String(sentinel.pid), sentinel.windowId);
    if (!original.onCurrentDesktop) throw new Error("The sentinel did not start on the owner's current desktop.");
    finishPhase("verify owner desktop before stage work");
    beginPhase("validate or recover proof desktop registration");
    const existingStage = manager.list().find((item) => item.name === name);
    let stageDisposition: "created" | "reused" | "recreated-stale";
    if (!existingStage) {
      await manager.create(name);
      stageDisposition = "created";
    } else {
      // A previous run's fixture process is intentionally closed, but its HWND can
      // remain in the local stage record. Clear only that exact proof-stage anchor,
      // then ask Windows whether the recorded desktop GUID still exists.
      if (existingStage.anchor) manager.clearOwnedAnchor(name, existingStage.anchor.pid, existingStage.anchor.windowId);
      try {
        await manager.inspectStage(name);
        stageDisposition = "reused";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!detail.includes("virtual desktop no longer exists")) throw error;
        // The proof stage has a fixed, private name. Forget removes only its stale
        // local mapping; it does not delete or switch any Windows desktop.
        manager.forget(name);
        await manager.create(name);
        stageDisposition = "recreated-stale";
      }
    }
    report.stage = { name, disposition: stageDisposition,
      previousDesktopId: existingStage?.desktopId ?? null,
      anchorCleared: Boolean(existingStage?.anchor) };
    const unchanged = await manager.inspectWindow(String(sentinel.pid), sentinel.windowId);
    if (!unchanged.onCurrentDesktop || unchanged.desktopId !== original.desktopId) throw new Error("Creating the stage changed the owner's desktop.");
    report.lifecycle.push(stageDisposition === "created" ? "new proof stage created; owner desktop remained active"
      : stageDisposition === "recreated-stale" ? "stale proof-stage mapping replaced; owner desktop remained active"
        : "existing proof stage validated; owner desktop remained active");
    finishPhase("validate or recover proof desktop registration", stageDisposition);
    beginPhase("attach target fixture to proof desktop");
    try {
      await manager.attachWindow(name, String(target.pid), target.windowId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!detail.includes("virtual desktop no longer exists")) throw error;
      // Windows can remove a virtual desktop between preflight and the move. The
      // native helper returns this exact error before changing the target window.
      manager.forget(name);
      await manager.create(name);
      const ownerAfterRecovery = await manager.inspectWindow(String(sentinel.pid), sentinel.windowId);
      if (!ownerAfterRecovery.onCurrentDesktop || ownerAfterRecovery.desktopId !== original.desktopId) {
        throw new Error("The owner desktop changed while recovering the stale proof-stage mapping.");
      }
      stageDisposition = "recreated-stale";
      report.stage = { name, disposition: stageDisposition, previousDesktopId: existingStage?.desktopId ?? null,
        anchorCleared: Boolean(existingStage?.anchor), recoveredDuringAttach: true, nativeError: detail };
      await manager.attachWindow(name, String(target.pid), target.windowId);
    }
    const moved = await manager.inspectWindow(String(target.pid), target.windowId);
    if (moved.desktopId === original.desktopId || moved.onCurrentDesktop) throw new Error("The target fixture did not move to the background stage.");
    if ((await manager.inspectWindow(String(sentinel.pid), sentinel.windowId)).desktopId !== original.desktopId) throw new Error("The unrelated fixture moved unexpectedly.");
    report.lifecycle.push("only the owned target window moved");
    finishPhase("attach target fixture to proof desktop");
    beginPhase("capture background target fixture");
    await snapshotDiagnostic("hidden desktop");
    const capture = await driver.capture(name);
    writeFileSync(join(folder, "background-window.png"), Buffer.from(capture.dataUrl.split(",")[1], "base64"));
    report.lifecycle.push("background window capture returned a valid frame");
    finishPhase("capture background target fixture");
    const check = async (action: string, run: () => Promise<unknown>, observed: (before: FixtureState, after: FixtureState) => boolean) => {
      const phase = `verify ${action} effect`;
      beginPhase(phase);
      const before = readState(targetPath);
      let result: unknown;
      try {
        result = await run();
        const after = await waitForState(targetPath, (state) => observed(before, state));
        report.actions.push({ action, observed: true, before, after, result });
        finishPhase(phase);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        report.actions.push({ action, observed: false, result, error: detail });
        const failed = [...report.phases].reverse().find((entry) => entry.phase === phase && entry.status === "started");
        if (failed) { failed.status = "failed"; failed.detail = detail; }
        report.failedPhase ??= phase;
      }
    };
    await check("background click", () => driver.click(name, 80, 70), (before, after) => after.clicks > before.clicks);
    await check("background type", async () => { await driver.click(name, 120, 135); return driver.typeText(name, "M9R background proof"); }, (_before, after) => after.text.includes("M9R background proof"));
    await check("background scroll", () => driver.scroll(name, 140, 260, "down"), (before, after) => after.scroll > before.scroll);
    await check("background drag", () => driver.drag(name, 420, 250, 490, 300), (before, after) => after.drags > before.drags);
    beginPhase("verify owner desktop remained active during input");
    if (!(await manager.inspectWindow(String(sentinel.pid), sentinel.windowId)).onCurrentDesktop) throw new Error("An input action switched away from the owner's desktop.");
    finishPhase("verify owner desktop remained active during input");
    beginPhase("open and return from proof desktop");
    await manager.activate(name);
    shouldReturn = true;
    if (!(await manager.inspectWindow(String(target.pid), target.windowId)).onCurrentDesktop) throw new Error("Opening the stage did not activate it.");
    await manager.returnToOwnerDesktop(name);
    shouldReturn = false;
    if (!(await manager.inspectWindow(String(sentinel.pid), sentinel.windowId)).onCurrentDesktop) throw new Error("Returning did not restore the owner desktop.");
    report.lifecycle.push("explicit open and return verified");
    finishPhase("open and return from proof desktop");
    // A separate local store keeps synthetic identities, permissions, and fixed app
    // arguments out of the owner's normal M9R configuration.
    const taskRoot = join(folder, "task-runtime");
    const taskStore = createLocalStore(taskRoot);
    const proofIdentity = taskStore.issueIdentity("proof-agent", "custom", "step3-proof-session");
    const { task: proofTask } = taskStore.addTask({ from: "you", to: "proof-agent", goal: "Exercise the owned desktop app", origin: "human_typed", idempotencyKey: "stage-proof", targetSession: "step3-proof-session" });
    const appStatePath = join(folder, "task-app.json");
    approveStageApp(taskRoot, "fixture", executable, [appStatePath, "M9R broker-owned task app"], { terminal: true, env: process.env });
    setTaskStagePermission(taskRoot, "proof-agent", true, { terminal: true, env: process.env }, true);
    const taskService = createTaskDesktopStageService({ store: taskStore, stage: { ...stage, root: taskRoot } });
    taskManager = createWindowsDesktopStageManager({ ...stage, root: taskRoot });
    const activeTaskManager = taskManager;
    const checkTaskDesktop = async (phase: string) => {
      if (!taskStageName) throw new Error("The task stage name was not recorded for desktop isolation checks.");
      const taskStage = await activeTaskManager.inspectStage(taskStageName);
      const ownerWindow = await manager.inspectWindow(String(sentinel.pid), sentinel.windowId);
      const state = { phase, expectedOwnerDesktopId: original.desktopId,
        taskStageDesktopId: taskStage.desktop.desktopId, taskStageActive: taskStage.desktop.isCurrent,
        ownerWindowDesktopId: ownerWindow.desktopId, ownerWindowOnCurrentDesktop: ownerWindow.onCurrentDesktop };
      report.desktopTransitions.push(state);
      if (!ownerWindow.onCurrentDesktop) {
        try {
          await activeTaskManager.returnToOwnerDesktop(taskStageName);
          const restored = await manager.inspectWindow(String(sentinel.pid), sentinel.windowId);
          const restoredStage = await activeTaskManager.inspectStage(taskStageName);
          report.desktopTransitions.push({ phase: `${phase} (owner desktop restored)`,
            expectedOwnerDesktopId: original.desktopId,
            taskStageDesktopId: restoredStage.desktop.desktopId, taskStageActive: restoredStage.desktop.isCurrent,
            ownerWindowDesktopId: restored.desktopId, ownerWindowOnCurrentDesktop: restored.onCurrentDesktop });
        } catch (restoreError) {
          const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
          throw new Error(`The owner desktop changed during ${phase}; automatic return failed: ${detail}`);
        }
        throw new Error(`The owner desktop changed during ${phase}; it was automatically restored.`);
      }
    };
    const runTaskPhase = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      beginPhase(phase);
      let result: T | undefined;
      let failed = false;
      let failure: unknown;
      try { result = await run(); } catch (error) { failed = true; failure = error; }
      await checkTaskDesktop(phase);
      if (failed) throw failure;
      finishPhase(phase);
      return result as T;
    };
    let taskAppOpen = false;
    try {
      beginPhase("prepare isolated task stage");
      const prepared = await taskService.prepare(proofIdentity.token, proofTask.id);
      taskStageName = prepared.name;
      await checkTaskDesktop("task stage preparation");
      if (prepared.hasAnchor) throw new Error("A newly prepared task stage unexpectedly has an app.");
      report.lifecycle.push("task identity and stage preparation verified");
      finishPhase("prepare isolated task stage");
      await runTaskPhase("task app launch and move", () => taskService.launch(proofIdentity.token, proofTask.id, "fixture"));
      taskAppOpen = true;
      report.lifecycle.push("exact-process app discovery, move and background show verified");
      const appBefore = await waitForState(appStatePath);
      await runTaskPhase("task click", () => taskService.act(proofIdentity.token, proofTask.id, { kind: "click", x: 80, y: 70 }));
      beginPhase("verify task click effect");
      await waitForState(appStatePath, (state) => state.clicks > appBefore.clicks);
      await checkTaskDesktop("task click effect wait");
      finishPhase("verify task click effect");
      await runTaskPhase("task edit-field click", () => taskService.act(proofIdentity.token, proofTask.id, { kind: "click", x: 120, y: 135 }));
      await runTaskPhase("task typing", () => taskService.act(proofIdentity.token, proofTask.id, { kind: "type", text: "M9R task lifecycle proof" }));
      beginPhase("verify task typing effect");
      await waitForState(appStatePath, (state) => state.text === "M9R task lifecycle proof");
      await checkTaskDesktop("task text effect wait");
      report.lifecycle.push("task-scoped click and type effects verified");
      finishPhase("verify task typing effect");
      beginPhase("verify agent-labeled OS cursor identity and motion");
      const firstCursorMove = await taskService.act(proofIdentity.token, proofTask.id, { kind: "cursor", x: 260, y: 220 }) as { cursor?: { x?: number; y?: number; enabled?: boolean; visible?: boolean } };
      if (firstCursorMove.cursor?.enabled !== true || firstCursorMove.cursor.visible !== true
        || firstCursorMove.cursor.x !== 260 || firstCursorMove.cursor.y !== 220) {
        throw new Error("The owner broker did not confirm a visible, correctly positioned agent OS cursor.");
      }
      await checkTaskDesktop("agent cursor first move");
      const secondCursorMove = await taskService.act(proofIdentity.token, proofTask.id, { kind: "cursor", x: 460, y: 340 }) as { cursor?: { x?: number; y?: number; enabled?: boolean; visible?: boolean } };
      if (secondCursorMove.cursor?.enabled !== true || secondCursorMove.cursor.visible !== true
        || secondCursorMove.cursor.x !== 460 || secondCursorMove.cursor.y !== 340) {
        throw new Error("The owner broker did not confirm a second visible agent cursor position.");
      }
      await checkTaskDesktop("agent cursor second move");
      report.cursor = { agent: "proof-agent", visibleBadge: "@proof-agent-<session tag>",
        firstPosition: { x: firstCursorMove.cursor.x, y: firstCursorMove.cursor.y },
        secondPosition: { x: secondCursorMove.cursor.x, y: secondCursorMove.cursor.y },
        visibleOnScreen: "opening the agent stage for a brief live check" };
      finishPhase("verify agent-labeled OS cursor identity and motion");
      beginPhase("show moving agent cursor on the actual desktop");
      if (!taskStageName) throw new Error("The task stage was not available for the live cursor check.");
      await activeTaskManager.activate(taskStageName);
      const liveCursorMove = await taskService.act(proofIdentity.token, proofTask.id, { kind: "cursor", x: 300, y: 250 }) as { cursor?: { x?: number; y?: number; visible?: boolean } };
      if (liveCursorMove.cursor?.visible !== true || liveCursorMove.cursor.x !== 300 || liveCursorMove.cursor.y !== 250) {
        throw new Error("The active desktop did not confirm the moving agent overlay.");
      }
      await delay(2_500);
      await activeTaskManager.returnToOwnerDesktop(taskStageName);
      await checkTaskDesktop("after visible agent-cursor check");
      report.lifecycle.push("agent-labeled Cua OS cursor moved on the active Windows desktop; owner desktop restored");
      finishPhase("show moving agent cursor on the actual desktop");
      const snapshot = await runTaskPhase("task capture", () => taskService.act(proofIdentity.token, proofTask.id, { kind: "capture" }));
      beginPhase("validate task capture response");
      if (!(snapshot as { capture?: { dataUrl?: string } }).capture?.dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Task capture returned no frame.");
      finishPhase("validate task capture response");
      beginPhase("verify revoked and completed task denial");
      setTaskStagePermission(taskRoot, "proof-agent", false, { terminal: true, env: process.env });
      let revokedDenied = false;
      try { await taskService.act(proofIdentity.token, proofTask.id, { kind: "click", x: 80, y: 70 }); } catch { revokedDenied = true; }
      if (!revokedDenied) throw new Error("Revoked stage control still accepted input.");
      setTaskStagePermission(taskRoot, "proof-agent", true, { terminal: true, env: process.env }, true);
      await taskService.closeApp(proofIdentity.token, proofTask.id);
      taskAppOpen = false;
      taskStore.setResult(proofTask.id, "Owned app lifecycle verified");
      let finishedDenied = false;
      try { await taskService.act(proofIdentity.token, proofTask.id, { kind: "capture" }); } catch { finishedDenied = true; }
      if (!finishedDenied) throw new Error("A completed task still had computer access.");
      report.lifecycle.push("approved task prepares and launches its own app", "task-scoped click/type/capture verified", "revocation and completed-task denial verified", "owned app discarded; owner desktop unchanged");
      finishPhase("verify revoked and completed task denial");
    } catch (error) {
      // Capture the task operation's phase before cleanup starts a new phase.
      // Otherwise a cleanup phase can hide the actual failure in the report.
      primaryFailurePhase = activePhase;
      throw error;
    } finally {
      if (taskAppOpen) {
        beginPhase("close task-owned app");
        try {
          setTaskStagePermission(taskRoot, "proof-agent", true, { terminal: true, env: process.env }, true);
          await taskService.closeApp(proofIdentity.token, proofTask.id);
          finishPhase("close task-owned app");
        } catch (cleanupError) {
          const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          report.cleanupError = detail;
          const cleanupPhase = [...report.phases].reverse().find((entry) => entry.phase === "close task-owned app" && entry.status === "started");
          if (cleanupPhase) { cleanupPhase.status = "failed"; cleanupPhase.detail = detail; }
          if (!primaryFailurePhase) primaryFailurePhase = "close task-owned app";
          else report.passed = false;
          if (primaryFailurePhase === "close task-owned app") throw cleanupError;
        }
      }
    }
    report.passed = report.actions.length === 4 && report.actions.every((action) => (action as { observed: boolean }).observed);
  } catch (error) {
    const failurePhase = primaryFailurePhase ?? activePhase;
    report.failedPhase = failurePhase;
    const failed = [...report.phases].reverse().find((entry) => entry.phase === failurePhase && entry.status === "started");
    if (failed) {
      failed.status = "failed";
      failed.detail = error instanceof Error ? error.message : String(error);
    }
    report.error = error instanceof Error ? error.message : String(error);
    report.passed = false;
  }
  finally {
    if (shouldReturn) try { await manager.returnToOwnerDesktop(name); } catch { report.error = `${report.error ?? ""} Owner desktop return needs attention.`; report.passed = false; }
    if (sentinelWindow) {
      try {
        const ownerWindow = await manager.inspectWindow(String(sentinelWindow.pid), sentinelWindow.windowId);
        if (!ownerWindow.onCurrentDesktop) {
          if (taskManager && taskStageName) await taskManager.returnToOwnerDesktop(taskStageName);
          else await manager.returnToOwnerDesktop(name);
          report.desktopTransitions.push({ phase: "final safety return", ownerWindowOnCurrentDesktop:
            (await manager.inspectWindow(String(sentinelWindow.pid), sentinelWindow.windowId)).onCurrentDesktop });
        }
      } catch (error) {
        report.error = `${report.error ?? ""} Final owner desktop safety return failed: ${error instanceof Error ? error.message : String(error)}`.trim();
        report.passed = false;
      }
    }
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
    // Pixels remain in their own PNG. Never embed them in console output or the report.
    for (const item of report.actions) {
      const action = item as { result?: { capture?: unknown } };
      if (action.result?.capture) delete action.result.capture;
    }
    writeFileSync(join(folder, "result.json"), JSON.stringify(report, null, 2) + "\n");
  }
  console.log(`Step 3 owner proof: ${report.passed ? "PASS" : "NOT PASSED"}\nResult: ${join(folder, "result.json")}\nThe proof desktop remains available; only the two test apps were closed.`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
