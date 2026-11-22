import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createCuaStageDriver, type CuaStageStructure } from "../src/lib/native/cua-stage-driver";
import { createWindowsDesktopStageManager, type NativeDispatchEvidence } from "../src/lib/native/windows-desktop-stage";
import { createTaskDesktopStageService } from "../src/lib/native/task-desktop-stage";
import { createMultiplayerDispatchFence } from "../src/lib/native/multiplayer-dispatch-fence";
import { createLocalStore } from "../src/lib/native/local-store";

// This optional binary is excluded from ordinary builds. It only accepts target
// windows owned by that exact fixture executable and its marked disposable form.
// It runs the production native handlers/protocol; the production agent gate is
// untouched and no environment markers are removed to run this test.
const HOST = fileURLToPath(new URL("../native-input-host/target/debug/m9r-native-input-fixture-host.exe", import.meta.url));

async function startForm() {
  const child = spawn(HOST, ["--spawn-form"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const info = await new Promise<{ pid: number; windowId: string; statePath: string }>((yes, no) => {
    let text = ""; let errors = "";
    const timer = setTimeout(() => { child.kill(); no(new Error(`Fixture did not start: ${errors}`)); }, 10_000);
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); no(error); });
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
      if (!text.includes("\n")) return;
      clearTimeout(timer);
      try { yes(JSON.parse(text.split(/\r?\n/)[0]!)); } catch (error) { no(error); }
    });
  });
  return { child, info };
}
async function waitState(path: string, expected: { title: string; caption: string }) {
  let state: { title: string; caption: string; becameForeground: boolean; input: { physicalMouse: number; injectedMouse: number; injectedKeyboard: number } } | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { state = JSON.parse(readFileSync(path, "utf8")); } catch { /* fixture may be publishing */ }
    if (state?.title === expected.title && state?.caption === expected.caption) return state;
    await delay(25);
  }
  assert.deepEqual(state, expected);
  throw new Error("fixture state unavailable");
}
function fields(structure: CuaStageStructure) {
  const edits = structure.elements.filter((element) => /edit/i.test(element.role ?? ""))
    .sort((left, right) => (left.rect?.y ?? 0) - (right.rect?.y ?? 0));
  assert.equal(edits.length, 2, "the real window must expose both fields");
  assert.ok(edits.every((element) => element.canReplaceValue));
  return edits;
}
async function waitForExit(pid: number) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    await delay(25);
  }
  assert.fail(`Test-owned native helper ${pid} did not exit after its channel closed`);
}

test("real native streams overlap SetValue calls to distinct controls of one HWND; the same control remains fenced", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const { child, info } = await startForm();
  // The Windows application-container temp directory can reject the lock
  // directory rename used by the local store. Keep the disposable store under
  // this test checkout; the native barrier and fixture state remain in temp.
  const root = mkdtempSync(join(resolve(fileURLToPath(new URL("../", import.meta.url))), ".tmp-native-stream-proof-"));
  const barrier = mkdtempSync(join(tmpdir(), "m9r-native-stream-barrier-"));
  const priorBarrier = process.env.M9R_NATIVE_TEST_BARRIER_DIR;
  process.env.M9R_NATIVE_TEST_BARRIER_DIR = barrier;
  const store = createLocalStore(root);
  const fence = createMultiplayerDispatchFence({ store });
  const evidence: NativeDispatchEvidence[] = [];
  const manager = createWindowsDesktopStageManager({ root, nativeHostPath: HOST, terminal: true, env: {}, sharedWindowFence: fence,
    onNativeDispatch: (event) => evidence.push(event) });
  const nativeDriver = createCuaStageDriver({ manager });
  const driver = { ...nativeDriver, showAgentCursor: async () => ({ label: "fixture", visible: true }), closeAgentCursor: async () => undefined };
  const service = createTaskDesktopStageService({ store, manager, driver, mutationFence: fence, stage: { env: {} },
    readPolicy: () => ({ handles: ["codex", "claude"], controlHandles: ["codex", "claude"] }) });
  const one = store.issueIdentity("codex", "codex", "stream-one");
  const two = store.issueIdentity("claude", "claude", "stream-two");
  const taskOne = store.addTask({ from: "you", to: "codex", targetSession: "stream-one", goal: "Write the title", origin: "human_typed", idempotencyKey: "one" }).task;
  const taskTwo = store.addTask({ from: "you", to: "claude", targetSession: "stream-two", goal: "Write the caption", origin: "human_typed", idempotencyKey: "two" }).task;
  try {
    await assert.rejects(manager.inspectWindow(String(process.pid), "1"), /outside its own disposable form/,
      "the fixture protocol cannot target a user application");
    const preparedOne = await service.prepare(one.token, taskOne.id, "background");
    const preparedTwo = await service.prepare(two.token, taskTwo.id, "background");
    await manager.attachSharedWindow(preparedOne.name, String(info.pid), info.windowId);
    await manager.attachSharedWindow(preparedTwo.name, String(info.pid), info.windowId);
    await delay(250);
    const nativeStructure = await manager.windowStructure(info.pid, info.windowId, { maxElements: 256, maxDepth: 32 });
    assert.ok(nativeStructure.elements.some((element) => element.role === "edit"), `Native fixture tree: ${JSON.stringify(nativeStructure)}; fixture=${JSON.stringify(info)}; children=${JSON.stringify(await manager.listChildWindowClasses(info.pid, info.windowId))}`);
    const observe = (token: string, taskId: string) => service.act(token, taskId, { kind: "read_structure", view: "app" }, "background") as Promise<CuaStageStructure>;
    const [a, b] = await Promise.all([observe(one.token, taskOne.id), observe(two.token, taskTwo.id)]);
    const title = fields(a)[0]!; const caption = fields(b)[1]!;
    // The desktop may foreground an unrelated elevated/system surface whose
    // process generation is intentionally unavailable to the fixture host.
    // This proof only needs the owner pointer baseline and the target's own
    // no-foreground/input counters.
    const beforeCursor = await manager.getOwnerCursorPosition();
    const inputBefore = await waitState(info.statePath, { title: "", caption: "" });
    await Promise.all([
      service.act(one.token, taskOne.id, { kind: "replace_element", ref: title.ref, text: "Title from Codex", view: "app" }, "background", "title-write"),
      service.act(two.token, taskTwo.id, { kind: "replace_element", ref: caption.ref, text: "Caption from Claude", view: "app" }, "background", "caption-write"),
    ]);
    await waitState(info.statePath, { title: "Title from Codex", caption: "Caption from Claude" });
    await delay(75); // let the independent hook and fixture publication settle
    const inputAfter = await waitState(info.statePath, { title: "Title from Codex", caption: "Caption from Claude" });
    assert.equal(evidence.length, 2);
    assert.notEqual(evidence[0]!.helperPid, evidence[1]!.helperPid, "agents use independent real native helpers");
    assert.notEqual(evidence[0]!.streamId, evidence[1]!.streamId);
    const [x, y] = evidence;
    assert.ok(BigInt(x!.startedUnixNanos) < BigInt(y!.endedUnixNanos) && BigInt(y!.startedUnixNanos) < BigInt(x!.endedUnixNanos),
      `actual native SetValue call intervals did not overlap: ${JSON.stringify(evidence)}`);
    assert.equal(inputAfter.becameForeground, false, "the target never took the user's foreground");
    assert.equal(inputAfter.input.injectedMouse, inputBefore.input.injectedMouse, "no synthetic mouse input was emitted");
    assert.equal(inputAfter.input.injectedKeyboard, inputBefore.input.injectedKeyboard, "no synthetic keyboard input was emitted");
    const cursorAfter = await manager.getOwnerCursorPosition();
    const physicalOwnerMoved = inputAfter.input.physicalMouse > inputBefore.input.physicalMouse;
    if (!physicalOwnerMoved) assert.deepEqual(cursorAfter, beforeCursor);
    else process.stdout.write("Cursor coordinate comparison inconclusive: physical owner mouse input occurred; zero-injected-input check still applies.\n");

    // Both providers independently observe the same current title field. Their
    // snapshots have different refs, but must contend on one canonical region.
    const [freshA, freshB] = await Promise.all([observe(one.token, taskOne.id), observe(two.token, taskTwo.id)]);
    const same = await Promise.allSettled([
      service.act(one.token, taskOne.id, { kind: "replace_element", ref: fields(freshA)[0]!.ref, text: "Title A", view: "app" }, "background", "same-a"),
      service.act(two.token, taskTwo.id, { kind: "replace_element", ref: fields(freshB)[0]!.ref, text: "Title B", view: "app" }, "background", "same-b"),
    ]);
    assert.equal(same.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(same.filter((result) => result.status === "rejected").length, 1);
    assert.equal(evidence.length, 3, "the conflicting writer never reaches the native mutation call");
    await waitState(info.statePath, { title: same[0]?.status === "fulfilled" ? "Title A" : "Title B", caption: "Caption from Claude" });
    const retired = evidence[0]!; const remaining = evidence[1]!;
    manager.closeInputStream(retired.streamId!);
    await waitForExit(retired.helperPid);
    assert.ok(["visible", "occluded"].includes(await manager.withInputStream(remaining.streamId!, () => manager.windowStatus(info.pid, info.windowId))),
      "closing one stream's helper leaves its peer's native channel usable without requiring foreground visibility");
    process.stdout.write(`Native gated-stress overlap verified (not a latency benchmark): ${JSON.stringify(evidence.slice(0, 2).map(({ helperPid, streamId, startedUnixNanos, endedUnixNanos }) =>
      ({ helperPid, streamId, startedUnixNanos, endedUnixNanos })))}\n`);
  } catch (error) {
    process.stderr.write(`Native same-window stream test failed before cleanup: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    throw error;
  } finally {
    await service.close(); manager.close();
    await Promise.all([...new Set(evidence.map((event) => event.helperPid))].map(waitForExit));
    if (child.exitCode === null) child.kill();
    await waitForExit(info.pid);
    if (priorBarrier === undefined) delete process.env.M9R_NATIVE_TEST_BARRIER_DIR;
    else process.env.M9R_NATIVE_TEST_BARRIER_DIR = priorBarrier;
    const statePath = resolve(info.statePath);
    if (statePath.startsWith(resolve(tmpdir()) + "\\") && /^m9r-input-stream-fixture-\d+-\d+\.json$/.test(basename(statePath))) rmSync(statePath, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(barrier, { recursive: true, force: true });
  }
});
