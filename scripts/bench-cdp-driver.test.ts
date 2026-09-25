import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { connectBenchBroker } from "./bench/cdp-driver";

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
