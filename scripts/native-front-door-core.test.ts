import assert from "node:assert/strict";
import test from "node:test";
import { aliasCollidesWithPath, findEndpointMentions } from "@/lib/native/mention-core";
import {
  CAPS,
  MAX_GOAL_CHARS,
  approxTokens,
  findByIdempotencyKey,
  newTask,
  redactSecrets,
  renderInboxInjection,
  renderSentAck,
  renderSessionCard,
  type Task,
} from "@/lib/native/inbox-core";

const aliases = ["codex", "claude", "codex-auth", "opencode"];
const mentions = (prompt: string, pathExists?: (t: string) => boolean) => findEndpointMentions(prompt, { aliases, pathExists });

test("a plain mention is found, case-insensitively, once, in order", () => {
  assert.deepEqual(mentions("@Codex please look, then ask @claude, and @codex again"), ["codex", "claude"]);
  assert.deepEqual(mentions("@codex-auth check this"), ["codex-auth"]);
});

test("a mention at the end of a sentence or in brackets still matches", () => {
  assert.deepEqual(mentions("ask @codex."), ["codex"]);
  assert.deepEqual(mentions("(cc @claude)"), ["claude"]);
  assert.deepEqual(mentions('say "@opencode, go"'), ["opencode"]);
});

test("emails, paths, package names and file extensions are not mentions", () => {
  assert.deepEqual(mentions("mail me at dev@codex.com"), []);
  assert.deepEqual(mentions("open @codex/file.ts"), []);
  assert.deepEqual(mentions("import from @claude/sdk"), []);
  assert.deepEqual(mentions("see @codex.js"), []);
  assert.deepEqual(mentions("path a/b@codex"), []);
});

test("an unknown alias is ignored so ordinary @-tokens never route", () => {
  assert.deepEqual(mentions("@types/node and @ayaan and @nobody"), []);
});

test("mentions inside code are ignored", () => {
  assert.deepEqual(mentions("run `@codex` literally"), []);
  assert.deepEqual(mentions("```\n@codex do it\n```\nnothing here"), []);
  assert.deepEqual(mentions("```\n@codex\n``` but ask @claude"), ["claude"]);
});

test("a token that names a real file or folder is a file mention, not an endpoint", () => {
  assert.deepEqual(mentions("look at @codex", (t) => t === "codex"), []);
  assert.deepEqual(mentions("look at @codex and @claude", (t) => t === "codex"), ["claude"]);
});

test("aliases that would collide with real top-level files are flagged", () => {
  assert.equal(aliasCollidesWithPath("claude", (n) => n === "claude.md"), true);
  assert.equal(aliasCollidesWithPath("codex", (n) => n === "src"), false);
});

const t0 = "2026-09-20T00:00:00.000Z";
const mk = (over: Partial<Parameters<typeof newTask>[0]> = {}, seq = 1, id = `T${seq}`) =>
  newTask({ from: "claude", to: "codex", goal: "investigate the relay reconnect bug", origin: "human_typed", idempotencyKey: `k${seq}`, ...over }, { id, seq }, t0);

test("a human-typed task needs no approval; an agent-initiated one waits unless a standing rule covers it", () => {
  assert.equal(mk().approval, "not_needed");
  assert.equal(mk({ origin: "agent_initiated" }).approval, "pending");
  assert.equal(mk({ origin: "agent_initiated", standingRuleApplies: true }).approval, "approved");
});

test("goals are capped with a visible marker and secrets are redacted before storage", () => {
  const long = mk({ goal: "x".repeat(MAX_GOAL_CHARS + 500) });
  assert.equal(long.goal.length <= MAX_GOAL_CHARS, true);
  assert.equal(long.goalTruncated, true);
  assert.match(long.goal, /truncated: full text via get_task/);
  const leaky = mk({ goal: "use api_key=sk-abcdefghijklmnopqrstuvwxyz123456 and password: hunter2hunter2" });
  assert.doesNotMatch(leaky.goal, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(leaky.goal, /hunter2hunter2/);
  assert.match(leaky.goal, /\[redacted\]/);
  assert.throws(() => mk({ goal: "   " }), /needs a goal/);
});

test("secret patterns cover keys, JWTs, AWS ids and private keys", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234567890";
  assert.equal(redactSecrets(`t ${jwt} t`), "t [redacted] t");
  assert.equal(redactSecrets("AKIAABCDEFGHIJKLMNOP"), "[redacted]");
  assert.equal(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"), "[redacted]");
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
});

test("the same idempotency key finds the existing task instead of creating another", () => {
  const a = mk({}, 1);
  assert.equal(findByIdempotencyKey([a], "codex", "k1")?.id, "T1");
  assert.equal(findByIdempotencyKey([a], "claude", "k1"), undefined);
  assert.equal(findByIdempotencyKey([a], "codex", "other"), undefined);
});

test("an empty inbox injects nothing, which costs zero tokens", () => {
  const r = renderInboxInjection([], 0);
  assert.equal(r.text, "");
  assert.equal(r.newCursor, 0);
});

test("the injection is delta-only: tasks at or below the cursor are not shown again", () => {
  const tasks = [mk({}, 1), mk({}, 2), mk({}, 3)];
  const first = renderInboxInjection(tasks, 0);
  assert.deepEqual(first.includedIds, ["T1", "T2", "T3"]);
  assert.equal(first.newCursor, 3);
  const second = renderInboxInjection(tasks, first.newCursor);
  assert.equal(second.text, "");
  const later = renderInboxInjection([...tasks, mk({}, 4)], first.newCursor);
  assert.deepEqual(later.includedIds, ["T4"]);
});

test("at most three items are shown, the rest are counted, and the cursor advances only past what was shown", () => {
  const tasks = [1, 2, 3, 4, 5].map((n) => mk({}, n));
  const r = renderInboxInjection(tasks, 0);
  assert.equal(r.includedIds.length, CAPS.inboxItems);
  assert.equal(r.omitted, 2);
  assert.equal(r.newCursor, 3);
  assert.match(r.text, /2 more waiting/);
  const next = renderInboxInjection(tasks, r.newCursor);
  assert.deepEqual(next.includedIds, ["T4", "T5"]);
});

test("each item stays within its token cap and points at get_task", () => {
  const big = mk({ goal: "y".repeat(1900) });
  const r = renderInboxInjection([big], 0);
  const item = r.text.split("\n")[1];
  assert.equal(approxTokens(item) <= CAPS.inboxItemTokens, true, `${approxTokens(item)} tokens`);
  assert.match(item, /Details: get_task T1\./);
});

test("a pending task is flagged so the agent does not act; denied and expired are hidden", () => {
  const pending = mk({ origin: "agent_initiated" }, 1);
  const denied: Task = { ...mk({ origin: "agent_initiated" }, 2), approval: "denied" };
  const expired: Task = { ...mk({ origin: "agent_initiated" }, 3), approval: "expired" };
  const approved = mk({ origin: "agent_initiated", standingRuleApplies: true }, 4);
  const r = renderInboxInjection([pending, denied, expired, approved], 0);
  assert.deepEqual(r.includedIds, ["T1", "T4"]);
  assert.match(r.text, /T1 from @claude, AWAITING THE USER'S APPROVAL, do not act on it yet/);
  assert.match(r.text, /T4 from @claude, approved by the user/);
});

test("the session card is a few lines of pointers within its cap, and never carries memory content", () => {
  const card = renderSessionCard({ handle: "claude", others: [{ handle: "codex", activity: "editing relay/hub.ts" }], pendingCount: 2, memoryDir: ".oathlock/memory" });
  assert.match(card, /M9R connected as @claude\./);
  assert.match(card, /@codex \(editing relay\/hub\.ts\)/);
  assert.match(card, /2 pending inbox item/);
  assert.match(card, /indexed in \.oathlock\/memory\/index\.md/);
  assert.doesNotMatch(renderSessionCard({ handle: "claude", others: [], pendingCount: 0 }), /memory/i, "no memory line when there is no folder");
  assert.equal(approxTokens(card) <= CAPS.cardTokens, true);
  const crowded = renderSessionCard({ handle: "a", others: Array.from({ length: 30 }, (_, i) => ({ handle: `agent${i}`, activity: "z".repeat(200) })), pendingCount: 0, memoryDir: "m" });
  assert.equal(approxTokens(crowded) <= CAPS.cardTokens, true);
  assert.equal((crowded.match(/@agent/g) ?? []).length <= CAPS.cardOthers, true);
});

test("the sent acknowledgement tells the sender not to do the work itself", () => {
  const ack = renderSentAck("T12", "codex");
  assert.match(ack, /task T12/);
  assert.match(ack, /do not do that work yourself/i);
  assert.match(ack, /tell the user it was sent to @codex/);
});
