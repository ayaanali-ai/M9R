import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createWebBroker } from "@/lib/native/web-broker-core";

const chromeCandidates = [
  process.env.M9R_REALISM_CHROME,
  process.env.M9R_BENCH_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((candidate): candidate is string => Boolean(candidate));
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
const pageActions = readFileSync(new URL("../extensions/browser/src/page-actions.js", import.meta.url), "utf8");

type CdpResponse = { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

class CdpClient {
  private nextId = 0;
  private readonly socket: WebSocket;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; method: string }>();

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const pending = this.waiting.get(message.id);
      if (!pending) return;
      this.waiting.delete(message.id);
      if (message.error) pending.reject(new Error(`DevTools ${pending.method} failed: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    socket.on("close", () => this.rejectPending(new Error("DevTools socket closed.")));
    socket.on("error", (error) => this.rejectPending(error));
  }

  private rejectPending(error: Error) {
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.waiting.clear();
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`DevTools ${method} timed out.`));
      }, 5_000);
      this.waiting.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
        timer,
        method,
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { this.socket.terminate(); }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Fixture server did not bind a port."));
      else resolve(address.port);
    });
  });
}

function startChrome(binary: string, profileDir: string): Promise<{ process: ChildProcess; endpoint: string; diagnostics: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-gpu-compositing",
      "--disable-gpu-rasterization", "--disable-features=VizDisplayCompositor,UseSkiaRenderer",
      "--disable-extensions", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Chromium did not expose its DevTools endpoint: ${stderr.slice(-500)}`));
    }, 20_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve({ process: child, endpoint: match[1], diagnostics: () => stderr }); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { if (code !== null && !stderr.includes("DevTools listening")) { clearTimeout(timer); reject(new Error(`Chromium exited before startup (${code}).`)); } });
  });
}

function openSocket(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("the web broker refuses search-result URLs before dispatching an open command", async () => {
  const sent: unknown[] = [];
  const broker = createWebBroker({ send: (message) => { sent.push(message); return true; } });
  const refused = await broker.submit({ agent: "codex", provider: "codex", sessionId: "realism-test", action: "open", tab: "fixture", url: "https://example.test/search?q=needle" });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /search box|search URL|search url/i);
  assert.equal(sent.length, 0, "a search URL must be refused before the browser sees an open command");
});

test("packaged browser actions preserve realistic key timing and cursor landing", { skip: !chromePath && "Chromium/Chrome/Edge is not installed; set M9R_REALISM_CHROME to run this integration test." }, async (t) => {
  const fixture = `<!doctype html><html><head><title>M9R action fixture</title></head><body>
    <form id="search"><label for="query">Search</label><input id="query" type="search"><button id="submit">Search</button></form>
    <button id="target">Target button</button><p id="status">Ready</p>
    <script>
      window.__m9rTest = { moves: [], clicks: [], keyTimes: [] };
      const target = document.querySelector("#target");
      target.addEventListener("mousemove", event => window.__m9rTest.moves.push({ x: event.clientX, y: event.clientY, id: event.target.id }));
      target.addEventListener("click", event => { window.__m9rTest.clicks.push(event.target.id); document.querySelector("#status").textContent = "Clicked"; });
      document.querySelector("#query").addEventListener("keydown", () => window.__m9rTest.keyTimes.push(performance.now()));
      document.querySelector("#search").addEventListener("submit", event => { event.preventDefault(); document.querySelector("#status").textContent = "Results loaded"; history.pushState({}, "", "/results"); });
    </script></body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fixture);
  });
  const port = await listen(server);
  const fixtureUrl = `http://127.0.0.1:${port}/`;
  const profileDir = mkdtempSync(join(tmpdir(), "m9r-web-action-realism-"));
  let chrome: ChildProcess | null = null;
  let cdp: CdpClient | null = null;

  t.after(async () => {
    cdp?.close();
    if (chrome?.pid && process.platform === "win32") spawnSync("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome?.kill();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      await Promise.race([new Promise<void>((resolve) => chrome!.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  });

  const started = await startChrome(chromePath!, profileDir);
  chrome = started.process;
  const browserCdp = new CdpClient(await openSocket(started.endpoint));
  const { targetId } = await browserCdp.send<{ targetId: string }>("Target.createTarget", { url: fixtureUrl });
  const debugListUrl = new URL(started.endpoint);
  debugListUrl.protocol = "http:";
  debugListUrl.pathname = "/json/list";
  debugListUrl.search = "";
  const targets = await fetch(debugListUrl).then((response) => response.json()) as Array<{ id: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((entry) => entry.id === targetId);
  assert.ok(target, "Chromium should expose the fixture page target");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (/GPU process isn't usable/.test(started.diagnostics())) {
    browserCdp.close();
    t.skip("Installed Chromium cannot create a headless renderer on this host (GPU subprocess exits with Windows 0xC000001D). The real-browser assertions remain enabled for compatible Chromium hosts.");
  }
  browserCdp.close();
  try {
    cdp = new CdpClient(await openSocket(target.webSocketDebuggerUrl));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
  } catch (error) {
    if (/GPU process isn't usable/.test(started.diagnostics())) {
      cdp?.close();
      return t.skip("Installed Chromium cannot create a headless renderer on this host (GPU subprocess exits with Windows 0xC000001D). The real-browser assertions remain enabled for compatible Chromium hosts.");
    }
    throw error;
  }

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await cdp!.send<CdpResponse>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Chromium page evaluation failed.");
    return response.result?.value as T;
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate<string>("document.readyState") === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const click = await evaluate<{ ok: boolean; error?: string }>(`(async () => { ${pageActions}\n return await m9rPageClick("#target", ${JSON.stringify(new URL(fixtureUrl).origin)}, "/", true); })()`);
  assert.equal(click.ok, true, click.error);
  const clicked = await evaluate<{ moves: Array<{ x: number; y: number; id: string }>; clicks: string[]; rect: { left: number; right: number; top: number; bottom: number } }>(
    `(() => { const rect = document.querySelector("#target").getBoundingClientRect(); return { moves: window.__m9rTest.moves, clicks: window.__m9rTest.clicks, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }; })()`,
  );
  assert.ok(clicked.moves.length >= 3, `expected at least 3 cursor moves; observed ${clicked.moves.length}`);
  const landing = clicked.moves.at(-1);
  assert.ok(landing);
  assert.equal(landing.id, "target", "the final cursor move must land on the target control");
  assert.ok(landing.x >= clicked.rect.left && landing.x <= clicked.rect.right, "cursor x must land inside the target rectangle");
  assert.ok(landing.y >= clicked.rect.top && landing.y <= clicked.rect.bottom, "cursor y must land inside the target rectangle");
  assert.deepEqual(clicked.clicks, ["target"]);

  const typedText = "M9R-realistic-input";
  const typed = await evaluate<{ ok: boolean; error?: string }>(`(async () => { ${pageActions}\n return await m9rPageType("#query", ${JSON.stringify(typedText)}, ${JSON.stringify(new URL(fixtureUrl).origin)}, "/", true); })()`);
  assert.equal(typed.ok, true, typed.error);
  const typing = await evaluate<{ value: string; keyTimes: number[] }>(`({ value: document.querySelector("#query").value, keyTimes: window.__m9rTest.keyTimes })`);
  assert.equal(typing.value, typedText);
  const gaps = typing.keyTimes.slice(1).map((time, index) => time - typing.keyTimes[index]!);
  assert.ok(gaps.length >= 3, `expected multiple per-key intervals; observed ${gaps.length}`);
  assert.ok(gaps.every((gap) => gap > 0), "each per-key interval must be positive");
  assert.ok(new Set(gaps.map((gap) => Math.round(gap))).size > 1, `key gaps were constant: ${gaps.join(", ")}`);

});
