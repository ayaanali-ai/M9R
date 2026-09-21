import type { Readable, Writable } from "node:stream";

/**
 * Minimal JSON-RPC client for `codex app-server` over stdio: one JSON object per line, no `jsonrpc`
 * field. Kept free of any M9R policy so it can be tested against a fake server.
 */

export class CodexRpcError extends Error {
  readonly method: string;
  readonly code: number | null;

  constructor(method: string, code: number | null, message: string) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code;
  }
}

export type CodexNotificationHandler = (method: string, params: unknown) => void;
/** Return the JSON-RPC `result`, or throw to answer with an error. Every server request is answered, never left hanging. */
export type CodexServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_LINE_CHARS = 8 * 1024 * 1024;

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private buffer = "";
  private closed = false;
  private onNotification: CodexNotificationHandler = () => undefined;
  private onServerRequest: CodexServerRequestHandler = async (method) => { throw new CodexRpcError(method, -32601, "not supported by M9R"); };
  private closeListeners: Array<(reason: string) => void> = [];

  private readonly input: Writable;
  private readonly requestTimeoutMs: number;

  constructor(input: Writable, output: Readable, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.input = input;
    this.requestTimeoutMs = requestTimeoutMs;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.receive(chunk));
    output.on("end", () => this.fail("The Codex app-server closed its output."));
    output.on("error", (error) => this.fail(`The Codex app-server output failed: ${error.message}`));
    input.on("error", (error) => this.fail(`The Codex app-server input failed: ${error.message}`));
  }

  setHandlers(handlers: { notification?: CodexNotificationHandler; serverRequest?: CodexServerRequestHandler }): void {
    if (handlers.notification) this.onNotification = handlers.notification;
    if (handlers.serverRequest) this.onServerRequest = handlers.serverRequest;
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new CodexRpcError(method, null, "the Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(method, null, `no response within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Fails every in-flight request; called on exit and on protocol-level failure. Idempotent. */
  fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CodexRpcError(entry.method, null, reason));
      this.pending.delete(id);
    }
    for (const listener of this.closeListeners) listener(reason);
  }

  private write(message: unknown): void {
    try {
      this.input.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(`could not write to the Codex app-server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_CHARS && !this.buffer.includes("\n")) {
      this.fail("The Codex app-server sent an oversized message.");
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      console.warn("[codex-app-server] ignoring a non-JSON line from the server.");
      return;
    }
    if (message === null || typeof message !== "object") return;
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && message.method === undefined) {
      const entry = this.pending.get(message.id as number | string);
      if (!entry) return;
      this.pending.delete(message.id as number | string);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CodexRpcError(entry.method, message.error.code ?? null, message.error.message ?? "request failed"));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (hasId) {
      const id = message.id as number | string;
      void this.onServerRequest(message.method, message.params).then(
        (result) => this.write({ id, result: result ?? {} }),
        (error: unknown) => this.write({ id, error: { code: error instanceof CodexRpcError && error.code !== null ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } }),
      );
      return;
    }
    try {
      this.onNotification(message.method, message.params);
    } catch (error) {
      console.error(`[codex-app-server] notification handler failed for ${message.method}:`, error instanceof Error ? error.message : error);
    }
  }
}
