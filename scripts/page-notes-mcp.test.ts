import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";

type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> };

test("m9r_note binds notes to the verified caller and supports append, list, export, clear", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-page-notes-mcp-"));
  try {
    const local = createLocalStore(root);
    const codex = local.issueIdentity("codex", "codex", "session-codex");
    const server = createM9rMcpServer({ store: local });
    const tool = (server as unknown as ToolServer)._registeredTools.m9r_note;
    assert.ok(tool, "m9r_note is registered");
    const call = (args: unknown) => tool.handler(args);
    const base = { token: codex.token, room: "repo", sourceUrl: "https://example.test/docs?q=private#top" };

    const appended = await call({ ...base, action: "append", text: "Review retry policy.", source: "agent" });
    assert.match(appended.content[0].text, /Saved/);
    const listed = await call({ token: codex.token, action: "list", room: "repo" });
    assert.match(listed.content[0].text, /@codex/);
    assert.match(listed.content[0].text, /Review retry policy/);
    assert.doesNotMatch(listed.content[0].text, /private|#top/);
    const exported = await call({ token: codex.token, action: "export", room: "repo" });
    assert.match(exported.content[0].text, /# M9R page notes/);
    const cleared = await call({ token: codex.token, action: "clear", room: "repo" });
    assert.match(cleared.content[0].text, /Cleared/);
    assert.match((await call({ token: codex.token, action: "list", room: "repo" })).content[0].text, /No active notes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("m9r_note refuses invalid identity and missing append fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-page-notes-mcp-"));
  try {
    const server = createM9rMcpServer({ store: createLocalStore(root) });
    const tool = (server as unknown as ToolServer)._registeredTools.m9r_note;
    assert.ok(tool);
    await assert.rejects(tool.handler({ token: "invalid", action: "list", room: "repo" }), /invalid or has been revoked/);
    const response = await tool.handler({ token: createLocalStore(root).issueIdentity("codex", "codex", "s").token, action: "append", room: "repo" });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /text and source are required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("m9r_note shares durable room memory across agent identities without requiring a page URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-shared-memory-mcp-"));
  try {
    const local = createLocalStore(root);
    const codex = local.issueIdentity("codex", "codex", "web-codex-one");
    const opencode = local.issueIdentity("opencode", "opencode", "web-opencode-one");
    const server = createM9rMcpServer({ store: local });
    const tool = (server as unknown as ToolServer)._registeredTools.m9r_note;
    assert.ok(tool);

    const added = await tool.handler({ token: codex.token, action: "append", room: "project-test", source: "agent", text: "The demo gate is extension restart stability." });
    assert.equal(added.isError, undefined);
    const readByTeammate = await tool.handler({ token: opencode.token, action: "list", room: "project-test" });
    assert.match(readByTeammate.content[0].text, /The demo gate is extension restart stability/);
    assert.match(readByTeammate.content[0].text, /room-wide/);

    const pageWithoutUrl = await tool.handler({ token: codex.token, action: "append", room: "project-test", source: "page", text: "Untrusted page text" });
    assert.equal(pageWithoutUrl.isError, true, "page-derived notes still require a URL for provenance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
