import {
  PTY_OUTPUT_MAX_CHUNK_BYTES,
  appendScrollback,
  chunkPtyBytes,
  decodePtyBytes,
  type PtyInputPayload,
  type PtyResizePayload,
} from "./mission-pty-protocol";

/**
 * Hosts the real terminal process for one pane and turns it into relay frames.
 *
 * The important job here is rate control, not spawning. A PTY emits data
 * whenever the child writes -- a build can produce thousands of tiny writes a
 * second -- while the Relay gives each subscriber a bounded mailbox
 * (DEFAULT_MAX_PENDING_RELAY_FRAMES) and drops anyone who overruns it. Sending
 * a frame per data event would drop viewers off their own terminal during
 * exactly the noisy moments they most want to watch. So output is coalesced
 * into a buffer and flushed on a fixed tick instead.
 */

/** ~60fps. Fast enough to feel live, slow enough to bound the frame rate. */
export const PTY_FLUSH_INTERVAL_MS = 16;

/** Frames emitted per flush. Caps sustained rate at ~180 frames/sec. */
export const PTY_MAX_CHUNKS_PER_FLUSH = 3;

/**
 * Ceiling on un-flushed output. A process dumping megabytes faster than the
 * transport drains cannot be shown in full to a human anyway, so the oldest
 * bytes are discarded rather than growing memory without bound -- the same
 * tradeoff a terminal's scrollback limit already makes.
 */
export const PTY_MAX_PENDING_BYTES = 512 * 1024;

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
}

export interface PtySpawnRequest {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface PtyHostOptions {
  sessionId: string;
  spawn(request: PtySpawnRequest): PtyProcess;
  /** Emits one output frame's worth of base64 terminal bytes. */
  publishOutput(output: { sessionId: string; seq: number; data: string }): void;
  publishExit(event: { sessionId: string; exitCode: number }): void;
  /** Injectable so tests drive the clock instead of waiting on real time. */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class MissionPtyHost {
  private readonly options: PtyHostOptions;
  private process: PtyProcess | null = null;
  /** ArrayBufferLike because subarray-backed views are how buffers are sliced here. */
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private seq = 0;
  private timer: unknown = null;
  private closed = false;
  /** Bytes dropped to stay under the pending ceiling; surfaced for tests/telemetry. */
  private droppedBytes = 0;

  constructor(options: PtyHostOptions) {
    this.options = options;
  }

  get pendingBytes(): number {
    return this.pending.length;
  }

  get droppedByteCount(): number {
    return this.droppedBytes;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.closed;
  }

  start(request: PtySpawnRequest): void {
    if (this.process) throw new Error("This terminal session is already started.");
    const child = this.options.spawn(request);
    this.process = child;
    child.onData((data) => this.enqueue(data));
    child.onExit((event) => {
      // Flush whatever the process wrote right before dying, otherwise the
      // last line of output -- often the error that explains the exit -- is
      // silently lost.
      this.flush(Number.POSITIVE_INFINITY);
      this.stopTimer();
      this.closed = true;
      this.options.publishExit({ sessionId: this.options.sessionId, exitCode: event.exitCode });
    });
    this.startTimer();
  }

  /** Terminal bytes from a viewer. Order is whatever the Relay delivered. */
  applyInput(payload: Pick<PtyInputPayload, "data">): void {
    if (!this.process || this.closed) return;
    const bytes = decodePtyBytes(payload.data);
    if (bytes.length === 0) return;
    this.process.write(Buffer.from(bytes).toString("utf8"));
  }

  applyResize(payload: Pick<PtyResizePayload, "cols" | "rows">): void {
    if (!this.process || this.closed) return;
    this.process.resize(payload.cols, payload.rows);
  }

  stop(): void {
    if (!this.process || this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.process.kill();
  }

  /** Exposed so a test can advance the clock without a real timer. */
  flushNow(): void {
    this.flush(PTY_MAX_CHUNKS_PER_FLUSH);
  }

  private enqueue(data: string): void {
    const bytes = new Uint8Array(Buffer.from(data, "utf8"));
    const before = this.pending.length + bytes.length;
    this.pending = appendScrollback(this.pending, bytes, PTY_MAX_PENDING_BYTES);
    if (before > this.pending.length) this.droppedBytes += before - this.pending.length;
  }

  private flush(maxChunks: number): void {
    if (this.pending.length === 0) return;
    const budget = Number.isFinite(maxChunks) ? maxChunks * PTY_OUTPUT_MAX_CHUNK_BYTES : this.pending.length;
    const sending = this.pending.subarray(0, budget);
    this.pending = this.pending.subarray(sending.length);
    for (const chunk of chunkPtyBytes(sending)) {
      this.options.publishOutput({ sessionId: this.options.sessionId, seq: this.seq, data: chunk });
      this.seq += 1;
    }
  }

  private startTimer(): void {
    const schedule = this.options.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
    this.timer = schedule(() => this.flush(PTY_MAX_CHUNKS_PER_FLUSH), PTY_FLUSH_INTERVAL_MS);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    const cancel = this.options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
    cancel(this.timer);
    this.timer = null;
  }
}
