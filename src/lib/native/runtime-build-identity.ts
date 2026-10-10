import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export const RUNTIME_BUILD_INFO_FILE = "m9r-build-info.json";

export interface RuntimeBuildInfo {
  schemaVersion: 1;
  buildId: string;
  builtAt: string;
  artifacts: Record<string, string>;
}

export interface RuntimeBuildIdentity {
  status: "verified" | "mismatch" | "invalid_manifest" | "unmanaged" | "unavailable";
  buildId?: string;
  artifact?: string;
  expectedSha256?: string;
  actualSha256?: string;
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

export function createRuntimeBuildInfo(artifacts: Record<string, string>, builtAt = new Date().toISOString()): RuntimeBuildInfo {
  const normalized = normalizedArtifacts(artifacts);
  return { schemaVersion: 1, buildId: calculateRuntimeBuildId(normalized), builtAt, artifacts: normalized };
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
      ? { status: "verified", buildId: parsed.buildId, artifact, expectedSha256, actualSha256 }
      : { status: "mismatch", buildId: parsed.buildId, artifact, expectedSha256, actualSha256, reason: "executable_hash_mismatch" };
  } catch {
    return { status: "unavailable", buildId: parsed.buildId, artifact, expectedSha256, reason: "executable_unreadable" };
  }
}
