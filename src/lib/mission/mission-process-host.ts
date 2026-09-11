/**
 * Process execution host (Phase 3A)
 * ----------------------------------------------------------------------------
 * The lower-level boundary beneath `MissionDispatchRuntime`'s
 * `ExecutionHost` (`mission-dispatch-runtime.ts`, Phase 2D.2's `start/poll/
 * cancel`): where an OS process or provider session actually lives, how its
 * isolated environment (a worktree, a container, a sandbox) is prepared and
 * torn down, and — critically — how a RESTARTED Runtime determines whether
 * something it doesn't remember dispatching is still alive.
 *
 * Named `ProcessExecutionHost`, not `ExecutionHost`, specifically to avoid
 * colliding with the simpler, already-shipped-and-tested interface in
 * `mission-dispatch-runtime.ts`. That interface stays exactly as Phase 2D.2
 * left it; a concrete adapter composing a `ProcessExecutionHost` +
 * `ProviderAdapter` (see `mission-provider-adapter.ts`) underneath it is
 * integration work for a later pass, not part of this phase (see
 * IMPLEMENTATION_NOTES.md's Phase 3A section for why).
 *
 * Fencing (Phase 2D.1/2D.2) proves a lease's logical ownership and is
 * checked before any RESULT is accepted — but fencing does nothing to stop
 * a still-running process from touching a filesystem, making a git commit,
 * calling a network API, or spending credentials. THAT is what
 * `prepare`/`launch`/`terminate`/`quarantine` exist to bound: physical/
 * process isolation, independent of and in addition to logical fencing.
 */

import type { DispatchInstruction } from "./mission-scheduler-store";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Whether a failed-to-identify process can be safely abandoned without
 * further isolation work (a throwaway worktree/container nobody else can
 * reach) or must be treated as potentially still able to affect shared
 * state (a checked-out path on a shared filesystem, a long-lived sandbox
 * with real credentials). This is what `mission-process-recovery.ts`'s rule
 * 4 vs. rule 5 turns on.
 */
export const ENVIRONMENT_KINDS = ["disposable", "shared"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export interface HostPrepareInput {
  instruction: DispatchInstruction;
  /** e.g. a repository clone URL / local path the environment should be based on. Opaque to this layer. */
  repositoryRef: string | null;
}

export interface PreparedEnvironment {
  environmentId: string;
  kind: EnvironmentKind;
  /** e.g. a worktree path, a container id — opaque to callers above this layer. */
  workingDirectory: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Process identity — never a bare PID
// ---------------------------------------------------------------------------

/**
 * Durable, non-secret information sufficient to ask "is the thing I
 * launched still what I think it is?" after a restart. A bare OS PID is
 * NEVER sufficient identity on its own — PIDs are reused by the OS, so a
 * restarted host that finds SOME process at the recorded PID cannot tell a
 * live descendant of what it launched apart from an unrelated process the
 * OS later assigned the same number. `processStartedAtEpochMs` (or an
 * equivalent OS-provided start-time/generation marker) is what rules that
 * out — see `inspect`'s doc comment for how it's used.
 */
export interface PersistableProcessHandle {
  executionId: string;
  environmentId: string;
  /**
   * Carried on the handle itself (not looked up separately) so recovery
   * after a restart can decide quarantine-and-redispatch vs. block-and-
   * review without needing the host to have also persisted the
   * `PreparedEnvironment` record. Whether an environment is disposable or
   * shared is a property fixed at `prepare` time and never changes for
   * that environment's lifetime.
   */
  environmentKind: EnvironmentKind;
  /** Which physical/virtual host this was launched on — a PID is only meaningful relative to a specific machine. */
  hostIdentity: string;
  /** OS process id, or an underlying supervisor's own opaque process/task id — never trusted alone. */
  processId: string;
  /**
   * A value that changes if the OS reuses `processId` for an unrelated
   * process — e.g. the OS-reported process start time, or a supervisor
   * generation counter. Required precisely so a PID collision after reuse
   * is detectable as "this isn't my process" rather than misread as "my
   * process is still running."
   */
  processStartIdentity: string;
  createdAt: string;
  /** Which `ProviderAdapter.id` this process is running under (mission-provider-adapter.ts). */
  adapterId: string;
  /** The provider's own session identifier, when the provider exposes one and it's safe to persist (no secret material). Null otherwise. */
  providerSessionRef: string | null;
}

// ---------------------------------------------------------------------------
// Status determination — the five outcomes recovery decides between
// ---------------------------------------------------------------------------

/**
 * What `inspect` itself can determine, RAW — before any recovery action is
 * taken. Deliberately distinct from the five named OUTCOMES a recovery pass
 * reports (`RecoveryOutcomeKind`, `mission-process-recovery.ts`):
 * `process_reattached`/`process_terminated`/`environment_quarantined` are
 * things that happen AS A RESULT of acting on one of these raw facts, not
 * facts `inspect` could know before acting.
 */
export const PROCESS_STATUS_KINDS = [
  "process_confirmed_dead",
  "process_alive_reattachable",
  "process_alive_not_reattachable",
  "process_status_unknown",
] as const;
export type ProcessStatusKind = (typeof PROCESS_STATUS_KINDS)[number];

export interface HostProcessStatus {
  kind: ProcessStatusKind;
  detail: string;
  /** Set on `process_confirmed_dead` when the underlying process/environment did emit an exit code before this check. Null otherwise (e.g. genuinely unknown, or reattached and still running). */
  exitCode: number | null;
}

export interface ReattachedProcess {
  handle: PersistableProcessHandle;
  /** Whatever's been captured so far — a reattached execution does not lose its history. */
  partialOutput: HostOutput;
}

/**
 * Phase 4D Part 4 §3 — honest, confirmed termination outcomes.
 * `AbortController.abort()` (or any signal-based request) is a REQUEST, not
 * proof of exit — the previous `TerminationResult` shape (`terminated`/
 * `alreadyGone` booleans only) let `NodeProcessExecutionHost.terminate`
 * report `terminated: true` the instant it called `abort()`, before the
 * child process had actually exited. These eight kinds are what a caller
 * (`mission-process-recovery.ts`, `MissionDispatchRuntime`) must be able to
 * distinguish before deciding whether a lease may safely be revoked.
 */
export const TERMINATION_RESULT_KINDS = [
  "already_exited",
  "graceful_exit_confirmed",
  "forced_kill_confirmed",
  "termination_requested_unconfirmed",
  "termination_timed_out",
  "process_identity_mismatch",
  "process_not_found",
  "termination_state_unknown",
] as const;
export type TerminationResultKind = (typeof TERMINATION_RESULT_KINDS)[number];

/** Only these three kinds mean the process is CONFIRMED gone — the only kinds a caller may treat as safe to redispatch over. */
export const CONFIRMED_DEAD_TERMINATION_KINDS: readonly TerminationResultKind[] = ["already_exited", "graceful_exit_confirmed", "forced_kill_confirmed"];

export function isConfirmedDeadTermination(kind: TerminationResultKind): boolean {
  return CONFIRMED_DEAD_TERMINATION_KINDS.includes(kind);
}

export interface TerminationResult {
  kind: TerminationResultKind;
  /**
   * DERIVED from `kind` (`isConfirmedDeadTermination`), never set
   * independently — preserved so every pre-existing caller checking
   * `.terminated`/`.alreadyGone` keeps working unchanged, while new callers
   * should branch on `kind` for the full honest picture.
   */
  terminated: boolean;
  alreadyGone: boolean;
  detail: string;
}

/**
 * `terminated`/`alreadyGone` preserve the ORIGINAL boolean convention this
 * type had before `kind` existed: `terminated: true` means THIS CALL
 * accomplished a termination (`graceful_exit_confirmed`/`forced_kill_confirmed`
 * only) — NOT "is the process dead" in general, which is what
 * `isConfirmedDeadTermination(kind)` answers instead (and which also
 * includes `already_exited`, a state this call found rather than caused).
 * Every other kind (timed out, unconfirmed, identity mismatch, not found)
 * reports both booleans false — conservative by construction, never a
 * false claim of success.
 */
export function buildTerminationResult(kind: TerminationResultKind, detail: string): TerminationResult {
  const terminated = kind === "graceful_exit_confirmed" || kind === "forced_kill_confirmed";
  const alreadyGone = kind === "already_exited" || kind === "process_not_found";
  return { kind, terminated, alreadyGone, detail };
}

export interface QuarantineResult {
  environmentId: string;
  quarantinedAt: string;
  /** Where the quarantined environment now lives, if it's kept for forensic inspection rather than deleted outright. Null if discarded immediately. */
  retainedAt: string | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** One raw event as the underlying process/provider emitted it, before any adapter normalization. */
export interface HostOutputEvent {
  sequence: number;
  emittedAt: string;
  /** Opaque provider-specific payload — `ProviderAdapter.parseEvent` (mission-provider-adapter.ts) is the only thing that interprets this. */
  raw: unknown;
}

export interface HostOutput {
  events: HostOutputEvent[];
  /** Set once the process has actually finished; null while still running or status unknown. */
  exitCode: number | null;
  /** True if capture hit its cap and discarded later output — must be surfaced, never silently dropped. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface HostLaunchInput {
  instruction: DispatchInstruction;
  environment: PreparedEnvironment;
  /** What `ProviderAdapter.prepareInvocation` (mission-provider-adapter.ts) produced for this instruction. Opaque here. */
  invocation: unknown;
}

export interface ProcessExecutionHost {
  /** Create an isolated environment for one instruction. Must not launch anything yet. */
  prepare(input: HostPrepareInput): Promise<PreparedEnvironment>;
  /** Actually start the process/session. Must not block until completion. */
  launch(input: HostLaunchInput): Promise<PersistableProcessHandle>;
  /**
   * Non-blocking: what is currently true about this handle? MUST compare
   * `processStartIdentity`, not just `processId` — a PID match alone is
   * never sufficient to conclude the process is the one that was launched.
   */
  inspect(handle: PersistableProcessHandle): Promise<HostProcessStatus>;
  /**
   * Attempt to resume live supervision of a process this host (or a peer
   * instance of it) previously launched, after a restart. Only meaningful
   * when `inspect` would report something still running AND this host
   * implementation actually supports reattaching to it (not every process
   * kind can be reattached — e.g. a piped child process with no persistent
   * session survives a restart as, at best, an orphaned OS process with no
   * way to recover its stdout stream).
   */
  reattach(handle: PersistableProcessHandle): Promise<ReattachedProcess>;
  /** Best-effort termination. Must report `alreadyGone: true` rather than error when the process turns out to already be dead. */
  terminate(handle: PersistableProcessHandle): Promise<TerminationResult>;
  /** Isolate a disposable environment whose process status could not be determined, so it can never affect a later redispatch. */
  quarantine(environmentId: string): Promise<QuarantineResult>;
  /** Collect whatever output exists so far (or in full, once finished). Safe to call repeatedly. */
  collect(handle: PersistableProcessHandle): Promise<HostOutput>;
  /** Tear down a prepared environment once it's no longer needed — the counterpart to `prepare`. */
  cleanup(environmentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryProcessExecutionHost — a scriptable fake, NOT a real host
// ---------------------------------------------------------------------------

interface SimulatedProcess {
  handle: PersistableProcessHandle;
  /** Test-controlled: what `inspect` should currently report for this handle. */
  status: HostProcessStatus;
  events: HostOutputEvent[];
  exitCode: number | null;
  reattachSupported: boolean;
  terminated: boolean;
}

/**
 * Fully in-memory, fully test-controlled. Every method is synchronous
 * internally (no `await` between reading and mutating a process's state),
 * matching every other `InMemory*` reference implementation in this domain.
 * Lets tests simulate the exact process-status outcomes Phase 3A's recovery
 * model must branch on (`process_confirmed_dead`, `process_reattached`,
 * `process_terminated`, `environment_quarantined`, `process_status_unknown`)
 * without spawning anything real. NOT a provider adapter, NOT a real
 * process supervisor — see IMPLEMENTATION_NOTES.md's Phase 3A section for
 * the concrete file plan that wraps `src/lib/resident-provider-adapters.ts`
 * for that.
 */
export class InMemoryProcessExecutionHost implements ProcessExecutionHost {
  private readonly environments = new Map<string, PreparedEnvironment>();
  private readonly quarantined = new Set<string>();
  private readonly processes = new Map<string, SimulatedProcess>();
  private envSeq = 0;
  private handleSeq = 0;

  async prepare(input: HostPrepareInput): Promise<PreparedEnvironment> {
    this.envSeq += 1;
    const env: PreparedEnvironment = {
      environmentId: `env-${this.envSeq}`,
      kind: "disposable",
      workingDirectory: `/tmp/mission-${input.instruction.missionId}-${this.envSeq}`,
      createdAt: input.instruction.createdAt,
    };
    this.environments.set(env.environmentId, env);
    return env;
  }

  async launch(input: HostLaunchInput): Promise<PersistableProcessHandle> {
    this.handleSeq += 1;
    const handle: PersistableProcessHandle = {
      executionId: input.instruction.instructionId,
      environmentId: input.environment.environmentId,
      environmentKind: input.environment.kind,
      hostIdentity: "fake-host-1",
      processId: `pid-${this.handleSeq}`,
      processStartIdentity: `start-${this.handleSeq}`,
      createdAt: input.instruction.createdAt,
      adapterId: input.instruction.adapterRequirement ?? "unknown",
      providerSessionRef: null,
    };
    this.processes.set(handle.executionId, {
      handle,
      status: { kind: "process_status_unknown", detail: "just launched, no status scripted yet", exitCode: null },
      events: [],
      exitCode: null,
      reattachSupported: true,
      terminated: false,
    });
    return handle;
  }

  async inspect(handle: PersistableProcessHandle): Promise<HostProcessStatus> {
    const process = this.processes.get(handle.executionId);
    if (!process) return { kind: "process_confirmed_dead", detail: "no record of this execution at all", exitCode: null };
    if (process.handle.processStartIdentity !== handle.processStartIdentity) {
      // A PID match alone would have been misleading here — the identity
      // marker differs, so whatever is at that OS-level id now is NOT the
      // process this handle refers to. Treated as confirmed dead, never as
      // "found something, must be it."
      return { kind: "process_confirmed_dead", detail: "processStartIdentity mismatch — the recorded process is gone, this PID was reused", exitCode: null };
    }
    return process.status;
  }

  async reattach(handle: PersistableProcessHandle): Promise<ReattachedProcess> {
    const process = this.processes.get(handle.executionId);
    if (!process || !process.reattachSupported) {
      throw new Error(`Cannot reattach to execution ${handle.executionId} — not supported or not found.`);
    }
    return {
      handle: process.handle,
      partialOutput: { events: [...process.events], exitCode: process.exitCode, truncated: false },
    };
  }

  async terminate(handle: PersistableProcessHandle): Promise<TerminationResult> {
    const process = this.processes.get(handle.executionId);
    if (!process) return buildTerminationResult("process_not_found", "no in-memory record — nothing to terminate");
    if (process.handle.processStartIdentity !== handle.processStartIdentity) {
      return buildTerminationResult("process_identity_mismatch", "processStartIdentity mismatch — this is not the process the handle refers to");
    }
    if (process.status.kind === "process_confirmed_dead") {
      return buildTerminationResult("already_exited", "process was already gone");
    }
    process.terminated = true;
    process.status = { kind: "process_confirmed_dead", detail: "terminated by host", exitCode: null };
    return buildTerminationResult("graceful_exit_confirmed", "process terminated and confirmed");
  }

  async quarantine(environmentId: string): Promise<QuarantineResult> {
    this.quarantined.add(environmentId);
    return { environmentId, quarantinedAt: new Date().toISOString(), retainedAt: null };
  }

  async collect(handle: PersistableProcessHandle): Promise<HostOutput> {
    const process = this.processes.get(handle.executionId);
    if (!process) return { events: [], exitCode: null, truncated: false };
    return { events: [...process.events], exitCode: process.exitCode, truncated: false };
  }

  async cleanup(environmentId: string): Promise<void> {
    this.environments.delete(environmentId);
  }

  // ---- test controls, not part of ProcessExecutionHost ----

  isQuarantined(environmentId: string): boolean {
    return this.quarantined.has(environmentId);
  }

  /** Script what `inspect` reports for a given handle. */
  setStatus(handle: PersistableProcessHandle, status: HostProcessStatus): void {
    const process = this.processes.get(handle.executionId);
    if (process) process.status = status;
  }

  setReattachSupported(handle: PersistableProcessHandle, supported: boolean): void {
    const process = this.processes.get(handle.executionId);
    if (process) process.reattachSupported = supported;
  }

  /** Script `collect`'s exit code directly — the completion signal a real host's `collect` would eventually report once its process exits. */
  setExitCode(handle: PersistableProcessHandle, exitCode: number, events: HostOutputEvent[] = []): void {
    const process = this.processes.get(handle.executionId);
    if (!process) return;
    process.exitCode = exitCode;
    process.events = events;
  }

  /** Append output WITHOUT setting an exit code — simulates output arriving incrementally while the process is still running. */
  appendEvents(handle: PersistableProcessHandle, events: HostOutputEvent[]): void {
    const process = this.processes.get(handle.executionId);
    if (!process) return;
    process.events.push(...events);
  }
}
