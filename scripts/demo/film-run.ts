/**
 * Runs real agents on the shared demo page so the footage is honest. Every scene uses M9R's real web tools and the real
 * extension; the agents are the subscription logins already on this machine (no API keys; it refuses to start with one).
 *
 * Scenes
 *   team       a real Claude Code session and a real Codex session work the SAME page at the same time. They collide on the
 *              tab, one is refused with a plain message, retries, and they message each other.
 *   interrupt  a real Claude Code session is interrupted by you mid-task and changes course (measured: about 1.9 s).
 *   collision  a short, deterministic clip: a test script sends real commands as two agent identities (say so on camera).
 *   all        team, then interrupt, then collision.
 *
 * Modes
 *   --mode self      (default) starts a throwaway broker, the demo page and a headless Chromium with the extension, so the
 *                    scene can be checked without touching your browser. Needs E2E_CHROME=<path to an unbranded Chromium>.
 *   --mode running   for filming in YOUR Chrome: start the broker first in another terminal
 *                      M9R_ALLOW_ANY_EXTENSION=1 npx tsx scripts/m9r-web-broker.ts
 *                    load (or reload) the extension from extensions/browser, then run this. It serves the demo page on
 *                    http://127.0.0.1:8765/test-page/index.html and opens it in a tab named "shared".
 *
 * Options: --scene <name>  --countdown <seconds before the scene starts>  --model <claude model>  --shots <folder>
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { startLiveSession } from "@/lib/native/live-session-core";
import { writeMcpConfig } from "../bench/claude-cli";
import { CODEX_PREFACE, codexArgs, codexCliPath, startCodex } from "../bench/codex-cli";

const argument = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined; };
const mode = argument("mode") ?? "self";
const sceneName = argument("scene") ?? "team";
const countdown = Number(argument("countdown") ?? 0);
const model = argument("model") ?? "sonnet";
const shotsDir = argument("shots");
const REPO = process.cwd();
const EXT = join(REPO, "extensions", "browser");
const BROKER_PORT = 47821;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";
const timeline: string[] = [];
const say = (line: string) => { const l = `${at()}  ${line}`; timeline.push(l); console.log(l); };

function servePage(port: number) {
  const server = createServer((req, res) => {
    const file = normalize(join(EXT, decodeURIComponent((req.url ?? "/").split("?")[0])));
    try {
      let body: Buffer | string = readFileSync(file);
      if (file.endsWith("index.html")) body = String(body).replace(/<script src="[^"]+"><\/script>/g, "");
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript" }[extname(file)] ?? "text/plain" });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise<{ url: string; close: () => void }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/test-page/index.html`, close: () => server.close() }));
  });
}

async function main() {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) if (process.env[key]) throw new Error(`${key} is set; unset it so runs use the subscription logins, not API billing`);
  const self = mode !== "running";
  const root = self ? mkdtempSync(join(tmpdir(), "m9r-film-")) : defaultStoreRoot(homedir(), process.env);
  const work = mkdtempSync(join(tmpdir(), "m9r-film-work-"));
  const cleanups: Array<() => void | Promise<void>> = [() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* temp */ } }];
  if (self) cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });

  if (self) {
    const broker = await startWebBroker({ key: loadOrCreateBrokerKey(brokerKeyPath(root)), port: BROKER_PORT, allowAnyExtension: true, timeoutMs: 30_000 });
    cleanups.push(() => broker.close());
    const chromePath = process.env.E2E_CHROME;
    if (!chromePath) throw new Error("self mode needs E2E_CHROME pointing at an unbranded Chromium (branded Chrome ignores --load-extension)");
    const profile = mkdtempSync(join(tmpdir(), "m9r-film-chrome-"));
    const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${profile}`, `--load-extension=${EXT}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run", "--window-size=1280,860", "about:blank"], { stdio: "ignore" });
    cleanups.push(() => { if (chrome.pid) spawnSync("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ } });
  }
  const site = await servePage(self ? 0 : 8765);
  cleanups.push(() => site.close());

  const store = createLocalStore(root);
  const client = createWebBrokerClient({ keyPath: brokerKeyPath(root), port: BROKER_PORT });
  // Distinct session ids: issuing a token revokes any other token with the same session id.
  const token = { claude: store.issueIdentity("claude", "claude", "film-claude").token, codex: store.issueIdentity("codex", "codex", "film-codex").token };
  for (const [from, to] of [["claude", "codex"], ["codex", "claude"]]) store.addRule({ from, to, ttlMs: 2 * 60 * 60_000, note: "film run" });

  // The first browser call must not race the extension connecting, so warm up in a helper tab.
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    const r = await Promise.race([client.run({ agent: "director", provider: "director", sessionId: "film", action: "open", tab: "warmup", url: `${site.url}?warmup` }), sleep(9000).then(() => ({ ok: false }))]);
    ready = r.ok;
    if (!ready) await sleep(1000);
  }
  if (!ready) throw new Error("the extension did not answer. Is the broker running and the extension loaded and enabled?");
  say(`extension connected; demo page at ${site.url}`);

  const mcpDir = mkdtempSync(join(tmpdir(), "m9r-film-mcp-"));
  writeMcpConfig(mcpDir, { repo: REPO, storeRoot: root, brokerPort: BROKER_PORT });
  const mcpConfig = join(mcpDir, "mcp.json");
  const launcher = join(mcpDir, "launch-m9r-mcp.cjs");
  cleanups.push(() => { try { rmSync(mcpDir, { recursive: true, force: true }); } catch { /* temp */ } });

  async function snap(name: string) {
    if (!shotsDir || !self) return;
    try {
      mkdirSync(shotsDir, { recursive: true });
      const list = (await (await fetch("http://127.0.0.1:9334/json")).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const page = list.filter((x) => x.type === "page" && x.url.includes("test-page") && !x.url.includes("warmup")).pop();
      if (!page) return;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      const shot = await new Promise<string>((resolve) => { ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 2) resolve(d.result.data); }; ws.send(JSON.stringify({ id: 1, method: "Page.bringToFront" })); setTimeout(() => ws.send(JSON.stringify({ id: 2, method: "Page.captureScreenshot", params: { format: "png" } })), 400); });
      writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(shot, "base64"));
      ws.close();
    } catch { /* screenshots are best effort */ }
  }

  async function fieldValues(): Promise<string> {
    if (!self) return "(check the fields on screen)";
    try {
      const list = (await (await fetch("http://127.0.0.1:9334/json")).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const page = list.filter((x) => x.type === "page" && x.url.includes("test-page") && !x.url.includes("warmup")).pop();
      if (!page) return "(no page tab found)";
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      const value = await new Promise<string>((resolve) => { ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 1) resolve(String(d.result?.result?.value)); }; ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "JSON.stringify({email:document.getElementById('email').value,order:document.getElementById('order').value,message:document.getElementById('message').value})", returnByValue: true } })); });
      ws.close();
      return value;
    } catch { return "(could not read the fields)"; }
  }

  function claudeSession(label: string) {
    return startLiveSession({
      config: { cwd: work, profile: "web-only", mcpConfigPath: mcpConfig, model },
      spawn: (command, args, cwd) => spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }) as never,
      env: process.env,
      onEvent: (e) => { if (e.kind === "tool") say(`${label} calls ${e.summary}`); else if (e.kind === "text") say(`${label} says: ${e.text.slice(0, 110)}`); else if (e.kind === "result") say(`${label} RESULT: ${e.text.slice(0, 140)}`); },
    });
  }
  const tabRule = "Use the tab name \"shared\" on EVERY m9r_web_* call. If a call is refused because the tab is in use by a teammate, wait a few seconds and try again. Never give up after one refusal.";

  async function team() {
    say("SCENE team: real Claude Code and real Codex on the same page");
    const claude = claudeSession("Claude");
    claude.send([
      `You are @claude, working with @codex on one shared web page through M9R tools. Your M9R session token is ${token.claude}; pass it as the token argument on every m9r_web_* call and every m9r_send call.`,
      tabRule,
      `1. Open ${site.url} in the tab.`,
      "2. Read the pricing with m9r_web_read selector '#pricing + p', then the shipping policy with selector '#shipping + p'.",
      "3. Type one short line about the volume rate and shipping into the field '#message' (selector #message) with m9r_web_type.",
      "4. Send @codex one line saying what you typed, with m9r_send. Do not open the page again after step 1: reopening reloads it and erases what you and @codex typed.",
      "Reply DONE with one line about what you did.",
    ].join("\n"));
    await sleep(2500);
    const codexCli = codexCliPath();
    if (!codexCli) throw new Error("Codex CLI entry point not found (set M9R_CODEX_CLI_JS)");
    const last = join(work, "codex-last.txt");
    const codexPrompt = `${CODEX_PREFACE}\n\n${[
      `You are @codex, working with @claude on one shared web page through M9R tools. Your M9R session token is ${token.codex}; pass it as the token argument on every m9r_web_* call and every m9r_send call.`,
      tabRule,
      `1. Your teammate @claude opens ${site.url} in the tab. Do NOT call m9r_web_open: it reloads the page and erases your teammate's typing. If your first call fails because the tab is not open yet, wait 5 seconds and try again.`,
      "2. Type the order number HG-1042 into the field '#order' with m9r_web_type.",
      "3. Read the returns policy with m9r_web_read selector '#returns + p'.",
      "4. Send @claude one line with the returns policy, with m9r_send.",
      "Reply DONE with one line about what you did.",
    ].join("\n")}`;
    const codex = startCodex(codexCli, codexArgs({ prompt: codexPrompt, cwd: work, launcher, storeRoot: root, brokerPort: BROKER_PORT, lastMessagePath: last }), work);
    say("Codex started");
    void codex.promise.then((o) => say(`Codex finished (exit ${o.code})`));
    await sleep(9000); await snap("team-1");
    const done = await Promise.race([codex.promise.then(() => "codex"), sleep(120_000).then(() => "timeout")]);
    for (let i = 0; i < 90 && claude.state().status !== "idle"; i++) await sleep(1000);
    await snap("team-2");
    say(`page fields at the end: ${await fieldValues()}`);
    say(`team scene ended (${done}); Claude status ${claude.state().status}, cost about $${claude.state().costUsd.toFixed(3)} API-equivalent`);
    claude.stop();
  }

  async function interrupt() {
    say("SCENE interrupt: real Claude Code, interrupted mid-task");
    await client.run({ agent: "director", provider: "director", sessionId: "film", action: "open", tab: "shared", url: `${site.url}?scene=interrupt` });
    await sleep(8500); // let the director's short claim lapse before Claude takes the tab
    const claude = claudeSession("Claude");
    claude.send([
      `You are @claude, an agent working in the user's browser through M9R tools. Your M9R session token is ${token.claude}; pass it as the token argument on every m9r_web_* call.`,
      tabRule,
      `1. Open ${site.url} in the tab.`,
      "2. Read three sections with m9r_web_read, one call each, in order: '#pricing + p', '#shipping + p', '#returns + p'. After each read write one short line about it.",
      "3. Then type a one-sentence summary into '#message'.",
      "Reply DONE when finished. If the user sends you a new message while you work, follow their newest instruction.",
    ].join("\n"));
    let reads = 0;
    const seen = () => timeline.filter((l) => l.includes("Claude calls") && l.includes("m9r_web_read")).length;
    for (let i = 0; i < 120 && (reads = seen()) < 2; i++) await sleep(500);
    say(">>> YOU INTERRUPT: skip the rest and type your instruction");
    claude.interrupt("Change of plan from the user: skip the remaining sections. Instead type exactly 'Interrupted by the user, please email me the pricing.' into the field '#message', then reply DONE.");
    for (let i = 0; i < 120 && claude.state().status !== "idle"; i++) await sleep(500);
    await snap("interrupt");
    say(`page fields at the end: ${await fieldValues()}`);
    say(`interrupt scene ended; interrupts ${claude.state().interrupts}, about $${claude.state().costUsd.toFixed(3)} API-equivalent`);
    claude.stop();
  }

  async function collision() {
    say("SCENE collision: a test script sends real commands as two agent identities (say so on camera)");
    const A = { agent: "claude", provider: "claude", sessionId: "film-a" };
    const B = { agent: "codex", provider: "codex", sessionId: "film-b" };
    const tab = "collision";
    const step = async (label: string, r: Parameters<typeof client.run>[0], pause = 2000) => { const out = await client.run(r); say(`${label}: ${JSON.stringify(out).slice(0, 150)}`); await sleep(pause); return out; };
    await step("Claude opens the page", { ...A, action: "open", tab, url: `${site.url}?scene=collision` }, 2500);
    await step("Codex reads pricing", { ...B, action: "read", tab, selector: "#pricing + p" });
    await step("Claude types in the order number", { ...A, action: "type", tab, selector: "#order", text: "HG-1042" }, 1500);
    await step("Codex tries to type in the same field (refused)", { ...B, action: "type", tab, selector: "#order", text: "HG-2000" }, 3000);
    await sleep(6500);
    await step("Codex types in a different field, no conflict", { ...B, action: "type", tab, selector: "#message", text: "12+ totes at $22, flat $9 shipping." }, 1500);
    await snap("collision");
  }

  if (countdown > 0) for (let i = countdown; i > 0; i--) { console.log(`Recording starts in ${i}...`); await sleep(1000); }
  const scenes: Record<string, () => Promise<void>> = { team, interrupt, collision };
  try {
    for (const name of sceneName === "all" ? ["team", "interrupt", "collision"] : [sceneName]) {
      if (!scenes[name]) throw new Error(`unknown scene ${name}`);
      await scenes[name]();
      await sleep(1500);
    }
  } finally {
    const logPath = join(tmpdir(), `m9r-film-${Date.now()}.log`);
    writeFileSync(logPath, timeline.join("\n"));
    console.log(`\ntimeline saved to ${logPath}`);
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
  }
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
