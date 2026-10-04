/** Local live C1 acceptance. No personal accounts, hosted resources or ordinary Chrome profile. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { changeApprovedSite, launchAgentChrome } from "../src/lib/native/agent-chrome";
import { agentChromePageSource } from "../src/lib/native/agent-chrome-cli";
import { startWebBroker } from "../src/lib/native/web-broker-server";

const root = resolve(".m9r/c1-live-acceptance");
mkdirSync(root, { recursive: true });
const release = resolve(root, "release");
if (existsSync(release)) throw new Error("Remove the previous C1 release marker before running again.");
const fixture = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html", "set-cookie": "c1_session=fixture-only; Max-Age=3600; HttpOnly; SameSite=Strict" });
  res.end(`<!doctype html><title>M9R C1 live acceptance</title><style>body{font:20px system-ui;padding:60px}input,button{font:inherit;padding:12px;margin:10px}pre{white-space:pre-wrap}</style><h1>M9R agent-owned Chrome</h1><button id="click">C1 local click</button><input id="text" aria-label="C1 text"><input id="secret" type="password" aria-label="Private field"><pre id="result">Waiting</pre><script>let clicked=false, typed='', trustedClick=false, trustedInput=false;const result=document.querySelector('#result');function render(){result.textContent=JSON.stringify({clicked,typed,trustedClick,trustedInput,persisted:${JSON.stringify((req.headers.cookie ?? "").includes("c1_session=fixture-only"))}})}document.querySelector('#click').onclick=e=>{clicked=true;trustedClick=e.isTrusted;render()};document.querySelector('#text').oninput=e=>{typed=e.target.value;trustedInput=e.isTrusted;render()};render()</script>`);
});
await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
const address = fixture.address() as { port: number };
const url = `http://127.0.0.1:${address.port}/`;
changeApprovedSite(root, url, true);
const browser = await launchAgentChrome({ root, pageActionsSource: agentChromePageSource() });
const key = randomBytes(32).toString("hex");
const broker = await startWebBroker({ key, port: 0, browserTransport: browser, timeoutMs: 20000 });
async function command(action: string, more: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${broker.port}/cmd`, { method: "POST", headers: { "x-m9r-key": key, "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", sessionId: "c1-live", tab: "c1", action, ...more }), signal: AbortSignal.timeout(25000) });
  return await response.json() as { ok: boolean; data?: unknown; error?: string };
}
try {
  const denied = await command("open", { url: `http://localhost:${address.port}/` });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  const opened = await command("open", { url });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const click = await command("click", { selector: "#click" });
  assert.equal(click.ok, true, JSON.stringify(click));
  const typed = await command("type", { selector: "#text", text: "C1 trusted text" });
  assert.equal(typed.ok, true, JSON.stringify(typed));
  const observed = await command("read", { selector: "#result" });
  const state = JSON.parse(String(observed.data));
  assert.deepEqual({ clicked: state.clicked, typed: state.typed, trustedClick: state.trustedClick, trustedInput: state.trustedInput }, { clicked: true, typed: "C1 trusted text", trustedClick: true, trustedInput: true });
  const secret = await command("type", { selector: "#secret", text: "synthetic" });
  assert.equal(secret.ok, false);
  changeApprovedSite(root, url, false);
  assert.equal((await command("read", { selector: "#result" })).ok, false);
  changeApprovedSite(root, url, true);
  const snapshot = await command("snapshot");
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const evidence = { timestamp: new Date().toISOString(), profile: browser.profile, pid: browser.pid, live: state, unapprovedOriginDenied: true, sensitiveFieldDenied: true, revokedSiteDenied: true, snapshot: true };
  writeFileSync(resolve(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log("C1_LIVE_READY " + JSON.stringify(evidence));
  // Keep the actual window present for the owner's/agent's native UI inspection.
  while (!existsSync(release)) await delay(500);
} finally {
  await broker.close();
  await new Promise<void>((done) => fixture.close(() => done()));
}
