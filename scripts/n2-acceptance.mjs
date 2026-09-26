// N2 acceptance (Codex delivery), real `codex`: a task typed in Claude is pushed into a real Codex thread with
// `codex queue`, Codex runs it, and the answer reaches Claude's inbox at its next prompt. Web app closed, no account.
//   node scripts/n2-acceptance.mjs
// Uses a scratch project and a scratch M9R home (never your real ~/.m9r) and never touches ~/.codex config; it does create
// two small Codex sessions (their rollout files stay in ~/.codex/sessions like any other run). Spends a few short turns.
// The Codex session here is created and resumed with `codex exec`; a live `codex resume` terminal and the Desktop app
// consume the same queue the same way (checked by hand, not by this script).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "cli", "dist");
const { createLocalStore } = await import(pathToFileURL(join(dist, "local-store.js")).href);
// On Windows, PowerShell can resolve the npm `codex.ps1` shim while child
// processes launched through cmd.exe cannot. Call the installed JS entrypoint
// directly when available; retain the PATH fallback for other installations.
const codexJs = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const codexCommand = existsSync(codexJs)
  ? { command: process.execPath, prefix: [codexJs], shell: false }
  : { command: "codex", prefix: [], shell: process.platform === "win32" };
const env = { ...process.env, M9R_SEND_AS_HUMAN: "1" };
// Codex supports a PEM bundle override. Git for Windows ships Mozilla public
// roots; use it only for this test's child processes when no bundle was set.
// This preserves TLS verification and changes no machine-wide trust settings.
const hasCodexCa = !!(env.CODEX_CA_CERTIFICATE?.trim() || env.SSL_CERT_FILE?.trim());
const gitCa = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "ssl", "cert.pem");
if (!hasCodexCa && process.platform === "win32" && existsSync(gitCa)) env.CODEX_CA_CERTIFICATE = gitCa;
const login = spawnSync(codexCommand.command, [...codexCommand.prefix, "login", "status"], {
  env, encoding: "utf8", timeout: 10_000, shell: codexCommand.shell, windowsHide: true,
});
const loginOutput = `${login.stdout ?? ""}${login.stderr ?? ""}`;
if (login.status !== 0 || /\bnot logged in\b/i.test(loginOutput) || !/\blogged in\b/i.test(loginOutput)) {
  console.log("BLOCKED  Codex CLI is not authenticated in this environment; run `codex login` and retry. No agent session was started.");
  process.exit(2);
}
const tlsReady = await new Promise((resolveTls) => {
  const req = httpsGet("https://api.openai.com/v1/models", { timeout: 8_000 }, (res) => {
    res.resume();
    resolveTls({ ok: true });
  });
  req.on("timeout", () => req.destroy(new Error("TLS preflight timed out")));
  req.on("error", (error) => resolveTls({ ok: false, reason: error.message }));
});
if (!tlsReady.ok) {
  console.log(`BLOCKED  Codex API TLS preflight failed: ${tlsReady.reason}. No agent session was started.`);
  process.exit(2);
}
const project = mkdtempSync(join(tmpdir(), "m9r-n2-project-"));
const m9rHome = mkdtempSync(join(tmpdir(), "m9r-n2-home-"));
env.M9R_HOME = m9rHome;
const store = createLocalStore(m9rHome);
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const codex = (args, input) => spawnSync(codexCommand.command, [...codexCommand.prefix, ...args], { cwd: project, env, input, encoding: "utf8", timeout: 240_000, shell: codexCommand.shell, windowsHide: true });
const m9r = (...args) => spawnSync(process.execPath, [join(dist, "m9r.js"), ...args], { cwd: project, env, encoding: "utf8", windowsHide: true });
const hook = (prompt) => spawnSync(process.execPath, [join(dist, "m9r-hook.js"), "UserPromptSubmit", "claude-code"], { env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cc-n2", cwd: project, prompt }), encoding: "utf8", windowsHide: true });

try {
  // A real Codex thread (the id the Codex hook would report is this same UUID; verified against a captured session).
  const created = codex(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-"], "Reply with only: ready");
  const createdOutput = `${created.stdout ?? ""}${created.stderr ?? ""}`;
  const threadId = /session id: ([0-9a-f-]{36})/i.exec(createdOutput)?.[1];
  const createdSuccessfully = created.status === 0 && !!threadId && /\bready\b/i.test(createdOutput);
  check("0 an authenticated Codex turn completed and created a real thread", createdSuccessfully, createdSuccessfully
    ? threadId
    : `exit ${created.status ?? "unknown"}${created.error ? ` (${created.error.code})` : ""}; output: ${createdOutput.replace(/\s+/g, " ").slice(-220)}`);
  if (!createdSuccessfully || !threadId) throw new Error("cannot continue without a completed authenticated Codex turn");
  store.registerEndpoint({ provider: "codex", sessionId: threadId, cwd: project });

  // 1. Typed in Claude (the hook), pushed into Codex by the detached runner.
  const ack = hook("@codex Reply with only the word: mango-pineapple");
  check("1a Claude is told the task was sent, so it does not do the work itself", /already sent your message to @codex/.test(ack.stdout), ack.stdout.slice(0, 120));
  let task;
  for (let i = 0; i < 40 && !(task = store.tasksFor("codex")[0])?.delivery; i += 1) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
  check("1b the push happened without any web app (state: queued)", task?.delivery?.state === "queued", JSON.stringify(task?.delivery));
  check("1c the pushed task is not also injected at Codex's own next prompt", !/M9R inbox/.test(spawnSync(process.execPath, [join(dist, "m9r-hook.js"), "UserPromptSubmit", "codex"], { env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: threadId, cwd: project, prompt: "hello" }), encoding: "utf8" }).stdout));

  // 2. Codex consumes its queue when the thread runs; the answer comes back to Claude once.
  const resumed = codex(["exec", "resume", "--skip-git-repo-check", threadId, "Reply with only: resumed", "--json"]);
  const resumedOutput = `${resumed.stdout}${resumed.stderr}`;
  const transportFailure = /invalid peer certificate: UnknownIssuer/i.test(resumedOutput)
    ? "Codex TLS trust failed (UnknownIssuer)"
    : /Missing bearer or basic authentication/i.test(resumedOutput)
      ? "Codex CLI authentication is unavailable to the child process"
      : undefined;
  check("2a Codex ran the queued task", /mango-pineapple/.test(resumedOutput), resumed.status === 0
    ? `marker missing; output: ${resumedOutput.replace(/\s+/g, " ").slice(-180)}`
    : `${transportFailure ? `${transportFailure}; ` : ""}resume exited ${resumed.status ?? "without a status"}${resumed.signal ? ` (${resumed.signal})` : ""}${resumed.error ? `; spawn error ${resumed.error.code}: ${resumed.error.message}` : ""}; stdout: ${String(resumed.stdout ?? "").replace(/\s+/g, " ").slice(-240)}; stderr: ${String(resumed.stderr ?? "").replace(/\s+/g, " ").slice(-240)}`);
  const back = hook("thanks");
  check("2b the answer reaches Claude's next prompt as the task's own answer", /M9R results \(1\)/.test(back.stdout) && /mango-pineapple/.test(back.stdout) && !/finished by @codex\] resumed/.test(back.stdout), back.stdout.slice(0, 160));
  check("2c it is shown once", hook("again").stdout === "");

  // 3. A task an agent started on its own is never pushed until approved.
  const pending = store.addTask({ from: "claude", to: "codex", goal: "Reply with only the word: unapproved", origin: "agent_initiated", idempotencyKey: "n2-pending" }).task;
  const sent = m9r("send", "@codex", "noop check", "--from", "claude", "--key", "n2-typed");
  check("3a m9r-cli send pushes a typed task", /pushed into its session/.test(sent.stdout), sent.stdout.trim().slice(0, 140));
  check("3b the unapproved agent-initiated task was not queued", !store.getTask(pending.id)?.delivery && store.getTask(pending.id)?.approval === "pending", JSON.stringify(store.getTask(pending.id)?.delivery));
  // 4. The same command run by an agent (its shell has no terminal and carries agent markers) is an agent-initiated task.
  const agentEnv = { ...env, CLAUDECODE: "1" };
  delete agentEnv.M9R_SEND_AS_HUMAN;
  const viaAgent = spawnSync(process.execPath, [join(dist, "m9r.js"), "send", "@codex", "Reply with only the word: agent-sent", "--from", "claude"], { env: agentEnv, encoding: "utf8", windowsHide: true });
  check("4a an agent running `m9r-cli send` is told the task waits for the user", /waiting for the user's approval; nothing was delivered/.test(viaAgent.stdout), viaAgent.stdout.trim().slice(0, 120));
  const agentTask = store.tasksFor("codex").find((t) => /agent-sent/.test(t.goal));
  check("4b it is agent-initiated, pending and never pushed", agentTask?.origin === "agent_initiated" && agentTask?.approval === "pending" && !agentTask?.delivery, JSON.stringify({ origin: agentTask?.origin, approval: agentTask?.approval }));
  const tryApprove = spawnSync(process.execPath, [join(dist, "m9r.js"), "approve", agentTask?.id ?? "T0", "--yes"], { env: agentEnv, encoding: "utf8", windowsHide: true });
  check("4c the agent cannot approve it", tryApprove.status === 1 && store.getTask(agentTask?.id ?? "")?.approval === "pending", `${tryApprove.stderr.trim().slice(0, 100)}`);
} finally {
  for (const dir of [project, m9rHome]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete scratch folder ${dir}; safe to delete by hand`); }
  }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
