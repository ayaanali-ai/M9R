/** Live C2: real headed Chrome, HTTP page, trusted typing, pointer drag, HTML drop and queued writers. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { launchAgentChrome, changeApprovedSite } from "../src/lib/native/agent-chrome";
import { agentChromePageSource } from "../src/lib/native/agent-chrome-cli";
import { startWebBroker } from "../src/lib/native/web-broker-server";

const root = resolve(".m9r/c2-live-acceptance");
mkdirSync(root, { recursive: true });
const fixture = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>M9R C2 live acceptance</title><style>body{font:18px system-ui;padding:25px}.row{display:flex;gap:70px;margin:25px}#pointer,#html,#destination,#drop{width:120px;height:75px;border:2px solid black;padding:10px}#pointer{touch-action:none}input{font:inherit}pre{white-space:pre-wrap}</style><h1>C2 quiet input</h1><input id="text" aria-label="C2 text"><div class="row"><div id="pointer">Pointer drag</div><div id="destination">Pointer end</div></div><div class="row"><div id="html" draggable="true">HTML drag</div><div id="drop">HTML drop</div></div><pre id="result"></pre><script>
  let active=false, moved=false;const state={typed:'',trustedInput:false,pointerDrag:false,trustedPointer:false,htmlDrop:false,trustedDrop:false,overlap:false,order:[],visibility:document.visibilityState};const result=document.querySelector('#result');function render(){state.visibility=document.visibilityState;result.textContent=JSON.stringify(state)}
  const p=document.querySelector('#pointer');p.onpointerdown=e=>{active=true;moved=false;p.setPointerCapture(e.pointerId);state.order.push('drag-start');render()};p.onpointermove=e=>{if(active&&e.buttons===1){moved=true;state.trustedPointer=e.isTrusted}};p.onpointerup=e=>{if(active){state.pointerDrag=moved&&e.isTrusted;active=false;state.order.push('drag-end');render()}};
  document.querySelector('#text').oninput=e=>{state.typed=e.target.value;state.trustedInput=e.isTrusted;state.overlap=state.overlap||active;state.order.push('type');render()};
  document.querySelector('#html').ondragstart=e=>{e.dataTransfer.setData('text/plain','C2 native HTML payload')};const d=document.querySelector('#drop');d.ondragover=e=>e.preventDefault();d.ondrop=e=>{e.preventDefault();state.htmlDrop=e.dataTransfer.getData('text/plain')==='C2 native HTML payload';state.trustedDrop=e.isTrusted;render()};document.addEventListener('visibilitychange',render);render();</script>`);
});
await new Promise<void>(done => fixture.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
changeApprovedSite(root, url, true);
let browser: Awaited<ReturnType<typeof launchAgentChrome>> | undefined;
let broker: Awaited<ReturnType<typeof startWebBroker>> | undefined;
try {
  browser = await launchAgentChrome({ root, pageActionsSource: agentChromePageSource() });
  const key = randomBytes(32).toString("hex");
  broker = await startWebBroker({ key, port: 0, browserTransport: browser, timeoutMs: 20000 });
  async function command(action: string, more: Record<string, unknown> = {}) {
    const res = await fetch(`http://127.0.0.1:${broker!.port}/cmd`, { method: "POST", headers: { "x-m9r-key": key, "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", provider: "codex", sessionId: "c2-live", tab: "c2", action, ...more }), signal: AbortSignal.timeout(25000) });
    return await res.json() as { ok: boolean; data?: unknown; error?: string };
  }
  const opened = await command("open", { url }); assert.equal(opened.ok, true, JSON.stringify(opened));
  // A different tab is foreground. CDP must act on the original tab without switching it forward.
  const observer = await command("open", { url, tab: "c2-observer" }); assert.equal(observer.ok, true, JSON.stringify(observer));
  const parallel = await Promise.all([
    command("drag", { selector: "#pointer", endSelector: "#destination" }),
    command("type", { agent: "claude", provider: "claude", sessionId: "c2-second-writer", selector: "#text", text: "C2 quiet trusted input" }),
  ]);
  for (const answer of parallel) assert.equal(answer.ok, true, JSON.stringify(answer));
  const html = await command("drag", { selector: "#html", endSelector: "#drop", args: { destination: "#drop" } });
  assert.equal(html.ok, true, JSON.stringify(html));
  const read = await command("read", { selector: "#result" }); assert.equal(read.ok, true);
  const state = JSON.parse(String(read.data));
  assert.equal(state.typed, "C2 quiet trusted input");
  for (const name of ["trustedInput", "pointerDrag", "trustedPointer", "htmlDrop", "trustedDrop"]) assert.equal(state[name], true, `${name}: ${JSON.stringify(state)}`);
  assert.equal(state.overlap, false);
  assert.equal(state.visibility, "hidden", "Input must land in the background tab.");
  const observerRead = await command("read", { selector: "#result", tab: "c2-observer" });
  assert.equal(observerRead.ok, true);
  const observerState = JSON.parse(String(observerRead.data));
  assert.equal(observerState.visibility, "visible", "The foreground tab must remain visible.");
  assert.deepEqual(state.order, ["drag-start", "drag-end", "type"]);
  const evidence = { timestamp: new Date().toISOString(), browser: "headed Chrome", site: "local HTTP acceptance page", route: "agent-chrome via broker /cmd", foregroundTabUnchanged: true, state };
  writeFileSync(resolve(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (broker) await broker.close(); else await browser?.close();
  await new Promise<void>(done => fixture.close(() => done()));
}
