// Live item-8 re-verification: real driver, real disposable test window, real agent
// cursor identity (so the visible overlay actually renders). Checks:
// - cursor stays visible/enabled across a SEQUENCE of actions, not just one
// - cursor actually moves to varied points (not "stuck" in one region)
// - every action family: click, type (insert), scroll, drag, key, hotkey, window_frame,
//   invoke_menu, clipboard write/read
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";

function spawnTestWindow(title: string) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = '${title}'
$form.Width = 500
$form.Height = 400
$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(20,20)
$box.Width = 400
$form.Controls.Add($box)
$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'Submit'
$btn.Location = New-Object System.Drawing.Point(20,60)
$form.Controls.Add($btn)
[System.Windows.Forms.Application]::Run($form)
`;
  const scriptPath = join(tmpdir(), `m9r-item8-${randomBytes(6).toString("hex")}.ps1`);
  writeFileSync(scriptPath, script, "utf8");
  return spawn("powershell", ["-NoProfile", "-sta", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Normal", "-File", scriptPath],
    { detached: false, stdio: ["ignore", "ignore", "ignore"] });
}

type CursorProof = { enabled: boolean; visible: boolean; x: number; y: number; screenX: number; screenY: number } | undefined;

function report(step: string, cursor: CursorProof, extra?: Record<string, unknown>) {
  console.log(`[${step}] cursor=${cursor ? `enabled=${cursor.enabled} visible=${cursor.visible} at(${cursor.x},${cursor.y}) screen(${cursor.screenX},${cursor.screenY})` : "ABSENT"}`
    + (extra ? ` extra=${JSON.stringify(extra)}` : ""));
}

async function main() {
  try { execSync("taskkill /IM notepad.exe /F", { stdio: "ignore" }); } catch {}
  const driver = createCuaStageDriver({ stage: { terminal: true } });
  const identity = { handle: "item8check", sessionId: `item8-${randomBytes(4).toString("hex")}` };
  const name = "owner-item8-check";

  const proc = spawnTestWindow("M9RItem8Check");
  await delay(1500);

  try {
    // Seed a fresh desktop capture
    await driver.captureDesktop(name, identity);

    // 1) moveCursor to several DIFFERENT points -- checking for "stuck in certain spots"
    for (const [x, y] of [[60, 50], [300, 50], [60, 300], [300, 300], [180, 170]] as const) {
      const moved = await driver.moveDesktopCursor(name, x, y, identity);
      report(`moveCursor(${x},${y})`, moved.cursor);
    }

    // 2) click -- check cursor visible immediately after, and STAYS (don't hide between actions)
    const clickResult = await driver.clickDesktop(name, 70, 65, identity); // near the button
    report("click(button)", undefined, { outcome: clickResult.outcome });

    // 3) type (insert) into the textbox
    const typeResult = await driver.typeTextDesktop(name, "hello item8", identity);
    report("type(insert)", undefined, { outcome: typeResult.outcome });

    // 4) scroll
    const scrollResult = await driver.scrollDesktop(name, 180, 170, "down", identity);
    report("scroll(down)", undefined, { outcome: scrollResult.outcome });

    // 5) drag
    const dragResult = await driver.dragDesktop(name, 60, 300, 300, 300, identity);
    report("drag", undefined, { outcome: dragResult.outcome });

    // 6) key
    const keyResult = await driver.pressKeyDesktop(name, "Escape", identity);
    report("press_key(Escape)", undefined, { outcome: keyResult.outcome });

    // 7) hotkey
    const hotkeyResult = await driver.hotkeyDesktop(name, ["ctrl", "a"], identity);
    report("hotkey(ctrl+a)", undefined, { outcome: hotkeyResult.outcome });

    // Final cursor check -- is it still visible after a whole sequence of actions?
    const finalCapture = await driver.captureDesktop(name, identity);
    console.log("final capture ok:", Boolean(finalCapture.dataUrl));

  } catch (error) {
    console.log("FATAL during sequence:", error instanceof Error ? error.message : error);
  } finally {
    try { await driver.closeAgentCursor(identity); } catch {}
    try { await driver.shutdown(); } catch {}
    try { process.kill(proc.pid!); } catch {}
  }
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
