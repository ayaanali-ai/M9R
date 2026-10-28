/**
 * Phase 9 runtime-readiness cache.
 *
 * This is deliberately a proof cache, not a `ready = true` flag. A record is
 * reusable only when every identity component that can change underneath a
 * provider connection still matches: logical handle, provider, project folder,
 * runtime generation, build fingerprint, and broker epoch. The cache contains
 * no process IDs, credentials, continuation values, or provider output.
 */

export type RuntimeReadinessInvalidationReason =
  | "process-exit"
  | "broker-restart"
  | "build-change"
  | "health-failure"
  | "transport-error"
  | "manual";

export interface RuntimeReadinessIdentity {
  readonly connectionId: string;
  readonly handle: string;
  readonly provider: string;
  readonly cwd: string;
  readonly generation: number;
  readonly buildFingerprint: string;
}

export interface RuntimeReadinessRecord extends RuntimeReadinessIdentity {
  readonly brokerEpoch: number;
  readonly verifiedAt: number;
}

export type RuntimeReadinessVerification =
  | { readonly ok: true; readonly record: RuntimeReadinessRecord }
  | { readonly ok: false; readonly reason: "unhealthy" | "identity-mismatch" | "invalid-generation" };

export interface RuntimeReadinessCache {
  epoch(): number;
  verify(identity: RuntimeReadinessIdentity, healthy: boolean, at?: number): RuntimeReadinessVerification;
  isValid(identity: RuntimeReadinessIdentity): boolean;
  get(connectionId: string): RuntimeReadinessRecord | undefined;
  invalidate(connectionId: string, reason: RuntimeReadinessInvalidationReason): void;
  invalidateAll(reason: RuntimeReadinessInvalidationReason): void;
  restartBroker(): void;
  changeBuild(buildFingerprint: string): void;
}

export interface RuntimeReadinessCacheOptions {
  readonly now?: () => number;
  readonly buildFingerprint?: string;
}

function cleanFingerprint(value: string): string {
  const fingerprint = value.trim();
  return fingerprint.length > 0 && fingerprint.length <= 256 ? fingerprint : "unknown";
}

function sameIdentity(left: RuntimeReadinessIdentity, right: RuntimeReadinessIdentity): boolean {
  return left.connectionId === right.connectionId
    && left.handle === right.handle
    && left.provider === right.provider
    && left.cwd === right.cwd
    && left.generation === right.generation
    && left.buildFingerprint === right.buildFingerprint;
}

/** Create one in-memory cache per broker owner. Restarting the broker creates a new epoch. */
export function createRuntimeReadinessCache(options: RuntimeReadinessCacheOptions = {}): RuntimeReadinessCache {
  const now = options.now ?? Date.now;
  let brokerEpoch = 1;
  let buildFingerprint = cleanFingerprint(options.buildFingerprint ?? "unknown");
  const records = new Map<string, RuntimeReadinessRecord>();

  const invalidateAll = (_reason: RuntimeReadinessInvalidationReason): void => {
    records.clear();
  };

  return {
    epoch: () => brokerEpoch,
    verify(identity, healthy, at = now()) {
      if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
        records.delete(identity.connectionId);
        return { ok: false, reason: "invalid-generation" };
      }
      const normalized = { ...identity, buildFingerprint: cleanFingerprint(identity.buildFingerprint) };
      if (!healthy) {
        records.delete(identity.connectionId);
        return { ok: false, reason: "unhealthy" };
      }
      if (normalized.buildFingerprint !== buildFingerprint) {
        records.delete(identity.connectionId);
        return { ok: false, reason: "identity-mismatch" };
      }
      const record: RuntimeReadinessRecord = { ...normalized, brokerEpoch, verifiedAt: Math.max(0, at) };
      records.set(identity.connectionId, record);
      return { ok: true, record };
    },
    isValid(identity) {
      const record = records.get(identity.connectionId);
      return record !== undefined
        && record.brokerEpoch === brokerEpoch
        && record.buildFingerprint === buildFingerprint
        && sameIdentity(record, { ...identity, buildFingerprint: cleanFingerprint(identity.buildFingerprint) });
    },
    get: (connectionId) => records.get(connectionId),
    invalidate(connectionId) { records.delete(connectionId); },
    invalidateAll,
    restartBroker() {
      brokerEpoch += 1;
      invalidateAll("broker-restart");
    },
    changeBuild(nextFingerprint) {
      const next = cleanFingerprint(nextFingerprint);
      if (next === buildFingerprint) return;
      buildFingerprint = next;
      invalidateAll("build-change");
    },
  };
}

