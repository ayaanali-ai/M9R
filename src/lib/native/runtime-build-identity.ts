import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export const RUNTIME_BUILD_INFO_FILE = "m9r-build-info.json";

export interface RuntimeSourceProvenance {
  sourceCommit: string;
  sourceDirty: boolean;
}

export interface RuntimeBuildInfo {
  schemaVersion: 1;
  buildId: string;
  builtAt: string;
  artifacts: Record<string, string>;
  source: RuntimeSourceProvenance;
}

export interface RuntimeBuildIdentity {
  status: "verified" | "mismatch" | "invalid_manifest" | "unmanaged" | "unavailable";
  buildId?: string;
  artifact?: string;
  expectedSha256?: string;
  actualSha256?: string;
  sourceCommit?: string;
  sourceDirty?: boolean;
  reason?: string;
}

function normalizeArtifactPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (!normalized || normalized.startsWith("/") || normalized.includes(":")
    || normalized.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error("Invalid runtime artifact path.");
  }
  return normalized;
}

function normalizedArtifacts(value: Record<string, string>): Record<string, string> {
  const entries = Object.entries(value).map(([path, digest]) => {
    const key = normalizeArtifactPath(path);
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error("Invalid runtime artifact hash.");
    return [key, digest.toLowerCase()] as const;
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!entries.length || new Set(entries.map(([path]) => path)).size !== entries.length) throw new Error("Invalid runtime artifact list.");
  return Object.fromEntries(entries);
}

export function calculateRuntimeBuildId(artifacts: Record<string, string>): string {
  const canonical = normalizedArtifacts(artifacts);
  return createHash("sha256").update(JSON.stringify(Object.entries(canonical))).digest("hex");
}

export function createRuntimeBuildInfo(
  artifacts: Record<string, string>,
  builtAt = new Date().toISOString(),
  source: RuntimeSourceProvenance = { sourceCommit: "unknown", sourceDirty: true },
): RuntimeBuildInfo {
  const normalized = normalizedArtifacts(artifacts);
  return { schemaVersion: 1, buildId: calculateRuntimeBuildId(normalized), builtAt, artifacts: normalized, source };
}

/**
 * Read only the generation marker for a running runtime.
 *
 * Long-lived feed processes use this cheap check while they are alive. The
 * full identity check hashes the executable and is intentionally reserved for
 * startup/health verification; hashing a large SEA executable on every poll
 * would turn stale-build protection into avoidable background I/O.
 */
export function readRuntimeBuildId(executablePath = process.execPath): string | null {
  try {
    const manifestPath = join(dirname(executablePath), RUNTIME_BUILD_INFO_FILE);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { schemaVersion?: unknown; buildId?: unknown };
    return parsed.schemaVersion === 1 && typeof parsed.buildId === "string" && /^[a-f0-9]{64}$/.test(parsed.buildId)
      ? parsed.buildId
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRuntimeBuildIdentity(executablePath = process.execPath): RuntimeBuildIdentity {
  const manifestPath = join(dirname(executablePath), RUNTIME_BUILD_INFO_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
    return code === "ENOENT"
      ? { status: "unmanaged", reason: "build_manifest_missing" }
      : { status: "unavailable", reason: "build_manifest_unreadable" };
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.buildId !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.buildId) || !isRecord(parsed.artifacts)
    || typeof parsed.builtAt !== "string") {
    return { status: "invalid_manifest", reason: "build_manifest_schema_invalid" };
  }

  // A hash-only manifest can prove byte identity, but it cannot prove which
  // source was built. Keep generation polling compatible with old installs,
  // while refusing to call an old manifest a fully managed runtime.
  if (!isRecord(parsed.source) || typeof parsed.source.sourceCommit !== "string"
    || typeof parsed.source.sourceDirty !== "boolean") {
    return { status: "unmanaged", buildId: parsed.buildId, reason: "source_provenance_missing" };
  }

  let artifacts: Record<string, string>;
  try {
    const input = Object.fromEntries(Object.entries(parsed.artifacts).map(([path, digest]) => [path, String(digest)]));
    artifacts = normalizedArtifacts(input);
    if (calculateRuntimeBuildId(artifacts) !== parsed.buildId) return { status: "invalid_manifest", reason: "build_manifest_digest_mismatch" };
  } catch {
    return { status: "invalid_manifest", reason: "build_manifest_artifacts_invalid" };
  }

  let artifact: string;
  try {
    artifact = normalizeArtifactPath(relative(dirname(manifestPath), executablePath) || basename(executablePath));
  } catch {
    return { status: "unmanaged", buildId: parsed.buildId, reason: "executable_outside_runtime" };
  }
  const expectedSha256 = artifacts[artifact];
  if (!expectedSha256) return { status: "unmanaged", buildId: parsed.buildId, artifact, reason: "executable_not_listed" };
  try {
    const actualSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
    return actualSha256 === expectedSha256
      ? {
          status: "verified",
          buildId: parsed.buildId,
          artifact,
          expectedSha256,
          actualSha256,
          sourceCommit: parsed.source.sourceCommit,
          sourceDirty: parsed.source.sourceDirty,
        }
      : { status: "mismatch", buildId: parsed.buildId, artifact, expectedSha256, actualSha256, reason: "executable_hash_mismatch" };
  } catch {
    return { status: "unavailable", buildId: parsed.buildId, artifact, expectedSha256, reason: "executable_unreadable" };
  }
}

/**
 * Verify the separately managed Web broker without borrowing the shared
 * desktop runtime manifest. The standalone installer owns
 * `web-broker-install.json` because the broker can be upgraded independently
 * of the resident engine and overlay.
 */
export function readManagedWebBrokerIdentity(
  executablePath = process.execPath,
  installRecordPath = join(dirname(dirname(executablePath)), "web-broker-install.json"),
): RuntimeBuildIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(installRecordPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
    return code === "ENOENT"
      ? readRuntimeBuildIdentity(executablePath)
      : { status: "unavailable", reason: "broker_install_record_unreadable" };
  }

  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.path !== "string"
    || typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.sha256)) {
    return { status: "invalid_manifest", reason: "broker_install_record_invalid" };
  }

  let recordedPath: string;
  try { recordedPath = resolve(parsed.path); }
  catch { return { status: "invalid_manifest", reason: "broker_install_record_path_invalid" }; }
  const actualPath = resolve(executablePath);
  const pathMatches = process.platform === "win32"
    ? recordedPath.toLowerCase() === actualPath.toLowerCase()
    : recordedPath === actualPath;
  if (!pathMatches) return readRuntimeBuildIdentity(executablePath);

  const expectedSha256 = parsed.sha256.toLowerCase();
  try {
    const actualSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
    return actualSha256 === expectedSha256
      ? {
          status: "verified",
          artifact: basename(executablePath),
          expectedSha256,
          actualSha256,
          reason: "managed_broker_record",
        }
      : { status: "mismatch", artifact: basename(executablePath), expectedSha256, actualSha256, reason: "broker_executable_hash_mismatch" };
  } catch {
    return { status: "unavailable", artifact: basename(executablePath), expectedSha256, reason: "broker_executable_unreadable" };
  }
}
