import assert from "node:assert/strict";
import test from "node:test";
import { jevJudge, jevMode, mockJevTransport, type JevTransport } from "../src/lib/jev.ts";
import { buildShadowQuestions, shadowAgreement, shadowJudgeHumanMessage, type ShadowRecord } from "../src/lib/jev-shadow.ts";

const fake = (isTask: number, target: string, confidence = 0.9): JevTransport => (async () => ({
  model: "jev-test",
  answers: { is_task: { type: "noul", noul: isTask }, target: { type: "choice", choice: target, confidence, probabilities: {} } },
  usage: { input_tokens: 120, output_tokens: 0 },
})) as never;

test("Jev is off unless explicitly enabled, and shadow mode needs an API key", () => {
  assert.equal(jevMode({}), "off");
  assert.equal(jevMode({ M9R_JEV_MODE: "shadow" }), "off", "no key -> degrade to off, never fail requests");
  assert.equal(jevMode({ M9R_JEV_MODE: "shadow", TYPESAFE_API_KEY: "k" }), "shadow");
  assert.equal(jevMode({ M9R_JEV_MODE: "mock" }), "mock");
  assert.equal(jevMode({ M9R_JEV_MODE: "active", TYPESAFE_API_KEY: "k" }), "off", "there is deliberately no mode that acts");
});

test("jevJudge never throws: failures, timeouts and off all read as 'no judgment'", async () => {
  const q = buildShadowQuestions(["codex"]);
  assert.equal(await jevJudge("x", q, { mode: "off" }), null);
  const boom: JevTransport = (async () => { throw new Error("api key sk-secret leaked in message"); }) as never;
  assert.equal(await jevJudge("x", q, { mode: "shadow", transport: boom }), null);
  const hang: JevTransport = ((_r, o) => new Promise((_res, rej) => o.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as never;
  assert.equal(await jevJudge("x", q, { mode: "shadow", transport: hang, timeoutMs: 20 }), null);
  const ok = await jevJudge("x", q, { mode: "shadow", transport: fake(0.8, "codex") });
  assert.equal(ok?.answers.is_task.noul, 0.8);
  assert.equal(ok?.inputTokens, 120);
});

test("shadow agreement compares Jev's would-dispatch with the current explicit-@mention routing", () => {
  assert.equal(shadowAgreement({ isTask: 0.9, target: "codex", actualMentioned: ["codex"] }), true);
  assert.equal(shadowAgreement({ isTask: 0.9, target: "claude-code", actualMentioned: ["codex"] }), false, "woke a different agent");
  assert.equal(shadowAgreement({ isTask: 0.1, target: "none", actualMentioned: [] }), true, "chatter, nobody mentioned");
  assert.equal(shadowAgreement({ isTask: 0.9, target: "codex", actualMentioned: [] }), false, "Jev would dispatch, current logic would not");
  assert.equal(shadowAgreement({ isTask: 0.1, target: "none", actualMentioned: ["codex"] }), false, "mentioned in passing: the false-dispatch case");
});

test("shadow judgment logs a record without the message body, dedupes replays, and marks outages", async () => {
  const records: ShadowRecord[] = [];
  const secretBody = "@codex please rotate the production key hunter2";
  const input = { messageId: "m1", body: secretBody, agents: [{ kind: "codex", connected: true, isChannelMember: true }, { kind: "claude-code", connected: false, isChannelMember: true }], actualMentionedKinds: ["codex"] };
  const record = await shadowJudgeHumanMessage(input, { mode: "shadow", transport: fake(0.95, "codex"), log: (r) => records.push(r) });
  assert.equal(record?.agree, true);
  assert.equal(record?.status, "judged");
  assert.ok(!JSON.stringify(record).includes("hunter2"), "message body must never appear in the record");
  assert.equal(await shadowJudgeHumanMessage(input, { mode: "shadow", transport: fake(0.95, "codex"), log: (r) => records.push(r) }), null, "idempotent replay is judged once");
  const down = await shadowJudgeHumanMessage({ ...input, messageId: "m2" }, { mode: "shadow", transport: (async () => { throw new Error("down"); }) as never, log: (r) => records.push(r) });
  assert.equal(down?.status, "unavailable");
  assert.equal(down?.agree, null);
  assert.equal(records.length, 2);
});

test("the target question is built from the channel's real roster plus an explicit 'none'", () => {
  const q = buildShadowQuestions(["codex", "claude-code"]);
  assert.deepEqual(Object.keys(q.target.criteria), ["codex", "claude-code", "none"]);
  assert.equal(q.is_task.type, "noul");
});

test("mock transport is deterministic and network-free", async () => {
  const j = await jevJudge({ message: "please fix the login bug" }, buildShadowQuestions(["codex"]), { mode: "mock", transport: mockJevTransport });
  assert.equal(j?.answers.is_task.noul, 0.9);
  const chat = await jevJudge({ message: "thanks, nice work team" }, buildShadowQuestions(["codex"]), { mode: "mock" });
  assert.equal(chat?.answers.is_task.noul, 0.1);
});
