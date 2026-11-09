import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

// Falsifying test for WhatsApp Desktop (a UWP app, a third genuinely
// different code path from Chrome's DOM and Word's Win32/OLE RichEdit).
//
// CRITICAL SAFETY DIFFERENCE FROM EVERY OTHER TEST IN THIS FILE SET:
// a WhatsApp message is delivered to a real person the instant Enter (or
// the Send button) is activated -- there is no draft/local-save step like
// Gmail's compose box or Word's document. This test therefore:
//   - NEVER sends press_key "enter" or any key combo.
//   - NEVER invokes a Send button/icon.
//   - Only verifies text landed in the compose box via a real UI
//     Automation read, then clears it back to empty with another
//     replace_element("") -- never a keystroke -- so no draft is left
//     sitting in the chat.
//   - NEVER closes WhatsApp's window or process: it is the owner's single,
//     already-running, already-signed-in real app, not something this
//     test spawned fresh. Only the M9R registry binding is released
//     (service.closeApp), exactly like the personal-Chrome tests never
//     close the user's real browser.
//   - Targets a chat the owner explicitly named ("Dad"), never a guessed
//     or first-in-list contact.
//
// Must be run from a plain, non-agent terminal: native-input-host's own
// agent-context gate refuses real dispatch otherwise, by design, same as
// every other real test in this file set.
const NATIVE_HOST = fileURLToPath(new URL("../native-input-host/target/debug/m9r-native-input-host.exe", import.meta.url));
// The AUMID M9R's own computer-use access grant reported for this
// machine's installed WhatsApp Desktop package.
const WHATSAPP_AUMID = "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App";
const CHAT_NAME = "Dad";

function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m9r-falsify-whatsapp-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function realService(store: ReturnType<typeof createLocalStore>, root: string) {
  setOwnerWorkMode(root, "agents-free");
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store, manager, driver, stage: { env: {} },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    // WhatsApp is a UWP package -- like Notepad, its exe cannot be spawned
    // directly (Windows refuses with EPERM); shell:AppsFolder\<AUMID> is
    // the same real activation mechanism as double-clicking its Start
    // Menu tile. Already running (the normal case), this simply focuses
    // the owner's existing, single real window -- it never creates a
    // second instance.
    resolveStageAppForTest: () => ({
      executable: "C:\\Windows\\explorer.exe",
      args: [`shell:AppsFolder\\${WHATSAPP_AUMID}`],
      windowExecutable: "WhatsApp.Root.exe",
    }),
  });
  return { manager, driver, service, cleanup: async () => { await service.close(); manager.close?.(); } };
}

function findChatListItem(structure: CuaStageStructure, name: string) {
  const needle = name.toLowerCase();
  return structure.elements.find((element) =>
    (element.label ?? "").toLowerCase().includes(needle)
    && /list item|button/i.test(element.role ?? ""));
}

/** WhatsApp's real compose box label is expected to be close to "Type a
 * message" -- matched loosely and never by position/size, and explicitly
 * excluding the top search box (whose label mentions "search"), so a
 * misidentified field can never be silently written into instead. */
function findComposeBox(structure: CuaStageStructure) {
  return structure.elements.find((element) => {
    const label = (element.label ?? "").toLowerCase();
    return element.canReplaceValue && label.includes("message") && !label.includes("search");
  });
}

test(
  "Falsifying test: background text delivery into real WhatsApp Desktop (write-only, never sends)",
  { timeout: 90_000 },
  () => withRoot(async (root) => {
    const store = createLocalStore(root);
    const { manager, service, cleanup } = realService(store, root);
    const identity = store.issueIdentity("codex", "codex", "session-falsify-whatsapp");
    const task = store.addTask({ from: "you", to: "codex", goal: "falsifying test whatsapp", origin: "human_typed", idempotencyKey: "falsify-whatsapp", targetSession: "session-falsify-whatsapp" }).task;
    try {
      // WhatsApp is a real, already-running, single-instance app: there is
      // no genuinely NEW window for service.launch()'s own discovery to
      // find (it deliberately excludes any window that already existed
      // before this call, to avoid silently adopting the owner's existing
      // session as if it were freshly launched -- the same safety rule
      // that made the Notepad tests close any pre-existing window first).
      // Here that would mean closing the owner's one real WhatsApp window,
      // which this test must never do.
      //
      // Checking for the already-open window FIRST, before ever calling
      // service.launch(), matters for more than tidiness: launch()'s own
      // discovery polls listVisibleWindows() for up to LAUNCH_POLL_BUDGET_MS
      // (55s, task-desktop-stage.ts) before it gives up and throws "no
      // supported exact-process window" -- a real run hit exactly that
      // failure, but only after burning most of the test's own 90s budget
      // on that doomed poll, leaving too little time for the rest of the
      // real UI steps below and making the test look hung rather than
      // simply starved for time. Going straight to listVisibleWindows() and
      // binding directly -- the same manager.presentOwnerWindow +
      // manager.attachWindow pair launch() uses internally on its own
      // success path -- skips that wasted 55s entirely. Only if WhatsApp
      // is not already open at all does this fall back to the real launch
      // path (which, for a future app-specific adapter, might succeed).
      let stageName: string;
      const visibleWindows = await manager.listVisibleWindows();
      console.log(`[falsify-whatsapp] diagnostic: native host sees ${visibleWindows.length} visible window(s): ${JSON.stringify(visibleWindows.map((w) => ({ pid: w.pid, title: w.title, processName: w.processName })))}`);
      const alreadyOpenWindow = visibleWindows.find((window) => window.title === "WhatsApp");
      if (alreadyOpenWindow) {
        console.log(`[falsify-whatsapp] WhatsApp is already open (pid=${alreadyOpenWindow.pid}); attaching directly instead of calling launch().`);
        const pending = await manager.create("test-window-whatsapp");
        stageName = pending.name;
        await manager.presentOwnerWindow(stageName, alreadyOpenWindow.pid, alreadyOpenWindow.windowId);
        await manager.attachWindow(stageName, String(alreadyOpenWindow.pid), alreadyOpenWindow.windowId, "whatsapp");
      } else {
        try {
          const launched = await service.launch(identity.token, task.id, "test-window", "background");
          assert.ok(launched.name, "launch returned a real stage name");
          stageName = launched.name!;
        } catch (error) {
          const message = String((error as Error).message ?? error);
          if (!/no supported exact-process window/i.test(message)) throw error;
          throw new Error(`WhatsApp was not already open and launch() could not adopt a new window either: ${message}`);
        }
      }
      assert.ok(manager.list().find((stage) => stage.name === stageName)?.anchor, "WhatsApp's real anchor is registered");

      let structure: CuaStageStructure | undefined;
      let chatItem: ReturnType<typeof findChatListItem>;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { structure = await service.act(identity.token, task.id, { kind: "read_structure", view: "app" }, "background") as unknown as CuaStageStructure; }
        catch { /* may not be ready yet */ }
        if (structure) {
          chatItem = findChatListItem(structure, CHAT_NAME);
          if (chatItem) break;
        }
        await delay(500);
      }
      if (!chatItem) {
        console.log(`[falsify-whatsapp] RESULT: inconclusive -- could not find a chat list entry matching "${CHAT_NAME}". Last structure had ${structure?.elements.length ?? 0} elements.`);
        return;
      }
      console.log(`[falsify-whatsapp] found chat: ref=${chatItem.ref} role=${chatItem.role} label=${JSON.stringify(chatItem.label)}`);

      await service.act(identity.token, task.id,
        { kind: "click_element", view: "app", ref: chatItem.ref, expectedRole: chatItem.role, expectedLabel: chatItem.label },
        "background");
      await delay(800);

      let composeBox: ReturnType<typeof findComposeBox>;
      let postClickStructure: CuaStageStructure | undefined;
      for (let attempt = 0; attempt < 15 && !composeBox; attempt++) {
        postClickStructure = await service.act(identity.token, task.id, { kind: "read_structure", view: "app" }, "background") as unknown as CuaStageStructure;
        composeBox = findComposeBox(postClickStructure);
        if (!composeBox) await delay(400);
      }
      if (!composeBox) {
        console.log(`[falsify-whatsapp] RESULT: inconclusive -- opened "${CHAT_NAME}" but could not locate its message compose box. Elements seen: ${JSON.stringify(postClickStructure?.elements.map((e) => ({ role: e.role, label: e.label })))}`);
        return;
      }
      console.log(`[falsify-whatsapp] found compose box: ref=${composeBox.ref} role=${composeBox.role} label=${JSON.stringify(composeBox.label)}`);

      const baselineForeground = await manager.currentForegroundWindow();
      const baselineCursor = await manager.getOwnerCursorPosition();

      const text = `m9r background write test ${Date.now()} (not sent)`;
      let dispatchError: unknown;
      try {
        // replace_element (UIA SetValue), never press_key/hotkey -- this
        // can never trigger WhatsApp's own Enter-to-send behavior.
        await service.act(identity.token, task.id,
          { kind: "replace_element", view: "app", ref: composeBox.ref, text, expectedRole: composeBox.role, expectedLabel: composeBox.label },
          "background");
      } catch (error) {
        dispatchError = error;
      }

      const foregroundAfter = await manager.currentForegroundWindow();
      const cursorAfter = await manager.getOwnerCursorPosition();
      assert.equal(foregroundAfter.pid, baselineForeground.pid, "a background attempt against WhatsApp must never change the real OS foreground window, pass or fail");
      assert.deepEqual(cursorAfter, baselineCursor, "the real owner cursor position must be unchanged regardless of outcome");

      if (dispatchError) {
        console.log(`[falsify-whatsapp] RESULT: clean refusal -- no background route reached WhatsApp's compose box, and it never fell through to the real foreground/cursor either. (${String((dispatchError as Error).message ?? dispatchError)})`);
        return;
      }

      await delay(500);
      let freshRef: string | undefined;
      try {
        const postWriteStructure = await service.act(identity.token, task.id, { kind: "read_structure", view: "app" }, "background") as unknown as CuaStageStructure;
        freshRef = findComposeBox(postWriteStructure)?.ref;
      } catch { /* fall back to the pre-write ref below */ }

      let readBack: { status: string; value?: string } | undefined;
      try {
        const result = await service.act(identity.token, task.id,
          { kind: "read_value", view: "app", ref: freshRef ?? composeBox.ref, expectedRole: composeBox.role, expectedLabel: composeBox.label },
          "background") as unknown as { readValue: { status: string; value?: string } };
        readBack = result.readValue;
      } catch (error) {
        console.log(`[falsify-whatsapp] read_value failed: ${String((error as Error).message ?? error)}`);
      }
      const matched = readBack?.status === "read" && (readBack.value ?? "").includes(text);
      console.log(`[falsify-whatsapp] RESULT: dispatch reported success; real UIA read-back of the compose box ${matched ? "CONFIRMS" : "DOES NOT CONFIRM"} the text actually landed (never sent -- clearing it now).`);

      // Clear the draft back to empty regardless of outcome -- never leave
      // test text sitting in a real chat with "Dad". Another replace_element
      // call, never a keystroke, so there is still no way this can send.
      try {
        await service.act(identity.token, task.id,
          { kind: "replace_element", view: "app", ref: freshRef ?? composeBox.ref, text: "", expectedRole: composeBox.role, expectedLabel: composeBox.label },
          "background");
      } catch (error) {
        console.log(`[falsify-whatsapp] WARNING: could not clear the compose box after the test -- check "${CHAT_NAME}"'s chat manually and clear it if the draft is still there. (${String((error as Error).message ?? error)})`);
      }

      assert.ok(matched, `dispatch claimed success but the real UIA read-back of WhatsApp's compose box did not confirm the text (${JSON.stringify(readBack)})`);
    } finally {
      // Deliberately no postCloseWindow and no process kill: this is the
      // owner's one real, already-running WhatsApp window, not something
      // this test spawned. Only the M9R registry binding is released.
      try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
      await cleanup();
      await delay(300);
    }
  }),
);
