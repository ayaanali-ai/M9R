import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { MISSION_RELAY_FRAME_VERSION, type RelayFrame } from "@/lib/mission/mission-relay-protocol";
import { WorkspaceRelayBrowserClient } from "@/lib/mission/mission-relay-browser-client";

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  readyState = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(raw: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(raw);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(frame: RelayFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  fail(): void {
    this.emit("error");
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? null;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const originalWebSocket = globalThis.WebSocket;

function relayReady(): RelayFrame {
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: "ready",
    type: "relay.ready",
    workspaceId: "workspace-1",
    channelId: "channel-1",
    correlationId: "auth",
    causationId: null,
    idempotencyKey: null,
    sentAt: "2026-08-09T00:00:00.000Z",
    payload: { principalKind: "human", principalId: "user-1" },
  };
}

function workspaceSnapshot(cursor: string): RelayFrame {
  return {
    ...relayReady(),
    frameId: "snapshot",
    type: "workspace.snapshot",
    correlationId: "subscribe",
    payload: { snapshot: { messages: [], participants: [], activity: [], cursor } },
  };
}

function lastSentFrame(socket: FakeWebSocket, type: string): RelayFrame {
  const raw = [...socket.sent].reverse().map((value) => JSON.parse(value) as RelayFrame).find((frame) => frame.type === type);
  assert.ok(raw, `expected a ${type} frame`);
  return raw;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
});

test("workspace relay resumes from the last snapshot cursor after reconnect", async () => {
  const client = new WorkspaceRelayBrowserClient({ url: "wss://relay.test", workspaceId: "workspace-1", channelId: "channel-1", credential: "credential", reconnect: false });
  const firstConnect = client.connect();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  firstSocket.receive(relayReady());
  await firstConnect;
  firstSocket.receive(workspaceSnapshot("2026-08-09T00:00:12.000Z"));

  firstSocket.close();
  const secondConnect = client.connect();
  const secondSocket = FakeWebSocket.instances[1];
  secondSocket.open();
  secondSocket.receive(relayReady());
  await secondConnect;

  assert.equal((lastSentFrame(secondSocket, "workspace.subscribe").payload as { cursor?: string }).cursor, "2026-08-09T00:00:12.000Z");
  client.close();
});

test("workspace relay authenticates before binding the selected channel", async () => {
  const client = new WorkspaceRelayBrowserClient({ url: "wss://relay.test", workspaceId: "workspace-1", channelId: "channel-1", credential: "credential", reconnect: false });
  const connect = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();

  const auth = lastSentFrame(socket, "auth.browser");
  assert.equal("channelId" in auth, false);
  assert.deepEqual(auth.payload, { credential: "credential" });

  socket.receive(relayReady());
  await connect;
  assert.equal(lastSentFrame(socket, "workspace.subscribe").channelId, "channel-1");
  client.close();
});

test("workspace relay fetches a fresh credential on reconnect", async () => {
  const credentials = ["credential-1", "credential-2"];
  const client = new WorkspaceRelayBrowserClient({
    url: "wss://relay.test",
    workspaceId: "workspace-1",
    channelId: "channel-1",
    getCredential: async () => credentials.shift() ?? "credential-fallback",
    reconnect: false,
  });
  const firstConnect = client.connect();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(lastSentFrame(firstSocket, "auth.browser").payload, { credential: "credential-1" });
  firstSocket.receive(relayReady());
  await firstConnect;

  firstSocket.close();
  const secondConnect = client.connect();
  const secondSocket = FakeWebSocket.instances[1];
  secondSocket.open();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(lastSentFrame(secondSocket, "auth.browser").payload, { credential: "credential-2" });
  secondSocket.receive(relayReady());
  await secondConnect;
  client.close();
});

test("workspace relay rejects a pending post immediately when the socket closes", async () => {
  const client = new WorkspaceRelayBrowserClient({ url: "wss://relay.test", workspaceId: "workspace-1", channelId: "channel-1", credential: "credential", reconnect: false });
  const connect = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive(relayReady());
  await connect;

  const pending = client.postMessage({ body: "hello", clientRequestId: "request-1" }).then(() => "resolved", () => "rejected");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  socket.close();
  const result = await Promise.race([pending, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))]);
  client.close();
  assert.equal(result, "rejected");
});

test("workspace relay resends the same pending post after reconnect", async () => {
  const client = new WorkspaceRelayBrowserClient({ url: "wss://relay.test", workspaceId: "workspace-1", channelId: "channel-1", credential: "credential", reconnect: true });
  const connect = client.connect();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  firstSocket.receive(relayReady());
  await connect;

  const pending = client.postMessage({ body: "retry me", clientRequestId: "stable-request-1" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const firstPost = lastSentFrame(firstSocket, "workspace.post");
  firstSocket.close();

  const reconnect = client.connect();
  const secondSocket = FakeWebSocket.instances[1];
  secondSocket.open();
  secondSocket.receive(relayReady());
  await reconnect;
  const secondPost = lastSentFrame(secondSocket, "workspace.post");
  assert.equal(secondPost.idempotencyKey, firstPost.idempotencyKey);
  assert.deepEqual(secondPost.payload, firstPost.payload);
  secondSocket.receive({ ...relayReady(), frameId: "event", type: "workspace.event", correlationId: firstPost.correlationId, payload: { message: { id: "message-1", created_at: "2026-08-09T00:00:13.000Z" }, cursor: "cursor-13" } });
  await pending;
  client.close();
});

test("workspace relay closes after a relay error so a later connection can recover", async () => {
  const client = new WorkspaceRelayBrowserClient({ url: "wss://relay.test", workspaceId: "workspace-1", channelId: "channel-1", credential: "credential", reconnect: false });
  const connect = client.connect();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  firstSocket.receive(relayReady());
  await connect;

  firstSocket.receive({
    ...relayReady(),
    frameId: "relay-error",
    type: "relay.error",
    payload: { message: "temporary relay failure" },
  });
  assert.equal(firstSocket.readyState, FakeWebSocket.CLOSED);
  assert.equal(firstSocket.closeCode, 4000, "browser-originated relay errors must use a valid client close code");

  const retry = client.connect();
  const secondSocket = FakeWebSocket.instances[1];
  secondSocket.open();
  secondSocket.receive(relayReady());
  await retry;
  assert.equal(client.isOpen, true);
  client.close();
});

test("workspace relay surfaces low-level connection errors to the status observer", async () => {
  const statuses: Array<[string, string | undefined]> = [];
  const client = new WorkspaceRelayBrowserClient({
    url: "wss://relay.test",
    workspaceId: "workspace-1",
    channelId: "channel-1",
    credential: "credential",
    reconnect: false,
    onStatus: (status, detail) => statuses.push([status, detail]),
  });
  const connect = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.fail();

  await assert.rejects(connect, /Workspace relay connection failed/);
  assert.deepEqual(statuses.at(-1), ["error", "Workspace relay connection failed."]);
  client.close();
});
