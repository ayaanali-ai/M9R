import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseHolders, windowsFileHolders } from "../src/lib/native/codex-liveness";

test("holder output becomes live, free or unknown, and anything unclear is never called free", () => {
  const files = ["C:/a.jsonl", "C:/b.jsonl", "C:/c.jsonl", "C:/d.jsonl"];
  const out = ["C:/a.jsonl\t1234:codex.exe;", "C:/b.jsonl\t", "C:/c.jsonl\tERR", "garbage line", ""].join("\n");
  assert.deepEqual(parseHolders(out, files), { "C:/a.jsonl": "live", "C:/b.jsonl": "free", "C:/c.jsonl": "unknown", "C:/d.jsonl": "unknown" });
});

test("on Windows a file another process holds open is live and an unopened one is free (Restart Manager, no exclusive open)", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "m9r-rm-"));
  const held = join(dir, "held.jsonl");
  const idle = join(dir, "idle.jsonl");
  writeFileSync(held, "x");
  writeFileSync(idle, "x");
  const holder = spawn(process.execPath, ["-e", `const fs=require("fs"); fs.openSync(${JSON.stringify(held)}, "r+"); console.log("ready"); setTimeout(()=>{}, 60000)`], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
    const verdicts = await windowsFileHolders([held, idle, join(dir, "missing.jsonl")]);
    assert.equal(verdicts[held], "live");
    assert.equal(verdicts[idle], "free");
    assert.notEqual(verdicts[join(dir, "missing.jsonl")], "live");
  } finally {
    holder.kill();
  }
});
