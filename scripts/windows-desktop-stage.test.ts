import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { acquireRegistryLock, createWindowsDesktopStageManager, formatWindowsStageRoomKeys } from "../src/lib/native/windows-desktop-stage";

const stageDesktop = "3ecb4a09-87d4-4f8b-9fd1-48bc9d8c14ae";
const createdDesktop = "4fc4701b-6c3e-46d1-bba1-e99d993a28a2";
const ownerDesktop = "c0999999-87d4-4f8b-9fd1-48bc9d8c14ae";

test("window-state control verifies the exact selected HWND and requested state", async () => withRoot(async (root) => {
  let result = "minimized";
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: async (request) => {
    if (request.op === "setWindowState") {
      assert.equal(request.pid, 123); assert.equal(request.windowId, "456");
      return { ok: true, state: result } as never;
    }
    return { ok: true, window: { pid: 123, windowId: "456", desktopId: stageDesktop, onCurrentDesktop: true } };
  } });
  await manager.register("stage", "123", "456");
  assert.equal(await manager.setWindowState("stage", "minimized"), "minimized");
  result = "restored";
  await assert.rejects(manager.setWindowState("stage", "maximized"), /not verified/);
}));

test("native window lifecycle states remain distinct and unknown results fail closed", async () => withRoot(async (root) => {
  let state = "closed";
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async () => ({ ok: true, windowState: state } as never) });
  for (state of ["closed", "moved", "minimized", "occluded", "hidden", "visible"]) assert.equal(await manager.windowStatus(123, "456"), state);
  state = "guess";
  await assert.rejects(manager.windowStatus(123, "456"), /could not be verified/);
}));

test("a post-create registry failure retains a recoverable desktop journal", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: async () => {
    mkdirSync(join(root, "windows-stages.json"));
    return { ok: true, desktop: { desktopId: createdDesktop, isCurrent: false, returnDesktopId: ownerDesktop } };
  } });
  await assert.rejects(manager.create("new-stage"), /could not save/);
  const files = readdirSync(join(root, "desktop-creation-recovery"));
  assert.equal(files.length, 1);
  const evidence = JSON.parse(readFileSync(join(root, "desktop-creation-recovery", files[0]!), "utf8"));
  assert.equal(evidence.desktop.desktopId, createdDesktop);
  assert.equal(evidence.name, "new-stage");
}));

test("an old registry lock held by a live process is not stolen and release checks its token", async () => withRoot(async (root) => {
  const release = acquireRegistryLock(root);
  const lock = join(root, "windows-stages.json.lock");
  const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  utimesSync(lock, new Date(0), new Date(0));
  assert.throws(() => acquireRegistryLock(root), /already running/);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ ...owner, token: "replacement" }));
  release();
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "replacement");
}));

test("an exact HWND cannot be claimed by two stages", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: async (request) => ({
    ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId: stageDesktop, onCurrentDesktop: true },
  }) });
  await manager.register("first", "123", "456");
  const contested = await Promise.allSettled([manager.register("racer-a", "123", "789"), manager.register("racer-b", "123", "789")]);
  assert.equal(contested.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(manager.register("second", "123", "456"), /already claimed/i);
  assert.equal(manager.list().length, 2);
  await manager.register("first", "123", "456");
}));

test("an exact HWND can be shared only by stages in the same durable coordination group", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: async (request) => ({
    ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId: stageDesktop, onCurrentDesktop: true },
  }) });
  const jointKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  await manager.register("provider-a", "123", "456", "calculator", jointKey);
  const joined = await manager.register("provider-b", "123", "456", "calculator", jointKey);
  assert.equal(joined.coordinationKey, jointKey);
  await assert.rejects(manager.register("unrelated", "123", "456", "calculator",
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"), /already claimed/i);
  assert.equal(manager.list().filter((stage) => stage.anchor?.windowId === "456").length, 2);
}));

test("shell point inspection and invocation preserve exact control identity without global input", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const control = { label: "Start", pid: 123, windowPid: 123, windowId: "456", rect: { x: 0, y: 0, width: 50, height: 50 }, invoked: false };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: async (request) => {
    requests.push(request);
    if (request.op === "windowAtPoint") return { ok: true, pointWindow: { pid: 123, windowId: "456", shell: true, screenOrigin: { x: -100, y: 25 } } };
    return { ok: true, control: { ...control, invoked: request.op === "invokePointControl" } };
  } });
  assert.deepEqual(await manager.windowAtPoint(10, 10), { pid: 123, windowId: BigInt(456), shell: true, keyboardWindow: false, screenOrigin: { x: -100, y: 25 } });
  const inspected = await manager.pointControl(10, 10);
  await manager.pointControl(10, 10, inspected);
  assert.deepEqual(requests.at(-1), { op: "invokePointControl", x: 10, y: 10, label: "Start", pid: 123, windowPid: 123, windowId: "456" });
  await assert.rejects(manager.windowAtPoint(NaN, 10), /Invalid/);
  await assert.rejects(manager.pointControl(0.5, 10), /Invalid/);
}));

test("whole-desktop UI Automation snapshots stay bounded and handle-free", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: async (request) => {
    requests.push(request);
    return { ok: true, desktopStructure: {
      scope: "desktop", status: "complete", truncated: false,
      screen: { x: -1920, y: 0, width: 3840, height: 1080 },
      elements: [{ ref: "desktop-ui-element-1", label: "Start", role: "button", className: "Start", depth: 2,
        enabled: true, focused: false, rect: { x: -10, y: 1040, width: 48, height: 40 } }],
    } } as never;
  } });
  const structure = await manager.desktopStructure({ maxElements: 64, maxDepth: 10 });
  assert.equal(structure.status, "complete");
  assert.equal(structure.screen.x, -1920);
  assert.equal(structure.elements[0]?.label, "Start");
  assert.deepEqual(requests, [{ op: "inspectDesktopStructure", maxElements: 64, maxDepth: 10 }]);
  await assert.rejects(manager.desktopStructure({ maxElements: 65 }), /bounds are invalid/);
}));
const anchor = { pid: 4_321, windowId: "9223372036854775807", desktopId: stageDesktop, onCurrentDesktop: false };

test("owned launch discovery accepts hidden windows only from the exact child process", async () => withRoot(async (root) => {
  let wrongProcess = false;
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "createDesktop" || request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: createdDesktop, isCurrent: false, returnDesktopId: ownerDesktop } };
      if (request.op === "listOwnedWindows") return { ok: true, windows: [{ pid: wrongProcess ? 9999 : 4321, windowId: "1234", title: "Hidden owned app", width: 656, height: 519 }] };
      throw new Error("Unexpected native request");
    } });
  await manager.create("launch-test");
  assert.equal((await manager.listOwnedWindows("launch-test", 4321))[0]?.windowId, "1234");
  assert.deepEqual(requests.at(-1), { op: "listOwnedWindows", pid: 4321 });
  wrongProcess = true;
  await assert.rejects(manager.listOwnedWindows("launch-test", 4321), /invalid identity/);
  await assert.rejects(manager.listOwnedWindows("launch-test", 0), /Invalid owned process/);
}));

test("moves only the exact broker-owned child to its background stage without activation", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "createDesktop" || request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: createdDesktop, isCurrent: false, returnDesktopId: ownerDesktop } };
      if (request.op === "showAndMoveOwnedWindow") return { ok: true, window: { pid: 4321, windowId: "1234", desktopId: createdDesktop, onCurrentDesktop: false } };
      throw new Error("Unexpected native request");
    } });
  await manager.create("launch-test");
  const result = await manager.moveOwnedWindow("launch-test", 4321, "1234");
  assert.equal(result.window.desktopId, createdDesktop);
  assert.equal(result.window.onCurrentDesktop, false);
  assert.deepEqual(requests.at(-1), { op: "showAndMoveOwnedWindow", pid: 4321, windowId: "1234", desktopId: createdDesktop });
  await assert.rejects(manager.moveOwnedWindow("launch-test", 4322, "1234"), /did not confirm/);
}));

function withRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const fixtureRoot = resolve(process.cwd(), ".test-tmp", "native-test-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, "m9r-windows-stage-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("registers a machine-local stage from an exact window and persists opaque room identities", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  const registered = await manager.register("My Stage", "4321", anchor.windowId);
  assert.equal(registered.name, "my-stage");
  assert.equal(registered.desktopId, stageDesktop);
  assert.deepEqual(registered.anchor, { pid: 4_321, windowId: anchor.windowId });
  assert.deepEqual(manager.list(), [registered]);
  assert.match(readFileSync(join(root, "windows-stages.json"), "utf8"), /"version": 3/);
  assert.match(registered.roomDesktopId, /^[0-9a-f-]{36}$/i);
  assert.match(registered.roomWindowId ?? "", /^[0-9a-f-]{36}$/i);
}));

test("creates a local stage without switching desktops and later activates it explicitly", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "createDesktop") return { ok: true, desktop: { desktopId: createdDesktop, isCurrent: false, returnDesktopId: ownerDesktop } };
      if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: createdDesktop, isCurrent: false } };
      if (request.op === "activateDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: true } };
      throw new Error(`Unexpected native operation: ${String(request.op)}`);
    },
  });

  const created = await manager.create("Agent Stage");
  assert.equal(created.name, "agent-stage");
  assert.equal(created.desktopId, createdDesktop);
  assert.equal(created.anchor, null);
  assert.deepEqual(await manager.inspectStage("agent-stage"), {
    stage: created,
    desktop: { desktopId: createdDesktop, isCurrent: false },
  });
  const activated = await manager.activate("agent-stage");
  assert.equal(activated.desktop.isCurrent, true);
  assert.deepEqual(requests.map((request) => request.op), ["createDesktop", "inspectDesktop", "activateDesktop"]);
  assert.match(readFileSync(join(root, "windows-stages.json"), "utf8"), /"anchor": null/);
}));

test("owner-preview rebind detaches a stale window and follows the desktop the owner is viewing", async () => withRoot(async (root) => {
  let currentDesktop = stageDesktop;
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "inspect") return { ok: true, window: { ...anchor, desktopId: stageDesktop, onCurrentDesktop: false } };
      if (request.op === "currentDesktop") return { ok: true, desktop: { desktopId: currentDesktop, isCurrent: true } };
      if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: true } };
      throw new Error(`Unexpected native operation: ${String(request.op)}`);
    },
  });
  const original = await manager.register("preview", "4321", anchor.windowId);
  const assignment = { handle: "codex", sessionTag: "1234abcd" };
  manager.assignAgent("preview", assignment);
  currentDesktop = ownerDesktop;

  const rebound = await manager.adoptCurrentDesktop("preview");
  assert.equal(rebound.desktopId, ownerDesktop);
  assert.equal(rebound.anchor, null);
  assert.equal(rebound.roomWindowId, null);
  assert.equal(rebound.roomDesktopId, original.roomDesktopId, "opaque desktop lease identity remains stable");
  assert.deepEqual(rebound.agentAssignment, assignment);
  assert.equal(requests.some((request) => request.op === "move" || request.op === "activateDesktop" || request.op === "close"), false,
    "rebinding changes only the local mapping and never manipulates the user's desktop or window");
}));

test("owner-preview inspection uses the current desktop query and never the private desktop-list API", async () => withRoot(async (root) => {
  let currentDesktop = stageDesktop;
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "currentDesktop") return { ok: true, desktop: { desktopId: currentDesktop, isCurrent: true } };
      throw new Error(`Owner-preview must not call ${String(request.op)}`);
    },
  });
  const name = "preview-agent-0123456789abcdef01234567";
  await manager.adoptCurrentDesktop(name);
  manager.assignAgent(name, { handle: "codex", sessionTag: "1234abcd" });

  assert.deepEqual(await manager.inspectStage(name), {
    stage: manager.list()[0],
    desktop: { desktopId: stageDesktop, isCurrent: true },
  });
  currentDesktop = ownerDesktop;
  assert.deepEqual(await manager.inspectStage(name), {
    stage: manager.list()[0],
    desktop: { desktopId: stageDesktop, isCurrent: false },
  });
  assert.deepEqual(requests.map((request) => request.op), ["currentDesktop", "currentDesktop", "currentDesktop"]);
}));

test("reads v1 stage registries and writes v3 when changed", async () => withRoot(async (root) => {
  const path = join(root, "windows-stages.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    stages: [{ name: "stage", desktopId: stageDesktop, anchor: { pid: 4_321, windowId: "123" }, registeredAt: "2026-10-04T12:00:00.000Z" }],
  }), "utf8");
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {} });
  assert.equal(manager.list()[0]?.anchor?.pid, 4_321);
  manager.forget("stage");
  assert.match(readFileSync(path, "utf8"), /"version": 3/);
}));

test("re-registering a known desktop refreshes its anchor without changing its identity", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  const original = await manager.register("stage", "4321", "123");
  const refreshed = await manager.register("stage", "9876", "456");
  assert.equal(refreshed.desktopId, original.desktopId);
  assert.equal(refreshed.registeredAt, original.registeredAt);
  assert.deepEqual(refreshed.anchor, { pid: 9_876, windowId: "456" });
  assert.equal(refreshed.roomDesktopId, original.roomDesktopId);
  assert.notEqual(refreshed.roomWindowId, original.roomWindowId, "a different native window gets a fresh coordination identity");
}));

test("persists the selected app reference so a fresh manager can recover it", async () => withRoot(async (root) => {
  const deps = {
    platform: "win32" as const, root, terminal: true, env: {},
    invokeNative: async (request: Record<string, unknown>) => ({ ok: true as const, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  };
  const manager = createWindowsDesktopStageManager(deps);
  const registered = await manager.register("stage", "4321", anchor.windowId, "notepad");
  assert.equal(registered.appId, "notepad");
  const reloaded = createWindowsDesktopStageManager(deps);
  assert.equal(reloaded.list()[0]?.appId, "notepad");
  const rebound = await reloaded.register("stage", "4321", anchor.windowId);
  assert.equal(rebound.appId, "notepad", "re-registering without an app id must preserve durable recovery metadata");
}));

test("room lease keys are stable and opaque and migrate existing v2 records once", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  await manager.register("stage", "4321", anchor.windowId);
  const first = await manager.roomKeys("stage");
  const second = await manager.roomKeys("stage");
  const machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const firstKeys = formatWindowsStageRoomKeys(machineId, first.stage);
  const secondKeys = formatWindowsStageRoomKeys(machineId, second.stage);
  assert.deepEqual(secondKeys, firstKeys);
  assert.match(firstKeys.desktop, /^desktop:[0-9a-f-]{36}:[0-9a-f-]{36}$/i);
  assert.match(firstKeys.window ?? "", /^window:[0-9a-f-]{36}:[0-9a-f-]{36}$/i);
  assert.doesNotMatch(JSON.stringify(firstKeys), /4321|9223372036854775807|3ecb4a09/i);

  const path = join(root, "windows-stages.json");
  const v2 = JSON.parse(readFileSync(path, "utf8")) as { version: number; stages: Array<Record<string, unknown>> };
  v2.version = 2;
  for (const stage of v2.stages) { delete stage.roomDesktopId; delete stage.roomWindowId; }
  writeFileSync(path, JSON.stringify(v2), "utf8");
  const migrated = await manager.roomKeys("stage");
  assert.match(readFileSync(path, "utf8"), /"version"\s*:\s*3/);
  const migratedKeys = formatWindowsStageRoomKeys(machineId, migrated.stage);
  assert.deepEqual(formatWindowsStageRoomKeys(machineId, (await manager.roomKeys("stage")).stage), migratedKeys);
}));

test("moves only the exact PID/window pair to the registered desktop and verifies the destination", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "move") return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } };
      const desktopId = Number(request.pid) === anchor.pid ? stageDesktop : ownerDesktop;
      return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId), desktopId, onCurrentDesktop: true } };
    },
  });
  await manager.register("stage", "4321", anchor.windowId);
  const result = await manager.moveWindow("stage", "7777", "0x1fff");
  assert.equal(result.fromDesktopId, ownerDesktop);
  assert.equal(result.window.desktopId, stageDesktop);
  assert.deepEqual(requests.at(-1), { op: "move", pid: 7_777, windowId: "0x1fff", desktopId: stageDesktop });
}));

test("attaches only the selected live window, moves it to the stage, then records it as the anchor", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const desktopByWindow = new Map([["4321:123", stageDesktop], ["7777:999", ownerDesktop]]);
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "move") {
        desktopByWindow.set(`${request.pid}:${request.windowId}`, String(request.desktopId));
      }
      const key = `${request.pid}:${request.windowId}`;
      const desktopId = desktopByWindow.get(key);
      if (request.op === "inspect" && desktopId) {
        return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId, onCurrentDesktop: desktopId === ownerDesktop } };
      }
      if (request.op === "move" && desktopId) {
        return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId), desktopId, onCurrentDesktop: false } };
      }
      throw new Error(`Unexpected native operation: ${String(request.op)}`);
    },
  });
  await manager.register("stage", "4321", "123");
  const result = await manager.attachWindow("stage", "7777", "999");
  assert.deepEqual(result.stage.anchor, { pid: 7777, windowId: "999" });
  assert.equal(result.window.desktopId, stageDesktop);
  assert.deepEqual(requests.filter((request) => request.op === "move"), [
    { op: "move", pid: 7777, windowId: "999", desktopId: stageDesktop },
  ]);
  assert.deepEqual((await manager.inspectStage("stage")).anchor, result.window);
}));

test("requires an interactive owner terminal and rejects agent initiated stage changes", async () => withRoot(async (root) => {
  const noTerminal = createWindowsDesktopStageManager({ platform: "win32", root, terminal: false, env: {} });
  await assert.rejects(() => noTerminal.register("stage", "1", "2"), /owner at an interactive terminal/);
  const agent = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: { CODEX_THREAD_ID: "thread" } });
  await assert.rejects(() => agent.register("stage", "1", "2"), /Agents cannot create, activate, register, or move/);
  await assert.rejects(() => agent.moveWindow("stage", "1", "2"), /Agents cannot create, activate, register, or move/);
}));

test("refuses stale anchors, desktop id drift, and failed post-move verification", async () => withRoot(async (root) => {
  let anchorDesktop = stageDesktop;
  const targetDesktop = ownerDesktop;
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      if (request.op === "move") return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId), desktopId: targetDesktop } };
      const desktopId = Number(request.pid) === anchor.pid ? anchorDesktop : targetDesktop;
      return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId), desktopId } };
    },
  });
  await manager.register("stage", "4321", anchor.windowId);
  anchorDesktop = ownerDesktop;
  await assert.rejects(() => manager.inspectStage("stage"), /anchor moved to another desktop/);
  await assert.rejects(() => manager.moveWindow("stage", "7777", "999"), /did not confirm/);
  assert.equal(manager.list()[0]?.desktopId, stageDesktop, "failed live checks must not silently rewrite the saved stage");
}));

test("fails closed on a corrupt registry and forgetting removes only the local mapping", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  await manager.register("stage", "4321", anchor.windowId);
  const path = join(root, "windows-stages.json");
  const saved = readFileSync(path, "utf8");
  writeFileSync(path, "{broken", "utf8");
  assert.throws(() => manager.list(), /registry is corrupt/);
  writeFileSync(path, saved, "utf8");
  const forgotten = manager.forget("stage");
  assert.equal(forgotten.desktopId, stageDesktop);
  assert.deepEqual(manager.list(), []);
}));

test("rejects malformed process ids, handles, and stage names before native calls", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async () => { throw new Error("native helper should not be called"); },
  });
  await assert.rejects(() => manager.register("../desktop", "10", "0x10"), /Stage names/);
  await assert.rejects(() => manager.register("stage", "0", "0x10"), /PID must be a positive/);
  await assert.rejects(() => manager.register("stage", "10", "0x00"), /Window id must be a non-zero/);
}));
