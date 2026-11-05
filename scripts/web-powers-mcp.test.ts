import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createM9rMcpServer } from "../src/lib/native/mcp-server.ts";
import { createWebBrokerClient } from "../src/lib/native/web-broker-client.ts";
import type { LocalStore } from "../src/lib/native/local-store";

test("MCP omits retired extension-backed browser tools and exposes native desktop controls", async (t) => {
  const store = {
    root: "C:/tmp/m9r-retired-browser-tools-test",
    verifyIdentity: () => null,
  } as unknown as LocalStore;
  const server = createM9rMcpServer({ store });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retired-browser-tools-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.equal(names.some((name) => name.startsWith("m9r_web_")), false, "retired extension tools must not be registered");
  assert.ok(names.includes("m9r_stage_action"), "native desktop stage action remains available");
  assert.ok(names.includes("m9r_computer_observe"), "native computer observation remains available");
  assert.ok(names.includes("m9r_computer_action"), "native computer action remains available");
});

test("broker client has no legacy extension command methods", () => {
  const client = createWebBrokerClient({ keyPath: "C:/tmp/retired-browser-route.key", fetchImpl: async () => new Response("{}") });
  assert.equal("run" in client, false, "there is no client method that can call /cmd");
  assert.equal("runBatch" in client, false, "there is no client method that can call /batch");
});
