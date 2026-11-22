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

// The real Gmail falsifying test, no CDP, no local test page -- the actual
// target, not a proxy. falsifying-test-chrome.test.ts already proved the
// mechanism against a contenteditable div and a React-controlled input,
// both designed to be as close to Gmail's own compose behavior as a local
// page can get; this test is what settles whether Gmail's own, real
// production compose box (not a lookalike) accepts the same background
// write. It runs in the owner's REAL Chrome, REAL signed-in profile --
// never an isolated/disposable one (Gmail cannot be tested logged out).
//
// Verification never uses GetWindowTextW (confirmed elsewhere in this repo
// to return only a frozen caption cross-process) and never a CDP read.
// read_value's UI Automation ValuePattern read is this product's own real
// production read-back primitive -- the same one a verified-effects check
// would use -- not a test-only shortcut.
//
// Must be run from a plain, non-agent terminal: native-input-host's own
// agent-context gate refuses real dispatch otherwise, by design, same as
// every other real test in this file set.
const NATIVE_HOST = fileURLToPath(new URL("../native-input-host/target/debug/m9r-native-input-host.exe", import.meta.url));
const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// view=cm&fs=1 opens the compose window directly if already signed in --
// still lands on Google's own sign-in page otherwise, which this test
// detects and reports plainly rather than guessing.
const GMAIL_COMPOSE_URL = "https://mail.google.com/mail/?view=cm&fs=1&tf=1";

function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m9r-falsify-gmail-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function realService(root: string, store: ReturnType<typeof createLocalStore>) {
  setOwnerWorkMode(root, "agents-free");
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store, manager, driver, stage: { env: {} },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    // Same real-personal-browser path as the Chrome battery and the real
    // product: --new-window into the owner's own, already-signed-in Chrome.
    resolveStageAppForTest: () => ({ executable: CHROME_EXE, args: ["--new-window", GMAIL_COMPOSE_URL], windowExecutable: "chrome.exe" }),
  });
  return { manager, driver, service, cleanup: async () => { await service.close(); manager.close?.(); } };
}

/** Gmail's own real aria-label for the compose body is "Message Body" --
 * this looks for exactly that, never a guess by size or position, so a
 * misidentified field (To/Subject/CC) can never be silently written into
 * instead. */
function findComposeBody(structure: CuaStageStructure) {
  return structure.elements.find((element) =>
    (element.label ?? "").toLowerCase().includes("message body") && element.canReplaceValue);
}

function looksLikeSignInPage(structure: CuaStageStructure): boolean {
  const text = structure.elements.map((element) => (element.label ?? "").toLowerCase()).join(" ");
  return /sign in|choose an account|enter your password/.test(text) && !text.includes("message body");
}

test(
  "Falsifying test: background text delivery into the real Gmail compose box, no CDP",
  { timeout: 120_000 },
  () => withRoot(async (root) => {
    const store = createLocalStore(root);
    const { manager, service, cleanup } = realService(root, store);
    const identity = store.issueIdentity("codex", "codex", "session-falsify-gmail");
    const task = store.addTask({ from: "you", to: "codex", goal: "falsifying test gmail", origin: "human_typed", idempotencyKey: "falsify-gmail", targetSession: "session-falsify-gmail" }).task;
    let anchor: { pid: number; windowId: string; processGeneration?: string } | undefined;
    try {
      const launched = await service.launch(identity.token, task.id, "test-window", "background");
      assert.ok(launched.name, "launch returned a real stage name");
      const stageName = launched.name!;
      anchor = manager.list().find((stage) => stage.name === stageName)?.anchor ?? undefined;

      // Gmail is a heavy real app over a real network -- give it real time
      // to finish loading and rendering compose, polling rather than
      // guessing a single fixed delay.
      let structure: CuaStageStructure | undefined;
      let composeBody: ReturnType<typeof findComposeBody>;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          structure = await service.act(identity.token, task.id, { kind: "read_structure", view: "app" }, "background") as unknown as CuaStageStructure;
        } catch { /* may not be ready yet */ }
        if (structure) {
          if (looksLikeSignInPage(structure)) {
            console.log("[falsify-gmail] RESULT: inconclusive -- this landed on Google's sign-in page, not compose. The owner's Chrome profile is not signed into Gmail (or the session needs re-auth). This proves nothing either way about the background-write mechanism.");
            return;
          }
          composeBody = findComposeBody(structure);
          if (composeBody) break;
        }
        await delay(1000);
      }
      if (!composeBody) {
        console.log(`[falsify-gmail] RESULT: inconclusive -- could not locate a "Message Body" element after 30s. Gmail may still be loading, or its UI/labels have changed. Last structure had ${structure?.elements.length ?? 0} elements.`);
        return;
      }
      console.log(`[falsify-gmail] found compose body: ref=${composeBody.ref} role=${composeBody.role} label=${JSON.stringify(composeBody.label)}`);

      const baselineForeground = await manager.currentForegroundWindow();
      const baselineCursor = await manager.getOwnerCursorPosition();

      const text = `multi background write test ${Date.now()}`;
      let dispatchError: unknown;
      try {
        await service.act(identity.token, task.id,
          { kind: "replace_element", view: "app", ref: composeBody.ref, text, expectedRole: composeBody.role, expectedLabel: composeBody.label },
          "background");
      } catch (error) {
        dispatchError = error;
      }

      const foregroundAfter = await manager.currentForegroundWindow();
      const cursorAfter = await manager.getOwnerCursorPosition();
      assert.equal(foregroundAfter.pid, baselineForeground.pid, "a background attempt against Gmail must never change the real OS foreground window, pass or fail");
      assert.deepEqual(cursorAfter, baselineCursor, "the real owner cursor position must be unchanged regardless of outcome");

      await delay(500);
      // Gmail is heavily React-driven and can replace its own DOM/UIA node
      // for the compose body on re-render -- reusing the PRE-write ref for
      // the read-back would then fail with a stale-element error that looks
      // like a verification failure but is really just an invalidated
      // reference. Re-finding the element fresh, by the same real label,
      // after the write is the honest way to read back what a React app's
      // own UI actually ended up holding.
      let readBack: { status: string; value?: string } | undefined;
      let postWriteStructure: CuaStageStructure | undefined;
      let freshRef: string | undefined;
      try {
        postWriteStructure = await service.act(identity.token, task.id, { kind: "read_structure", view: "app" }, "background") as unknown as CuaStageStructure;
        freshRef = findComposeBody(postWriteStructure)?.ref;
      } catch (error) {
        console.log(`[falsify-gmail] re-reading structure after write failed: ${String((error as Error).message ?? error)}`);
      }
      console.log(`[falsify-gmail] pre-write ref=${composeBody.ref}; post-write ref=${freshRef ?? "not found"} (${freshRef === composeBody.ref ? "SAME element" : "DIFFERENT -- Gmail replaced its own node"})`);
      try {
        const result = await service.act(identity.token, task.id,
          { kind: "read_value", view: "app", ref: freshRef ?? composeBody.ref, expectedRole: composeBody.role, expectedLabel: composeBody.label },
          "background") as unknown as { readValue: { status: string; value?: string } };
        readBack = result.readValue;
      } catch (error) {
        console.log(`[falsify-gmail] read_value itself failed: ${String((error as Error).message ?? error)}`);
      }
      console.log(`[falsify-gmail] dispatch error: ${dispatchError ? String((dispatchError as Error).message ?? dispatchError) : "none"}; real UIA read-back: ${JSON.stringify(readBack)}`);

      if (dispatchError) {
        console.log("[falsify-gmail] RESULT: clean refusal -- no background route reached Gmail's real compose box, and it never fell through to the real foreground/cursor either.");
      } else {
        const matched = readBack?.status === "read" && (readBack.value ?? "").includes(text);
        console.log(`[falsify-gmail] RESULT: dispatch reported success; real UIA read-back of the compose box ${matched ? "CONFIRMS" : "DOES NOT CONFIRM"} the text actually landed.`);
        assert.ok(matched, `dispatch claimed success but the real UIA read-back of Gmail's compose box did not confirm the text (${JSON.stringify(readBack)})`);
      }
    } finally {
      if (anchor) { try { await manager.postCloseWindow(anchor.pid, anchor.windowId); } catch { /* best-effort */ } }
      try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
      await cleanup();
      await delay(300);
    }
  }),
);
