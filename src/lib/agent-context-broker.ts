import { createHash } from "node:crypto";

export type ContextReference = `${"file" | "diff" | "rule" | "decision" | "finding"}://${string}`;

export interface ResolvedContextItem {
  ref: ContextReference;
  content: string;
  bytes: number;
  digest: string;
}

export interface ContextResolutionRequest {
  refs: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  maxFetches: number;
  maxTotalBytes: number;
}

export interface ContextResolverDependencies {
  readRepositoryFile(path: string): Promise<string | null>;
  readCurrentDiff(runId: string): Promise<string | null>;
  readRetainedContext(ref: ContextReference): Promise<string | null>;
}

export interface ContextCompilationRequest {
  refs: readonly string[];
  maxFetches: number;
}

export interface CompiledContextRequest {
  refs: ContextReference[];
  omittedRefs: string[];
}

/**
 * Compile a stable, duplicate-free reference list before any context fetch.
 * Governance references win over source files so a small packet retains the
 * rules and decisions that constrain the delegated work. This is deliberately
 * deterministic and model-free; it cannot consume provider tokens.
 */
export function compileContextRequest(input: ContextCompilationRequest): CompiledContextRequest {
  if (!Number.isSafeInteger(input.maxFetches) || input.maxFetches < 0 || input.maxFetches > 100) {
    throw new Error("Context compilation fetch budget is invalid.");
  }
  const unique = [...new Set(input.refs)];
  const priority = (value: string): number => {
    if (/^rule:\/\//.test(value)) return 0;
    if (/^decision:\/\//.test(value)) return 1;
    if (/^finding:\/\//.test(value)) return 2;
    if (/^diff:\/\//.test(value)) return 3;
    if (/^file:\/\//.test(value)) return 4;
    return 5;
  };
  const ordered = unique
    .map((value, index) => ({ value, index, rank: priority(value) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const selected = ordered.slice(0, input.maxFetches).map(({ value }) => parseReference(value).ref);
  const selectedSet = new Set(selected.map((value) => value as string));
  return {
    refs: selected,
    omittedRefs: unique.filter((value) => !selectedSet.has(value)),
  };
}

function cleanRepositoryPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("../") || path.includes("\u0000") || /^[a-zA-Z]:/.test(path)) {
    throw new Error("Context reference contains an invalid repository path.");
  }
  return path;
}

function matchesScope(path: string, scopeValue: string): boolean {
  const scope = cleanRepositoryPath(scopeValue).replace(/\/$/, "");
  return path === scope || path.startsWith(`${scope}/`);
}

function validateRequest(input: ContextResolutionRequest): void {
  if (!Array.isArray(input.refs) || input.refs.length > 50) throw new Error("Context references exceed the fetch limit.");
  if (!Number.isSafeInteger(input.maxFetches) || input.maxFetches < 0 || input.maxFetches > 100 || input.refs.length > input.maxFetches) {
    throw new Error("Context references exceed the authorized context fetch budget.");
  }
  if (!Number.isSafeInteger(input.maxTotalBytes) || input.maxTotalBytes < 1 || input.maxTotalBytes > 1024 * 1024) {
    throw new Error("Context byte budget is invalid.");
  }
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length === 0 || input.allowedPaths.length > 100) {
    throw new Error("Context allowed paths are invalid.");
  }
  if (!Array.isArray(input.prohibitedPaths) || input.prohibitedPaths.length > 100) {
    throw new Error("Context prohibited paths are invalid.");
  }
}

function parseReference(value: string): { ref: ContextReference; kind: "file" | "diff" | "retained"; key: string } {
  if (typeof value !== "string" || value.length > 510 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Context reference is invalid.");
  const file = /^file:\/\/(.+)$/.exec(value);
  if (file) return { ref: value as ContextReference, kind: "file", key: cleanRepositoryPath(file[1]) };
  const diff = /^diff:\/\/([a-zA-Z0-9._:-]{1,100})\/current$/.exec(value);
  if (diff) return { ref: value as ContextReference, kind: "diff", key: diff[1] };
  if (/^(?:rule|decision|finding):\/\/[a-zA-Z0-9._~:/#-]{1,500}$/.test(value)) {
    return { ref: value as ContextReference, kind: "retained", key: value };
  }
  throw new Error("Context reference is invalid or unsupported.");
}

export async function resolveContextReferences(
  input: ContextResolutionRequest,
  deps: ContextResolverDependencies,
): Promise<{ status: "resolved" | "needs_context"; items: ResolvedContextItem[]; missingRefs: ContextReference[]; fetchesUsed: number; totalBytes: number }> {
  validateRequest(input);
  const parsed = [...new Set(input.refs)].map(parseReference);
  if (parsed.length > input.maxFetches) throw new Error("Context references exceed the authorized context fetch budget.");
  const items: ResolvedContextItem[] = [];
  const missingRefs: ContextReference[] = [];
  let totalBytes = 0;
  for (const entry of parsed) {
    let content: string | null;
    if (entry.kind === "file") {
      if (input.prohibitedPaths.some((scope) => matchesScope(entry.key, scope))) throw new Error("Context file is prohibited by the launch grant.");
      if (!input.allowedPaths.some((scope) => matchesScope(entry.key, scope))) throw new Error("Context file is outside the launch grant scope.");
      content = await deps.readRepositoryFile(entry.key);
    } else if (entry.kind === "diff") {
      content = await deps.readCurrentDiff(entry.key);
    } else {
      content = await deps.readRetainedContext(entry.ref);
    }
    if (content === null) {
      missingRefs.push(entry.ref);
      continue;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes < 1 || bytes > input.maxTotalBytes - totalBytes) throw new Error("Resolved context exceeds the authorized byte budget.");
    totalBytes += bytes;
    items.push({ ref: entry.ref, content, bytes, digest: createHash("sha256").update(content).digest("hex") });
  }
  return {
    status: missingRefs.length === 0 ? "resolved" : "needs_context",
    items,
    missingRefs,
    fetchesUsed: parsed.length,
    totalBytes,
  };
}

export interface ProviderResultEnvelope {
  status: "completed" | "needs_context" | "failed";
  summary: string;
  requestedContextRefs: ContextReference[];
  findings: unknown[];
  evidenceRefs: string[];
  verification: unknown[];
  failures: string[];
  limitations: string[];
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function boundedStrings(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const normalized = value.map((item) => boundedString(item, maxLength));
  return normalized.every((item): item is string => item !== null) ? [...new Set(normalized)] : null;
}

export function parseProviderResultEnvelope(raw: string): ProviderResultEnvelope {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Provider result is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider result must be an object.");
  const row = value as Record<string, unknown>;
  if ("transcript" in row || "reasoning" in row || "chain_of_thought" in row) throw new Error("Provider result must not contain a transcript or hidden reasoning.");
  const status = row.status === "completed" || row.status === "needs_context" || row.status === "failed" ? row.status : null;
  const summary = boundedString(row.summary, 2_000);
  const requested = boundedStrings(row.requested_context_refs ?? [], 20, 510);
  const evidenceRefs = boundedStrings(row.evidence_refs ?? [], 100, 510);
  const failures = boundedStrings(row.failures ?? [], 50, 1_000);
  const limitations = boundedStrings(row.limitations ?? [], 50, 1_000);
  const findings = Array.isArray(row.findings) && row.findings.length <= 100 ? row.findings : null;
  const verification = Array.isArray(row.verification) && row.verification.length <= 100 ? row.verification : null;
  if (!status || !summary || !requested || !evidenceRefs || !failures || !limitations || !findings || !verification) {
    throw new Error("Provider result does not match m9r.provider-result.v1.");
  }
  const requestedContextRefs = requested.map((ref) => parseReference(ref).ref);
  if (status === "needs_context" && requestedContextRefs.length === 0) throw new Error("needs_context must identify requested context references.");
  return { status, summary, requestedContextRefs, findings, evidenceRefs, verification, failures, limitations };
}

export interface ExperimentArm {
  totalTokens: number | null;
  qualityScore: number;
  adopted: boolean;
  reworkRequired: boolean;
}

function ratio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function evaluatePacketExperiment(input: { legacy: ExperimentArm; packet: ExperimentArm }): {
  decision: "enable_packet" | "hold";
  reason: "usage_unreported" | "outcome_regressed" | "quality_regressed" | "no_token_savings" | "quality_preserved_with_savings";
  tokenSavingsRatio: number | null;
  qualityRatio: number;
} {
  for (const arm of [input.legacy, input.packet]) {
    if (!Number.isFinite(arm.qualityScore) || arm.qualityScore < 0 || arm.qualityScore > 1) throw new Error("Experiment quality score must be between 0 and 1.");
  }
  const qualityRatio = ratio(input.legacy.qualityScore === 0 ? (input.packet.qualityScore === 0 ? 1 : Number.POSITIVE_INFINITY) : input.packet.qualityScore / input.legacy.qualityScore);
  if (input.legacy.totalTokens == null || input.packet.totalTokens == null) return { decision: "hold", reason: "usage_unreported", tokenSavingsRatio: null, qualityRatio };
  if (![input.legacy.totalTokens, input.packet.totalTokens].every((value) => Number.isSafeInteger(value) && value! > 0)) throw new Error("Experiment token usage must be positive integers.");
  const tokenSavingsRatio = ratio(1 - input.packet.totalTokens / input.legacy.totalTokens);
  if (!input.packet.adopted || input.packet.reworkRequired || (input.legacy.adopted && !input.packet.adopted)) {
    return { decision: "hold", reason: "outcome_regressed", tokenSavingsRatio, qualityRatio };
  }
  if (qualityRatio < 0.99) return { decision: "hold", reason: "quality_regressed", tokenSavingsRatio, qualityRatio };
  if (tokenSavingsRatio <= 0) return { decision: "hold", reason: "no_token_savings", tokenSavingsRatio, qualityRatio };
  return { decision: "enable_packet", reason: "quality_preserved_with_savings", tokenSavingsRatio, qualityRatio };
}
