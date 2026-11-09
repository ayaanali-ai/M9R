import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCuaStageDriver, type CuaStageStructure } from "../src/lib/native/cua-stage-driver";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService } from "../src/lib/native/task-desktop-stage";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { setOwnerWorkMode } from "../src/lib/native/owner-work-mode";

// The "harder" falsifying test, next after Chrome and Gmail: Microsoft Word.
// Unlike Chrome, Word is a genuinely different, non-browser native code
// path (classic Win32/OLE app, no DOM, no contenteditable). This asks the
// same real question as the other two -- does the SAME background route
// (UIA / WM_CHAR, no CDP-equivalent, no screen-reader API) actually land
// text in it -- with the strongest kind of proof available: the real
// on-disk .docx content after a real Save, read directly out of its own
// document.xml, never trusting the dispatch call's return value alone.
//
// Must be run from a plain, non-agent terminal: native-input-host's own
// agent-context gate refuses real dispatch otherwise, by design, same as
// every other real test in this file set.
const NATIVE_HOST = fileURLToPath(new URL("../native-input-host/target/debug/m9r-native-input-host.exe", import.meta.url));
const WINWORD_EXE = "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE";

function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m9r-falsify-office-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function realService(root: string, store: ReturnType<typeof createLocalStore>) {
  setOwnerWorkMode(root, "agents-free");
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store, manager, driver, stage: { env: {} },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    // /n opens a genuinely new blank document -- never the owner's own
    // already-open Word window or document.
    resolveStageAppForTest: () => ({ executable: WINWORD_EXE, args: ["/n"], windowExecutable: "WINWORD.EXE" }),
  });
  return { manager, driver, service, cleanup: async () => { await service.close(); manager.close?.(); } };
}

function findDocumentElement(structure: CuaStageStructure) {
  return structure.elements.find((element) => /^document$/i.test(element.role ?? ""));
}

/** .docx is a zip; shelling out to Expand-Archive is the simplest honest way
 * to read its real on-disk XML from Node without adding a zip dependency. */
function expandDocx(docxPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${docxPath}' -DestinationPath '${destDir}' -Force`], { stdio: "ignore" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`))));
    child.on("error", reject);
  });
}

test(
  "Falsifying test: background text delivery into real Microsoft Word, no CDP-equivalent",
  { timeout: 120_000 },
  () => withRoot(async (root) => {
    if (!existsSync(WINWORD_EXE)) {
      console.log(`[falsify-office] RESULT: inconclusive -- Word is not installed at ${WINWORD_EXE} on this machine.`);
      return;
    }
    const store = createLocalStore(root);
    const { manager, service, cleanup } = realService(root, store);
    const identity = store.issueIdentity("codex", "codex", "session-falsify-office");
    const task = store.addTask({ from: "you", to: "codex", goal: "falsifying test office", origin: "human_typed", idempotencyKey: "falsify-office", targetSession: "session-falsify-office" }).task;
    const workDir = mkdtempSync(join(tmpdir(), "m9r-falsify-office-save-"));
    const savePath = join(workDir, "falsify-office.docx");
    let anchor: { pid: number; windowId: string } | undefined;
    try {
      // Word's own splash-window-to-real-document-window handoff is slower
      // and less uniform than Chrome's or Notepad's -- the native host's own
      // present_owner_window (native-input-host/src/windows_stage.rs) finds
      // a candidate HWND via discovery, then asserts IsWindowVisible on it.
      // A real run observed this failing on all 3 of a quick, 2s-gap retry,
      // which points at Word needing more real settle time before the next
      // discovery, not just one more immediate try. Never force-kill
      // WINWORD.EXE by image name here: that would risk closing a real Word
      // window the owner has open with unsaved work, not just whatever this
      // test itself spawned -- service.closeApp (scoped to this test's own
      // registered stage, if any) is the only cleanup used between attempts.
      let launched: Awaited<ReturnType<typeof service.launch>> | undefined;
      let launchError: unknown;
      for (let attempt = 0; attempt < 5 && !launched; attempt++) {
        try {
          launched = await service.launch(identity.token, task.id, "test-window", "background");
        } catch (error) {
          launchError = error;
          console.log(`[falsify-office] launch attempt ${attempt} failed, retrying: ${String((error as Error).message ?? error)}`);
          try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
          await delay(5000);
        }
      }
      if (!launched) throw launchError instanceof Error ? launchError : new Error("Word's launch never produced a presentable window after 5 attempts");
      assert.ok(launched.name, "launch returned a real stage name");
      const stageName = launched.name!;
      anchor = manager.list().find((stage) => stage.name === stageName)?.anchor;
      assert.ok(anchor, "Word's real anchor is registered");

      // Word is a heavy real app with its own splash/load sequence -- give
      // it real time, polling rather than guessing a single fixed delay.
      let structure: CuaStageStructure | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { structure = await service.act(identity.token, task.id, { kind: "read_structure", view: "app" }, "background") as unknown as CuaStageStructure; }
        catch { /* may not be ready yet */ }
        if (structure && findDocumentElement(structure)) break;
        await delay(1000);
      }
      const documentElement = structure && findDocumentElement(structure);
      console.log(`[falsify-office] document element: ${JSON.stringify(documentElement)}`);

      const baselineForeground = await manager.currentForegroundWindow();
      const baselineCursor = await manager.getOwnerCursorPosition();

      const text = `multi background write test ${Date.now()}`;
      let dispatchError: unknown;
      try {
        await service.act(identity.token, task.id, { kind: "type", text }, "background");
      } catch (error) {
        dispatchError = error;
      }

      const foregroundAfter = await manager.currentForegroundWindow();
      const cursorAfter = await manager.getOwnerCursorPosition();
      assert.equal(foregroundAfter.pid, baselineForeground.pid, "a background attempt against Word must never change the real OS foreground window, pass or fail");
      assert.deepEqual(cursorAfter, baselineCursor, "the real owner cursor position must be unchanged regardless of outcome");

      if (dispatchError) {
        console.log(`[falsify-office] RESULT: clean refusal -- no background route reached Word's document, and it never fell through to the real foreground/cursor either. (${String((dispatchError as Error).message ?? dispatchError)})`);
        return;
      }

      // Word's document pane is a RichEdit-style control (TextPattern, not
      // ValuePattern) -- a UIA read_value on it is expected to fail or
      // return nothing useful. That is diagnostic, not the proof. The real
      // proof is the actual .docx written to disk after a real Save.
      try {
        const readBack = await service.act(identity.token, task.id,
          { kind: "read_value", view: "app", ref: documentElement?.ref ?? "" }, "background") as unknown as { readValue: { status: string; value?: string } };
        console.log(`[falsify-office] UIA read_value on the document pane (diagnostic only): ${JSON.stringify(readBack)}`);
      } catch (error) {
        console.log(`[falsify-office] UIA read_value on the document pane failed, as expected for a RichEdit-style control (diagnostic only): ${String((error as Error).message ?? error)}`);
      }

      // Real Save needs genuine OS foreground (same as Notepad's dialog in
      // scripts/background-input-phase0-t3.test.ts) -- borrowed briefly,
      // for this one necessary step, never a return to exclusive input.
      // Word is heavier than Notepad and can transiently steal its own
      // foreground back (update checks, account/telemetry prompts) between
      // the confirm loop and the next keystroke, so each real-input step
      // re-confirms and retries rather than assuming one lease holds.
      async function withConfirmedForeground<T>(run: () => Promise<T>): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 8; attempt++) {
          await manager.withForegroundAuthorization(async () => {}, () => manager.bringToForeground(anchor!.pid, anchor!.windowId));
          let confirmed = false;
          for (let wait = 0; wait < 20 && !confirmed; wait++) {
            confirmed = (await manager.currentForegroundWindow()).pid === anchor!.pid;
            if (!confirmed) await delay(100);
          }
          if (!confirmed) { await delay(200); continue; }
          try {
            return await manager.withForegroundAuthorization(async () => {}, run);
          } catch (error) {
            lastError = error;
            console.log(`[falsify-office] foreground step attempt ${attempt} failed, retrying: ${String((error as Error).message ?? error)}`);
            await delay(300);
          }
        }
        throw lastError instanceof Error ? lastError : new Error("could not keep Word as the real OS foreground window long enough to send input");
      }

      // F12 = Save As. A brand-new, never-saved document always needs a
      // target path; this is the normal, expected first save for this file.
      await withConfirmedForeground(() => manager.sendKeyCombo(anchor!.pid, anchor!.windowId, ["F12"]));
      await delay(1500);
      await withConfirmedForeground(() => manager.sendText(anchor!.pid, anchor!.windowId, savePath));
      await delay(300);
      await withConfirmedForeground(() => manager.sendKeyCombo(anchor!.pid, anchor!.windowId, ["enter"]));
      await delay(1500);

      let saved: ReturnType<typeof statSync> | undefined;
      for (let attempt = 0; attempt < 30 && !saved; attempt++) {
        try { saved = statSync(savePath); } catch { await delay(200); }
      }
      assert.ok(saved, `the .docx was never actually written to disk at ${savePath}`);

      const extractDir = join(workDir, "extracted");
      await expandDocx(savePath, extractDir);
      const documentXml = readFileSync(join(extractDir, "word", "document.xml"), "utf8");
      const matched = documentXml.includes(text);
      console.log(`[falsify-office] RESULT: dispatch reported success; real on-disk document.xml ${matched ? "CONFIRMS" : "DOES NOT CONFIRM"} the text actually landed.`);
      assert.ok(matched, "dispatch claimed success but the real saved .docx's own document.xml did not contain the exact dispatched text");
    } finally {
      if (anchor) { try { await manager.postCloseWindow(anchor.pid, anchor.windowId); } catch { /* best-effort */ } }
      try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
      await cleanup();
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      await delay(300);
    }
  }),
);
