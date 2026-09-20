/**
 * Live test of the Codex app-server adapter against the REAL Codex on this machine (manual; uses a few tokens of the
 * logged-in Codex subscription; never part of `npm test`).
 *
 *   CODEX_LIVE=1 node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs scripts/codex-app-server-live.ts
 *
 * Every step runs in a fresh temp directory. Prints PASS/FAIL/INFO per step and exits 1 on any FAIL.
 */
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter, createCodexAppServerAdapter } from "@/lib/bridge/codex-app-server-adapter";
import type { AgentSessionHandle, InteractiveProviderEvent } from "@/lib/bridge/interactive-provider-adapter";

if (process.env.CODEX_LIVE !== "1") {
  console.log("Set CODEX_LIVE=1 to run. This starts a real Codex app-server and uses your Codex subscription.");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const assignment = { missionId: "channel-codex-live", dispatchKey: "live", goal: "live", executionConstraints: {} } as never;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};
const info = (message: string) => console.log(`INFO  ${message}`);

async function open(adapter: CodexAppServerAdapter, cwd = mkdtempSync(join(tmpdir(), "codex-live-"))) {
  const server = await adapter.launchServer({ assignment, environment: { workingDirectory: cwd, kind: "disposable" } });
  const initialized = await adapter.initialize(server);
  return { server, cwd, initialized };
}
const replyText = (events: InteractiveProviderEvent[]) => events.filter((e) => e.type === "provider.reply_text").map((e) => String(e.payload.text)).join("");
async function run(adapter: CodexAppServerAdapter, session: AgentSessionHandle, prompt: string, onEvent?: (event: InteractiveProviderEvent) => void | Promise<void>) {
  const events: InteractiveProviderEvent[] = [];
  for await (const event of adapter.prompt({ session, text: prompt })) { events.push(event); await onEvent?.(event); }
  return events;
}
function findRollout(threadId: string): string | null {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const walk = (dir: string, depth: number): string | null => {
    if (!existsSync(dir) || depth < 0) return null;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { const hit = walk(full, depth - 1); if (hit) return hit; }
      else if (entry.includes(threadId)) return full;
    }
    return null;
  };
  return walk(root, 5);
}

// 1. a real turn: handshake, thread, streaming text, usage, completion
const adapter = createCodexAppServerAdapter();
const first = await open(adapter);
check("1a handshake reports a Codex version", /\d+\.\d+\.\d+/.test(first.initialized.agentName), first.initialized.agentName);
const session = await adapter.createSession({ server: first.server, assignment });
check("1b thread id is a real Codex thread id", /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(session.providerSessionRef ?? ""), String(session.providerSessionRef));
const t1 = Date.now();
const turn1 = await run(adapter, session, "Reply with exactly the single word: ok. Do not use any tools.");
const types1 = turn1.map((e) => e.type);
check("1c streams reply text and completes", replyText(turn1).toLowerCase().includes("ok") && types1.at(-1) === "provider.completed", `${replyText(turn1).trim().slice(0, 30)} in ${Date.now() - t1}ms`);
check("1d reports token usage", types1.includes("provider.usage_updated"));
check("1e the failure path is not what happened", !types1.includes("provider.failed"), turn1.find((e) => e.type === "provider.failed")?.payload.reason as string ?? "");

// 2. the thread is a normal persisted Codex thread and can be resumed by id (same as `codex resume <id>`)
await sleep(1000);
const rollout = findRollout(session.providerSessionRef!);
check("2a the thread is stored in Codex's own history", !!rollout, rollout ?? "not found under ~/.codex/sessions");
await adapter.closeSession({ session });
await adapter.shutdown(first.server);
const secondAdapter = createCodexAppServerAdapter();
const second = await open(secondAdapter, first.cwd);
const resumed = await secondAdapter.resumeSession({ server: second.server, providerSessionRef: session.providerSessionRef!, assignment });
const turn2 = await run(secondAdapter, resumed, "What single word did I ask you to reply with earlier? Answer with just that word, no tools.");
check("2b a new server resumes the same thread and it remembers the earlier turn", replyText(turn2).toLowerCase().includes("ok"), replyText(turn2).trim().slice(0, 40));

// 3. native interrupt: a long turn stops promptly, and the session is usable afterwards
const long = await secondAdapter.createSession({ server: second.server, assignment });
const startedAt = Date.now();
let firstDeltaAt = 0;
let interruptedAt = 0;
const longEvents = await run(secondAdapter, long, "Write out the numbers from 1 to 3000, each on its own line, directly in your reply. Do not use tools. Do not stop early.", async (event) => {
  if (event.type === "provider.reply_text" && !firstDeltaAt) {
    firstDeltaAt = Date.now();
    setTimeout(() => { interruptedAt = Date.now(); void secondAdapter.cancelTurn({ session: long }); }, 1500);
  }
});
const endedAt = Date.now();
const last = longEvents.at(-1);
check("3a interrupt ends the turn as cancelled", last?.type === "provider.completed" && last.payload.stopReason === "cancelled", JSON.stringify(last?.payload));
check("3b and it ends within ~10 s of the interrupt, not when the generation would finish", interruptedAt > 0 && endedAt - interruptedAt < 10_000, interruptedAt ? `${endedAt - interruptedAt}ms after interrupt, ${endedAt - startedAt}ms total` : "no text was ever streamed");
const after = await run(secondAdapter, long, "Reply with exactly the single word: alive. Do not use tools.");
check("3c the same session accepts a new turn after an interrupt", replyText(after).toLowerCase().includes("alive"), replyText(after).trim().slice(0, 30));

// 4. native steer: input added to a turn that is already running
const steerSession = await secondAdapter.createSession({ server: second.server, assignment });
let steerAccepted = false as boolean | string;
let steerDone = false;
const steerEvents = await run(secondAdapter, steerSession, "Write a very long, detailed story about a lighthouse, at least 1500 words. No tools.", async (event) => {
  if (event.type === "provider.reply_text" && !steerDone) {
    steerDone = true;
    try { await secondAdapter.steer({ session: steerSession, text: "Change of plan: stop the story now and reply with only the words STEERED OK." }); steerAccepted = true; }
    catch (error) { steerAccepted = error instanceof Error ? error.message : String(error); }
  }
});
check("4a steer is accepted by the running turn", steerAccepted === true, String(steerAccepted));
const steerText = replyText(steerEvents);
info(`steered turn produced ${steerText.length} characters; ends with: ${JSON.stringify(steerText.slice(-40))}`);
check("4b the turn completes normally after being steered", steerEvents.at(-1)?.type === "provider.completed");
check("4c the model actually acted on the steering input (best effort: it is the model's choice)", /STEERED OK/i.test(steerText));

// 5. approvals: with the `untrusted` policy Codex must ask before running a command it cannot prove safe
async function approvalRun(approve: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), "codex-live-approval-"));
  const guarded = createCodexAppServerAdapter({ approvalPolicy: "untrusted", permissionTimeoutMs: 60_000 });
  const opened = await open(guarded, cwd);
  const s = await guarded.createSession({ server: opened.server, assignment });
  let asked: InteractiveProviderEvent | null = null;
  const events = await run(guarded, s, "Run this exact shell command and tell me its output: node -e \"console.log(6*7)\". Then reply with just the number.", async (event) => {
    if (event.payload.activityKind === "permission.requested" && event.payload.status === "waiting" && !asked) {
      asked = event;
      await guarded.respondToPermission({ session: s, requestId: String(event.payload.requestId), approved: approve });
    }
  });
  await guarded.closeSession({ session: s }).catch(() => undefined);
  await guarded.shutdown(opened.server);
  return { asked: asked as InteractiveProviderEvent | null, events };
}
const approved = await approvalRun(true);
check("5a Codex asks before running the command (a permission request reaches M9R)", !!approved.asked, approved.asked ? String(approved.asked.payload.summary).slice(0, 80) : "no request");
check("5b approving lets it run and the answer comes back", /42/.test(replyText(approved.events)) || approved.events.some((e) => e.payload.activityKind === "command.completed" && e.payload.status === "succeeded"), replyText(approved.events).trim().slice(0, 40));
const declined = await approvalRun(false);
check("5c declining stops the command from running", !!declined.asked && !declined.events.some((e) => e.payload.activityKind === "command.completed" && e.payload.status === "succeeded"), declined.asked ? "asked, declined" : "no request");
info(`decline reply: ${JSON.stringify(replyText(declined.events).trim().slice(0, 100))}`);

await secondAdapter.shutdown(second.server);
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
