// Capability sweep. Run: E2E_CHROME=<chromium path> npm run test:capability-sweep   (CAPONLY=hover,back limits it to matching checks)
// Capability sweep: drives the real broker, the real extension (in unbranded Chromium) and a fixture page through the same
// broker requests the MCP tools make. Nothing here touches the owner's own broker or browser (alternate ports, temp home).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";

const REPO = process.cwd().split("\\").join("/");
const CAP = `${REPO}/scripts/capability-sweep`;
const CHROME = process.env.E2E_CHROME ?? "";
if (!CHROME) throw new Error("Set E2E_CHROME to an unbranded Chromium (branded Chrome ignores --load-extension), e.g. the Playwright chromium build.");
const PORT = 47831, SITE = 8790, CDP = 9381;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = mkdtempSync(join(tmpdir(), "m9r-cap-home-"));
const work = mkdtempSync(join(tmpdir(), "m9r-cap-"));
const ext = join(work, "ext");
cpSync(join(REPO, "extensions/browser"), ext, { recursive: true, filter: (p) => !/store-assets|test-page|screenshots/.test(p) });
const bgPath = join(ext, "src/background.js");
writeFileSync(bgPath, readFileSync(bgPath, "utf8").replace("ws://127.0.0.1:47821/ext", `ws://127.0.0.1:${PORT}/ext`));

const files: Record<string, [string, string]> = { "/fixture.html": ["fixture.html", "text/html"], "/frame.html": ["frame.html", "text/html"], "/page2.html": ["page2.html", "text/html"] };
const site = createServer((req, res) => {
  const p = (req.url ?? "/").split("?")[0];
  if (p === "/x.txt") { res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment" }); return void res.end("hello"); }
  const f = files[p]; if (!f) { res.writeHead(404); return void res.end(); }
  res.writeHead(200, { "content-type": f[1] }); res.end(readFileSync(join(CAP, f[0])));
}).listen(SITE, "127.0.0.1");

const broker = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./scripts/register-alias.mjs", "scripts/m9r-web-broker.ts", "--home", home, "--port", String(PORT)], { cwd: REPO, env: { ...process.env, M9R_ALLOW_ANY_EXTENSION: "1", M9R_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
let brokerOut = ""; broker.stdout.on("data", (d) => (brokerOut += d)); broker.stderr.on("data", (d) => (brokerOut += d));
let chrome: ReturnType<typeof spawn>;
const cleanup = () => { try { spawnSync("taskkill", ["/pid", String(chrome?.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} try { spawnSync("taskkill", ["/pid", String(broker.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} site.close(); try { rmSync(work, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

const keyFile = () => { for (const cand of [brokerKeyPath(home), join(home, "web-broker.key")]) { try { readFileSync(cand); return cand; } catch {} } return brokerKeyPath(home); };
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await sleep(500); }
chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "m9r-cap-chrome-"))}`, `--load-extension=${ext}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run", "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
await sleep(1500);
const client = createWebBrokerClient({ keyPath: keyFile(), port: PORT });
const key = () => readFileSync(keyFile(), "utf8").trim();
const A = { agent: "claude", provider: "claude", sessionId: "cap-a" }, B = { agent: "codex", provider: "codex", sessionId: "cap-b" };
type R = { ok: boolean; error?: string; data?: unknown };
const run = (action: string, extra: Record<string, unknown> = {}, who = A): Promise<R> => {
  const e: Record<string, unknown> = { ...extra };
  if (typeof e.ref === "string") { e.selector = `@m9r-ref:${e.ref}`; delete e.ref; }
  if (action === "press" && typeof e.key === "string") { e.args = { key: e.key }; delete e.key; }
  return client.run({ ...who, action, tab: "shared", ...e } as never) as Promise<R>;
};
const cdpPage = async () => { const l = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>; return l.filter((x) => x.type === "page" && x.url.includes(`:${SITE}`)).pop(); };
async function evalPage(expression: string): Promise<unknown> {
  const t = await cdpPage(); if (!t) return "(no page)";
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  const v = await new Promise((resolve) => { ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 1) resolve(d.result?.result?.value); }; ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })); });
  ws.close(); return v;
}
const logOf = async () => ((await evalPage("JSON.stringify(window.__log||[])")) ? JSON.parse(String(await evalPage("JSON.stringify(window.__log||[])"))) : []) as Array<[string, number]>;
const has = async (prefix: string) => (await logOf()).some(([m]) => m.startsWith(prefix));
async function refOf(needle: string): Promise<string | null> {
  const r = await run("snapshot", { args: { limit: 150 } });
  const d = r.data;
  if (typeof d === "string") {
    const line = d.split(String.fromCharCode(10)).find((l) => l.toLowerCase().includes(needle.toLowerCase()) && /e[0-9]+/.test(l));
    return line ? (line.match(/e[0-9]+/) ?? [null])[0] : null;
  }
  const els = ((d as { elements?: Array<{ name?: string; ref?: string }> } | undefined)?.elements ?? []);
  return els.find((e) => String(e.name ?? "").toLowerCase().includes(needle.toLowerCase()))?.ref ?? null;
}
const pendingActions = async () => { try { return ((await (await fetch(`http://127.0.0.1:${PORT}/web/actions/pending`, { headers: { "x-m9r-key": key() } })).json()) as { actions: Array<{ id: string; action?: string }> }).actions; } catch { return []; } };
const denyAll = async () => { for (const a of await pendingActions()) await fetch(`http://127.0.0.1:${PORT}/web/actions/deny`, { method: "POST", headers: { "x-m9r-key": key(), "content-type": "application/json" }, body: JSON.stringify({ id: a.id }) }).catch(() => {}); };
const approveAll = async () => { for (const a of await pendingActions()) await fetch(`http://127.0.0.1:${PORT}/web/actions/approve`, { method: "POST", headers: { "x-m9r-key": key(), "content-type": "application/json" }, body: JSON.stringify({ id: a.id }) }).catch(() => {}); };
async function held(action: string, extra: Record<string, unknown>): Promise<string> {
  const p = run(action, extra); const first = await Promise.race([p.then(() => "done" as const), sleep(2500).then(() => "wait" as const)]);
  const pend = await pendingActions(); await denyAll(); const r = await p;
  return first === "wait" && pend.length ? `held for owner approval (${pend.length} pending)` : `${r.ok ? "RAN WITHOUT APPROVAL" : "refused"}: ${String(r.error ?? "").slice(0, 100)}`;
}

type Row = { name: string; status: string; note: string; ms: number };
const rows: Row[] = [];
async function t(name: string, fn: () => Promise<[string, string]>) {
  if (process.env.CAPONLY && !process.env.CAPONLY.split(",").some((k) => name.toLowerCase().includes(k.toLowerCase()))) return;
  const start = Date.now(); let out: [string, string];
  try { out = await fn(); } catch (e) { out = ["ERROR", String((e as Error).message ?? e).slice(0, 140)]; }
  rows.push({ name, status: out[0], note: out[1], ms: Date.now() - start }); console.log(`${out[0].padEnd(6)} ${name}  -- ${out[1]}  (${Date.now() - start} ms)`);
}
const url = (p = "/fixture.html") => `http://127.0.0.1:${SITE}${p}`;
const ok = (b: boolean, good: string, bad: string): [string, string] => (b ? ["PASS", good] : ["FAIL", bad]);

// warm up until the extension answers
let ready = false;
for (let i = 0; i < 80 && !ready; i++) { const r = await Promise.race([run("open", { tab: "warm", url: url("/page2.html") }), sleep(8000).then(() => ({ ok: false } as R))]); ready = r.ok; if (!ready) await sleep(1000); }
if (!ready) { console.log("EXTENSION NEVER CONNECTED\n" + brokerOut.slice(-800)); process.exit(2); }
await run("close", { tab: "warm" });

await t("open a normal page", async () => { const r = await run("open", { url: url() }); return ok(r.ok, "opened", String(r.error)); });
await t("open a search-query URL is refused", async () => { const r = await run("open", { tab: "s2", url: url("/fixture.html?q=cats") }); return ok(!r.ok, "refused with a hint", "was allowed"); });
await t("snapshot lists controls with refs", async () => { const r = await run("snapshot", { args: {} }); const s = typeof r.data === "string" ? r.data : JSON.stringify(r.data);  return ok(/\be\d+\b/.test(s) && /Search fixture|search/i.test(s), `${(s.match(/\be\d+\b/g) ?? []).length} refs`, s.slice(0, 120)); });
await t("snapshot sees shadow-DOM button", async () => ok(!!(await refOf("Shadow button")), "found", "shadow control not in snapshot"));
await t("snapshot sees same-origin iframe button", async () => ok(!!(await refOf("Frame button")), "found", "iframe control not in snapshot"));
await t("click search box then type then Enter (no form)", async () => {
  const q = await refOf("Search fixture"); if (!q) return ["FAIL", "search box not found"];
  const c = await run("click", { ref: q }); const ty = await run("type", { ref: q, text: "hello world" }); const pr = await run("press", { ref: q, key: "Enter" });
  const l = await logOf(); const entered = l.some(([m]) => m.startsWith("enter-search:hello world"));
  return [entered ? "PASS" : "FAIL", `click:${c.ok} type:${ty.ok} enter:${pr.ok} (${JSON.stringify((pr.data as { effect?: string } | undefined)?.effect ?? "")})`];
});
await t("press Enter after the search box was replaced (stale ref)", async () => {
  const q = await refOf("Second search"); if (!q) return ["FAIL", "second search box not found"];
  await run("click", { ref: q }); await run("type", { ref: q, text: "anthropic" });
  const pr = await run("press", { ref: q, key: "Enter" }); const l = await logOf();
  return [l.some(([m]) => m.startsWith("enter-search2:anthropic")) ? "PASS" : "FAIL", `press ok:${pr.ok} ${String(pr.error ?? "").slice(0, 90)} swapped:${l.some(([m]) => m === "swapped")}`];
});
await t("typing has human-like per-key timing", async () => {
  const l = (await logOf()).filter(([m]) => m === "input").map(([, ms]) => ms); if (l.length < 8) return ["FAIL", `${l.length} input events`];
  const g = l.slice(1).map((v, i) => v - l[i]); const mean = g.reduce((a, b) => a + b, 0) / g.length; const sd = Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length);
  return ok(sd > 15 && Math.min(...g) >= 20, `mean ${Math.round(mean)} ms, sd ${Math.round(sd)}`, `mean ${Math.round(mean)} sd ${Math.round(sd)}`);
});
await t("click produces pointer path (hover, moves, press, release)", async () => {
  const b = await refOf("Send form"); if (!b) return ["FAIL", "no button"]; const before = (await logOf()).length; const r = await run("click", { ref: b });
  const l = (await logOf()).slice(before).map(([m]) => m); const moves = l.filter((m) => m === "mousemove").length;
  return ok(r.ok && moves >= 3 && l.includes("form-submit"), `${moves} moves, form submitted`, `ok:${r.ok} moves:${moves} events:${l.slice(0, 8).join(",")}`);
});
await t("Enter inside a form field submits the form", async () => { const n = await refOf("Name"); if (!n) return ["FAIL", "no name field"]; await run("type", { ref: n, text: "Ada" }); const b = (await logOf()).length; await run("press", { ref: n, key: "Enter" }); return ok((await logOf()).slice(b).some(([m]) => m === "form-submit"), "submitted", "no submit"); });
await t("fill_form fills several fields", async () => { const r = await run("fill_form", { formSelector: "#f1", args: { fields: [{ selector: "#nm", value: "Grace" }, { selector: "#em", value: "g@example.com" }, { selector: "#ta", value: "line one" }] } }); const v = await evalPage("document.querySelector('#nm').value+'|'+document.querySelector('#em').value+'|'+document.querySelector('#ta').value"); return ok(r.ok && v === "Grace|g@example.com|line one", "3 fields set", `${r.ok} ${r.error ?? v}`); });
await t("password field is refused", async () => { const r = await run("type", { selector: "#pw", text: "hunter2" }); return ok(!r.ok, "refused", "TYPED INTO PASSWORD"); });
await t("hidden field is refused", async () => { const r = await run("type", { selector: "#hid", text: "x" }); return ok(!r.ok, "refused", "typed into hidden"); });
await t("card-number field is refused", async () => { const r = await run("type", { selector: "#cc", text: "4242424242424242" }); return ok(!r.ok, "refused", "TYPED INTO CARD FIELD"); });
await t("checkbox check/uncheck", async () => { await run("check", { selector: "#cb" }); const a = await evalPage("document.querySelector('#cb').checked"); await run("uncheck", { selector: "#cb" }); const b = await evalPage("document.querySelector('#cb').checked"); return ok(a === true && b === false, "both work", `after check:${a} after uncheck:${b}`); });
await t("radio via check", async () => { const r = await run("check", { selector: "#r2" }); return ok(r.ok && (await evalPage("document.querySelector('#r2').checked")) === true, "selected", String(r.error)); });
await t("select dropdown by label", async () => { const r = await run("select", { selector: "#sel", args: { option: "Zed" } }); return ok(r.ok && (await evalPage("document.querySelector('#sel').value")) === "z", "chose Zed", String(r.error)); });
await t("type into contenteditable", async () => { const r = await run("type", { selector: "#ce", text: "typed in editor" }); return ok(r.ok && String(await evalPage("document.querySelector('#ce').textContent")).includes("typed in editor"), "typed", String(r.error)); });
await t("type into textarea", async () => { const r = await run("type", { selector: "#ta", text: "first\nsecond" }); return ok(r.ok && String(await evalPage("document.querySelector('#ta').value")).includes("second"), "typed", String(r.error)); });
await t("hover reveals a menu", async () => { const b = (await logOf()).length; const r = await run("hover", { selector: "#hov" }); await sleep(300); const l = (await logOf()).slice(b).map(([m]) => m); return ok(r.ok && (await has("hover-open")), "menu opened", `ok:${r.ok} ${JSON.stringify(r.data)} ${r.error ?? ""} events:${l.slice(0, 12).join(",")}`); });
await t("wait for delayed content", async () => { await run("click", { selector: "#later" }); const r = await run("wait", { args: { text: "Loaded content", ms: 5000 } }); return ok(r.ok, "appeared", String(r.error)); });
await t("find text on page", async () => { const r = await run("find", { args: { query: "Bottom marker", scrollToFirst: true } }); return ok(r.ok, "found", String(r.error)); });
await t("scroll to bottom triggers lazy content", async () => { await run("scroll", { args: { to: "bottom" } }); await sleep(800); return ok(await has("lazy-loaded"), "lazy content loaded", "lazy content did not load"); });
await t("read a table as JSON", async () => { const r = await run("extract", { selector: "#tbl", args: { maxRows: 10 } }); return ok(r.ok && JSON.stringify(r.data).includes("Team"), "rows returned", String(r.error)); });
await t("screenshot", async () => { const r = await run("screenshot", { args: { format: "jpeg" } }); return ok(r.ok, "captured", String(r.error)); });
await t("read same-origin iframe text", async () => { const r = await run("read", { selector: "#fr" }); const rf = await run("read", {}); return ok(/INSIDE-FRAME/.test(JSON.stringify(rf.data) + JSON.stringify(r.data)), "frame text visible", "frame text not in read"); });
await t("click a shadow-DOM button", async () => { const r = await refOf("Shadow button"); if (!r) return ["GAP", "not addressable"]; const cr = await run("click", { ref: r }); return ok(await has("shadow-click"), "clicked", `no click; ok:${cr.ok} ${String(cr.error ?? "").slice(0, 90)}`); });
await t("click an iframe button", async () => { const r = await refOf("Frame button"); if (!r) return ["GAP", "not addressable"]; await run("click", { ref: r }); return ok(await has("iframe-click"), "clicked", "no click"); });
await t("double click and right click", async () => { const a = await run("double_click", { selector: "#dbl" }); const b = await run("right_click", { selector: "#ctx" }); return ok((await has("dblclick")) && (await has("contextmenu")), "both fired", `dbl:${a.ok}${a.error ?? ""} ctx:${b.ok}${b.error ?? ""}`); });
await t("drag and drop (HTML5) needs approval", async () => ["INFO", await held("drag", { selector: "#drag", endSelector: "#drop", args: { destination: "#drop" } })]);
await t("obscured element is refused", async () => { await evalPage("window.showCover()"); const r = await run("click", { selector: "#coveredbtn" }); return ok(!r.ok && !(await has("covered-clicked")), "refused: " + String(r.error).slice(0, 60), "CLICKED THROUGH AN OVERLAY"); });
await evalPage("document.getElementById('cover').style.display='none'");
await t("Buy now click needs approval", async () => [/held|refused/.test(await held("click", { selector: "#buy" })) ? "PASS" : "FAIL", await held("buy", { selector: "#buy" })]);
await t("post click needs approval", async () => ["INFO", await held("post", { selector: "#post" })]);
await t("file upload needs approval", async () => ["INFO", await held("upload", { selector: "#file" })]);
await t("download link needs approval", async () => ["INFO", await held("download", { selector: "#dl" })]);
await t("click_at (canvas) needs approval", async () => ["INFO", await held("click_at", { args: { x: 100, y: 100 } })]);
await t("confirm() dialog does not freeze the page and the agent is told", async () => { const b = await run("click", { selector: "#confirmbtn" }); await sleep(600); const l = await logOf(); const told = JSON.stringify(b.data ?? {}).includes("confirm"); return ok(b.ok && l.some(([m]) => m.startsWith("confirm-result")) && told, "answered safely and reported", `click ok:${b.ok} ${String(b.error ?? "").slice(0, 80)} result-logged:${l.some(([m]) => m.startsWith("confirm-result"))} told:${told}`); });
await t("link click navigates (same tab)", async () => { const l = await refOf("Page two"); if (!l) return ["FAIL", "no link"]; const r = await run("click", { ref: l }); await sleep(1200); const u = await evalPage("location.pathname"); return ok(u === "/page2.html", "navigated", `at ${u}; ${r.error ?? ""}`); });
await t("back returns to the fixture", async () => { const hl = await evalPage("history.length"); const r = await run("back"); await sleep(1500); const path = await evalPage("location.pathname"); const tabs = await run("tabs"); return ok(path === "/fixture.html", "back worked", `historyLength:${hl} ok:${r.ok} err:${r.error} path:${path} tabs:${JSON.stringify(tabs.data).slice(0, 200)}`); });
await t("a link that opens a new tab becomes an M9R tab", async () => { const l = await refOf("new tab"); if (!l) return ["FAIL", "no link"]; await run("click", { ref: l }); await sleep(2000); const tabs = await run("tabs"); const txt = JSON.stringify(tabs.data); return ok(/shared-new/.test(txt), "tracked as shared-new", txt.slice(0, 160)); });
await run("close", { tab: "shared-new" }); await sleep(500); await run("switch", { tab: "shared" });
await t("adopt the owner's tab (owner approves)", async () => { const p = run("adopt", { tab: "adopted" }); await sleep(2500); const pend = (await pendingActions()).length; await approveAll(); const r = await p; const rd = await run("read", { tab: "adopted" }); return ok(pend > 0 && r.ok && rd.ok, `approval asked (${pend}), joined ${JSON.stringify(r.data).slice(0, 80)}`, `pending:${pend} adopt ok:${r.ok} ${r.error ?? ""} read ok:${rd.ok} ${rd.error ?? ""}`); });
await t("reload keeps working", async () => { const r = await run("reload"); return ok(r.ok, "reloaded", String(r.error)); });
await t("two agents: second joins the shared tab without reload", async () => { await run("type", { selector: "#nm", text: "keepme" }); const r = await run("open", { url: url() }, B); const v = await evalPage("document.querySelector('#nm').value"); return ok(r.ok && v === "keepme", "joined, field intact", `${r.ok} value:${v}`); });
await t("two agents: typing in a claimed field is refused", async () => { const a = run("type", { selector: "#em", text: "aaa" }, A); const b = await run("type", { selector: "#em", text: "bbb" }, B); await a; return ["INFO", `B result: ${b.ok ? "allowed" : "refused"} ${String(b.error ?? "").slice(0, 100)}`]; });
await t("open a different site path in the same tab (deep link to a profile-style URL)", async () => { const r = await run("open", { url: url("/page2.html") }); return ["INFO", `allowed:${r.ok} (agents can still navigate by URL; the rule only blocks search queries)`]; });

await t("long text typing budget (600 chars)", async () => { await run("open", { url: url() }); const s = Date.now(); const r = await run("type", { selector: "#ta", text: "word ".repeat(120) }); const v = String(await evalPage("document.querySelector('#ta').value")).length; return ["INFO", `${Date.now() - s} ms, ${v}/600 chars, ok:${r.ok}`]; });
await t("keyboard shortcut Control+A", async () => { const r = await run("press", { selector: "#nm", key: "Control+A" }); return ok(r.ok, "sent", String(r.error)); });

console.log("\nSUMMARY " + JSON.stringify(rows.reduce((a: Record<string, number>, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {})));
writeFileSync(join(tmpdir(), "m9r-capability-sweep-results.json"), JSON.stringify(rows, null, 1));
cleanup(); process.exit(0);
