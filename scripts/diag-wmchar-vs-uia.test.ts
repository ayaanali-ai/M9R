import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService } from "../src/lib/native/task-desktop-stage";
import { createWindowsDesktopStageManager } from "../src/lib/native/windows-desktop-stage";
import { setOwnerWorkMode } from "../src/lib/native/owner-work-mode";

const NATIVE_HOST = join(process.cwd(), "native-input-host", "target", "debug", "m9r-native-input-host.exe");

test("diag: WM_CHAR typing + REAL Ctrl+W + REAL Enter", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-diag-"));
  const workDir = mkdtempSync(join(tmpdir(), "m9r-diag-save-"));
  const savePath = join(workDir, "diag-output.txt");
  writeFileSync(savePath, "");
  const store = createLocalStore(root);
  setOwnerWorkMode(root, "agents-free"); // this explicitly owner-run diagnostic intentionally uses real foreground
  const manager = createWindowsDesktopStageManager({ nativeHostPath: NATIVE_HOST, root, terminal: true, env: {} });
  const driver = createCuaStageDriver({ manager });
  const service = createTaskDesktopStageService({
    store, manager, driver, stage: { env: {} },
    readPolicy: () => ({ handles: ["codex"], controlHandles: ["codex"] }),
    resolveStageAppForTest: () => ({ executable: "C:\\Windows\\explorer.exe", args: [savePath], windowExecutable: "Notepad.exe" }),
  });
  const identity = store.issueIdentity("codex", "codex", "session-diag");
  const task = store.addTask({ from: "you", to: "codex", goal: "diag", origin: "human_typed", idempotencyKey: "diag-a", targetSession: "session-diag" }).task;
  try {
    const launched = await service.launch(identity.token, task.id, "test-window", "background");
    const stageName = launched.name!;
    await service.act(identity.token, task.id, { kind: "type", text: "wmchar then real save" }, "background");
    const anchor = manager.list().find((s) => s.name === stageName)?.anchor;
    assert.ok(anchor);
    await manager.withForegroundAuthorization(async () => {}, () => manager.bringToForeground(anchor!.pid, anchor!.windowId));
    for (let i = 0; i < 20; i++) {
      const cur = await manager.currentForegroundWindow();
      if (cur.pid === anchor!.pid && cur.windowId.toLowerCase() === anchor!.windowId.toLowerCase()) break;
      await delay(100);
    }
    // Real SendInput Ctrl+W and real Enter -- the exact same mechanism
    // confirmed by hand to work, isolating whether WM_CHAR typing survives
    // through to a genuinely real save.
    await manager.withForegroundAuthorization(async () => {}, () => manager.sendKeyCombo(anchor!.pid, anchor!.windowId, ["ctrl", "w"]));
    await delay(800);
    await manager.withForegroundAuthorization(async () => {}, () => manager.sendKeyCombo(anchor!.pid, anchor!.windowId, ["enter"]));
    await delay(1000);
    const content = readFileSync(savePath, "utf8");
    console.log(`[diag] disk content after WM_CHAR type + real Ctrl+W + real Enter: ${JSON.stringify(content)}`);
  } finally {
    try { await service.closeApp(identity.token, task.id, "background"); } catch { /* best-effort */ }
    await service.close();
    manager.close?.();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
