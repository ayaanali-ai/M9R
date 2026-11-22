import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService } from "../src/lib/native/task-desktop-stage";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { setOwnerWorkMode } from "../src/lib/native/owner-work-mode";

// Phase 0, T3 (build order item 3, per Muse's exact spec): a real app
// (Notepad) gets real unsaved text typed into it in the background, while a
// second, fully independent process is continuously typing into its OWN real
// foreground window via real SendInput the entire time -- proving that
// background delivery to Notepad never steals the foreground, never moves
// the owner's cursor, and never disturbs the independent foreground typer's
// own keystrokes. The background-isolation assertions end there, before the
// dialog phase below.
//
// After that, the test stops the independent typer, takes a real, confirmed
// foreground lease on Notepad (manager.bringToForeground, verified via
// currentForegroundWindow before proceeding), then provokes and answers
// Notepad's "Do you want to save changes?" dialog with real SendInput
// (Ctrl+W to close the tab, then Enter to confirm Save) -- not
// postCloseWindow and not UI Automation's confirmDialogButton. This phase
// is a foreground-lease test, not a second background-delivery test; it
// does not exercise or prove anything about concurrent/contended foreground
// use. The file's real on-disk content is the final proof, alongside the
// independent typer's own self-report from the background-typing phase.
//
// This test must be run from a plain, non-agent terminal (never from inside
// an agent session): native-input-host's own agent-context gate will refuse
// real dispatch otherwise, by design, and must never be defeated.
//
// --spawn-foreground-typer is a second, independent process this test
// starts and must kill itself; it is NOT part of any M9R dispatch path and
// has no agent-context gate, because its entire purpose is to behave like an
// ordinary foreground application the agent's background work must not
// disturb.
const NATIVE_HOST = fileURLToPath(new URL("../native-input-host/target/debug/m9r-native-input-host.exe", import.meta.url));
// C:\Windows\System32\notepad.exe is a separate, older fallback binary on
// this machine (no AppUserModelId, nags about its own pending self-update,
// and can silently relaunch itself mid-test). The real app is the packaged
// Notepad; spawning its exe path directly is refused by Windows (EPERM).
//
// Activating it generically (shell:AppsFolder\<AppID>, no file argument)
// just focuses whatever Notepad window the owner already has open instead
// of creating a new one -- genuinely unsafe for a test, since it would type
// into whatever real document the owner is actually working on. Opening a
// specific, test-owned file path through Explorer (the same mechanism as
// double-clicking a .txt file) gives every test its own window, scoped to a
// file only this test created, never touching anything the owner has open.
function notepadLaunchSpec(filePath: string) {
  return { executable: "C:\\Windows\\explorer.exe", args: [filePath], windowExecutable: "Notepad.exe" };
}

/**
 * Windows 11 Notepad is tab-based: opening a new file while an instance is
 * already running adds a tab to that SAME top-level window instead of
 * creating a new one, so launch() never sees a genuinely new window to
 * adopt. The only way to guarantee an isolated window for this test is to
 * ensure no Notepad window is already open first. Refuses (never force-closes)
 * if any already-open window has real unsaved changes (its own "*" dirty
 * marker) -- this must never be able to discard the owner's real work.
 */
// Our own test's scratch files always start with this prefix -- real
// Notepad tabs keyed to any other filename are never ours to discard. Every
// run uses a unique filename (see the test body): Notepad's own tab/recency
// matching was observed to key off the DISPLAY NAME, not the full path, so
// reusing one fixed name across runs kept colliding with stale tabs no
// matter how aggressively the session-recovery cache was cleared. A name
// that was never seen before cannot collide with anything cached.
const T3_TEST_FILE_PREFIX = "t3-output-";

async function ensureNoConflictingNotepadWindow(manager: ReturnType<typeof createWindowsDesktopStageManager>): Promise<void> {
  const windows = (await manager.listVisibleWindows()).filter((window) => window.className === "Notepad");
  for (const window of windows) {
    // The window's own title bar only reflects whichever TAB is currently
    // active -- Windows 11 Notepad is tab-based, and a modified tab sitting
    // in the background never shows up there. Reading the real UI
    // Automation tree's "tab item" elements (each one labelled
    // "<name>. Modified." or "<name>. Unmodified.") is the only way to see
    // every tab's real dirty state, not just the active one.
    let structure: Awaited<ReturnType<typeof manager.windowStructure>> | undefined;
    try {
      structure = await manager.windowStructure(window.pid, window.windowId, { maxElements: 200, maxDepth: 12 });
    } catch { /* if we can't inspect it, fall through to the title-only check below */ }
    const tabItems = structure?.elements.filter((element) => element.role === "tab item") ?? [];
    const modifiedTabs = tabItems.filter((element) => (element.label ?? "").includes("Modified") && !(element.label ?? "").includes("Unmodified"));
    const foreignModifiedTabs = modifiedTabs.filter((element) => !(element.label ?? "").startsWith(T3_TEST_FILE_PREFIX));
    if (foreignModifiedTabs.length > 0) {
      throw new Error(`Refusing to run: a real, non-test Notepad tab has unsaved changes (${foreignModifiedTabs.map((t) => t.label).join(", ")}). Save or close it yourself first, then rerun.`);
    }
    // No per-tab structure was readable at all (rare) -- fall back to the
    // conservative title-only check rather than assuming it's safe.
    if (!structure && window.title.includes("*")) {
      throw new Error(`Refusing to run: Notepad window "${window.title}" has unsaved changes and its tabs could not be inspected individually. Save or close it yourself first, then rerun.`);
    }
    // Every modified tab here is confirmed to be our own disposable test
    // scratch content (or there are none) -- safe to discard entirely.
    // postCloseWindow (WM_CLOSE) was observed to leave leftover tabs behind
    // across runs rather than reliably tearing the whole window down, which
    // let same-named-but-different-path test tabs pile up and made a later
    // run's "current tab" ambiguous (one observed symptom: Save unexpectedly
    // falling through to Save As, as if the active tab wasn't bound to a
    // real path at all). Terminating the process outright guarantees every
    // one of these disposable tabs is actually gone, not just asked to
    // close, before this run creates its own fresh window.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(window.pid), "/F"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const remaining = (await manager.listVisibleWindows()).filter((window) => window.className === "Notepad");
    if (remaining.length === 0) break;
    await delay(100);
  }

  // Windows 11 Notepad persists its own session-recovery cache to disk
  // (LocalState/TabState, LocalState/WindowState) continuously as you type
  // -- it survives even a full process kill, and the NEXT launch silently
  // restores every entry as a "recovered" tab that is disconnected from any
  // real file path. That ghost tab is what made Save fall through to an
  // invisible/failed write even after every other piece (WM_CHAR typing,
  // Ctrl+W, a real Enter) was individually proven to work end to end. Every
  // modified tab was already confirmed above to be our own disposable test
  // pattern (or this function already refused before reaching here), so
  // clearing this cache is safe -- and the owner has explicitly approved
  // this running automatically on every preflight, since it regenerates on
  // every keystroke and manual clearing before each run is not viable.
  const notepadLocalState = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "Packages", "Microsoft.WindowsNotepad_8wekyb3d8bbwe", "LocalState",
  );
  for (const sub of ["TabState", "WindowState"]) {
    const dir = join(notepadLocalState, sub);
    // Clear the folder's CONTENTS, not the folder itself -- the packaged
    // app's own runtime may expect this directory structure to already
    // exist on launch, and removing the directory entirely (forcing it to
    // recreate its own LocalState layout from scratch) is an unnecessary
    // extra variable right before immediately relaunching it.
    try {
      for (const entry of readdirSync(dir)) {
        try { rmSync(join(dir, entry), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    } catch { /* directory may not exist yet -- nothing to clear */ }
  }

  // A forceful kill followed immediately by a relaunch within the same
  // process (unlike every manual/standalone check this session, which ran
  // against an already-quiesced system) leaves a narrow window where the
  // packaged app's activation plumbing may not yet be ready for the next
  // request. A short settle delay here is cheap insurance against that race.
  await delay(500);
}

interface TyperReport {
  pid: number; intended: string; actual: string; foregroundEverLost: boolean; cursorEverMoved: boolean;
}

function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m9r-phase0-t3-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function realService(root: string, store: ReturnType<typeof createLocalStore>, filePath: string) {
  setOwnerWorkMode(root, "agents-free"); // owner explicitly permits this foreground dialog acceptance harness
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store,
    manager,
    driver,
    stage: { env: {} },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    resolveStageAppForTest: () => notepadLaunchSpec(filePath),
  });
  return {
    manager,
    driver,
    service,
    cleanup: async () => {
      await service.close();
      manager.close?.();
    },
  };
}

function readTyperReport(pid: number): TyperReport | undefined {
  try {
    return JSON.parse(readFileSync(join(tmpdir(), `m9r-foreground-typer-${pid}.json`), "utf8")) as TyperReport;
  } catch {
    return undefined;
  }
}

/** Spawn the independent, ungated real-SendInput foreground typer and wait for its first report. */
async function startForegroundTyper(): Promise<{ pid: number; stop: () => void }> {
  const child = spawn(NATIVE_HOST, ["--spawn-foreground-typer"], { stdio: "ignore" });
  const pid = child.pid;
  if (!pid) throw new Error("The independent foreground typer process did not start.");
  for (let attempt = 0; attempt < 40; attempt++) {
    if (readTyperReport(pid)) break;
    await delay(50);
  }
  return { pid, stop: () => { try { child.kill(); } catch { /* best-effort */ } } };
}

test("Phase 0 T3: background typing never disturbs a real foreground typer, and closing with a real dialog uses a bounded foreground lease", { timeout: 90_000 }, () =>
  withRoot(async (root) => {
    const store = createLocalStore(root);
    const workDir = mkdtempSync(join(tmpdir(), "m9r-phase0-t3-save-"));
    // A unique filename per run -- Notepad's own tab/recency matching keys
    // off the display name, not the full path, so a name that was never
    // seen before cannot collide with any stale or cached tab.
    const savePath = join(workDir, `${T3_TEST_FILE_PREFIX}${Date.now()}-${process.pid}.txt`);
    // Pre-create the file so Notepad opens a window scoped to it specifically
    // (never the owner's already-open document), and so that confirming
    // "Save" on the unsaved-changes dialog writes directly to this exact
    // path with no further Save As dialog (the document already has a name).
    writeFileSync(savePath, "");
    const { manager, driver, service, cleanup } = realService(root, store, savePath);
    const identity = store.issueIdentity("codex", "codex", "session-t3");
    const task = store.addTask({ from: "you", to: "codex", goal: "T3 dialog task", origin: "human_typed", idempotencyKey: "t3-a", targetSession: "session-t3" }).task;
    let typer: { pid: number; stop: () => void } | undefined;
    try {
      await ensureNoConflictingNotepadWindow(manager);

      // Launching a brand-new app window is, by Windows's own design, the one
      // moment a window legitimately grabs real OS foreground -- that's the
      // OS creating and activating a new top-level window, not anything this
      // background delivery channel chose to do. It happens once, here,
      // before the independent typer starts, so it is deliberately excluded
      // from what "background never takes the foreground" is actually
      // claiming below.
      const launched = await service.launch(identity.token, task.id, "test-window", "background");
      assert.ok(launched.name, "launch returned a real stage name");
      const stageName = launched.name!;

      // The independent control: a real, separate process that owns the real
      // foreground and types into itself continuously via real SendInput,
      // self-reporting whether anything ever took its foreground or moved the
      // owner's cursor out from under it. Started only now, after the app's
      // one-time launch-focus has already settled, so it measures exactly the
      // thing under test: the background TYPE action, not the launch itself.
      typer = await startForegroundTyper();
      const baselineCursor = await manager.getOwnerCursorPosition();

      const typed = await service.act(identity.token, task.id, { kind: "type", text: "unsaved T3 content" }, "background");
      assert.ok(typed, "the background type action completed");

      const anchor = manager.list().find((stage) => stage.name === stageName)?.anchor;
      assert.ok(anchor, "Notepad's real anchor is still registered");

      // Diagnostic, not a guess: Notepad marks its own real title bar with a
      // leading "*" the moment it considers the document dirty. Checking this
      // BEFORE closing proves (or disproves) whether the background WM_CHAR
      // delivery actually registered as a real edit from Notepad's own point
      // of view, independent of anything this test assumes about Notepad's
      // internals.
      const ownedWindows = await manager.listOwnedWindowsForProcess(anchor!.pid);
      const mainWindow = ownedWindows.find((window) => window.windowId.toLowerCase() === anchor!.windowId.toLowerCase());
      console.log(`[T3] Notepad window before close: ${JSON.stringify(mainWindow)}`);
      assert.ok(mainWindow?.title?.includes("*"),
        `Notepad's real title bar never showed the unsaved-changes marker after background typing (window=${JSON.stringify(mainWindow)}); ` +
        `the WM_CHAR delivery did not register as a real edit from Notepad's own point of view.`);

      // The background typing phase is proven non-disruptive right here,
      // before anything below deliberately borrows the foreground: the
      // independent typer's own report, captured at this exact point, is
      // the honest boundary of what "background" guaranteed.
      const typingPhaseReport = readTyperReport(typer.pid);
      assert.ok(typingPhaseReport, "the independent foreground typer produced a self-report during the background typing phase");
      assert.equal(typingPhaseReport!.foregroundEverLost, false, "background typing must never take the real foreground");
      assert.equal(typingPhaseReport!.cursorEverMoved, false, "background typing must never move the real owner cursor");
      const cursorAfterTyping = await manager.getOwnerCursorPosition();
      assert.deepEqual(cursorAfterTyping, baselineCursor, "the real owner cursor position must be unchanged by background typing");

      // Confirmed by direct observation: a real app's own "unsaved changes"
      // confirmation dialog only appears when its window actually has real
      // OS focus -- WM_CLOSE posted to an unfocused window is correctly
      // delivered (the process does exit), but the app silently discards
      // instead of prompting, since it cannot block on a modal the user
      // cannot see or answer. Provoking and answering that one real dialog
      // genuinely needs real foreground; this is exactly what a foreground
      // lease (item 5) is for -- borrowed briefly, for one necessary step,
      // never a return to serialized/exclusive input. The independent typer
      // is stopped first: it has no awareness of this lease and would race
      // real SendInput against this window if left running through it,
      // which is a hazard around the lease itself, not something background
      // delivery needs to tolerate.
      typer.stop();
      typer = undefined;
      await manager.withForegroundAuthorization(async () => {}, () => manager.bringToForeground(anchor!.pid, anchor!.windowId));

      // Verify the lease actually took, not just that the call didn't throw:
      // GetForegroundWindow must really report this window before WM_CLOSE
      // is posted, or the dialog will silently fail to appear exactly as
      // before.
      let leaseConfirmed = false;
      for (let attempt = 0; attempt < 20 && !leaseConfirmed; attempt++) {
        const current = await manager.currentForegroundWindow();
        leaseConfirmed = current.pid === anchor!.pid && current.windowId.toLowerCase() === anchor!.windowId.toLowerCase();
        if (!leaseConfirmed) {
          console.log(`[T3] foreground lease not yet confirmed (attempt ${attempt}): current foreground is ${JSON.stringify(current)}`);
          if (attempt % 5 === 4) await manager.withForegroundAuthorization(async () => {}, () => manager.bringToForeground(anchor!.pid, anchor!.windowId));
          await delay(100);
        }
      }
      assert.ok(leaseConfirmed, "the foreground lease never actually made Notepad the real OS foreground window");

      // No UI Automation calls happen between the lease being confirmed and
      // the Ctrl+W below -- scripts/diag-wmchar-vs-uia.test.ts (the one
      // sequence proven, by a real passing run, to save correctly end to
      // end) makes none either. An earlier version of this test walked the
      // live UIA tree here "just for logging" right as Ctrl+W was about to
      // fire the dialog's entrance animation, which is exactly the kind of
      // interference proven below to break the read-before-Enter. Removed:
      // match the proven-working sequence exactly, not a close approximation
      // of it.

      // Both a posted WM_CLOSE and a real Alt+F4 (confirmed above to reach a
      // genuinely foregrounded window) close the WHOLE multi-tab window at
      // once and exit silently, with no prompt -- that path never reaches a
      // per-document save check. Windows 11 Notepad's save-confirmation is
      // wired to closing ONE TAB, a distinct, more specific action in the
      // app's own tab-management code. Ctrl+W (real SendInput, same lease)
      // closes only the current tab -- exactly this document.
      await manager.withForegroundAuthorization(async () => {}, () => manager.sendKeyCombo(anchor!.pid, anchor!.windowId, ["ctrl", "w"]));

      // Notepad's "Do you want to save changes?" prompt is a WinUI
      // ContentDialog rendered inside this same main window (not a separate
      // popup), and answering it with a real Enter is proven to work
      // (scripts/diag-wmchar-vs-uia.test.ts) -- that diagnostic made NO UI
      // Automation calls between the close and the Enter, just one fixed
      // settle delay. Earlier attempts here instead polled the live UIA tree
      // with deep walks (up to 100 times) right up until the keystroke,
      // which is the one remaining difference from the proven-working
      // sequence: repeatedly walking a WinUI ContentDialog while it is still
      // animating in can leave real Win32 keyboard focus somewhere other
      // than wherever UIA's cached "focused" property reports. Matching the
      // proven pattern exactly: one fixed wait, ONE structure read purely
      // for logging (never gating the keystroke), then the real Enter with
      // no further UIA calls in between.
      await delay(800);
      await manager.withForegroundAuthorization(async () => {}, () => manager.sendKeyCombo(anchor!.pid, anchor!.windowId, ["enter"]));
      await delay(1000);

      // Real on-disk proof, never trust the resolved promise alone.
      let saved: ReturnType<typeof statSync> | undefined;
      for (let attempt = 0; attempt < 30 && !saved; attempt++) {
        try { saved = statSync(savePath); } catch { await delay(100); }
      }
      assert.ok(saved, `the file was actually written to disk at ${savePath}`);
      const content = readFileSync(savePath, "utf8");
      assert.ok(content.includes("unsaved T3 content"), `the saved file's real content was ${JSON.stringify(content)}`);
    } finally {
      typer?.stop();
      try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
      await cleanup();
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }));

function readTestWindowModified(windowId: string): string {
  try {
    return readFileSync(join(tmpdir(), `m9r-test-window-modified-${windowId}.txt`), "utf8");
  } catch {
    return "";
  }
}

function realTestWindowService(root: string, store: ReturnType<typeof createLocalStore>) {
  setOwnerWorkMode(root, "agents-free");
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store,
    manager,
    driver,
    stage: { env: {} },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    resolveStageAppForTest: () => ({ executable: NATIVE_HOST, args: ["--spawn-test-window"] }),
  });
  return { manager, driver, service, cleanup: async () => { await service.close(); manager.close?.(); } };
}

test("Phase 0 T3a (isolation): background WM_CHAR delivery sets a classic Edit control's own modified flag",
  { timeout: 60_000 }, () =>
  withRoot(async (root) => {
    const store = createLocalStore(root);
    const { manager, service, cleanup } = realTestWindowService(root, store);
    const identity = store.issueIdentity("codex", "codex", "session-t3a");
    const task = store.addTask({ from: "you", to: "codex", goal: "T3a classic control", origin: "human_typed", idempotencyKey: "t3a", targetSession: "session-t3a" }).task;
    try {
      const launched = await service.launch(identity.token, task.id, "test-window", "background");
      assert.ok(launched.name, "launch returned a real stage name");
      const typed = await service.act(identity.token, task.id, { kind: "type", text: "classic control edit" }, "background");
      assert.ok(typed, "the background type action completed");
      const anchor = manager.list().find((stage) => stage.name === launched.name)?.anchor;
      assert.ok(anchor, "the classic test window's real anchor is still registered");
      let modified = readTestWindowModified(anchor!.windowId);
      for (let attempt = 0; attempt < 30 && modified !== "1"; attempt++) {
        await delay(50);
        modified = readTestWindowModified(anchor!.windowId);
      }
      // This is the control's OWN internal EM_GETMODIFY state -- the exact
      // mechanism a real app like Notepad would consult to decide whether to
      // show a save prompt -- not just a readback of the typed text.
      assert.equal(modified, "1", "the classic Edit control's own modified flag must be set by background WM_CHAR delivery, proving the delivery mechanism itself is sound for classic controls");
    } finally {
      try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
      await cleanup();
    }
  }));

test("Phase 0 T3b (isolation): UI Automation setValue against real Notepad's own text control sets its dirty marker",
  { timeout: 60_000 }, () =>
  withRoot(async (root) => {
    const store = createLocalStore(root);
    const workDir = mkdtempSync(join(tmpdir(), "m9r-phase0-t3b-"));
    const filePath = join(workDir, "t3b-target.txt");
    writeFileSync(filePath, "");
    const { manager, service, cleanup } = realService(root, store, filePath);
    const identity = store.issueIdentity("codex", "codex", "session-t3b");
    const task = store.addTask({ from: "you", to: "codex", goal: "T3b UIA setValue", origin: "human_typed", idempotencyKey: "t3b", targetSession: "session-t3b" }).task;
    try {
      await ensureNoConflictingNotepadWindow(manager);
      const launched = await service.launch(identity.token, task.id, "test-window", "background");
      assert.ok(launched.name, "launch returned a real stage name");
      const anchor = manager.list().find((stage) => stage.name === launched.name)?.anchor;
      assert.ok(anchor, "Notepad's real anchor is registered");

      // A transient, unrelated Notepad "new version available" banner can pop
      // in and out on its own and race a two-step read-then-dispatch, which
      // the native layer correctly refuses rather than guess through. Dismiss
      // it first (if present), then retry the read immediately before
      // dispatch to shrink that race window instead of guessing past it.
      const dismissTransientBanner = async () => {
        const probe = await manager.windowStructure(anchor!.pid, anchor!.windowId, { maxElements: 4096, maxDepth: 64 });
        const dismiss = probe.elements.find((element) => element.enabled && element.actions?.invoke === true
          && /^dismiss$/i.test(element.label));
        if (!dismiss) return;
        try {
          await manager.invokeWindowElement(anchor!.pid, anchor!.windowId, {
            path: dismiss.path, action: "activate", expectedRole: dismiss.role,
            expectedLabel: dismiss.label, expectedClassName: dismiss.className, expectedAutomationId: dismiss.automationId,
          });
        } catch { /* best-effort: the banner may already be gone by the time this runs */ }
      };
      await dismissTransientBanner();
      await delay(200);

      let dispatch: Awaited<ReturnType<typeof manager.invokeWindowElement>> | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 5 && !dispatch?.dispatched; attempt++) {
        await dismissTransientBanner();
        const structure = await manager.windowStructure(anchor!.pid, anchor!.windowId, { maxElements: 4096, maxDepth: 64 });
        const textControl = structure.elements.find((element) => element.enabled && element.actions?.setValue === true
          && /^(?:edit|document|text)$/i.test(element.role));
        if (attempt === 0) console.log(`[T3b] candidate controls: ${JSON.stringify(structure.elements.map((element) => ({ role: element.role, label: element.label, actions: element.actions })))}`);
        assert.ok(textControl, "Notepad's own text control exposes a UI Automation setValue action");
        // Diagnostic: two back-to-back reads, with no action in between, isolate
        // whether the native re-walk itself is unstable for this element
        // (independent of any real race with Notepad's own UI), rather than
        // guessing at the cause from the generic "changed before dispatch" error.
        const recheck = await manager.windowStructure(anchor!.pid, anchor!.windowId, { maxElements: 4096, maxDepth: 64 });
        const recheckControl = recheck.elements.find((element) => element.enabled && element.actions?.setValue === true
          && /^(?:edit|document|text)$/i.test(element.role));
        console.log(`[T3b] attempt ${attempt} first-read vs re-read: ${JSON.stringify({
          first: { path: textControl!.path, role: textControl!.role, label: textControl!.label, className: textControl!.className, automationId: textControl!.automationId },
          second: recheckControl ? { path: recheckControl.path, role: recheckControl.role, label: recheckControl.label, className: recheckControl.className, automationId: recheckControl.automationId } : undefined,
        })}`);
        try {
          dispatch = await manager.invokeWindowElement(anchor!.pid, anchor!.windowId, {
            path: textControl!.path, action: "setValue", expectedRole: textControl!.role,
            expectedLabel: textControl!.label, expectedClassName: textControl!.className,
            expectedAutomationId: textControl!.automationId, text: "uia setvalue t3b content",
          });
        } catch (error) {
          lastError = error;
          await delay(200);
        }
      }
      assert.ok(dispatch?.dispatched, `UI Automation setValue was not dispatched against Notepad's text control: ${dispatch?.reason ?? (lastError instanceof Error ? lastError.message : "unknown reason")}`);

      let mainWindow;
      for (let attempt = 0; attempt < 30; attempt++) {
        const ownedWindows = await manager.listOwnedWindowsForProcess(anchor!.pid);
        mainWindow = ownedWindows.find((window) => window.windowId.toLowerCase() === anchor!.windowId.toLowerCase());
        if (mainWindow?.title?.includes("*")) break;
        await delay(100);
      }
      console.log(`[T3b] Notepad window after UIA setValue: ${JSON.stringify(mainWindow)}`);
      assert.ok(mainWindow?.title?.includes("*"),
        `Notepad's real title bar never showed the unsaved-changes marker after UI Automation setValue (window=${JSON.stringify(mainWindow)})`);
    } finally {
      try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
      await cleanup();
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }));

test("Phase 0 T3c (isolation): background WM_CHAR delivery to Notepad's actual child Edit HWND sets its dirty marker",
  { timeout: 60_000 }, () =>
  withRoot(async (root) => {
    const store = createLocalStore(root);
    const workDir = mkdtempSync(join(tmpdir(), "m9r-phase0-t3c-"));
    const filePath = join(workDir, "t3c-target.txt");
    writeFileSync(filePath, "");
    const { manager, service, cleanup } = realService(root, store, filePath);
    const identity = store.issueIdentity("codex", "codex", "session-t3c");
    const task = store.addTask({ from: "you", to: "codex", goal: "T3c child Edit HWND", origin: "human_typed", idempotencyKey: "t3c", targetSession: "session-t3c" }).task;
    try {
      await ensureNoConflictingNotepadWindow(manager);
      const launched = await service.launch(identity.token, task.id, "test-window", "background");
      assert.ok(launched.name, "launch returned a real stage name");
      const anchor = manager.list().find((stage) => stage.name === launched.name)?.anchor;
      assert.ok(anchor, "Notepad's real anchor is registered");

      // T3b's UI Automation read showed the real text control's className is
      // "Edit" -- the classic control -- but the original T3's WM_CHAR, sent
      // to the top-level anchor window, never registered. That is consistent
      // with the Edit control being a CHILD window of the frame, not the
      // frame itself. Find it directly and target it, rather than guess.
      const childWindowId = await manager.findEditChildWindow(anchor!.pid, anchor!.windowId);
      console.log(`[T3c] child Edit window: ${JSON.stringify(childWindowId)}`);
      assert.ok(childWindowId, "Notepad exposes a classic Edit-class child window");

      await manager.sendTextToWindow(anchor!.pid, childWindowId!, "child hwnd t3c content");

      let mainWindow;
      for (let attempt = 0; attempt < 30; attempt++) {
        const ownedWindows = await manager.listOwnedWindowsForProcess(anchor!.pid);
        mainWindow = ownedWindows.find((window) => window.windowId.toLowerCase() === anchor!.windowId.toLowerCase());
        if (mainWindow?.title?.includes("*")) break;
        await delay(100);
      }
      console.log(`[T3c] Notepad window after child-HWND WM_CHAR: ${JSON.stringify(mainWindow)}`);
      assert.ok(mainWindow?.title?.includes("*"),
        `Notepad's real title bar never showed the unsaved-changes marker after WM_CHAR to its child Edit HWND (window=${JSON.stringify(mainWindow)})`);
    } finally {
      try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
      await cleanup();
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }));
