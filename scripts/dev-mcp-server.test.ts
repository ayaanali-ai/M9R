/**
 * Dev tool MCP server — Buzz-parity (crates/buzz-dev-mcp) — integration
 * tests. Connects a real MCP Client to the real server over an in-memory
 * transport pair (not a mock of either side) and calls each registered
 * tool, verifying both the happy path and the containment refusal that is
 * this port's one deliberate divergence from Buzz's own unbounded posture.
 */

import test from "node:test";
/* The MCP SDK returns an intentionally open tool-result shape. These tests
 * assert protocol fields at runtime, so keep the boundary assertions explicit
 * instead of hiding them behind a second test-only model of the SDK types. */
/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevMcpServer, isDirectDevMcpProcess } from "../src/lib/bridge/dev-mcp-server.ts";
import { TERMINAL_ENABLED } from "../src/lib/terminal-config.ts";

test("compiled MCP entrypoint recognizes a Windows path without requiring a file URL slash shape", () => {
  assert.equal(
    isDirectDevMcpProcess("C:\\RunLeak\\runleak\\cli\\dist\\dev-mcp-server.js", "file:///C:/RunLeak/runleak/cli/dist/dev-mcp-server.js"),
    true,
  );
  assert.equal(
    isDirectDevMcpProcess("C:\\RunLeak\\runleak\\cli\\dist\\other.js", "file:///C:/RunLeak/runleak/cli/dist/dev-mcp-server.js"),
    false,
  );
});

async function withClient(root: string, run: (client: Client) => Promise<void>): Promise<void> {
  const server = createDevMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((entry) => entry.type === "text");
  return block?.text ?? "";
}

function isSuccess(result: { isError?: boolean }): boolean {
  return result.isError !== true;
}

test("read_file reads a file within the working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await writeFile(join(root, "hello.txt"), "hello world", "utf8");
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } }) as any;
      assert.equal(textOf(result), "hello world");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file refuses a path outside the working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/passwd" } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /outside the working directory/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("str_replace replaces exactly one unique occurrence", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await writeFile(join(root, "code.ts"), "const x = 1;\nconst y = 2;", "utf8");
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "str_replace", arguments: { path: "code.ts", oldText: "const x = 1;", newText: "const x = 100;" } }) as any;
      assert.equal(result.isError, undefined);
      const read = await client.callTool({ name: "read_file", arguments: { path: "code.ts" } }) as any;
      assert.equal(textOf(read), "const x = 100;\nconst y = 2;");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("str_replace refuses a non-unique oldText", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await writeFile(join(root, "dup.ts"), "foo\nfoo", "utf8");
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "str_replace", arguments: { path: "dup.ts", oldText: "foo", newText: "bar" } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /must be unique/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("str_replace refuses when oldText is not found", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await writeFile(join(root, "empty.ts"), "nothing here", "utf8");
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "str_replace", arguments: { path: "empty.ts", oldText: "missing", newText: "x" } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not found/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tree lists files and directories, excluding node_modules and .git", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "", "utf8");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "should-not-appear.js"), "", "utf8");
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "tree", arguments: { path: "." } }) as any;
      const text = textOf(result);
      assert.match(text, /src\//);
      assert.match(text, /src\/index\.ts/);
      assert.doesNotMatch(text, /node_modules/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git_read completes a bounded read-only repository inspection", async () => {
  const root = process.cwd();
  await withClient(root, async (client) => {
    const result = await client.callTool({ name: "git_read", arguments: { operation: "log", limit: 1 } }) as any;
    assert.equal(isSuccess(result), true);
    assert.match(textOf(result), /^git log -1 --oneline\n[\s\S]+/);
  });
});

test("todo add/list/complete round-trips", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await withClient(root, async (client) => {
      const added = await client.callTool({ name: "todo", arguments: { action: "add", text: "write tests" } }) as any;
      const addedText = textOf(added);
      const id = addedText.match(/Added ([^:]+):/)?.[1];
      assert.ok(id, "expected an id in the add response");

      const listed = await client.callTool({ name: "todo", arguments: { action: "list" } }) as any;
      assert.match(textOf(listed), /\[ \].*write tests/);

      const completed = await client.callTool({ name: "todo", arguments: { action: "complete", id } }) as any;
      assert.equal(isSuccess(completed), true);

      const listedAfter = await client.callTool({ name: "todo", arguments: { action: "list" } }) as any;
      assert.match(textOf(listedAfter), /\[x\].*write tests/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("todo complete refuses an unknown id", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "todo", arguments: { action: "complete", id: "does-not-exist" } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /No todo with id/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server exposes exactly the governed tool set (no unrestricted shell or view_image)", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await withClient(root, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      // handoff_to_terminal is registered only while the terminal multiplayer
      // view is enabled (NEXT_PUBLIC_M9R_TERMINAL_ENABLED), which is off by
      // default -- so the governed set shrinks by exactly that one tool.
      const expected = ["draft_section", "git_read", "read_file", "request_assignment_change", "request_evidence_review", "rg", "search_memory", "send_message", "str_replace", "submit_evidence", "todo", "tree"];
      if (TERMINAL_ENABLED) expected.push("handoff_to_terminal");
      assert.deepEqual(names, expected.sort());
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("send_message refuses when no channel connection was provided", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "send_message", arguments: { text: "@codex hi" } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /no channel connection/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("send_message refuses when the mission isn't bound to a chat channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    const server = createDevMcpServer(root, { appUrl: "https://example.invalid", agentToken: "tok", missionId: "not-a-channel-mission" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "send_message", arguments: { text: "@codex hi" } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /isn't bound to a chat channel/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("send_message posts to the real conversation-messages endpoint derived from the channel- mission id", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  let capturedAuth: string | null = null;
  let capturedBody: unknown = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ message: { id: "m1" } }), { status: 201 });
  }) as typeof fetch;
  try {
    const server = createDevMcpServer(root, { appUrl: "https://oathlock.example/", agentToken: "agent-tok-123", missionId: "channel-abc-123" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "send_message", arguments: { text: "@codex can you review this and get back to me?" } }) as any;
      assert.equal(isSuccess(result), true);
      assert.match(textOf(result), /posted/i);
      assert.equal(capturedUrl, "https://oathlock.example/api/agent/conversations/abc-123/messages");
      assert.equal(capturedAuth, "Bearer agent-tok-123");
      assert.deepEqual(capturedBody, { kind: "message", body: "@codex can you review this and get back to me?" });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("send_message preserves thread replies and deliberate direct-recipient routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ message: { id: "m2" } }), { status: 201 });
  }) as typeof fetch;
  try {
    const server = createDevMcpServer(root, { appUrl: "https://oathlock.example", agentToken: "agent-tok", missionId: "channel-abc-123" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "send_message",
        arguments: { text: "@claude-code review this result", parentMessageId: "human-message-7", recipientConnectionId: "claude-connection-2" },
      }) as any;
      assert.equal(isSuccess(result), true);
      assert.deepEqual(capturedBody, {
        kind: "message",
        body: "@claude-code review this result",
        parent_message_id: "human-message-7",
        recipient_connection_id: "claude-connection-2",
      });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("send_message surfaces a clear error when the API call fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("moderation blocked", { status: 403 })) as typeof fetch;
  try {
    const server = createDevMcpServer(root, { appUrl: "https://oathlock.example", agentToken: "tok", missionId: "channel-abc-123" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "send_message", arguments: { text: "@codex hi" } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /HTTP 403/);
      assert.match(textOf(result), /moderation blocked/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("submit_evidence refuses when no channel connection was provided", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  try {
    await withClient(root, async (client) => {
      const result = await client.callTool({ name: "submit_evidence", arguments: {
        requestId: "request-1",
        evidence: {
          schemaVersion: "oathlock.chat-evidence.v1",
          summary: "Fixed the thing.",
          work: ["Updated the reconnect path."],
          files: ["src/lib/mission/mission-relay-browser-client.ts"],
          verification: [{ command: "npm test", result: "passed" }],
          limitations: [],
        },
      } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /no channel connection/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request_evidence_review is a separate approval request before evidence submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ id: "request-1", message: { id: "m-request-1" } }), { status: 201 });
  }) as typeof fetch;
  try {
    const server = createDevMcpServer(root, { appUrl: "https://oathlock.example", agentToken: "tok", missionId: "channel-abc-123" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "request_evidence_review", arguments: { summary: "I finished the requested change and have verification ready." } }) as any;
      assert.equal(isSuccess(result), true);
      assert.match(textOf(result), /approval/i);
      assert.deepEqual(calls, [{
        url: "https://oathlock.example/api/agent/conversations/abc-123/evidence/requests",
        body: { summary: "I finished the requested change and have verification ready." },
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("submit_evidence posts to the evidence endpoint derived from the channel- mission id, not the messages endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  let capturedAuth: string | null = null;
  let capturedBody: unknown = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ id: "e1", message: { id: "m1" } }), { status: 201 });
  }) as typeof fetch;
  try {
    const server = createDevMcpServer(root, { appUrl: "https://oathlock.example/", agentToken: "agent-tok-123", missionId: "channel-abc-123" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const evidence = {
        schemaVersion: "oathlock.chat-evidence.v1",
        summary: "Fixed the double-turn bug.",
        work: ["Preserved the cursor across reconnects."],
        files: ["src/lib/mission/mission-relay-browser-client.ts"],
        verification: [{ command: "npm run test:phase1-relay", result: "12 tests passed" }],
        limitations: ["No live provider task was run."],
      };
      const result = await client.callTool({ name: "submit_evidence", arguments: { requestId: "request-1", evidence } }) as any;
      assert.equal(isSuccess(result), true);
      assert.match(textOf(result), /submitted/i);
      assert.equal(capturedUrl, "https://oathlock.example/api/agent/conversations/abc-123/evidence");
      assert.equal(capturedAuth, "Bearer agent-tok-123");
      assert.deepEqual(capturedBody, { requestId: "request-1", evidence });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("submit_evidence surfaces a clear error when the API call fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "oathlock-devmcp-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("workspace not found", { status: 404 })) as typeof fetch;
  try {
    const server = createDevMcpServer(root, { appUrl: "https://oathlock.example", agentToken: "tok", missionId: "channel-abc-123" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "submit_evidence", arguments: {
        requestId: "request-1",
        evidence: {
          schemaVersion: "oathlock.chat-evidence.v1",
          summary: "Fixed the thing.",
          work: ["Updated the reconnect path."],
          files: ["src/lib/mission/mission-relay-browser-client.ts"],
          verification: [{ command: "npm test", result: "passed" }],
          limitations: [],
        },
      } }) as any;
      assert.equal(result.isError, true);
      assert.match(textOf(result), /HTTP 404/);
      assert.match(textOf(result), /workspace not found/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
