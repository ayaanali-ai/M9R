import assert from "node:assert/strict";
import test from "node:test";
import { recoverOpenCodeAnswer } from "@/lib/native/opencode-result";

test("a resumed OpenCode turn can recover its last assistant text when JSONL stdout is empty", async () => {
  let requested = "";
  const result = await recoverOpenCodeAnswer("http://127.0.0.1:47123", "secret", "ses-1", async (url, init) => {
    requested = String(url);
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Basic /);
    return new Response(JSON.stringify([
      { info: { id: "msg-user-1", role: "user" }, parts: [{ type: "text", text: "question" }] },
      { info: { id: "msg-assistant-1", role: "assistant", time: { completed: 2 } }, parts: [{ type: "text", text: "Verified answer" }] },
    ]), { status: 200 });
  });
  assert.equal(requested, "http://127.0.0.1:47123/session/ses-1/message?limit=10");
  assert.equal(result, "Verified answer");
});

test("the recovery path fails closed on HTTP or malformed message data", async () => {
  assert.equal(await recoverOpenCodeAnswer("http://127.0.0.1:47123", "secret", "ses-1", async () => new Response("oops", { status: 500 })), null);
  assert.equal(await recoverOpenCodeAnswer("http://127.0.0.1:47123", "secret", "ses-1", async () => new Response(JSON.stringify([{ info: { role: "user" }, parts: [{ type: "text", text: "private" }] }]), { status: 200 })), null);
});

test("recovery never reports unfinished assistant progress as the terminal answer", async () => {
  const response = (messages: unknown[]) => new Response(JSON.stringify(messages), { status: 200 });

  const unfinished = await recoverOpenCodeAnswer("http://127.0.0.1:47123", "secret", "ses-1", async () => response([
    { info: { id: "user-old", role: "user" }, parts: [{ type: "text", text: "earlier question" }] },
    { info: { id: "assistant-old", role: "assistant", time: { completed: 2 } }, parts: [{ type: "text", text: "Earlier completed answer" }] },
    { info: { id: "user-current", role: "user" }, parts: [{ type: "text", text: "current question" }] },
    { info: { id: "assistant-current", role: "assistant", time: { created: 3 } }, parts: [{ type: "text", text: "Searching the page now…" }] },
  ]));
  assert.equal(unfinished, null, "an assistant message without time.completed is progress, not a terminal answer");
});

test("recovery never reports a previous turn when the current turn has no assistant reply", async () => {
  const response = (messages: unknown[]) => new Response(JSON.stringify(messages), { status: 200 });
  const noReplyYet = await recoverOpenCodeAnswer("http://127.0.0.1:47123", "secret", "ses-1", async () => response([
    { info: { id: "user-old", role: "user" }, parts: [{ type: "text", text: "earlier question" }] },
    { info: { id: "assistant-old", role: "assistant", time: { completed: 2 } }, parts: [{ type: "text", text: "Earlier completed answer" }] },
    { info: { id: "user-current", role: "user" }, parts: [{ type: "text", text: "current question" }] },
  ]));
  assert.equal(noReplyYet, null, "a prior turn must not be mistaken for the current turn's missing reply");
});

test("recovery does not report text attached to a failed assistant message", async () => {
  const result = await recoverOpenCodeAnswer("http://127.0.0.1:47123", "secret", "ses-1", async () => new Response(JSON.stringify([
    { info: { id: "user-current", role: "user" }, parts: [{ type: "text", text: "current question" }] },
    { info: { id: "assistant-current", role: "assistant", time: { completed: 3 }, error: { name: "APIError" } }, parts: [{ type: "text", text: "Partial answer before provider failure" }] },
  ]), { status: 200 }));
  assert.equal(result, null);
});
