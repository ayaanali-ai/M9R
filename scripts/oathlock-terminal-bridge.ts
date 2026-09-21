import { createServer } from "node:http";
import { open, readFile, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import * as pty from "node-pty";
import chokidar from "chokidar";
import { WebSocket, WebSocketServer } from "ws";
import { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, MAX_BRIDGE_MESSAGE_BYTES, authorizeUpgrade, parseClientMessage } from "../src/lib/local-terminal-bridge-core";
import { createTerminalSessionManager, type PtyFactory } from "../src/lib/local-terminal-session-manager";
import { parseResidentActivityLine, residentActivityJournalPath } from "../src/lib/resident-activity-journal";
import { isTerminalProvider, type TerminalProvider } from "../src/lib/local-terminal-protocol";
import { renderLocalProviderWorkspace } from "../src/lib/local-provider-workspace-page";
import { parseProviderAdapterConfig } from "../src/lib/provider-adapter-config";
import { createResidentSupervisor } from "../src/lib/resident-supervisor";
import { spawn } from "node:child_process";

const repositoryRoot = process.cwd();
const localOnlyRuntime = process.env.M9R_LOCAL_ONLY === "1";
const host = DEFAULT_BRIDGE_HOST;
const requestedPort = Number.parseInt(process.env.OATHLOCK_BRIDGE_PORT ?? "", 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535 ? requestedPort : DEFAULT_BRIDGE_PORT;
// The hosted app never receives a terminal WebSocket. It embeds the local
// workspace document below, and the browser's same-origin policy keeps the
// hosted page from reading or injecting terminal traffic. Only local origins
// may upgrade to a shell-bearing socket.
const allowedOrigins = (process.env.OATHLOCK_BRIDGE_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000,http://127.0.0.1:43117")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
const require = createRequire(import.meta.url);
const xtermScriptPath = require.resolve("@xterm/xterm");
const xtermCssPath = resolve(dirname(xtermScriptPath), "..", "css", "xterm.css");
const fitAddonScriptPath = require.resolve("@xterm/addon-fit");

function providerFromProtocols(protocols: string[]): TerminalProvider | null {
  const value = protocols.find((protocol) => protocol.startsWith("oathlock-provider."))?.slice("oathlock-provider.".length);
  return isTerminalProvider(value) ? value : null;
}

function powershellArg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function localAdapterCommand(provider: string): Promise<string | undefined> {
  if (["codex", "claude-code", "opencode"].includes(provider)) return undefined;
  try {
    const raw = JSON.parse(await readFile(resolve(repositoryRoot, ".oathlock", "agents", provider, "adapter.json"), "utf8")) as unknown;
    const parsed = parseProviderAdapterConfig(raw, provider);
    if (!parsed.ok) return undefined;
    return [parsed.value.command, ...parsed.value.args].map(powershellArg).join(" ");
  } catch {
    return undefined;
  }
}

const ptyFactory: PtyFactory = { spawn: (command, args, options) => pty.spawn(command, [...args], options) };
let broadcastSessions = () => {};
const sessions = createTerminalSessionManager({ repositoryRoot, ptyFactory, onSessionsChanged: () => broadcastSessions() });
const clientAuthorization = new Map<WebSocket, TerminalProvider>();
const residentJournal = residentActivityJournalPath(repositoryRoot);
let residentJournalOffset = 0;
let residentJournalRemainder = "";
let consumingResidentJournal = false;
let residentJournalInitialized = false;

async function consumeResidentJournal(): Promise<void> {
  if (consumingResidentJournal) return;
  consumingResidentJournal = true;
  try {
    const size = await stat(residentJournal).then((value) => value.size).catch(() => 0);
    if (!residentJournalInitialized) {
      residentJournalOffset = Math.max(0, size - 1024 * 1024);
      residentJournalInitialized = true;
    }
    if (size < residentJournalOffset) {
      residentJournalOffset = 0;
      residentJournalRemainder = "";
    }
    if (size === residentJournalOffset) return;
    const length = size - residentJournalOffset;
    const file = await open(residentJournal, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, residentJournalOffset);
      residentJournalOffset += bytesRead;
      const lines = `${residentJournalRemainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
      residentJournalRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = parseResidentActivityLine(line);
        if (event) sessions.observe(event);
      }
    } finally {
      await file.close();
    }
  } finally {
    consumingResidentJournal = false;
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && requestUrl.pathname === "/workspace") {
    const provider = requestUrl.searchParams.get("provider");
    if (!isTerminalProvider(provider)) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Unsupported provider.");
      return;
    }
    const nonce = randomBytes(18).toString("base64url");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; connect-src ws://${host}:${port}; frame-ancestors https://app.m9r.workers.dev https://oathlock.vercel.app http://localhost:3000 http://127.0.0.1:3000; base-uri 'none'; form-action 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    const providerCommand = await localAdapterCommand(provider);
    response.end(renderLocalProviderWorkspace(provider, nonce, port, providerCommand));
    return;
  }
  if (request.method === "GET" && (requestUrl.pathname === "/assets/xterm.js" || requestUrl.pathname === "/assets/xterm.css" || requestUrl.pathname === "/assets/addon-fit.js")) {
    const isCss = requestUrl.pathname.endsWith(".css");
    const assetPath = requestUrl.pathname === "/assets/addon-fit.js" ? fitAddonScriptPath : isCss ? xtermCssPath : xtermScriptPath;
    void readFile(assetPath).then((asset) => {
      response.writeHead(200, {
        "content-type": isCss ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400, immutable",
        "x-content-type-options": "nosniff",
      });
      response.end(asset);
    }).catch(() => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Runtime asset unavailable.");
    });
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.includes(origin)) response.setHeader("access-control-allow-origin", origin);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, protocol: BRIDGE_PROTOCOL_VERSION, repositoryBound: true, providers: sessions.list().map((session) => session.provider).filter((value, index, all) => all.indexOf(value) === index), sessions: sessions.list().length }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: "Not found." }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_MESSAGE_BYTES, perMessageDeflate: false });
broadcastSessions = () => {
  for (const client of wss.clients) {
    const authorization = clientAuthorization.get(client);
    if (!authorization) continue;
    send(client, {
      type: "sessions",
      sessions: sessions.listFor(authorization),
    });
  }
};

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (url.pathname !== "/terminal") return socket.destroy();
  const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const authorization = authorizeUpgrade({ origin: request.headers.origin, protocols, allowedOrigins });
  const provider = providerFromProtocols(protocols);
  if (!authorization.ok || !provider) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (ws, request) => {
  const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const connectionProvider = providerFromProtocols(protocols);
  if (!connectionProvider) return ws.close(1008, "Provider authorization missing");
  clientAuthorization.set(ws, connectionProvider);
  const detachBySession = new Map<string, () => void>();
  send(ws, {
    type: "ready",
    protocol: BRIDGE_PROTOCOL_VERSION,
    sessions: sessions.listFor(connectionProvider),
  });

  function attach(sessionId: string): void {
    detachBySession.get(sessionId)?.();
    detachBySession.set(sessionId, sessions.attach(sessionId, (event) => send(ws, event)));
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return send(ws, { type: "error", error: "Binary terminal messages are not supported." });
    try {
      const message = parseClientMessage(raw.toString());
      switch (message.type) {
        case "list": send(ws, { type: "sessions", sessions: sessions.listFor(connectionProvider) }); break;
        case "spawn": {
          if (message.provider !== connectionProvider) throw new Error("This connection cannot launch another provider.");
          const session = sessions.spawn(message);
          attach(session.id);
          send(ws, { type: "spawned", session: sessions.list().find((item) => item.id === session.id) });
          break;
        }
        case "attach": sessions.requireProvider(message.sessionId, connectionProvider); attach(message.sessionId); send(ws, { type: "attached", sessionId: message.sessionId }); break;
        case "input": sessions.requireProvider(message.sessionId, connectionProvider); sessions.write(message.sessionId, message.data); break;
        case "resize": sessions.requireProvider(message.sessionId, connectionProvider); sessions.resize(message.sessionId, message.cols, message.rows); break;
        case "report-state":
          sessions.requireProvider(message.sessionId, connectionProvider);
          sessions.reportState(message.sessionId, message.state);
          send(ws, { type: "state-recorded", sessionId: message.sessionId, state: message.state });
          break;
        case "close": sessions.requireProvider(message.sessionId, connectionProvider); sessions.close(message.sessionId); break;
      }
    } catch (error) {
      send(ws, { type: "error", error: error instanceof Error ? error.message : "Terminal bridge request failed." });
    }
  });
  ws.on("close", () => { clientAuthorization.delete(ws); for (const detach of detachBySession.values()) detach(); detachBySession.clear(); });
});

const heartbeat = setInterval(() => { for (const client of wss.clients) client.ping(); }, 30_000);
heartbeat.unref();
const residentJournalPoll = setInterval(() => { void consumeResidentJournal(); }, 250);
residentJournalPoll.unref();
void consumeResidentJournal();

let missionBridgeSupervisor: ReturnType<typeof createResidentSupervisor> | null = null;
let missionBridgeSyncTimer: ReturnType<typeof setInterval> | null = null;
let reconnectPollTimer: ReturnType<typeof setInterval> | null = null;

function shutdown(): void {
  clearInterval(heartbeat);
  clearInterval(residentJournalPoll);
  sessions.shutdown();
  if (missionBridgeSyncTimer) clearInterval(missionBridgeSyncTimer);
  missionBridgeSyncTimer = null;
  if (reconnectPollTimer) clearInterval(reconnectPollTimer);
  reconnectPollTimer = null;
  missionBridgeSupervisor?.stop();
  for (const client of wss.clients) client.close(1001, "Bridge shutting down");
  wss.close();
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Starting the runtime is intentionally idempotent. `init` and the Watchfloor
// may both attempt to ensure it is running; a second invocation must report
// that state cleanly instead of surfacing Node's unhandled EADDRINUSE error.
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    process.stdout.write(`M9R local runtime is already running on ${host}:${port}.\n`);
    process.exit(0);
  }
  process.stderr.write(`M9R local runtime failed to start: ${error.message}\n`);
  process.exit(1);
});

server.listen(port, host, () => {
  process.stdout.write([
    "M9R local runtime is running.",
    `Repository: ${repositoryRoot}`,
    `Endpoint: ws://${host}:${port}/terminal`,
    "Raw terminal output stays local unless you explicitly submit redacted evidence.",
    "Press Ctrl+C to stop the bridge and its terminal sessions.",
    "",
  ].join("\n"));
});

// Best-effort, and deliberately SEPARATE processes rather than an in-process
// import: local-mission-bridge-runner.ts (and the whole ACP/relay tree
// under it) is now ALSO packaged into the minimal, hand-bundled `cli/`
// distributable (build-cli.mjs's explicit file whitelist) -- previously it
// was excluded, so a real npx-installed user got the raw terminal bridge
// but never autonomous mention-triggered work at all. Two contexts, same
// sibling-file layout, different launch, exactly like
// acp-stdio-adapter.ts's devMcpServerDescriptor: the monorepo runs this
// file as .ts via tsx with local-mission-bridge-runner.ts right next to it
// in src/lib/bridge/; the packaged CLI flattens both into cli/dist/*.js,
// already-compiled, no tsx in the package. import.meta.url's own extension
// tells us which.
//
// One child process PER connected provider, not one for whichever token
// happens to be found first -- confirmed live tonight that a human had to
// manually spawn a separate `terminal runtime` per agent, hiding the other
// providers' token files to force each one to bind correctly, just to get
// more than one agent listening at once. That is not a real product
// experience; a user connecting three agents must get three real, live,
// automatically-started bridges the moment this command runs, same as
// connecting one. Each child gets OATHLOCK_LOCAL_MISSION_BRIDGE_PROVIDER
// pinned in its own real env (a real OS process, not shared in-process
// state) so it only ever binds to that one provider's token --
// startMissionBridge sets process.env.OATHLOCK_AGENT_TOKEN globally, so
// running more than one provider inside a single process would make later
// sessions silently post using an earlier provider's identity.
//
// Discovery here is intentionally self-contained (no import from
// local-mission-bridge-bootstrap.ts) to keep this file's own dependency
// tree free of the Mission/ACP chain -- it only needs to know WHICH
// provider directories exist, not read their tokens.
const LOCAL_PROVIDER_NAMES = ["claude-code", "codex", "opencode"] as const;
async function connectedLocalProviders(): Promise<string[]> {
  const found: string[] = [];
  for (const provider of LOCAL_PROVIDER_NAMES) {
    try {
      const raw = await readFile(resolve(repositoryRoot, ".oathlock", "agents", provider, "local.json"), "utf8");
      const parsed = JSON.parse(raw) as { token?: string };
      if (typeof parsed.token === "string" && parsed.token.trim()) found.push(provider);
    } catch {
      // Not connected under this provider name.
    }
  }
  return found;
}

/** First connected provider's token -- reconnect is workspace-scoped, not provider-specific, so any one of them can poll for it. */
async function anyConnectedProviderToken(): Promise<string | null> {
  for (const provider of LOCAL_PROVIDER_NAMES) {
    try {
      const raw = await readFile(resolve(repositoryRoot, ".oathlock", "agents", provider, "local.json"), "utf8");
      const parsed = JSON.parse(raw) as { token?: string };
      if (typeof parsed.token === "string" && parsed.token.trim()) return parsed.token.trim();
    } catch {
      // Not connected under this provider name.
    }
  }
  return null;
}

const reconnectMarkerPath = resolve(repositoryRoot, ".oathlock", "reconnect-handled.json");
const appUrl = (process.env.OATHLOCK_API_URL ?? "https://app.m9r.workers.dev").replace(/\/+$/, "");

/**
 * Poll target for a dashboard "reconnect my agents" click. This is the piece
 * that makes that button real rather than a no-op: it's the only place in
 * the always-alive terminal runtime process that talks to the hosted app on
 * its own initiative, so it's the only thing that COULD notice a remote
 * request and act on it. A bridge that exhausted its restart budget
 * (state "failed") stays that way forever otherwise -- nothing local was
 * ever going to un-stick it without a human restarting the whole process.
 */
async function checkReconnectRequest(): Promise<void> {
  const token = await anyConnectedProviderToken();
  if (!token) return;
  let response: Response;
  try {
    response = await fetch(`${appUrl}/api/agent/bridge-commands`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return;
  }
  if (!response.ok) return;
  const body = await response.json().catch(() => null) as { reconnectRequestedAt?: string | null } | null;
  const requestedAt = body?.reconnectRequestedAt;
  if (!requestedAt) return;

  let lastHandled: string | null = null;
  try { lastHandled = (JSON.parse(await readFile(reconnectMarkerPath, "utf8")) as { lastHandled?: string }).lastHandled ?? null; } catch { /* first run */ }
  if (lastHandled && Date.parse(lastHandled) >= Date.parse(requestedAt)) return;

  process.stdout.write(`[reconnect] handling a remote reconnect request from ${requestedAt}.\n`);
  const retried = missionBridgeSupervisor?.retryFailed() ?? [];
  const providers = await connectedLocalProviders();
  missionBridgeSupervisor?.syncProfiles(providers);
  try {
    await mkdir(dirname(reconnectMarkerPath), { recursive: true });
    await open(reconnectMarkerPath, "w").then((handle) => handle.writeFile(JSON.stringify({ lastHandled: requestedAt })).finally(() => handle.close()));
  } catch { /* best-effort marker; a missed write just means this fires again next poll, which is harmless */ }
  // Best-effort report-back so the dashboard button can say something real
  // instead of a blind "Requested" that never learns whether anything
  // actually happened -- a dropped report just means the next poll's own
  // report (or a human refreshing) is the only feedback, same failure mode
  // every other best-effort call in this file already accepts.
  const summary = retried.length > 0 ? `Retried ${retried.length} stuck agent${retried.length === 1 ? "" : "s"}: ${retried.join(", ")}.` : "No stuck agents found on this machine.";
  try {
    await fetch(`${appUrl}/api/agent/bridge-commands`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ handledAt: new Date().toISOString(), summary }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* best-effort; the dashboard's poll simply times out and says so honestly */ }
}

/**
 * Live file presence: the honest fix for a real gap found live -- a file
 * deleted or changed any way OTHER than an agent's own reported tool call
 * (a human editing directly, `git checkout`, anything) used to leave
 * workspace_file_activity's last row unchanged, so the Files rail and Live
 * Code kept showing it as current forever with no indication it was gone.
 * This is the one per-machine resident process that already knows the real
 * repository root, so it's the only place that COULD know this honestly.
 *
 * Deliberately excludes common noise directories rather than trying to
 * respect the repo's actual .gitignore -- correctness there would need a
 * real gitignore parser and nested-.gitignore handling; a fixed denylist of
 * the directories that are noise in virtually every JS/TS repo is simpler
 * and covers the case that actually matters (build output and dependency
 * trees, not a project's own bespoke ignore rules).
 */
const FILE_WATCH_IGNORE_SEGMENTS = new Set([".git", "node_modules", ".next", ".oathlock", "dist", "cli"]);
function isIgnoredWatchPath(absolutePath: string): boolean {
  const rel = relative(repositoryRoot, absolutePath);
  return rel.split(sep).some((segment) => FILE_WATCH_IGNORE_SEGMENTS.has(segment));
}

/** Binary/huge files never get their content read into newText -- Live Code
 * is for source text, and a multi-megabyte or binary blob has no business
 * being shipped through the relay as if it were reviewable file content. */
const MAX_WATCHED_FILE_BYTES = 256 * 1024;
async function readWatchedFileText(absolutePath: string): Promise<string | null> {
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile() || stats.size > MAX_WATCHED_FILE_BYTES) return null;
    const buffer = await readFile(absolutePath);
    if (buffer.subarray(0, 1024).includes(0)) return null; // a NUL byte this early means binary, not text
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

interface PendingFileWatchEvent { filePath: string; activityKind: "create" | "changed" | "delete"; newText?: string | null }
const pendingFileWatchEvents = new Map<string, PendingFileWatchEvent>();
let fileWatchFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** Batches a burst of disk events (a branch checkout can touch hundreds of
 * files at once) into one request instead of one HTTP call per file --
 * same reasoning as any other debounced reporter in this codebase. Keyed by
 * path, so a rapid create-then-edit of the same file collapses into its
 * final state rather than reporting a stale intermediate one. */
function scheduleFileWatchFlush(): void {
  if (fileWatchFlushTimer) return;
  fileWatchFlushTimer = setTimeout(() => {
    fileWatchFlushTimer = null;
    void flushFileWatchEvents();
  }, 700);
  fileWatchFlushTimer.unref?.();
}

async function flushFileWatchEvents(): Promise<void> {
  if (pendingFileWatchEvents.size === 0) return;
  const events = [...pendingFileWatchEvents.values()];
  pendingFileWatchEvents.clear();
  const token = await anyConnectedProviderToken();
  if (!token) return; // No connected provider yet to authenticate as -- retried on the next real disk event, never queued indefinitely.
  try {
    await fetch(`${appUrl}/api/agent/file-watch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort, same posture as checkReconnectRequest -- a dropped batch
    // just means this tick's disk events aren't reported; the file's own
    // next real change (or this same one, if it recurs) retries.
  }
}

function startFileWatcher(): void {
  const watcher = chokidar.watch(repositoryRoot, {
    ignored: (path: string) => isIgnoredWatchPath(path),
    ignoreInitial: true,
    persistent: true,
  });
  function relativeWatchPath(absolutePath: string): string {
    return relative(repositoryRoot, absolutePath).split(sep).join("/");
  }
  watcher.on("add", (path: string) => {
    void readWatchedFileText(path).then((newText) => {
      const filePath = relativeWatchPath(path);
      pendingFileWatchEvents.set(filePath, { filePath, activityKind: "create", newText });
      scheduleFileWatchFlush();
    });
  });
  watcher.on("change", (path: string) => {
    void readWatchedFileText(path).then((newText) => {
      const filePath = relativeWatchPath(path);
      pendingFileWatchEvents.set(filePath, { filePath, activityKind: "changed", newText });
      scheduleFileWatchFlush();
    });
  });
  watcher.on("unlink", (path: string) => {
    const filePath = relativeWatchPath(path);
    pendingFileWatchEvents.set(filePath, { filePath, activityKind: "delete", newText: null });
    scheduleFileWatchFlush();
  });
  watcher.on("error", () => { /* best-effort -- a watcher error must never crash the resident */ });
}

const isCompiledTerminalBridge = import.meta.url.endsWith(".js");
const missionBridgeRunnerArgs = isCompiledTerminalBridge
  ? [resolve(dirname(fileURLToPath(import.meta.url)), "local-mission-bridge-runner.js")]
  : [require.resolve("tsx/cli"), resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "bridge", "local-mission-bridge-runner.ts")];
// Mission bridge children used to run with stdio fully "ignore"d -- headless
// by design (no console per connected provider), but that also meant every
// console.error/console.log a bridge writes when it silently refuses to
// start a session (a bad mention match, a lookup failure, an ACP launch
// error) went nowhere. A user with no terminal window open had no way to
// ever learn why one provider stopped responding while another kept
// working. Route each child's own stdout/stderr into its own append-only
// log file instead -- still headless, but now actually diagnosable.
const missionBridgeLogDir = resolve(repositoryRoot, ".oathlock", "runtime", "mission-bridge-logs");
async function startMissionBridgeChildren(): Promise<void> {
  const connectedProviders = await connectedLocalProviders();
  await mkdir(missionBridgeLogDir, { recursive: true }).catch(() => {});
  missionBridgeSupervisor = createResidentSupervisor({
    profiles: connectedProviders,
    restartDelayMs: 2_000,
    maxRestarts: 3,
    launch: (provider, onExit) => {
      const logStream = createWriteStream(resolve(missionBridgeLogDir, `${provider}.log`), { flags: "a" });
      const child = spawn(process.execPath, missionBridgeRunnerArgs, {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, OATHLOCK_LOCAL_MISSION_BRIDGE_PROVIDER: provider },
      });
      const timestampPrefix = () => `[${new Date().toISOString()}] `;
      child.stdout?.on("data", (chunk: Buffer) => logStream.write(`${timestampPrefix()}${chunk}`));
      child.stderr?.on("data", (chunk: Buffer) => logStream.write(`${timestampPrefix()}${chunk}`));
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        logStream.end(`${timestampPrefix()}[supervisor] child exited with code ${code}\n`);
        onExit(code);
      };
      child.once("exit", (code) => finish(code));
      child.once("error", (error) => {
        logStream.write(`${timestampPrefix()}[supervisor] child spawn error: ${error instanceof Error ? error.message : String(error)}\n`);
        finish(1);
      });
      return { kill: () => { settled = true; logStream.end(); child.kill(); } };
    },
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
    onStateChange: (provider, state) => {
      // See scripts/oathlock-cli.ts's identical wiring for the resident-CLI
      // path -- "failed" means this provider's mission bridge is now
      // permanently offline until the whole terminal runtime restarts, and
      // was previously silent with no signal anywhere.
      if (state === "failed") process.stderr.write(`[mission-bridge-supervisor] provider "${provider}" has FAILED and will not auto-restart -- it exhausted its restart budget. Restart the terminal runtime once the underlying issue is fixed.\n`);
    },
  });
  missionBridgeSupervisor.start();
  // Profiles can be connected after the machine-local listener starts. Keep
  // reconciling the child set so a new Claude/OpenCode connection becomes
  // live automatically without a second runtime command or a risky restart.
  missionBridgeSyncTimer = setInterval(() => {
    void connectedLocalProviders()
      .then((providers) => missionBridgeSupervisor?.syncProfiles(providers))
      .catch((error) => process.stderr.write(`M9R local mission bridge profile sync failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }, 5_000);
  missionBridgeSyncTimer.unref?.();

  reconnectPollTimer = setInterval(() => {
    void checkReconnectRequest().catch((error) => process.stderr.write(`M9R reconnect check failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }, 20_000);
  reconnectPollTimer.unref?.();

  startFileWatcher();
}

if (localOnlyRuntime) {
  process.stdout.write("M9R local-only runtime: hosted relay, API polling, and mission bridges are disabled.\n");
} else {
  void startMissionBridgeChildren().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown startup error";
    process.stderr.write(`M9R local mission bridge failed to start: ${message}\n`);
  });
}
