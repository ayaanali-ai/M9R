import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// Phase 0 concurrency proof (build order item 3). Everything here is real: a
// real native-input-host process, real OS windows (via its test-only
// --spawn-test-window harness), and real PostMessageW/WM_CHAR dispatch --
// never a mocked native layer and never a trusted return code. This is the
// honest, minimal version of the Muse doc's T1/T2 (two different apps
// running concurrently; the same-target serialization stress test). T3 (the
// dialog task) is not attempted in this pass; it is still open on the build
// order.
//
// Effect verification deliberately does NOT use GetWindowTextW cross-process:
// that Win32 API is documented to return only a window's frozen creation-time
// caption when called from a different process than the one that owns the
// window, never a control's live content -- confirmed directly while
// debugging this file (a self-read inside the target process showed live,
// correct updates on every character, while the exact same native host's
// cross-process GetWindowTextW call kept returning the original placeholder,
// unchanged, for the entire test). Real production code already reflects
// this limitation honestly: the WM_CHAR background channel in
// cua-stage-driver.ts returns status "unverifiable" rather than claiming
// certainty. The disposable test harness has no real UI Automation
// label/AutomationId to address it by either, so for this test's own
// verification it reports its own live content to a small file keyed by its
// window handle, which the test reads directly.
const NATIVE_HOST = fileURLToPath(new URL("../native-input-host/target/debug/m9r-native-input-host.exe", import.meta.url));

async function readTestWindowContent(windowId: string): Promise<string> {
  const path = join(tmpdir(), `m9r-test-window-content-${windowId}.txt`);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      await delay(50);
    }
  }
  return "";
}

async function waitForTestWindowContent(windowId: string, expected: string): Promise<string> {
  let text = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    text = await readTestWindowContent(windowId);
    if (text === expected) return text;
    await delay(50);
  }
  return text;
}

function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "m9r-phase0-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function realService(root: string, store: ReturnType<typeof createLocalStore>) {
  setOwnerWorkMode(root, "agents-free"); // permit disposable fixture startup; measured writes remain background-only
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store,
    manager,
    driver,
    stage: { env: {} },
    readPolicy: () => ({ handles: ["codex", "claude"], controlHandles: ["codex", "claude"] }),
    resolveStageAppForTest: () => ({ executable: NATIVE_HOST, args: ["--spawn-test-window"] }),
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

function actionTimings(store: ReturnType<typeof createLocalStore>, taskId: string) {
  return (store.getTask(taskId)?.stageTiming ?? []).filter((event) => event.phase === "action");
}

test("Bilateral: two agents edit separate Windows fixtures concurrently and preserve foreground and pointer", { timeout: 60_000 }, () =>
  withRoot(async (root) => {
    const store = createLocalStore(root);
    const { manager, service, cleanup } = realService(root, store);
    const identityOne = store.issueIdentity("codex", "codex", "session-one");
    const identityTwo = store.issueIdentity("claude", "claude-code", "session-two");
    const taskOne = store.addTask({ from: "you", to: "codex", goal: "T1 window one", origin: "human_typed", idempotencyKey: "t1-one", targetSession: "session-one" }).task;
    const taskTwo = store.addTask({ from: "you", to: "claude", goal: "T1 window two", origin: "human_typed", idempotencyKey: "t1-two", targetSession: "session-two" }).task;
    try {

      const launchedOne = await service.launch(identityOne.token, taskOne.id, "test-window", "background");
      const launchedTwo = await service.launch(identityTwo.token, taskTwo.id, "test-window", "background");
      assert.notEqual(launchedOne.name, launchedTwo.name, "two different identities get two different stages/queues");

      // Each action sleeps (via a deliberately slow text payload is not reliable timing control,
      // so instead we rely on real dispatch latency plus the queue's own timing records) -- the
      // real proof is in the recorded stageTiming windows below, not an assumption about speed.
      const foreground = await manager.currentForegroundWindow();
      const pointer = await manager.getOwnerCursorPosition();
      const [resultOne, resultTwo] = await Promise.all([
        service.act(identityOne.token, taskOne.id, { kind: "type", text: "from-window-one" }, "background"),
        service.act(identityTwo.token, taskTwo.id, { kind: "type", text: "from-window-two" }, "background"),
      ]);
      assert.ok(resultOne, "window one's action completed");
      assert.ok(resultTwo, "window two's action completed");

      store.flushStageTiming();
      const timingsOne = actionTimings(store, taskOne.id);
      const timingsTwo = actionTimings(store, taskTwo.id);
      assert.equal(timingsOne.length, 1);
      assert.equal(timingsTwo.length, 1);
      const [one] = timingsOne, [two] = timingsTwo;
      const startOne = Date.parse(one!.startedAt), endOne = Date.parse(one!.endedAt);
      const startTwo = Date.parse(two!.startedAt), endTwo = Date.parse(two!.endedAt);
      // Genuine concurrency: each action's window overlaps the other's, rather than one
      // ending strictly before the other starts (which is what a shared, serializing queue
      // would force).
      const overlaps = startOne < endTwo && startTwo < endOne;
      assert.ok(overlaps, `expected overlapping action windows; window one [${one!.startedAt}, ${one!.endedAt}], window two [${two!.startedAt}, ${two!.endedAt}]`);

      // Real effect, read back from the target window's own live self-report --
      // never trust the resolved promise alone, and never cross-check one
      // window's text against the other's. See the file header for why this
      // cannot be GetWindowTextW.
      const anchorOne = manager.list().find((stage) => stage.name === launchedOne.name)?.anchor;
      const anchorTwo = manager.list().find((stage) => stage.name === launchedTwo.name)?.anchor;
      assert.ok(anchorOne && anchorTwo, "both windows are still registered with their real anchors");
      const textOne = await waitForTestWindowContent(anchorOne!.windowId, "from-window-one");
      const textTwo = await waitForTestWindowContent(anchorTwo!.windowId, "from-window-two");
      assert.equal(textOne, "from-window-one", "window one received exactly its own text, never window two's");
      assert.equal(textTwo, "from-window-two", "window two received exactly its own text, never window one's");
      assert.equal((await manager.currentForegroundWindow()).windowId, foreground.windowId);
      assert.deepEqual(await manager.getOwnerCursorPosition(), pointer);
    } finally {
      try {
        await service.closeApp(identityOne.token, taskOne.id, "background");
      } catch { /* best-effort: the real cleanup below must still run */ }
      try {
        await service.closeApp(identityTwo.token, taskTwo.id, "background");
      } catch { /* best-effort: the real cleanup below must still run */ }
      await cleanup();
    }
  }));

test("Phase 0 T2: two concurrent actions on the same real target are serialized, not raced", { timeout: 60_000 }, () =>
  withRoot(async (root) => {
    const store = createLocalStore(root);
    const { manager, service, cleanup } = realService(root, store);
    const identity = store.issueIdentity("codex", "codex", "session-same-target");
    const taskA = store.addTask({ from: "you", to: "codex", goal: "T2 first write", origin: "human_typed", idempotencyKey: "t2-a", targetSession: "session-same-target" }).task;
    const taskB = store.addTask({ from: "you", to: "codex", goal: "T2 second write", origin: "human_typed", idempotencyKey: "t2-b", targetSession: "session-same-target" }).task;
    try {

      const launched = await service.launch(identity.token, taskA.id, "test-window", "background");

      // Same identity => same stage name => same per-stage queue (task-desktop-stage.ts's
      // enqueueStage/enqueueTimedStage). Two concurrent dispatches at the *same* target must
      // never be allowed to race against each other the way T1's two different targets did.
      await Promise.all([
        service.act(identity.token, taskA.id, { kind: "type", text: "AAAA" }, "background"),
        service.act(identity.token, taskB.id, { kind: "type", text: "BBBB" }, "background"),
      ]);

      store.flushStageTiming();
      const timingsA = actionTimings(store, taskA.id);
      const timingsB = actionTimings(store, taskB.id);
      assert.equal(timingsA.length, 1);
      assert.equal(timingsB.length, 1);
      const [a] = timingsA, [b] = timingsB;
      const startA = Date.parse(a!.startedAt), endA = Date.parse(a!.endedAt);
      const startB = Date.parse(b!.startedAt), endB = Date.parse(b!.endedAt);
      // Strict serialization: one action's window must end at or before the other's starts.
      // Any overlap here would mean the same-target stress test the Muse doc specifically
      // calls out is not actually being protected by the per-stage queue.
      const serialized = endA <= startB || endB <= startA;
      assert.ok(serialized, `expected non-overlapping action windows; A [${a!.startedAt}, ${a!.endedAt}], B [${b!.startedAt}, ${b!.endedAt}]`);

      const anchor = manager.list().find((stage) => stage.name === launched.name)?.anchor;
      assert.ok(anchor, "the shared stage still has its real anchor");
      let text = await readTestWindowContent(anchor!.windowId);
      for (let attempt = 0; attempt < 30 && text.length < 8; attempt++) {
        await delay(50);
        text = await readTestWindowContent(anchor!.windowId);
      }
      // Each write is atomic and uninterrupted: the result is exactly one run of A's
      // four characters and one run of B's four characters, concatenated in either
      // order -- never an interleaving like "ABAB..." that a race would produce.
      assert.ok(text === "AAAABBBB" || text === "BBBBAAAA", `expected two uninterleaved runs, got ${JSON.stringify(text)}`);
    } finally {
      try {
        await service.closeApp(identity.token, taskA.id, "background");
      } catch { /* best-effort: the real cleanup below must still run */ }
      await cleanup();
    }
  }));
