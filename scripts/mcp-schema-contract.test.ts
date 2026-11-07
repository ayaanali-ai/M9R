import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import type { NetworkCoreClient } from "@/lib/native/network-core-client";

// Use the installed validator that backs ajv-formats, without adding a dependency.
const require = createRequire(import.meta.url);
const formatsRequire = createRequire(require.resolve("ajv-formats"));
const Ajv2020 = formatsRequire("ajv/dist/2020").default;
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

test("M9R tools/list emits valid 2020-12 schemas and preserves live tool registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-schema-"));
  const server = createM9rMcpServer({ store: createLocalStore(root), networkCore: {} as NetworkCoreClient });
  const client = new Client({ name: "schema-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const list = await client.listTools();
    assert.ok(list.tools.some(tool => tool.name === "m9r_computer_action"));
    assert.ok(list.tools.some(tool => tool.name === "m9r_network_join"));
    assert.ok(list.tools.length > 10);
    for (const tool of list.tools) {
      for (const [kind, schema] of Object.entries({ inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) })) {
        assert.equal(schema.$schema, DIALECT, `${tool.name}.${kind}`);
        assert.equal(schema.type, "object", `${tool.name}.${kind}`);
        assert.equal(ajv.validateSchema(schema), true, `${tool.name}.${kind}: ${ajv.errorsText()}`);
        ajv.compile(schema);
      }
    }
    const tool = server.registerTool("contract_tuple", {
      title: "Schema probe", description: "Local-only schema regression probe",
      inputSchema: { pair: z.tuple([z.string(), z.number()]) },
      annotations: { readOnlyHint: true }, _meta: { probe: true },
    }, async ({ pair }) => ({ content: [{ type: "text", text: JSON.stringify(pair) }] }));
    tool.update({ name: "contract_renamed" });
    const probe = (await client.listTools()).tools.find(tool => tool.name === "contract_renamed");
    assert.ok(probe);
    assert.equal(probe.title, "Schema probe");
    assert.equal(probe.annotations?.readOnlyHint, true);
    assert.deepEqual(probe._meta, { probe: true });
    const validate = ajv.compile(probe.inputSchema);
    assert.equal(validate({ pair: ["x", 2] }), true);
    assert.equal(validate({ pair: [2, "x"] }), false);
    assert.deepEqual((probe.inputSchema.properties?.pair as { prefixItems?: unknown[] }).prefixItems, [{ type: "string" }, { type: "number" }]);
    assert.equal((await client.callTool({ name: "contract_renamed", arguments: { pair: ["x", 2] } })).isError, undefined);
    assert.equal((await client.callTool({ name: "contract_renamed", arguments: { pair: [2, "x"] } })).isError, true);
    tool.disable();
    assert.equal((await client.listTools()).tools.some(tool => tool.name === "contract_renamed"), false);
    tool.enable();
    assert.equal((await client.listTools()).tools.some(tool => tool.name === "contract_renamed"), true);
    tool.remove();
    assert.equal((await client.listTools()).tools.some(tool => tool.name === "contract_renamed"), false);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
