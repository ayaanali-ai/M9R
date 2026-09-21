// O1 acceptance (overlay feed writer), real processes: a real `m9r-cli feed --watch`, a real hook and CLI creating tasks,
// a killed and restarted writer, a corrupt store, and idle CPU. No window, no account, no network.
//   node scripts/o1-acceptance.mjs
// Uses a scratch M9R home, so it never touches your real ~/.m9r.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "cli", "dist");
const { createLocalStore } = await import(pathToFileURL(join(dist, "local-store.js")).href);
const home = mkdtempSync(join(tmpdir(), "m9r-o1-"));
const feedFile = join(home, "feed.json");
const baseEnv = { ...process.env, M9R_HOME: home };
for (const k of Object.keys(baseEnv)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/.test(k)) delete baseEnv[k];
const agentEnv = { ...baseEnv, CLAUDECODE: "1" };
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readFeed = () => { try { return JSON.parse(readFileSync(feedFile, "utf8")); } catch { return null; } };
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return { v, took: Date.now() - t0 }; await sleep(25); } return { v: null, took: Date.now() - t0 }; }
const startWriter = () => spawn(process.execPath, [join(dist, "m9r.js"), "feed", "--watch"], { env: baseEnv, stdio: "ignore", windowsHide: true });
const send = (text, env) => spawnSync(process.execPath, [join(dist, "m9r.js"), "send", "@codex", text, "--from", "claude"], { env, encoding: "utf8", windowsHide: true });
const cpuSeconds = (pid) => Number(spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).CPU`], { encoding: "utf8" }).stdout.trim() || "0");

let writer;
try {
  // The store starts empty (a real hook registers Codex and Claude the way a session would).
  spawnSync(process.execPath, [join(dist, "m9r-hook.js"), "SessionStart", "claude-code"], { env: baseEnv, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-o1", cwd: "C:/p" }), windowsHide: true });
  writer = startWriter();
  const first = await until(() => readFeed(), 6000);
  check("1 the feed file appears with the three known agents", !!first.v && first.v.agents?.length >= 3 && first.v.version === 1, `${first.took} ms`);
  check("2 Claude is 'seen' (no open/closed signal claimed), OpenCode is not connected", first.v?.agents.find((a) => a.handle === "claude")?.state === "seen" && first.v?.agents.find((a) => a.handle === "opencode")?.state === "not_connected");

  // An agent asks for work: it waits for approval and must reach the feed fast, with secrets removed.
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const t0 = Date.now();
  const sent = send(`Review lease.ts using key ${secret}`, agentEnv);
  const ping = await until(() => readFeed()?.needsYou?.find((n) => n.kind === "approval"), 4000);
  check("3 an agent-initiated task shows up as 'needs you' within 2 s of being created", !!ping.v && Date.now() - t0 < 2000 + 700, `${Date.now() - t0} ms (send took ${Date.now() - t0 - ping.took} ms)`);
  const afterSend = readFeed();
  check("4 it carries one ping for that item, and the secret never reached the file", afterSend.pings?.length === 1 && !readFileSync(feedFile, "utf8").includes(secret), sent.stdout.trim().slice(0, 60));

  // The user says no (a terminal decision); the item leaves the list.
  const store = createLocalStore(home);
  store.setApproval(ping.v.taskId, "denied");
  const gone = await until(() => (readFeed()?.needsYou ?? []).every((n) => n.kind !== "approval"), 3000);
  check("5 a decision made elsewhere removes it from the feed within 2 s", !!gone.v && gone.took < 2000, `${gone.took} ms`);

  // Kill the writer hard, add work while it is dead, start a new one: nothing lost, seq keeps counting, no duplicate ping.
  const seqBefore = readFeed().seq;
  writer.kill("SIGKILL");
  await sleep(300);
  send("Second review of lease.ts", agentEnv);
  writer = startWriter();
  const back = await until(() => { const f = readFeed(); return f && f.seq > seqBefore && f.needsYou.some((n) => n.kind === "approval") ? f : null; }, 6000);
  check("6 after a hard kill the restarted writer catches up and seq keeps counting", !!back.v, `seq ${seqBefore} -> ${back.v?.seq}`);
  check("7 the restart pings only the new item once", back.v?.pings?.length === 1 && /Second review/.test(back.v.pings[0].text), JSON.stringify(back.v?.pings?.map((p) => p.text)));

  // A corrupt store must not stop the writer.
  writeFileSync(join(home, "state.json"), "{ this is not json", "utf8");
  await sleep(1500);
  check("8 a corrupt state file does not kill the writer, and the feed stays valid", writer.exitCode === null && readFeed()?.version === 1, `exit=${writer.exitCode}`);

  // Idle cost.
  const c0 = cpuSeconds(writer.pid);
  await sleep(10_000);
  const used = cpuSeconds(writer.pid) - c0;
  check("9 idle CPU over 10 s is under 3%", used < 0.3, `${used.toFixed(2)} s of CPU in 10 s`);
} finally {
  try { writer?.kill(); } catch { /* already gone */ }
  await sleep(500);
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${home}; safe to delete by hand`); }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
