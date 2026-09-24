import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedAgentLaunchPlan, buildHostedWakePlan, initialHostedSessionState, normalizeProjectFolder, transitionHostedSessions, type HostedAgentKey, type HostedAgentSession } from "@/lib/native/hosted-agent-session-core";

const key: HostedAgentKey = { roomId: "room-a", projectFolder: "C:\\Work\\M9R", vendor: "codex", agentId: "codex-main" };
const ensure = (state = initialHostedSessionState(), id = "s1", overrides: Partial<HostedAgentKey> = {}) => transitionHostedSessions(state, { type: "ensure", key: { ...key, ...overrides }, sessionId: id, now: 1_000 });

test("project folders normalize by platform without merging case-sensitive POSIX paths", () => {
  assert.equal(normalizeProjectFolder("C:\\Work\\M9R\\", "win32"), "c:/work/m9r");
  assert.equal(normalizeProjectFolder("/work/M9R/", "linux"), "/work/M9R");
  assert.notEqual(normalizeProjectFolder("/work/M9R", "linux"), normalizeProjectFolder("/work/m9r", "linux"));
  assert.equal(normalizeProjectFolder("relative/project", "linux"), null);
});

test("ensure starts one logical agent session and subsequent ensure reuses it instead of spawning a duplicate", () => {
  const started = ensure();
  assert.equal(started.ok, true);
  assert.equal(started.action, "started");
  assert.equal(started.state.sessions.length, 1);
  assert.equal(started.state.sessions[0].projectFolder, "c:/work/m9r");
  const repeated = ensure(started.state, "different-new-id");
  assert.equal(repeated.ok, true);
  assert.equal(repeated.action, "reused");
  assert.equal(repeated.state.sessions.length, 1);
  assert.equal(repeated.session?.id, "s1");
});

test("separate projects, rooms, or logical agents may each have their own live session", () => {
  const first = ensure();
  const second = ensure(first.state, "s2", { projectFolder: "C:\\Work\\Other" });
  const third = ensure(second.state, "s3", { roomId: "room-b" });
  assert.equal(third.ok, true);
  assert.equal(third.state.sessions.length, 3);
});

test("an ambiguous duplicate live registry fails closed rather than choosing one", () => {
  const first = ensure();
  const original = first.state.sessions[0];
  const duplicate = { ...original, id: "duplicate" };
  const corrupted = { sessions: [original, duplicate] };
  const result = ensure(corrupted, "new");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /multiple live sessions/);
  assert.equal(result.state, corrupted);
});

test("ready, idle sweep, and wake preserve the same vendor session while incrementing resume count", () => {
  const started = ensure();
  const ready = transitionHostedSessions(started.state, { type: "ready", id: "s1", ptySessionId: "pty-1", vendorSessionId: "thread-1", now: 2_000 });
  assert.equal(ready.action, "ready");
  const slept = transitionHostedSessions(ready.state, { type: "idle-sweep", now: 30_000, idleAfterMs: 10_000 });
  assert.equal(slept.action, "slept");
  assert.equal(slept.session?.status, "sleeping");
  const woke = transitionHostedSessions(slept.state, { type: "wake", id: "s1", now: 31_000 });
  assert.equal(woke.action, "waking");
  assert.equal(woke.session?.status, "starting");
  assert.equal(woke.session?.vendorSessionId, "thread-1");
  assert.equal(woke.session?.ptySessionId, "pty-1");
  assert.equal(woke.session?.resumeCount, 1);
});

test("activity refreshes the idle clock and a non-expired session is not put to sleep", () => {
  const started = ensure();
  const ready = transitionHostedSessions(started.state, { type: "ready", id: "s1", ptySessionId: "pty-1", now: 2_000 });
  const active = transitionHostedSessions(ready.state, { type: "activity", id: "s1", now: 25_000 });
  const sweep = transitionHostedSessions(active.state, { type: "idle-sweep", now: 30_000, idleAfterMs: 10_000 });
  assert.equal(sweep.action, "unchanged");
  assert.equal(sweep.session?.status, "active");
});

test("wake refuses a starting session instead of treating it as a successful resume", () => {
  const started = ensure();
  const wake = transitionHostedSessions(started.state, { type: "wake", id: "s1", now: 2_000 });
  assert.equal(wake.ok, false);
  assert.equal(wake.action, "unchanged");
  assert.equal(wake.session?.status, "starting");
});

test("sleeping and terminal states cannot be revived by activity or a late ready event", () => {
  const started = ensure();
  const ready = transitionHostedSessions(started.state, { type: "ready", id: "s1", now: 2_000 });
  const slept = transitionHostedSessions(ready.state, { type: "idle-sweep", now: 20_000, idleAfterMs: 10_000 });
  const activity = transitionHostedSessions(slept.state, { type: "activity", id: "s1", now: 21_000 });
  assert.equal(activity.ok, false);
  assert.equal(activity.session?.status, "sleeping");
  const stopped = transitionHostedSessions(slept.state, { type: "stop", id: "s1", now: 22_000 });
  const lateReady = transitionHostedSessions(stopped.state, { type: "ready", id: "s1", now: 23_000 });
  assert.equal(lateReady.ok, false);
  assert.equal(lateReady.session?.status, "stopped");
  assert.equal(lateReady.state.sessions[0].status, "stopped");
});

test("stopped and failed sessions release the live slot but remain in history", () => {
  const started = ensure();
  const stopped = transitionHostedSessions(started.state, { type: "stop", id: "s1", now: 2_000 });
  const replacement = ensure(stopped.state, "s2");
  assert.equal(replacement.action, "started");
  const failed = transitionHostedSessions(replacement.state, { type: "fail", id: "s2", reason: "spawn_failed", now: 3_000 });
  assert.equal(failed.session?.status, "failed");
  assert.equal(failed.session?.failureCode, "spawn_failed");
  assert.equal(failed.state.sessions.length, 2);
});

test("launch plans keep project path and resume IDs in separate argv entries and keep tokens out of argv", () => {
  const config = { projectFolder: "C:\\Work\\M9R", profile: "web-only" as const, mcpConfigPath: "C:\\tmp\\mcp.json", promptFile: "C:\\tmp\\prompt.txt", mcpCommand: "C:\\node.exe", mcpArgs: ["mcp.js"], mcpEnv: {}, sessionToken: "secret-token" };
  const claude = buildHostedAgentLaunchPlan({ ...config, vendor: "claude", resumeSessionId: "claude-session-1" });
  assert.equal(claude.command, "claude");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--resume"), claude.args.indexOf("--resume") + 2), ["--resume", "claude-session-1"]);
  assert.equal(claude.args.join(" ").includes("secret-token"), false);
  const codex = buildHostedAgentLaunchPlan({ ...config, vendor: "codex" });
  assert.equal(codex.command, "codex");
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--cd"), codex.args.indexOf("--cd") + 2), ["--cd", "c:/work/m9r"]);
  assert.equal(codex.args.join(" ").includes("secret-token"), false);
});

test("wake plans use Codex queue or authenticated Claude PTY input without pretending either runtime is wired", () => {
  const codex = buildHostedWakePlan({ vendor: "codex", threadId: "123e4567-e89b-12d3-a456-426614174000", text: "review the failing check" });
  assert.deepEqual(codex, { ok: true, plan: { kind: "codex-queue", command: "codex", args: ["queue", "--thread", "123e4567-e89b-12d3-a456-426614174000", "--message", "review the failing check"] } });
  const claude = buildHostedWakePlan({ vendor: "claude", marker: "M9R-USER-abcdefgh1234", text: "stop and explain" });
  assert.equal(claude.ok, true);
  assert.equal(claude.ok && claude.plan.kind, "claude-pty-input");
  if (claude.ok && claude.plan.kind === "claude-pty-input") {
    assert.equal(JSON.parse(claude.plan.line).message.content[0].text, "[M9R-USER-abcdefgh1234] stop and explain");
  }
  assert.equal(buildHostedWakePlan({ vendor: "codex", threadId: "not-a-thread", text: "hello" }).ok, false);
});

test("hosted session records never accept arbitrary terminal output as a failure detail", () => {
  const started = ensure();
  const safe: HostedAgentSession = started.state.sessions[0];
  assert.equal("output" in safe, false);
  assert.equal("failureDetail" in safe, false);
});
