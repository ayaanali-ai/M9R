export interface ResidentProcessHandle {
  kill(): void;
}

/**
 * A resident deliberately exits with this code when it detects the on-disk
 * build is newer than the one it started with (see checkBuildFreshness in
 * scripts/oathlock-cli.ts). This is a planned, expected exit -- the process
 * is asking to be relaunched with fresh code, not reporting a failure -- so
 * it must be relaunched immediately and must never count against the crash
 * restart budget below. A rebuild-heavy dev session restarting residents
 * several times a minute is normal and must never trip the same breaker a
 * real crash loop trips.
 */
export const RESIDENT_STALE_BUILD_EXIT_CODE = 87;

export interface ResidentScheduleHandle {
  cancel(): void;
}

export type ResidentSupervisorState = "idle" | "running" | "backoff" | "failed" | "stopped";

export interface ResidentSupervisorSnapshot {
  profile: string;
  state: ResidentSupervisorState;
  restarts: number;
}

interface SupervisedResident {
  profile: string;
  state: ResidentSupervisorState;
  /** Timestamps (ms) of restarts within the current window -- a sliding window, not a lifetime counter, so a resident that crashed 3 times last week and has been fine since doesn't stay permanently locked out today. Mirrors acp-client.ts's recoverSessionInternal, which solves the exact same problem for ACP session recovery. */
  restarts: number[];
  generation: number;
  process: ResidentProcessHandle | null;
  scheduled: ResidentScheduleHandle | null;
}

const PROFILE_NAME = /^[a-zA-Z0-9._:-]{1,100}$/;

export function residentProfileNames(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const profiles = (config as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return [];
  return [...new Set(profiles.flatMap((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return [];
    const name = (profile as { name?: unknown }).name;
    return typeof name === "string" && PROFILE_NAME.test(name) ? [name] : [];
  }))];
}

/**
 * Owns one long-lived resident process per configured provider profile.
 * Restarts are bounded so a broken provider cannot consume limits forever.
 */
export function createResidentSupervisor(options: {
  profiles: string[];
  launch(profile: string, onExit: (code: number | null) => void): ResidentProcessHandle;
  schedule(callback: () => void, delayMs: number): ResidentScheduleHandle;
  restartDelayMs?: number;
  maxRestarts?: number;
  /** Rolling window the restart budget is measured against. Default 5 minutes -- long enough that a real crash loop (several failures in quick succession) still trips it, short enough that sporadic, unrelated crashes days apart don't add up to a permanent lockout. */
  restartWindowMs?: number;
  /**
   * Fires on every state transition -- in particular the one transition
   * nothing previously observed: entering "failed". Before this, a resident
   * that exhausted its restart budget went silent with no signal anywhere
   * except a human noticing the agent had stopped responding (confirmed live
   * this session with claude-gate11e). now(profile, state)
   */
  onStateChange?(profile: string, state: ResidentSupervisorState): void;
  now?(): number;
}) {
  const restartDelayMs = options.restartDelayMs ?? 5_000;
  const maxRestarts = options.maxRestarts ?? 3;
  const restartWindowMs = Math.max(1_000, options.restartWindowMs ?? 5 * 60_000);
  const now = options.now ?? Date.now;
  let residents = [...new Set(options.profiles.filter((name) => PROFILE_NAME.test(name)))].map<SupervisedResident>((profile) => ({
    profile,
    state: "idle",
    restarts: [],
    generation: 0,
    process: null,
    scheduled: null,
  }));
  let stopped = false;
  let started = false;

  function setState(resident: SupervisedResident, state: ResidentSupervisorState): void {
    resident.state = state;
    options.onStateChange?.(resident.profile, state);
  }

  /** Prunes to the current window, records a fresh restart, and reports whether the budget is now exhausted. */
  function recordRestartAttempt(resident: SupervisedResident): boolean {
    const nowMs = now();
    resident.restarts = resident.restarts.filter((attempt) => nowMs - attempt < restartWindowMs);
    if (resident.restarts.length >= maxRestarts) return true;
    resident.restarts.push(nowMs);
    return false;
  }

  function launch(resident: SupervisedResident): void {
    if (stopped || resident.state === "running") return;
    resident.scheduled = null;
    const generation = ++resident.generation;
    try {
      const process = options.launch(resident.profile, (code) => {
        if (stopped || generation !== resident.generation) return;
        resident.process = null;
        if (code === 0) {
          setState(resident, "stopped");
          return;
        }
        if (code === RESIDENT_STALE_BUILD_EXIT_CODE) {
          // Planned self-restart for fresh code -- relaunch right away, no
          // backoff delay and no budget consumed, same as a human manually
          // restarting it after a rebuild.
          setState(resident, "backoff");
          resident.scheduled = options.schedule(() => launch(resident), 0);
          return;
        }
        if (recordRestartAttempt(resident)) {
          setState(resident, "failed");
          return;
        }
        setState(resident, "backoff");
        resident.scheduled = options.schedule(() => launch(resident), restartDelayMs);
      });
      resident.process = process;
      setState(resident, "running");
    } catch {
      resident.process = null;
      if (recordRestartAttempt(resident)) {
        setState(resident, "failed");
        return;
      }
      setState(resident, "backoff");
      resident.scheduled = options.schedule(() => launch(resident), restartDelayMs);
    }
  }

  return {
    start(): void {
      if (stopped) return;
      started = true;
      for (const resident of residents) if (resident.state === "idle") launch(resident);
    },

    /**
     * Reconcile the long-lived runtime with profiles added after it started.
     * Connecting Claude after Codex must not require killing the shared
     * listener or manually starting a second runtime process.
     */
    syncProfiles(profiles: string[]): void {
      if (stopped) return;
      const nextProfiles = [...new Set(profiles.filter((name) => PROFILE_NAME.test(name)))];
      const nextSet = new Set(nextProfiles);
      for (const resident of residents) {
        if (nextSet.has(resident.profile)) continue;
        resident.generation += 1;
        resident.scheduled?.cancel();
        resident.scheduled = null;
        resident.process?.kill();
        resident.process = null;
        setState(resident, "stopped");
      }
      const existing = new Map(residents.filter((resident) => nextSet.has(resident.profile)).map((resident) => [resident.profile, resident]));
      residents = nextProfiles.map((profile) => existing.get(profile) ?? {
        profile,
        state: "idle" as ResidentSupervisorState,
        restarts: [],
        generation: 0,
        process: null,
        scheduled: null,
      });
      if (started) for (const resident of residents) if (resident.state === "idle") launch(resident);
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const resident of residents) {
        resident.scheduled?.cancel();
        resident.scheduled = null;
        const process = resident.process;
        resident.process = null;
        setState(resident, "stopped");
        process?.kill();
      }
    },

    snapshot(): ResidentSupervisorSnapshot[] {
      return residents.map(({ profile, state, restarts }) => ({ profile, state, restarts: restarts.length }));
    },

    /**
     * Clears the restart budget and relaunches every resident stuck in
     * "failed" -- the only way out of that state today is killing this whole
     * process. Exists for a remote "reconnect my agents" trigger: a human
     * clicking a dashboard button has no other way to unstick a bridge that
     * exhausted its budget hours ago without restarting their machine.
     */
    /**
     * Returns which profiles were actually retried, not just whether the call
     * ran -- a remote "reconnect" request has no other way to tell a real
     * human whether it found something stuck to fix or nothing needed it.
     */
    retryFailed(): string[] {
      if (stopped) return [];
      const retried: string[] = [];
      for (const resident of residents) {
        if (resident.state !== "failed") continue;
        resident.restarts = [];
        setState(resident, "idle");
        launch(resident);
        retried.push(resident.profile);
      }
      return retried;
    },
  };
}
