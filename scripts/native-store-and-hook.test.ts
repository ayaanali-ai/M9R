import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore, defaultStoreRoot, handleForProvider, RESULT_RECONCILIATION_MAX_AGE_MS } from "@/lib/native/local-store";
import { handleHookEvent, routeTypedMentions } from "@/lib/native/hook-handler";
import { normalizeHandle, renderInboxInjection } from "@/lib/native/inbox-core";
import { CODEX_WEB_PREFACE, webAgentPrompt } from "@/lib/native/web-live-sessions";
import { isBrokerAgentPrompt } from "@/lib/native/codex-delivery-core";
import { applyAgentMcpStoreMutation } from "@/lib/native/web-broker-server";

function tempStore(now?: () => Date) {
  const root = mkdtempSync(join(tmpdir(), "m9r-store-"));
  return { root, store: createLocalStore(root, { now }), done: () => rmSync(root, { recursive: true, force: true }) };
}
const task = (over: Record<string, unknown> = {}) => ({ from: "codex", to: "claude", goal: "look at the reconnect bug", origin: "human_typed" as const, idempotencyKey: "k1", ...over });

test("provider names map to friendly handles", () => {
  assert.equal(handleForProvider("claude-code"), "claude");
  assert.equal(handleForProvider("Codex"), "codex");
  assert.equal(handleForProvider("My Tool!"), "my-tool");
  assert.equal(handleForProvider("!!!"), "agent");
  assert.equal(normalizeHandle("@CLAUDE"), "claude");
  assert.equal(normalizeHandle("@@CLAUDE"), "@claude", "normalization removes exactly one leading mention marker");
  assert.equal(defaultStoreRoot("/home/u", {}), join("/home/u", ".m9r"));
  assert.equal(defaultStoreRoot("/home/u", { M9R_HOME: "/tmp/x" }), "/tmp/x");
});

test("provider delivery refusal keeps the durable task id out of ordinary prompt text", () => {
  const { store, done } = tempStore();
  const refusal = handleHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "source-session",
    cwd: "/repo",
    prompt: "@codex review the current change",
  }, { ...ctx(store), strictTargetIdentity: true });
  const text = ctxOf(refusal) ?? "";
  assert.match(text, /could not deliver your message to @codex/i);
  assert.doesNotMatch(text, /T1|task\s+id/i);
  assert.equal(store.tasksFor("codex")[0]?.delivery?.state, "failed", "the internal failure record remains durable");
  done();
});

test("agent sessions are keyed by agent, normalized folder, and provider session id", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "claude-code", sessionId: "same-session", cwd: "C:\\Work\\One\\" });
  store.registerEndpoint({ provider: "claude-code", sessionId: "same-session", cwd: "c:/work/one" });
  store.registerEndpoint({ provider: "claude-code", sessionId: "same-session", cwd: "C:\\Work\\Two" });

  assert.equal(store.sessionsFor("claude").length, 2, "same id in two folders must remain two sessions; path spelling aliases within a folder should dedupe");
  assert.equal(store.sessionsFor("claude", "c:/work/one").length, 1);
  assert.equal(store.sessionsFor("claude", "C:\\Work\\Two")[0].cwd, "c:/work/two");
  done();
});

test("inbox cursors are folder scoped when the same agent session id is observed in distinct folders", () => {
  const { store, done } = tempStore();
  store.setCursor("claude", "shared-id", 4, "C:\\Work\\One");
  store.setCursor("claude", "shared-id", 2, "C:\\Work\\Two");
  assert.equal(store.cursorFor("claude", "shared-id", "c:/work/one"), 4);
  assert.equal(store.cursorFor("claude", "shared-id", "C:\\Work\\Two"), 2);
  assert.equal(store.cursorFor("claude", "shared-id"), 0, "scoped cursors must not leak into the legacy agent/session key");
  done();
});

test("an already claimed session does not receive the same task again through another cwd", () => {
  const { store, done } = tempStore();
  const created = store.addTask(task({ idempotencyKey: "folder-scope-hook" }));
  const one = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "same", cwd: "C:\\Work\\One", prompt: "hello" }, ctx(store));
  const two = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "same", cwd: "C:\\Work\\Two", prompt: "hello" }, ctx(store));
  assert.match(ctxOf(one) ?? "", /look at the reconnect bug/);
  assert.equal(two, null, "the provider session id is the task owner even when its cursor is project-scoped");
  assert.equal(store.getTask(created.task.id)?.deliveredSession, "same");
  assert.equal(store.cursorFor("claude", "same", "C:\\Work\\One"), 1);
  assert.equal(store.cursorFor("claude", "same", "C:\\Work\\Two"), 1, "the second cursor advances past work already delivered to this session");
  done();
});

test("tasks get sequential ids and per-inbox sequence numbers, and the same key never creates a second task", () => {
  const { store, done } = tempStore();
  const a = store.addTask(task());
  const b = store.addTask(task({ idempotencyKey: "k2" }));
  const dup = store.addTask(task());
  assert.equal(a.task.id, "T1"); assert.equal(a.task.seq, 1); assert.equal(a.created, true);
  assert.equal(b.task.id, "T2"); assert.equal(b.task.seq, 2);
  assert.equal(dup.created, false); assert.equal(dup.task.id, "T1");
  assert.equal(store.addTask(task({ to: "codex", idempotencyKey: "k3" })).task.seq, 1, "each inbox counts on its own");
  assert.equal(store.tasksFor("claude").length, 2);
  done();
});

test("a resolved idempotency match does not swallow a deliberate resend of identical pill text", () => {
  const { store, done } = tempStore();
  const first = store.addTask(task({ idempotencyKey: "paste-repeat" }));
  store.setResult(first.task.id, "the first identical message was already handled");
  const resent = store.addTask(task({ idempotencyKey: "paste-repeat" }));
  assert.equal(resent.created, true, "a pasted resend must create a fresh task after the old one resolved");
  assert.notEqual(resent.task.id, first.task.id);
  done();
});

test("recipient handles are normalized before task storage, inbox lookup and idempotency checks", () => {
  const { store, done } = tempStore();
  const created = store.addTask(task({ to: "@CLAUDE" }));
  assert.equal(created.task.to, "claude");
  assert.equal(store.tasksFor("claude").length, 1);
  assert.equal(store.tasksFor("@CLAUDE").length, 1);
  const duplicate = store.addTask(task({ to: "claude" }));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, created.task.id);
  done();
});

test("state survives a new store instance on the same folder, cursors are per session and only move forward", () => {
  const { root, store, done } = tempStore();
  store.addTask(task());
  store.setCursor("claude", "s1", 5);
  store.setCursor("claude", "s1", 3);
  const again = createLocalStore(root);
  assert.equal(again.getTask("T1")?.goal, "look at the reconnect bug");
  assert.equal(again.cursorFor("claude", "s1"), 5);
  assert.equal(again.cursorFor("claude", "other"), 0, "a different Claude session must not have its own notification silently eaten by another session's cursor");
  assert.equal(again.cursorFor("codex", "s1"), 0);
  done();
});

test("an untargeted task is claimed by one Claude session and cannot be answered from a different session", () => {
  const { store, done } = tempStore();
  const created = store.addTask({ from: "codex", to: "claude", goal: "check the build", origin: "human_typed", idempotencyKey: "k1" });
  const a = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session-a", cwd: "/repo", prompt: "hi" }, ctx(store));
  assert.match(ctxOf(a) ?? "", /check the build/);
  assert.equal(store.getTask(created.task.id)?.deliveredSession, "session-a");
  const b = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session-b", cwd: "/repo", prompt: "hi" }, ctx(store));
  assert.equal(b, null, "a different provider session must not receive work already claimed by session A");
  assert.equal(store.getTask(created.task.id)?.deliveredSession, "session-a");
  done();
});

test("an explicit target session repairs a stale deliveredSession from an older build", () => {
  const { root, store, done } = tempStore();
  const target = store.issueIdentity("claude", "claude-code", "target-session");
  const task = store.addTask({ from: "codex", to: "claude", goal: "continue the task", origin: "human_typed", targetSession: "target-session", idempotencyKey: "stale-target-delivery" });
  const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as { tasks: Array<Record<string, unknown>> };
  state.tasks[0].deliveredAt = new Date().toISOString();
  state.tasks[0].deliveredSession = "old-session";
  writeFileSync(join(root, "state.json"), JSON.stringify(state), "utf8");

  assert.equal(store.tasksForSession("claude", "old-session").length, 0);
  assert.equal(store.tasksForSession("claude", "target-session").length, 1);
  const claimed = store.claimInboxTasks("claude", "target-session", [task.task.id], "/repo");
  assert.equal(claimed.length, 1);
  assert.equal(store.getTask(task.task.id)?.deliveredSession, "target-session");
  const result = applyAgentMcpStoreMutation(store, { action: "result", token: target.token, taskId: task.task.id, summary: "done" });
  assert.equal(result.status, 200);
  done();
});

test("approvals and results are stored, results are capped and redacted", () => {
  const { store, done } = tempStore();
  store.addTask(task({ origin: "agent_initiated" }));
  assert.equal(store.getTask("T1")?.approval, "pending");
  store.setApproval("T1", "approved");
  assert.equal(store.getTask("T1")?.approval, "approved");
  store.setResult("T1", "done, used token=abcdef123456 " + "z".repeat(600));
  const r = store.getTask("T1")?.resultSummary ?? "";
  assert.equal(r.length <= 400, true);
  assert.doesNotMatch(r, /abcdef123456/);
  done();
});

test("an unapproved provider task is not claimed before approval and becomes deliverable afterward", () => {
  const clock = () => new Date("2026-09-20T12:00:00Z");
  const { store, done } = tempStore(clock);
  const pending = store.addTask({
    from: "codex", to: "claude", goal: "open the settings app", origin: "agent_initiated", idempotencyKey: "approval-frontier",
  }).task;
  const first = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd: "/repo", prompt: "continue" }, ctx(store));
  assert.doesNotMatch(ctxOf(first) ?? "", /open the settings app/, "pending work must not leak into the provider prompt");
  assert.equal(store.getTask(pending.id)?.deliveredAt, undefined, "pending work must not acquire a delivery receipt");
  assert.equal(store.cursorFor("claude", "claude-session", "/repo"), 0, "pending work must not advance the inbox cursor");

  store.setApproval(pending.id, "approved");
  const second = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd: "/repo", prompt: "continue" }, ctx(store));
  assert.match(ctxOf(second) ?? "", /open the settings app/, "approval must make the same task deliverable");
  assert.equal(store.getTask(pending.id)?.deliveredSession, "claude-session");
  done();
});

test("a corrupt state file fails closed without losing identity or resetting task ids", () => {
  const { root, store, done } = tempStore();
  store.addTask(task());
  writeFileSync(join(root, "state.json"), "{ not json", "utf8");
  assert.throws(() => store.tasksFor("claude"), /M9R local state.*invalid/);
  assert.throws(() => store.addTask(task()), /M9R local state.*invalid/);
  assert.equal(readFileSync(join(root, "state.json"), "utf8"), "{ not json");
  done();
});

test("a newer state version is preserved and cannot be overwritten by an older runtime", () => {
  const { root, store, done } = tempStore();
  const original = JSON.stringify({ version: 2, identities: [{ secret: "preserve" }] });
  writeFileSync(join(root, "state.json"), original);
  assert.throws(() => store.addTask(task()), /unsupported version/);
  assert.equal(readFileSync(join(root, "state.json"), "utf8"), original);
  done();
});

test("an aged lock is preserved instead of stealing ownership from another writer", () => {
  const { root, store, done } = tempStore();
  mkdirSync(join(root, "state.lock"));
  writeFileSync(join(root, "state.lock", "owner-abc.json"), JSON.stringify({ pid: process.pid, nonce: "live-owner" }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(root, "state.lock"), old, old);
  assert.throws(() => store.addTask(task()), /lock was preserved/);
  assert.equal(JSON.parse(readFileSync(join(root, "state.lock", "owner-abc.json"), "utf8")).nonce, "live-owner");
  done();
});

test("a lock with a demonstrably dead owner recovers without resetting the state", () => {
  const { root, store, done } = tempStore();
  store.addTask(task());
  mkdirSync(join(root, "state.lock"));
  writeFileSync(join(root, "state.lock", "owner-abc.json"), JSON.stringify({ pid: 2147483647, nonce: "dead-owner" }));
  assert.equal(store.addTask(task({ idempotencyKey: "after-crash" })).task.id, "T2");
  done();
});

// ---- hook handler ----------------------------------------------------------------------------------------------

// Direct hook-handler tests represent a provider hook whose session metadata
// has already been verified by hook-run.ts. Production callers supply the same
// trust bit (or the provider parent PID); keeping it explicit here prevents a
// unit fixture from exercising the intentionally untrusted/held path by
// accident.
const ctx = (store: ReturnType<typeof createLocalStore>, provider = "claude-code", pathExists: (p: string) => boolean = () => false) => ({ provider, store, pathExists, sessionMetadataVerified: true, now: () => new Date("2026-09-20T12:00:00Z") });
const ctxOf = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const hookSpecificOutput = (value as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  if (!hookSpecificOutput || typeof hookSpecificOutput !== "object") return undefined;
  const additionalContext = (hookSpecificOutput as { additionalContext?: unknown }).additionalContext;
  return typeof additionalContext === "string" ? additionalContext : undefined;
};

test("SessionStart registers the endpoint and prints a short card that lists recently active others", () => {
  const { store, done } = tempStore(() => new Date("2026-09-20T11:58:00Z"));
  store.registerEndpoint({ provider: "codex", sessionId: "c1" });
  const out = handleHookEvent({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" }, ctx(store));
  assert.equal(out?.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctxOf(out)!, /M9R connected as @claude\./);
  assert.match(ctxOf(out)!, /Active now: @codex/);
  assert.equal(store.listEndpoints().some((e) => e.handle === "claude"), true);
  done();
});

test("SessionStart does not expose CLI polling instructions for pending work", () => {
  const { store, done } = tempStore();
  store.addTask({
    from: "codex",
    to: "claude",
    goal: "Review the harmless verification.",
    origin: "agent_initiated",
    idempotencyKey: "session-card-pending",
  });
  const out = handleHookEvent({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" }, ctx(store));
  const card = ctxOf(out) ?? "";
  assert.match(card, /pending|authorized|delivered/i);
  assert.doesNotMatch(card, /m9r-cli tasks|task ID/i);
  done();
});

test("repeated SessionStart for the same session keeps its token valid, while explicit revocation allows a fresh token", () => {
  const { store, done } = tempStore();
  const start = () => handleHookEvent({ hook_event_name: "SessionStart", session_id: "resume-me", cwd: "/repo" }, ctx(store));
  const extractToken = (out: unknown) => {
    const match = /M9R session token[^:]*: ([A-Za-z0-9_-]{32})/.exec(ctxOf(out) ?? "");
    assert.ok(match, "SessionStart must include the session identity token");
    return match[1];
  };

  const firstToken = extractToken(start());
  const resumedToken = extractToken(start());
  assert.equal(resumedToken, firstToken, "resuming a provider session must not invalidate its earlier SessionStart card");
  assert.notEqual(store.verifyIdentity(firstToken), null);

  store.revokeIdentity("resume-me");
  const afterRevoke = extractToken(start());
  assert.notEqual(afterRevoke, firstToken, "a revoked identity must be replaced when the provider session reconnects");
  assert.equal(store.verifyIdentity(firstToken), null);
  assert.notEqual(store.verifyIdentity(afterRevoke), null);
  done();
});

test("a compacted SessionStart carries the private binding forward on the same provider process", () => {
  const { store, root, done } = tempStore();
  const context = { ...ctx(store), providerProcessId: 4242 };
  try {
    handleHookEvent({ hook_event_name: "SessionStart", session_id: "before-compaction", cwd: "C:/repo" }, context);
    const before = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as {
      connectionClaims: Array<{ claimId: string }>;
    };
    const binding = store.bindConnectionClaim(before.connectionClaims[0]!.claimId, { provider: "claude-code", processId: 4242 });
    assert.ok(binding);

    handleHookEvent({ hook_event_name: "SessionStart", session_id: "after-compaction", cwd: "C:/repo" }, context);
    const after = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as {
      connectionClaims: Array<{ sessionId: string; bindingId?: string }>;
      connectionBindings: Array<{ sessionId: string; bindingId: string }>;
    };
    assert.deepEqual(after.connectionClaims.map((claim) => claim.sessionId), ["after-compaction"]);
    assert.equal(after.connectionClaims[0]!.bindingId, binding!.bindingId);
    assert.deepEqual(after.connectionBindings.map((candidate) => candidate.sessionId), ["after-compaction"]);
    assert.equal(store.identityTokenFor("claude", "before-compaction"), null);
  } finally { done(); }
});

test("an already-open Codex session restores its missing identity on the next trusted prompt", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "codex", sessionId: "codex-open", cwd: "C:/repo" });
  assert.equal(store.identityTokenFor("codex", "codex-open"), null);

  const result = handleHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-open",
    cwd: "C:/repo",
    prompt: "continue",
  }, ctx(store, "codex"));

  assert.ok(store.identityTokenFor("codex", "codex-open"));
  assert.match(ctxOf(result) ?? "", /M9R connected as @codex/);
  assert.match(ctxOf(result) ?? "", /M9R session token/);
  done();
});

test("OpenCode polling pushes only an approved, fresh task into its exact authenticated session and acknowledges once", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const { store, done } = tempStore(() => now);
  store.registerEndpoint({ provider: "opencode", sessionId: "oc-1", cwd: "C:/repo" });
  const identity = store.issueIdentity("opencode", "opencode", "oc-1");
  const pinned = store.addTask({
    from: "codex", to: "opencode", goal: "review the shared change", origin: "human_typed",
    cwd: "C:/repo", targetSession: "oc-1", idempotencyKey: "opencode-live-prompt",
  }).task;
  const pending = store.addTask({
    from: "claude", to: "opencode", goal: "publish the announcement", origin: "agent_initiated",
    cwd: "C:/repo", targetSession: "oc-1", idempotencyKey: "opencode-live-approval",
  }).task;
  const context = { ...ctx(store, "opencode"), now: () => now };
  const poll = (session = "oc-1") => handleHookEvent({ hook_event_name: "OpenCodePoll", session_id: session, cwd: "C:/repo" }, context);

  const offered = poll();
  assert.equal(offered?.hookSpecificOutput.hookEventName, "OpenCodePoll");
  const envelope = JSON.parse(ctxOf(offered)!) as { task_id: string; prompt: string };
  assert.equal(envelope.task_id, pinned.id);
  assert.equal(envelope.prompt, pinned.goal, "OpenCode receives only the owner's task text");
  assert.doesNotMatch(envelope.prompt, new RegExp(pinned.id), "task correlation stays in the envelope");
  assert.doesNotMatch(envelope.prompt, new RegExp(identity.token), "the session credential stays in trusted adapter context");
  assert.equal(store.getTask(pinned.id)?.delivery?.state, "sending", "the durable claim prevents a second prompt while acceptance is unconfirmed");
  assert.equal(store.cursorFor("opencode", "oc-1", "C:/repo"), pinned.seq);
  assert.equal(poll(), null, "an unacknowledged offer is still delivered at most once");
  assert.equal(poll("different-session"), null, "a pinned task never leaks into another OpenCode session");

  const ack = handleHookEvent({ hook_event_name: "OpenCodeDelivered", session_id: "oc-1", cwd: "C:/repo", task_id: pinned.id }, context);
  assert.deepEqual(JSON.parse(ctxOf(ack)!), { accepted: true, task_id: pinned.id });
  assert.equal(store.getTask(pinned.id)?.delivery?.state, "queued");
  assert.equal(store.getTask(pinned.id)?.deliveredSession, "oc-1");
  assert.equal(store.cursorFor("opencode", "oc-1", "C:/repo"), pinned.seq);
  assert.deepEqual(JSON.parse(ctxOf(handleHookEvent({ hook_event_name: "OpenCodeDelivered", session_id: "oc-1", cwd: "C:/repo", task_id: pinned.id }, context))!), { accepted: true, task_id: pinned.id }, "ack retry is idempotent");
  assert.equal(poll(), null, "acknowledged work is not prompted a second time");

  assert.equal(poll(), null, "agent work stays blocked while approval is pending");
  store.setApproval(pending.id, "approved");
  const approved = JSON.parse(ctxOf(poll())!) as { task_id: string; prompt: string };
  assert.equal(approved.task_id, pending.id);
  assert.match(approved.prompt, /publish the announcement/);

  // The dedicated task pump owns the cursor once it claims a task; an unrelated provider prompt does not.
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "oc-1", cwd: "C:/repo", prompt: "ordinary prompt" }, context), null);
  assert.equal(store.cursorFor("opencode", "oc-1", "C:/repo"), pending.seq);
  done();
});

test("OpenCode polling ignores a queued task beyond the inbox freshness window", () => {
  let clock = new Date("2026-10-07T12:00:00Z");
  const { store, done } = tempStore(() => clock);
  store.registerEndpoint({ provider: "opencode", sessionId: "oc-current", cwd: "C:/repo" });
  store.issueIdentity("opencode", "opencode", "oc-current");
  const task = store.addTask({
    from: "codex", to: "opencode", goal: "historical OpenCode work", origin: "human_typed",
    cwd: "C:/repo", targetSession: "oc-current", idempotencyKey: "opencode-history-fence",
  }).task;
  clock = new Date(clock.getTime() + 31 * 60_000);
  const context = { ...ctx(store, "opencode"), now: () => clock };
  assert.equal(
    handleHookEvent({ hook_event_name: "OpenCodePoll", session_id: "oc-current", cwd: "C:/repo" }, context),
    null,
    "a current authenticated session must not receive a historical queued task",
  );
  assert.equal(store.getTask(task.id)?.delivery, undefined, "the stale task must remain history, not become claimed work");
  done();
});

test("a late OpenCode provider failure closes an already queued task as terminally failed", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const { store, done } = tempStore(() => now);
  store.registerEndpoint({ provider: "opencode", sessionId: "oc-failure", cwd: "C:/repo" });
  store.issueIdentity("opencode", "opencode", "oc-failure");
  const task = store.addTask({
    from: "codex", to: "opencode", goal: "exercise late provider failure", origin: "human_typed",
    cwd: "C:/repo", targetSession: "oc-failure", idempotencyKey: "opencode-late-failure",
  }).task;
  const context = { ...ctx(store, "opencode"), now: () => now };
  const offered = handleHookEvent({ hook_event_name: "OpenCodePoll", session_id: "oc-failure", cwd: "C:/repo" }, context);
  assert.ok(offered);
  assert.ok(handleHookEvent({ hook_event_name: "OpenCodeDelivered", session_id: "oc-failure", cwd: "C:/repo", task_id: task.id }, context));
  assert.equal(store.getTask(task.id)?.delivery?.state, "queued");

  const failed = handleHookEvent({
    hook_event_name: "OpenCodeExecutionFailed",
    session_id: "oc-failure",
    cwd: "C:/repo",
    task_id: task.id,
    execution_error: "provider_execution_failed",
  }, context);
  assert.ok(failed, "the execution failure must be acknowledged by the local hook");
  const recorded = store.getTask(task.id);
  assert.ok(recorded?.lifecycle);
  assert.equal(recorded.lifecycle.state, "failed");
  assert.match(recorded.lifecycle.error ?? "", /OpenCode provider execution failed/);
  done();
});

test("an OpenCode delivery acknowledgement cannot resurrect an expired offer", () => {
  let clock = new Date("2026-10-07T12:00:00Z");
  const { store, done } = tempStore(() => clock);
  store.registerEndpoint({ provider: "opencode", sessionId: "oc-expired", cwd: "C:/repo" });
  store.issueIdentity("opencode", "opencode", "oc-expired");
  const task = store.addTask({
    from: "codex", to: "opencode", goal: "expired OpenCode offer", origin: "human_typed",
    cwd: "C:/repo", targetSession: "oc-expired", idempotencyKey: "opencode-expired-ack",
  }).task;
  const context = { ...ctx(store, "opencode"), now: () => clock };
  const offered = handleHookEvent({ hook_event_name: "OpenCodePoll", session_id: "oc-expired", cwd: "C:/repo" }, context);
  assert.ok(offered);
  assert.equal(store.getTask(task.id)?.delivery?.state, "sending");

  clock = new Date(clock.getTime() + 31 * 60_000);
  assert.equal(
    handleHookEvent({ hook_event_name: "OpenCodeDelivered", session_id: "oc-expired", cwd: "C:/repo", task_id: task.id }, context),
    null,
    "a delayed provider acknowledgement must not turn an expired offer into live queued work",
  );
  assert.equal(store.getTask(task.id)?.delivery?.state, "sending");
  done();
});

test("a stale prompt delivery cannot reclaim a later Claude turn", () => {
  let clock = new Date("2026-10-07T12:00:00Z");
  const { store, done } = tempStore(() => clock);
  const taskRecord = store.addTask({
    from: "codex", to: "claude", goal: "continue the old provider task", origin: "human_typed",
    cwd: "C:/repo", targetSession: "claude-session", idempotencyKey: "stale-prompt-context",
  }).task;
  store.issueIdentity("claude", "claude-code", "claude-session");
  const context = { ...ctx(store), now: () => clock };
  const delivered = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd: "C:/repo", prompt: "ordinary prompt" }, context);
  assert.match(ctxOf(delivered) ?? "", /continue the old provider task/);

  clock = new Date(clock.getTime() + RESULT_RECONCILIATION_MAX_AGE_MS + 1);
  const stale = handleHookEvent({
    hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd: "C:/repo", prompt: taskRecord.goal, task_id: taskRecord.id,
  }, context);
  assert.equal(stale, null, "a delivery older than the reconciliation window must not be reattached to a later turn");
  done();
});

test("a stale authenticated OpenCode session cannot block the current session's unpinned task", () => {
  let clock = new Date("2026-10-07T11:00:00Z");
  const { store, done } = tempStore(() => clock);
  store.registerEndpoint({ provider: "opencode", sessionId: "closed", cwd: "C:/repo" });
  store.issueIdentity("opencode", "opencode", "closed");
  clock = new Date("2026-10-07T12:00:00Z");
  store.registerEndpoint({ provider: "opencode", sessionId: "current", cwd: "C:/repo" });
  store.issueIdentity("opencode", "opencode", "current");
  const task = store.addTask({ from: "you", to: "opencode", goal: "show the cursor", origin: "human_typed", cwd: "C:/repo", idempotencyKey: "stale-session" }).task;
  const context = { ...ctx(store, "opencode"), now: () => clock };
  const output = handleHookEvent({ hook_event_name: "OpenCodePoll", session_id: "current", cwd: "C:/repo" }, context);
  assert.equal(JSON.parse(ctxOf(output)!).task_id, task.id);
  handleHookEvent({ hook_event_name: "OpenCodeDelivered", session_id: "current", cwd: "C:/repo", task_id: task.id }, context);
  assert.equal(store.getTask(task.id)?.deliveredSession, "current");
  done();
});

test("OpenCode live task acknowledgement refuses revoked identities, denied approvals, and another project", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const { store, done } = tempStore(() => now);
  store.registerEndpoint({ provider: "opencode", sessionId: "oc-1", cwd: "C:/repo" });
  store.issueIdentity("opencode", "opencode", "oc-1");
  const taskRecord = store.addTask({
    from: "codex", to: "opencode", goal: "inspect this project", origin: "human_typed",
    cwd: "C:/other", targetSession: "oc-1", idempotencyKey: "wrong-project",
  }).task;
  const context = { ...ctx(store, "opencode"), now: () => now };
  assert.equal(handleHookEvent({ hook_event_name: "OpenCodePoll", session_id: "oc-1", cwd: "C:/repo" }, context), null);
  assert.equal(handleHookEvent({ hook_event_name: "OpenCodeDelivered", session_id: "oc-1", cwd: "C:/repo", task_id: taskRecord.id }, context), null);
  assert.equal(store.getTask(taskRecord.id)?.delivery, undefined);
  store.revokeIdentity("oc-1");
  assert.equal(handleHookEvent({ hook_event_name: "OpenCodePoll", session_id: "oc-1", cwd: "C:/other" }, context), null);
  done();
});

test("a typed mention creates a task for the target and tells the sender not to do the work", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "codex" });
  const out = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "@codex investigate the relay reconnect bug" }, ctx(store));
  const t = store.tasksFor("codex");
  assert.equal(t.length, 1);
  assert.equal(t[0].goal, "investigate the relay reconnect bug");
  assert.equal(t[0].from, "claude");
  assert.equal(t[0].origin, "human_typed");
  // No dispatch is wired in this ctx, so no push is attempted: the ack must say held, not sent.
  assert.match(ctxOf(out)!, /held your message to @codex/);
  assert.match(ctxOf(out)!, /do not do that work yourself/i);
  done();
});

test("a generated workspace envelope cannot create human-typed mention tasks", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "claude-code", sessionId: "claude-session", cwd: "/repo" });
  const result = routeTypedMentions({
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-session",
    cwd: "/repo",
    prompt: [
      "@claude review the generated workspace result",
      "[M9R generated workspace envelope v1]",
      "This is provider-generated workspace context, not a human prompt.",
    ].join("\n"),
  }, { provider: "codex", store, pathExists: () => false });
  assert.deepEqual(result, { acks: [], tasks: [] });
  assert.equal(store.tasksFor("claude").length, 0);
  done();
});

test("a mention states the true delivery state: pushed, inbox pickup, or held", () => {
  const { store, done } = tempStore();
  const dispatched: string[] = [];
  const wire = (provider: string) => ({ provider, store, pathExists: () => false, readIndex: () => null, dispatch: (id: string) => dispatched.push(id) });
  // Pushed: @codex mentioned from claude, with a queue push attempted live.
  const pushed = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "@codex review the relay" }, wire("claude-code"));
  assert.match(ctxOf(pushed)!, /already sent your message to @codex/);
  assert.equal(dispatched.length, 1);
  // Inbox pickup: a live claude session exists, but nothing pushes to it mid-turn.
  // (Sent from codex so @claude is another agent, not a self-mention.)
  store.registerEndpoint({ provider: "claude-code", sessionId: "cl-live", cwd: "/repo" });
  store.issueIdentity("claude", "claude-code", "cl-live");
  const pickup = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s9", cwd: "/repo", prompt: "@claude check the relay too" }, wire("codex"));
  assert.match(ctxOf(pickup)!, /in their inbox/);
  assert.match(ctxOf(pickup)!, /next prompt/);
  assert.match(ctxOf(pickup)!, /Do not do that work yourself/);
  // Held: no live opencode session anywhere.
  const held = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s9", cwd: "/repo", prompt: "@opencode compare notes" }, wire("codex"));
  assert.match(ctxOf(held)!, /held your message to @opencode/);
  assert.match(ctxOf(held)!, /no active session/);
  assert.match(ctxOf(held)!, /Do not do that work yourself/);
  done();
});

test("the per-user M9R install folder is never persisted as a project scope", () => {
  const { root, store, done } = tempStore();
  store.registerEndpoint({ provider: "codex", sessionId: "codex-install", cwd: join(root, "bin") });
  const direct = store.addTask({ from: "you", to: "codex", goal: "direct store task", origin: "human_typed", cwd: join(root, "bin"), idempotencyKey: "direct-install-cwd" });
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s-install", cwd: join(root, "bin"), prompt: "@codex use the approved stage" }, ctx(store));

  const endpoint = store.listEndpoints().find((item) => item.handle === "claude");
  assert.equal(endpoint?.cwd, undefined);
  assert.equal(store.sessionsFor("codex")[0]?.cwd, undefined);
  assert.equal(direct.task.cwd, undefined);
  assert.equal(store.tasksFor("codex")[0]?.cwd, undefined);

  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s-project", cwd: "C:/RunLeak/runleak", prompt: "@codex use the project" }, ctx(store));
  assert.equal(store.tasksFor("codex")[2]?.cwd, "C:/RunLeak/runleak");
  done();
});

test("Windows System32 is never persisted as a provider project scope", () => {
  const { store, done } = tempStore();
  handleHookEvent({ hook_event_name: "SessionStart", session_id: "system-session", cwd: "C:\\WINDOWS\\System32" }, { ...ctx(store, "codex") });
  assert.equal(store.sessionsFor("codex")[0]?.cwd, undefined);
  const routed = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "source", cwd: "C:\\WINDOWS\\System32", prompt: "@codex use the current project" }, { ...ctx(store, "opencode"), strictTargetIdentity: false });
  assert.doesNotMatch(ctxOf(routed) ?? "", /task T1/);
  assert.equal(store.tasksFor("codex")[0]?.cwd, undefined);
  done();
});

test("cursor and session-link APIs also discard an M9R install cwd", () => {
  const { root, store, done } = tempStore();
  const installCwd = join(root, "bin");

  store.setCursor("codex", "install-session", 7, installCwd);
  assert.equal(store.cursorFor("codex", "install-session", installCwd), 7, "install-scoped callers use the unscoped session cursor");
  assert.equal(store.cursorFor("codex", "install-session"), 7, "the install path cannot create a separate project cursor");

  store.setLink(
    { handle: "codex", sessionId: "install-session", cwd: installCwd },
    { handle: "claude", sessionId: "partner-session", cwd: installCwd },
    "picked",
  );
  const link = store.allLinks()[0];
  assert.equal(link.a.cwd, undefined);
  assert.equal(link.b.cwd, undefined);
  assert.equal(store.linksFor("codex", "install-session", installCwd).length, 1);
  assert.doesNotMatch(readFileSync(join(root, "state.json"), "utf8"), /\\bin[\\"]|\/bin[\"]/, "the install directory is not written into store state");
  done();
});

test("legacy records with an M9R install cwd are repaired on the next store write", () => {
  const { root, store, done } = tempStore();
  const installCwd = join(root, "bin");
  writeFileSync(join(root, "state.json"), JSON.stringify({
    version: 1,
    nextTaskNo: 4,
    nextSeq: { codex: 3 },
    tasks: [{ id: "T3", seq: 3, from: "you", to: "codex", goal: "old proof", origin: "human_typed", idempotencyKey: "old-proof", cwd: installCwd }],
    cursors: {},
    endpoints: { codex: { handle: "codex", provider: "codex", cwd: installCwd, lastSeenAt: new Date().toISOString() } },
    events: [],
    rules: [],
    nextRuleNo: 1,
    sessions: [{ handle: "codex", provider: "codex", sessionId: "old", cwd: installCwd, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }],
    links: [{ id: "L1", a: { handle: "codex", sessionId: "old", cwd: installCwd }, b: { handle: "claude", sessionId: "partner", cwd: installCwd }, origin: "picked", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    nextLinkNo: 2,
    identities: [],
  }), "utf8");

  assert.equal(store.getTask("T3")?.cwd, undefined);
  assert.equal(store.listEndpoints()[0]?.cwd, undefined);
  assert.equal(store.sessionsFor("codex")[0]?.cwd, undefined);
  assert.equal(store.allLinks()[0]?.a.cwd, undefined);
  store.dismiss([]); // force the repaired read-state to be persisted atomically
  assert.doesNotMatch(readFileSync(join(root, "state.json"), "utf8"), /\\bin[\\"]|\/bin[\"]/);
  done();
});

test("the prompt the broker builds for a web-room agent never becomes tasks for its teammates", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "claude-code" });
  store.registerEndpoint({ provider: "opencode" });
  const prompt = `${CODEX_WEB_PREFACE}

${webAgentPrompt("codex", "tok_test", ["claude", "opencode"], "project-x")}

The owner says:
read the page`;
  const out = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "w1", cwd: "/repo", prompt }, ctx(store, "codex"));
  assert.equal(store.tasksFor("claude").length, 0, "no task for @claude");
  assert.equal(store.tasksFor("opencode").length, 0, "no task for @opencode");
  assert.equal(ctxOf(out) ?? "", "", "nothing is injected into a machine-written prompt");
  const resumePrompt = "Your current M9R session token is tok_test_2. Use it only on M9R tools and never disclose it. Prior browser permissions and room instructions still apply.\n\nThe owner says:\n@claude messaged you (T9): hello @opencode";
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "w1b", cwd: "/repo", prompt: resumePrompt }, ctx(store, "codex"));
  assert.equal(store.tasksFor("claude").length, 0, "a resumed worker's short prompt is machine-written too");
  assert.equal(store.tasksFor("opencode").length, 0);
  assert.equal(isBrokerAgentPrompt(webAgentPrompt("claude", "tok", ["codex"])), true, "the bare agent prompt (no Codex preface) is recognised by its header");
  assert.equal(isBrokerAgentPrompt("@claude please look at the relay bug"), false, "a person's message is not");
  // A person typing the same handles still routes normally.
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "w2", cwd: "/repo", prompt: "@claude and @opencode please compare notes" }, ctx(store, "codex"));
  assert.equal(store.tasksFor("claude").length, 1);
  assert.equal(store.tasksFor("opencode").length, 1);
  done();
});

test("a new session is not handed old, already-answered, or other-session backlog; fresh work still arrives", () => {
  const { store, done } = tempStore(() => new Date("2026-09-20T00:00:00Z"));
  store.registerEndpoint({ provider: "claude-code" });
  const old = store.addTask({ from: "codex", to: "claude", goal: "ancient typed task", origin: "human_typed", idempotencyKey: "old" }).task;
  const answered = store.addTask({ from: "codex", to: "claude", goal: "already answered", origin: "human_typed", idempotencyKey: "ans" }).task;
  store.setResult(answered.id, "done");
  const later = new Date("2026-09-20T00:20:00Z");
  const fresh = createLocalStore(store.root, { now: () => later });
  fresh.addTask({ from: "codex", to: "claude", goal: "recent task", origin: "human_typed", idempotencyKey: "new" });
  const at = (iso: string) => renderInboxInjection(fresh.tasksFor("claude"), 0, { now: Date.parse(iso) }).text;
  assert.match(at("2026-09-20T00:25:00Z"), /recent task/);
  assert.doesNotMatch(at("2026-09-20T00:25:00Z"), /already answered/, "a task with a result is finished");
  assert.match(at("2026-09-20T00:25:00Z"), /ancient typed task/, "within the 30-minute window it is still recent");
  assert.doesNotMatch(at("2026-09-20T03:00:00Z"), /ancient typed task|recent task/, "hours later none of it is replayed to a new session");
  assert.equal(old.id !== answered.id, true);
  done();
});

test("mention diagnostics receives the unmodified hook input only for routed mentions", () => {
  const { store, done } = tempStore();
  const captured: Array<{ prompt?: string; targets: readonly string[]; rawPayload?: string }> = [];
  const captureMentionInput = (input: { prompt?: string }, targets: readonly string[], rawPayload?: string) => captured.push({ prompt: input.prompt, targets, rawPayload });
  const input = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "@codex inspect this exact prompt" };
  const rawPayload = '{  "hook_event_name":"UserPromptSubmit", "session_id":"s1", "cwd":"/repo", "prompt":"@codex inspect this exact prompt"  }\n';
  handleHookEvent(input, { ...ctx(store), rawPayload, captureMentionInput });
  handleHookEvent({ ...input, prompt: "plain prompt" }, { ...ctx(store), captureMentionInput });
  assert.deepEqual(captured, [{ prompt: input.prompt, targets: ["codex"], rawPayload }]);
  assert.equal(store.tasksFor("codex").length, 1);
  done();
});

test("the same prompt submitted twice does not create a second task", () => {
  const { store, done } = tempStore();
  const input = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "@codex do the thing" };
  handleHookEvent(input, ctx(store));
  handleHookEvent(input, ctx(store));
  assert.equal(store.tasksFor("codex").length, 1);
  done();
});

test("a mention of yourself, of a file or folder with that name, or inside code is ignored", () => {
  const { store, done } = tempStore();
  const run = (prompt: string, exists?: (p: string) => boolean) => handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/repo", prompt }, ctx(store, "claude-code", exists));
  assert.equal(run("@claude do it"), null);
  assert.equal(run("look at @codex", (p) => p.endsWith("codex")), null);
  assert.equal(run("run `@codex` as written"), null);
  assert.equal(store.tasksFor("codex").length, 0);
  done();
});

test("a plain prompt with nothing in the inbox prints nothing, which costs zero tokens", () => {
  const { store, done } = tempStore();
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/repo", prompt: "what is 2+2" }, ctx(store)), null);
  done();
});

test("an inbox item is injected once and remains bound to the session that received it", () => {
  const { store, done } = tempStore();
  store.addTask({ from: "codex", to: "claude", goal: "review lease.ts", origin: "human_typed", idempotencyKey: "a" });
  const first = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "hi" }, ctx(store));
  assert.match(ctxOf(first)!, /M9R work \(1 new\)/);
  assert.match(ctxOf(first)!, /M9R work from @codex: review lease\.ts/);
  assert.doesNotMatch(ctxOf(first)!, /T1|get_task|session token/i);
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "and again" }, ctx(store)), null);
  const otherSession = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: "/repo", prompt: "new window" }, ctx(store));
  assert.equal(otherSession, null, "the same task must not be replayed into a second Claude session");
  done();
});

test("a Claude tool-result notice does not consume a task before a real prompt can claim it", () => {
  const { store, done } = tempStore();
  const created = store.addTask({ from: "codex", to: "claude", goal: "continue the T37 diagnosis", origin: "human_typed", idempotencyKey: "t37-post-tool-notice" });
  const first = store.issueIdentity("claude", "claude-code", "session-a");
  const second = store.issueIdentity("claude", "claude-code", "session-b");

  const notice = handleHookEvent({ hook_event_name: "PostToolUse", session_id: "session-a", cwd: "/repo" }, ctx(store));
  assert.equal(notice, null, "a tool-result hook is not a reliable task-delivery channel");
  assert.equal(store.getTask(created.task.id)?.deliveredSession, undefined);
  assert.equal(store.getTask(created.task.id)?.deliveredAt, undefined);
  assert.equal(store.cursorFor("claude", "session-a", "/repo"), 0);

  const delivered = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "session-b", cwd: "/repo", prompt: "check inbox" }, ctx(store));
  assert.match(ctxOf(delivered) ?? "", /continue the T37 diagnosis/);
  assert.equal(store.getTask(created.task.id)?.deliveredSession, "session-b");

  const result = (token: string) => applyAgentMcpStoreMutation(store, {
    action: "result", token, taskId: created.task.id, summary: "diagnosis complete",
  });
  assert.equal(result(first.token).status, 403, "a different provider session cannot report the task result");
  assert.equal(result(second.token).status, 200, "the session that received the task can report its result");
  done();
});

test("Codex inbox work stays held until that session has an active M9R identity", () => {
  const { store, done } = tempStore();
  store.addTask({ from: "claude", to: "codex", goal: "review the governed bridge", origin: "human_typed", idempotencyKey: "codex-identity-gate" });
  const input = { hook_event_name: "UserPromptSubmit", session_id: "c1", cwd: "/repo", prompt: "hi" };

  const held = handleHookEvent(input, ctx(store, "codex"));
  const heldText = ctxOf(held) ?? "";
  assert.match(heldText, /reconnect.*M9R identity|M9R identity.*reconnect/i, "the session should get a safe explanation instead of silently losing delegated work");
  assert.doesNotMatch(heldText, /review the governed bridge|M9R inbox/i, "task contents must not enter an ungoverned session");
  assert.equal(store.cursorFor("codex", "c1", "/repo"), 0, "holding the task must not advance the session inbox cursor");
  assert.equal(store.tasksFor("codex")[0].deliveredAt, undefined, "holding the task must not mark it delivered");

  handleHookEvent({ ...input, hook_event_name: "SessionStart" }, ctx(store, "codex"));
  const delivered = handleHookEvent(input, ctx(store, "codex"));
  assert.match(ctxOf(delivered) ?? "", /review the governed bridge/, "a session with an issued identity should receive the pending task normally");
  assert.equal(store.tasksFor("codex")[0].deliveredSession, "c1");
  done();
});

test("an agent-initiated task that is still pending stays owner-visible without entering the provider prompt", () => {
  const { store, done } = tempStore();
  const pending = store.addTask({ from: "codex", to: "claude", goal: "delete the old branch", origin: "agent_initiated", idempotencyKey: "b" }).task;
  const out = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "hi" }, ctx(store));
  assert.doesNotMatch(ctxOf(out) ?? "", /delete the old branch/, "pending work must not be injected into the provider prompt");
  assert.equal(store.pendingApprovals()[0]?.id, pending.id, "the owner-facing approval queue still contains the task");
  assert.equal(store.getTask(pending.id)?.deliveredAt, undefined, "the provider did not receive a delivery receipt");
  assert.equal(store.cursorFor("claude", "s1", "/repo"), 0, "the provider cursor remains before the approval frontier");
  done();
});

test("secrets typed into a mention are redacted before the task is stored", () => {
  const { store, done } = tempStore();
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/repo", prompt: "@codex use api_key=sk-abcdefghijklmnopqrstuvwxyz123456 to test" }, ctx(store));
  assert.doesNotMatch(store.tasksFor("codex")[0].goal, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  done();
});

test("hook failures are silent: a broken store or unknown event prints nothing and never throws", () => {
  const { store, done } = tempStore();
  const broken = { ...store, registerEndpoint: () => { throw new Error("disk on fire"); } } as unknown as typeof store;
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "@codex hi" }, ctx(broken)), null);
  assert.equal(handleHookEvent({ hook_event_name: "PostToolUse" }, ctx(store)), null);
  assert.equal(handleHookEvent({}, ctx(store)), null);
  done();
});

test("stale OpenCode PostToolUse hook registrations cannot inject the same task on every tool call", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "opencode", sessionId: "oc-1", cwd: "C:/repo" });
  store.issueIdentity("opencode", "opencode", "oc-1");
  const { task: pending } = store.addTask({
    from: "codex", to: "opencode", goal: "inspect this file", origin: "human_typed", cwd: "C:/repo", targetSession: "oc-1", idempotencyKey: "stale-opencode-posttooluse",
  });
  const context = { ...ctx(store, "opencode"), now: () => new Date("2026-10-07T12:00:00Z") };
  const event = { hook_event_name: "PostToolUse", session_id: "oc-1", cwd: "C:/repo", tool_name: "read" };
  assert.equal(handleHookEvent(event, context), null);
  assert.equal(handleHookEvent(event, context), null);
  assert.equal(store.getTask(pending.id)?.delivery, undefined);
  assert.equal(store.getTask(pending.id)?.deliveredAt, undefined);
  assert.equal(store.cursorFor("opencode", "oc-1", "C:/repo"), 0);
  done();
});

test("text pasted into Claude Code arrives wrapped in <pasted_content> tags; the task keeps only what was asked", () => {
  const store = createLocalStore(mkdtempSync(join(tmpdir(), "m9r-paste-")));
  store.registerEndpoint({ provider: "codex", sessionId: "01a0aaaa-0000-7000-8000-000000000009", cwd: "C:/p" });
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/p", prompt: '@codex <pasted_content id="6b01"> reply with only the word: ok </pasted_content>' }, { provider: "claude-code", store, pathExists: () => false, readIndex: () => null });
  assert.equal(store.getTask("T1")?.goal, "reply with only the word: ok");
});

test("mentions found only inside Claude Code pasted content do not dispatch phantom tasks", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "codex", sessionId: "codex-session", cwd: "C:/p" });
  const result = handleHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-session",
    cwd: "C:/p",
    prompt: '<pasted_content id="6b01">@codex reply with only the word: ok</pasted_content>',
  }, ctx(store));

  assert.equal(store.tasksFor("codex").length, 0);
  assert.equal(result, null);
  done();
});

test("local state refuses an over-budget update and preserves its previous snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-store-capacity-"));
  try {
    const store = createLocalStore(root, { maxStateBytes: 512 });
    store.noteEvent("agent.connected", "baseline");
    const path = join(root, "state.json");
    const before = readFileSync(path, "utf8");
    assert.throws(() => store.addRule({ from: "codex", to: "claude", ttlMs: 60_000, note: "x".repeat(2_000) }), /capacity|byte limit/i);
    assert.equal(readFileSync(path, "utf8"), before, "the last complete state file survives the rejected update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local state refuses to read a file beyond its configured byte ceiling", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-store-oversized-"));
  try {
    const path = join(root, "state.json");
    const oversized = " ".repeat(513);
    writeFileSync(path, oversized, "utf8");
    const store = createLocalStore(root, { maxStateBytes: 512 });
    assert.throws(() => store.listEndpoints(), /capacity|byte limit/i);
    assert.equal(readFileSync(path, "utf8"), oversized, "oversized state is not quarantined or overwritten automatically");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
