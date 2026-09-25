import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseHolders, windowsFileHolders } from "../src/lib/native/codex-liveness";

test("holder output becomes live, free or unknown, and anything unclear is never called free", () => {
  const files = ["C:/a.jsonl", "C:/b.jsonl", "C:/c.jsonl", "C:/d.jsonl"];
  const out = ["C:/a.jsonl\t1234:codex.exe;", "C:/b.jsonl\t", "C:/c.jsonl\tERR", "garbage line", ""].join("\n");
  assert.deepEqual(parseHolders(out, files), { "C:/a.jsonl": "live", "C:/b.jsonl": "free", "C:/c.jsonl": "unknown", "C:/d.jsonl": "unknown" });
});

test("on Windows a file another process holds open is live and an unopened one is free (Restart Manager, no exclusive open)", { skip: process.platform !== "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "m9r-rm-"));
  const held = join(dir, "held.jsonl");
  const idle = join(dir, "idle.jsonl");
  writeFileSync(held, "x");
  writeFileSync(idle, "x");
  // Restart Manager reports resources with an incompatible sharing mode. Node's
  // default Windows open permits read/write/delete sharing, so it isn't a useful
  // fixture for a process that is meant to hold the file against a writer.
  const quotedHeld = held.replaceAll("'", "''");
  const holdFile = `$stream = [System.IO.File]::Open('${quotedHeld}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read); [Console]::Out.WriteLine('ready'); Start-Sleep -Seconds 60`;
  const holder = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", holdFile], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  try {
    await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
    if ((await windowsFileHolders([idle]))[idle] === "unknown") {
      t.skip("Restart Manager is unavailable in this restricted Windows environment");
      return;
    }
    const verdicts = await windowsFileHolders([held, idle, join(dir, "missing.jsonl")]);
    assert.equal(verdicts[held], "live");
    assert.equal(verdicts[idle], "free");
    assert.notEqual(verdicts[join(dir, "missing.jsonl")], "live");
  } finally {
    holder.kill();
    await new Promise<void>((resolve) => holder.once("close", () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
