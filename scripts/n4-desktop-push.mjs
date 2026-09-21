// Push proof for Codex Desktop: a task sent from Claude with M9R goes into a live Codex Desktop thread through `codex queue`,
// Codex Desktop runs it, and the answer comes back to Claude's next prompt. Uses a scratch M9R home; the ONLY thing touched in
// Codex is one thread you name (a scratch thread you made for this), and the message it receives is the harmless one below.
//   node scripts/n4-desktop-push.mjs <codex thread id>
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const threadId = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(threadId ?? "")) { console.log("Usage: node scripts/n4-desktop-push.mjs <codex thread id>"); process.exit(2); }
const engine = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "engine", "dist", "m9r-engine.exe");
const home = mkdtempSync(join(tmpdir(), "m9r-n4-"));
const env = { ...process.env, M9R_HOME: home };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/.test(k)) delete env[k];
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, extra = {}, input) => spawnSync(engine, args, { env: { ...env, ...extra }, input, encoding: "utf8", windowsHide: true });

function rollout() {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(`${threadId}.jsonl`) ? [join(d, e.name)] : []));
  return walk(join(homedir(), ".codex", "sessions"))[0];
}
const lines = () => readFileSync(rollout(), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

let watcher;
try {
  const file = rollout();
  check("0 the named Codex thread exists and is a Codex Desktop thread", !!file && lines()[0]?.payload?.originator === "Codex Desktop", lines()[0]?.payload?.originator);
  const cwd = lines()[0]?.payload?.cwd;
  run(["m9r-hook", "SessionStart", "claude-code"], {}, JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-n4", cwd }));
  // No Codex hook: the engine's watcher finds Codex sessions by itself from Codex's own files.
  watcher = spawn(engine, ["feed", "--watch"], { env, stdio: "ignore", windowsHide: true });
  let found = false;
  for (let i = 0; i < 40 && !found; i += 1) { found = run(["sessions", "@codex"]).stdout.includes(threadId.slice(0, 13)); if (!found) await sleep(1000); }
  check("0b the engine found the Desktop thread on its own (no Codex hook)", found);

  const t0 = Date.now();
  const sent = run(["send", "@codex", "Reply with only the word: desktop-push-ok", "--from", "claude", "--session", threadId.slice(0, 13)], { M9R_SEND_AS_HUMAN: "1" });
  check("1 the task is accepted and pushed into the Desktop thread", /pushed into its session/i.test(sent.stdout), sent.stdout.trim().slice(0, 100) || sent.stderr.slice(0, 100));

  let answered = null;
  while (Date.now() - t0 < 120_000 && !answered) {
    const ls = lines();
    const i = ls.findIndex((r) => r.type === "response_item" && r.payload?.role === "user" && JSON.stringify(r.payload.content).includes("[M9R T1]"));
    if (i >= 0) {
      const after = ls.slice(i);
      const done = after.findIndex((r) => r.type === "event_msg" && r.payload?.type === "task_complete");
      if (done >= 0) answered = after.slice(0, done).filter((r) => r.payload?.role === "assistant").map((r) => JSON.stringify(r.payload.content)).join(" ");
    }
    if (!answered) await sleep(1500);
  }
  check("2 Codex Desktop ran it and answered", /desktop-push-ok/.test(answered ?? ""), answered ? `${((Date.now() - t0) / 1000).toFixed(1)} s after sending: ${answered.slice(0, 60)}` : "no answer in 120 s");

  let back = "";
  for (let i = 0; i < 20 && !back; i += 1) { back = run(["m9r-hook", "UserPromptSubmit", "claude-code"], {}, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cc-n4", cwd, prompt: "thanks" })).stdout; if (!back) await sleep(1500); }
  check("3 the answer reaches Claude's next prompt", /M9R results \(1\)/.test(back) && /desktop-push-ok/.test(back), back.slice(0, 120));
} finally {
  try { watcher?.kill(); } catch { /* gone */ }
  await sleep(500);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${home}`); }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
