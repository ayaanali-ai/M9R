import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { stopChildProcess } from "./runtime-child-shutdown.mjs";

const executable = resolve(process.argv[2] ?? "engine/dist/m9r-engine.exe");
const manifest = JSON.parse(readFileSync(join(dirname(executable), "m9r-build-info.json"), "utf8"));
// The packaged supervisor deliberately resolves the active installed runtime
// through M9R_HOME so an old provider-owned parent cannot revive a retired
// engine. A package verifier must use an isolated store; otherwise it tests
// the user's installed runtime instead of the candidate passed on argv.
const smokeHome = mkdtempSync(join(tmpdir(), "m9r-runtime-mcp-"));
const child = spawn(executable, ["mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, M9R_HOME: smokeHome },
});
let buffer = "";
const responses = new Map();
let rejectPending;
const failed = new Promise((_, reject) => { rejectPending = reject; });
child.once("error", rejectPending);
child.stdout.on("data", (data) => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { const response = JSON.parse(line); responses.get(response.id)?.(response); } catch { /* non-JSON diagnostic */ }
  }
});
// Drain diagnostics without printing tokens or private payloads.
child.stderr.resume();
function request(id, method, params) {
  return Promise.race([new Promise((resolveResponse) => {
    responses.set(id, resolveResponse);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }), failed]);
}
const timeout = setTimeout(() => rejectPending(new Error("MCP handshake timed out")), 10_000);
try {
  const init = await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runtime-acceptance", version: "1" } });
  const expectedVersion = `1.0.0+${manifest.buildId.slice(0, 12)}`;
  if (init.result?.serverInfo?.version !== expectedVersion) throw new Error("Running MCP version does not match installed manifest");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await request(2, "tools/list", {});
  const requiredTools = [
    "m9r_stage_prepare", "m9r_stage_app", "m9r_stage_action",
    "m9r_computer_observe", "m9r_computer_action",
  ];
  for (const name of requiredTools) {
    if (!list.result?.tools?.some((tool) => tool.name === name)) throw new Error(`Missing installed tool: ${name}`);
  }
  const legacyWebExtensionTools = ["m9r_web_open", "m9r_web_click", "m9r_web_read"];
  const legacyWebToolsPresent = legacyWebExtensionTools.filter((name) => list.result?.tools?.some((tool) => tool.name === name));
  if (legacyWebToolsPresent.length > 0) {
    throw new Error(`Retired browser-extension tools are still exposed: ${legacyWebToolsPresent.join(", ")}`);
  }
  console.log(JSON.stringify({
    executable,
    installedBuildId: manifest.buildId,
    mcpVersion: expectedVersion,
    stageToolsPresent: true,
    computerUseToolsPresent: true,
    legacyWebExtensionToolsPresent: false,
  }));
} finally {
  clearTimeout(timeout);
  await stopChildProcess(child);
  rmSync(smokeHome, { recursive: true, force: true });
}
