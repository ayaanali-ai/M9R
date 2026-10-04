/** C1: persistent, agent-owned Chrome. Only this process's profile and CDP socket are controlled. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { dragChrome } from "./agent-chrome-input";

export interface BrowserTransport {
  ready(): boolean;
  send(message: unknown): boolean;
  subscribe(receive: (message: unknown) => void, disconnected: () => void): () => void;
  close(): Promise<void>;
}

export function approvedSite(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin === "null") {
    throw new Error("Use an HTTP(S) site URL without credentials.");
  }
  return url.origin;
}

/** A fixed private subtree, never a caller-selected Chrome user-data directory. Reject linked directories. */
export function agentChromePaths(root: string) {
  const absolute = resolve(root);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (lstatSync(absolute).isSymbolicLink() || realpathSync(absolute).toLowerCase() !== absolute.toLowerCase()) {
    throw new Error("The agent Chrome directory must be a real directory, not a link.");
  }
  const profile = join(absolute, "chrome-profile");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (lstatSync(profile).isSymbolicLink() || realpathSync(profile).toLowerCase() !== profile.toLowerCase()) {
    throw new Error("The agent Chrome profile must not be a link.");
  }
  return { root: absolute, profile, sites: join(absolute, "approved-sites.json"), lock: join(absolute, "chrome-launch.lock") };
}

export function readApprovedSites(root: string): string[] {
  const path = agentChromePaths(root).sites;
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Invalid site settings file.");
    const state: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(state) || state.length > 256 || state.some((site) => typeof site !== "string" || approvedSite(site) !== site)) {
      throw new Error("Invalid approved-site settings; refusing browser access.");
    }
    return state as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Called only by the human CLI approval flow. The transport has no grant-writing command. */
export function changeApprovedSite(root: string, site: string, approved: boolean): string[] {
  const origin = approvedSite(site);
  const sites = readApprovedSites(root).filter((entry) => entry !== origin);
  if (approved) sites.push(origin);
  if (sites.length > 256) throw new Error("Too many approved sites.");
  writeFileSync(agentChromePaths(root).sites, JSON.stringify(sites.sort(), null, 2) + "\n", { mode: 0o600 });
  return sites;
}

function findChrome(): string {
  const candidates = process.platform === "win32" ? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error("Google Chrome was not found. Install Chrome before starting the agent browser.");
  return executable;
}

class CdpConnection {
  private seq = 0;
  private events = new Set<(event: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void>();
  private pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.method) { for (const listener of this.events) listener(response); return; }
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id); clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(String(response.error.message)));
        else pending.resolve(response.result ?? {});
      } catch { /* malformed browser frame is ignored */ }
    });
    socket.on("close", () => this.fail());
    socket.on("error", () => this.fail());
  }
  static async connect(endpoint: string): Promise<CdpConnection> {
    const socket = new WebSocket(endpoint, { maxPayload: 4 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("Chrome connection timed out.")); }, 10_000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new Error("Chrome connection failed.")); });
    });
    return new CdpConnection(socket);
  }
  ready() { return this.socket.readyState === WebSocket.OPEN; }
  onClose(listener: () => void) { this.socket.once("close", listener); }
  onEvent(listener: (event: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void) {
    this.events.add(listener); return () => { this.events.delete(listener); };
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (!this.ready()) return Promise.reject(new Error("Agent Chrome disconnected."));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome ${method} timed out.`)); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (error) { this.pending.delete(id); clearTimeout(timer); reject(new Error("Chrome command could not be sent.")); }
      });
    });
  }
  close() { this.fail(); this.socket.close(); }
  private fail() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Agent Chrome disconnected.")); }
    this.pending.clear();
  }
}

interface Command { type: string; id?: string; action?: string; tab?: string; url?: string; selector?: string; endSelector?: string; args?: { destination?: string }; text?: string; expectOrigin?: string; expectPathPrefix?: string }
interface Tab { targetId: string; sessionId: string }
interface PageResult { ok: boolean; error?: string; data?: unknown }

export async function launchAgentChrome(options: { root: string; pageActionsSource: string; chromeExecutable?: string }): Promise<BrowserTransport & { profile: string; pid: number }> {
  const paths = agentChromePaths(options.root);
  // A crash may leave a dead owner lock. Never kill or adopt another running Chrome process.
  try {
    const lockedPid = Number(readFileSync(paths.lock, "utf8"));
    if (!Number.isInteger(lockedPid) || lockedPid < 1) throw new Error("Invalid Chrome launch lock; inspect it before restarting.");
    try { process.kill(lockedPid, 0); throw new Error("The agent Chrome channel is already running."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    rmSync(paths.lock);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  writeFileSync(paths.lock, String(process.pid), { flag: "wx", mode: 0o600 });
  let child: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  const listeners = new Set<{ receive(message: unknown): void; disconnected(): void }>();
  let stopped = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const releaseLock = () => { try { if (readFileSync(paths.lock, "utf8") === String(process.pid)) rmSync(paths.lock); } catch { /* already removed */ } };
  try {
    const portFile = join(paths.profile, "DevToolsActivePort");
    // Delete only stale discovery metadata in our fixed subtree; never profile/login data.
    rmSync(portFile, { force: true });
    child = spawn(options.chromeExecutable ?? findChrome(), [
      `--user-data-dir=${paths.profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank",
      "--disable-gpu",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    ], { stdio: "ignore", windowsHide: false });
    let launchError: Error | undefined;
    child.once("error", (error) => { launchError = error; });
    let endpoint = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error("Agent Chrome exited during launch.");
      try {
        const [port, path] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536 && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(path)) {
          endpoint = `ws://127.0.0.1:${port}${path}`; break;
        }
      } catch { /* Chrome is still starting */ }
      await delay(50);
    }
    if (!endpoint) throw new Error("Agent Chrome did not publish its private debug endpoint.");
    cdp = await CdpConnection.connect(endpoint);
    const connection = cdp;
    const tabs = new Map<string, Tab>();
    const queues = new Map<string, Promise<void>>();
    connection.onClose(() => { closed = true; for (const listener of listeners) listener.disconnected(); });

    async function world(tab: Tab): Promise<number> {
      const tree = await connection.send("Page.getFrameTree", {}, tab.sessionId) as { frameTree: { frame: { id: string } } };
      const context = await connection.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "m9r-agent-chrome" }, tab.sessionId);
      return Number(context.executionContextId);
    }
    async function evaluate(tab: Tab, expression: string): Promise<unknown> {
      const result = await connection.send("Runtime.evaluate", { expression, contextId: await world(tab), returnByValue: true, awaitPromise: true }, tab.sessionId) as {
        result?: { value?: unknown }; exceptionDetails?: unknown;
      };
      if (result.exceptionDetails) throw new Error("Agent Chrome page inspection failed.");
      return result.result?.value;
    }
    async function location(tab: Tab): Promise<string> { return String(await evaluate(tab, "location.href")); }
    function allowed(url: string, command: Command) {
      const origin = approvedSite(url);
      if (!readApprovedSites(paths.root).includes(origin)) throw new Error("Site not approved. Ask the owner to run: m9r web chrome approve <site-url>.");
      if (command.expectOrigin && origin !== command.expectOrigin) throw new Error("The page left the granted site.");
      if (command.expectPathPrefix) {
        const prefix = command.expectPathPrefix;
        const path = new URL(url).pathname;
        if (prefix !== "/" && path !== prefix && !path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")) throw new Error("The page left the granted path.");
      }
      if (closed || stopped) throw new Error("Agent Chrome work was stopped.");
    }
    async function pageAction(tab: Tab, expression: string): Promise<PageResult> {
      return await evaluate(tab, options.pageActionsSource + "\n" + expression) as PageResult;
    }
    async function execute(command: Command): Promise<void> {
      const tabName = command.tab ?? "shared";
      let tab = tabs.get(tabName);
      let url: string | undefined;
      let result: PageResult;
      try {
        if (closed || stopped) throw new Error("Agent Chrome work was stopped.");
        if (!["open", "read", "snapshot", "click", "type", "drag"].includes(command.action ?? "")) throw new Error("This Chrome channel supports open, read, snapshot, click, type and drag only.");
        if (command.action === "open") {
          allowed(command.url ?? "", command);
          if (!tab) {
            const target = await connection.send("Target.createTarget", { url: "about:blank" });
            const attached = await connection.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            tab = { targetId: String(target.targetId), sessionId: String(attached.sessionId) };
            tabs.set(tabName, tab);
          }
          await connection.send("Page.enable", {}, tab.sessionId);
          const navigation = await connection.send("Page.navigate", { url: command.url }, tab.sessionId);
          if (navigation.errorText) throw new Error("Chrome could not navigate to the approved page.");
          let loaded = false;
          let lastReady = "unavailable";
          let navigationCommitted = false;
          for (let attempt = 0; attempt < 300; attempt++) {
            if (stopped || closed) throw new Error("Agent Chrome work was stopped.");
            try {
              const state = await evaluate(tab, "({url: location.href, ready: document.readyState})") as { url: string; ready: string };
              const tree = await connection.send("Page.getFrameTree", {}, tab.sessionId) as { frameTree: { frame: { loaderId?: string } } };
              lastReady = state.ready;
              navigationCommitted = !navigation.loaderId || tree.frameTree.frame.loaderId === navigation.loaderId;
              if (navigationCommitted && state.url !== "about:blank" && ["interactive", "complete"].includes(state.ready)) { allowed(state.url, command); url = state.url; loaded = true; break; }
            } catch (error) { if (/Site not approved|granted|stopped/.test(String(error))) throw error; }
            await delay(50);
          }
          if (!loaded) throw new Error(`The approved page did not finish loading (document: ${lastReady}, navigation committed: ${navigationCommitted}).`);
          result = { ok: true, data: { tab: tabName, url, route: "agent-chrome" } };
        } else {
          if (!tab) throw new Error("Open a page in this Chrome channel first.");
          url = await location(tab); allowed(url, command);
          const origin = approvedSite(url);
          if (command.action === "read") {
            result = await pageAction(tab, `m9rPageRead(${JSON.stringify(command.selector ?? null)}, ${JSON.stringify(origin)}, ${JSON.stringify(command.expectPathPrefix ?? null)})`);
          } else if (command.action === "snapshot") {
            result = await pageAction(tab, "m9rPageSnapshot(null,80)");
          } else if (command.action === "drag") {
            const destination = command.endSelector ?? command.args?.destination;
            if (!command.selector || !destination) throw new Error("Drag needs source and destination selectors or refs.");
            const plan = async (selector: string) => {
              const value = await pageAction(tab!, `m9rPageClickPlan(${JSON.stringify(selector)}, ${JSON.stringify(origin)}, ${JSON.stringify(command.expectPathPrefix ?? null)}, null, null, 'left', 1, 'click')`);
              if (!value.ok) throw new Error(value.error ?? "Drag target unavailable.");
              return value.data as { x: number; y: number };
            };
            // Plan destination first: any scroll it causes must settle before source coordinates are chosen.
            const to = await plan(destination);
            const from = await plan(command.selector);
            const hit = async (selector: string, point: { x: number; y: number }) => evaluate(tab!, `(() => {
              const selector=${JSON.stringify(selector)};
              const el=selector.startsWith('@m9r-ref:') ? window.__m9rPageActionRefMap?.get(selector.slice(9)) : document.querySelector(selector);
              const hit=document.elementFromPoint(${point.x},${point.y});
              return !!el && el.isConnected && !el.disabled && (el===hit || el.contains(hit));
            })()`);
            if (!await hit(command.selector, from) || !await hit(destination, to)) throw new Error("Both drag targets must be visible in the same viewport.");
            // Keep background rendering active without Target.activateTarget or Page.bringToFront.
            await connection.send("Emulation.setFocusEmulationEnabled", { enabled: true }, tab.sessionId);
            await dragChrome({
              send: (method, params) => connection.send(method, params, tab!.sessionId),
              onDrag: (listener) => connection.onEvent((event) => {
                if (event.sessionId === tab!.sessionId && event.method === "Input.dragIntercepted" && event.params?.data) listener(event.params.data as Record<string, unknown>);
              }),
              check: async () => { const current = await location(tab!); allowed(current, command); if (current !== url) throw new Error("The page changed during drag."); },
            }, from, to);
            result = { ok: true, data: { route: "agent-chrome", delivery: "cdp", dragged: true } };
          } else {
            const plan = await pageAction(tab, `m9rPageClickPlan(${JSON.stringify(command.selector)}, ${JSON.stringify(origin)}, ${JSON.stringify(command.expectPathPrefix ?? null)}, null, null, 'left', 1, 'click')`);
            if (!plan.ok) throw new Error(plan.error ?? "Target is unavailable.");
            const point = plan.data as { x: number; y: number; name: string };
            if (command.action === "type") {
              // Resolve only a selector/ref; never evaluate an agent's JavaScript. Password/card/OTP fields stay off limits.
              const prepared = await evaluate(tab, `(() => {
                const selector = ${JSON.stringify(command.selector)};
                const ref = typeof selector === 'string' && selector.startsWith('@m9r-ref:') ? selector.slice(9) : null;
                const el = ref ? window.__m9rPageActionRefMap?.get(ref) : document.querySelector(selector);
                if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
                const type = String(el.type || '').toLowerCase();
                const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
                if (type === 'password' || type === 'hidden' || autocomplete.some(v => v.startsWith('cc-') || ['one-time-code','current-password','new-password'].includes(v))) return false;
                if (!['INPUT','TEXTAREA'].includes(el.tagName) && !el.isContentEditable) return false;
                el.focus();
                window.__m9rTypingTarget = el;
                if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
                else el.select();
                return document.activeElement === el;
              })()`);
              if (!prepared) throw new Error("Typing target is not editable or is sensitive.");
              const current = await location(tab); allowed(current, command);
              if (current !== url) throw new Error("The page changed before typing.");
              if (!await evaluate(tab, "document.activeElement === window.__m9rTypingTarget && window.__m9rTypingTarget?.isConnected")) throw new Error("Typing focus changed before input.");
              await connection.send("Input.insertText", { text: command.text ?? "" }, tab.sessionId);
            } else {
              // Replan against the hit target after scroll/layout settles and recheck the site immediately before input.
              const current = await location(tab); allowed(current, command);
              if (current !== url) throw new Error("The page changed before clicking.");
              const validation = await evaluate(tab, `(() => {
                const selector = ${JSON.stringify(command.selector)};
                const el = selector?.startsWith('@m9r-ref:') ? window.__m9rPageActionRefMap?.get(selector.slice(9)) : document.querySelector(selector);
                const hit = document.elementFromPoint(${point.x}, ${point.y});
                return !!el && el.isConnected && !el.disabled && (el === hit || el.contains(hit));
              })()`);
              if (!validation) throw new Error("The click target changed before input.");
              await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, tab.sessionId);
              if (stopped || closed) throw new Error("Agent Chrome work was stopped.");
              await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, tab.sessionId);
              await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, tab.sessionId);
            }
            result = { ok: true, data: { route: "agent-chrome", delivery: "cdp", label: point.name } };
          }
          const current = await location(tab); allowed(current, command); url = current;
        }
      } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : "Agent Chrome action failed." }; }
      finally {
        if (tab && command.action === "drag") await connection.send("Emulation.setFocusEmulationEnabled", { enabled: false }, tab.sessionId).catch(() => undefined);
      }
      for (const listener of listeners) listener.receive({ type: "result", id: command.id, ...result!, ...(url ? { origin: new URL(url).origin, url } : {}) });
    }
    const transport = {
      profile: paths.profile, pid: child.pid!,
      ready: () => !closed && connection.ready(),
      subscribe(receive: (message: unknown) => void, disconnected: () => void) {
        const listener = { receive, disconnected }; listeners.add(listener); return () => { listeners.delete(listener); };
      },
      send(raw: unknown): boolean {
        if (!raw || typeof raw !== "object" || closed) return false;
        const command = raw as Command;
        if (command.type === "stop-all") { stopped = true; return true; }
        if (command.type !== "command") return true;
        const tab = command.tab ?? "shared";
        const next = (queues.get(tab) ?? Promise.resolve()).then(() => execute(command));
        queues.set(tab, next);
        void next.finally(() => { if (queues.get(tab) === next) queues.delete(tab); }).catch(() => undefined);
        return true;
      },
      close(): Promise<void> {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          stopped = true;
          // Graceful close flushes Chrome's own login/profile state; no cookie extraction or profile deletion.
          try { if (connection.ready()) await connection.send("Browser.close"); } catch { /* Chrome can close the socket before its reply */ }
          connection.close(); closed = true;
          if (child && child.exitCode === null) {
            await Promise.race([new Promise<void>((done) => child!.once("exit", () => done())), delay(2_000)]);
            if (child.exitCode === null) child.kill();
          }
          releaseLock();
        })();
        return closePromise;
      },
    };
    return transport;
  } catch (error) { cdp?.close(); child?.kill(); releaseLock(); throw error; }
}
