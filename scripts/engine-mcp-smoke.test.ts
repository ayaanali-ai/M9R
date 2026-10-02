// The engine exe (engine/dist/m9r-engine.exe) is what a real Codex/Claude session's MCP config actually launches --
// separate from cli/dist, which this repo rebuilds far more often. It went 5 days stale with nobody noticing because
// nothing ever actually launched it and checked it spoke MCP correctly; the owner's real Codex session hit
// "M9R browser tools are unavailable" as a result. This runs the real built exe through a real MCP handshake and
// confirms the web tools are actually present, not just that the process didn't crash.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const exe = join(process.cwd(), "engine", "dist", process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");

test("the built engine exe's `mcp` subcommand completes a real MCP handshake and exposes the web tools", { skip: !existsSync(exe) ? "engine/dist/m9r-engine.exe was not built (run: node scripts/build-engine.mjs)" : false }, async () => {
  const child = spawn(exe, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));
  try {
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-test", version: "1" } } });
    await new Promise((r) => setTimeout(r, 400));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await new Promise((r) => setTimeout(r, 1200));

    type ToolInfo = {
      name: string;
      inputSchema?: { properties?: Record<string, { pattern?: string; description?: string }> };
    };
    const messages = out.trim().split("\n").map((line) => { try { return JSON.parse(line) as { id?: number; result?: { tools?: ToolInfo[] } }; } catch { return null; } }).filter((m): m is NonNullable<typeof m> => Boolean(m));
    const initResult = messages.find((m) => m.id === 1);
    assert.ok(initResult, `no response to initialize (stderr: ${err.slice(0, 500)})`);
    const toolsResult = messages.find((m) => m.id === 2);
    assert.ok(toolsResult?.result?.tools, "no response to tools/list");
    const names = toolsResult.result!.tools!.map((t) => t.name);
    // These specifically require deps.web to be wired (scripts/m9r-mcp.ts) -- if the engine's MCP entry ever loses its
    // web broker client again, these tools are simply absent from the list, exactly reproducing the real failure.
    for (const required of ["m9r_web_open", "m9r_web_click", "m9r_web_read", "m9r_send", "m9r_inbox", "m9r_git_read", "m9r_read_file"]) {
      assert.ok(names.includes(required), `${required} missing from the engine's real tool list: [${names.join(", ")}]`);
    }
    const readTool = toolsResult.result!.tools!.find((tool) => tool.name === "m9r_web_read");
    assert.equal(
      readTool?.inputSchema?.properties?.ref?.pattern,
      "^e[a-f0-9]{24}_\\d{1,3}$",
      "the built engine must expose the current snapshot-scoped nonce-ref format",
    );
  } finally {
    child.kill();
  }
});

test("the built engine exe's `dev-mcp-server` subcommand starts the packaged governed MCP server", { skip: !existsSync(exe) ? "engine/dist/m9r-engine.exe was not built (run: node scripts/build-engine.mjs)" : false }, async () => {
  const child = spawn(exe, ["dev-mcp-server", process.cwd()], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));
  try {
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-test", version: "1" } } });
    await new Promise((r) => setTimeout(r, 400));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await new Promise((r) => setTimeout(r, 800));

    const messages = out.trim().split("\n").map((line) => { try { return JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string }; tools?: Array<{ name: string }> } }; } catch { return null; } }).filter((m): m is NonNullable<typeof m> => Boolean(m));
    const initResult = messages.find((m) => m.id === 1);
    assert.ok(initResult, `no response to initialize (exit=${child.exitCode}, stderr: ${err.slice(0, 500)})`);
    assert.equal(initResult.result?.serverInfo?.name, "m9r-dev-mcp");
    const toolsResult = messages.find((m) => m.id === 2);
    assert.ok(toolsResult?.result?.tools, `no response to tools/list (stderr: ${err.slice(0, 500)})`);
    const names = toolsResult.result!.tools!.map((tool) => tool.name);
    for (const required of ["read_file", "str_replace", "tree", "rg", "git_read", "send_message"]) {
      assert.ok(names.includes(required), `${required} missing from the packaged dev MCP tool list: [${names.join(", ")}]`);
    }
  } finally {
    child.kill();
  }
});
