import assert from "node:assert/strict";
import test from "node:test";
import { mcpWorkerEnvironment, readM9rMcpConnectionConfig } from "@/lib/native/mcp-connection-env";

test("MCP connection configuration preserves explicit provider, binding, and process identity", () => {
  const connection = readM9rMcpConnectionConfig({
    M9R_PROVIDER: " claude-code ",
    M9R_CONNECTION_BINDING_ID: "binding-1",
    M9R_CONNECTION_PROCESS_ID: "4242",
  }, 99);
  assert.deepEqual(connection, { provider: "claude-code", bindingId: "binding-1", processId: 4242 });

  const worker = mcpWorkerEnvironment({ ...process.env, M9R_HOME: "C:/m9r", M9R_PROVIDER: "stale", M9R_MCP_WORKER: "0" }, connection);
  assert.equal(worker.M9R_HOME, "C:/m9r");
  assert.equal(worker.M9R_MCP_WORKER, "1");
  assert.equal(worker.M9R_PROVIDER, "claude-code");
  assert.equal(worker.M9R_CONNECTION_BINDING_ID, "binding-1");
  assert.equal(worker.M9R_CONNECTION_PROCESS_ID, "4242");
});

test("the top-level supervisor recovers provider claims by exact parent PID, while workers do not infer one", () => {
  assert.deepEqual(
    readM9rMcpConnectionConfig({}, 5151),
    { processId: 5151 },
    "the later store lookup must still require exactly one claim owned by this PID",
  );
  assert.deepEqual(readM9rMcpConnectionConfig({}, 0), {});
  assert.deepEqual(
    readM9rMcpConnectionConfig({ M9R_PROVIDER: "codex" }, 5151),
    { provider: "codex", processId: 5151 },
    "a configured provider must still carry the supervisor's exact parent PID for claim selection",
  );
  assert.deepEqual(
    readM9rMcpConnectionConfig({ M9R_PROVIDER: "codex", M9R_MCP_WORKER: "1" }, 5151),
    { provider: "codex" },
    "a worker must not infer ownership from its own supervisor parent",
  );
  assert.deepEqual(readM9rMcpConnectionConfig({ M9R_CONNECTION_BINDING_ID: "binding-1" }, 5151), { bindingId: "binding-1" });
});
