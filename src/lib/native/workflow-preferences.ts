import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UniversalIntentContract } from "./universal-intent-resolver";

/** Bounded local-only workflow memory. It never stores prompts, page text, secrets, or images. */
export type WorkflowPreferenceKey = "no-submit" | "no-advance" | "prefer-structure" | "prefer-start-search";
export interface WorkflowPreferenceRecord { key: WorkflowPreferenceKey; count: number; updatedAt: string; }
export type WorkflowActionPattern = "semantic-target" | "reobserve-after-mutation" | "coordinate-fallback";
export type WorkflowProviderCapability = "browser" | "desktop" | "system-control" | "form-entry";
export interface WorkflowPatternRecord { pattern: WorkflowActionPattern; count: number; updatedAt: string; }
export interface WorkflowProviderStrengthRecord { provider: string; capability: WorkflowProviderCapability; count: number; updatedAt: string; }
export interface WorkflowPreferenceLedger {
  recordIntent(intent: Pick<UniversalIntentContract, "constraints" | "fallbackPolicy">): void;
  recordActionPattern(pattern: WorkflowActionPattern): void;
  recordProviderStrength(provider: string, capability: WorkflowProviderCapability): void;
  snapshot(): readonly WorkflowPreferenceRecord[];
  actionPatterns(): readonly WorkflowPatternRecord[];
  providerStrengths(): readonly WorkflowProviderStrengthRecord[];
}

const FILE_NAME = "workflow-preferences.json";
const MAX_RECORDS = 64;
const KEYS = new Set<WorkflowPreferenceKey>(["no-submit", "no-advance", "prefer-structure", "prefer-start-search"]);
const ACTION_PATTERNS = new Set<WorkflowActionPattern>(["semantic-target", "reobserve-after-mutation", "coordinate-fallback"]);
const PROVIDER_CAPABILITIES = new Set<WorkflowProviderCapability>(["browser", "desktop", "system-control", "form-entry"]);
const MAX_PROVIDER_STRENGTHS = 32;

function valid(value: unknown): value is WorkflowPreferenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === "string" && KEYS.has(item.key as WorkflowPreferenceKey)
    && Number.isSafeInteger(item.count) && Number(item.count) > 0 && Number(item.count) <= 100_000
    && typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt));
}

export function createWorkflowPreferenceLedger(root: string, now: () => Date = () => new Date()): WorkflowPreferenceLedger {
  const path = join(root, FILE_NAME);
  const records = new Map<WorkflowPreferenceKey, WorkflowPreferenceRecord>();
  const patterns = new Map<WorkflowActionPattern, WorkflowPatternRecord>();
  const strengths = new Map<string, WorkflowProviderStrengthRecord>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // Version 0 was a plain preference array; accept it so an update never
    // discards a user's bounded local memory.
    const preferenceItems = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as { preferences?: unknown }).preferences) ? (parsed as { preferences: unknown[] }).preferences : []);
    for (const item of preferenceItems.slice(-MAX_RECORDS)) if (valid(item)) records.set(item.key, item);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const object = parsed as { patterns?: unknown; providerStrengths?: unknown };
      if (Array.isArray(object.patterns)) for (const item of object.patterns.slice(-MAX_RECORDS)) if (validPattern(item)) patterns.set(item.pattern, item);
      if (Array.isArray(object.providerStrengths)) for (const item of object.providerStrengths.slice(-MAX_PROVIDER_STRENGTHS)) if (validStrength(item)) strengths.set(strengthKey(item.provider, item.capability), item);
    }
  } catch { /* missing or malformed memory is intentionally treated as empty */ }
  let pending = Promise.resolve();
  const persist = () => {
    const temp = `${path}.tmp-${process.pid}`;
    try {
      const payload = {
        version: 1,
        preferences: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)),
        patterns: [...patterns.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)),
        providerStrengths: [...strengths.values()].sort((a, b) => strengthKey(a.provider, a.capability).localeCompare(strengthKey(b.provider, b.capability))),
      };
      writeFileSync(temp, JSON.stringify(payload) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } catch { try { unlinkSync(temp); } catch { /* best effort */ } }
  };
  const add = (key: WorkflowPreferenceKey) => {
    const previous = records.get(key);
    records.set(key, { key, count: Math.min(100_000, (previous?.count ?? 0) + 1), updatedAt: now().toISOString() });
    pending = pending.then(persist, persist);
  };
  const addPattern = (pattern: WorkflowActionPattern) => {
    if (!ACTION_PATTERNS.has(pattern)) return;
    const previous = patterns.get(pattern);
    patterns.set(pattern, { pattern, count: Math.min(100_000, (previous?.count ?? 0) + 1), updatedAt: now().toISOString() });
    pending = pending.then(persist, persist);
  };
  const addStrength = (provider: string, capability: WorkflowProviderCapability) => {
    const normalizedProvider = provider.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
    if (!normalizedProvider || !PROVIDER_CAPABILITIES.has(capability)) return;
    const key = strengthKey(normalizedProvider, capability);
    const previous = strengths.get(key);
    if (!previous && strengths.size >= MAX_PROVIDER_STRENGTHS) return;
    strengths.set(key, { provider: normalizedProvider, capability, count: Math.min(100_000, (previous?.count ?? 0) + 1), updatedAt: now().toISOString() });
    pending = pending.then(persist, persist);
  };
  return {
    recordIntent(intent) {
      if (intent.constraints.allowSubmit === false) add("no-submit");
      if (intent.constraints.allowAdvance === false) add("no-advance");
      if (intent.fallbackPolicy.structureFirst) add("prefer-structure");
      if (intent.fallbackPolicy.startSearchBeforeTaskbar) add("prefer-start-search");
    },
    recordActionPattern: addPattern,
    recordProviderStrength: addStrength,
    snapshot() { return [...records.values()].sort((a, b) => a.key.localeCompare(b.key)); },
    actionPatterns() { return [...patterns.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)); },
    providerStrengths() { return [...strengths.values()].sort((a, b) => strengthKey(a.provider, a.capability).localeCompare(strengthKey(b.provider, b.capability))); },
  };
}

function validPattern(value: unknown): value is WorkflowPatternRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.pattern === "string" && ACTION_PATTERNS.has(item.pattern as WorkflowActionPattern)
    && Number.isSafeInteger(item.count) && Number(item.count) > 0 && Number(item.count) <= 100_000
    && typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt));
}

function validStrength(value: unknown): value is WorkflowProviderStrengthRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.provider === "string" && /^[a-z0-9_-]{1,32}$/.test(item.provider)
    && typeof item.capability === "string" && PROVIDER_CAPABILITIES.has(item.capability as WorkflowProviderCapability)
    && Number.isSafeInteger(item.count) && Number(item.count) > 0 && Number(item.count) <= 100_000
    && typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt));
}

function strengthKey(provider: string, capability: WorkflowProviderCapability): string {
  return `${provider}:${capability}`;
}

