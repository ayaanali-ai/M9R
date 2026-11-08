import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

type Rgb = readonly [number, number, number];

export interface AgentCursorOverlayPoint {
  id: string;
  label: string;
  color: Rgb;
  x: number;
  y: number;
}

export interface AgentCursorOverlayHost {
  upsert(point: AgentCursorOverlayPoint): Promise<boolean>;
  hide(id: string): Promise<void>;
  close(): Promise<void>;
}

type OverlayMessage = { event?: unknown; requestId?: unknown; ok?: unknown };
type SpawnOverlay = typeof spawn;
type OverlayChild = ChildProcessByStdio<Writable, Readable, null>;

const READY_TIMEOUT_MS = 2_000;
const ACK_TIMEOUT_MS = 900;
const EXIT_TIMEOUT_MS = 700;

/**
 * One owner-broker child renders all agent markers. It is presentation only:
 * callers must never use its result as evidence that an input action landed.
 */
export function createAgentCursorOverlayHost(input: {
  executablePath: string;
  spawnProcess?: SpawnOverlay;
}): AgentCursorOverlayHost {
  const spawnProcess = input.spawnProcess ?? spawn;
  let child: OverlayChild | undefined;
  let ready: Promise<boolean> | undefined;
  let nextRequestId = 1;
  let closing: Promise<void> | undefined;
  const pending = new Map<number, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  const visible = new Set<string>();
  const hide = async (id: string): Promise<void> => {
    if (!visible.has(id)) return;
    if (await send({ cmd: "hide", id })) visible.delete(id);
  };

  const failPending = () => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve(false);
      pending.delete(id);
    }
  };

  function consumeLine(line: string): void {
    let message: OverlayMessage;
    try { message = JSON.parse(line) as OverlayMessage; }
    catch { return; }
    if (message.event === "ready") {
      // The startup promise is resolved by the first successfully rendered
      // layered frame, not merely by process creation.
      (child as (OverlayChild & { __m9rReady?: () => void }) | undefined)?.__m9rReady?.();
      return;
    }
    if (message.event !== "ack" || !Number.isSafeInteger(message.requestId)) return;
    const id = message.requestId as number;
    const request = pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(id);
    request.resolve(message.ok === true);
  }

  async function ensureStarted(): Promise<boolean> {
    if (child && ready) return ready;
    if (closing) await closing;
    let resolveReady!: (value: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    let settled = false;
    const finishReady = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolveReady(value);
    };
    let process: OverlayChild;
    try {
      process = spawnProcess(input.executablePath, ["--spawn-cursor-overlay"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      }) as OverlayChild;
    } catch {
      finishReady(false);
      return readiness;
    }
    child = process;
    ready = readiness;
    (process as OverlayChild & { __m9rReady?: () => void }).__m9rReady = () => finishReady(true);
    const lines = createInterface({ input: process.stdout });
    lines.on("line", consumeLine);
    process.once("error", () => finishReady(false));
    process.once("exit", () => {
      finishReady(false);
      lines.close();
      failPending();
      if (child === process) {
        child = undefined;
        ready = undefined;
      }
    });
    const timer = setTimeout(() => finishReady(false), READY_TIMEOUT_MS);
    const result = await readiness;
    clearTimeout(timer);
    if (!result && child === process) {
      child = undefined;
      ready = undefined;
      lines.close();
      try { process.kill(); } catch { /* the process may already have exited */ }
    }
    return result;
  }

  async function send(command: Record<string, unknown>): Promise<boolean> {
    if (!await ensureStarted()) return false;
    const process = child;
    if (!process || process.exitCode !== null || process.killed || !process.stdin.writable) return false;
    const requestId = nextRequestId++;
    if (!Number.isSafeInteger(requestId)) {
      nextRequestId = 2;
      return false;
    }
    const line = `${JSON.stringify({ ...command, requestId })}\n`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(false);
      }, ACK_TIMEOUT_MS);
      pending.set(requestId, { resolve, timer });
      process.stdin.write(line, (error) => {
        if (!error) return;
        const request = pending.get(requestId);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.resolve(false);
      });
    });
  }

  return {
    async upsert(point) {
      if (!point.id || point.id.length > 72 || !point.label || point.label.length > 28
        || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return false;
      const ok = await send({ cmd: "upsert", id: point.id, label: point.label, color: point.color, x: point.x, y: point.y });
      if (ok) visible.add(point.id);
      return ok;
    },
    async hide(id) {
      await hide(id);
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        await Promise.all([...visible].map((id) => hide(id).catch(() => undefined)));
        const process = child;
        if (!process) return;
        child = undefined;
        ready = undefined;
        visible.clear();
        const exited = new Promise<void>((resolve) => {
          if (process.exitCode !== null) { resolve(); return; }
          process.once("exit", () => resolve());
        });
        try { process.stdin.end(); } catch { /* already closed */ }
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS))]);
        if (process.exitCode === null && !process.killed) {
          try { process.kill(); } catch { /* already exited */ }
        }
        failPending();
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
}
