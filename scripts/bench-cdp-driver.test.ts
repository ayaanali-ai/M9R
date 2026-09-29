import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { Cdp, connectBenchBroker } from "./bench/cdp-driver";

test("CDP driver sends the broker ready handshake as soon as its extension socket opens", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let received: unknown;
  server.on("connection", (socket) => {
    socket.once("message", (data) => {
      received = JSON.parse(String(data));
      socket.send(JSON.stringify({ type: "ack" }));
    });
  });

  const client = await connectBenchBroker(address.port);
  try {
    for (let i = 0; i < 20 && received === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(received, { type: "ready" });
    assert.equal(client.readyState, WebSocket.OPEN);
  } finally {
    client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pending DevTools calls fail immediately with socket-close details", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let peer: WebSocket | undefined;
  server.once("connection", (socket) => { peer = socket; });

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    await once(socket, "open");
    assert.ok(peer);
    const cdp = new Cdp(socket);
    const startedAt = Date.now();
    const pending = cdp.send("Page.enable", {}, "test-session");
    peer.close(1011, "simulated CDP loss");

    await assert.rejects(pending, /DevTools WebSocket closed \(code 1011\): simulated CDP loss/);
    assert.ok(Date.now() - startedAt < 1_000, "closed CDP transport should not masquerade as a 15-second protocol timeout");
  } finally {
    socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
