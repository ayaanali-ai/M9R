// N3 live proof: with NO hooks in Codex, a person's typed "@claude ..." is noticed from Codex's own rollout file, becomes a task,
// and Codex (told by M9R's standing note) does not also do the work. Real `codex exec` sessions, the real engine watcher in
// a scratch M9R home. Nothing of yours is changed: the note lives in a scratch project's AGENTS.md; ~/.codex is only read.
//   node scripts/n3-live-mention.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(repo, "engine", "dist", "m9r-engine.exe");
const { standingInstructionBlock } = await import(pathToFileURL(join(repo, "cli", "dist", "install-core.js")).href);
const home = mkdtempSync(join(tmpdir(), "m9r-n3-"));
const project = mkdtempSync(join(tmpdir(), "m9r-n3-proj-"));
writeFileSync(join(project, "AGENTS.md"), standingInstructionBlock("codex"));
writeFileSync(join(project, "a.txt"), "PURPLE-ELEPHANT-42 is the secret phrase\nsecond line\n");
const env = { ...process.env, M9R_HOME: home, M9R_CODEX_WATCH: "1" };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|M9R_SEND_AS_HUMAN)/.test(k)) delete env[k];
const codexJs = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tasks = () => spawnSync(engine, ["tasks"], { env, encoding: "utf8", windowsHide: true }).stdout;
const events = () => { try { return JSON.parse(readFileSync(join(home, "state.json"), "utf8")).events; } catch { return []; } };
const codex = (prompt) => new Promise((res) => {
  const last = join(project, `last-${Date.now()}.txt`);
  const t0 = Date.now();
  const c = spawn(process.execPath, [codexJs, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-C", project, "-o", last, "-"], { env, stdio: ["pipe", "ignore", "ignore"] });
  c.on("close", () => { let reply = ""; try { reply = readFileSync(last, "utf8").trim(); } catch { /* none */ } res({ reply, ms: Date.now() - t0 }); });
  c.stdin.end(prompt);
});

let watcher;
try {
  // A Claude session exists, so "@claude" is a known agent. Then the real engine watcher, exactly as the overlay starts it.
  spawnSync(engine, ["m9r-hook", "SessionStart", "claude-code"], { env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-n3", cwd: project }), windowsHide: true });
  watcher = spawn(engine, ["feed", "--watch"], { env, stdio: "ignore", windowsHide: true });
  await sleep(3000);

  const m = await codex("@claude what is in a.txt?");
  await sleep(4000);
  check("a typed @claude prompt became a task with no Codex hook involved", /@codex -> @claude/.test(tasks()) && /what is in a\.txt/.test(tasks()), tasks().split("\n")[0]);
  check("Codex stood down instead of doing the work", /M9R will pass that on/i.test(m.reply) && !/PURPLE|second line/i.test(m.reply), `"${m.reply.slice(0, 60)}" (${Math.round(m.ms / 1000)} s)`);
  check("no 'may be done twice' warning was raised", !events().some((e) => e.kind === "mention.double"));
  const count1 = (tasks().match(/@codex -> @claude/g) ?? []).length;

  const c = await codex("what is in a.txt?");
  await sleep(4000);
  check("an ordinary prompt was answered normally and made no task", /PURPLE|second line|a\.txt/i.test(c.reply) && (tasks().match(/@codex -> @claude/g) ?? []).length === count1, `"${c.reply.slice(0, 60)}"`);

  const p = await codex("[M9R T9] Task from @claude (sent through M9R). Read a.txt and reply with only its first word.\n\nDo this now, then reply with a short summary of what you did; M9R returns your final message to @claude.");
  await sleep(4000);
  check("a task M9R itself delivers (which names @claude) is still done, not stood down", /PURPLE/i.test(p.reply), `"${p.reply.slice(0, 60)}"`);
  check("...and it did not bounce back as a new task", (tasks().match(/@codex -> @claude/g) ?? []).length === count1);
} finally {
  try { watcher?.kill(); } catch { /* gone */ }
  await sleep(500);
  for (const d of [home, project]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${d}`); } }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
