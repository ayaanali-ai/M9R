import test from "node:test";
import assert from "node:assert/strict";

import { run, localPath, type CliDeps } from "../src/lib/oathlock-cli-core.ts";

const CWD = "/repo";

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function harness(router: (url: string, init?: RequestInit) => ReturnType<typeof response>) {
  const token = "oak_conversation_secret";
  const files = new Map<string, string>([[localPath(CWD), JSON.stringify({ token })]]);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    cwd: CWD,
    env: {},
    fetch: (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return router(String(url), init);
    }) as unknown as typeof fetch,
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeFile: async (path, value) => { files.set(path, value); },
    mkdir: async () => {},
    fileExists: async (path) => files.has(path),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, requests, out, err, token };
}

const PEERS = { connections: [{ connection_id: "conn-codex", agent_kind: "codex" }, { connection_id: "conn-grok", agent_kind: "grok-build" }] };

test("conversation start resolves --with to a connection id and posts topic + participants", async () => {
  const h = harness((url) => {
    if (url.endsWith("/api/agent/connections")) return response(200, PEERS);
    if (url.endsWith("/api/agent/conversations")) {
      return response(201, { conversation: { id: "conv-1", topic: "Task A handoff", status: "open", created_at: "2030-01-01T00:00:00Z" } });
    }
    return response(404, { error: "unexpected" });
  });

  const code = await run(["conversation", "start", "--topic", "Task A handoff", "--with", "codex"], h.deps);
  assert.equal(code, 0);
  const startReq = h.requests.find((r) => r.url.endsWith("/api/agent/conversations"));
  assert.deepEqual(JSON.parse(String(startReq?.init?.body)), {
    topic: "Task A handoff",
    participant_connection_ids: ["conn-codex"],
  });
  assert.match(h.out.join("\n"), /Conversation started/);
  assert.match(h.out.join("\n"), /conv-1/);
});

test("conversation start can include the authenticated caller alongside peer agents", async () => {
  const h = harness((url) => {
    if (url.endsWith("/api/agent/connections")) return response(200, { connections: [{ connection_id: "conn-claude", agent_kind: "claude-code" }, { connection_id: "conn-opencode", agent_kind: "opencode" }] });
    if (url.endsWith("/api/agent/whoami")) return response(200, { connectionId: "conn-codex", agentKind: "codex" });
    if (url.endsWith("/api/agent/conversations")) return response(201, { conversation: { id: "conv-all", topic: "All agents", status: "open", created_at: "2030-01-01T00:00:00Z" } });
    return response(404, { error: "unexpected" });
  });

  const code = await run(["conversation", "start", "--topic", "All agents", "--with", "codex,claude-code,opencode"], h.deps);
  assert.equal(code, 0);
  const startReq = h.requests.find((r) => r.url.endsWith("/api/agent/conversations"));
  assert.deepEqual(JSON.parse(String(startReq?.init?.body)), {
    topic: "All agents",
    participant_connection_ids: ["conn-codex", "conn-claude", "conn-opencode"],
  });
});

test("conversation start fails closed when --with matches no active connection", async () => {
  const h = harness((url) => (url.endsWith("/api/agent/connections") ? response(200, PEERS) : response(404, {})));
  const code = await run(["conversation", "start", "--topic", "Task A", "--with", "grok-3000"], h.deps);
  assert.equal(code, 1);
  assert.match(h.err.join("\n"), /no active connection matching "grok-3000"/);
});

test("conversation send resolves --to and defaults kind to message, broadcasts when --to is omitted", async () => {
  const h = harness((url) => {
    if (url.endsWith("/api/agent/connections")) return response(200, PEERS);
    if (url.includes("/api/agent/conversations/conv-1/messages")) return response(201, { message: { id: "msg-1" } });
    return response(404, { error: "unexpected" });
  });

  const code = await run([
    "conversation", "send", "--conversation", "conv-1", "--to", "codex",
    "--type", "handoff", "--text", "I need you to perform part 2 of Task A while I do part 1.",
  ], h.deps);
  assert.equal(code, 0);
  const sendReq = h.requests.find((r) => r.url.includes("/messages"));
  assert.deepEqual(JSON.parse(String(sendReq?.init?.body)), {
    recipient_connection_id: "conn-codex",
    kind: "handoff",
    body: "I need you to perform part 2 of Task A while I do part 1.",
  });

  const broadcastHarness = harness((url) =>
    url.includes("/api/agent/conversations/conv-1/messages") ? response(201, { message: { id: "msg-2" } }) : response(404, {}),
  );
  const broadcastCode = await run(["conversation", "send", "--conversation", "conv-1", "--text", "status update"], broadcastHarness.deps);
  assert.equal(broadcastCode, 0);
  assert.deepEqual(JSON.parse(String(broadcastHarness.requests[0].init?.body)), {
    recipient_connection_id: null,
    kind: "message",
    body: "status update",
  });
  assert.match(broadcastHarness.out.join("\n"), /broadcast/);
});

test("conversation messages resolves sender/recipient connection ids to agent kinds", async () => {
  const h = harness((url) => {
    if (url.endsWith("/api/agent/connections")) return response(200, PEERS);
    if (url.includes("/api/agent/conversations/conv-1/messages")) {
      return response(200, {
        messages: [
          { id: "m1", sender_connection_id: "conn-self", recipient_connection_id: "conn-codex", kind: "handoff", body: "do part 2", created_at: "2030-01-01T00:00:00Z" },
          { id: "m2", sender_connection_id: "conn-codex", recipient_connection_id: null, kind: "ack", body: "okay, I'll be back with a summary", created_at: "2030-01-01T00:00:01Z" },
        ],
      });
    }
    return response(404, { error: "unexpected" });
  });
  const code = await run(["conversation", "messages", "--conversation", "conv-1"], h.deps);
  assert.equal(code, 0);
  const text = h.out.join("\n");
  assert.match(text, /messages: 2/);
  assert.match(text, /\[handoff\] you -> codex: do part 2/);
  assert.match(text, /\[ack\] codex -> everyone: okay, I'll be back with a summary/);
});

test("conversation commands fail closed without a local token, making no request", async () => {
  const deps: CliDeps = {
    cwd: CWD,
    env: {},
    fetch: (async () => response(500, {})) as unknown as typeof fetch,
    readFile: async () => { throw new Error("ENOENT"); },
    writeFile: async () => {},
    mkdir: async () => {},
    fileExists: async () => false,
    out: () => {},
    err: () => {},
  };
  assert.equal(await run(["conversation", "start", "--topic", "x", "--with", "codex"], deps), 1);
  assert.equal(await run(["conversation", "send", "--conversation", "c", "--text", "x"], deps), 1);
  assert.equal(await run(["conversation", "messages", "--conversation", "c"], deps), 1);
});
