import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderInboxInjection } from "@/lib/native/inbox-core";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";

type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "m9r-inbox-"));
  const store = createLocalStore(root);
  store.addRule({ from: "claude", to: "codex", ttlMs: 3_600_000 });
  const server = createM9rMcpServer({ store });
  const call = async (name: string, args: unknown) => (await (server as unknown as ToolServer)._registeredTools[name].handler(args)).content[0].text;
  return {
    store,
    call,
    claude: store.issueIdentity("claude", "claude-code", "c1").token,
    codex: store.issueIdentity("codex", "codex", "x1").token,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("each inbox check shows only messages not seen before, then reports empty", async () => {
  const t = setup();
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "first finding" });
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "second finding" });

  const first = await t.call("m9r_inbox", { token: t.codex });
  assert.match(first, /first finding/);
  assert.match(first, /second finding/);
  assert.equal(await t.call("m9r_inbox", { token: t.codex }), "Inbox is empty.", "already-seen messages are not repeated");

  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "third finding" });
  const later = await t.call("m9r_inbox", { token: t.codex });
  assert.match(later, /third finding/);
  assert.doesNotMatch(later, /first finding|second finding/);
  t.done();
});

test("waitSeconds returns as soon as a message arrives instead of running out the clock", async () => {
  const t = setup();
  const started = Date.now();
  const waiting = t.call("m9r_inbox", { token: t.codex, waitSeconds: 10 });
  setTimeout(() => void t.call("m9r_send", { token: t.claude, to: "codex", goal: "late finding" }), 300);
  const text = await waiting;
  assert.match(text, /late finding/);
  assert.ok(Date.now() - started < 3_000, "it did not wait the full ten seconds");
  t.done();
});

test("with nothing to deliver, waitSeconds waits about that long and then says the inbox is empty", async () => {
  const t = setup();
  const started = Date.now();
  assert.equal(await t.call("m9r_inbox", { token: t.codex, waitSeconds: 1 }), "Inbox is empty.");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3_000, `waited ${elapsed}ms`);
  t.done();
});

test("an explicit inbox check shows a long message in full, while the automatic injection still clips it", async () => {
  const t = setup();
  const long = `dates ${"x".repeat(1_500)} END`;
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: long });

  const explicit = await t.call("m9r_inbox", { token: t.codex });
  assert.ok(explicit.includes("END"), "the whole message reached the agent");

  const automatic = renderInboxInjection(t.store.tasksFor("codex"), 0);
  assert.ok(!automatic.text.includes("END"), "the hook's own injection keeps its short cap");
  t.done();
});

test("two sessions of the same agent each see a message once, and one session's check does not hide it from the other", async () => {
  const t = setup();
  const second = t.store.issueIdentity("codex", "codex", "x2").token;
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "shared finding" });
  assert.match(await t.call("m9r_inbox", { token: t.codex }), /shared finding/);
  assert.match(await t.call("m9r_inbox", { token: second }), /shared finding/);
  assert.equal(await t.call("m9r_inbox", { token: second }), "Inbox is empty.");
  t.done();
});

test("a bad token is refused", async () => {
  const t = setup();
  await assert.rejects(t.call("m9r_inbox", { token: "nope", waitSeconds: 0 }), /invalid or has been revoked/);
  t.done();
});
