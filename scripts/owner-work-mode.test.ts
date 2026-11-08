import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createOwnerWorkPolicy, readOwnerWorkMode, setOwnerWorkMode } from "../src/lib/native/owner-work-mode";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { createWebUiBridge } from "../src/lib/native/web-ui-bridge";
import { startWebBroker } from "../src/lib/native/web-broker-server";
import { requestOwnerPipe } from "../src/lib/native/owner-pipe";
import { ownerPipePath } from "../src/lib/native/web-broker-paths";
import { createDesktopTransport } from "../pill/src/shells/desktop";
import { fromUiState } from "../pill/src/shells/convert";
import { createWebBroker } from "../src/lib/native/web-broker-core";
import { createWebAuthority } from "../src/lib/native/web-authority-core";
import { createTaskDesktopStageService } from "../src/lib/native/task-desktop-stage";
import { createLocalStore } from "../src/lib/native/local-store";
import type { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { runNativeCommand } from "../src/lib/native/native-commands";

test("safe default, scoped approvals and Agents Free guard the actual native foreground boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-work-policy-"));
  let accepted = false; const approvals: string[] = []; const dispatched: string[] = [];
  const policy = createOwnerWorkPolicy(root, () => ({ requestApproval: async request => { approvals.push(`${request.agent}:${request.sessionId}`); return accepted; } }));
  const manager = createWindowsDesktopStageManager({ root, platform: "win32", terminal: true, env: {},
    invokeNative: async request => { dispatched.push(String(request.op)); return { ok: true, input: { childWindowId: "456" }, foregroundWindow: { pid: 123, windowId: "456" } }; } });
  const turn = (taskId: string, operation: () => Promise<unknown>) => policy.run({ agent: "codex", provider: "codex", sessionId: "one", taskId,
    signal: new AbortController().signal }, () => manager.withForegroundAuthorization(policy.authorize, operation));
  try {
    assert.equal(readOwnerWorkMode(root), "working");
    await assert.rejects(manager.sendText(123, "456", "unscoped"), /owner-authorized task turn/);
    assert.equal(dispatched.length, 0);
    assert.deepEqual(await manager.foregroundWindow(123, "456"), { pid: 123, windowId: "456" }, "foreground verification only reads state and needs no turn");
    dispatched.length = 0;
    await turn("T1", () => manager.sendTextToWindow(123, "456", "headless"));
    assert.deepEqual(dispatched, ["sendTextToWindow"]); assert.equal(approvals.length, 0);
    await assert.rejects(turn("T1", () => manager.sendText(123, "456", "blocked")), /waiting for owner approval/);
    assert.deepEqual(dispatched, ["sendTextToWindow"]);
    accepted = true;
    await turn("T1", async () => {
      await manager.sendText(123, "456", "approved");
      await manager.sendKeyCombo(123, "456", ["ENTER"]);
      await manager.restoreOwnerCursorPosition(10, 20);
      assert.equal(approvals.length, 2, "one approval authorizes this turn and exact target plus necessary restore");
      await manager.sendText(123, "789", "other target");
      assert.equal(approvals.length, 3, "another target asks again");
      setOwnerWorkMode(root, "agents-free"); setOwnerWorkMode(root, "working");
      await manager.sendText(123, "456", "renewed approval");
      assert.equal(approvals.length, 4, "returning to Working invalidates a grant even inside the same operation");
    });
    await turn("T2", () => manager.sendText(123, "456", "next task"));
    assert.equal(approvals.length, 5, "a grant never leaks to the next task/operation");
    setOwnerWorkMode(root, "agents-free"); accepted = false;
    await turn("T3", () => manager.sendText(123, "456", "legacy path"));
    assert.equal(approvals.length, 5);
    writeFileSync(join(root, "owner-work-mode.json"), '{"version":1,"mode":"invalid"}');
    const count = dispatched.length;
    await assert.rejects(turn("T4", () => manager.sendText(123, "456", "invalid preference")), /preference is invalid/);
    assert.equal(dispatched.length, count);
  } finally { manager.close(); rmSync(root, { recursive: true, force: true }); }
});

test("foreground denial, timeout and cancellation remove the real broker approval and dispatch nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-work-wait-"));
  const broker = createWebBroker({ send: () => true, authority: createWebAuthority({ ownerId: "owner" }) });
  const policy = createOwnerWorkPolicy(root, () => ({ requestApproval: request => broker.requestStageApproval({ ...request, timeoutMs: 1_000 }) }));
  let sent = 0;
  const run = (signal = new AbortController().signal) => policy.run({ agent: "codex", provider: "codex", sessionId: "s1", taskId: "T1", signal }, async () => {
    await policy.authorize({ op: "sendText", pid: 1, windowId: "2" }); sent++;
  });
  try {
    const denied = run(); assert.equal(broker.pendingApprovals().length, 1);
    broker.decideApproval(broker.pendingApprovals()[0]!.id, "deny");
    await assert.rejects(denied, /waiting for owner approval/); assert.equal(sent, 0);
    await assert.rejects(run(), /waiting for owner approval/); assert.equal(sent, 0); assert.equal(broker.pendingApprovals().length, 0);
    const canceled = new AbortController(); const canceledTurn = run(canceled.signal);
    canceled.abort(new Error("owner stopped"));
    await assert.rejects(canceledTurn, /owner stopped/); assert.equal(sent, 0); assert.equal(broker.pendingApprovals().length, 0);
    const freeTurn = run(); assert.equal(broker.pendingApprovals().length, 1);
    setOwnerWorkMode(root, "agents-free"); await freeTurn;
    assert.equal(sent, 1); assert.equal(broker.pendingApprovals().length, 0, "switching to Agents Free releases and removes the waiting prompt");
  } finally { broker.stopAll("owner"); rmSync(root, { recursive: true, force: true }); }
});

test("task service gates focus and new-process launch while semantic observation remains available", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-work-stage-"));
  const store = createLocalStore(root); const identity = store.issueIdentity("codex", "codex", "s1");
  const task = store.addTask({ from: "you", to: "codex", targetSession: "s1", goal: "Use the app", origin: "human_typed", idempotencyKey: "one" }).task;
  const calls: string[] = []; let accepted = false; let promptCount = 0;
  let revokeAfterSpawn = false; let launchRevoked = false;
  const marker = join(root, "test-owned-launch.pid");
  const launched = () => existsSync(marker) ? Number(readFileSync(marker, "utf8")) : undefined;
  const manager = createWindowsDesktopStageManager({ root, terminal: true, platform: "win32", env: {}, invokeNative: async request => {
    calls.push(String(request.op));
    if (request.op === "inspect" || request.op === "presentOwnerWindow") return { ok: true, window: { pid: Number(request.pid), windowId: String(request.windowId) } };
    if (request.op === "listVisibleWindows") {
      if (revokeAfterSpawn && launched() && !launchRevoked) { launchRevoked = true; setOwnerWorkMode(root, "working"); accepted = false; }
      return { ok: true, windows: launched() ? [{ pid: launched()!, windowId: "789", title: "Disposable launcher fixture",
        appName: basename(process.execPath), processName: basename(process.execPath), processPath: process.execPath, width: 500, height: 400 }] : [] };
    }
    if (request.op === "windowStatus") return { ok: true, windowState: "visible" };
    return { ok: true };
  } });
  const capture = { dataUrl: "data:image/png;base64,eA==", width: 1, height: 1, capturedAt: new Date().toISOString() };
  const driver = { showAgentCursor: async () => {}, closeAgentCursor: async () => {}, shutdown: async () => {},
    capture: async () => capture, focusWindow: async (name: string) => { const anchor = (await manager.inspectStage(name)).anchor!;
      await manager.bringToForeground(anchor.pid, anchor.windowId); return { capture, outcome: { status: "unverified" } }; },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const service = createTaskDesktopStageService({ store, manager, driver, stage: { env: {}, platform: "win32" },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }), approvals: () => ({ requestApproval: async () => { promptCount++; return accepted; } }),
    resolveStageAppForTest: () => ({ executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},1500)`] }) });
  try {
    const prepared = await service.prepare(identity.token, task.id);
    await manager.register(prepared.name, "123", "456");
    await service.act(identity.token, task.id, { kind: "capture", view: "app" });
    await assert.rejects(service.act(identity.token, task.id, { kind: "focus", view: "app" }), /waiting for owner approval/);
    assert.equal(calls.includes("bringToForeground"), false);
    await assert.rejects(service.launch(identity.token, task.id, "fixture", "owner-preview", "scoped-launch"), /waiting for owner approval/);
    assert.equal(existsSync(marker), false, "denial happens before starting even the disposable child");
    assert.equal(calls.includes("bringToForeground"), false);
    accepted = true;
    await service.act(identity.token, task.id, { kind: "focus", view: "app" });
    assert.equal(calls.filter(op => op === "bringToForeground").length, 1);
    const beforeLaunch = promptCount;
    const approved = await service.launch(identity.token, task.id, "fixture", "owner-preview", "scoped-launch");
    assert.equal(approved.running, true); assert.ok(launched());
    assert.equal(promptCount - beforeLaunch, 1, "one launch approval covers only the exact system-resolved new HWND and its initial focus");
    await delay(1700); rmSync(marker, { force: true });
    await service.closeApp(identity.token, task.id);
    accepted = false; setOwnerWorkMode(root, "agents-free");
    const beforeFree = promptCount;
    const free = await service.launch(identity.token, task.id, "fixture");
    assert.equal(free.running, true); assert.ok(launched(), "Agents Free preserves the existing new-process launch path");
    assert.equal(promptCount, beforeFree);
    await delay(1700); rmSync(marker, { force: true }); await service.closeApp(identity.token, task.id);
    setOwnerWorkMode(root, "working"); accepted = true; revokeAfterSpawn = true;
    await assert.rejects(service.launch(identity.token, task.id, "fixture", "owner-preview", "post-spawn-denial"), /launch outcome is uncertain/);
    assert.ok(launchRevoked && launched(), "the refusal happened after a real disposable process was launched");
    const replay = await service.launch(identity.token, task.id, "fixture", "owner-preview", "post-spawn-denial");
    assert.equal(replay.operationReceipt?.status, "uncertain", "a post-spawn refusal cannot release its receipt and permit duplicate launch");
    assert.equal(replay.actionExecuted, false);
  } finally {
    const pid = launched(); if (pid) { try { process.kill(pid); } catch { /* test child already exited */ } }
    await service.close(); manager.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("owner pill mode transport is authenticated, persisted and reflected after a new bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-work-ui-"));
  const key = randomBytes(32).toString("hex");
  const ui = createWebUiBridge({ ownerWorkMode: () => readOwnerWorkMode(root), setOwnerWorkMode: mode => setOwnerWorkMode(root, mode) });
  const broker = await startWebBroker({ key, port: 0, ownerPipePath: ownerPipePath(root), ui });
  try {
    const desktop = createDesktopTransport(async (command, args) => {
      assert.equal(command, "set_owner_work_mode");
      const errors: string[] = [];
      const code = await runNativeCommand("pill-work-mode", [String(args?.mode)], { homeDir: root, env: { M9R_HOME: root }, out: () => {}, err: text => errors.push(text) });
      assert.equal(code, 0, errors.join("\n")); return "updated";
    });
    assert.equal(ui.snapshot().ownerWorkMode, "working");
    const unauthorized = await fetch(`http://127.0.0.1:${broker.port}/web/ui/work-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "agents-free" }) });
    assert.equal(unauthorized.status, 401);
    const keyed = await fetch(`http://127.0.0.1:${broker.port}/web/ui/work-mode`, { method: "POST", headers: { "content-type": "application/json", "x-m9r-key": key }, body: JSON.stringify({ mode: "agents-free" }) });
    assert.ok(keyed.status >= 400, "agent HTTP credentials cannot mutate the owner preference");
    assert.equal(readOwnerWorkMode(root), "working");
    await desktop.setOwnerWorkMode!("agents-free");
    assert.equal(readOwnerWorkMode(root), "agents-free");
    const restarted = createWebUiBridge({ ownerWorkMode: () => readOwnerWorkMode(root) });
    assert.equal(fromUiState(restarted.snapshot()).ownerWorkMode, "agents-free");
    const invalid = await requestOwnerPipe<{ ok?: boolean }>(ownerPipePath(root), { method: "POST", path: "/web/ui/work-mode", body: { mode: "working", extra: true } });
    assert.equal(invalid?.ok, false); assert.equal(readOwnerWorkMode(root), "agents-free");
    await desktop.setOwnerWorkMode!("working");
    assert.equal(readOwnerWorkMode(root), "working");
    assert.equal(await runNativeCommand("pill-work-mode", ["agents-free"], { homeDir: root, env: { M9R_HOME: root, CODEX_THREAD_ID: "agent" }, out: () => {}, err: () => {} }), 1);
    assert.equal(readOwnerWorkMode(root), "working");
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});
