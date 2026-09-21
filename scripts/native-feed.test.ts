import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFeed, feedBody, lastTurnState, type Feed, type FeedInput, type SessionProbe } from "../src/lib/native/feed-core";
import { feedPass, runFeed } from "../src/lib/native/feed-writer";
import { createLocalStore } from "../src/lib/native/local-store";
import type { Task } from "../src/lib/native/inbox-core";

const NOW = new Date("2026-09-20T12:00:00Z");
const S1 = "01a0c010-9e03-7152-a1d2-039c92c32e05";
const S2 = "01a0c011-1111-7152-a1d2-039c92c32e06";

function task(over: Partial<Task> & Pick<Task, "id">): Task {
  return { seq: 1, from: "claude", to: "codex", goal: "Review lease.ts", goalTruncated: false, pointers: [], origin: "human_typed", approval: "not_needed", replyDepth: 0, idempotencyKey: over.id, createdAt: "2026-09-20T11:55:00Z", ...over };
}
function input(over: Partial<FeedInput> = {}): FeedInput {
  return { now: NOW, endpoints: [], sessions: [], tasks: [], events: [], probes: {}, pendingIds: new Set(), ...over };
}
const codexSession = (id: string, seen = "2026-09-20T11:58:00Z") => ({ handle: "codex", provider: "codex", sessionId: id, cwd: "C:/p", firstSeenAt: seen, lastSeenAt: seen });
const probe = (live: SessionProbe["live"], turn: SessionProbe["turn"] = "unknown"): SessionProbe => ({ live, turn });

test("the last turn event in a rollout tail decides working or idle; a cut-off first line is ignored", () => {
  const line = (t: string) => JSON.stringify({ type: "event_msg", payload: { type: t } });
  assert.equal(lastTurnState(["{cut off", line("task_started")].join("\n")), "working");
  assert.equal(lastTurnState([line("task_started"), line("task_complete")].join("\n")), "idle");
  assert.equal(lastTurnState([line("task_started"), line("task_complete"), line("task_started")].join("\n")), "working");
  assert.equal(lastTurnState("nothing useful here"), "unknown");
});

test("agent states come only from evidence: open and working, open and idle, offline, unknown, seen, not connected", () => {
  const sessions = [codexSession(S1), codexSession(S2)];
  const at = (probes: Record<string, SessionProbe>) => buildFeed(input({ sessions, endpoints: [{ handle: "codex", provider: "codex", lastSeenAt: "2026-09-20T11:58:00Z" }], probes }), null).agents.find((a) => a.handle === "codex")!;
  assert.equal(at({ [S1]: probe("live", "working"), [S2]: probe("free") }).state, "open_working");
  assert.equal(at({ [S1]: probe("live", "idle"), [S2]: probe("free") }).state, "open_idle");
  assert.equal(at({ [S1]: probe("free"), [S2]: probe("free") }).state, "offline");
  assert.equal(at({ [S1]: probe("unknown"), [S2]: probe("unknown") }).state, "unknown", "a check that could not run is never called offline");
  const two = at({ [S1]: probe("live", "idle"), [S2]: probe("free") });
  assert.deepEqual(two.sessions.map((s) => ({ id: s.id, live: s.live })), [{ id: S1, live: true }, { id: S2, live: false }], "each session says whether it is open");
  assert.match(two.evidence, /held open/);

  const feed = buildFeed(input({ endpoints: [{ handle: "claude", provider: "claude-code", lastSeenAt: "2026-09-20T11:58:00Z" }], sessions: [{ handle: "claude", provider: "claude-code", sessionId: "cc1", firstSeenAt: "2026-09-20T11:58:00Z", lastSeenAt: "2026-09-20T11:58:00Z" }] }), null);
  const claude = feed.agents.find((a) => a.handle === "claude")!;
  assert.equal(claude.state, "seen", "Claude Code has no open/closed signal, so it is only 'seen'");
  assert.match(claude.evidence, /no reliable open\/closed signal/);
  assert.equal(feed.agents.find((a) => a.handle === "opencode")?.state, "not_connected");
  const old = buildFeed(input({ endpoints: [{ handle: "claude", provider: "claude-code", lastSeenAt: "2026-09-20T08:00:00Z" }], sessions: [] }), null).agents.find((a) => a.handle === "claude")!;
  assert.equal(old.state, "unknown", "not seen for hours is not claimed as anything");
});

test("needs-you lists approvals first, then failed pushes, then answers; lapsed, dismissed and old items are left out", () => {
  const tasks: Task[] = [
    task({ id: "T1", from: "claude", approval: "pending", origin: "agent_initiated", goal: "Review lease.ts" }),
    task({ id: "T2", approval: "not_needed", delivery: { state: "failed", attempts: 1, error: "2 Codex sessions are open here and M9R cannot tell which you mean" } }),
    task({ id: "T3", to: "codex", resultSummary: "Reviewed: one race in renew().", delivery: { state: "done", attempts: 1 } }),
    task({ id: "T4", approval: "pending", origin: "agent_initiated" }),
    task({ id: "T5", resultSummary: "dismissed answer", dismissedAt: "2026-09-20T11:59:00Z" }),
    task({ id: "T6", resultSummary: "too old", createdAt: "2026-09-19T00:00:00Z" }),
    task({ id: "T7", approval: "pending", origin: "agent_initiated", goal: "Deploy to production" }),
  ];
  const feed = buildFeed(input({ tasks, pendingIds: new Set(["T1", "T7"]) }), null);
  assert.deepEqual(feed.needsYou.map((n) => `${n.kind}:${n.taskId}`), ["approval:T7", "approval:T1", "push_failed:T2", "answer:T3"]);
  const t7 = feed.needsYou[0];
  assert.equal(t7.kind === "approval" && t7.protected, true, "a protected action is flagged so the overlay can warn");
  const failed = feed.needsYou[2];
  assert.equal(failed.kind === "push_failed" && /m9r-cli sessions/.test(failed.fix), true);
});

test("secrets and long text never reach the feed", () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const feed = buildFeed(input({
    tasks: [task({ id: "T1", approval: "pending", origin: "agent_initiated", goal: `use key ${secret} and ${"x".repeat(900)}` }), task({ id: "T2", resultSummary: `token: ${secret} ${"y".repeat(900)}` })],
    events: [{ at: "2026-09-20T11:59:00Z", kind: "task.created", taskId: "T1", text: `password = hunter2hunter2 ${secret}` }],
    pendingIds: new Set(["T1"]),
  }), null);
  const text = JSON.stringify(feed);
  assert.ok(!text.includes(secret), "the key is gone");
  assert.ok(!text.includes("hunter2hunter2"));
  const approval = feed.needsYou.find((n) => n.kind === "approval");
  assert.ok(approval && approval.kind === "approval" && approval.goal.length <= 300);
  const answer = feed.needsYou.find((n) => n.kind === "answer");
  assert.ok(answer && answer.kind === "answer" && answer.summary.length <= 400);
});

test("seq only moves when something changed, and a ping fires once per new item, never again after a restart", () => {
  const base = input({ tasks: [task({ id: "T1", approval: "pending", origin: "agent_initiated" })], pendingIds: new Set(["T1"]) });
  const first = buildFeed(base, null);
  assert.equal(first.seq, 1);
  assert.equal(first.pings.length, 1);
  assert.match(first.pings[0].text, /^@claude asks @codex: /);
  const same = buildFeed({ ...base, now: new Date("2026-09-20T12:00:30Z") }, first);
  assert.equal(same.seq, 1, "nothing changed: same seq");
  assert.equal(feedBody(same), feedBody(first), "the timestamp alone is not a change");
  const more = buildFeed(input({ tasks: [...base.tasks, task({ id: "T2", resultSummary: "done", delivery: { state: "done", attempts: 1 } })], pendingIds: new Set(["T1"]) }), first);
  assert.equal(more.seq, 2);
  assert.deepEqual(more.pings.map((p) => p.taskId), ["T2"], "only the new item pings, not T1 again");
  const restarted = buildFeed(input({ tasks: more.needsYou.length ? [...base.tasks, task({ id: "T2", resultSummary: "done", delivery: { state: "done", attempts: 1 } })] : [], pendingIds: new Set(["T1"]) }), more);
  assert.equal(restarted.seq, 2);
});

test("the writer writes an atomic feed for a real task, writes nothing when nothing changed, and survives a corrupt state file", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-feed-"));
  const store = createLocalStore(root);
  store.registerEndpoint({ provider: "codex", sessionId: S1, cwd: "C:/p" });
  store.addTask({ from: "claude", to: "codex", goal: "Review lease.ts", origin: "agent_initiated", idempotencyKey: "a" });
  const deps = { now: () => NOW, liveness: async () => ({ [S1]: "live" as const }), readRolloutTail: () => JSON.stringify({ payload: { type: "task_started" } }) };
  const written: Feed[] = [];
  const feed = await runFeed({ root, deps, onWrite: (f) => written.push(f) });
  assert.ok(feed && existsSync(join(root, "feed.json")));
  const onDisk = JSON.parse(readFileSync(join(root, "feed.json"), "utf8")) as Feed;
  assert.equal(onDisk.needsYou[0].kind, "approval");
  assert.equal(onDisk.agents.find((a) => a.handle === "codex")?.state, "open_working");
  assert.deepEqual(readdirSync(root).filter((f) => f.includes(".tmp-")), [], "no temp file is left behind");
  assert.equal(await runFeed({ root, deps }), null, "unchanged: no rewrite, so the overlay is not woken");

  writeFileSync(join(root, "state.json"), "{ this is not json", "utf8");
  const after = await feedPass(root, deps, {});
  assert.ok(after === null || after.version === 1, "a corrupt store is set aside and the feed carries on");
  assert.ok(JSON.parse(readFileSync(join(root, "feed.json"), "utf8")).version === 1);
});

test("watch mode picks up a task created by a hook within about a second, then stops when told to", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-feed-watch-"));
  const store = createLocalStore(root);
  store.registerEndpoint({ provider: "codex", sessionId: S1, cwd: "C:/p" });
  const controller = new AbortController();
  const seen: Feed[] = [];
  const deps = { liveness: async () => ({ [S1]: "live" as const }), readRolloutTail: () => JSON.stringify({ payload: { type: "task_complete" } }) };
  const done = runFeed({ root, watch: true, pollEveryMs: 50, probeEveryMs: 5000, deps, signal: controller.signal, onWrite: (f) => seen.push(f) });
  await new Promise((r) => setTimeout(r, 300));
  const before = Date.now();
  store.addTask({ from: "claude", to: "codex", goal: "Review lease.ts", origin: "agent_initiated", idempotencyKey: "w" });
  while (!seen.some((f) => f.needsYou.length > 0) && Date.now() - before < 3000) await new Promise((r) => setTimeout(r, 25));
  const took = Date.now() - before;
  controller.abort();
  await done;
  assert.ok(seen.some((f) => f.needsYou.length > 0), "the new task appeared in the feed");
  assert.ok(took < 1500, `appeared in ${took} ms`);
  assert.equal(seen.filter((f) => f.pings.length > 0).length >= 1, true);
});

test("dismiss hides an item from the feed and changes nothing else about the task", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-feed-dismiss-"));
  const store = createLocalStore(root, { now: () => NOW });
  const { task: t } = store.addTask({ from: "claude", to: "codex", goal: "Review", origin: "human_typed", idempotencyKey: "d" });
  store.setDelivery(t.id, { state: "queued", threadId: S1 });
  store.setResult(t.id, "Reviewed: fine.");
  await feedPass(root, { now: () => NOW }, {});
  assert.equal((JSON.parse(readFileSync(join(root, "feed.json"), "utf8")) as Feed).needsYou.length, 1);
  assert.equal(store.dismiss([t.id]), 1);
  assert.equal(store.dismiss([t.id]), 0, "dismissing twice is harmless");
  await feedPass(root, { now: () => NOW }, {});
  assert.equal((JSON.parse(readFileSync(join(root, "feed.json"), "utf8")) as Feed).needsYou.length, 0);
  assert.equal(store.getTask(t.id)?.approval, "not_needed");
  assert.equal(store.getTask(t.id)?.delivery?.state, "done");
  assert.equal(store.getTask(t.id)?.resultSummary, "Reviewed: fine.");
});

test("only one feed watcher may run: a live holder blocks a second, a dead one is taken over, release frees it", async () => {
  const { acquireFeedLock } = await import("@/lib/native/feed-writer");
  const root = mkdtempSync(join(tmpdir(), "m9r-lock-"));
  const release = acquireFeedLock(root, process.pid);
  assert.ok(release);
  assert.equal(acquireFeedLock(root, process.pid + 1), null, "a live holder blocks another writer");
  release?.();
  const again = acquireFeedLock(root, process.pid + 1);
  assert.ok(again, "released lock can be taken");
  writeFileSync(join(root, "feed.lock"), "999999999");
  assert.ok(acquireFeedLock(root, process.pid), "a lock left by a dead process is taken over");
});
