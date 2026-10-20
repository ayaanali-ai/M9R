import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

type RpcId = string | number;
type RpcParams = Record<string, unknown> & { requestId?: RpcId };
type RpcCapabilities = Record<string, unknown> & { tools?: Record<string, unknown> & { listChanged?: boolean } };
type RpcResult = Record<string, unknown> & { protocolVersion?: string; capabilities?: RpcCapabilities };
type RpcError = Record<string, unknown> & { data?: Record<string, unknown> };
type Message = { jsonrpc?: string; id?: RpcId; method?: string; params?: RpcParams; result?: RpcResult; error?: RpcError };
type Pending = { message: Message; generation?: number };

export interface McpSupervisorOptions {
  input: Readable;
  output: Writable;
  /** Trusted launcher configuration; never selected by an incoming tool payload. */
  spawnWorker: () => ChildProcess;
  maxAttempts?: number;
  retryDelayMs?: number;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxMessageBytes?: number;
  /** Trusted installation metadata only, never a revision supplied by a tool request. */
  workerRevision?: () => string | undefined;
  refreshEveryMs?: number;
  onEvent?: (event: { kind: "ready" | "lost" | "recovery-exhausted" | "refresh"; generation: number; exitCode?: number | null; workerPid?: number }) => void;
}

/**
 * Own the provider's pipe for its lifetime while replaceable runtime workers
 * negotiate the original client's MCP capabilities. Requests already sent to a
 * lost worker receive an uncertain result; they are never executed again here.
 * This layer forwards protocol messages and does not choose provider identities.
 */
export function runMcpStdioSupervisor(options: McpSupervisorOptions) {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid recovery attempt limit");
  const limit = options.maxMessageBytes ?? 32 * 1024 * 1024;
  const pending = new Map<string | number, Pending>();
  const serverRequests = new Map<string | number, { originalId: string | number; generation: number }>();
  const shutdowns = new WeakMap<ChildProcess, Promise<void>>();
  let child: ChildProcess | undefined;
  let generation = 0;
  let initialization: Message | undefined;
  let initialProtocol: string | undefined;
  let initialized = false;
  let initializationAnswered = false;
  let stopping = false;
  let connecting: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let retiring: Promise<void> | undefined;
  let cancelHandshake: (() => void) | undefined;
  let serverRequestSequence = 0;
  let inputBuffer = "";
  // Providers are allowed to pipeline notifications and the first request
  // after initialize. Hold those messages until the private worker has
  // completed its own handshake instead of treating startup latency as a
  // runtime failure.
  const preReadyMessages: Message[] = [];
  let loadedRevision: string | undefined;
  let refreshing = false;
  let finishClosed!: () => void;
  const closed = new Promise<void>(resolve => { finishClosed = resolve; });
  // Pipe reads may split a Unicode character between buffers. Decode streams,
  // not individual chunks, so arbitrary provider names and tool text survive.
  options.input.setEncoding("utf8");
  const event = (kind: "ready" | "lost" | "recovery-exhausted" | "refresh", exitCode?: number | null, workerPid?: number) => {
    try { options.onEvent?.({ kind, generation, ...(exitCode !== undefined ? { exitCode } : {}), ...(workerPid !== undefined ? { workerPid } : {}) }); } catch { /* Diagnostics cannot break the transport. */ }
  };
  function parseMessage(line: string): Message {
    const value: unknown = JSON.parse(line);
    if (!JSONRPCMessageSchema.safeParse(value).success) throw new Error("Invalid MCP frame");
    return value as Message;
  }

  function send(message: Message) {
    if (!options.output.destroyed) options.output.write(`${JSON.stringify(message)}\n`);
  }

  function failure(id: string | number, sent: boolean) {
    send({ jsonrpc: "2.0", id, error: { code: -32001,
      message: sent ? "M9R runtime connection was lost; reconcile the existing operation before further input." : "M9R runtime is unavailable after bounded recovery.",
      data: { dispatchStatus: sent ? "unknown" : "not-dispatched", replayAllowed: false } } });
  }

  function write(worker: ChildProcess, message: Message) {
    if (!worker.stdin || worker.stdin.destroyed) throw new Error("Worker input is unavailable");
    worker.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function stopWorker(worker: ChildProcess): Promise<void> {
    const prior = shutdowns.get(worker);
    if (prior) return prior;
    const shutdown = terminateWorker(worker);
    shutdowns.set(worker, shutdown);
    return shutdown;
  }

  async function terminateWorker(worker: ChildProcess) {
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
    worker.stdin?.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, options.shutdownTimeoutMs ?? 2000); })]);
    if (timer) clearTimeout(timer);
    if (worker.exitCode === null && worker.signalCode === null) {
      // Only the private worker created by this supervisor is eligible here.
      worker.kill();
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, options.shutdownTimeoutMs ?? 2000); })]);
      if (timer) clearTimeout(timer);
      if (worker.exitCode === null && worker.signalCode === null) throw new Error("Owned MCP worker did not exit");
    }
  }

  async function connectAttempt() {
    const startingRevision = options.workerRevision?.();
    const worker = options.spawnWorker();
    if (!worker.stdin || !worker.stdout) throw new Error("Worker must expose pipe transports");
    worker.stdout.setEncoding("utf8");
    child = worker;
    const currentGeneration = ++generation;
    const handshakeId = `m9r-recovery-${currentGeneration}`;
    let buffer = "";
    let settled = false;
    let finish!: () => void;
    let reject!: (error: Error) => void;
    const handshake = new Promise<void>((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
    const timer = setTimeout(() => reject(new Error("Worker handshake timed out")), options.handshakeTimeoutMs ?? 10000);
    cancelHandshake = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Initialization cancelled")); } };
    const lost = () => {
      if (child !== worker) return;
      child = undefined;
      event("lost", worker.exitCode, worker.pid);
      retiring = stopWorker(worker);
      // The next connection must await confirmed teardown. Attach a handler
      // immediately so a failed private-worker shutdown never becomes unhandled.
      void retiring.catch(() => {});
      serverRequests.clear();
      for (const [id, entry] of pending) {
        if (entry.generation === currentGeneration) { pending.delete(id); failure(id, true); }
      }
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Worker connection lost")); }
      else if (initialized && !stopping) {
        // Recovery is bounded once per loss; a failed episode waits for a new
        // client request rather than creating a permanent restart loop.
        queueMicrotask(() => { void ensureConnected().catch(() => {}); });
      }
    };
    worker.once("error", lost);
    worker.once("exit", lost);
    worker.stdin.on("error", lost);
    worker.stdout.on("error", lost);
    worker.stdout.on("data", chunk => {
      if (child !== worker || stopping) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > limit) { lost(); return; }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Message;
        try { message = parseMessage(line); } catch { lost(); return; }
        if (message.id === handshakeId && !message.method) {
          const result = message.result;
          if (!result?.protocolVersion || message.error || (initialProtocol && initialProtocol !== result.protocolVersion)) {
            reject(new Error("Worker protocol negotiation failed"));
            continue;
          }
          if (settled) continue;
          settled = true; clearTimeout(timer);
          cancelHandshake = undefined;
          initialProtocol = result.protocolVersion;
          loadedRevision = startingRevision;
          if (!initializationAnswered) {
            initializationAnswered = true;
            const capabilities = result.capabilities ?? {};
            const forwardedResult = { ...result, capabilities: { ...capabilities } };
            if (forwardedResult.capabilities.tools) forwardedResult.capabilities.tools = { ...forwardedResult.capabilities.tools, listChanged: true };
            send({ jsonrpc: "2.0", id: initialization!.id, result: forwardedResult });
            const queued = preReadyMessages.splice(0);
            for (const queuedMessage of queued) receive(queuedMessage);
          } else {
            if (initialized) write(worker, { jsonrpc: "2.0", method: "notifications/initialized" });
            if (initialized && result.capabilities?.tools) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
          }
          event("ready", undefined, worker.pid);
          finish();
        } else if (message.method) {
          if (message.id !== undefined) {
            const id = `m9r-server-${currentGeneration}-${++serverRequestSequence}`;
            serverRequests.set(id, { originalId: message.id, generation: currentGeneration });
            send({ ...message, id });
          } else send(message);
        } else if (message.id !== undefined) {
          const entry = pending.get(message.id);
          if (entry?.generation === currentGeneration) { pending.delete(message.id); send(message); }
        }
      }
    });
    // Drain worker diagnostics without copying potentially private payloads.
    worker.stderr?.resume();
    try {
      write(worker, { ...initialization!, id: handshakeId });
      await handshake;
    } catch (error) {
      settled = true; clearTimeout(timer);
      cancelHandshake = undefined;
      if (child === worker) child = undefined;
      retiring = stopWorker(worker);
      await retiring;
      retiring = undefined;
      throw error;
    }
  }

  function ensureConnected(): Promise<void> {
    if (stopping) return Promise.reject(new Error("Supervisor is closing"));
    if (connecting) return connecting;
    if (child) return Promise.resolve();
    connecting = (async () => {
      if (retiring) { await retiring; retiring = undefined; }
      for (let attempt = 0; attempt < maxAttempts && !stopping; attempt++) {
        try { await connectAttempt(); return; }
        catch {
          // A failed teardown is a real safety barrier, not permission to leave
          // a private worker behind and start another one.
          if (retiring) { await retiring; retiring = undefined; }
          if (attempt + 1 < maxAttempts && !stopping) await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 100));
        }
      }
      event("recovery-exhausted");
      throw new Error("M9R worker recovery exhausted");
    })().finally(() => { connecting = undefined; });
    return connecting;
  }

  function receive(message: Message) {
    if (stopping) return;
    if (message.method === "initialize" && message.id !== undefined) {
      if (initialization) { failure(message.id, false); return; }
      initialization = message;
      void ensureConnected().catch(() => { failure(message.id!, false); initialization = undefined; });
      return;
    }
    if (!initialization || !initializationAnswered) {
      if (message.id !== undefined || message.method === "notifications/initialized") {
        if (preReadyMessages.length >= 128) {
          if (message.id !== undefined) failure(message.id, false);
        } else preReadyMessages.push(message);
      }
      return;
    }
    if (message.method === "notifications/initialized") { initialized = true; if (child) write(child, message); return; }
    if (!message.method && message.id !== undefined) {
      const request = serverRequests.get(message.id);
      serverRequests.delete(message.id);
      if (child && request?.generation === generation) write(child, { ...message, id: request.originalId });
      return;
    }
    if (message.method === "notifications/cancelled") {
      const id = message.params?.requestId;
      if (id === undefined) { if (child) write(child, message); return; }
      const entry = pending.get(id);
      if (entry && entry.generation === undefined) pending.delete(id);
      else if (child) write(child, message);
      return;
    }
    if (message.id === undefined) { if (child) write(child, message); return; }
    if (pending.has(message.id) || pending.size >= 128) { failure(message.id, false); return; }
    const entry: Pending = { message };
    pending.set(message.id, entry);
    void ensureConnected().then(() => {
      if (!child || pending.get(message.id!) !== entry || stopping) return;
      entry.generation = generation;
      write(child, message);
    }).catch(() => {
      if (pending.get(message.id!) === entry) { pending.delete(message.id!); failure(message.id!, entry.generation !== undefined); }
    });
  }

  options.input.on("data", chunk => {
    inputBuffer += chunk.toString();
    if (Buffer.byteLength(inputBuffer) > limit) { void stop(); return; }
    for (;;) {
      const end = inputBuffer.indexOf("\n");
      if (end < 0) break;
      const line = inputBuffer.slice(0, end); inputBuffer = inputBuffer.slice(end + 1);
      try {
        const message = parseMessage(line);
        receive(message);
      } catch { send({ jsonrpc: "2.0", error: { code: -32700, message: "Invalid MCP frame" } }); }
    }
  });
  options.input.on("end", () => { void stop(); });
  options.input.on("error", () => { void stop(); });
  options.output.on("error", () => { void stop(); });

  const refreshTimer = options.workerRevision ? setInterval(() => {
    if (stopping || refreshing || connecting || !child || !initialized || pending.size || serverRequests.size) return;
    let revision: string | undefined;
    try { revision = options.workerRevision?.(); } catch { return; }
    if (!revision || revision === loadedRevision) return;
    refreshing = true;
    const worker = child;
    // Closing only an idle, owned worker preserves active provider work. New
    // requests wait behind the existing confirmed-retirement barrier.
    child = undefined;
    event("refresh", undefined, worker.pid);
    retiring = stopWorker(worker);
    void ensureConnected().catch(() => {}).finally(() => { refreshing = false; });
  }, options.refreshEveryMs ?? 1500) : undefined;

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (refreshTimer) clearInterval(refreshTimer);
    cancelHandshake?.();
    stopPromise = (async () => {
      if (child) { const worker = child; child = undefined; await stopWorker(worker); }
      try { await connecting; } catch { /* Recovery stops with the owned transport. */ }
      finishClosed();
    })();
    return stopPromise;
  }
  return { stop, closed };
}
