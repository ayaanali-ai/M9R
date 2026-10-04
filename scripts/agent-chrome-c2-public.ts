/** Public browser-input demo pages. Only local form edits; never submit, authenticate or publish. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchAgentChrome, changeApprovedSite } from "../src/lib/native/agent-chrome";
import { agentChromePageSource } from "../src/lib/native/agent-chrome-cli";
import { startWebBroker } from "../src/lib/native/web-broker-server";

async function run(kind: "type" | "drag") {
  const root = resolve(`.m9r/c2-public-${kind}`);
  mkdirSync(root, { recursive: true });
  const url = `https://www.selenium.dev/selenium/web/${kind === "type" ? "formPage.html" : "mouse_interaction.html"}`;
  changeApprovedSite(root, url, true);
  const browser = await launchAgentChrome({ root, pageActionsSource: agentChromePageSource() });
  const key = randomBytes(32).toString("hex");
  const broker = await startWebBroker({ key, port: 0, browserTransport: browser, timeoutMs: 30000 });
  async function command(action: string, extra: Record<string, unknown> = {}) {
    const res = await fetch(`http://127.0.0.1:${broker.port}/cmd`, { method: "POST", headers: { "x-m9r-key": key, "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", provider: "codex", sessionId: "c2-public", tab: "test", action, ...extra }), signal: AbortSignal.timeout(40000) });
    const result = await res.json() as { ok: boolean; data?: unknown; error?: string };
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  }
  try {
    await command("open", { url });
    await command("open", { url, tab: "foreground" });
    if (kind === "type") {
      await command("type", { selector: "#working", text: "M9R C2 quiet typing" });
      assert.equal(await command("read", { selector: "#working" }), "M9R C2 quiet typing");
    } else {
      assert.equal(await command("read", { selector: "#droppable" }), "Droppable");
      await command("drag", { selector: "#draggable", endSelector: "#droppable" });
      assert.equal(await command("read", { selector: "#drop-status" }), "dropped");
    }
    return { action: kind, url, passed: true, backgroundTab: true };
  } finally { await broker.close(); }
}
const evidence = { timestamp: new Date().toISOString(), results: [await run("type"), await run("drag")] };
writeFileSync(resolve(".m9r/c2-public-result.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
