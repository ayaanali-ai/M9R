// N1 acceptance (native front door, Claude side): real `claude -p` sessions, no web app, no account.
//   node scripts/n1-acceptance.mjs
// Uses a scratch project and a scratch M9R home, so it never touches your real ~/.claude or ~/.m9r. It writes the
// hooks and the standing instruction with the same functions `m9r-cli setup` uses. Spends a few haiku turns.
// Not covered here: Claude Desktop (needs the app; hooks fire the same there per Anthropic's docs) and the file-level
// install/uninstall behaviour (covered by scripts/native-commands.test.ts).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "cli", "dist");
const load = (name) => import(pathToFileURL(join(dist, name)).href);
const { mergeHooks, applyStandingInstruction } = await load("install-core.js");
const { createLocalStore } = await load("local-store.js");

const project = mkdtempSync(join(tmpdir(), "m9r-n1-project-"));
const m9rHome = mkdtempSync(join(tmpdir(), "m9r-n1-home-"));
const hookJs = join(dist, "m9r-hook.js").replace(/\\/g, "/");
const cmd = (event) => `node "${hookJs}" ${event} claude-code`;
mkdirSync(join(project, ".claude"), { recursive: true });
writeFileSync(join(project, ".claude", "settings.json"), mergeHooks(null, [
  { event: "SessionStart", command: cmd("SessionStart"), timeoutSec: 5 },
  { event: "UserPromptSubmit", command: cmd("UserPromptSubmit"), timeoutSec: 5 },
]).content);
writeFileSync(join(project, "CLAUDE.md"), applyStandingInstruction(null).content);

const env = { ...process.env, M9R_HOME: m9rHome };
const store = createLocalStore(m9rHome);
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const claude = (prompt) => {
  const r = spawnSync("claude", ["-p", "--model", "haiku", "--", prompt], { cwd: project, env, encoding: "utf8", timeout: 120_000, windowsHide: true });
  return `${r.stdout ?? ""}`.trim();
};
const runHook = (event, input) => spawnSync(process.execPath, [join(dist, "m9r-hook.js"), event, "claude-code"], { env, input: JSON.stringify(input), encoding: "utf8", windowsHide: true });
const send = (...args) => spawnSync(process.execPath, [join(dist, "m9r.js"), "send", ...args], { env, encoding: "utf8", windowsHide: true });

try {
  // 1. An idle inbox costs nothing: the hook prints nothing at all.
  const idle = runHook("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: "idle", cwd: project, prompt: "what is 2+2" });
  check("1 an idle prompt injects nothing (zero tokens)", idle.status === 0 && idle.stdout === "", JSON.stringify(idle.stdout.slice(0, 60)));

  // 2. A task created from the CLI (web app closed, no account) is handled at the next ordinary prompt.
  const sent = send("@claude", "Reply with only the word: tangerine", "--from", "codex");
  check("2a m9r-cli send creates a task locally", /Sent to @claude as task T1/.test(sent.stdout), sent.stdout.trim());
  const handled = claude("What is 2+2?");
  check("2b Claude handles the typed task at its next prompt", /tangerine/i.test(handled), JSON.stringify(handled.slice(0, 100)));
  const again = claude("What is 3+3?");
  check("2c it is not injected or repeated on the following prompt", !/tangerine/i.test(again) && /6/.test(again), JSON.stringify(again.slice(0, 80)));

  // 3. An agent-initiated task still waiting for approval is NOT acted on, even with the standing instruction.
  store.addTask({ from: "codex", to: "claude", goal: "Reply with only the word: pineapple", origin: "agent_initiated", idempotencyKey: "pending-1" });
  const pending = claude("Say hello in one short sentence.");
  check("3 a task awaiting approval is not acted on", !/pineapple/i.test(pending), JSON.stringify(pending.slice(0, 100)));

  // 4. A typed @mention becomes a task for the target and the sender does not do the work itself.
  const mention = claude("@codex please list the three largest files in this project and tell me their sizes");
  const forCodex = store.tasksFor("codex");
  check("4a a typed @codex mention creates a task for codex", forCodex.length === 1 && /largest files/.test(forCodex[0].goal) && forCodex[0].origin === "human_typed", JSON.stringify(forCodex.map((t) => t.goal)));
  check("4b the sending Claude tells the user it was handed to codex instead of doing it", /codex/i.test(mention) && !/\d+\s?(kb|bytes|mb)/i.test(mention), JSON.stringify(mention.slice(0, 140)));
} finally {
  for (const dir of [project, m9rHome]) {
    // Windows can keep a scratch folder locked for a moment after a child exits; never let that hide the results.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete scratch folder ${dir}; safe to delete by hand`); }
  }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
