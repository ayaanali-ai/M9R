/**
 * NodeProcessExecutionHost — the first real `ProcessExecutionHost`
 * (Phase 3B).
 * ----------------------------------------------------------------------------
 * Wraps existing, already-tested infrastructure rather than reimplementing
 * it: `runProviderProcess` (`resident-provider-adapters.ts`) for the actual
 * spawn/timeout/cancel/output-capture, and `createGrantWorktree`
 * (`resident-write-isolation.ts`) for real git-worktree isolation per
 * instruction. Nothing in this file re-spawns a process a different way or
 * re-parses provider output — that stays entirely in
 * `mission-provider-adapter-codex.ts`.
 *
 * Honest limitation, not an oversight: `runProviderProcess` is a Node
 * `child_process` — there is no OS/runtime primitive this host uses to
 * reattach to a child process after the SUPERVISING Node process itself
 * restarts (Node offers no such API; a piped child's stdin/stdout streams
 * are gone the moment the parent that held those file descriptors exits).
 * So this host NEVER reports `process_alive_reattachable` and `reattach`
 * always refuses — rule 2 (mission-process-recovery.ts) simply never
 * fires for this host. What it CAN do reliably: distinguish "confirmed
 * dead" (exited while THIS instance was still watching it) from "status
 * unknown" (no in-memory record survived a restart — genuinely unknown,
 * not confirmed-anything). A host backed by a real supervisor daemon,
 * systemd, or a container runtime could support real reattachment; this
 * one honestly can't, and says so via its capability profile rather than
 * fabricating support.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGrantWorktree, worktreeSpecForGrant } from "@/lib/resident-write-isolation";
import { runProviderProcess, type ProviderProcessSpec } from "@/lib/resident-provider-adapters";
import { buildTerminationResult } from "./mission-process-host";
import type {
  HostLaunchInput,
  HostOutput,
  HostOutputEvent,
  HostPrepareInput,
  HostProcessStatus,
  PersistableProcessHandle,
  PreparedEnvironment,
  ProcessExecutionHost,
  QuarantineResult,
  ReattachedProcess,
  TerminationResult,
} from "./mission-process-host";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GitExecutor = (file: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
const realGitExecutor: GitExecutor = async (file, args, cwd) => promisify(execFile)(file, args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });

interface TrackedProcess {
  handle: PersistableProcessHandle;
  environmentPath: string;
  events: HostOutputEvent[];
  retainedEventBytes: number;
  eventCaptureTruncated: boolean;
  eventSeq: number;
  exitCode: number | null;
  finished: boolean;
  truncated: boolean;
  abortController: AbortController;
  /** Set only when `runProviderProcess` itself REJECTED (spawn error, onSpawn rejection) rather than resolving with an outcome — a distinct failure mode from a normal (even nonzero) exit. Phase 4D Part 4 §2/§4. */
  launchError: Error | null;
}

export interface NodeProcessExecutionHostConfig {
  hostIdentity: string;
  /** Injectable for tests — defaults to real `git` invocations. */
  gitExecutor?: GitExecutor;
  /** Bounded grace period after requesting cooperative termination, before escalating — injectable for deterministic tests. Default 3000ms. */
  terminationGraceMs?: number;
  /** Bounded confirmation window after escalating (or after the grace period, if escalation is a no-op) before giving up and reporting `termination_timed_out` — never waits indefinitely. Default 2000ms. */
  terminationConfirmMs?: number;
  /** How often to poll for natural completion while waiting out the bounded windows above. Default 25ms. */
  terminationPollIntervalMs?: number;
  /** Maximum UTF-8 bytes retained across incremental provider-output events. Default 1 MiB. */
  maxOutputEventBytes?: number;
  /** Maximum incremental provider-output event objects retained per execution. Default 2000. */
  maxOutputEventCount?: number;
}

const DEFAULT_MAX_OUTPUT_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_EVENT_COUNT = 2_000;

function outputEventBytes(event: HostOutputEvent): number {
  const raw = event.raw as { text?: unknown };
  return typeof raw.text === "string" ? Buffer.byteLength(raw.text, "utf8") : 0;
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^\uFFFD+/, "");
}

export class NodeProcessExecutionHost implements ProcessExecutionHost {
  private readonly hostIdentity: string;
  private readonly gitExecutor: GitExecutor;
  private readonly terminationGraceMs: number;
  private readonly terminationConfirmMs: number;
  private readonly terminationPollIntervalMs: number;
  private readonly maxOutputEventBytes: number;
  private readonly maxOutputEventCount: number;
  private readonly processes = new Map<string, TrackedProcess>();
  private readonly environmentPaths = new Map<string, string>();
  private readonly quarantined = new Set<string>();
  private handleSeq = 0;

  constructor(config: NodeProcessExecutionHostConfig) {
    this.hostIdentity = config.hostIdentity;
    this.gitExecutor = config.gitExecutor ?? realGitExecutor;
    this.terminationGraceMs = config.terminationGraceMs ?? 3000;
    this.terminationConfirmMs = config.terminationConfirmMs ?? 2000;
    this.terminationPollIntervalMs = config.terminationPollIntervalMs ?? 25;
    this.maxOutputEventBytes = Math.max(1, config.maxOutputEventBytes ?? DEFAULT_MAX_OUTPUT_EVENT_BYTES);
    this.maxOutputEventCount = Math.max(1, config.maxOutputEventCount ?? DEFAULT_MAX_OUTPUT_EVENT_COUNT);
  }

  async prepare(input: HostPrepareInput): Promise<PreparedEnvironment> {
    if (!input.repositoryRef) {
      throw new Error("NodeProcessExecutionHost requires a repositoryRef to prepare an isolated worktree — no bare-filesystem mode is supported.");
    }
    const spec = await createGrantWorktree(
      { repositoryRoot: input.repositoryRef, grantId: sanitizedEnvironmentId(input.instruction), baseRef: "HEAD" },
      this.gitExecutor,
    );
    const environmentId = sanitizedEnvironmentId(input.instruction);
    this.environmentPaths.set(environmentId, spec.worktreeRoot);
    return {
      environmentId,
      kind: "disposable",
      workingDirectory: spec.worktreeRoot,
      createdAt: new Date().toISOString(),
    };
  }

  async launch(input: HostLaunchInput): Promise<PersistableProcessHandle> {
    const invocation = input.invocation as { adapterId: string; payload: ProviderProcessSpec };
    this.handleSeq += 1;

    const abortController = new AbortController();
    const tracked: TrackedProcess = {
      handle: {
        executionId: input.instruction.instructionId,
        environmentId: input.environment.environmentId,
        environmentKind: input.environment.kind,
        hostIdentity: this.hostIdentity,
        processId: "pending",
        processStartIdentity: `pending-${this.handleSeq}-${Date.now()}`,
        createdAt: new Date().toISOString(),
        adapterId: invocation.adapterId,
        providerSessionRef: null,
      },
      environmentPath: input.environment.workingDirectory,
      events: [],
      retainedEventBytes: 0,
      eventCaptureTruncated: false,
      eventSeq: 0,
      exitCode: null,
      finished: false,
      truncated: false,
      abortController,
      launchError: null,
    };
    this.processes.set(tracked.handle.executionId, tracked);

    // Deliberately NOT awaited — `launch` must not block until the process
    // finishes. `runProviderProcess`'s own Promise settles this tracked
    // entry's `finished`/`exitCode` fields whenever the process actually
    // exits; `inspect`/`collect` read those fields without ever awaiting
    // this promise themselves.
    //
    // Phase 4D Part 4 §2/§4: the `.catch` below is the fix for a real,
    // reproduced bug — `runProviderProcess` REJECTS (never resolves) on a
    // synchronous spawn throw (converted to a rejection by Promise-executor
    // semantics), an async `child.once("error", ...)`, or an `onSpawn`
    // callback rejection. Without a `.catch` here, any of those produced an
    // unhandled promise rejection AND left `tracked.finished` false
    // forever — `inspect`/`collect`/`poll` would report "still running"
    // indefinitely for a launch that had already, terminally, failed.
    void runProviderProcess(
      invocation.payload,
      // The instruction carries no explicit wall-clock budget of its own in
      // this vertical slice; executionConstraints is the caller's place to
      // supply one. Falls back to a conservative default rather than an
      // unbounded run.
      typeof input.instruction.executionConstraints.maxDurationMs === "number" ? input.instruction.executionConstraints.maxDurationMs : 10 * 60_000,
      abortController.signal,
      undefined,
      (stream, data) => {
        const boundedData = utf8Tail(data, this.maxOutputEventBytes);
        if (boundedData !== data) tracked.eventCaptureTruncated = true;
        tracked.eventSeq += 1;
        const event: HostOutputEvent = {
          sequence: tracked.eventSeq,
          emittedAt: new Date().toISOString(),
          raw: { kind: "output", stream, text: boundedData },
        };
        tracked.events.push(event);
        tracked.retainedEventBytes += outputEventBytes(event);
        while (
          tracked.events.length > this.maxOutputEventCount ||
          tracked.retainedEventBytes > this.maxOutputEventBytes
        ) {
          const removed = tracked.events.shift();
          if (!removed) break;
          tracked.retainedEventBytes -= outputEventBytes(removed);
          tracked.eventCaptureTruncated = true;
        }
      },
      (pid) => {
        tracked.handle = { ...tracked.handle, processId: pid != null ? String(pid) : "unknown", processStartIdentity: `${pid ?? "unknown"}-${Date.now()}` };
      },
    ).then((outcome) => {
      tracked.finished = true;
      tracked.exitCode = outcome.exitCode;
      tracked.truncated =
        outcome.stdoutTruncated ||
        outcome.stderrTruncated ||
        tracked.eventCaptureTruncated;
    }).catch((error: unknown) => {
      tracked.finished = true;
      // -1 is never a real process exit code (POSIX/Windows exit codes are
      // non-negative) — a deliberate, documented sentinel meaning "no valid
      // exit code was ever produced," distinct from both "still running"
      // (HostOutput.exitCode stays null) and a genuine zero/nonzero exit.
      // `RealExecutionHost.poll` treats a non-null exitCode as "finished,"
      // so this is also what unblocks a poller that would otherwise wait
      // forever for a launch that never truly started.
      tracked.exitCode = -1;
      tracked.launchError = error instanceof Error ? error : new Error(String(error));
    });

    return tracked.handle;
  }

  async inspect(handle: PersistableProcessHandle): Promise<HostProcessStatus> {
    const tracked = this.processes.get(handle.executionId);
    if (!tracked) {
      // No in-memory record — either this handle never belonged to this
      // host instance, or (the realistic restart case) THIS instance is a
      // fresh process with no memory of what an earlier instance launched.
      // Node cannot answer "is that child still running" without the
      // original ChildProcess object, so this is honestly unknown, not
      // assumed dead.
      return { kind: "process_status_unknown", detail: "No in-memory record of this execution — likely a restarted host with no way to inspect a child it did not itself spawn.", exitCode: null };
    }
    if (tracked.handle.processStartIdentity !== handle.processStartIdentity) {
      return { kind: "process_confirmed_dead", detail: "processStartIdentity mismatch.", exitCode: null };
    }
    if (tracked.finished) {
      const detail = tracked.launchError
        ? `launch never produced a normal exit: ${tracked.launchError.message}`
        : `process exited with code ${tracked.exitCode}`;
      return { kind: "process_confirmed_dead", detail, exitCode: tracked.exitCode };
    }
    // Still running, per this host's own bookkeeping. Never reattachable —
    // see the file-level doc comment for why.
    return { kind: "process_alive_not_reattachable", detail: "process is still running under this host instance; no reattach mechanism exists for a plain child_process.", exitCode: null };
  }

  async reattach(handle: PersistableProcessHandle): Promise<ReattachedProcess> {
    void handle;
    throw new Error("NodeProcessExecutionHost does not support reattachment — a Node child_process cannot be resumed by a different process instance.");
  }

  /**
   * Phase 4D Part 4 §3 — a bounded, honest termination algorithm. Never
   * treats "the abort signal was sent" as proof of exit; never blocks
   * indefinitely either. Steps, exactly as specified:
   *   1. inspect current identity/state (process-not-found, identity
   *      mismatch, and already-exited are all resolved before any signal
   *      is sent — no point requesting termination of something already
   *      gone or that isn't the process this handle names).
   *   2. request graceful termination (`abortController.abort()` — the
   *      SAME signal `runProviderProcess` already wires to `child.kill()`).
   *   3. wait for a bounded grace period, polling for natural completion.
   *   4. escalate ("force kill" — see the inline note on what that means
   *      for a plain `child_process` this host does not hold a direct
   *      reference to) if still not confirmed.
   *   5. wait for a bounded confirmation period.
   *   6. return an HONEST result — `termination_timed_out` if still
   *      unconfirmed, never a false `terminated: true`.
   */
  async terminate(handle: PersistableProcessHandle): Promise<TerminationResult> {
    const tracked = this.processes.get(handle.executionId);
    if (!tracked) return buildTerminationResult("process_not_found", "no in-memory record — nothing to terminate");
    if (tracked.handle.processStartIdentity !== handle.processStartIdentity) {
      return buildTerminationResult("process_identity_mismatch", "processStartIdentity mismatch — this is not the process this handle refers to; a PID match alone is never sufficient");
    }
    if (tracked.finished) {
      return buildTerminationResult("already_exited", `already exited with code ${tracked.exitCode}`);
    }

    // Step 2: request graceful termination.
    tracked.abortController.abort();

    // Step 3: bounded grace period, polling for natural completion —
    // handles "natural completion races with termination" deterministically
    // (whichever becomes true first is what gets reported; never a fixed
    // sleep that ignores an earlier real exit).
    if (await this.waitForFinish(tracked, this.terminationGraceMs)) {
      return buildTerminationResult("graceful_exit_confirmed", `process exited with code ${tracked.exitCode} after graceful termination`);
    }

    // Step 4: escalate. `runProviderProcess`'s abort handler already calls
    // `child.kill()` on the SAME child; this host holds no direct
    // `ChildProcess` reference of its own to send a second, stronger signal
    // (e.g. SIGKILL) independently — re-invoking `abort()` is idempotent and
    // is the only escalation available at this layer. Stated as an honest
    // limitation of wrapping `runProviderProcess`, not silently assumed
    // equivalent to a real forced kill.
    tracked.abortController.abort();

    // Step 5: bounded confirmation period.
    if (await this.waitForFinish(tracked, this.terminationConfirmMs)) {
      return buildTerminationResult("forced_kill_confirmed", `process exited with code ${tracked.exitCode} after forced termination`);
    }

    // Step 6: never claim death that was never confirmed, and never block
    // forever — the caller (mission-process-recovery.ts) must not revoke a
    // lease or redispatch on this result.
    return buildTerminationResult("termination_timed_out", `termination requested but not confirmed within ${this.terminationGraceMs + this.terminationConfirmMs}ms`);
  }

  /** Polls `tracked.finished` at `terminationPollIntervalMs` cadence until true or `timeoutMs` elapses. Never a fixed sleep — returns as soon as completion is observed. */
  private async waitForFinish(tracked: TrackedProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tracked.finished) return true;
      await sleep(Math.min(this.terminationPollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    return tracked.finished;
  }

  async quarantine(environmentId: string): Promise<QuarantineResult> {
    const path = this.environmentPaths.get(environmentId);
    if (!path) {
      this.quarantined.add(environmentId);
      return { environmentId, quarantinedAt: new Date().toISOString(), retainedAt: null };
    }
    const quarantinedPath = `${path}.quarantined-${Date.now()}`;
    // `git worktree move` is the correct primitive here (not a plain fs
    // rename): it updates git's own admin metadata for the worktree along
    // with the directory, so the quarantined path remains a valid,
    // inspectable worktree rather than an orphaned directory git no longer
    // recognizes.
    await this.gitExecutor("git", ["worktree", "move", path, quarantinedPath], worktreeRepositoryRoot(path));
    this.environmentPaths.set(environmentId, quarantinedPath);
    this.quarantined.add(environmentId);
    return { environmentId, quarantinedAt: new Date().toISOString(), retainedAt: quarantinedPath };
  }

  async collect(handle: PersistableProcessHandle): Promise<HostOutput> {
    const tracked = this.processes.get(handle.executionId);
    if (!tracked) return { events: [], exitCode: null, truncated: false };
    return { events: [...tracked.events], exitCode: tracked.finished ? tracked.exitCode : null, truncated: tracked.truncated };
  }

  async cleanup(environmentId: string): Promise<void> {
    const path = this.environmentPaths.get(environmentId);
    if (!path) return;
    await this.gitExecutor("git", ["worktree", "remove", "--force", path], worktreeRepositoryRoot(path));
    this.environmentPaths.delete(environmentId);
  }

  // ---- test controls, not part of ProcessExecutionHost ----

  isQuarantined(environmentId: string): boolean {
    return this.quarantined.has(environmentId);
  }
}

function sanitizedEnvironmentId(instruction: { instructionId: string }): string {
  const safe = instruction.instructionId.replace(/[^a-zA-Z0-9._-]/g, "-");
  // worktreeSpecForGrant requires an 8+ char id shape; pad deterministically
  // rather than accept an id too short to satisfy it.
  const padded = safe.length >= 8 ? safe : `${safe}${"0".repeat(8 - safe.length)}`;
  worktreeSpecForGrant("/placeholder", padded); // throws if still invalid — fail fast, not at prepare()'s git call.
  return padded;
}

function worktreeRepositoryRoot(worktreePath: string): string {
  // `git worktree move/remove` must be invoked from a directory git
  // recognizes — the worktree's own directory works, since it's a fully
  // functional git working tree in its own right.
  return worktreePath;
}
