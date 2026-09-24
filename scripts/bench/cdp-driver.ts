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

class Cdp {
  nextId = 0;
  waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string } };
      const entry = message.id === undefined ? undefined : this.waiting.get(message.id);
      if (!entry || message.id === undefined) return;
      this.waiting.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`DevTools call ${method} did not answer within 15s`));
      }, 15_000);
      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

function launchChrome(chromePath: string, profileDir: string): Promise<{ process: ChildProcess; endpoint: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      chromePath,
      ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const timer = setTimeout(() => reject(new Error("Chrome did not report a DevTools endpoint in time")), 20_000);
    let buffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve({ process: child, endpoint: match[1] });
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
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
  const cdp = new Cdp(await openSocket(chrome.endpoint));
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
    await cdp.send("Page.navigate", { url }, sessionId);
    for (let i = 0; i < 200; i++) {
      if ((await evaluate(sessionId, "document.readyState")) === "complete" && (await evaluate(sessionId, "location.href")) !== "about:blank") return;
      await sleep(25);
    }
    throw new Error("page did not finish loading");
  }

  const broker = await connectBenchBroker(options.brokerPort);
  const reply = (id: string, ok: boolean, payload: { data?: unknown; error?: string }, origin?: string | null, url?: string | null) =>
    broker.send(JSON.stringify({ type: "result", id, ok, data: payload.data, error: payload.error, origin: origin ?? undefined, url: url ?? undefined }));

  async function handle(command: { id: string; action: string; tab: string; url?: string; selector?: string; text?: string; expectOrigin?: string; expectPathPrefix?: string }) {
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

      const call =
        command.action === "read"
          ? `m9rPageRead(${JSON.stringify(command.selector ?? null)}, ${JSON.stringify(command.expectOrigin ?? null)}, ${JSON.stringify(command.expectPathPrefix ?? null)})`
          : command.action === "click"
            ? `m9rPageClick(${JSON.stringify(command.selector)}, ${JSON.stringify(command.expectOrigin ?? null)}, ${JSON.stringify(command.expectPathPrefix ?? null)})`
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
