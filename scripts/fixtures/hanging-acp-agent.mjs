#!/usr/bin/env node
/**
 * Minimal ACP agent fixture for testing acp-stdio-adapter.ts's prompt
 * timeout: answers `initialize` and `session/new` normally (so a real
 * session actually gets established), but `session/prompt` never
 * resolves -- modeled on the SDK's own dist/examples/agent.js, stripped to
 * exactly what's needed to reproduce a genuinely hung provider turn.
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);

acp
  .agent({ name: "hanging-fixture-agent" })
  .onRequest("initialize", async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", async () => ({ sessionId: "fixture-session-1" }))
  .onRequest("authenticate", async () => ({}))
  // Deliberately never resolves or rejects -- simulates the observed hang
  // (a provider subprocess spawn that never returns, matching the
  // CreateProcessAsUserW failures seen live) with no timeout of its own.
  .onRequest("session/prompt", () => new Promise(() => {}))
  .connect(stream);
