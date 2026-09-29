/**
 * Request/response transport for actions owned by the local OS user.
 * Windows uses a named pipe; POSIX uses a mode-0600 Unix socket.
 */
import { chmodSync, existsSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";

const MAX_FRAME_BYTES = 64 * 1024;

export interface OwnerPipeRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

export interface OwnerPipeOptions {
  path: string;
  handle(request: OwnerPipeRequest): unknown | Promise<unknown>;
}

function writeJson(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

export async function startOwnerPipe(options: OwnerPipeOptions): Promise<Server> {
  if (process.platform !== "win32" && existsSync(options.path)) rmSync(options.path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    let finished = false;
    const finish = (value: unknown) => {
      if (finished) return;
      finished = true;
      writeJson(socket, value);
    };
    socket.setTimeout(2_000, () => finish({ ok: false, error: "owner pipe request timed out" }));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (finished) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        finish({ ok: false, error: "owner pipe request is too large" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as OwnerPipeRequest;
        if (!parsed || (parsed.method !== "GET" && parsed.method !== "POST") || typeof parsed.path !== "string" || !parsed.path.startsWith("/web/")) {
          finish({ ok: false, error: "invalid owner pipe request" });
          return;
        }
        Promise.resolve(options.handle(parsed)).then(finish, () => finish({ ok: false, error: "owner pipe request failed" }));
      } catch {
        finish({ ok: false, error: "invalid owner pipe JSON" });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.path);
  });
  if (process.platform !== "win32") {
    try { chmodSync(options.path, 0o600); } catch { /* unsupported filesystems remain usable */ }
  }
  return server;
}

export function requestOwnerPipe<T = unknown>(path: string, request: OwnerPipeRequest, timeoutMs = 2_000): Promise<T | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const done = (value: T | null) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.on("error", () => done(null));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) done(null);
        return;
      }
      try { done(JSON.parse(buffer.slice(0, newline)) as T); }
      catch { done(null); }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
