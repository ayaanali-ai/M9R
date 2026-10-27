import { posix, win32 } from "node:path";

/**
 * The provider-neutral lifecycle states owned by M9R. Provider adapters may
 * use different wire protocols, but they must report through this state
 * vocabulary to the supervisor and its UI consumers.
 */
export type ManagedProviderStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "working"
  | "paused"
  | "draining"
  | "failed";

export interface ManagedProviderConnectionProfileInput {
  /** Optional explicit logical identity for a deliberately separate slot. */
  connectionId?: string;
  handle: string;
  provider: string;
  /** Must be an absolute project folder; aliases are normalized before routing. */
  cwd: string;
  model?: string;
  effort?: string;
}
export interface ManagedProviderConnectionProfile {
  readonly connectionId: string;
  readonly handle: string;
  readonly provider: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface ManagedProviderConnectionSelectionInput {
  /** Optional agent identity narrows a deliberately separate handle slot. */
  handle?: string;
  provider: string;
  cwd: string;
  /** Explicit logical identity is required when otherwise-identical slots coexist. */
  connectionId?: string;
}

export type ManagedProviderConnectionSelection =
  | { readonly kind: "selected"; readonly profile: ManagedProviderConnectionProfile }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly profiles: readonly ManagedProviderConnectionProfile[] };

/** Private continuation metadata; never include this in a public snapshot or pill event. */
export interface ManagedProviderContinuation {
  readonly providerSessionRef?: string;
}

export interface ManagedProviderTask {
  readonly taskId: string;
  readonly connectionId: string;
  readonly handle: string;
  readonly provider: string;
  readonly cwd: string;
  readonly generation: number;
  readonly prompt: string;
}

export interface ManagedProviderReady {
  readonly connectionId: string;
  readonly generation: number;
  readonly continuation?: ManagedProviderContinuation;
}

export type ManagedProviderEvent =
  /** The provider transport has accepted the prompt for this connection. */
  | { readonly kind: "accepted" }
  | { readonly kind: "status"; readonly status: ManagedProviderStatus; readonly doing?: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly summary?: string }
  | { readonly kind: "result"; readonly text: string; readonly isError: boolean }
  | { readonly kind: "error"; readonly error: string; readonly retryable: boolean };

/**
 * Public-safe connection state. Process IDs, tokens, and provider continuation
 * references deliberately do not appear here.
 */
export interface ManagedProviderConnectionSnapshot {
  readonly connectionId: string;
  readonly handle: string;
  readonly provider: string;
  readonly cwd: string;
  readonly status: ManagedProviderStatus;
  readonly generation: number;
  readonly activeTaskId?: string;
  readonly doing?: string;
}

/**
 * The adapter contract shared by Claude, Codex, OpenCode, and future providers.
 * `pause` and `resume` govern M9R acceptance of new work; they do not pretend
 * that every provider has an identical native pause primitive.
 */
export interface ManagedProviderConnection {
  readonly profile: ManagedProviderConnectionProfile;
  start(continuation?: ManagedProviderContinuation): Promise<ManagedProviderReady>;
  send(task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent>;
  cancel(taskId: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): ManagedProviderConnectionSnapshot;
  /** Private resume metadata for the owner supervisor; never expose it in a public snapshot. */
  continuation(): ManagedProviderContinuation | undefined;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

/** One M9R-owned lifecycle/controller containing isolated provider connections. */
export interface ManagedProviderSupervisor {
  ensureConnection(
    profile: ManagedProviderConnectionProfile,
    continuation?: ManagedProviderContinuation,
  ): Promise<ManagedProviderConnection>;
  dispatch(task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent>;
  cancel(connectionId: string, taskId: string): Promise<void>;
  pause(connectionId: string): Promise<void>;
  resume(connectionId: string): Promise<void>;
  snapshots(): readonly ManagedProviderConnectionSnapshot[];
  drain(): Promise<void>;
  stop(): Promise<void>;
  /** Start the same logical profiles again after a controlled runtime replacement. */
  restore(profiles?: readonly ManagedProviderConnectionProfile[]): Promise<readonly ManagedProviderConnectionSnapshot[]>;
}

const HANDLE_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_.:%-]{1,512}$/;

function normalizeHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_PATTERN.test(handle) || handle === "all" || handle === "you") {
    throw new Error(`managed provider handle must be a concrete agent identity: ${JSON.stringify(value)}`);
  }
  return handle;
}

function normalizeProvider(value: string): string {
  const provider = value.trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error(`managed provider name is invalid: ${JSON.stringify(value)}`);
  }
  return provider;
}

function normalizeCwd(value: string): string {
  const cwd = value.trim();
  if (!cwd || (!win32.isAbsolute(cwd) && !posix.isAbsolute(cwd))) {
    throw new Error("managed provider cwd must be an absolute project folder");
  }
  const slashed = cwd.replace(/\\/g, "/");
  const normalized = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  if (normalized === "/" || /^[a-z]:$/i.test(normalized)) {
    throw new Error("managed provider cwd must identify a project folder, not a filesystem root");
  }
  return normalized.toLowerCase();
}

function defaultConnectionId(handle: string, provider: string, cwd: string): string {
  return `m9r:${handle}:${provider}:${encodeURIComponent(cwd)}`;
}

/** Normalize the identity fields before a profile can enter the supervisor. */
export function normalizeManagedProviderProfile(input: ManagedProviderConnectionProfileInput): ManagedProviderConnectionProfile {
  const handle = normalizeHandle(input.handle);
  const provider = normalizeProvider(input.provider);
  const cwd = normalizeCwd(input.cwd);
  const connectionId = input.connectionId?.trim() || defaultConnectionId(handle, provider, cwd);
  if (!CONNECTION_ID_PATTERN.test(connectionId)) {
    throw new Error("managed provider connection ID contains unsupported characters");
  }
  const model = input.model?.trim() || undefined;
  const effort = input.effort?.trim() || undefined;
  return { connectionId, handle, provider, cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * Select a managed connection without consulting process IDs or recency.
 * Provider plus normalized project folder is the compatibility identity; an
 * explicit logical connection ID is the only way to choose between deliberate
 * same-provider/same-folder slots. A missing or ambiguous match fails closed.
 */
export function selectManagedProviderProfile(
  profiles: readonly ManagedProviderConnectionProfile[],
  input: ManagedProviderConnectionSelectionInput,
): ManagedProviderConnectionSelection {
  let provider: string;
  let cwd: string;
  let handle: string | undefined;
  try {
    provider = normalizeProvider(input.provider);
    cwd = normalizeCwd(input.cwd);
    handle = input.handle === undefined ? undefined : normalizeHandle(input.handle);
  } catch (error) {
    return { kind: "none", reason: error instanceof Error ? error.message : "managed provider selector is invalid" };
  }

  const matching = profiles.filter((profile) => profile.provider === provider
    && profile.cwd === cwd
    && (handle === undefined || profile.handle === handle));
  const requestedConnectionId = input.connectionId?.trim();
  const scoped = requestedConnectionId
    ? matching.filter((profile) => profile.connectionId === requestedConnectionId)
    : matching;
  if (scoped.length === 1) return { kind: "selected", profile: scoped[0]! };
  if (scoped.length > 1) return { kind: "ambiguous", profiles: scoped };
  return {
    kind: "none",
    reason: requestedConnectionId
      ? "no managed connection matched the explicit connection ID, provider, and project folder"
      : "no managed connection matched the provider and project folder",
  };
}

export type ManagedProviderTaskValidation = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Validate the routing envelope before an adapter sees a task. This prevents a
 * task from crossing provider, folder, connection, or runtime-generation
 * boundaries even when a caller has stale local state.
 */
export function validateManagedProviderTask(
  task: ManagedProviderTask,
  profile: ManagedProviderConnectionProfile,
  expectedGeneration: number,
): ManagedProviderTaskValidation {
  if (!task.taskId.trim()) return { ok: false, error: "managed provider task ID is required" };
  if (!task.prompt.trim()) return { ok: false, error: "managed provider task prompt is required" };
  if (task.connectionId !== profile.connectionId) return { ok: false, error: "task connection does not match the selected provider connection" };
  if (task.handle !== profile.handle || task.provider !== profile.provider) return { ok: false, error: "task provider identity does not match the selected connection" };
  let taskCwd: string;
  try { taskCwd = normalizeCwd(task.cwd); } catch { return { ok: false, error: "task cwd is not an absolute project folder" }; }
  if (taskCwd !== profile.cwd) return { ok: false, error: "task project folder does not match the selected provider connection" };
  if (!Number.isSafeInteger(task.generation) || task.generation !== expectedGeneration) return { ok: false, error: "task runtime generation is stale" };
  return { ok: true };
}
