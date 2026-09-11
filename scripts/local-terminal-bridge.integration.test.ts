import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";
import { BRIDGE_PROTOCOL_VERSION } from "../src/lib/local-terminal-protocol.ts";

test("the real runtime rejects unauthenticated HTTP state mutation and accepts state changes on an authorized provider socket", { timeout: 20_000 }, async () => {
  const port = 43119;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/oathlock-terminal-bridge.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, OATHLOCK_BRIDGE_PORT: String(port), OATHLOCK_BRIDGE_ORIGINS: "http://localhost:3000" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Runtime did not start: ${stderr}`)), 10_000);
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("M9R local runtime is running.")) { clearTimeout(timer); resolve(); }
      });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Runtime exited early with ${code}: ${stderr}`)); });
    });

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/agent-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "guessed-session", state: "blocked" }),
    });
    assert.equal(unauthenticated.status, 404);

    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, [BRIDGE_PROTOCOL_VERSION, "oathlock-provider.codex"], { origin: "http://localhost:3000" });
      let sessionId = "";
      ws.on("message", (data) => {
        const parsed = JSON.parse(String(data)) as Record<string, unknown>;
        if (parsed.type === "ready") {
          ws.send(JSON.stringify({ type: "spawn", provider: "codex", cwd: ".", cols: 100, rows: 30 }));
          return;
        }
        if (parsed.type === "spawned") {
          sessionId = String((parsed.session as { id?: unknown } | undefined)?.id ?? "");
          ws.send(JSON.stringify({ type: "report-state", sessionId, state: "blocked" }));
          return;
        }
        if (parsed.type === "state-recorded") {
          ws.send(JSON.stringify({ type: "close", sessionId }));
          ws.close();
          resolve(parsed);
        }
      });
      ws.once("error", reject);
    });
    assert.equal(message.type, "state-recorded");
    assert.equal(message.state, "blocked");
  } finally {
    child.kill();
  }
});
