/**
 * Headless Chrome that answers the web broker exactly like the browser extension does, so the whole stack (agent tool
 * -> broker -> browser -> page) can be exercised and timed without loading an unpacked extension. It runs the same
 * page-action code as extensions/browser/src/page-actions.js through the DevTools protocol.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.M9R_BENCH_CHROME && existsSync(env.M9R_BENCH_CHROME)) return env.M9R_BENCH_CHROME;
  return CHROME_PATHS.find((path) => existsSync(path)) ?? null;
}

type CdpResult = { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

type PendingCdpCall = {
  method: string;
  sessionId?: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class Cdp {
  nextId = 0;
  waiting = new Map<number, PendingCdpCall>();
  socket: WebSocket;
  diagnostics?: () => string;

  constructor(socket: WebSocket, diagnostics?: () => string) {
    this.socket = socket;
    this.diagnostics = diagnostics;
    socket.on("message", (data) => {
      let message: { id?: number; result?: unknown; error?: { message: string } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        this.rejectPending(new Error("DevTools returned an invalid protocol message"));
        return;
      }
      const entry = message.id === undefined ? undefined : this.waiting.get(message.id);
      if (!entry || message.id === undefined) return;
      this.waiting.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    socket.on("error", (error) => this.rejectPending(new Error(`DevTools WebSocket error: ${error.message}`)));
    socket.on("close", (code, reason) => {
      const detail = reason.length > 0 ? `: ${reason.toString()}` : "";
      let context = "";
      try { context = this.diagnostics?.() ?? ""; } catch { /* diagnostics must never mask the transport failure */ }
      this.rejectPending(new Error(`DevTools WebSocket closed (code ${code})${detail}${context ? `; ${context}` : ""}`));
    });
  }

  rejectPending(error: Error): void {
    for (const [id, entry] of this.waiting) {
      this.waiting.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`DevTools WebSocket is not open (state ${this.socket.readyState}) while sending ${method}`));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        const session = sessionId ? ` for session ${sessionId}` : "";
        reject(new Error(`DevTools call ${method}${session} did not answer within 15s`));
      }, 15_000);
      this.waiting.set(id, {
        method,
        sessionId,
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }), (error) => {
          if (!error) return;
          const entry = this.waiting.get(id);
          if (!entry) return;
          this.waiting.delete(id);
          entry.reject(new Error(`DevTools could not send ${method}: ${error.message}`));
        });
      } catch (error) {
        const entry = this.waiting.get(id);
        if (!entry) return;
        this.waiting.delete(id);
        entry.reject(new Error(`DevTools could not send ${method}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }
}

function launchChrome(chromePath: string, profileDir: string): Promise<{ process: ChildProcess; endpoint: string; diagnostics: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      chromePath,
      ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let settled = false;
    let buffer = "";
    let stderrTail = "";
    const diagnostics = () => {
      const relevantStderr = stderrTail
        .replace(/(?:DevTools listening on )?wss?:\/\/[^\s]+/g, "[DevTools URL redacted]")
        .replace(/https?:\/\/[^\s]+/g, "[URL redacted]")
        .split(/\r?\n/)
        .filter((line) => /(error|warn|failed|crash|fatal|exit)/i.test(line))
        .slice(-8)
        .join(" | ");
      return `Chrome exit=${child.exitCode ?? "running"}, signal=${child.signalCode ?? "none"}, killed=${child.killed}${relevantStderr ? `, stderr=${relevantStderr}` : ""}`;
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${message}; ${diagnostics()}`));
    };
    const timer = setTimeout(() => fail("Chrome did not report a DevTools endpoint in time"), 20_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      buffer += text;
      stderrTail = `${stderrTail}${text}`.slice(-16_384);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ process: child, endpoint: match[1], diagnostics });
      }
    });
    child.once("error", (error) => fail(`Chrome failed to start: ${error.message}`));
    child.once("exit", (code, signal) => fail(`Chrome exited before reporting a DevTools endpoint (code ${code ?? "unknown"}, signal ${signal ?? "none"})`));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openSocket(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : undefined);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function connectBenchBroker(brokerPort: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${brokerPort}/ext`, { origin: "chrome-extension://bench-driver" });
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "ready" }));
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export async function startCdpDriver(options: { brokerPort: number; chromePath?: string }): Promise<{ close: () => Promise<void> }> {
  const chromePath = options.chromePath ?? findChrome();
  if (!chromePath) throw new Error("no Chrome or Edge found (set M9R_BENCH_CHROME)");
  const pageActions = readFileSync(join(process.cwd(), "extensions", "browser", "src", "page-actions.js"), "utf8");
  const profileDir = mkdtempSync(join(tmpdir(), "m9r-bench-chrome-"));
  const chrome = await launchChrome(chromePath, profileDir);
  const cdp = new Cdp(await openSocket(chrome.endpoint), chrome.diagnostics);
  chrome.process.once("exit", (code, signal) => {
    cdp.rejectPending(new Error(`Chrome exited while the CDP driver was active (code ${code ?? "unknown"}, signal ${signal ?? "none"}); ${chrome.diagnostics()}`));
  });
  const tabs = new Map<string, string>();

  async function evaluate(sessionId: string, expression: string): Promise<unknown> {
    const out = await cdp.send<CdpResult>("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? "page script failed");
    return out.result?.value;
  }

  const originOf = async (sessionId: string) => {
    const value = await evaluate(sessionId, "location.protocol.startsWith('http') ? location.origin : null");
    return typeof value === "string" ? value : null;
  };

  const urlOf = async (sessionId: string) => {
    const value = await evaluate(sessionId, "location.protocol.startsWith('http') ? location.href : null");
    return typeof value === "string" ? value : null;
  };

  const pathWithinGrant = (url: string | null, prefix: string | undefined) => {
    if (!prefix) return true;
    if (!url) return false;
    try {
      const path = new URL(url).pathname;
      return prefix === "/" || path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
    } catch {
      return false;
    }
  };

  async function navigate(sessionId: string, url: string): Promise<void> {
    const before = await evaluate(sessionId, "({ url: location.href, timeOrigin: performance.timeOrigin })") as { url?: string; timeOrigin?: number };
    await cdp.send("Page.navigate", { url }, sessionId);
    for (let i = 0; i < 200; i++) {
      const state = await evaluate(sessionId, "({ readyState: document.readyState, url: location.href, timeOrigin: performance.timeOrigin })") as {
        readyState?: string;
        url?: string;
        timeOrigin?: number;
      };
      const newDocument = state.url !== before.url || state.timeOrigin !== before.timeOrigin;
      if (newDocument && state.readyState === "complete" && state.url !== "about:blank") return;
      await sleep(25);
    }
    throw new Error("a new page document did not finish loading");
  }

async function waitForClickNavigation(sessionId: string, before: { url?: string; timeOrigin?: number }): Promise<void> {
  const navigationGraceDeadline = Date.now() + 300;
  const navigationDeadline = Date.now() + 5_000;
  let navigationStarted = false;
  while (Date.now() < navigationDeadline) {
    const state = await evaluate(sessionId, "({ readyState: document.readyState, url: location.href, timeOrigin: performance.timeOrigin })") as {
      readyState?: string;
      url?: string;
      timeOrigin?: number;
    };
    navigationStarted = state.url !== before.url || state.timeOrigin !== before.timeOrigin;
    if (navigationStarted && state.readyState === "complete" && state.url !== "about:blank") return;
    if (!navigationStarted && Date.now() >= navigationGraceDeadline) return;
    await sleep(25);
  }
  if (navigationStarted) throw new Error("the page did not finish loading after the browser click");
}

  const broker = await connectBenchBroker(options.brokerPort);
  const reply = (id: string, ok: boolean, payload: { data?: unknown; error?: string }, origin?: string | null, url?: string | null) =>
    broker.send(JSON.stringify({ type: "result", id, ok, data: payload.data, error: payload.error, origin: origin ?? undefined, url: url ?? undefined }));

  async function handle(command: { id: string; action: string; tab: string; url?: string; selector?: string; text?: string; args?: Record<string, unknown>; expectOrigin?: string; expectPathPrefix?: string }) {
    try {
      if (command.action === "open") {
        let sessionId = tabs.get(command.tab);
        if (!sessionId) {
          const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
          sessionId = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
          await cdp.send("Page.enable", {}, sessionId);
          await cdp.send("Runtime.enable", {}, sessionId);
          tabs.set(command.tab, sessionId);
        }
        await navigate(sessionId, command.url ?? "about:blank");
        const landed = await originOf(sessionId);
        const actualUrl = await urlOf(sessionId);
        if (command.expectOrigin && landed !== command.expectOrigin) {
          await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
          return reply(command.id, false, { error: "the page ended up outside the granted site" }, landed, actualUrl);
        }
        if (command.expectPathPrefix && !pathWithinGrant(actualUrl, command.expectPathPrefix)) {
          await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
          return reply(command.id, false, { error: "the page ended up outside the granted path" }, landed, actualUrl);
        }
        return reply(command.id, true, { data: { tab: command.tab, url: command.url } }, landed, actualUrl);
      }

      const sessionId = tabs.get(command.tab);
      if (!sessionId) return reply(command.id, false, { error: `tab "${command.tab}" is not open; call m9r_web_open first` });
      const current = await originOf(sessionId);
      const currentUrl = await urlOf(sessionId);
      if (command.expectOrigin && current !== command.expectOrigin) return reply(command.id, false, { error: "the tab is no longer on the granted site" }, current);
      if (command.expectPathPrefix && !pathWithinGrant(currentUrl, command.expectPathPrefix)) return reply(command.id, false, { error: "the tab is no longer within the granted path" }, current, currentUrl);

      if (command.action === "click") {
        // This isolated headless test harness has no visible renderer or Native Messaging host.
        // Exercise the same validated click plan through browser-level input; production visible-tab
        // clicks are dispatched by the native host, never by this benchmark-only CDP path.
        const clickPlan = (await evaluate(sessionId,
          `${pageActions}\n;m9rPageClickPlan(${JSON.stringify(command.selector)}, ${JSON.stringify(command.expectOrigin ?? null)}, ${JSON.stringify(command.expectPathPrefix ?? null)}, null, null, "left", 1, "click")`)) as {
            ok: boolean;
            data?: { x: number; y: number; clickCount: number; name?: string };
            error?: string;
          };
        if (!clickPlan.ok || !clickPlan.data) return reply(command.id, false, { error: clickPlan.error ?? "could not prepare trusted benchmark input" }, current, currentUrl);
        const clickOrigin = await originOf(sessionId);
        const clickUrl = await urlOf(sessionId);
        if (command.expectOrigin && clickOrigin !== command.expectOrigin) return reply(command.id, false, { error: "the page left its granted site before benchmark input" }, clickOrigin, clickUrl);
        if (command.expectPathPrefix && !pathWithinGrant(clickUrl, command.expectPathPrefix)) return reply(command.id, false, { error: "the page left its granted path before benchmark input" }, clickOrigin, clickUrl);

        const { x, y, clickCount } = clickPlan.data;
        const beforeInput = await evaluate(sessionId, "({ url: location.href, timeOrigin: performance.timeOrigin })") as { url?: string; timeOrigin?: number };
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" }, sessionId);
        let releaseNeeded = true;
        try {
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount, pointerType: "mouse" }, sessionId);
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount, pointerType: "mouse" }, sessionId);
          releaseNeeded = false;
        } finally {
          if (releaseNeeded) {
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount, pointerType: "mouse" }, sessionId).catch(() => {});
          }
        }
        await waitForClickNavigation(sessionId, beforeInput);
        const landedOrigin = await originOf(sessionId);
        const landedUrl = await urlOf(sessionId);
        return reply(command.id, true, { data: { ...clickPlan.data, clicked: true, trustedInput: "cdp-headless-benchmark" } }, landedOrigin, landedUrl);
      }

      const call = command.action === "read"
        ? `m9rPageRead(${JSON.stringify(command.selector ?? null)}, ${JSON.stringify(command.expectOrigin ?? null)}, ${JSON.stringify(command.expectPathPrefix ?? null)})`
        : command.action === "snapshot"
          ? `m9rPageSnapshot(${JSON.stringify(command.args?.query ?? null)}, ${JSON.stringify(command.args?.limit ?? null)})`
        : `m9rPageType(${JSON.stringify(command.selector)}, ${JSON.stringify(command.text)}, ${JSON.stringify(command.expectOrigin ?? null)}, ${JSON.stringify(command.expectPathPrefix ?? null)})`;
      const result = (await evaluate(sessionId, `${pageActions}\n;${call}`)) as { ok: boolean; data?: unknown; error?: string };
      return reply(command.id, result.ok, result, await originOf(sessionId), await urlOf(sessionId));
    } catch (error) {
      return reply(command.id, false, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  broker.on("message", (data) => {
    const message = JSON.parse(String(data)) as { type?: string };
    if (message.type === "command") void handle(message as never);
  });

  return {
    async close() {
      broker.terminate();
      cdp.socket.terminate();
      if (process.platform === "win32" && chrome.process.pid) spawnSync("taskkill", ["/pid", String(chrome.process.pid), "/T", "/F"], { stdio: "ignore" });
      else chrome.process.kill();
      await sleep(300);
      try {
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Chrome may still hold files briefly; the temp folder is harmless
      }
    },
  };
}
