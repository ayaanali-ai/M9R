// N3 terminal-typing proof: a real interactive Codex TUI (real pseudo-terminal), NO Codex hooks. A person types "@claude ..."
// into it; the engine's watcher must turn it into a task within seconds, and Codex (told by M9R's standing note) must not also
// do the work. Also checks ordinary prompts still work, and that the note still holds after several turns.
//   node scripts/n3-live-terminal.mjs
// Needs the repo folder to be a project Codex already trusts (it is, for this repo); the run uses a scratch folder INSIDE the
// repo so it inherits that trust, and never accepts a trust dialog or edits ~/.codex. Uses a scratch M9R home.
import { spawn as ptySpawn } from "node-pty";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(repo, "engine", "dist", "m9r-engine.exe");
const { standingInstructionBlock } = await import(pathToFileURL(join(repo, "cli", "dist", "install-core.js")).href);
const project = join(repo, ".n3-proof");
const home = mkdtempSync(join(tmpdir(), "m9r-n3t-"));
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "AGENTS.md"), standingInstructionBlock("codex"));
writeFileSync(join(project, "a.txt"), "PURPLE-ELEPHANT-42 is the secret phrase\nsecond line\n");
const env = { ...process.env, M9R_HOME: home };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|M9R_SEND_AS_HUMAN)/.test(k)) delete env[k];
const codexJs = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const ENTER = String.fromCharCode(13);
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tasks = () => spawnSync(engine, ["tasks"], { env, encoding: "utf8", windowsHide: true }).stdout;
const taskCount = () => (tasks().match(/@codex -> @claude/g) ?? []).length;
const events = () => { try { return JSON.parse(readFileSync(join(home, "state.json"), "utf8")).events; } catch { return []; } };
async function waitFor(fn, ms, step = 500) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return Date.now(); await sleep(step); } return 0; }

// The rollout file of the session we open: the newest one whose first line names this folder.
function findRollout(after) {
  const root = join(homedir(), ".codex", "sessions");
  let best = null;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith("rollout-") && statSync(p).mtimeMs >= after) { try { const first = JSON.parse(readFileSync(p, "utf8").split("\n")[0]); if ((first.payload?.cwd ?? "").toLowerCase().endsWith(".n3-proof") && (!best || statSync(p).mtimeMs > statSync(best).mtimeMs)) best = p; } catch { /* partial first line */ } } } };
  walk(root);
  return best;
}
const assistantTextAfter = (file, marker) => {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const i = lines.findIndex((r) => r.type === "response_item" && r.payload?.role === "user" && JSON.stringify(r.payload.content).includes(marker));
  if (i < 0) return null;
  const done = lines.slice(i).findIndex((r) => r.type === "event_msg" && r.payload?.type === "task_complete");
  if (done < 0) return null;
  return lines.slice(i, i + done).filter((r) => r.payload?.role === "assistant").map((r) => JSON.stringify(r.payload.content)).join(" ");
};
const usedTools = (file, marker) => {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const i = lines.findIndex((r) => r.type === "response_item" && r.payload?.role === "user" && JSON.stringify(r.payload.content).includes(marker));
  if (i < 0) return null;
  const done = lines.slice(i).findIndex((r) => r.type === "event_msg" && r.payload?.type === "task_complete");
  return lines.slice(i, done < 0 ? undefined : i + done).some((r) => r.type === "response_item" && (r.payload?.type === "function_call" || r.payload?.type === "custom_tool_call"));
};

let watcher, term;
try {
  spawnSync(engine, ["m9r-hook", "SessionStart", "claude-code"], { env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-n3t", cwd: project }), windowsHide: true });
  watcher = spawn(engine, ["feed", "--watch"], { env, stdio: "ignore", windowsHide: true });
  await sleep(3000);
  const startedAt = Date.now() - 1000;

  let screen = "";
  term = ptySpawn(process.execPath, [codexJs, "-C", project], { name: "xterm-256color", cols: 120, rows: 40, cwd: project, env });
  term.onData((d) => { screen += d; });
  await sleep(14_000);
  if (/Update available/.test(screen)) { term.write("2"); await sleep(500); term.write(ENTER); await sleep(1500); }
  if (/trust the contents|Do you trust/i.test(screen)) { console.log("STOP  Codex asked to trust this folder. This proof never accepts that. Stopping without changing anything."); process.exitCode = 2; throw new Error("trust dialog"); }
  await sleep(4000);

  const type = async (text) => { term.write(text); await sleep(400); term.write(ENTER); return Date.now(); };
  const mention = "@claude what is in a.txt?";
  const t0 = await type(mention);
  const seen = await waitFor(() => taskCount() >= 1, 40_000, 250);
  check("1 a mention typed into the live Codex terminal became a task, with no Codex hook", !!seen && /what is in a\.txt/.test(tasks()), seen ? `${((seen - t0) / 1000).toFixed(1)} s after Enter` : "no task within 40 s");

  const rollout = await (async () => { for (let i = 0; i < 20; i += 1) { const f = findRollout(startedAt); if (f) return f; await sleep(1000); } return null; })();
  check("2 the live session's rollout file was found", !!rollout, rollout?.slice(-60));
  if (!rollout) throw new Error("no rollout");
  await waitFor(() => assistantTextAfter(rollout, "@claude what is in a.txt") !== null, 120_000, 1500);
  const reply1 = assistantTextAfter(rollout, "@claude what is in a.txt") ?? "";
  check("3 Codex stood down: it said M9R will pass it on and did no work", /M9R will pass that on/i.test(reply1) && !/PURPLE|second line/i.test(reply1) && usedTools(rollout, "@claude what is in a.txt") === false, reply1.slice(0, 80));
  check("4 no 'may be done twice' warning", !events().some((e) => e.kind === "mention.double"));

  // Ordinary prompts keep working, and the note is still obeyed after several turns.
  const before = taskCount();
  await type("what is 17 times 23?");
  await waitFor(() => (assistantTextAfter(rollout, "17 times 23") ?? "").length > 0, 120_000, 1500);
  check("5 an ordinary prompt is answered normally and makes no task", /391/.test(assistantTextAfter(rollout, "17 times 23") ?? "") && taskCount() === before);
  for (const q of ["what is 2 plus 2?", "what is 10 minus 3?", "name one primary colour"]) { await type(q); await waitFor(() => (assistantTextAfter(rollout, q) ?? "").length > 0, 120_000, 1500); }
  const late = "hey @claude can you summarize a.txt for me";
  await type(late);
  const seen2 = await waitFor(() => taskCount() >= before + 1, 40_000, 250);
  check("6 a mention typed after several turns still becomes a task", !!seen2 && /summarize a\.txt/.test(tasks()));
  await waitFor(() => assistantTextAfter(rollout, "summarize a.txt for me") !== null, 120_000, 1500);
  const reply2 = assistantTextAfter(rollout, "summarize a.txt for me") ?? "";
  check("7 ...and Codex still stood down (the note held for several turns)", /M9R will pass that on/i.test(reply2) && !/PURPLE/i.test(reply2), reply2.slice(0, 80));
  check("8 exactly two tasks were made in all (nothing doubled)", taskCount() === before + 1 && (tasks().match(/@codex -> @claude/g) ?? []).length === 2, `${(tasks().match(/@codex -> @claude/g) ?? []).length} tasks`);
} catch (e) {
  if (String(e.message) !== "trust dialog" && String(e.message) !== "no rollout") console.log("ERROR", e);
  failures += 1;
} finally {
  try { term?.kill(); } catch { /* gone */ }
  try { watcher?.kill(); } catch { /* gone */ }
  await sleep(800);
  for (const d of [home, project]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${d}`); } }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
