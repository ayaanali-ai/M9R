import { createHash } from "node:crypto";
import { detectInstalledAgents, type VersionProbe } from "../agent-detection-core";

/**
 * Provider-neutral compatibility evidence. This module deliberately does not
 * start providers, rewrite their configuration, or own the CLI/MCP transport.
 * It turns observations into a stable record and a conservative reconciliation
 * plan for the runtime that will consume it later.
 */
export const PROVIDER_UPDATE_COMPATIBILITY_VERSION = "m9r.provider-update-compat.v1" as const;

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FULL_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_IN_TEXT_PATTERN = /(?:^|[^\d])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?!\d)/i;

export interface ProviderRuntimeObservationInput {
  /** Stable provider slug, not a session id, token, or display label. */
  providerId: string;
  /** Executable name or path as observed by the caller. */
  binary: string;
  /** Raw first line from the provider's side-effect-free version probe. */
  versionLine: string;
  /** Resolved executable path when the caller has one; never required. */
  executablePath?: string | null;
  /** The transport remains caller-owned; this layer accepts future values. */
  transport?: string;
  /** M9R adapter contract observed alongside the provider. */
  adapterContractVersion?: string | null;
  /** Capability manifest observed alongside the provider. */
  capabilityManifestVersion?: string | null;
  /** Opaque digest of relevant provider configuration; never raw credentials. */
  configFingerprint?: string | null;
  observedAtMs: number;
}

export interface ProviderRuntimeObservation {
  schema: typeof PROVIDER_UPDATE_COMPATIBILITY_VERSION;
  providerId: string;
  binary: string;
  versionLine: string;
  version: string | null;
  executablePath: string | null;
  transport: string;
  adapterContractVersion: string | null;
  capabilityManifestVersion: string | null;
  configFingerprint: string | null;
  observedAtMs: number;
  /** SHA-256 over non-secret identity/config digests; timestamp is excluded. */
  fingerprint: string;
}

export type ProviderRuntimeChangeKind =
  | "first_seen"
  | "unchanged"
  | "provider_updated"
  | "provider_downgraded"
  | "installation_replaced"
  | "adapter_changed"
  | "configuration_changed"
  | "provider_changed"
  | "unavailable";

export type ProviderRuntimeChangeReason =
  | "first_observation"
  | "provider_version"
  | "installation"
  | "adapter_contract"
  | "configuration"
  | "observation_unavailable"
  | "observation_changed";

export interface ProviderRuntimeComparison {
  kind: ProviderRuntimeChangeKind;
  reasons: readonly ProviderRuntimeChangeReason[];
  previousFingerprint: string | null;
  currentFingerprint: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
}

export type ProviderReconciliationAction =
  | "initialize_connection"
  | "reuse_connection"
  | "refresh_adapter_and_reconnect"
  | "rebind_replaced_installation"
  | "wait_without_mutation"
  | "hold_without_mutation";

export interface ProviderReconciliationPlan {
  action: ProviderReconciliationAction;
  /** Provider updates must not turn into a manual M9R reconnect ritual. */
  userActionRequired: false;
  /** Durable M9R task state is retained while the provider is reconciled. */
  preserveDurableTaskState: true;
  /** The existing CLI/MCP route remains the transport boundary. */
  preserveExistingCliMcpPath: true;
  /** A replacement is healthy before the old connection/worker is retired. */
  waitForHealthyReplacementBeforeRetiring: true;
  reason: string;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function boundedText(name: string, value: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) throw new Error(`${name} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  if (normalized.includes("\0")) throw new Error(`${name} contains an invalid NUL character`);
  return normalized;
}

function nullableBoundedText(name: string, value: string | null | undefined, maxLength: number): string | null {
  if (value == null) return null;
  return boundedText(name, value, maxLength, true) || null;
}

function normalizeConfigFingerprint(value: string | null | undefined): string | null {
  const fingerprint = nullableBoundedText("configFingerprint", value, 256);
  if (fingerprint === null) return null;
  if (!/^sha256:[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error("configFingerprint must be a sha256:<64-hex> digest, never raw configuration or credentials");
  }
  return fingerprint.toLowerCase();
}

function normalizeProviderId(value: string): string {
  const providerId = boundedText("providerId", value, 64).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("providerId must be a lowercase provider slug");
  return providerId;
}

function parseFullVersion(value: string | null): ParsedVersion | null {
  if (!value) return null;
  const match = FULL_VERSION_PATTERN.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  return { core, prerelease: match[4] ? match[4].split(".") : [] };
}

/** Extracts a comparable semver-like version from any provider's version line. */
export function extractProviderVersion(versionLine: string): string | null {
  const line = boundedText("versionLine", versionLine, 512, true);
  const match = VERSION_IN_TEXT_PATTERN.exec(line);
  const version = match?.[1] ?? null;
  return parseFullVersion(version) ? version : null;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;
    if (aNumber !== null && bNumber !== null) return aNumber < bNumber ? -1 : 1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Returns null when either provider version is not safely comparable. */
export function compareProviderVersions(left: string | null, right: string | null): -1 | 0 | 1 | null {
  const a = parseFullVersion(left);
  const b = parseFullVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function fingerprintFor(observation: Omit<ProviderRuntimeObservation, "fingerprint" | "observedAtMs">): string {
  const stable = JSON.stringify({
    schema: observation.schema,
    providerId: observation.providerId,
    binary: observation.binary,
    versionLine: observation.versionLine,
    version: observation.version,
    executablePath: observation.executablePath,
    transport: observation.transport,
    adapterContractVersion: observation.adapterContractVersion,
    capabilityManifestVersion: observation.capabilityManifestVersion,
    configFingerprint: observation.configFingerprint,
  });
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

export function normalizeProviderRuntimeObservation(input: ProviderRuntimeObservationInput): ProviderRuntimeObservation {
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) throw new Error("observedAtMs must be a non-negative safe integer");
  const normalized: Omit<ProviderRuntimeObservation, "fingerprint" | "observedAtMs"> = {
    schema: PROVIDER_UPDATE_COMPATIBILITY_VERSION,
    providerId: normalizeProviderId(input.providerId),
    binary: boundedText("binary", input.binary, 1024),
    versionLine: boundedText("versionLine", input.versionLine, 512, true),
    version: extractProviderVersion(input.versionLine),
    executablePath: nullableBoundedText("executablePath", input.executablePath, 2048),
    transport: boundedText("transport", input.transport ?? "cli-mcp", 64),
    adapterContractVersion: nullableBoundedText("adapterContractVersion", input.adapterContractVersion, 128),
    capabilityManifestVersion: nullableBoundedText("capabilityManifestVersion", input.capabilityManifestVersion, 128),
    configFingerprint: normalizeConfigFingerprint(input.configFingerprint),
  };
  return {
    ...normalized,
    observedAtMs: input.observedAtMs,
    fingerprint: fingerprintFor(normalized),
  };
}

function installationChanged(previous: ProviderRuntimeObservation, current: ProviderRuntimeObservation): boolean {
  return previous.providerId !== current.providerId
    || previous.binary !== current.binary
    || previous.transport !== current.transport
    || (previous.executablePath !== null && current.executablePath !== null && previous.executablePath !== current.executablePath);
}

export function classifyProviderRuntime(
  previous: ProviderRuntimeObservation | undefined,
  current: ProviderRuntimeObservation | null,
): ProviderRuntimeComparison {
  if (current === null) {
    return {
      kind: "unavailable",
      reasons: ["observation_unavailable"],
      previousFingerprint: previous?.fingerprint ?? null,
      currentFingerprint: null,
      previousVersion: previous?.version ?? null,
      currentVersion: null,
    };
  }
  if (!previous) {
    return {
      kind: "first_seen",
      reasons: ["first_observation"],
      previousFingerprint: null,
      currentFingerprint: current.fingerprint,
      previousVersion: null,
      currentVersion: current.version,
    };
  }
  if (previous.fingerprint === current.fingerprint) {
    return {
      kind: "unchanged",
      reasons: [],
      previousFingerprint: previous.fingerprint,
      currentFingerprint: current.fingerprint,
      previousVersion: previous.version,
      currentVersion: current.version,
    };
  }

  const reasons: ProviderRuntimeChangeReason[] = ["observation_changed"];
  const installationWasReplaced = installationChanged(previous, current);
  const adapterChanged = previous.adapterContractVersion !== current.adapterContractVersion
    || previous.capabilityManifestVersion !== current.capabilityManifestVersion;
  const configurationChanged = previous.configFingerprint !== current.configFingerprint;
  const versionComparison = compareProviderVersions(previous.version, current.version);
  if (installationWasReplaced) reasons.push("installation");
  if (adapterChanged) reasons.push("adapter_contract");
  if (configurationChanged) reasons.push("configuration");
  if (versionComparison !== 0) reasons.push("provider_version");

  let kind: ProviderRuntimeChangeKind;
  if (installationWasReplaced) kind = "installation_replaced";
  else if (versionComparison === 1) kind = "provider_downgraded";
  else if (versionComparison === -1) kind = "provider_updated";
  else if (adapterChanged) kind = "adapter_changed";
  else if (configurationChanged) kind = "configuration_changed";
  else kind = "provider_changed";

  return {
    kind,
    reasons,
    previousFingerprint: previous.fingerprint,
    currentFingerprint: current.fingerprint,
    previousVersion: previous.version,
    currentVersion: current.version,
  };
}

export function planProviderReconciliation(comparison: ProviderRuntimeComparison): ProviderReconciliationPlan {
  const shared = {
    userActionRequired: false as const,
    preserveDurableTaskState: true as const,
    preserveExistingCliMcpPath: true as const,
    waitForHealthyReplacementBeforeRetiring: true as const,
  };

  switch (comparison.kind) {
    case "first_seen":
      return { ...shared, action: "initialize_connection", reason: "First provider observation; initialize through the existing transport boundary." };
    case "unchanged":
      return { ...shared, action: "reuse_connection", reason: "Provider identity and compatibility evidence are unchanged; reuse the current connection." };
    case "provider_updated":
      return { ...shared, action: "refresh_adapter_and_reconnect", reason: "Provider version advanced; refresh compatibility state and reconnect without dropping durable work." };
    case "provider_downgraded":
      return { ...shared, action: "rebind_replaced_installation", reason: "Provider version moved backwards; reconcile the installation conservatively and keep durable work." };
    case "installation_replaced":
      return { ...shared, action: "rebind_replaced_installation", reason: "The provider installation identity changed; bind the replacement only after it is healthy." };
    case "adapter_changed":
    case "configuration_changed":
    case "provider_changed":
      return { ...shared, action: "refresh_adapter_and_reconnect", reason: "Compatibility evidence changed; refresh the provider-neutral adapter state without changing the CLI/MCP route." };
    case "unavailable":
      return { ...shared, action: "wait_without_mutation", reason: "The provider is temporarily unavailable; retain state and wait for a new observation." };
  }
}

export function observationFromDetectedAgent(
  agent: { kind: string; binary: string; versionLine: string },
  observedAtMs: number,
): ProviderRuntimeObservation {
  return normalizeProviderRuntimeObservation({
    providerId: agent.kind,
    binary: agent.binary,
    versionLine: agent.versionLine,
    transport: "cli-mcp",
    observedAtMs,
  });
}

/**
 * Feeds the existing side-effect-free CLI probes into the compatibility layer.
 * This is additive: callers that only need the legacy DetectedAgent records
 * continue to use detectInstalledAgents unchanged.
 */
export async function detectProviderRuntimeObservations(
  probe: VersionProbe,
  observedAtMs: number,
): Promise<ProviderRuntimeObservation[]> {
  const detected = await detectInstalledAgents(probe);
  return detected.map((agent) => observationFromDetectedAgent(agent, observedAtMs));
}
