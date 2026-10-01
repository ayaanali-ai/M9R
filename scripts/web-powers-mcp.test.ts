import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createM9rMcpServer } from "../src/lib/native/mcp-server.ts";
import type { LocalStore } from "../src/lib/native/local-store";
import type { WebRequest } from "../src/lib/native/web-broker-core";

const powerNames = [
  "m9r_web_scroll", "m9r_web_wait", "m9r_web_back", "m9r_web_forward", "m9r_web_tabs", "m9r_web_switch", "m9r_web_do",
  "m9r_web_close", "m9r_web_press", "m9r_web_select", "m9r_web_find", "m9r_web_hover", "m9r_web_screenshot", "m9r_web_extract",
  "m9r_web_snapshot", "m9r_web_click_at", "m9r_web_reload", "m9r_web_double_click", "m9r_web_right_click", "m9r_web_drag", "m9r_web_drop",
  "m9r_web_check", "m9r_web_uncheck", "m9r_web_toggle", "m9r_web_fill_form", "m9r_web_select_text", "m9r_web_copy", "m9r_web_paste",
  "m9r_web_upload", "m9r_web_download", "m9r_web_submit", "m9r_web_buy", "m9r_web_post", "m9r_web_follow", "m9r_web_like", "m9r_web_dm", "m9r_web_point", "m9r_web_follow_link",
];

test("MCP exposes all browser powers and binds each call to the verified caller", async (t) => {
  const requests: WebRequest[] = [];
  const store = {
    root: "C:/tmp/m9r-web-powers-test",
    verifyIdentity: (token: string) => token === "valid-test-token" ? { handle: "claude", provider: "claude-code", sessionId: "session-1" } : null,
  } as unknown as LocalStore;
  const server = createM9rMcpServer({
    store,
    web: { run: async (request) => { requests.push(request); return { ok: true, data: { done: true }, label: "Search box" }; } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "web-powers-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const name of powerNames) assert.ok(names.includes(name), `missing MCP tool ${name}`);

  const response = await client.callTool({ name: "m9r_web_scroll", arguments: { token: "valid-test-token", tab: "research", by: 240 } });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    agent: "claude", provider: "claude-code", sessionId: "session-1", action: "scroll", tab: "research",
    selector: undefined, args: { to: undefined, by: 240, smooth: undefined },
  });
  const content = response.content as Array<{ type: string; text?: string }>;
  assert.equal(content[0]?.type, "text");
  assert.match(content[0]?.text ?? "", /Target: Search box/);

  await client.callTool({ name: "m9r_web_scroll", arguments: { token: "bad-token", by: 240 } });
  assert.equal(requests.length, 1, "unverified identity must never reach the broker");
});

test("snapshot refs map into the protected broker selector slot without changing its request contract", async (t) => {
  const requests: WebRequest[] = [];
  const store = {
    root: "C:/tmp/m9r-web-ref-test",
    verifyIdentity: () => ({ handle: "codex", provider: "codex", sessionId: "session-ref" }),
  } as unknown as LocalStore;
  const server = createM9rMcpServer({ store, web: { run: async (request) => { requests.push(request); return { ok: true }; } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "web-ref-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({ name: "m9r_web_snapshot", arguments: { token: "valid", tab: "research", query: "search", limit: 150 } });
  assert.deepEqual(requests[0], { agent: "codex", provider: "codex", sessionId: "session-ref", action: "snapshot", tab: "research", args: { query: "search", limit: 150 } });
  await client.callTool({ name: "m9r_web_click", arguments: { token: "valid", tab: "research", ref: "e0123456789abcdef01234567_12" } });
  assert.equal(requests[1]?.selector, "@m9r-ref:e0123456789abcdef01234567_12");
  assert.equal(requests[1]?.action, "click");
});

test("m9r_web_press exposes the page-change result and the no-change hint to the agent", async (t) => {
  const store = {
    root: "C:/tmp/m9r-web-press-test",
    verifyIdentity: () => ({ handle: "codex", provider: "codex", sessionId: "session-press" }),
  } as unknown as LocalStore;
  const server = createM9rMcpServer({
    store,
    web: { run: async () => ({ ok: true, data: { pressed: "Enter", pageChanged: false, hint: "Nothing visibly changed after Enter; check the page before retrying." } }) },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "web-press-result-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({ name: "m9r_web_press", arguments: { token: "valid", tab: "research", key: "Enter" } });
  const content = response.content as Array<{ type: string; text?: string }>;
  assert.match(content[0]?.text ?? "", /"pageChanged":false/);
  assert.match(content[0]?.text ?? "", /Nothing visibly changed after Enter/);
});

test("m9r_web_do sends one ordered batch request and returns the broker result", async (t) => {
  const batches: unknown[] = [];
  const store = {
    root: "C:/tmp/m9r-web-batch-test",
    verifyIdentity: () => ({ handle: "codex", provider: "codex", sessionId: "session-batch" }),
  } as unknown as LocalStore;
  const server = createM9rMcpServer({
    store,
    web: {
      run: async () => ({ ok: true }),
      runBatch: async (request) => {
        batches.push(request);
        return { ok: true, steps: [{ index: 0, action: "open", response: { ok: true, pageState: { url: "https://example.test/", title: "Example", topControls: [{ ref: "e0123456789abcdef01234567_1", role: "button", name: "Save", position: 1 }] } } }] };
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "web-batch-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({ name: "m9r_web_do", arguments: {
    token: "valid", tab: "research", includePageState: true,
    steps: [{ action: "open", url: "https://example.test/" }, { action: "click", ref: "e0123456789abcdef01234567_1" }],
  } });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], {
    agent: "codex", provider: "codex", sessionId: "session-batch", tab: "research", includePageState: true,
    steps: [{ action: "open", url: "https://example.test/" }, { action: "click", selector: "@m9r-ref:e0123456789abcdef01234567_1" }],
  });
  const content = response.content as Array<{ type: string; text?: string }>;
  assert.match(content[0]?.text ?? "", /\"topControls\"/);
});

test("a web-room agent's inbox cursor survives a fresh respawn (a new session ID every message must not re-show its whole delivered history)", async (t) => {
  const cursors: Record<string, number> = {};
  const tasks = [
    { id: "T1", seq: 1, from: "web-claude", to: "web-opencode", goal: "old stop-all relic from hours ago", origin: "agent_initiated" as const, approval: "approved" as const, replyDepth: 0, idempotencyKey: "k1", createdAt: "2026-09-27T01:00:00.000Z", goalTruncated: false, pointers: [] },
    { id: "T2", seq: 2, from: "web-codex", to: "web-opencode", goal: "the real, current question", origin: "agent_initiated" as const, approval: "approved" as const, replyDepth: 0, idempotencyKey: "k2", createdAt: "2026-09-27T02:00:00.000Z", goalTruncated: false, pointers: [] },
  ];
  const store = {
    root: "C:/tmp/m9r-cursor-test",
    verifyIdentity: (token: string) => token.startsWith("web-session-") ? { handle: "opencode", provider: "opencode", sessionId: token } : null,
    tasksFor: (handle: string) => tasks.filter((t) => t.to === handle),
    cursorFor: (handle: string, sessionId?: string) => cursors[`${handle}\u0000${sessionId ?? ""}`] ?? 0,
    setCursor: (handle: string, sessionId: string | undefined, seq: number) => { cursors[`${handle}\u0000${sessionId ?? ""}`] = seq; },
  } as unknown as LocalStore;
  const server = createM9rMcpServer({
    store,
    web: { run: async () => ({ ok: true }), authorizeRoomMessage: async () => ({ ok: true }) },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cursor-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // First worker (session A) already saw both messages, including the ancient one, and its cursor advanced.
  const first = await client.callTool({ name: "m9r_inbox", arguments: { token: "web-session-A" } });
  const firstText = (first.content as Array<{ text?: string }>)[0]?.text ?? "";
  assert.match(firstText, /old stop-all relic/);
  assert.match(firstText, /real, current question/);

  // A brand-new process for the same agent (session B) must NOT see that ancient relic resurface.
  const second = await client.callTool({ name: "m9r_inbox", arguments: { token: "web-session-B" } });
  const secondText = (second.content as Array<{ text?: string }>)[0]?.text ?? "";
  assert.equal(secondText, "Inbox is empty.", "a fresh respawn's cursor must not reset to zero and re-show old delivered tasks");
});
