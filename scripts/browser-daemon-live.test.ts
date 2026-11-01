import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { launchAgentChrome } from "../src/lib/native/agent-chrome";
import { agentChromePageSource } from "../src/lib/native/agent-chrome-cli";

test("live isolated CDP tabs preserve identity, input, scrolling and close without an extension", { skip: process.env.M9R_BROWSER_LIVE !== "1", timeout: 90_000 }, async () => {
  const temp = resolve(".test-tmp");
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "browser-acceptance-"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>M9R browser acceptance</title><button id="click" onclick="this.textContent=\'Clicked\'">Click fixture</button><input id="text" aria-label="Fixture text"><div style="height:3000px">Scroll fixture</div>');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  let browser: Awaited<ReturnType<typeof launchAgentChrome>> | undefined;
  try {
    browser = await launchAgentChrome({ root, pageActionsSource: agentChromePageSource() });
    let seq = 0;
    const command = (action: string, tab = "one", more: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((done, reject) => {
      const id = `live-${++seq}`;
      const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Browser action ${action} timed out`)); }, 20_000);
      const unsubscribe = browser!.subscribe((message) => {
        const result = message as Record<string, unknown>;
        if (result.id !== id) return;
        clearTimeout(timer); unsubscribe(); done(result);
      }, () => { clearTimeout(timer); reject(new Error("Browser disconnected")); });
      assert.equal(browser!.send({ type: "command", id, action, tab, ...more }), true);
    });
    assert.equal((await command("open", "one", { url })).ok, true);
    assert.equal((await command("open", "two", { url })).ok, true);
    const first = await command("snapshot");
    const identity = first.data as { browserInstanceId: string; tabId: string };
    const second = (await command("snapshot", "two")).data as { browserInstanceId: string; tabId: string };
    assert.equal(identity.browserInstanceId, second.browserInstanceId);
    assert.notEqual(identity.tabId, second.tabId);
    assert.equal((await command("click", "one", { selector: "#click", expectedBrowserInstanceId: identity.browserInstanceId, expectedTabId: second.tabId })).ok, false);
    assert.equal((await command("click", "one", { selector: "#click", expectedBrowserInstanceId: identity.browserInstanceId, expectedTabId: identity.tabId })).ok, true);
    assert.equal((await command("type", "one", { selector: "#text", text: "M9R acceptance" })).ok, true);
    assert.equal((await command("scroll", "one", { args: { by: 200 } })).ok, true);
    assert.equal((await command("close", "two")).ok, true);
    assert.equal((await command("snapshot", "two")).ok, false);
    assert.equal((await command("snapshot", "one")).ok, true);
  } finally {
    await browser?.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
