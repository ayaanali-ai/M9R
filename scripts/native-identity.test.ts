import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { issueIdentity, verifyToken, newToken } from "@/lib/native/identity-core";
import { createM9rMcpServer } from "@/lib/native/mcp-server";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "m9r-identity-"));
  return { store: createLocalStore(root), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("newToken makes distinct, sufficiently long tokens", () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 30);
});

test("issueIdentity/verifyToken: a fresh token verifies, a wrong or revoked one does not", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const issued = issueIdentity("claude", "claude-code", "s1", now);
  const ok = verifyToken([issued], issued.token);
  assert.deepEqual(ok, { handle: "claude", provider: "claude-code", sessionId: "s1" });

  assert.equal(verifyToken([issued], "not-a-real-token"), null);

  const revoked = { ...issued, revokedAt: now };
  assert.equal(verifyToken([revoked], issued.token), null);
});

test("verifyToken rejects a token presented with the wrong claimed session id", () => {
  const issued = issueIdentity("codex", "codex", "s1", "2026-01-01T00:00:00.000Z");
  assert.equal(verifyToken([issued], issued.token, "s2"), null);
  assert.notEqual(verifyToken([issued], issued.token, "s1"), null);
});

test("store.issueIdentity revokes any earlier live token for the same session before issuing a new one", () => {
  const { store, done } = tempStore();
  const first = store.issueIdentity("claude", "claude-code", "s1");
  const second = store.issueIdentity("claude", "claude-code", "s1");
  assert.notEqual(first.token, second.token);
  assert.equal(store.verifyIdentity(first.token), null, "the old token for this session must no longer verify");
  assert.notEqual(store.verifyIdentity(second.token), null);
  done();
});

test("store.revokeIdentity invalidates the live token for a session", () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("codex", "codex", "s1");
  assert.notEqual(store.verifyIdentity(issued.token), null);
  store.revokeIdentity("s1");
  assert.equal(store.verifyIdentity(issued.token), null);
  done();
});

type ToolServer = ReturnType<typeof createM9rMcpServer> & { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> };

async function callTool(server: ReturnType<typeof createM9rMcpServer>, name: string, args: unknown = {}) {
  const tool = (server as ToolServer)._registeredTools[name];
  assert.ok(tool, `tool ${name} was not registered`);
  return tool.handler(args);
}

test("m9r_whoami refuses an invalid token and answers with the verified identity for a valid one", async () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("claude", "claude-code", "s1");
  const server = createM9rMcpServer({ store, token: issued.token });
  const bad = createM9rMcpServer({ store, token: "garbage" });

  const ok = await callTool(server, "m9r_whoami");
  assert.match(ok.content[0].text, /@claude/);

  await assert.rejects(() => callTool(bad, "m9r_whoami"), /invalid or has been revoked/);
  done();
});

test("m9r_send creates a real inbox task the recipient can see, m9r_result records it and refuses a mismatched owner", async () => {
  const { store, done } = tempStore();
  const codex = store.issueIdentity("codex", "codex", "s-codex");
  const claude = store.issueIdentity("claude", "claude-code", "s-claude");
  const codexServer = createM9rMcpServer({ store, token: codex.token });
  const claudeServer = createM9rMcpServer({ store, token: claude.token });

  const sent = await callTool(codexServer, "m9r_send", { to: "claude", goal: "check the build" });
  assert.match(sent.content[0].text, /Sent to @claude as task T1/);
  assert.equal(store.getTask("T1")?.from, "codex");

  await assert.rejects(() => callTool(codexServer, "m9r_result", { taskId: "T1", summary: "done" }), /not sent to you/);

  const inbox = await callTool(claudeServer, "m9r_inbox");
  assert.match(inbox.content[0].text, /check the build/);

  const result = await callTool(claudeServer, "m9r_result", { taskId: "T1", summary: "build is green" });
  assert.match(result.content[0].text, /Recorded result for T1/);
  assert.equal(store.getTask("T1")?.resultSummary, "build is green");
  done();
});
