import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { createConnection, createServer, type Server } from "node:net";

const OWNER_PROTOCOL_VERSION = 1 as const;
const OWNER_PORT_FIRST = 40_000;
const OWNER_PORT_COUNT = 9_000;
const OWNER_PORT_ATTEMPTS = 64;
const OWNER_CONNECT_TIMEOUT_MS = 750;
const OWNER_MESSAGE_MAX_BYTES = 1_024;

export interface RuntimeOwnerDescriptor {
  rootId: string;
  pid: number;
  startedAtMs: number;
  port: number;
  protocolVersion: typeof OWNER_PROTOCOL_VERSION;
}

export interface RuntimeOwnerLease extends RuntimeOwnerDescriptor {
  token: string;
  release(): Promise<void>;
}

export type AcquireTerminalRuntimeOwnerResult =
  | { status: "acquired"; owner: RuntimeOwnerLease }
  | { status: "already-running"; owner: RuntimeOwnerDescriptor };

export interface AcquireTerminalRuntimeOwnerOptions {
  /** Inherited only by the managed watchdog and its replacement runtime. */
  token?: string;
  /** Test seam; production candidates are deterministically derived per OS user. */
  ports?: readonly number[];
  /** Test seam for isolating runtime owners in tests. */
  userHome?: string;
  onRestartRequest?: () => void;
}

export interface InspectTerminalRuntimeOwnerOptions {
  /** Test seam; production candidates are deterministically derived per OS user. */
  ports?: readonly number[];
  /** Test seam for a runtime started with an isolated user-home environment. */
  userHome?: string;
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  const normalized = process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
  return normalized.replaceAll("/", sep);
}

function rootIdentity(userHome = homedir()): string {
  return createHash("sha256")
    .update(`m9r-terminal-runtime-owner-v1\0${normalizedPath(userHome)}`)
    .digest("hex");
}

function portCandidates(supplied?: readonly number[], userHome = homedir()): number[] {
  if (supplied) {
    const ports = [...new Set(supplied)];
    if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
      throw new TypeError("Runtime owner ports must be non-empty valid TCP ports.");
    }
    return ports;
  }
  const seed = Number.parseInt(rootIdentity(userHome).slice(0, 8), 16) % OWNER_PORT_COUNT;
  return Array.from({ length: OWNER_PORT_ATTEMPTS }, (_, index) =>
    OWNER_PORT_FIRST + ((seed + index * 97) % OWNER_PORT_COUNT),
  );
}

function parseOwnerMessage(raw: string): RuntimeOwnerDescriptor | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<RuntimeOwnerDescriptor> & { type?: unknown };
    if (record.type !== "m9r-terminal-runtime-owner"
      || record.protocolVersion !== OWNER_PROTOCOL_VERSION
      || typeof record.rootId !== "string"
      || !/^[a-f0-9]{64}$/.test(record.rootId)
      || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0
      || !Number.isSafeInteger(record.startedAtMs) || (record.startedAtMs ?? 0) <= 0
      || !Number.isInteger(record.port) || (record.port ?? 0) < 1 || (record.port ?? 0) > 65_535) return null;
    return {
      rootId: record.rootId,
      pid: record.pid!,
      startedAtMs: record.startedAtMs!,
      port: record.port!,
      protocolVersion: OWNER_PROTOCOL_VERSION,
    };
  } catch {
    return null;
  }
}

function parseResponse(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function sendRequest(port: number, request: Record<string, unknown>): Promise<string | null> {
  return new Promise((resolveResponse) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let response = "";
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResponse(value);
    };
    const timer = setTimeout(() => finish(null), OWNER_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer | string) => {
      response += String(chunk);
      if (Buffer.byteLength(response, "utf8") > OWNER_MESSAGE_MAX_BYTES) return finish(null);
      const newline = response.indexOf("\n");
      if (newline >= 0) finish(response.slice(0, newline));
    });
    socket.once("error", () => finish(null));
    socket.once("end", () => finish(response || null));
  });
}

type ProbeResult =
  | { kind: "owner"; owner: RuntimeOwnerDescriptor }
  | { kind: "foreign" }
  | { kind: "unreachable" };

async function probePort(port: number): Promise<ProbeResult> {
  const response = await sendRequest(port, { type: "probe" });
  if (!response) return { kind: "unreachable" };
  const value = parseResponse(response);
  const owner = value ? parseOwnerMessage(JSON.stringify(value)) : null;
  return owner ? { kind: "owner", owner } : { kind: "foreign" };
}

function sameSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function runtimeOwnerServer(options: {
  descriptor: RuntimeOwnerDescriptor;
  token: string;
  onRestartRequest?: () => void;
}): Server {
  let restartRequested = false;
  return createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(OWNER_CONNECT_TIMEOUT_MS, () => socket.destroy());
    let request = "";
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (Buffer.byteLength(request, "utf8") > OWNER_MESSAGE_MAX_BYTES) return socket.destroy();
      const newline = request.indexOf("\n");
      if (newline < 0) return;
      const parsed = parseResponse(request.slice(0, newline));
      if (parsed?.type === "probe") {
        socket.end(`${JSON.stringify({ type: "m9r-terminal-runtime-owner", ...options.descriptor })}\n`);
        return;
      }
      if (parsed?.type === "verify" && sameSecret(parsed.token, options.token)) {
        socket.end(`${JSON.stringify({ ok: true, rootId: options.descriptor.rootId, pid: options.descriptor.pid })}\n`);
        return;
      }
      if (parsed?.type === "restart" && sameSecret(parsed.token, options.token) && !restartRequested) {
        restartRequested = true;
        socket.end(`${JSON.stringify({ ok: true, rootId: options.descriptor.rootId, pid: options.descriptor.pid })}\n`);
        setTimeout(() => {
          try { options.onRestartRequest?.(); } catch { /* restart callback is best-effort after acknowledgement */ }
        }, 20).unref();
        return;
      }
      socket.end(`${JSON.stringify({ ok: false })}\n`);
    });
  });
}

export async function acquireTerminalRuntimeOwner(
  options: AcquireTerminalRuntimeOwnerOptions,
): Promise<AcquireTerminalRuntimeOwnerResult> {
  const userHome = options.userHome ?? homedir();
  const rootId = rootIdentity(userHome);
  const startedAtMs = Date.now();
  if (options.token !== undefined && !/^[a-f0-9]{64}$/.test(options.token)) {
    throw new TypeError("Runtime owner token must be 32 bytes encoded as lowercase hexadecimal.");
  }
  const token = options.token ?? randomBytes(32).toString("hex");
  for (const port of portCandidates(options.ports, userHome)) {
    const descriptor: RuntimeOwnerDescriptor = { rootId, pid: process.pid, startedAtMs, port, protocolVersion: OWNER_PROTOCOL_VERSION };
    const server = runtimeOwnerServer({ descriptor, token, onRestartRequest: options.onRestartRequest });
    try {
      await listen(server, port);
      server.unref();
      let released = false;
      const owner: RuntimeOwnerLease = {
        ...descriptor,
        token,
        async release() {
          if (released) return;
          released = true;
          await new Promise<void>((resolveRelease) => {
            if (!server.listening) return resolveRelease();
            server.close(() => resolveRelease());
          });
        },
      };
      return { status: "acquired", owner };
    } catch (error) {
      server.close();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES" && code !== "EADDRNOTAVAIL") throw error;
      if (code === "EADDRINUSE") {
        const existing = await probePort(port);
        if (existing.kind === "owner" && existing.owner.rootId === rootId) {
          return { status: "already-running", owner: existing.owner };
        }
        if (existing.kind === "unreachable") {
          throw new Error(`M9R found local runtime port ${port} occupied but could not verify its owner; refusing to start a duplicate runtime.`);
        }
      }
    }
  }
  throw new Error("M9R could not acquire a local runtime-owner port; no provider processes were started. Close a conflicting local service or retry.");
}

export async function inspectTerminalRuntimeOwner(
  options: InspectTerminalRuntimeOwnerOptions,
): Promise<RuntimeOwnerDescriptor | null> {
  const userHome = options.userHome ?? homedir();
  const rootId = rootIdentity(userHome);
  for (const port of portCandidates(options.ports, userHome)) {
    const result = await probePort(port);
    if (result.kind === "owner" && result.owner.rootId === rootId) return result.owner;
  }
  return null;
}

export async function requestTerminalRuntimeRestart(
  owner: RuntimeOwnerDescriptor,
  token: string,
): Promise<boolean> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const response = await sendRequest(owner.port, { type: "restart", token });
  if (!response) return false;
  const value = parseResponse(response);
  return value?.ok === true && value.rootId === owner.rootId && value.pid === owner.pid;
}

/** Proves that a watchdog still belongs to the currently active runtime. */
export async function verifyTerminalRuntimeOwner(
  owner: RuntimeOwnerDescriptor,
  token: string,
): Promise<boolean> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const response = await sendRequest(owner.port, { type: "verify", token });
  if (!response) return false;
  const value = parseResponse(response);
  return value?.ok === true && value.rootId === owner.rootId && value.pid === owner.pid;
}
