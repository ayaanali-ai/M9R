import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { startBenchSite } from "./bench/bench-site";
import { findChrome, startCdpDriver } from "./bench/cdp-driver";
import { removeBenchTempDirectory } from "./bench/temp-cleanup";
import { createBenchmarkWebBrokerClient, inviteBenchmarkAgent } from "./bench/web-client";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> };

const chrome = findChrome();

test("an agent tool call drives a real headless browser end to end: open, read, type, click, and the site scores the answer", { skip: chrome ? false : "no Chrome or Edge installed" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "m9r-bench-e2e-"));
  const modeFile = join(root, "mode");
  writeFileSync(modeFile, "hands-off\n", "utf8");
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const broker = await startWebBroker({ key, port: 0, timeoutMs: 20_000, allowAnyExtension: true, modeFile });
  const store = createLocalStore(root);
  const server = createM9rMcpServer({ store, web: createBenchmarkWebBrokerClient(key, broker.port) });
  const call = (name: string, args: Record<string, unknown>) => (server as unknown as ToolServer)._registeredTools[name].handler(args);
  const site = await startBenchSite({ seed: 6 });
  const driver = await startCdpDriver({ brokerPort: broker.port });
  const { token } = store.issueIdentity("claude", "claude-code", "s1");

  try {
    await inviteBenchmarkAgent(key, broker.port, "claude");
    const opened = await call("m9r_web_open", { token, url: site.url("/search/spec") });
    const browserFailure = opened.content[0]?.text ?? "";
    if (/GPU process isn't usable|GPU process exited unexpectedly: exit_code=-1073741790/i.test(browserFailure)) {
      t.skip("local headless browser GPU process crashes with Windows 0xC000001D; real-browser behavior is unverified in this environment");
      return;
    }
    assert.equal(opened.isError, undefined, opened.content[0].text);

    // Page reads are returned directly: per-result disclosure approval was removed from the local broker on 2026-09-30.
    const spec = await call("m9r_web_read", { token, selector: "#code" });
    assert.equal(spec.isError, undefined, spec.content[0]?.text);
    assert.equal(spec.content[0].text, site.data.search.targetCode);

    const missing = await call("m9r_web_read", { token, selector: "#nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /no element matches/);

    const answerLink = await call("m9r_web_click", { token, selector: 'a[href="/search/answer"]' });
    assert.equal(answerLink.isError, undefined, answerLink.content[0]?.text);
    for (let i = 0; i < 100 && !site.loads().some((load) => load.path === "/search/answer"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(site.loads().some((load) => load.path === "/search/answer"), "the page's own answer link should navigate within the open site");
    const typed = await call("m9r_web_type", { token, selector: "#item", text: site.data.search.truth.item });
    assert.equal(typed.isError, undefined, typed.content[0]?.text);
    const clicked = await call("m9r_web_click", { token, selector: "#submit" });
    assert.equal(clicked.isError, undefined, clicked.content[0]?.text);

    for (let i = 0; i < 100 && site.submissions().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const [submission] = site.submissions();
    assert.ok(submission, "the page's own script posted the answer to the site");
    assert.equal(submission.task, "search");
    assert.equal(submission.score.allCorrect, true);
    assert.deepEqual(site.loads().map((l) => l.path), ["/search/spec", "/search/answer"]);
  } finally {
    await driver.close();
    await site.close();
    await broker.close();
    removeBenchTempDirectory(root, "m9r-bench-e2e-");
  }
});
