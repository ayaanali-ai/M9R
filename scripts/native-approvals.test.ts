import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isAgentContext, isHumanContext, isProtectedAction, lapsedPending, parseDuration, ruleCovers } from "../src/lib/native/approval-core";
import { nativePaths, runNativeCommand, type NativeIo } from "../src/lib/native/native-commands";
import { createLocalStore } from "../src/lib/native/local-store";
import { renderSessionCard } from "../src/lib/native/inbox-core";
import type { DeliveryDeps } from "../src/lib/native/codex-delivery";

const THREAD = "01a0bf78-e44a-7801-8e67-681a53f0ab68";

function sandbox(opts: { terminal?: boolean; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "m9r-n5-"));
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const codexDeps: DeliveryDeps = {
    resolveCodex: () => ({ command: "node", args: ["codex.js"] }),
    runCodex: async (_c, args) => { calls.push(args); return { code: 0, stderr: "" }; },
    readRolloutTail: () => null,
  };
  const io: NativeIo = {
    homeDir: home,
    env: { M9R_HOME: join(home, ".m9r"), ...(opts.env ?? {}) },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    confirm: opts.terminal === false ? undefined : async () => true,
    codexDeps,
    cwd: "C:/p",
  };
  const store = createLocalStore(nativePaths(io).m9r);
  store.registerEndpoint({ provider: "codex", sessionId: THREAD, cwd: "C:/p" });
  return { io, out, err, calls, store, run: (cmd: string, args: string[] = []) => runNativeCommand(cmd, args, io) };
}

test("a person at a terminal is human; an agent's shell (no terminal, or agent markers) is not", () => {
  assert.equal(isHumanContext({ hasTerminal: true, env: {} }), true);
  assert.equal(isHumanContext({ hasTerminal: false, env: {} }), false);
  assert.equal(isHumanContext({ hasTerminal: true, env: { CLAUDECODE: "1" } }), false);
  assert.equal(isHumanContext({ hasTerminal: true, env: { CODEX_THREAD_ID: THREAD } }), false);
  assert.equal(isAgentContext({ CODEX_CI: "1" }), true);
  assert.equal(isHumanContext({ hasTerminal: false, env: { M9R_SEND_AS_HUMAN: "1" } }), true, "the user's own script opt-in");
});

test("protected actions are recognised, ordinary work is not", () => {
  for (const g of ["delete the build folder", "git push --force to main", "drop table users", "deploy to production", "publish the package", "rotate the API key", "refund the customer"]) assert.equal(isProtectedAction(g), true, g);
  for (const g of ["review relay/lease.ts", "summarise the failing test", "add a unit test for the parser"]) assert.equal(isProtectedAction(g), false, g);
});

test("durations are limited to a day; a rule covers only its pair, while unexpired, never for a protected action", () => {
  assert.equal(parseDuration(undefined), 3_600_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("2d"), null);
  assert.equal(parseDuration("soon"), null);
  const now = new Date("2026-09-20T12:00:00Z");
  const rules = [{ id: "R1", from: "claude", to: "codex", createdAt: "", expiresAt: "2026-09-20T13:00:00Z" }];
  assert.ok(ruleCovers(rules, { from: "claude", to: "codex", goal: "review lease.ts" }, now));
  assert.equal(ruleCovers(rules, { from: "codex", to: "claude", goal: "review lease.ts" }, now), undefined);
  assert.equal(ruleCovers(rules, { from: "claude", to: "codex", goal: "deploy to production" }, now), undefined);
  assert.equal(ruleCovers(rules, { from: "claude", to: "codex", goal: "review" }, new Date("2026-09-20T14:00:00Z")), undefined, "expired");
  assert.deepEqual(lapsedPending([{ id: "T1", approval: "pending", createdAt: "2026-09-19T00:00:00Z" }, { id: "T2", approval: "pending", createdAt: "2026-09-20T11:00:00Z" }], now), ["T1"]);
});

test("an agent running `send` creates a pending task that is never pushed, and is told how the user approves it", async () => {
  const s = sandbox({ terminal: false, env: { CLAUDECODE: "1" } });
  assert.equal(await s.run("send", ["@codex", "Review relay/lease.ts", "--from", "claude"]), 0);
  assert.match(s.out.join("\n"), /waiting for the user's approval; nothing was delivered/);
  assert.match(s.out.join("\n"), /m9r-cli approve T1/);
  assert.equal(s.calls.length, 0, "nothing was pushed into Codex");
  assert.equal(s.store.getTask("T1")?.origin, "agent_initiated");
  assert.equal(s.store.getTask("T1")?.approval, "pending");
});

test("an agent cannot approve, deny, allow or revoke, even for its own task", async () => {
  const s = sandbox({ terminal: false, env: { CLAUDECODE: "1" } });
  await s.run("send", ["@codex", "Review lease.ts", "--from", "claude"]);
  for (const [cmd, args] of [["approve", ["T1", "--yes"]], ["deny", ["T1", "--yes"]], ["allow", ["@claude", "@codex"]], ["revoke", ["R1"]]] as const) {
    assert.equal(await s.run(cmd, [...args]), 1, cmd);
  }
  assert.match(s.err.join("\n"), /needs a person at a terminal/);
  assert.equal(s.store.getTask("T1")?.approval, "pending");
  assert.equal(s.store.activeRules().length, 0);
  const inTerminalButAgentShell = sandbox({ terminal: true, env: { CODEX_THREAD_ID: THREAD } });
  await inTerminalButAgentShell.run("send", ["@claude", "x", "--from", "codex"]);
  assert.equal(await inTerminalButAgentShell.run("approve", ["T1", "--yes"]), 1, "agent markers win over a terminal");
});

test("a person approves: the task is pushed into Codex right away; denying never delivers", async () => {
  const agent = sandbox({ terminal: false, env: { CLAUDECODE: "1" } });
  await agent.run("send", ["@codex", "Review lease.ts", "--from", "claude"]);
  await agent.run("send", ["@codex", "Refactor the parser", "--from", "claude"]);
  const person = { ...agent.io, env: { M9R_HOME: agent.io.env.M9R_HOME }, confirm: async () => true };
  const run = (cmd: string, args: string[]) => runNativeCommand(cmd, args, person);
  assert.equal(await run("approve", ["T1", "--yes"]), 0);
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(agent.calls[0].slice(0, 4), ["queue", "--thread", THREAD, "--message"]);
  assert.equal(agent.store.getTask("T1")?.approval, "approved");
  assert.equal(agent.store.getTask("T1")?.delivery?.state, "queued");
  assert.equal(await run("deny", ["T2", "--yes"]), 0);
  assert.equal(agent.store.getTask("T2")?.approval, "denied");
  assert.equal(agent.calls.length, 1, "a denied task is never pushed");
  assert.equal(await run("approve", ["T2", "--yes"]), 0);
  assert.equal(agent.store.getTask("T2")?.approval, "denied", "an answered task cannot be flipped");
});

test("a standing rule lets one agent hand work to another for a while, but protected actions still ask", async () => {
  const s = sandbox({ terminal: true });
  assert.equal(await s.run("allow", ["@claude", "@codex", "--for", "30m"]), 0);
  assert.match(s.out.join("\n"), /Rule R1: @claude may hand work to @codex/);
  const agent = { ...s.io, env: { M9R_HOME: s.io.env.M9R_HOME, CLAUDECODE: "1" }, confirm: undefined };
  const send = (text: string) => runNativeCommand("send", ["@codex", text, "--from", "claude"], agent);
  await send("Review lease.ts");
  assert.equal(s.store.getTask("T1")?.approval, "approved", "covered by the rule");
  assert.equal(s.calls.length, 1, "an approved agent task is pushed");
  await send("Deploy to production");
  assert.equal(s.store.getTask("T2")?.approval, "pending", "protected: the rule does not cover it");
  assert.equal(s.calls.length, 1);
  assert.equal(await s.run("revoke", ["R1"]), 0);
  assert.equal(await s.run("standing"), 0);
  await send("Review the parser");
  assert.equal(s.store.getTask("T3")?.approval, "pending", "the rule is gone");
});

test("pending approvals lapse after a day instead of waiting forever, and the session card tells the agent about the rest", () => {
  let clock = new Date("2026-09-20T12:00:00Z");
  const store = createLocalStore(mkdtempSync(join(tmpdir(), "m9r-n5-clock-")), { now: () => clock });
  store.addTask({ from: "claude", to: "codex", goal: "Review lease.ts", origin: "agent_initiated", idempotencyKey: "a" });
  assert.equal(store.pendingApprovals().length, 1);
  assert.match(renderSessionCard({ handle: "claude", others: [], pendingCount: 0, awaitingApproval: 1 }), /1 task\(s\) are waiting for the user's approval/);
  assert.doesNotMatch(renderSessionCard({ handle: "claude", others: [], pendingCount: 0 }), /approval/);
  clock = new Date("2026-09-21T13:00:00Z");
  assert.equal(store.pendingApprovals().length, 0);
  assert.deepEqual(store.sweepExpired(), ["T1"]);
  assert.equal(store.getTask("T1")?.approval, "expired");
});

test("`tasks` lists what is waiting and how far each task got", async () => {
  const s = sandbox({ terminal: true });
  s.store.addTask({ from: "claude", to: "codex", goal: "Review lease.ts", origin: "agent_initiated", idempotencyKey: "a" });
  s.store.addTask({ from: "you", to: "codex", goal: "Say hi", origin: "human_typed", idempotencyKey: "b" });
  assert.equal(await s.run("tasks"), 0);
  const text = s.out.join("\n");
  assert.match(text, /T1 {2}@claude -> @codex {2}\[awaiting approval\]/);
  assert.match(text, /T2 {2}@you -> @codex {2}\[in the inbox\]/);
  assert.match(text, /1 waiting for you/);
});
