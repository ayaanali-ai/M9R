import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";

type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> };

test("m9r_memory is real, shared cross-agent memory -- not a fake/placeholder surface", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-memory-mcp-"));
  try {
    const local = createLocalStore(root);
    const codex = local.issueIdentity("codex", "codex", "session-codex");
    const claude = local.issueIdentity("claude-code", "claude-code", "session-claude");
    const server = createM9rMcpServer({ store: local });
    const tool = (server as unknown as ToolServer)._registeredTools.m9r_memory;
    assert.ok(tool, "m9r_memory is registered");
    const call = (args: unknown) => tool.handler(args);

    // One agent writes a global fact...
    const added = await call({ token: codex.token, action: "add", text: "User prefers terse commit messages." });
    assert.equal(added.isError, undefined);
    assert.match(added.content[0].text, /Saved/);

    // ...a DIFFERENT agent reads it back, with the writer's identity attached -- the
    // "teammates, no walls" model, not per-agent-isolated storage.
    const seenByTeammate = await call({ token: claude.token, action: "list" });
    assert.match(seenByTeammate.content[0].text, /User prefers terse commit messages/);
    assert.match(seenByTeammate.content[0].text, /@codex/);

    // persona scope is honored and filterable.
    const personaAdd = await call({ token: claude.token, action: "add", text: "Deep in the pill redesign this week.", scope: "persona:claude-code" });
    assert.equal(personaAdd.isError, undefined);
    const personaList = await call({ token: codex.token, action: "list", scope: "persona:claude-code" });
    assert.match(personaList.content[0].text, /Deep in the pill redesign/);
    assert.doesNotMatch(personaList.content[0].text, /terse commit messages/);

    // Invalid scope is rejected, not silently accepted.
    const badScope = await call({ token: codex.token, action: "add", text: "x", scope: "not-a-scope" });
    assert.equal(badScope.isError, true);

    // remove actually removes it -- not a no-op that just says it did.
    const idMatch = /\[([^\]]+)\]/.exec(added.content[0].text) ?? /Saved (\S+)/.exec(added.content[0].text);
    const firstEntry = (await call({ token: codex.token, action: "list", scope: "global" })).content[0].text;
    const entryId = /\[([^\]]+)\]/.exec(firstEntry)?.[1];
    assert.ok(entryId, "list renders a real entry id");
    const removed = await call({ token: codex.token, action: "remove", id: entryId });
    assert.match(removed.content[0].text, /Removed/);
    const afterRemove = await call({ token: codex.token, action: "list", scope: "global" });
    assert.doesNotMatch(afterRemove.content[0].text, /terse commit messages/);

    // Persists to the real store root (survives a fresh server instance against the same root).
    const reopened = createM9rMcpServer({ store: createLocalStore(root) });
    const reopenedTool = (reopened as unknown as ToolServer)._registeredTools.m9r_memory;
    const stillThere = await reopenedTool.handler({ token: codex.token, action: "list", scope: "persona:claude-code" });
    assert.match(stillThere.content[0].text, /Deep in the pill redesign/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("m9r_memory's relate/relationship actions build pair history regardless of who asks", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-memory-mcp-"));
  try {
    const local = createLocalStore(root);
    const codex = local.issueIdentity("codex", "codex", "session-codex");
    const claude = local.issueIdentity("claude-code", "claude-code", "session-claude");
    const server = createM9rMcpServer({ store: local });
    const tool = (server as unknown as ToolServer)._registeredTools.m9r_memory;
    const call = (args: unknown) => tool.handler(args);

    const noHistory = await call({ token: codex.token, action: "relationship", with: "claude-code" });
    assert.match(noHistory.content[0].text, /No relationship history yet/);

    const handoff = await call({ token: codex.token, action: "relate", with: "claude-code", kind: "handoff", note: "Picked up the pill redesign cleanly." });
    assert.match(handoff.content[0].text, /Logged a handoff/);
    const correction = await call({ token: claude.token, action: "relate", with: "codex", kind: "correction", note: "Had to fix a missing scope check." });
    assert.equal(correction.isError, undefined);

    // Either side of the pair sees the same combined history.
    const fromClaude = await call({ token: claude.token, action: "relationship", with: "codex" });
    assert.match(fromClaude.content[0].text, /handoffs: 1, corrections: 1, praise: 0, friction: 0/);
    assert.match(fromClaude.content[0].text, /Had to fix a missing scope check/);

    const badKind = await call({ token: codex.token, action: "relate", with: "claude-code", kind: "nonsense", note: "x" });
    assert.equal(badKind.isError, true);
    const selfPair = await call({ token: codex.token, action: "relate", with: "codex", kind: "praise", note: "x" });
    assert.equal(selfPair.isError, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("m9r_memory refuses invalid identity and empty text", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-memory-mcp-"));
  try {
    const server = createM9rMcpServer({ store: createLocalStore(root) });
    const tool = (server as unknown as ToolServer)._registeredTools.m9r_memory;
    assert.ok(tool);
    await assert.rejects(tool.handler({ token: "invalid", action: "list" }), /could not verify this agent connection/);
    const token = createLocalStore(root).issueIdentity("codex", "codex", "s").token;
    const response = await tool.handler({ token, action: "add" });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /text is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
