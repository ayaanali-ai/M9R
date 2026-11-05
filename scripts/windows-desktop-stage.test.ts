import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createWindowsDesktopStageManager, formatWindowsStageRoomKeys } from "../src/lib/native/windows-desktop-stage";
import { DesktopInputNotDispatchedError, DesktopInputOutcomeUnknownError } from "../src/lib/native/desktop-input-errors";

const roomId = "3ecb4a09-87d4-4f8b-9fd1-48bc9d8c14ae";

test("visible window inventory keeps ordinary windows whose optional shell identities are null", async () => withRoot(async (root) => {
  const window = { pid: 456, windowId: "0x123", title: "Notepad", width: 900, height: 700,
    className: "Notepad", processName: "Notepad.exe", processPath: null, appUserModelId: null };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => request.op === "listVisibleWindows" ? { ok: true, windows: [window] } : { ok: false } });
  assert.deepEqual(await manager.listVisibleWindows(), [window],
    "native JSON nulls mean identity metadata is unavailable, not that the real app window is invalid");
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
const anchor = { pid: 4_321, windowId: "9223372036854775807" };

test("native input errors preserve whether SendInput dispatched any events", async () => withRoot(async (root) => {
  let response: Record<string, unknown> = { ok: false, dispatchState: "not-dispatched", error: "target was not foreground" };
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async () => response as never });
  await assert.rejects(() => manager.sendClick(anchor.pid, anchor.windowId, 30, 40),
    (error: unknown) => error instanceof DesktopInputNotDispatchedError && error.dispatchState === "not-dispatched");

  response = { ok: false, dispatchState: "uncertain", error: "release failed after down" };
  await assert.rejects(() => manager.sendClick(anchor.pid, anchor.windowId, 30, 40),
    (error: unknown) => error instanceof DesktopInputOutcomeUnknownError && error.dispatchState === "uncertain");

  response = { ok: false, error: "old helper omitted the dispatch state" };
  await assert.rejects(() => manager.sendClick(anchor.pid, anchor.windowId, 30, 40),
    (error: unknown) => error instanceof DesktopInputOutcomeUnknownError,
    "an old or malformed helper response cannot be misreported as proof that no input was sent");
}));

test("reused PIDs and HWNDs cannot satisfy a persisted process-generation binding", async () => withRoot(async (root) => {
  let generation = "0000000000000001";
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async () => ({ ok: true, window: { ...anchor, processGeneration: generation } }) });
  await manager.register("generation-test", String(anchor.pid), anchor.windowId);
  assert.equal(manager.list()[0]?.anchor?.processGeneration, generation);
  await manager.inspectStage("generation-test");
  generation = "0000000000000002";
  await assert.rejects(manager.inspectStage("generation-test"), /process generation changed/);
}));

test("a window saved before generations existed is bound on its next inspection, then protected like any other", async () => withRoot(async (root) => {
  let generation: string | undefined;
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async () => ({ ok: true, window: { ...anchor, ...(generation ? { processGeneration: generation } : {}) } }) });
  await manager.register("legacy-test", String(anchor.pid), anchor.windowId);
  assert.equal(manager.list()[0]?.anchor?.processGeneration, undefined, "an older build saved no generation");
  generation = "0000000000000001";
  await manager.inspectStage("legacy-test");
  assert.equal(manager.list()[0]?.anchor?.processGeneration, generation, "the same live process and handle bind the generation");
  generation = "0000000000000002";
  await assert.rejects(manager.inspectStage("legacy-test"), /process generation changed/);
}));

test("one replacement resolver requires the same creation time and one exact candidate", async () => withRoot(async (root) => {
  let generation = "0000000000000001";
  let candidateIds = ["1234"];
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {}, invokeNative: async (request) => {
    if (request.op === "processGeneration") return { ok: true, processGeneration: generation };
    if (request.op === "listOwnedWindows") return { ok: true, windows: candidateIds.map((windowId) => ({ pid: anchor.pid, windowId, title: "Same title", width: 800, height: 600 })) };
    return { ok: true, window: { ...anchor, windowId: String(request.windowId), processGeneration: generation } };
  } });
  await manager.register("generation-test", String(anchor.pid), anchor.windowId);
  assert.equal((await manager.resolveWindowReplacement("generation-test"))?.windowId, "1234");
  assert.equal(manager.list()[0]?.anchor?.windowId, anchor.windowId, "resolution never silently changes the binding");
  candidateIds = ["1234", "5678"];
  assert.equal(await manager.resolveWindowReplacement("generation-test"), undefined, "titles cannot disambiguate identity");
  candidateIds = ["1234"];
  generation = "0000000000000002";
  assert.equal(await manager.resolveWindowReplacement("generation-test"), undefined);
}));

test("owned launch discovery accepts windows only from the exact child process", async () => withRoot(async (root) => {
  let wrongProcess = false;
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
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

function withRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const fixtureRoot = resolve(process.cwd(), ".workcache", "native-test-fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, "m9r-windows-stage-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("registers a machine-local stage from an exact HWND and persists opaque coordination identities", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  const registered = await manager.register("My Stage", "4321", anchor.windowId);
  assert.equal(registered.name, "my-stage");
  assert.deepEqual(registered.anchor, { pid: 4_321, windowId: anchor.windowId });
  assert.deepEqual(manager.list(), [registered]);
  assert.match(readFileSync(join(root, "windows-stages.json"), "utf8"), /"version": 6/);
  assert.match(registered.roomDesktopId, /^[0-9a-f-]{36}$/i);
  assert.match(registered.roomWindowId ?? "", /^[0-9a-f-]{36}$/i);
}));

test("a full registry drops only owner-preview stages whose window process has exited", async () => withRoot(async (root) => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const stages = [
    ...Array.from({ length: 13 }, (_, i) => ({ name: `preview-agent-dead${i}`, desktopId: roomId, roomDesktopId: uuid(i), returnToDesktopId: null,
      anchor: { pid: 9_000 + i, windowId: String(100 + i) }, roomWindowId: uuid(100 + i), registeredAt: "2026-10-26T08:00:00.000Z" })),
    { name: "preview-agent-live", desktopId: roomId, roomDesktopId: uuid(50), returnToDesktopId: null,
      anchor: { pid: 7_777, windowId: "777" }, roomWindowId: uuid(150), registeredAt: "2026-10-27T08:00:00.000Z" },
    { name: "agent-legacy-desktop-fields", desktopId: "4fc4701b-6c3e-46d1-bba1-e99d993a28a2", roomDesktopId: uuid(51), returnToDesktopId: "c0999999-87d4-4f8b-9fd1-48bc9d8c14ae",
      anchor: { pid: 9_500, windowId: "950" }, roomWindowId: uuid(151), registeredAt: "2026-10-27T08:00:00.000Z" },
    { name: "agent-no-anchor", desktopId: roomId, roomDesktopId: uuid(52), returnToDesktopId: null,
      anchor: null, roomWindowId: null, registeredAt: "2026-10-27T08:00:00.000Z" },
  ];
  assert.equal(stages.length, 16);
  writeFileSync(join(root, "windows-stages.json"), JSON.stringify({ version: 3, stages }));
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-30T12:00:00Z"),
    processAlive: (pid) => pid === 7_777 || pid === 4_321,
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  await manager.register("preview-agent-new", "4321", anchor.windowId);
  assert.deepEqual(manager.list().map((stage) => stage.name).sort(),
    ["agent-legacy-desktop-fields", "agent-no-anchor", "preview-agent-live", "preview-agent-new"]);
  assert.doesNotMatch(readFileSync(join(root, "windows-stages.json"), "utf8"), /returnToDesktopId/,
    "legacy Windows desktop routing metadata is discarded when the registry is rewritten");
}));

test("a session registry can grow past sixteen entries without refusing a new stage", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-30T12:00:00Z"),
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  for (let index = 0; index < 16; index++) await manager.ensureStage(`preview-agent-stage-${index}`);

  await manager.register("new-session-stage", String(anchor.pid), anchor.windowId);

  assert.equal(manager.list().length, 17);
  assert.ok(manager.list().some((stage) => stage.name === "new-session-stage"));
}));

test("stage compaction reclaims dormant empty preview entries but preserves active work and reusable windows", async () => withRoot(async (root) => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const emptyPreview = (name: string, taskId?: string) => ({ name, roomDesktopId: uuid(name.length + 1), anchor: null, roomWindowId: null,
    ...(taskId ? { agentAssignment: { handle: "codex", sessionTag: "1234abcd", taskId } } : {}), registeredAt: "2026-10-30T10:00:00.000Z" });
  const anchoredPreview = (name: string, pid: number, taskId?: string) => ({ name, roomDesktopId: uuid(name.length + 2),
    anchor: { pid, windowId: String(pid) }, roomWindowId: uuid(name.length + 100),
    ...(taskId ? { agentAssignment: { handle: "codex", sessionTag: "1234abcd", taskId } } : {}),
    registeredAt: "2026-10-30T10:00:00.000Z" });
  writeFileSync(join(root, "windows-stages.json"), JSON.stringify({ version: 6, stages: [
    emptyPreview("preview-agent-empty"),
    emptyPreview("preview-agent-finished", "finished-task"),
    emptyPreview("preview-agent-active", "active-task"),
    anchoredPreview("preview-agent-live-window", 7_777),
    anchoredPreview("preview-agent-dead-window", 9_000),
    anchoredPreview("preview-agent-active-dead-window", 9_001, "active-task"),
    { name: "manual-empty-stage", roomDesktopId: uuid(999), anchor: null, roomWindowId: null, registeredAt: "2026-10-30T10:00:00.000Z" },
  ] }), "utf8");
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-30T12:00:00Z"),
    processAlive: (pid) => pid === 7_777 || pid === anchor.pid,
    taskActive: (taskId) => taskId === "active-task",
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });

  await manager.ensureStage("preview-agent-new-session");

  const names = manager.list().map((stage) => stage.name).sort();
  assert.deepEqual(names, ["manual-empty-stage", "preview-agent-active", "preview-agent-active-dead-window", "preview-agent-live-window", "preview-agent-new-session"]);
}));

test("creates an owner-visible stage as local metadata without issuing native window operations", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => { requests.push(request); return { ok: false, error: "No native operation is expected for a local stage mapping." }; },
  });

  const created = await manager.create("Agent Stage");
  assert.equal(created.name, "agent-stage");
  assert.equal(created.anchor, null);
  assert.deepEqual(await manager.inspectStage("agent-stage"), { stage: created });
  assert.deepEqual(requests, []);
  assert.match(readFileSync(join(root, "windows-stages.json"), "utf8"), /"anchor": null/);
}));

test("legacy Windows desktop metadata is ignored when validating an exact live HWND", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "inspect") return { ok: true, window: { ...anchor, desktopId: "legacy-other-desktop", onCurrentDesktop: false } };
      throw new Error(`Unexpected native operation: ${String(request.op)}`);
    },
  });
  await manager.register("preview", "4321", anchor.windowId);
  const inspected = await manager.inspectStage("preview");
  assert.equal(inspected.anchor?.pid, anchor.pid);
  assert.equal(inspected.anchor?.windowId, anchor.windowId);
  assert.deepEqual(Object.keys(inspected.anchor ?? {}).sort(), ["pid", "windowId"]);
  assert.deepEqual(requests.map((request) => request.op), ["inspect", "inspect"]);
}));

test("stage inspection is local metadata and does not ask about Windows desktop identity", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      throw new Error(`Owner-preview must not call ${String(request.op)}`);
    },
  });
  const name = "preview-agent-0123456789abcdef01234567";
  await manager.ensureStage(name);
  manager.assignAgent(name, { handle: "codex", sessionTag: "1234abcd" });
  assert.deepEqual(await manager.inspectStage(name), { stage: manager.list()[0] });
  assert.deepEqual(requests, []);
}));

test("reads old stage registries, drops OS desktop fields, and writes v6 when changed", async () => withRoot(async (root) => {
  const path = join(root, "windows-stages.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    stages: [{ name: "stage", desktopId: roomId, returnToDesktopId: roomId, anchor: { pid: 4_321, windowId: "123" }, registeredAt: "2026-10-04T12:00:00.000Z" }],
  }), "utf8");
  const manager = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: {} });
  assert.equal(manager.list()[0]?.anchor?.pid, 4_321);
  manager.forget("stage");
  const migrated = readFileSync(path, "utf8");
  assert.match(migrated, /"version": 6/);
  assert.doesNotMatch(migrated, /returnToDesktopId|"desktopId"/);
}));

test("re-registering a known stage refreshes its anchor without changing its coordination identity", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {}, now: () => new Date("2026-10-04T12:00:00Z"),
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } }),
  });
  const original = await manager.register("stage", "4321", "123");
  const refreshed = await manager.register("stage", "9876", "456");
  assert.equal(refreshed.registeredAt, original.registeredAt);
  assert.deepEqual(refreshed.anchor, { pid: 9_876, windowId: "456" });
  assert.equal(refreshed.roomDesktopId, original.roomDesktopId);
  assert.notEqual(refreshed.roomWindowId, original.roomWindowId, "a different native window gets a fresh coordination identity");
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
  assert.match(readFileSync(path, "utf8"), /"version"\s*:\s*6/);
  const migratedKeys = formatWindowsStageRoomKeys(machineId, migrated.stage);
  assert.deepEqual(formatWindowsStageRoomKeys(machineId, (await manager.roomKeys("stage")).stage), migratedKeys);
}));

test("attaches only the selected live window without issuing an OS desktop move", async () => withRoot(async (root) => {
  const requests: Record<string, unknown>[] = [];
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => {
      requests.push(request);
      if (request.op === "inspect") return { ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId) } };
      throw new Error(`Unexpected native operation: ${String(request.op)}`);
    },
  });
  await manager.register("stage", "4321", "123");
  const result = await manager.attachWindow("stage", "7777", "999");
  assert.deepEqual(result.stage.anchor, { pid: 7777, windowId: "999" });
  assert.equal("desktopId" in result.window, false);
  assert.equal(requests.some((request) => /^(?:currentDesktop|createDesktop|inspectDesktop|activateDesktop|moveWindowToDesktop)$/.test(String(request.op))), false);
  assert.deepEqual((await manager.inspectStage("stage")).anchor, result.window);
}));

test("requires an interactive owner terminal and rejects agent initiated stage changes", async () => withRoot(async (root) => {
  const noTerminal = createWindowsDesktopStageManager({ platform: "win32", root, terminal: false, env: {} });
  await assert.rejects(() => noTerminal.register("stage", "1", "2"), /owner at an interactive terminal/);
  const agent = createWindowsDesktopStageManager({ platform: "win32", root, terminal: true, env: { CODEX_THREAD_ID: "thread" } });
  await assert.rejects(() => agent.register("stage", "1", "2"), /Agents cannot change owner desktop-stage bindings/);
}));

test("legacy off-desktop status cannot stale an exact PID and HWND binding", async () => withRoot(async (root) => {
  const manager = createWindowsDesktopStageManager({
    platform: "win32", root, terminal: true, env: {},
    invokeNative: async (request) => ({ ok: true, window: { ...anchor, pid: Number(request.pid), windowId: String(request.windowId), desktopId: "legacy-other-desktop", onCurrentDesktop: false } }),
  });
  await manager.register("stage", "4321", anchor.windowId);
  assert.equal((await manager.inspectStage("stage")).anchor?.windowId, anchor.windowId);
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
  assert.equal(forgotten.name, "stage");
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
