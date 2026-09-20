// N2 live-terminal proof: a real interactive `codex resume` TUI under a real pseudo-terminal (node-pty) consumes a task
// pushed with `m9r-cli send`, runs it, and the answer reaches Claude's inbox. Also covers a BUSY thread (a task pushed
// while the session is mid-turn) and TWO Codex sessions at once.
//   node scripts/n2-live-terminal.mjs [--busy] [--two]
// Needs a project whose Codex hooks are already trusted (set M9R_TRUSTED_PROJECT); a scratch M9R home is used.
import { spawn as ptySpawn } from "node-pty";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "cli", "dist");
const project = process.env.M9R_TRUSTED_PROJECT;
if (!project || !existsSync(project)) { console.log("Set M9R_TRUSTED_PROJECT to a folder whose .codex/hooks.json Codex already trusts."); process.exit(2); }
const args = process.argv.slice(2);
const { createLocalStore } = await import(pathToFileURL(join(dist, "local-store.js")).href);

const m9rHome = mkdtempSync(join(tmpdir(), "m9r-live-"));
const env = { ...process.env, M9R_HOME: m9rHome };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCODE)/.test(k)) delete env[k];
const store = createLocalStore(m9rHome);
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codexJs = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const codexArgs = existsSync(codexJs) ? { cmd: process.execPath, pre: [codexJs] } : { cmd: "codex", pre: [] };
const send = (text, extraEnv = {}, session) => spawnSync(process.execPath, [join(dist, "m9r.js"), "send", "@codex", text, "--from", "claude", ...(session ? ["--session", session] : [])], { env: { ...env, M9R_SEND_AS_HUMAN: "1", ...extraEnv }, encoding: "utf8", windowsHide: true });
const hook = (sid, prompt) => spawnSync(process.execPath, [join(dist, "m9r-hook.js"), "UserPromptSubmit", "claude-code"], { env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sid, cwd: project, prompt }), encoding: "utf8", windowsHide: true });
function rollout(threadId) {
  const root = join(homedir(), ".codex", "sessions");
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(`${threadId}.jsonl`) ? [join(d, e.name)] : []));
  return walk(root)[0];
}
const rolloutText = (threadId) => { const f = rollout(threadId); return f ? readFileSync(f, "utf8") : ""; };
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(1500); } return false; }
function newThread() {
  const r = spawnSync(codexArgs.cmd, [...codexArgs.pre, "exec", "--sandbox", "read-only", "-C", project, "-"], { env, input: "Reply with only: ready", encoding: "utf8", timeout: 240_000 });
  return /session id: ([0-9a-f-]{36})/i.exec(`${r.stdout}${r.stderr}`)?.[1];
}
function openTui(threadId) {
  let screen = "";
  const term = ptySpawn(codexArgs.cmd, [...codexArgs.pre, "resume", threadId, "-C", project], { name: "xterm-256color", cols: 120, rows: 40, cwd: project, env });
  term.onData((d) => { screen += d; });
  return { term, screen: () => screen };
}

const tuis = [];
try {
  const threadId = newThread();
  check("0 a real thread was created, and the trusted hook registered it by itself", !!threadId && store.listEndpoints().some((e) => e.sessionId === threadId), threadId);
  if (!threadId) throw new Error("no thread");

  const tui = openTui(threadId); tuis.push(tui);
  await sleep(12_000);
  // A live session sitting on a modal takes the keyboard and does not consume pushed tasks. Codex shows an "Update available"
  // dialog on some starts; choose "Skip" (option 2: installs nothing, persists nothing) so the session reaches its idle prompt.
  if (/Update available/.test(tui.screen())) { tui.term.write("2"); await sleep(500); tui.term.write("\r"); console.log("INFO  dismissed the Codex update dialog with Skip (a session left on it would not consume pushed tasks)"); }
  await sleep(6000);
  console.log(`(TUI drew ${tui.screen().length} bytes; the live session is running)`);

  if (args.includes("--busy")) {
    // Keep the session busy with a slow command, push while it is mid-turn.
    tui.term.write("Run the shell command: powershell -NoProfile -Command Start-Sleep -Seconds 25 ; then reply with only: slow-done\r");
    await sleep(6000);
    const r = send("Reply with only the word: pushed-while-busy");
    check("B1 pushing while the thread is busy is accepted", /pushed into its session/.test(r.stdout), r.stdout.trim().slice(0, 100));
    check("B2 the busy thread still ran the pushed task afterwards", await waitFor(() => (rolloutText(threadId).match(/pushed-while-busy/g) ?? []).length >= 3, 150_000));
  } else {
    const r = send("Reply with only the word: live-terminal-ok");
    check("1 push into a live interactive session is accepted", /pushed into its session/.test(r.stdout), r.stdout.trim().slice(0, 100));
    check("2 the live session consumed and ran it (no resume, no user action)", await waitFor(() => (rolloutText(threadId).match(/live-terminal-ok/g) ?? []).length >= 3, 90_000));
  }
  const back = await (async () => { for (let i = 0; i < 20; i += 1) { const h = hook("cc-live", "thanks"); if (h.stdout) return h.stdout; await sleep(1500); } return ""; })();
  check("3 the answer reaches Claude's next prompt", /M9R results \(1\)/.test(back) && /(live-terminal-ok|pushed-while-busy)/.test(back), back.slice(0, 160));

  if (args.includes("--two")) {
    // A second Codex session appears (a finished `exec` one) while the first is still the live interactive session.
    const second = newThread();
    check("T0 a second Codex session exists, and the first is still remembered", !!second && second !== threadId && store.sessionsFor("codex").length === 2, second);
    const unaimed = send("Reply with only the word: unaimed");
    const t1 = store.tasksFor("codex").find((t) => /unaimed/.test(t.goal));
    check("T1 an unaimed push with two sessions is NOT sent to a guess", t1?.delivery?.state === "failed" && /2 Codex sessions/.test(t1?.delivery?.error ?? ""), unaimed.stdout.trim().slice(0, 140));
    const codexPrompt = spawnSync(process.execPath, [join(dist, "m9r-hook.js"), "UserPromptSubmit", "codex"], { env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: second, cwd: project, prompt: "hello" }), encoding: "utf8", windowsHide: true });
    check("T2 it waits in the inbox and shows at the next Codex prompt instead of being lost", /M9R inbox[\s\S]*unaimed/.test(codexPrompt.stdout), codexPrompt.stdout.slice(0, 120));
    const listed = spawnSync(process.execPath, [join(dist, "m9r.js"), "sessions", "@codex"], { env, encoding: "utf8", windowsHide: true }).stdout;
    check("T3 `m9r-cli sessions` lists both", listed.includes(threadId) && listed.includes(second), `${listed.length} chars`);
    const pinned = send("Reply with only the word: aimed-at-live", {}, threadId.slice(0, 14));
    check("T4 a pinned push goes to the live session", /pushed into its session/.test(pinned.stdout) && store.tasksFor("codex").at(-1)?.delivery?.threadId === threadId, pinned.stdout.trim().slice(0, 100));
    check("T5 the live interactive session consumed the pinned task", await waitFor(() => (rolloutText(threadId).match(/aimed-at-live/g) ?? []).length >= 3, 90_000));
  }
} finally {
  for (const t of tuis) { try { t.term.kill(); } catch { /* already gone */ } }
  try { rmSync(m9rHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${m9rHome}`); }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
