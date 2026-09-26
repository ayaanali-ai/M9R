import { spawn as ptySpawn } from "node-pty";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const project = "C:/RunLeak/runleak/.n3-proof/speed";
const codexJs = join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/.test(k)) delete env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENTER = String.fromCharCode(13);
const created = spawnSync(process.execPath, [codexJs, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-C", project, "-"], { env, input: "Reply with only: ready", encoding: "utf8", timeout: 240000 });
const id = /session id: ([0-9a-f-]{36})/i.exec(`${created.stdout}${created.stderr}`)?.[1];
console.log("thread", id);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(`${id}.jsonl`) ? [join(d, e.name)] : []));
const file = walk(join(homedir(), ".codex", "sessions"))[0];
const lines = () => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let screen = "";
const term = ptySpawn(process.execPath, [codexJs, "resume", id, "-C", project], { name: "xterm-256color", cols: 110, rows: 30, cwd: project, env });
term.onData((d) => { screen += d; });
await sleep(14000);
if (/Update available/.test(screen)) { term.write("2"); await sleep(400); term.write(ENTER); }
await sleep(8000);
for (let n = 1; n <= 4; n++) {
  const marker = `lag${n}x${Date.now()}`;
  const t0 = Date.now();
  const q = spawnSync(process.execPath, [codexJs, "queue", "--thread", id, "--message", `Reply with only the word: ${marker}`], { env, encoding: "utf8" });
  const tq = Date.now() - t0;
  let seen = 0, done = 0;
  while (Date.now() - t0 < 90000 && !done) {
    const ls = lines(); const i = ls.findIndex((r) => r.type === "response_item" && r.payload?.role === "user" && JSON.stringify(r.payload.content).includes(marker));
    if (i >= 0 && !seen) seen = Date.now() - t0;
    if (i >= 0 && ls.slice(i).some((r) => r.type === "event_msg" && r.payload?.type === "task_complete")) done = Date.now() - t0;
    await sleep(100);
  }
  console.log(`run ${n}: queue command ${tq} ms; Codex recorded it at ${seen} ms (gap ${seen - tq} ms); answered by ${done} ms`);
  await sleep(6000);
}
term.kill();
