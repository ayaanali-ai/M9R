import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService } from "../src/lib/native/task-desktop-stage";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { setOwnerWorkMode } from "../src/lib/native/owner-work-mode";

// The real falsifying-test battery for Chrome, no CDP. agent-chrome.ts (the
// CDP write path) does not exist on this branch; this asks whether the SAME
// background route everything else here uses (UIA SetValue / WM_CHAR,
// through the normal stage driver) can write into a real Chrome tab at all,
// with no CDP debugger attached (so no "being debugged" banner). This is a
// real measurement, not a guess: each page's own real DOM self-reports what
// it actually received over a plain local HTTP request -- never
// GetWindowTextW, never a CDP read, never trusting the dispatch call's own
// return value alone. One pass on one plain input is not proof at scale --
// this file runs the plain case repeatedly for stability, then escalates to
// harder, more Gmail-like real surfaces one at a time, each its own
// independent test so a harder one failing does not hide whether the easier
// ones are solid.
//
// Must be run from a plain, non-agent terminal: native-input-host's own
// agent-context gate refuses real dispatch otherwise, by design, same as
// every other real test in this file set.
const NATIVE_HOST = fileURLToPath(new URL("../native-input-host/target/debug/m9r-native-input-host.exe", import.meta.url));

function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m9r-falsify-chrome-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

/** Serves one page whose own client-side JS reports every real value it
 * actually observed, over a plain local HTTP request. `bodyHtml` is the
 * target surface; `reportScript` is the exact listening code for that
 * surface (different DOM shapes need different real event wiring). */
function startReportingPage(bodyHtml: string, reportScript: string): Promise<{ url: string; latestValue: () => string; close: () => Promise<void> }> {
  let latest = "";
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/report")) {
      const value = new URL(req.url, "http://localhost").searchParams.get("v") ?? "";
      latest = value;
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(
      `<!doctype html><html><body style="font-size:40px">${bodyHtml}<script>${reportScript}</script></body></html>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        latestValue: () => latest,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// This is the SAME path the real product uses for the owner's personal
// browser (task-stage-apps.ts's ownedBrowserLaunch, and its own comment:
// "Browser stages always use the owner's normal profile and cookies. There
// is deliberately no isolated-profile branch"). "--new-window" is how it
// asks Chrome's own already-running instance for a genuinely new window
// (not a tab reused into something the owner has open), still inside the
// owner's real, logged-in profile -- never a disposable --user-data-dir.
function realService(root: string, store: ReturnType<typeof createLocalStore>, url: string) {
  setOwnerWorkMode(root, "agents-free");
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store, manager, driver, stage: { env: {} },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    resolveStageAppForTest: () => ({ executable: CHROME_EXE, args: ["--new-window", url], windowExecutable: "chrome.exe" }),
  });
  return { manager, driver, service, cleanup: async () => { await service.close(); manager.close?.(); } };
}

interface Scenario { name: string; bodyHtml: string; reportScript: string; text: string }

const PLAIN_INPUT: Omit<Scenario, "name"> = {
  bodyHtml: `<input id="a" autofocus style="font-size:40px;width:90%" />`,
  reportScript: `document.getElementById("a").addEventListener("input", (e) => fetch("/report?v=" + encodeURIComponent(e.target.value)));`,
  text: "chrome no cdp",
};

const SCENARIOS: Scenario[] = [
  { name: "plain input, run 1 of 3", ...PLAIN_INPUT },
  { name: "plain input, run 2 of 3", ...PLAIN_INPUT },
  { name: "plain input, run 3 of 3", ...PLAIN_INPUT },
  {
    name: "textarea (multi-line form field)",
    bodyHtml: `<textarea id="a" autofocus style="font-size:40px;width:90%;height:200px"></textarea>`,
    reportScript: `document.getElementById("a").addEventListener("input", (e) => fetch("/report?v=" + encodeURIComponent(e.target.value)));`,
    text: "textarea no cdp",
  },
  {
    name: "contenteditable div (Gmail compose's real mechanism, not a form field)",
    bodyHtml: `<div id="a" contenteditable="true" tabindex="0" autofocus style="font-size:40px;width:90%;min-height:200px;border:1px solid #000"></div><script>document.getElementById("a").focus();</script>`,
    reportScript: `document.getElementById("a").addEventListener("input", (e) => fetch("/report?v=" + encodeURIComponent(e.target.textContent)));`,
    text: "contenteditable no cdp",
  },
  {
    name: "React-style controlled input (overwrites its own DOM value unless a real framework-visible input event fires)",
    bodyHtml: `<input id="a" autofocus style="font-size:40px;width:90%" />`,
    // Mimics what a controlled React component actually does: it listens on
    // the native "input" event (the same one React's SyntheticEvent system
    // is built on) and re-renders the DOM value FROM ITS OWN STATE every
    // time. A delivery mechanism that only mutates the DOM value directly
    // (e.g. a raw UIA SetValue with no real input event fired) would be
    // visibly overwritten back to empty here on the very next render tick --
    // exactly the class of bug React apps like Gmail are most exposed to.
    reportScript: `
      let state = "";
      const el = document.getElementById("a");
      const render = () => { if (el.value !== state) el.value = state; };
      el.addEventListener("input", (e) => { state = e.target.value; render(); fetch("/report?v=" + encodeURIComponent(state)); });
      setInterval(render, 16);
    `,
    text: "react style no cdp",
  },
];

for (const scenario of SCENARIOS) {
  test(
    `Falsifying test: background text delivery into a real Chrome tab, no CDP -- ${scenario.name}`,
    { timeout: 90_000 },
    () => withRoot(async (root) => {
      const page = await startReportingPage(scenario.bodyHtml, scenario.reportScript);
      const store = createLocalStore(root);
      const { manager, service, cleanup } = realService(root, store, page.url);
      const identity = store.issueIdentity("codex", "codex", "session-falsify-chrome");
      const task = store.addTask({ from: "you", to: "codex", goal: "falsifying test chrome", origin: "human_typed", idempotencyKey: `falsify-chrome-${scenario.name}`, targetSession: "session-falsify-chrome" }).task;
      let anchor: { pid: number; windowId: string; processGeneration?: string } | undefined;
      try {
        const launched = await service.launch(identity.token, task.id, "test-window", "background");
        assert.ok(launched.name, "launch returned a real stage name");
        anchor = manager.list().find((stage) => stage.name === launched.name)?.anchor ?? undefined;

        // Chrome's own launch-settle takes real time (it is not finished the
        // moment the OS reports a window exists).
        await delay(3000);

        // Direct, same mechanism Phase 0 T1/T2 already proved.
        const baselineForeground = await manager.currentForegroundWindow();
        const baselineCursor = await manager.getOwnerCursorPosition();

        let dispatchError: unknown;
        try {
          await service.act(identity.token, task.id, { kind: "type", text: scenario.text }, "background");
        } catch (error) {
          dispatchError = error;
        }

        const foregroundAfter = await manager.currentForegroundWindow();
        const cursorAfter = await manager.getOwnerCursorPosition();
        assert.equal(foregroundAfter.pid, baselineForeground.pid, "a background attempt against Chrome must never change the real OS foreground window, pass or fail");
        assert.deepEqual(cursorAfter, baselineCursor, "the real owner cursor position must be unchanged regardless of outcome");

        await delay(400);
        const received = page.latestValue();
        console.log(`[falsify-chrome:${scenario.name}] dispatch error: ${dispatchError ? String((dispatchError as Error).message ?? dispatchError) : "none"}; page received: ${JSON.stringify(received)}`);

        if (dispatchError) {
          console.log(`[falsify-chrome:${scenario.name}] RESULT: clean refusal -- no background route reached Chrome, and it never fell through to the real foreground/cursor either.`);
          assert.equal(received, "", "a reported refusal must mean nothing was actually typed into the real page");
        } else {
          console.log(`[falsify-chrome:${scenario.name}] RESULT: dispatch reported success; real page received ${JSON.stringify(received)}`);
          assert.equal(received, scenario.text, "if dispatch claims success, the real DOM must show the exact text that was supposedly typed, as observed by the page's own real event listener");
        }
      } finally {
        try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
        // When Chrome was already running, "--new-window" hands the request
        // to that SAME shared browser process -- the window's owning PID is
        // the owner's real, whole Chrome. Killing that process would close
        // every real tab and window the owner has open. Closing only this
        // one window (WM_CLOSE to its exact HWND) is the safe, correct
        // cleanup, matching how the real product is designed to behave.
        if (anchor) { try { await manager.postCloseWindow(anchor.pid, anchor.windowId); } catch { /* best-effort */ } }
        await cleanup();
        await page.close();
        await delay(300);
      }
    }),
  );
}
