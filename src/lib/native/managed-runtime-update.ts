import type {
  ManagedProviderConnectionProfile,
  ManagedProviderConnectionSnapshot,
  ManagedProviderSupervisor,
} from "./managed-provider-contract";

export type ControlledRuntimeUpdatePhase =
  | "draining"
  | "stopping"
  | "replacing"
  | "verifying"
  | "starting"
  | "restoring"
  | "cleaning"
  | "succeeded"
  | "failed";

export type ControlledRuntimeUpdateSupervisor = Pick<
  ManagedProviderSupervisor,
  "drain" | "stop" | "restore" | "snapshots"
>;

export interface ControlledRuntimeUpdateOptions {
  supervisor: ControlledRuntimeUpdateSupervisor;
  /** Logical configuration is durable policy; provider process state is not. */
  profiles: readonly ManagedProviderConnectionProfile[];
  currentGeneration: string;
  drainTimeoutMs?: number;
  /** Called only when the normal drain exceeded its bound. */
  boundActiveWork?: () => Promise<void> | void;
  replaceStablePackage: () => Promise<{ generation: string }> | { generation: string };
  verifyStablePackage: (generation: string) => Promise<boolean | void> | boolean | void;
  startGeneration: (generation: string) => Promise<void> | void;
  cleanupRetiredArtifacts: () => Promise<{ remaining: readonly string[] }> | { remaining: readonly string[] };
  /** Restores the prior generation when the new package cannot complete the transaction. */
  rollbackStablePackage?: () => Promise<void> | void;
  onPhase?: (phase: ControlledRuntimeUpdatePhase) => void;
}

export interface ControlledRuntimeUpdateResult {
  readonly ok: boolean;
  readonly phase: "succeeded" | "failed";
  readonly phases: readonly ControlledRuntimeUpdatePhase[];
  readonly previousGeneration: string;
  readonly nextGeneration?: string;
  readonly activeWorkBound: boolean;
  readonly cleanupPending?: readonly string[];
  readonly restoredConnections?: readonly ManagedProviderConnectionSnapshot[];
  readonly error?: string;
}

function messageFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 512) || "controlled runtime update failed";
}

async function waitForDrain(
  drain: Promise<void>,
  timeoutMs: number,
): Promise<"completed" | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  try {
    const result = await Promise.race([drain.then(() => "completed" as const), timeout]);
    if (result === "timed_out") void drain.catch(() => undefined);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Coordinates the only safe runtime transition:
 * drain the exact owner connections, stop those connections, replace and
 * verify the stable package, start the new generation, restore logical
 * profiles with private continuation metadata, then prove retired artifacts
 * are gone. A healthy executable path alone can never make this succeed.
 */
export async function runControlledRuntimeUpdate(options: ControlledRuntimeUpdateOptions): Promise<ControlledRuntimeUpdateResult> {
  if (!options.currentGeneration.trim()) throw new Error("controlled runtime update requires a current generation");
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 10 * 60_000) {
    throw new Error("controlled runtime update drain timeout is invalid");
  }

  const phases: ControlledRuntimeUpdatePhase[] = [];
  let activeWorkBound = false;
  let nextGeneration: string | undefined;
  let cleanupPending: readonly string[] | undefined;
  let restoredConnections: readonly ManagedProviderConnectionSnapshot[] | undefined;
  let replacementApplied = false;

  const setPhase = (phase: ControlledRuntimeUpdatePhase): void => {
    phases.push(phase);
    options.onPhase?.(phase);
  };

  const failed = async (error: unknown): Promise<ControlledRuntimeUpdateResult> => {
    const original = messageFor(error);
    let finalError = original;
    if (replacementApplied && options.rollbackStablePackage) {
      try {
        await options.rollbackStablePackage();
        await options.startGeneration(options.currentGeneration);
        restoredConnections = await options.supervisor.restore(options.profiles);
      } catch (rollbackError) {
        finalError = `${original}; rollback/recovery also failed: ${messageFor(rollbackError)}`.slice(0, 1024);
      }
    }
    if (phases.at(-1) !== "failed") setPhase("failed");
    return {
      ok: false,
      phase: "failed",
      phases,
      previousGeneration: options.currentGeneration,
      ...(nextGeneration ? { nextGeneration } : {}),
      activeWorkBound,
      ...(cleanupPending ? { cleanupPending } : {}),
      ...(restoredConnections ? { restoredConnections } : {}),
      error: finalError,
    };
  };

  try {
    setPhase("draining");
    const drainResult = await waitForDrain(options.supervisor.drain(), drainTimeoutMs);
    if (drainResult === "timed_out") {
      if (!options.boundActiveWork) return await failed(new Error(`owner supervisor drain timed out after ${drainTimeoutMs}ms; replacement was not attempted`));
      await options.boundActiveWork();
      activeWorkBound = true;
    }

    setPhase("stopping");
    await options.supervisor.stop();

    setPhase("replacing");
    const replacement = await options.replaceStablePackage();
    if (!replacement || typeof replacement.generation !== "string" || !replacement.generation.trim() || replacement.generation === options.currentGeneration) {
      throw new Error("stable package replacement did not produce a new generation");
    }
    nextGeneration = replacement.generation;
    replacementApplied = true;

    setPhase("verifying");
    const verified = await options.verifyStablePackage(nextGeneration);
    if (verified === false) throw new Error(`stable package generation ${nextGeneration} failed verification`);

    setPhase("starting");
    await options.startGeneration(nextGeneration);

    setPhase("restoring");
    restoredConnections = await options.supervisor.restore(options.profiles);

    setPhase("cleaning");
    const cleanup = await options.cleanupRetiredArtifacts();
    if (!cleanup || !Array.isArray(cleanup.remaining)) throw new Error("runtime cleanup did not return a remaining-artifact list");
    cleanupPending = [...cleanup.remaining];
    if (cleanupPending.length > 0) throw new Error(`retired artifacts remain after update cleanup: ${cleanupPending.join(", ")}`);

    setPhase("succeeded");
    return {
      ok: true,
      phase: "succeeded",
      phases,
      previousGeneration: options.currentGeneration,
      nextGeneration,
      activeWorkBound,
      restoredConnections,
    };
  } catch (error) {
    return failed(error);
  }
}
