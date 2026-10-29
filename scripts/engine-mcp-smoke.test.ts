// The engine exe (engine/dist/m9r-engine.exe) is what a real Codex/Claude session's MCP config actually launches --
// separate from cli/dist, which this repo rebuilds far more often. It went 5 days stale with nobody noticing because
// nothing ever actually launched it and checked it spoke MCP correctly; the owner's real Codex session hit
// "M9R browser tools are unavailable" as a result. This runs the real built exe through a real MCP handshake and
// confirms the current native desktop tools are actually present, not just that the process didn't crash.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const exe = join(process.cwd(), "engine", "dist", process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");

test("the configured native hook serves MCP beyond the short per-event hook timeout", { skip: !existsSync(exe) ? "engine runtime was not built" : false }, async () => {
  const shim = join(process.cwd(), "engine", "dist", process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native");
  assert.ok(existsSync(shim), "the engine package must include its configured MCP launcher");
  const child = spawn(shim, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hook-mcp-smoke", version: "1" } } });
    await new Promise(done => setTimeout(done, 4200));
    assert.equal(child.exitCode, null, `MCP must not take the short-lived hook path: ${stderr}`);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await new Promise(done => setTimeout(done, 600));
    const messages = output.trim().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const tools = messages.find(message => message.id === 2)?.result?.tools ?? [];
    assert.ok(tools.some((tool: { name: string }) => tool.name === "m9r_stage_app"), `configured hook did not expose desktop tools: ${stderr}`);
  } finally {
    child.stdin.end();
    await new Promise(done => setTimeout(done, 400));
    if (child.exitCode === null) child.kill();
  }
});

test("the built engine exe's `mcp` subcommand completes a real MCP handshake and exposes the native tools", { skip: !existsSync(exe) ? "engine/dist/m9r-engine.exe was not built (run: node scripts/build-engine.mjs)" : false }, async () => {
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
      inputSchema?: { properties?: Record<string, { pattern?: string; description?: string; enum?: string[]; default?: string }> };
    };
    const messages = out.trim().split("\n").map((line) => { try { return JSON.parse(line) as { id?: number; result?: { serverInfo?: { version?: string }; tools?: ToolInfo[] } }; } catch { return null; } }).filter((m): m is NonNullable<typeof m> => Boolean(m));
    const initResult = messages.find((m) => m.id === 1);
    assert.ok(initResult, `no response to initialize (stderr: ${err.slice(0, 500)})`);
    const runtimeManifest = JSON.parse(readFileSync(join(process.cwd(), "engine", "dist", "m9r-build-info.json"), "utf8")) as { buildId?: string };
    const expectedBuildId = runtimeManifest.buildId ?? "";
    assert.match(expectedBuildId, /^[a-f0-9]{64}$/, "the engine package must carry its full artifact manifest");
    assert.equal(initResult.result?.serverInfo?.version, `1.0.0+${expectedBuildId.slice(0, 12)}`,
      "the running MCP engine identity must match the manifest packaged beside the executable");
    const toolsResult = messages.find((m) => m.id === 2);
    assert.ok(toolsResult?.result?.tools, "no response to tools/list");
    const names = toolsResult.result!.tools!.map((t) => t.name);
    // The active browser/app route is the owner-visible native desktop surface. The retired browser-extension tools
    // must stay out of the provider tool list so an agent cannot silently select the wrong control plane.
    for (const required of ["m9r_stage_prepare", "m9r_stage_app", "m9r_stage_action", "m9r_computer_observe", "m9r_computer_action", "m9r_send", "m9r_inbox", "m9r_git_read", "m9r_read_file"]) {
      assert.ok(names.includes(required), `${required} missing from the engine's real tool list: [${names.join(", ")}]`);
    }
    assert.ok(!names.includes("m9r_web_open"), "the retired browser-extension route must not be registered in the active engine");
    for (const toolName of ["m9r_stage_prepare", "m9r_stage_app", "m9r_stage_action"]) {
      const stageTool: ToolInfo | undefined = toolsResult.result!.tools!.find((tool: ToolInfo) => tool.name === toolName);
      assert.ok(stageTool, `${toolName} missing from the built engine's real tool list`);
      assert.deepEqual(
        stageTool.inputSchema?.properties?.mode?.enum,
        ["background", "owner-preview"],
        `${toolName} must expose both background and owner-preview modes`,
      );
      assert.equal(stageTool.inputSchema?.properties?.mode?.default, "owner-preview");
    }
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
