/**
 * Real agents on REAL public sites, for the launch video. Same honesty rules as film-run.ts: M9R's real web tools, the
 * real extension, and the subscription logins already on this machine (it refuses to start with an API key set). Every
 * page touched is public and read-only for us: agents only open, read, and type into search boxes. Nothing clicks,
 * logs in, posts or submits.
 *
 * Scenes
 *   collision  "real collision": Claude and Codex are told to search Wikipedia for SQLite in the same real search box at the
 *              same moment (a GO message releases both). One holds the field; the other is refused with M9R's plain
 *              message, goes to its own tab, reads the SQLite GitHub repo and messages the holder what it found.
 *   team3      "three agents, one real question" (how old is curl, how alive is it, what does HN say): Claude reads the
 *              Wikipedia article, Codex the GitHub repo, OpenCode the hn.algolia results; Codex and OpenCode message
 *              Claude, and Claude types a one-line answer into the hn.algolia search box (a live search, submits nothing).
 *   all        collision, then team3.
 *
 * Each scene checks itself and exits non-zero if the collision or the messaging did not really happen: the refusal must
 * appear in the refused agent's own transcript, the message must be in M9R's task store and read by its recipient, the
 * broker feed must show who acted where, and in self mode the real page's field value is read back over CDP.
 *
 * Modes
 *   --mode self      (default) starts its own broker (port 47931), and a headless Chromium with a temporary copy of the
 *                    extension that points at that port and is pre-granted the four sites. Needs E2E_CHROME=<unbranded
 *                    Chromium>, e.g. the Playwright chromium-1223 build.
 *   --mode running   for filming in YOUR Chrome. Stop any other M9R web broker first: this runner starts its own on the
 *                    extension's port 47821 with a throwaway store, so your real M9R inbox is not touched. Load (or reload)
 *                    the extension from extensions/browser and give it access to en.wikipedia.org, github.com and
 *                    hn.algolia.com once (see the preflight message). Then run with --countdown.
 *
 * Options: --scene <name>  --countdown <s>  --model <claude model>  --opencode-model <provider/model>  --shots <folder>
 *          --claim-seconds <n> (default 8, the product default)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "@/lib/native/local-store";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { startLiveSession } from "@/lib/native/live-session-core";
import { writeMcpConfig } from "../bench/claude-cli";
import { CODEX_PREFACE, codexArgs, codexCliPath, usageFromJsonl } from "../bench/codex-cli";

const argument = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined; };
const mode = argument("mode") ?? "self";
const sceneName = argument("scene") ?? "collision";
const countdown = Number(argument("countdown") ?? 0);
const model = argument("model") ?? "sonnet";
const opencodeModel = argument("opencode-model") ?? "opencode/big-pickle";
const claimSeconds = Number(argument("claim-seconds") ?? 8);
const shotsDir = argument("shots");
const self = mode !== "running";
const REPO = process.cwd();
const EXT = join(REPO, "extensions", "browser");
const BROKER_PORT = self ? 47931 : 47821;
const CDP_PORT = 9345;
const SITES = { wiki: "https://en.wikipedia.org", github: "https://github.com", hn: "https://hn.algolia.com", hnews: "https://news.ycombinator.com" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";
const timeline: string[] = [];
const say = (line: string) => { const l = `${at()}  ${line}`; timeline.push(l); console.log(l); };
const failures: string[] = [];
const check = (ok: boolean, what: string) => { say(`${ok ? "CHECK ok  " : "CHECK FAIL"}  ${what}`); if (!ok) failures.push(what); return ok; };

/** A throwaway copy of the extension that talks to this runner's broker port and already holds the four sites. */
function preparedExtension(dir: string): string {
  cpSync(EXT, dir, { recursive: true, filter: (src) => !src.includes("store-assets") });
  const bg = join(dir, "src", "background.js");
  writeFileSync(bg, readFileSync(bg, "utf8").replace("ws://127.0.0.1:47821/ext", `ws://127.0.0.1:${BROKER_PORT}/ext`));
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { host_permissions: string[] };
  manifest.host_permissions.push(...Object.values(SITES).map((origin) => `${origin}/*`));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function opencodeExe(): string | null {
  const candidates = [process.env.M9R_OPENCODE_EXE, process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe") : undefined];
  return candidates.find((p): p is string => Boolean(p && existsSync(p))) ?? null;
}

async function main() {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) if (process.env[key]) throw new Error(`${key} is set; unset it so runs use the subscription logins, not API billing`);
  const root = mkdtempSync(join(tmpdir(), "m9r-real-"));
  const work = mkdtempSync(join(tmpdir(), "m9r-real-work-"));
  const cleanups: Array<() => void | Promise<void>> = [
    () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* temp */ } },
    () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } },
  ];
  const children: ChildProcess[] = [];
  cleanups.push(() => { for (const c of children) if (c.pid && c.exitCode === null) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" }); });

  const keyPath = brokerKeyPath(root);
  let broker: Awaited<ReturnType<typeof startWebBroker>>;
  try {
    broker = await startWebBroker({ key: loadOrCreateBrokerKey(keyPath), port: BROKER_PORT, allowAnyExtension: true, timeoutMs: 30_000, claimTtlMs: claimSeconds * 1000 });
  } catch (error) {
    throw new Error(`could not start the broker on port ${BROKER_PORT} (${error instanceof Error ? error.message : error}). ${self ? "" : "Stop your other M9R web broker first; the extension only talks to 47821."}`);
  }
  cleanups.push(() => broker.close());

  if (self) {
    const chromePath = process.env.E2E_CHROME;
    if (!chromePath) throw new Error("self mode needs E2E_CHROME pointing at an unbranded Chromium (branded Chrome ignores --load-extension)");
    const ext = preparedExtension(mkdtempSync(join(tmpdir(), "m9r-real-ext-")));
    const profile = mkdtempSync(join(tmpdir(), "m9r-real-chrome-"));
    const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, `--load-extension=${ext}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--no-first-run", "--window-size=1280,860", "--lang=en-US", "about:blank"], { stdio: "ignore" });
    cleanups.push(() => { if (chrome.pid) spawnSync("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); for (const d of [profile, ext]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });
  }

  const store = createLocalStore(root);
  const client = createWebBrokerClient({ keyPath, port: BROKER_PORT });
  const token = {
    claude: store.issueIdentity("claude", "claude", "real-claude").token,
    codex: store.issueIdentity("codex", "codex", "real-codex").token,
    opencode: store.issueIdentity("opencode", "opencode", "real-opencode").token,
  };
  for (const [from, to] of [["claude", "codex"], ["codex", "claude"], ["opencode", "claude"]]) store.addRule({ from, to, ttlMs: 2 * 60 * 60_000, note: "film run" });

  // The broker feed is the audit trail: every dispatched action and every agent message, with who, which tab and where.
  const feed = new Map<number, Record<string, unknown>>();
  const feedTabs = new Map<string, string>();
  const key = readFileSync(keyPath, "utf8").trim();
  const pollFeed = async () => {
    try {
      const snap = (await (await fetch(`http://127.0.0.1:${BROKER_PORT}/web/feed`, { headers: { "x-m9r-key": key } })).json()) as { recent: Array<Record<string, unknown>>; tabs: Array<{ tab: string; origin?: string }> };
      for (const entry of snap.recent) feed.set(Number(entry.seq), entry);
      for (const tab of snap.tabs) if (tab.origin) feedTabs.set(tab.tab, tab.origin);
    } catch { /* next poll */ }
  };
  const feedTimer = setInterval(() => void pollFeed(), 700);
  cleanups.push(() => clearInterval(feedTimer));
  const feedEntries = () => [...feed.values()].sort((a, b) => Number(a.seq) - Number(b.seq));

  // Warm up and preflight: the extension must be connected and allowed on every site the scenes use.
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    const r = await Promise.race([client.run({ agent: "director", provider: "director", sessionId: "film", action: "open", tab: "warmup", url: `${SITES.wiki}/wiki/Special:BlankPage` }), sleep(12_000).then(() => ({ ok: false, error: "no answer" }))]);
    ready = r.ok;
    if (!ready && /permission/i.test(r.error ?? "")) break;
    if (!ready) await sleep(1000);
  }
  const blocked: string[] = [];
  for (const [name, url] of [["en.wikipedia.org", `${SITES.wiki}/wiki/Special:BlankPage`], ["github.com", `${SITES.github}/curl/curl`], ["hn.algolia.com", `${SITES.hn}/?q=curl`]]) {
    const r = await client.run({ agent: "director", provider: "director", sessionId: "film", action: "open", tab: "warmup", url });
    if (!r.ok) blocked.push(`${name}: ${r.error}`);
  }
  // Park the helper tab on a blank page so it is never mistaken for a scene tab (CDP checks skip BlankPage).
  await client.run({ agent: "director", provider: "director", sessionId: "film", action: "open", tab: "warmup", url: `${SITES.wiki}/wiki/Special:BlankPage` });
  if (blocked.length) {
    throw new Error([
      "preflight failed; the extension cannot act on every scene site:", ...blocked.map((b) => `  ${b}`),
      "Fix (once per site, in the Chrome that has the extension): open the site, click the M9R extension icon in the toolbar,",
      "click \"Allow this site\", then \"Allow\" in Chrome's own prompt. Sites: en.wikipedia.org, github.com, hn.algolia.com.",
    ].join("\n"));
  }
  say(`extension connected and allowed on wikipedia, github and hn.algolia (broker ${BROKER_PORT}, claim ${claimSeconds}s)`);

  const mcpDir = mkdtempSync(join(tmpdir(), "m9r-real-mcp-"));
  writeMcpConfig(mcpDir, { repo: REPO, storeRoot: root, brokerPort: BROKER_PORT });
  const mcpConfig = join(mcpDir, "mcp.json");
  const launcher = join(mcpDir, "launch-m9r-mcp.cjs");
  cleanups.push(() => { try { rmSync(mcpDir, { recursive: true, force: true }); } catch { /* temp */ } });

  async function cdpPage(urlPart: string) {
    if (!self) return null;
    const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    return list.filter((x) => x.type === "page" && x.url.includes(urlPart) && !x.url.includes("BlankPage")).pop() ?? null;
  }
  async function cdp<T>(urlPart: string, method: string, params: Record<string, unknown>): Promise<T | null> {
    try {
      const page = await cdpPage(urlPart);
      if (!page) return null;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      const result = await new Promise<T>((resolve) => { ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 2) resolve(d.result as T); }; ws.send(JSON.stringify({ id: 1, method: "Page.bringToFront" })); setTimeout(() => ws.send(JSON.stringify({ id: 2, method, params })), 300); });
      ws.close();
      return result;
    } catch { return null; }
  }
  // Every match, joined: Wikipedia's search component swaps its input element once it is used, so one selector can go stale.
  const pageValue = async (urlPart: string, selector: string) => {
    const r = await cdp<{ result?: { value?: unknown } }>(urlPart, "Runtime.evaluate", { expression: `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.value).filter(Boolean).join(" | ") || null`, returnByValue: true });
    return r?.result?.value === undefined ? null : (r.result.value as string | null);
  };
  async function snap(name: string, urlPart: string) {
    if (!shotsDir || !self) return;
    const r = await cdp<{ data: string }>(urlPart, "Page.captureScreenshot", { format: "png" });
    if (r?.data) { mkdirSync(shotsDir, { recursive: true }); writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(r.data, "base64")); }
  }

  /** Marks every existing inbox item as seen for a session, so an agent only ever sees this scene's messages. */
  const drainInbox = (handle: string, sessionId: string) => { const seqs = store.tasksFor(handle).map((t) => t.seq); if (seqs.length) store.setCursor(handle, sessionId, Math.max(...seqs)); };

  function claudeSession(label: string, transcript: string[]) {
    return startLiveSession({
      config: { cwd: work, profile: "web-only", mcpConfigPath: mcpConfig, model },
      spawn: (command, args, cwd) => {
        const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        child.stdout.on("data", (chunk: Buffer) => transcript.push(chunk.toString()));
        return child as never;
      },
      env: process.env,
      onEvent: (e) => { if (e.kind === "tool") say(`${label} calls ${e.summary}`); else if (e.kind === "text") say(`${label} says: ${e.text.slice(0, 110)}`); else if (e.kind === "result") say(`${label} RESULT: ${e.text.slice(0, 160)}`); },
    });
  }

  function startCodexStreaming(prompt: string, onLine: (line: string) => void) {
    const cli = codexCliPath();
    if (!cli) throw new Error("Codex CLI entry point not found (set M9R_CODEX_CLI_JS)");
    const last = join(work, `codex-last-${Date.now()}.txt`);
    const child = spawn(process.execPath, [cli, ...codexArgs({ prompt: `${CODEX_PREFACE}\n\n${prompt}`, cwd: work, launcher, storeRoot: root, brokerPort: BROKER_PORT, lastMessagePath: last })], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString(); buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) onLine(line); }
    });
    const done = new Promise<{ code: number | null; stdout: string; last: string }>((resolve) => child.once("close", (code) => resolve({ code, stdout, last: existsSync(last) ? readFileSync(last, "utf8").trim() : "" })));
    return { done, stdout: () => stdout };
  }

  /** One-line narration of a Codex JSONL event: tool calls (direct or through the exec gateway) and its messages. */
  function narrateCodex(line: string) {
    let e: { type?: string; item?: Record<string, unknown> };
    try { e = JSON.parse(line); } catch { return; }
    if (e.type !== "item.started" && e.type !== "item.completed") return;
    const item = e.item ?? {};
    const text = JSON.stringify(item);
    const tool = /m9r_(web_open|web_read|web_type|web_click|send|inbox|whoami|note)/.exec(text)?.[0];
    if (e.type === "item.started" && tool) say(`Codex calls ${tool}${/"selector\\?":\\?"([^"\\]+)/.exec(text)?.[1] ? `: ${/"selector\\?":\\?"([^"\\]+)/.exec(text)?.[1]}` : ""}`);
    else if (e.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") say(`Codex says: ${item.text.slice(0, 140)}`);
    else if (e.type === "item.completed" && /is in use by @/.test(text)) say(`Codex was REFUSED: ${/[a-z]+ in tab [^.]*is in use by @\w+ for about \d+s/.exec(text.replace(/\\"/g, '"'))?.[0] ?? "field in use"}`);
  }

  function startOpenCode(prompt: string, label: string) {
    const exe = opencodeExe();
    if (!exe) throw new Error("OpenCode not found (set M9R_OPENCODE_EXE to opencode.exe)");
    // A fixed config home: OpenCode bootstraps a new config dir once (about two minutes), later starts take about 20 s.
    const xdg = join(tmpdir(), "m9r-film-opencode-xdg");
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    const off = Object.fromEntries(["bash", "edit", "write", "read", "grep", "glob", "list", "webfetch", "websearch", "task", "todowrite", "todoread", "patch", "codesearch", "skill"].map((t) => [t, false]));
    writeFileSync(join(xdg, "opencode", "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { m9r: { type: "local", command: [process.execPath, launcher], environment: { M9R_HOME: root, M9R_WEB_BROKER_PORT: String(BROKER_PORT) }, enabled: true } },
      tools: off,
    }));
    const child = spawn(exe, ["run", "--format", "json", "-m", opencodeModel, prompt], { cwd: work, env: { ...process.env, XDG_CONFIG_HOME: xdg }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    let buffer = "";
    const tokens = { input: 0, output: 0, cached: 0 };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString(); buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let e: { type?: string; part?: { tool?: string; text?: string; state?: { input?: { selector?: string; url?: string }; output?: string; status?: string }; tokens?: { input?: number; output?: number; cache?: { read?: number } } } };
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "tool_use") say(`${label} calls ${String(e.part?.tool).replace(/^m9r_/, "")}${e.part?.state?.input?.selector ? `: ${e.part.state.input.selector}` : e.part?.state?.input?.url ? `: ${e.part.state.input.url}` : ""}${e.part?.state?.status === "error" ? " (error)" : ""}`);
        else if (e.type === "text" && e.part?.text) say(`${label} says: ${e.part.text.slice(0, 140)}`);
        else if (e.type === "step_finish") { tokens.input += e.part?.tokens?.input ?? 0; tokens.output += e.part?.tokens?.output ?? 0; tokens.cached += e.part?.tokens?.cache?.read ?? 0; }
      }
    });
    const done = new Promise<{ code: number | null; stdout: string }>((resolve) => child.once("close", (code) => resolve({ code, stdout })));
    return { done, tokens, stdout: () => stdout };
  }

  const safety = "Never click anything, never log in, never submit, post, subscribe or buy. Only m9r_web_open, m9r_web_read, m9r_web_type (search boxes only), m9r_send and m9r_inbox.";

  async function collision() {
    say("SCENE collision: real Claude Code and real Codex race for the same real Wikipedia search box");
    await client.run({ agent: "director", provider: "director", sessionId: "film", action: "open", tab: "shared", url: `${SITES.wiki}/wiki/Main_Page` });
    await sleep(claimSeconds * 1000 + 500); // the director's open claims the tab; let it lapse before the agents race
    drainInbox("claude", "real-claude"); drainInbox("codex", "real-codex");
    const seqBefore = { claude: Math.max(0, ...store.tasksFor("claude").map((t) => t.seq)), codex: Math.max(0, ...store.tasksFor("codex").map((t) => t.seq)) };
    const since = Math.max(0, ...feed.keys());
    const prompt = (me: "claude" | "codex", other: "claude" | "codex") => [
      `You are @${me}, working with @${other} in the owner's real browser through M9R tools. Your M9R session token is ${token[me]}; pass it as the token argument on every M9R call.`,
      "The tab named \"shared\" already shows Wikipedia. Never call m9r_web_open on the tab \"shared\".",
      `1. Call m9r_inbox with waitSeconds 30. Repeat until a message from @director saying GO arrives. Do nothing else before GO.`,
      "2. The moment GO arrives, search Wikipedia for SQLite: m9r_web_type with tab \"shared\", selector \"#searchInput\", text \"SQLite\".",
      "3. If step 2 SUCCEEDED, the field is yours: immediately make two more m9r_web_type calls on the same tab and selector, first with text \"SQLite history\", then \"SQLite history and license\". Then wait for your teammate: call m9r_inbox with waitSeconds 30, up to 4 times, until a message from @" + other + " arrives. Reply DONE and quote that message.",
      `4. If step 2 was REFUSED because @${other} is using the field, do not touch that field again and do not wait. Open https://github.com/sqlite/sqlite in your OWN tab named \"research\" with m9r_web_open, read it once with m9r_web_read (tab \"research\", no selector), then send your teammate ONE short line with m9r_send (to: \"${other}\", no @ sign) saying what that repository is and one concrete fact from the page. Then reply DONE.`,
      safety,
    ].join("\n");

    const claudeLog: string[] = [];
    const codexLines: string[] = [];
    const claude = claudeSession("Claude", claudeLog);
    claude.send(prompt("claude", "codex"));
    const codex = startCodexStreaming(prompt("codex", "claude"), (line) => { codexLines.push(line); narrateCodex(line); });
    say("Claude and Codex started; both wait for GO");
    const waiting = (s: string) => /m9r_inbox/.test(s);
    for (let i = 0; i < 300 && !(claudeLog.some(waiting) && codexLines.some(waiting)); i++) await sleep(500);
    if (!check(claudeLog.some(waiting) && codexLines.some(waiting), "both agents reached the GO barrier within 150 s")) { claude.stop(); return; }
    await sleep(1500);
    say(">>> GO to both at once");
    for (const to of ["claude", "codex"]) store.addTask({ to, from: "director", goal: "GO", origin: "human_typed", idempotencyKey: `go:${to}:${Date.now()}` });
    const goAt = Date.now();

    const codexRun = await Promise.race([codex.done, sleep(240_000).then(() => null)]);
    for (let i = 0; i < 240 && claude.state().status !== "idle" && claude.state().status !== "exited"; i++) await sleep(500);
    const sceneSeconds = ((Date.now() - goAt) / 1000).toFixed(0);
    await snap("collision", "wikipedia.org/wiki/Main_Page");
    await pollFeed();

    const claudeText = claudeLog.join("");
    const codexText = codexRun?.stdout ?? codex.stdout();
    const refusedClaude = /is in use by @codex/.test(claudeText);
    const refusedCodex = /is in use by @claude/.test(codexText);
    check(refusedClaude !== refusedCodex, `exactly one agent was refused on the field (Claude refused: ${refusedClaude}, Codex refused: ${refusedCodex})`);
    const holder = refusedCodex ? "claude" : "codex";
    const loser = holder === "claude" ? "codex" : "claude";
    say(`holder @${holder}, refused @${loser}`);
    const entries = feedEntries().filter((e) => Number(e.seq) > since);
    const typedShared = entries.filter((e) => e.tab === "shared" && String(e.action).startsWith("typing in"));
    check(typedShared.length > 0 && typedShared.every((e) => e.agent === holder), `broker feed: only @${holder} typed in the shared tab (${typedShared.map((e) => e.agent).join(", ")})`);
    check(entries.some((e) => e.agent === loser && e.tab === "research" && String(e.action).startsWith("opening github.com")), `broker feed: @${loser} opened github.com in its own tab "research"`);
    const note = store.tasksFor(holder).find((t) => t.from === loser && t.seq > seqBefore[holder]);
    if (!note && store.tasksFor(`@${holder}`).some((t) => t.from === loser)) say(`@${loser} addressed its message to "@${holder}" (with the @), so it never reached @${holder}'s inbox`);
    check(Boolean(note), `task store: @${loser} sent @${holder} a message${note ? `: "${note.goal.slice(0, 120)}"` : ""}`);
    check(entries.some((e) => e.messageKind === "agent_message" && e.agent === loser), "broker feed: the message was shown on the page overlay");
    const holderText = holder === "claude" ? claudeText : codexText;
    check(Boolean(note) && holderText.includes(note!.id), `@${holder} actually read the message (${note?.id ?? "none"}) through m9r_inbox`);
    if (self) {
      const value = await pageValue("wikipedia.org/wiki/Main_Page", "input[name=search]");
      check(typeof value === "string" && /(^| )SQLite/.test(value), `real page: Wikipedia's search box holds "${value}"`);
    }
    const codexUsage = usageFromJsonl(codexText);
    say(`collision scene ended ${sceneSeconds}s after GO; Codex exit ${codexRun?.code ?? "timeout"}; Claude about $${claude.state().costUsd.toFixed(3)} API-equivalent (subscription); Codex tokens ${codexUsage ? `${codexUsage.input} in (${codexUsage.cached} cached) / ${codexUsage.output} out` : "n/a"}`);
    claude.stop();
  }

  async function team3() {
    say("SCENE team3: Claude, Codex and OpenCode answer one real question about curl");
    drainInbox("claude", "real-claude"); drainInbox("codex", "real-codex"); drainInbox("opencode", "real-opencode");
    const claudeSeqBefore = Math.max(0, ...store.tasksFor("claude").map((t) => t.seq));
    const since = Math.max(0, ...feed.keys());
    const hnTab = "hn";
    const claudeLog: string[] = [];
    const claude = claudeSession("Claude", claudeLog);
    const opencode = startOpenCode([
      `You are @opencode, one of three agents answering: how old is curl, how alive is it, and what does Hacker News say about it? You work in the owner's real browser through M9R tools. Your M9R session token is ${token.opencode}; pass it as the token argument on every M9R call.`,
      `1. Open https://hn.algolia.com/?q=curl in the tab named "${hnTab}" with m9r_web_open.`,
      `2. Read the results once with m9r_web_read (tab "${hnTab}", selector "main" or no selector).`,
      "3. Send @claude ONE short line with m9r_send (to: \"claude\", no @ sign): the title of the top Hacker News story about curl and its points. Then reply DONE.",
      "Do not type anything anywhere: @claude types into this tab later.",
      safety,
    ].join("\n"), "OpenCode");
    say("OpenCode started");
    claude.send([
      `You are @claude, the lead of three agents answering: how old is curl, how alive is it, and what does Hacker News say about it? You work in the owner's real browser through M9R tools. Your M9R session token is ${token.claude}; pass it as the token argument on every M9R call.`,
      "@codex is checking the GitHub repo and @opencode is reading Hacker News; both will message you.",
      "1. Open https://en.wikipedia.org/wiki/CURL in your tab named \"wiki\" with m9r_web_open, then read the infobox with m9r_web_read (tab \"wiki\", selector \".infobox\"). Note the initial release year.",
      "2. Wait for both teammates: call m9r_inbox with waitSeconds 30, repeatedly (up to 6 times), until you have one message from @codex AND one from @opencode.",
      `3. Type ONE line (under 90 characters, plain words, it must contain the word curl) answering the question into the Hacker News search box: m9r_web_type with tab "${hnTab}", selector "input[type=search]". Do not open that tab and do not press enter. Type it once.`,
      "4. Reply DONE with the line you typed.",
      safety,
    ].join("\n"));
    await sleep(2000);
    const codexLines: string[] = [];
    const codex = startCodexStreaming([
      `You are @codex, one of three agents answering: how old is curl, how alive is it, and what does Hacker News say about it? You work in the owner's real browser through M9R tools. Your M9R session token is ${token.codex}; pass it as the token argument on every M9R call.`,
      "1. Open https://github.com/curl/curl in your tab named \"repo\" with m9r_web_open.",
      "2. Read it once with m9r_web_read (tab \"repo\", no selector).",
      "3. Send @claude ONE short line with m9r_send (to: \"claude\", no @ sign): the star count and how recently it was committed to. Then reply DONE.",
      safety,
    ].join("\n"), (line) => { codexLines.push(line); narrateCodex(line); });
    say("Codex started");
    const [codexRun, opencodeRun] = await Promise.all([Promise.race([codex.done, sleep(240_000).then(() => null)]), Promise.race([opencode.done, sleep(240_000).then(() => null)])]);
    say(`Codex finished (${codexRun ? `exit ${codexRun.code}` : "timeout"}); OpenCode finished (${opencodeRun ? `exit ${opencodeRun.code}` : "timeout"})`);
    for (let i = 0; i < 360 && claude.state().status !== "idle" && claude.state().status !== "exited"; i++) await sleep(500);
    await snap("team3", "hn.algolia.com");
    await pollFeed();

    const entries = feedEntries().filter((e) => Number(e.seq) > since);
    const opened = (agent: string, host: string) => entries.some((e) => e.agent === agent && String(e.action) === `opening ${host}`);
    check(opened("claude", "en.wikipedia.org"), "broker feed: @claude opened en.wikipedia.org");
    check(opened("codex", "github.com"), "broker feed: @codex opened github.com");
    check(opened("opencode", "hn.algolia.com"), "broker feed: @opencode opened hn.algolia.com");
    const inbox = store.tasksFor("claude").filter((t) => t.seq > claudeSeqBefore);
    const claudeText = claudeLog.join("");
    for (const from of ["codex", "opencode"]) {
      const note = inbox.find((t) => t.from === from);
      if (!note && store.tasksFor("@claude").some((t) => t.from === from)) say(`@${from} addressed its message to "@claude" (with the @), so it never reached the inbox`);
      check(Boolean(note), `task store: @${from} messaged @claude${note ? `: "${note.goal.slice(0, 120)}"` : ""}`);
      check(Boolean(note) && claudeText.includes(note!.id), `@claude read @${from}'s message (${note?.id ?? "none"}) through m9r_inbox`);
    }
    const typed = entries.filter((e) => e.tab === hnTab && String(e.action).startsWith("typing in"));
    check(typed.some((e) => e.agent === "claude"), `broker feed: @claude typed in the hn.algolia tab (${typed.map((e) => e.agent).join(", ") || "nobody"})`);
    if (self) {
      const value = await pageValue("hn.algolia.com", "input[type=search]");
      check(typeof value === "string" && /curl/i.test(value) && value.length > 12, `real page: hn.algolia search box holds "${value}"`);
    }
    const codexUsage = usageFromJsonl(codexRun?.stdout ?? codex.stdout());
    say(`team3 ended; Claude about $${claude.state().costUsd.toFixed(3)} API-equivalent (subscription); Codex tokens ${codexUsage ? `${codexUsage.input} in (${codexUsage.cached} cached) / ${codexUsage.output} out` : "n/a"}; OpenCode (${opencodeModel}) tokens ${opencode.tokens.input} in (${opencode.tokens.cached} cached) / ${opencode.tokens.output} out`);
    claude.stop();
  }

  if (!self) say("Filming: bring the M9R tabs to the front as they open (the extension opens them in the background).");
  if (countdown > 0) for (let i = countdown; i > 0; i--) { console.log(`Recording starts in ${i}...`); await sleep(1000); }
  const scenes: Record<string, () => Promise<void>> = { collision, team3 };
  try {
    for (const name of sceneName === "all" ? ["collision", "team3"] : [sceneName]) {
      if (!scenes[name]) throw new Error(`unknown scene ${name}`);
      await scenes[name]();
      await sleep(1500);
    }
  } finally {
    const logPath = join(tmpdir(), `m9r-film-real-${Date.now()}.log`);
    writeFileSync(logPath, timeline.join("\n"));
    console.log(`\ntimeline saved to ${logPath}`);
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
  }
  if (failures.length) throw new Error(`SCENE CHECKS FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  console.log("all scene checks passed");
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
