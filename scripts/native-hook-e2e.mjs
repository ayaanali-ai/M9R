// End-to-end check of the native hook the way an agent runs it: as a child process with its stdin/stdout/stderr on pipes, waiting
// for the pipes to CLOSE (Claude does exactly that, so a background engine that inherited them would look like a hung hook).
// Scratch home only (USERPROFILE and M9R_HOME both point at it); no Node on PATH is needed for M9R itself.
//   node scripts/native-hook-e2e.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "engine", "dist");
const engine = join(dist, "m9r-engine.exe");
const home = mkdtempSync(join(tmpdir(), "m9r-nh-"));
const env = { ...process.env, USERPROFILE: home, HOME: home, M9R_HOME: join(home, ".m9r"), CODEX_HOME: join(home, "no-codex") };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_THREAD|OPENCODE)/.test(k)) delete env[k];
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shim = join(home, ".m9r", "bin", "m9r-hook.exe");

/** Runs the hook like an agent: pipes for all three streams, resolves when the pipes close. */
function runHook(event, provider, payload) {
  return new Promise((res) => {
    const t0 = Date.now();
    const c = spawn(shim, [event, provider], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", (code) => res({ out, code, ms: Date.now() - t0 }));
    c.stdin.end(JSON.stringify(payload));
  });
}
const start = (extra = {}) => ({ hook_event_name: "SessionStart", session_id: "sess-1", cwd: "C:/", ...extra });
const tasks = () => spawnSync(engine, ["tasks"], { env, encoding: "utf8", windowsHide: true }).stdout;

try {
  const s = spawnSync(engine, ["setup", "--yes"], { env, encoding: "utf8", windowsHide: true });
  check("setup installs the engine and the native hook", s.status === 0 && existsSync(shim) && existsSync(join(home, ".m9r", "bin", "m9r-engine.exe")), s.stdout.split("\n").slice(-3).join(" ").slice(0, 100));
  check("the agent's settings point at the native hook", /m9r-hook\.exe/.test(readFileSync(join(home, ".claude", "settings.json"), "utf8")));

  // Setup itself warms the new program and starts the engine, so the very first prompt finds it ready.
  let up = null; const t0 = Date.now();
  while (Date.now() - t0 < 40_000) { const r = await runHook("SessionStart", "claude-code", start()); if (r.out) { up = r; break; } await sleep(500); }
  check("1 setup started the engine: the hook answers, and the first real call finishes well inside the 5 s limit", !!up && /M9R connected as @claude/.test(up.out) && up.ms < 2500, up ? `engine answered ${((Date.now() - t0) / 1000).toFixed(1)} s after setup; that call took ${up.ms} ms` : "never answered");

  const warm = [];
  for (let i = 0; i < 8; i += 1) warm.push((await runHook("UserPromptSubmit", "claude-code", { hook_event_name: "UserPromptSubmit", session_id: "sess-1", cwd: "C:/", prompt: "hello" })).ms);
  warm.sort((a, b) => a - b);
  check("2 warm calls are well inside the 5 s limit (median under 400 ms, slowest under 1500 ms)", warm[4] < 400 && warm[7] < 1500, `median ${warm[4]} ms, slowest ${warm[7]} ms`);

  await runHook("SessionStart", "codex", start({ session_id: "cx-1" }));
  const m = await runHook("UserPromptSubmit", "claude-code", { hook_event_name: "UserPromptSubmit", session_id: "sess-1", cwd: "C:/", prompt: "hey @codex what is in a.txt" });
  check("3 a typed mention through the native hook becomes a task and the agent is told", /what is in a\.txt/.test(tasks()) && /T1/.test(m.out), m.out.slice(0, 90));

  // Stop the engine (as a reboot would) and check the hook stays instant and restarts it.
  const shut = spawnSync(engine, ["uninstall", "--dry-run"], { env, encoding: "utf8", windowsHide: true });
  void shut;
  const down = await new Promise((res) => { const p = spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='m9r-engine.exe'" | Where-Object { $_.ExecutablePath -like '${home.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'stopped' }`], { encoding: "utf8" }); res(p.stdout.trim()); });
  await sleep(1500);
  const after = await runHook("SessionStart", "claude-code", start());
  check("4 after the engine dies (as after a reboot) the hook stays instant and empty, and its pipes close", down.includes("stopped") && after.ms < 2000 && after.out === "", `${after.ms} ms`);
  await sleep(26_000); // the restart guard lets the hook start the engine again after 25 s
  await runHook("SessionStart", "claude-code", start());
  let back = null; const t1 = Date.now();
  while (Date.now() - t1 < 40_000) { const r = await runHook("SessionStart", "claude-code", start()); if (r.out) { back = r; break; } await sleep(500); }
  check("5 ...and it brings the engine back by itself", !!back);

  const un = spawnSync(engine, ["uninstall", "--yes"], { env, encoding: "utf8", windowsHide: true });
  await sleep(800);
  check("6 uninstall stops the engine and removes both programs", un.status === 0 && !existsSync(shim) && !existsSync(join(home, ".m9r", "bin", "m9r-engine.exe")), un.stdout.split("\n").slice(-2).join(" ").slice(0, 100));
} finally {
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='m9r-engine.exe'" | Where-Object { $_.ExecutablePath -like '${home.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
  await sleep(800);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.log(`note: could not delete ${home}`); }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
