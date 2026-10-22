import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  computerUseActionSchema,
  computerUseResultSchema,
  computerUseTelemetrySchema,
  parseComputerUseAction,
  parseComputerUseTarget,
  type ComputerUseAction,
  type ComputerUseCapability,
  type ComputerUseLocator,
  type ComputerUsePostcondition,
  type ComputerUseResult,
  type ComputerUseTarget,
  type ComputerUseTelemetry,
} from "./computer-use-contract";
import { selectComputerUseRoute, type ComputerUseRouteDescriptor } from "./computer-use-router";
import type { VerifiedIdentity } from "./identity-core";
import type { ComputerOperationInput, LocalStore, StageOperationClaim } from "./local-store";
import type { StageClientResult, WebBrokerClient } from "./web-broker-client";
import type { WebRequest, WebResponse } from "./web-broker-core";

const MAX_OBSERVATION_AGE_MS = 30_000;
const MAX_TARGETS = 256;
const TARGET_TTL_MS = MAX_OBSERVATION_AGE_MS * 4;
const MAX_CHANGE_BASELINES = 256;
const CHANGE_BASELINE_TTL_MS = TARGET_TTL_MS;
/**
 * A structured observation should stay cheap even when the native driver returns a
 * noisy partial tree or several owned popups. Images are still available when they
 * fit this bounded budget; an oversized visual is reported as omitted instead of
 * silently turning one observation into an enormous provider turn.
 */
const MAX_RESPONSE_IMAGE_BYTES = 512 * 1024;
const MAX_RESPONSE_IMAGES = 4;
const FINGERPRINT_SCHEMA_VERSION = 1;
const BROWSER_REF = /^e[a-f0-9]{24}_\d{1,3}$/;
// Cua element tokens are opaque driver values and are not guaranteed to be
// UUIDs. They stay private inside the desktop record; providers receive the
// generated control_* ref below instead.
const STAGE_REF = /^[A-Za-z0-9._:-]{1,512}$/;
// Modern MCP clients can consume this directly instead of asking the model to
// parse the compatibility text envelope. The text block remains below for
// older provider bridges, so this additive field does not change the
// authorization or evidence contract.
const COMPUTER_USE_OUTPUT_SCHEMA = z.object({}).passthrough();

// Fallback only, for a caller that has not been updated to pass its real authField (see
// ComputerUseMcpDeps.authField above) -- an always-empty object kept any such caller's tools
// permanently unable to accept a token even as a fallback, which is the same bug mcp-server.ts's
// own AUTH_FIELD had. Do not use this directly; see buildInputSchemas below.
const LEGACY_TOKEN_FIELD_FALLBACK = {} as { token?: z.ZodOptional<z.ZodString> };
const COMPUTER_USE_OBSERVE_TARGETS = ["desktop", "app-window", "browser-tab"] as const;

/**
 * Some provider MCP bridges serialize a discriminated-union object argument
 * before sending it over their tool transport. Keep the canonical schema and
 * validation, but accept that transport representation at the boundary so a
 * bridge quirk cannot turn a valid provider-neutral action into a schema error.
 */
const computerUseActionWireSchema = z.union([
  computerUseActionSchema,
  z.string().min(2).max(32_768),
]);

function normalizeComputerUseActionWire(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function buildInputSchemas(authField: ComputerUseMcpDeps["authField"]) {
  const tokenField = authField ?? LEGACY_TOKEN_FIELD_FALLBACK;
  return {
    observe: {
      ...tokenField,
      target: z.enum(COMPUTER_USE_OBSERVE_TARGETS),
      taskId: z.string().regex(/^T[0-9]{1,12}$/).optional(),
      mode: z.enum(["owner-preview", "background"]).default("owner-preview"),
      representation: z.enum(["structured", "visual"]).optional().describe("App windows default to structured accessibility; desktop targets default to a bounded composite of visible windows and controls. Request visual when pixels are the intended route; incomplete structure carries the same-capture visual fallback."),
      tab: z.string().min(1).max(40).optional(),
    },
    action: { ...tokenField, action: computerUseActionWireSchema },
  };
}

interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  parentRef?: string;
  depth?: number;
  disabled?: boolean;
  selected?: boolean;
  actions?: string[];
  canReplaceValue?: boolean;
  canInsertText?: boolean;
  canSelectText?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

interface DesktopControl {
  ref: string;
  stageRef?: string;
  parentRef?: string;
  depth?: number;
  role?: string;
  label?: string;
  enabled?: boolean;
  selected?: boolean;
  actions?: string[];
  canReplaceValue?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

type TargetContext =
  | { kind: "desktop"; taskId: string; mode: "owner-preview" | "background"; view: "desktop" | "app"; representation: "structured" | "visual";
      structureStatus?: string; width: number; height: number; controls: Map<string, DesktopControl>; inputSelectionConfirmed: boolean }
  | { kind: "browser"; tab?: string; url?: string; title?: string; text?: string; elements: Map<string, BrowserElement> };

interface TargetRecord {
  target: ComputerUseTarget;
  identityKey: string;
  logicalKey: string;
  scopeKey: string;
  route: ComputerUseRouteDescriptor;
  context: TargetContext;
  pinnedRouteId?: string;
  change: ObservationChange;
}

type FingerprintCompleteness = "complete" | "partial" | "unavailable";
type ChangeStatus = "initial" | "unchanged" | "changed" | "unknown";

interface NormalizedFingerprintEntry {
  base: string;
  state: string;
  geometry: string;
}

interface ObservationFingerprint {
  completeness: FingerprintCompleteness;
  entries: NormalizedFingerprintEntry[];
  geometry: string[];
  hash: string;
}

interface StoredObservationFingerprint extends ObservationFingerprint {
  revision: string;
  observedAt: number;
}

interface ObservationChange {
  status: ChangeStatus;
  fingerprintSchemaVersion: number;
  comparisonScope: "full-target" | "observed-subtree" | "none";
  counts: { added: number; removed: number; updated: number };
  geometry: { status: "initial" | "unchanged" | "changed" | "unknown" };
  comparedToRevision?: string;
}

interface ComputerUseMcpDeps {
  web?: WebBrokerClient;
  store: Pick<LocalStore, "claimComputerOperation" | "inspectComputerOperation" | "releaseComputerOperation" | "settleComputerOperation">;
  requireIdentity(token?: unknown): Promise<VerifiedIdentity>;
  identityToken(identity: VerifiedIdentity, presented?: unknown): Promise<string>;
  /** Resolve the internal stage task only when the provider omitted it. */
  resolveTaskId(identity: VerifiedIdentity, taskId?: string): string;
  now?: () => Date;
  monotonicNow?: () => number;
  /**
   * The real, live token-field schema from the owning MCP server (mcp-server.ts's
   * OPTIONAL_TOKEN_FIELD), not the module-level TOKEN_FIELD constant below. Falls back to that
   * constant only when unset, for any other caller that has not been updated to pass it.
   */
  authField?: { token?: z.ZodString | z.ZodOptional<z.ZodString> };
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: "image/png" };
type ToolResponse = ReturnType<typeof toolResponse>;
type ComputerUseTimingPhase = "observationMs" | "routingMs" | "actionMs" | "verificationMs";
type ComputerUseTimingRecorder = {
  measure<T>(phase: ComputerUseTimingPhase, operation: () => Promise<T>): Promise<T>;
  measureSync<T>(phase: ComputerUseTimingPhase, operation: () => T): T;
  markPriorReceiptFound(): void;
};
type ComputerUseObserveArgs = {
  token?: unknown;
  target: typeof COMPUTER_USE_OBSERVE_TARGETS[number];
  taskId?: string;
  mode?: "owner-preview" | "background";
  representation?: "structured" | "visual";
  tab?: string;
};
type ComputerUseActionArgs = { token?: unknown; action: ComputerUseAction | string };

function identityKey(identity: VerifiedIdentity): string {
  return JSON.stringify([identity.handle, identity.provider, identity.sessionId]);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  const rect = recordOf(value);
  return !!rect && [rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part))
    && (rect.width as number) > 0 && (rect.height as number) > 0;
}

function structureCompleteness(value: unknown): FingerprintCompleteness {
  return value === "complete" || value === "partial" || value === "unavailable" ? value : "unavailable";
}

function normalizedString(value: unknown, max = 256): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "";
}

/**
 * Build a privacy-safe semantic fingerprint from the observation already in
 * hand. Transient refs/tokens, timestamps, screenshots, and control values are
 * deliberately excluded. Parent relationships use the parent's semantic
 * description rather than its per-walk opaque ref.
 */
function normalizeObservationFingerprint(
  rawElements: readonly Record<string, unknown>[],
  completeness: FingerprintCompleteness,
): ObservationFingerprint {
  const byRef = new Map<string, Record<string, unknown>>();
  for (const element of rawElements) {
    if (typeof element.ref === "string") byRef.set(element.ref, element);
  }
  const entries: NormalizedFingerprintEntry[] = [];
  const geometry: string[] = [];
  for (const element of rawElements.slice(0, 512)) {
    const role = normalizedString(element.role, 80).toLowerCase();
    const label = normalizedString(element.label ?? element.name, 160).toLowerCase();
    const depth = Number.isSafeInteger(element.depth) ? String(element.depth) : "";
    const parent = typeof element.parentRef === "string" ? byRef.get(element.parentRef) : undefined;
    const parentRole = normalizedString(parent?.role, 80).toLowerCase();
    const parentLabel = normalizedString(parent?.label ?? parent?.name, 160).toLowerCase();
    const base = JSON.stringify({ role, label, depth, parentRole, parentLabel });
    const actions = Array.isArray(element.actions)
      ? element.actions.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()).sort()
      : [];
    const state = JSON.stringify({
      actions,
      enabled: typeof element.enabled === "boolean" ? element.enabled : undefined,
      disabled: typeof element.disabled === "boolean" ? element.disabled : undefined,
      selected: typeof element.selected === "boolean" ? element.selected : undefined,
      expanded: typeof element.expanded === "boolean" ? element.expanded : undefined,
    });
    const rect = validRect(element.rect)
      ? JSON.stringify([element.rect.x, element.rect.y, element.rect.width, element.rect.height])
      : "";
    entries.push({ base, state, geometry: rect });
    if (rect) geometry.push(`${base}\0${rect}`);
  }
  entries.sort((a, b) => `${a.base}\0${a.state}`.localeCompare(`${b.base}\0${b.state}`));
  geometry.sort();
  const hashInput = JSON.stringify({ completeness, entries: entries.map(({ base, state }) => [base, state]) });
  const hash = createHash("sha256").update(hashInput).digest("hex");
  return { completeness, entries, geometry, hash };
}

function multisetCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function compareFingerprintEntries(previous: readonly NormalizedFingerprintEntry[], current: readonly NormalizedFingerprintEntry[]) {
  const previousByBase = new Map<string, string[]>();
  const currentByBase = new Map<string, string[]>();
  for (const entry of previous) previousByBase.set(entry.base, [...(previousByBase.get(entry.base) ?? []), entry.state]);
  for (const entry of current) currentByBase.set(entry.base, [...(currentByBase.get(entry.base) ?? []), entry.state]);
  let added = 0;
  let removed = 0;
  let updated = 0;
  const bases = new Set([...previousByBase.keys(), ...currentByBase.keys()]);
  for (const base of bases) {
    const oldStates = previousByBase.get(base) ?? [];
    const newStates = currentByBase.get(base) ?? [];
    const oldCounts = multisetCounts(oldStates);
    const newCounts = multisetCounts(newStates);
    let unchanged = 0;
    for (const [state, count] of oldCounts) unchanged += Math.min(count, newCounts.get(state) ?? 0);
    const oldUnmatched = oldStates.length - unchanged;
    const newUnmatched = newStates.length - unchanged;
    const changedPairs = Math.min(oldUnmatched, newUnmatched);
    updated += changedPairs;
    removed += oldUnmatched - changedPairs;
    added += newUnmatched - changedPairs;
  }
  return {
    added: Math.min(added, 512),
    removed: Math.min(removed, 512),
    updated: Math.min(Math.max(0, updated), 512),
  };
}

function compareObservationFingerprint(previous: StoredObservationFingerprint | undefined, current: ObservationFingerprint, revision: string): ObservationChange {
  if (!previous) {
    return { status: current.completeness === "complete" ? "initial" : "unknown", fingerprintSchemaVersion: FINGERPRINT_SCHEMA_VERSION,
      comparisonScope: current.completeness === "complete" ? "full-target" : "observed-subtree", counts: { added: 0, removed: 0, updated: 0 },
      geometry: { status: "initial" } };
  }
  const comparedToRevision = previous.revision;
  const geometryStatus = !previous.geometry.length || !current.geometry.length
    ? "unknown"
    : JSON.stringify(previous.geometry) === JSON.stringify(current.geometry) ? "unchanged" : "changed";
  if (previous.completeness !== "complete" || current.completeness !== "complete") {
    return { status: "unknown", fingerprintSchemaVersion: FINGERPRINT_SCHEMA_VERSION, comparisonScope: "observed-subtree",
      counts: { added: 0, removed: 0, updated: 0 }, geometry: { status: geometryStatus }, comparedToRevision };
  }
  const counts = compareFingerprintEntries(previous.entries, current.entries);
  const changed = counts.added > 0 || counts.removed > 0 || counts.updated > 0;
  return { status: changed ? "changed" : "unchanged", fingerprintSchemaVersion: FINGERPRINT_SCHEMA_VERSION,
    comparisonScope: "full-target", counts, geometry: { status: geometryStatus }, comparedToRevision };
}

function dataUrlImage(value: unknown): ImageBlock | undefined {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) return undefined;
  return { type: "image", data: value.slice("data:image/png;base64,".length), mimeType: "image/png" };
}

function toolResponse(value: unknown, image?: ImageBlock, isError = false) {
  const images: ImageBlock[] = [];
  let omittedImages = 0;
  const appendImage = (candidate: ImageBlock | undefined) => {
    if (!candidate) return;
    const estimatedBytes = Math.ceil(candidate.data.length * 3 / 4);
    if (images.length >= MAX_RESPONSE_IMAGES || estimatedBytes > MAX_RESPONSE_IMAGE_BYTES
      || images.reduce((sum, item) => sum + Math.ceil(item.data.length * 3 / 4), 0) + estimatedBytes > MAX_RESPONSE_IMAGE_BYTES) {
      omittedImages += 1;
      return;
    }
    images.push(candidate);
  };
  appendImage(image);
  const observation = recordOf(recordOf(value)?.observation);
  const popups = recordOf(observation?.capture)?.ownedPopups;
  if (Array.isArray(popups)) for (const popup of popups.slice(0, 8)) {
    appendImage(dataUrlImage(recordOf(popup)?.dataUrl));
  }
  const body = omittedImages > 0 && recordOf(value)
    ? { ...recordOf(value), imageDelivery: { status: "bounded", delivered: images.length, omitted: omittedImages, maxBytes: MAX_RESPONSE_IMAGE_BYTES } }
    : value;
  // Keep structuredContent byte-for-byte aligned with the compatibility text
  // envelope, including deliberate dataUrl redaction. This prevents the new
  // MCP field from becoming a second path for raw screenshots or popup data.
  const serialized = JSON.stringify(body, (key, item) => key === "dataUrl" ? undefined : item);
  const structuredContent = (() => {
    if (isError || !serialized) return undefined;
    try {
      const parsed: unknown = JSON.parse(serialized);
      return recordOf(parsed);
    } catch {
      return undefined;
    }
  })();
  const content: Array<TextBlock | ImageBlock> = [{ type: "text", text: serialized ?? "null" }, ...images];
  return { content, ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError: true } : {}) };
}

function elapsedMs(startedAt: number, endedAt: number): number {
  const duration = endedAt - startedAt;
  return Number.isFinite(duration) ? Math.round(Math.max(0, duration) * 1_000) / 1_000 : 0;
}

function createTimingRecorder(monotonicNow: () => number): ComputerUseTimingRecorder & {
  snapshot(): Pick<ComputerUseTelemetry["timingsMs"], ComputerUseTimingPhase>;
  priorReceiptFound(): boolean;
} {
  const timings: Partial<Record<ComputerUseTimingPhase, number>> = {};
  let foundPriorReceipt = false;
  const record = (phase: ComputerUseTimingPhase, startedAt: number) => {
    const elapsed = elapsedMs(startedAt, monotonicNow());
    timings[phase] = elapsedMs(0, (timings[phase] ?? 0) + elapsed);
  };
  return {
    async measure<T>(phase: ComputerUseTimingPhase, operation: () => Promise<T>): Promise<T> {
      const startedAt = monotonicNow();
      try { return await operation(); }
      finally { record(phase, startedAt); }
    },
    measureSync<T>(phase: ComputerUseTimingPhase, operation: () => T): T {
      const startedAt = monotonicNow();
      try { return operation(); }
      finally { record(phase, startedAt); }
    },
    markPriorReceiptFound() { foundPriorReceipt = true; },
    snapshot() { return { ...timings }; },
    priorReceiptFound() { return foundPriorReceipt; },
  };
}

function attachComputerUseTelemetry(response: ToolResponse, telemetry: ComputerUseTelemetry): ToolResponse {
  const textIndex = response.content.findIndex((block) => block.type === "text");
  const textBlock = response.content[textIndex];
  if (textIndex < 0 || textBlock?.type !== "text") return response;
  let body: unknown;
  try { body = JSON.parse(textBlock.text); } catch { return response; }
  const object = recordOf(body);
  if (!object) return response;
  const validatedTelemetry = computerUseTelemetrySchema.parse(telemetry);
  const content = response.content.map((block, index) => index === textIndex
    ? { type: "text" as const, text: JSON.stringify({ ...object, telemetry: validatedTelemetry }) }
    : block);
  const structuredContent = response.structuredContent
    ? { ...response.structuredContent, telemetry: validatedTelemetry }
    : undefined;
  return { ...response, content, ...(structuredContent ? { structuredContent } : {}) };
}

function withComputerUseTelemetry<Args>(
  handler: (args: Args, timing: ComputerUseTimingRecorder) => Promise<ToolResponse>,
  monotonicNow: () => number,
): (args: Args) => Promise<ToolResponse> {
  return async (args) => {
    const startedAt = monotonicNow();
    const timing = createTimingRecorder(monotonicNow);
    const response = await handler(args, timing);
    return attachComputerUseTelemetry(response, {
      timingsMs: { ...timing.snapshot(), totalMs: elapsedMs(startedAt, monotonicNow()) },
      priorReceiptFound: timing.priorReceiptFound(),
    });
  };
}

function capabilitiesForDesktop(controls: readonly DesktopControl[], view: "desktop" | "app", inputSelectionConfirmed: boolean,
  representation: "structured" | "visual", structureStatus?: string): ComputerUseCapability[] {
  const semanticControls = controls.filter((control) => control.enabled !== false && control.stageRef
    && control.actions?.some((action) => /^(?:click|invoke|press|expand|toggle|select)$/i.test(action)));
  const visualControls = controls.filter((control) => control.enabled !== false && control.rect);
  const visualAvailable = representation === "visual" || structureStatus === "partial" || structureStatus === "unknown"
    || structureStatus === "unavailable" || structureStatus === "not-requested";
  const accessibleAvailable = structureStatus === "complete" || structureStatus === "partial"
    || (structureStatus === undefined && controls.some((control) => Boolean(control.stageRef)));
  return [
    "observe.screenshot",
    ...(accessibleAvailable ? ["observe.accessibility" as const] : []),
    ...(visualAvailable ? ["input.click.point" as const] : []),
    ...(semanticControls.length || visualControls.length ? ["input.click.element" as const] : []),
    ...(view === "app" && visualAvailable ? [
      "input.click.right" as const,
      "input.click.double.point" as const,
      ...(visualControls.length ? ["input.click.double.element" as const] : []),
    ] : []),
    ...(visualAvailable ? ["input.drag" as const, "input.drag.duration" as const] : []),
    ...(view === "app" || inputSelectionConfirmed ? ["input.key" as const] : []),
    ...(inputSelectionConfirmed ? ["input.text.insert" as const] : []),
    // Only an exact, already-registered app window can take a single
    // explicit foreground confirming click -- never the desktop-wide view,
    // which has no single bounded target to momentarily focus.
    ...(view === "app" ? ["input.shared-os" as const, "input.focus" as const] : []),
    ...(view === "app" ? ["window.frame" as const, "window.state" as const, "menu.invoke" as const, "clipboard.read" as const, "clipboard.write" as const] : []),
    ...(controls.some((control) => control.enabled !== false && control.canReplaceValue && Boolean(control.role?.trim()))
      ? ["input.text.replace" as const] : []),
    ...(visualAvailable ? ["input.scroll.line.horizontal" as const, "input.scroll.line.vertical" as const,
      "input.scroll.page.horizontal" as const, "input.scroll.page.vertical" as const] : []),
  ];
}

const BROWSER_BASE_CAPABILITIES: ComputerUseCapability[] = [
  "observe.dom",
  "input.key",
  "input.scroll.pixel.vertical",
  "browser.navigate",
];

function canReplaceBrowserValue(element: Pick<BrowserElement, "role" | "canReplaceValue">): boolean {
  if (element.canReplaceValue !== undefined) return element.canReplaceValue;
  const role = element.role.trim().toLowerCase();
  return role === "textbox" || role === "searchbox";
}

function canInsertBrowserText(element: Pick<BrowserElement, "role" | "canReplaceValue" | "canInsertText">): boolean {
  return canReplaceBrowserValue(element) && element.canInsertText === true;
}

function canSelectBrowserText(element: Pick<BrowserElement, "role" | "canSelectText">): boolean {
  if (element.canSelectText !== undefined) return element.canSelectText;
  return ["button", "link", "menuitem", "option", "tab"].includes(element.role.trim().toLowerCase());
}

function capabilitiesForBrowser(elements: readonly BrowserElement[], nativeClickAvailable: boolean): ComputerUseCapability[] {
  const enabled = elements.filter((element) => element.disabled !== true);
  return [
    ...BROWSER_BASE_CAPABILITIES,
    ...(nativeClickAvailable ? ["input.click.point" as const, "input.click.middle" as const, "input.click.right" as const] : []),
    ...(nativeClickAvailable && enabled.length ? ["input.click.element" as const, "input.click.double.element" as const] : []),
    ...(enabled.some(canInsertBrowserText) ? ["input.text.insert" as const] : []),
    ...(enabled.some(canReplaceBrowserValue) ? ["input.text.replace" as const] : []),
    ...(elements.some(canSelectBrowserText) ? ["input.select-text.text" as const] : []),
    ...(enabled.length >= 2 ? ["input.drag" as const] : []),
  ];
}

function stageCapture(response: StageClientResult): Record<string, unknown> | undefined {
  const result = recordOf(response.result);
  const fromResult = recordOf(result?.capture);
  if (fromResult && typeof fromResult.dataUrl === "string" && typeof fromResult.width === "number" && typeof fromResult.height === "number") {
    return fromResult;
  }
  const recovery = recordOf(response.recovery);
  const fromRecovery = recovery?.kind === "capture_refreshed" ? recordOf(recovery.capture) : undefined;
  return fromRecovery && typeof fromRecovery.dataUrl === "string" && typeof fromRecovery.width === "number" && typeof fromRecovery.height === "number"
    ? fromRecovery
    : undefined;
}

function browserSnapshotData(response: WebResponse): Record<string, unknown> | undefined {
  return recordOf(response.data);
}

function createComputerUseResult(input: ComputerUseResult) {
  return computerUseResultSchema.parse(input);
}

function publicStageCapture(capture: Record<string, unknown>) {
  return {
    width: capture.width,
    height: capture.height,
    capturedAt: capture.capturedAt,
    ...(typeof capture.accessibilityStatus === "string" ? { accessibilityStatus: capture.accessibilityStatus } : {}),
    ...(Array.isArray(capture.ownedPopups) ? { ownedPopups: capture.ownedPopups } : {}),
    ...(capture.popupCaptureStatus ? { popupCaptureStatus: capture.popupCaptureStatus } : {}),
  };
}

/**
 * Exposes one target/action surface while keeping the existing owner broker and
 * web broker as the only dispatch backends. Observations are session-scoped,
 * bounded, short-lived, and never contain raw HWND/process handles.
 */
export function registerComputerUseTools(server: McpServer, deps: ComputerUseMcpDeps): void {
  const records = new Map<string, TargetRecord>();
  const logicalTargets = new Map<string, string>();
  const changeBaselines = new Map<string, StoredObservationFingerprint>();
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const now = deps.now ?? (() => new Date());
  const inputSchemas = buildInputSchemas(deps.authField);

  function removeTarget(targetId: string) {
    const existing = records.get(targetId);
    if (existing) {
      records.delete(targetId);
      if (logicalTargets.get(existing.logicalKey) === targetId) logicalTargets.delete(existing.logicalKey);
    }
  }

  function pruneTargets(nowMs: number) {
    for (const [targetId, record] of records) {
      if (nowMs - record.target.observedAt > TARGET_TTL_MS) removeTarget(targetId);
    }
    while (records.size > MAX_TARGETS) removeTarget(records.keys().next().value as string);
    for (const [key, baseline] of changeBaselines) {
      if (nowMs - baseline.observedAt > CHANGE_BASELINE_TTL_MS) changeBaselines.delete(key);
    }
    while (changeBaselines.size > MAX_CHANGE_BASELINES) changeBaselines.delete(changeBaselines.keys().next().value as string);
  }

  function saveObservation(input: {
    identity: VerifiedIdentity;
    logicalKey: string;
    kind: "desktop" | "desktop-window" | "browser-tab";
    observedAt: number;
    capabilities: ComputerUseCapability[];
    context: TargetContext;
    extra?: Record<string, unknown>;
    fingerprint: ObservationFingerprint;
  }): TargetRecord {
    const idKey = identityKey(input.identity);
    const logicalKey = `${idKey}\0${input.logicalKey}`;
    const baselineKey = `${logicalKey}\0${input.kind}`;
    let targetId = logicalTargets.get(logicalKey);
    if (!targetId || !records.has(targetId)) {
      targetId = randomUUID();
      logicalTargets.set(logicalKey, targetId);
    }
    const previous = records.get(targetId);
    const revision = randomUUID();
    const change = compareObservationFingerprint(changeBaselines.get(baselineKey), input.fingerprint, revision);
    const targetInput = {
      kind: input.kind,
      targetId,
      revision,
      observedAt: input.observedAt,
      capabilities: input.capabilities,
      ...(input.kind === "desktop-window" ? { windowRef: targetId } : {}),
      ...(input.kind === "browser-tab" && typeof input.extra?.url === "string" ? { url: input.extra.url } : {}),
    };
    const target = parseComputerUseTarget(targetInput);
    const routeId = input.kind === "browser-tab" ? "m9r-browser-broker" : "m9r-desktop-stage";
    const route: ComputerUseRouteDescriptor = {
      routeId,
      targetKinds: [input.kind],
      capabilities: input.capabilities,
      priority: 0,
      requiresOwnerInputLease: false,
    };
    const record: TargetRecord = {
      target,
      identityKey: idKey,
      logicalKey,
      scopeKey: input.logicalKey,
      route,
      context: input.context,
      change,
      ...(previous?.pinnedRouteId ? { pinnedRouteId: previous.pinnedRouteId } : {}),
    };
    changeBaselines.set(baselineKey, { ...input.fingerprint, revision, observedAt: input.observedAt });
    records.delete(targetId);
    records.set(targetId, record);
    pruneTargets(now().getTime());
    return record;
  }

  async function observeDesktop(input: {
    token: string;
    identity: VerifiedIdentity;
    taskId: string;
    mode: "owner-preview" | "background";
    view: "desktop" | "app";
    representation: "structured" | "visual";
    logicalKey?: string;
    captureOverride?: Record<string, unknown>;
    inputSelectionConfirmed?: boolean;
  }): Promise<{ record: TargetRecord; observation: Record<string, unknown>; image?: ImageBlock }> {
    if (!deps.web?.taskStageAction) throw new Error("The owner-launched desktop stage broker is unavailable.");
    let capture = input.captureOverride;
    let structure = recordOf(capture?.structure);
    if (!capture) {
      if (!deps.web.prepareTaskStage) throw new Error("The owner-launched desktop stage broker cannot prepare a target.");
      const prepared = await deps.web.prepareTaskStage(input.token, input.taskId, input.mode);
      if (!prepared.ok) throw new Error(prepared.error ?? "The desktop stage could not be prepared.");
      if (input.representation === "structured") {
        const response = await deps.web.taskStageAction(input.token, input.taskId, { kind: "read_structure", view: input.view }, input.mode);
        if (response.ok) {
          const candidate = recordOf(response.result);
          structure = candidate && (typeof candidate.status === "string" || candidate.scope === "desktop" || Array.isArray(candidate.elements))
            ? candidate : undefined;
          const sameCallFallback = recordOf(structure?.fallbackCapture);
          if (sameCallFallback && typeof sameCallFallback.dataUrl === "string") capture = sameCallFallback;
        }
      }
      if (input.representation === "visual" || !structure) {
        const response = await deps.web.taskStageAction(input.token, input.taskId, { kind: "capture", view: input.view }, input.mode);
        if (!response.ok) {
          if (!structure) throw new Error(response.error ?? "The desktop capture failed.");
        } else {
          capture = stageCapture(response);
          structure = recordOf(capture?.structure) ?? structure;
        }
      }
    }
    structure = recordOf(structure ?? capture?.structure);
    let structureStatus = typeof structure?.status === "string" ? structure.status : undefined;
    if (structureStatus && !["complete", "partial", "unknown", "unavailable", "not-requested"].includes(structureStatus)) {
      structureStatus = "unknown";
    }
    if (!structure && capture && input.representation === "structured") structureStatus = "unavailable";
    let visibleCapture = input.representation === "visual" ? capture : undefined;
    if (input.representation === "structured" && structureStatus !== "complete" && !visibleCapture) {
      const sameCallFallback = recordOf(structure?.fallbackCapture);
      if (sameCallFallback && typeof sameCallFallback.dataUrl === "string") visibleCapture = sameCallFallback;
      else if (capture && typeof capture.dataUrl === "string") visibleCapture = capture;
      else {
        // Older broker builds may return a partial tree without carrying its screenshot.
        // This is one bounded fallback capture, never a route-probing loop.
        const fallback = await deps.web.taskStageAction(input.token, input.taskId, { kind: "capture", view: input.view }, input.mode);
        if (fallback.ok) {
          visibleCapture = stageCapture(fallback);
          structure = recordOf(visibleCapture?.structure) ?? structure;
          structureStatus = typeof structure?.status === "string" ? structure.status : structureStatus;
        }
      }
    }
    let width: number | undefined;
    let height: number | undefined;
    if (visibleCapture) {
      const rawWidth = visibleCapture.width;
      const rawHeight = visibleCapture.height;
      if (!Number.isSafeInteger(rawWidth) || !Number.isSafeInteger(rawHeight)
        || (rawWidth as number) < 1 || (rawHeight as number) < 1 || (rawWidth as number) > 16_384 || (rawHeight as number) > 16_384) {
        throw new Error("The desktop broker returned invalid capture dimensions.");
      }
      width = rawWidth as number;
      height = rawHeight as number;
    }
    const capturedAt = typeof structure?.capturedAt === "string" ? structure.capturedAt
      : typeof visibleCapture?.capturedAt === "string" ? visibleCapture.capturedAt
        : typeof capture?.capturedAt === "string" ? capture.capturedAt : undefined;
    const observedAt = capturedAt ? Date.parse(capturedAt) : Number.NaN;
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("The desktop broker returned an invalid capture timestamp.");
    const controls: DesktopControl[] = [];
    const allElements = Array.isArray(structure?.elements) ? structure.elements : [];
    if (allElements.length > 200 && structureStatus === "complete") structureStatus = "partial";
    const rawElements = allElements.slice(0, 200).map(recordOf).filter((value): value is Record<string, unknown> => Boolean(value));
    const stageRefMap = new Map<string, string>();
    for (const element of rawElements) {
      if (typeof element.ref === "string" && STAGE_REF.test(element.ref) && !stageRefMap.has(element.ref)) {
        stageRefMap.set(element.ref, `control_${randomUUID()}`);
      }
    }
    for (const element of rawElements) {
      if (typeof element.ref !== "string") continue;
      const ref = stageRefMap.get(element.ref);
      if (!ref) continue;
      const actions = Array.isArray(element.actions)
        ? element.actions.filter((action): action is string => typeof action === "string" && action.length > 0).slice(0, 16).map((action) => action.slice(0, 40))
        : [];
      controls.push({
        ref,
        stageRef: element.ref,
        ...(typeof element.parentRef === "string" && stageRefMap.has(element.parentRef) ? { parentRef: stageRefMap.get(element.parentRef)! } : {}),
        ...(Number.isSafeInteger(element.depth) && (element.depth as number) >= 0 ? { depth: element.depth as number } : {}),
        ...(typeof element.role === "string" ? { role: element.role.slice(0, 80) } : {}),
        ...(typeof element.label === "string" ? { label: element.label.slice(0, 160) } : {}),
        ...(typeof element.enabled === "boolean" ? { enabled: element.enabled } : {}),
        ...(typeof element.selected === "boolean" ? { selected: element.selected } : {}),
        ...(actions.length ? { actions } : {}),
        ...(element.canReplaceValue === true ? { canReplaceValue: true } : {}),
        ...(validRect(element.rect) ? { rect: element.rect } : {}),
      });
    }
    const structuredControls = [...controls];
    if (visibleCapture?.controlsTruncated === true && structureStatus === "complete") structureStatus = "partial";
    if (visibleCapture && Array.isArray(visibleCapture.controls)) {
      const controlByStageRef = new Map(controls.filter((control) => control.stageRef).map((control) => [control.stageRef!, control]));
      for (const raw of visibleCapture.controls.slice(0, 200)) {
        const control = recordOf(raw);
        if (!control || !validRect(control.rect)) continue;
        const rect = control.rect;
        const left = Math.max(0, rect.x);
        const top = Math.max(0, rect.y);
        const right = Math.min(width as number, rect.x + rect.width);
        const bottom = Math.min(height as number, rect.y + rect.height);
        if (right <= left || bottom <= top) continue;
        const stageRef = typeof control.elementRef === "string" && STAGE_REF.test(control.elementRef) ? control.elementRef : undefined;
        const existing = stageRef ? controlByStageRef.get(stageRef) : undefined;
        const rectValue = { x: left, y: top, width: right - left, height: bottom - top };
        if (existing) {
          existing.rect = rectValue;
          continue;
        }
        controls.push({
          ref: stageRef ? stageRefMap.get(stageRef) ?? `control_${randomUUID()}` : `control_${randomUUID()}`,
          ...(stageRef ? { stageRef } : {}),
          ...(typeof control.role === "string" ? { role: control.role.slice(0, 80) } : {}),
          ...(typeof control.label === "string" ? { label: control.label.slice(0, 160) } : {}),
          ...(control.canReplaceValue === true ? { canReplaceValue: true } : {}),
          rect: rectValue,
        });
      }
    }
    const map = new Map(controls.map((control) => [control.ref, control]));
    const logicalKey = input.logicalKey ?? `desktop:${input.taskId}:${input.mode}:${input.view}`;
    const inputSelectionConfirmed = input.inputSelectionConfirmed === true;
    const kind = input.view === "app" ? "desktop-window" : "desktop";
    const contextRepresentation = input.representation;
    const rectByStageRef = new Map(controls.filter((control) => control.stageRef && control.rect).map((control) => [control.stageRef!, control.rect!]));
    const fingerprintElements = structuredControls.map((element) => ({
      ...element,
      ...(rectByStageRef.get(element.stageRef ?? element.ref) ? { rect: rectByStageRef.get(element.stageRef ?? element.ref) } : {}),
    })) as unknown as Record<string, unknown>[];
    const fingerprint = normalizeObservationFingerprint(fingerprintElements, structureCompleteness(structureStatus));
    const record = saveObservation({
      identity: input.identity,
      logicalKey,
      kind,
      observedAt,
      capabilities: capabilitiesForDesktop(controls, input.view, inputSelectionConfirmed, contextRepresentation, structureStatus),
      context: { kind: "desktop", taskId: input.taskId, mode: input.mode, view: input.view, representation: contextRepresentation,
        ...(structureStatus ? { structureStatus } : {}), width: width ?? 0, height: height ?? 0, controls: map, inputSelectionConfirmed },
      fingerprint,
    });
    const publicElements = structuredControls.map(({ ref, parentRef, depth, role, label, enabled, selected, actions, canReplaceValue, rect }) => ({
      ref, ...(parentRef ? { parentRef } : {}), ...(depth !== undefined ? { depth } : {}), ...(role ? { role } : {}), ...(label ? { label } : {}),
      ...(enabled !== undefined ? { enabled } : {}), ...(selected !== undefined ? { selected } : {}), ...(actions ? { actions } : {}),
      ...(canReplaceValue ? { canReplaceValue: true } : {}),
      ...(rect ? { rect } : {}),
    }));
    const publicWindows = Array.isArray(structure?.windows) ? structure.windows.slice(0, 12).map((value) => {
      const window = recordOf(value);
      if (!window || typeof window.ref !== "string" || typeof window.appName !== "string"
        || typeof window.title !== "string" || !validRect(window.rect)) return undefined;
      const windowElements = Array.isArray(window.elements) ? window.elements.slice(0, 256).map(recordOf)
        .filter((element): element is Record<string, unknown> => Boolean(element))
        .map((element) => ({
          ...(typeof element.ref === "string" ? { ref: element.ref.slice(0, 512) } : {}),
          ...(typeof element.windowRef === "string" ? { windowRef: element.windowRef.slice(0, 128) } : {}),
          ...(validRect(element.rect) ? { rect: element.rect } : {}),
          ...(typeof element.parentRef === "string" ? { parentRef: element.parentRef.slice(0, 512) } : {}),
          ...(Number.isSafeInteger(element.depth) && (element.depth as number) >= 0 ? { depth: element.depth as number } : {}),
          ...(typeof element.role === "string" ? { role: element.role.slice(0, 80) } : {}),
          ...(typeof element.label === "string" ? { label: element.label.slice(0, 160) } : {}),
          ...(typeof element.enabled === "boolean" ? { enabled: element.enabled } : {}),
          ...(typeof element.selected === "boolean" ? { selected: element.selected } : {}),
          ...(Array.isArray(element.actions) ? { actions: element.actions.filter((action): action is string => typeof action === "string").slice(0, 16).map((action) => action.slice(0, 40)) } : {}),
          ...(element.canReplaceValue === true ? { canReplaceValue: true } : {}),
        })) : undefined;
      return {
        ref: window.ref.slice(0, 128),
        appName: window.appName.slice(0, 120),
        title: window.title.slice(0, 240),
        rect: window.rect,
        ...(window.frontmost === true ? { frontmost: true } : {}),
        ...(typeof window.minimized === "boolean" ? { minimized: window.minimized } : {}),
        ...(typeof window.onCurrentSpace === "boolean" ? { onCurrentSpace: window.onCurrentSpace } : {}),
        ...(window.status === "complete" || window.status === "partial" || window.status === "unavailable" ? { status: window.status } : {}),
        elements: windowElements,
      };
    }).filter((value) => value !== undefined) : undefined;
    const publicShell = recordOf(structure?.shell);
    const structuredObservation = structure && structureStatus ? {
      status: structureStatus,
      capturedAt: typeof structure.capturedAt === "string" ? structure.capturedAt : new Date(observedAt).toISOString(),
      ...(typeof structure.appName === "string" ? { appName: structure.appName.slice(0, 120) } : {}),
      ...(typeof structure.windowTitle === "string" ? { windowTitle: structure.windowTitle.slice(0, 240) } : {}),
      elements: publicElements,
      ...(publicWindows ? { windows: publicWindows } : {}),
      ...(publicShell?.status === "visual-fallback" ? {
        shell: {
          status: "visual-fallback" as const,
          reason: typeof publicShell.reason === "string" ? publicShell.reason.slice(0, 240)
            : "The Windows shell is available through the same-capture visual fallback.",
        },
      } : {}),
      change: record.change,
    } : undefined;
    const publicControls = controls.filter((control) => control.stageRef || control.rect || control.canReplaceValue).map((control) => ({
      ref: control.ref,
      ...(control.parentRef ? { parentRef: control.parentRef } : {}),
      ...(control.depth !== undefined ? { depth: control.depth } : {}),
      ...(control.role ? { role: control.role } : {}),
      ...(control.label ? { label: control.label } : {}),
      ...(control.enabled !== undefined ? { enabled: control.enabled } : {}),
      ...(control.selected !== undefined ? { selected: control.selected } : {}),
      ...(control.actions ? { actions: control.actions } : {}),
      ...(control.canReplaceValue ? { canReplaceValue: true } : {}),
      ...(control.rect ? { rect: control.rect } : {}),
    }));
    const image = visibleCapture ? dataUrlImage(visibleCapture.dataUrl) : undefined;
    const observation = input.representation === "structured"
      ? { representation: "structured", ...(structuredObservation ? { structure: structuredObservation } : {}), controls: publicControls,
          change: record.change,
          ...(visibleCapture ? { capture: publicStageCapture(visibleCapture) } : {}) }
      : { representation: "visual", ...(structuredObservation ? { structure: structuredObservation } : {}),
          change: record.change,
          ...(visibleCapture ? { capture: publicStageCapture(visibleCapture) } : {}), controls: publicControls };
    return {
      record,
      observation,
      ...(image ? { image } : {}),
    };
  }

  async function observeBrowser(input: {
    identity: VerifiedIdentity;
    tab?: string;
    logicalKey?: string;
  }): Promise<{ record: TargetRecord; observation: Record<string, unknown>; image?: ImageBlock }> {
    if (!deps.web) throw new Error("The M9R browser broker is unavailable.");
    // Use the request-start time as a conservative freshness bound. The broker
    // does not carry a capture timestamp through every browser transport, so
    // stamping on response completion would make a slow/queued observation
    // appear newer than the snapshot that produced its element refs.
    const observationStartedAt = now().getTime();
    const response = await deps.web.run({
      agent: input.identity.handle,
      provider: input.identity.provider,
      sessionId: input.identity.sessionId,
      action: "snapshot",
      ...(input.tab ? { tab: input.tab } : {}),
      args: { limit: 150 },
    });
    if (!response.ok) throw new Error(response.error ?? "The M9R browser snapshot failed.");
    const snapshot = browserSnapshotData(response);
    if (!snapshot || !Array.isArray(snapshot.elements)) throw new Error("The browser broker returned no structured page snapshot.");
    const rawElementRecords = snapshot.elements.map(recordOf).filter((value): value is Record<string, unknown> => Boolean(value));
    const browserCompleteness: FingerprintCompleteness = rawElementRecords.length > 150 ? "partial" : "complete";
    const rawElements = rawElementRecords.slice(0, 150);
    const observedRefs = new Set(rawElements.flatMap((element) => typeof element.ref === "string" && BROWSER_REF.test(element.ref)
      && element.sensitive !== true ? [element.ref] : []));
    const elements: BrowserElement[] = [];
    for (const element of rawElements) {
      if (!element || typeof element.ref !== "string" || !BROWSER_REF.test(element.ref) || element.sensitive === true) continue;
      const actions = Array.isArray(element.actions)
        ? element.actions.filter((action): action is string => typeof action === "string" && action.length > 0).slice(0, 16).map((action) => action.slice(0, 40))
        : undefined;
      elements.push({
        ref: element.ref,
        role: typeof element.role === "string" ? element.role.slice(0, 80) : "unknown",
        name: typeof element.name === "string" ? element.name.slice(0, 160) : "",
        ...(typeof element.parentRef === "string" && observedRefs.has(element.parentRef) && element.parentRef !== element.ref
          ? { parentRef: element.parentRef } : {}),
        ...(Number.isSafeInteger(element.depth) && (element.depth as number) >= 0 && (element.depth as number) <= 255
          ? { depth: element.depth as number } : {}),
        ...(typeof element.disabled === "boolean" ? { disabled: element.disabled } : {}),
        ...(typeof element.selected === "boolean" ? { selected: element.selected } : {}),
        ...(actions?.length ? { actions } : {}),
        ...(typeof element.canReplaceValue === "boolean" ? { canReplaceValue: element.canReplaceValue } : {}),
        ...(typeof element.canInsertText === "boolean" ? { canInsertText: element.canInsertText } : {}),
        ...(typeof element.canSelectText === "boolean" ? { canSelectText: element.canSelectText } : {}),
        ...(validRect(element.rect) ? { rect: element.rect } : {}),
      });
    }
    const elementMap = new Map(elements.map((element) => [element.ref, element]));
    const url = typeof snapshot.url === "string" ? snapshot.url.slice(0, 4096) : undefined;
    const title = typeof snapshot.title === "string" ? snapshot.title.slice(0, 256) : undefined;
    const fingerprint = normalizeObservationFingerprint(elements.map((element) => ({
      ...element,
      label: element.name,
      ...(element.disabled !== undefined ? { enabled: !element.disabled } : {}),
    })) as unknown as Record<string, unknown>[], browserCompleteness);
    const record = saveObservation({
      identity: input.identity,
      logicalKey: input.logicalKey ?? `browser:${input.tab ?? "default"}`,
      kind: "browser-tab",
      observedAt: observationStartedAt,
      capabilities: capabilitiesForBrowser(elements, snapshot.nativeClickAvailable === true),
      context: { kind: "browser", ...(input.tab ? { tab: input.tab } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}),
        ...(typeof snapshot.text === "string" ? { text: snapshot.text.slice(0, 4_000) } : {}), elements: elementMap },
      extra: { ...(url ? { url } : {}) },
      fingerprint,
    });
    return {
      record,
      observation: {
        url,
        title,
        text: typeof snapshot.text === "string" ? snapshot.text.slice(0, 4_000) : "",
        elements,
        change: record.change,
      },
    };
  }

  async function refreshRecord(record: TargetRecord, token: string, identity: VerifiedIdentity) {
    return record.context.kind === "browser"
      ? observeBrowser({ identity, tab: record.context.tab, logicalKey: record.scopeKey })
      : observeDesktop({ token, identity, taskId: record.context.taskId, mode: record.context.mode, view: record.context.view,
          representation: record.context.representation, logicalKey: record.scopeKey });
  }

  function checkLocator(record: TargetRecord, locator: ComputerUseLocator): string | undefined {
    if (locator.kind === "point") {
      const expectedSpace = record.context.kind === "browser" ? "page-viewport" : "target-local";
      if (locator.coordinateSpace !== expectedSpace) return `This target requires ${expectedSpace} coordinates.`;
      if (record.context.kind === "desktop" && (locator.x >= record.context.width || locator.y >= record.context.height)) {
        return "The point is outside the latest desktop capture.";
      }
      return undefined;
    }
    if (locator.snapshotId !== record.target.revision) return "The element reference belongs to an older observation; observe the target again.";
    const elements = record.context.kind === "browser" ? record.context.elements : record.context.controls;
    return elements.has(locator.ref) ? undefined : "The element reference was not present in this target observation.";
  }

  function actionPreflight(record: TargetRecord, action: ComputerUseAction): string | undefined {
    if (action.kind === "focus") {
      return record.context.kind === "desktop" && record.context.view === "app"
        ? undefined
        : "Standalone focus is available only for one exact observed app window; browser tabs and desktop-wide views have no bounded OS focus target.";
    }
    if (action.postcondition && action.postcondition.kind !== "accessible-control-present" && record.context.kind !== "browser") {
      return `The ${action.postcondition.kind} postcondition requires a browser-tab observation.`;
    }
    if (action.postcondition?.kind === "accessible-control-present" && record.context.kind === "desktop" && record.context.controls.size === 0) {
      return "This desktop target did not expose accessible controls, so the requested postcondition cannot be verified; no action was sent.";
    }
    if (action.kind === "click") {
      const error = checkLocator(record, action.locator);
      if (error) return error;
      if (record.context.kind === "browser" && action.locator.kind === "element"
        && record.context.elements.get(action.locator.ref)?.disabled === true) {
        return "The referenced browser control was observed disabled; no input was sent.";
      }
      if (record.context.kind === "desktop" && action.locator.kind === "element") {
        const control = record.context.controls.get(action.locator.ref);
        const semanticClick = action.button === "left" && action.count === 1 && control?.stageRef
          && control.enabled !== false && control.actions?.some((name) => /^(?:click|invoke|press|expand|toggle|select)$/i.test(name));
        if (!semanticClick && !control?.rect) {
          return "This structured element has no safe semantic click action and no visual fallback bounds. Request a fresh visual app-window observation; no input was sent.";
        }
      }
      if (record.context.kind === "browser" && action.button === "middle" && action.locator.kind === "element"
        && !record.context.elements.get(action.locator.ref)?.rect) {
        return "The browser snapshot has no bounds for this middle-click target; no input was sent.";
      }
      return undefined;
    }
    if (action.kind === "text") {
      if (record.context.kind === "browser") {
        if (action.locator?.kind !== "element") return "Browser text input requires a fresh editable element reference.";
        const error = checkLocator(record, action.locator);
        if (error) return error;
        const element = record.context.elements.get(action.locator.ref);
        const supported = element && (action.mode === "insert" ? canInsertBrowserText(element) : canReplaceBrowserValue(element));
        return supported
          ? undefined
          : `The referenced browser control was not observed to support text ${action.mode === "insert" ? "insertion at a caret" : "replacement"}; no input was sent.`;
      }
      if (action.mode === "insert") {
        if (action.locator) return "Desktop insertion uses the exact input target selected by a preceding confirmed click; it does not reinterpret a locator as focus.";
        return record.context.inputSelectionConfirmed
          ? undefined
          : "Desktop text insertion requires a confirmed input selection from a successful click on this exact target; no input was sent.";
      }
      if (action.locator?.kind !== "element") return "Desktop field replacement requires a fresh accessible element reference.";
      const error = checkLocator(record, action.locator);
      if (error) return error;
      const control = record.context.controls.get(action.locator.ref);
      return control?.canReplaceValue && Boolean(control.role?.trim()) && Boolean(control.stageRef || control.rect)
        ? undefined
        : "The referenced desktop control does not advertise an accessible whole-value replacement action.";
    }
    if (action.kind === "select_text") {
      if (record.context.kind !== "browser" || action.locator.kind !== "element" || action.selection.kind !== "text") {
        return "This route supports selecting a text phrase in a browser element, not select-all or point-based selection.";
      }
      if (action.selection.occurrence !== undefined && action.selection.occurrence !== 0) {
        return "This browser route selects the first matching occurrence only.";
      }
      const error = checkLocator(record, action.locator);
      if (error) return error;
      const element = record.context.elements.get(action.locator.ref);
      return element && canSelectBrowserText(element)
        ? undefined
        : "The referenced browser element was not observed to contain selectable DOM text; no selection was sent.";
    }
    if (action.kind === "scroll") {
      if (record.context.kind === "desktop") {
        if (action.unit === "pixel") return "The desktop driver exposes line or page scroll units, not pixel-distance scrolling.";
        if (Math.abs(action.deltaX || action.deltaY) > 50) return "The desktop driver supports at most 50 scroll ticks per operation; no input was sent.";
        if (action.at?.kind !== "point") return "Desktop scrolling requires a fresh point on the exact target window.";
        return checkLocator(record, action.at);
      }
      if (action.unit !== "pixel") return "The browser broker accepts scroll distances in pixels only.";
      if (action.deltaX !== 0) return "The browser route currently exposes vertical page scrolling only.";
      if (action.at) return "The browser route exposes page-level pixel scrolling; element-scoped scrolling has different semantics and is not routed here.";
      return undefined;
    }
    if (action.kind === "drag") {
      if (record.context.kind === "desktop") {
        if (action.from.kind !== "point" || action.to.kind !== "point") return "The desktop stage drag route requires two captured points.";
        const fromError = checkLocator(record, action.from);
        return fromError ?? checkLocator(record, action.to);
      }
      if (action.from.kind !== "element" || action.to.kind !== "element") return "The browser drag route requires source and destination element references.";
      const fromError = checkLocator(record, action.from);
      const toError = fromError ?? checkLocator(record, action.to);
      if (toError) return toError;
      if (record.context.elements.get(action.from.ref)?.disabled === true || record.context.elements.get(action.to.ref)?.disabled === true) {
        return "Both browser drag targets must be enabled in the latest observation; no drag was sent.";
      }
      return undefined;
    }
    if (action.kind === "navigate" && record.context.kind !== "browser") return "Navigation is available only for a browser-tab target.";
    if (action.kind === "key" && record.context.kind === "desktop" && record.context.view === "desktop"
      && !record.context.inputSelectionConfirmed) {
      return "Desktop-wide key input requires a confirmed target-window selection; click a target and verify the returned result first.";
    }
    return undefined;
  }

  function locatorRef(record: TargetRecord, locator: ComputerUseLocator): string {
    if (locator.kind !== "element") throw new Error("The selected route requires an element reference.");
    const elements = record.context.kind === "browser" ? record.context.elements : record.context.controls;
    if (!elements.has(locator.ref) || locator.snapshotId !== record.target.revision) throw new Error("The element reference is stale.");
    return locator.ref;
  }

  function desktopPoint(record: TargetRecord, locator: ComputerUseLocator): { x: number; y: number } {
    if (record.context.kind !== "desktop") throw new Error("The selected route is not a desktop target.");
    if (locator.kind === "point") return { x: locator.x, y: locator.y };
    const control = record.context.controls.get(locator.ref);
    if (!control || locator.snapshotId !== record.target.revision) throw new Error("The desktop control reference is stale.");
    if (!control.rect) throw new Error("This structured element has no visual bounds; request a fresh visual observation before a coordinate-based action.");
    return { x: Math.floor(control.rect.x + control.rect.width / 2), y: Math.floor(control.rect.y + control.rect.height / 2) };
  }

  function webElement(record: TargetRecord, locator: ComputerUseLocator): BrowserElement {
    if (record.context.kind !== "browser" || locator.kind !== "element") throw new Error("The browser route requires a page element reference.");
    if (locator.snapshotId !== record.target.revision) throw new Error("The browser element reference is stale.");
    const element = record.context.elements.get(locator.ref);
    if (!element) throw new Error("The browser element reference is not in the latest snapshot.");
    return element;
  }

  function webTargetLabel(record: TargetRecord, locator: ComputerUseLocator): string | undefined {
    try { return webElement(record, locator).name || undefined; } catch { return undefined; }
  }

  function verifyPostcondition(record: TargetRecord, condition: ComputerUsePostcondition): "verified" | "mismatch" | "unknown" {
    if (condition.kind === "url-equals") {
      if (record.context.kind !== "browser" || !record.context.url) return "unknown";
      try {
        const expectedUrl = new URL(condition.url).href;
        const observedUrl = new URL(record.context.url).href;
        return observedUrl === expectedUrl ? "verified" : "mismatch";
      } catch { return "unknown"; }
    }
    if (condition.kind === "visible-text-contains") {
      if (record.context.kind !== "browser" || record.context.text === undefined) return "unknown";
      return record.context.text.includes(condition.text) ? "verified" : "unknown";
    }
    const controls = record.context.kind === "browser"
      ? [...record.context.elements.values()].map(({ role, name }) => ({ role, label: name }))
      : [...record.context.controls.values()];
    return controls.some((control) =>
      (condition.role === undefined || control.role === condition.role)
      && (condition.label === undefined || control.label === condition.label)) ? "verified" : "unknown";
  }

  function webRequestForAction(record: TargetRecord, action: ComputerUseAction, identity: VerifiedIdentity): WebRequest {
    if (record.context.kind !== "browser") throw new Error("The selected route is not a browser target.");
    const shared = {
      agent: identity.handle,
      provider: identity.provider,
      sessionId: identity.sessionId,
      ...(record.context.tab ? { tab: record.context.tab } : {}),
    };
    if (action.kind === "navigate") return { action: "open", ...shared, url: action.url };
    if (action.kind === "click") {
      if (action.locator.kind === "point") {
        return { action: "click_at", ...shared, args: { x: action.locator.x, y: action.locator.y, button: action.button } };
      }
      const element = webElement(record, action.locator);
      if (action.count === 2) return { action: "double_click", ...shared, selector: `@m9r-ref:${element.ref}`, ...(element.name ? { targetLabel: element.name } : {}) };
      if (action.button === "right") return { action: "right_click", ...shared, selector: `@m9r-ref:${element.ref}`, ...(element.name ? { targetLabel: element.name } : {}) };
      if (action.button === "middle") {
        if (!element.rect) throw new Error("The browser snapshot has no bounds for a middle-click target.");
        return { action: "click_at", ...shared, args: {
          x: element.rect.x + Math.floor(element.rect.width / 2),
          y: element.rect.y + Math.floor(element.rect.height / 2),
          button: "middle",
        } };
      }
      return { action: "click", ...shared, selector: `@m9r-ref:${element.ref}`, ...(element.name ? { targetLabel: element.name } : {}) };
    }
    if (action.kind === "text") {
      const selector = `@m9r-ref:${locatorRef(record, action.locator!)}`;
      const targetLabel = webTargetLabel(record, action.locator!);
      return action.mode === "insert"
        ? { action: "paste", ...shared, selector, args: { valueText: action.text }, ...(targetLabel ? { targetLabel } : {}) }
        : { action: "type", ...shared, selector, text: action.text, ...(targetLabel ? { targetLabel } : {}) };
    }
    if (action.kind === "key") {
      const key = [...(action.modifiers ?? []), action.key].join("+");
      return { action: "press", ...shared, args: { key } };
    }
    if (action.kind === "select_text") return {
      action: "select_text", ...shared,
      selector: `@m9r-ref:${locatorRef(record, action.locator)}`,
      ...(webTargetLabel(record, action.locator) ? { targetLabel: webTargetLabel(record, action.locator) } : {}),
      args: { text: action.selection.kind === "text" ? action.selection.text : "" },
    };
    if (action.kind === "scroll") return { action: "scroll", ...shared, args: { by: action.deltaY } };
    if (action.kind === "drag") return {
      action: "drag", ...shared,
      selector: `@m9r-ref:${locatorRef(record, action.from)}`,
      endSelector: `@m9r-ref:${locatorRef(record, action.to)}`,
      ...(webTargetLabel(record, action.from) ? { targetLabel: webTargetLabel(record, action.from) } : {}),
    };
    throw new Error(`The browser route does not support ${action.kind}.`);
  }

  async function dispatchDesktop(record: TargetRecord, action: ComputerUseAction, token: string): Promise<StageClientResult> {
    if (record.context.kind !== "desktop" || !deps.web?.taskStageAction) throw new Error("The owner-launched desktop stage broker is unavailable.");
    let stageAction: unknown;
    if (action.kind === "click") {
      const control = action.locator.kind === "element" ? record.context.controls.get(action.locator.ref) : undefined;
      const semanticClick = action.locator.kind === "element" && action.button === "left" && action.count === 1
        && control?.stageRef && control.enabled !== false && control.actions?.some((name) => /^(?:click|invoke|press|expand|toggle|select)$/i.test(name));
      const confirmFocusForeground = action.confirmFocusForeground === true;
      if (semanticClick) {
        stageAction = { kind: "click_element", ref: control.stageRef, view: "app",
          ...(control.role !== undefined ? { expectedRole: control.role } : {}),
          ...(control.label !== undefined ? { expectedLabel: control.label } : {}),
          ...(confirmFocusForeground ? { confirmFocusForeground } : {}) };
      } else {
        const point = desktopPoint(record, action.locator);
      stageAction = { kind: action.count === 2 ? "double_click" : action.button === "right" ? "right_click" : action.button === "middle" ? "middle_click" : "click", ...point, view: record.context.view,
          ...(confirmFocusForeground ? { confirmFocusForeground } : {}) };
      }
    } else if (action.kind === "key") {
      const keys = [...(action.modifiers ?? []), action.key];
      stageAction = keys.length === 1
        ? { kind: "press_key", key: action.key, view: record.context.view,
          ...(action.confirmFocusForeground ? { confirmFocusForeground: true } : {}) }
        : { kind: "hotkey", keys, view: record.context.view,
          ...(action.confirmFocusForeground ? { confirmFocusForeground: true } : {}) };
    } else if (action.kind === "drag" && action.from.kind === "point" && action.to.kind === "point") {
      stageAction = { kind: "drag", fromX: action.from.x, fromY: action.from.y, toX: action.to.x, toY: action.to.y,
        ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}), view: record.context.view,
        ...(action.confirmFocusForeground ? { confirmFocusForeground: true } : {}) };
    } else if (action.kind === "text" && action.mode === "insert") {
      stageAction = { kind: "type", mode: "insert", text: action.text, view: record.context.view,
        ...(action.confirmFocusForeground ? { confirmFocusForeground: true } : {}) };
    } else if (action.kind === "text" && action.mode === "replace" && action.locator?.kind === "element") {
      const control = record.context.controls.get(action.locator.ref)!;
      if (control.stageRef) {
        stageAction = { kind: "replace_element", ref: control.stageRef, text: action.text, view: "app" };
      } else {
        const point = desktopPoint(record, action.locator);
        stageAction = { kind: "type", mode: "replace", ...point, expectedRole: control.role, ...(control.label !== undefined ? { expectedLabel: control.label } : {}),
          text: action.text, view: record.context.view };
      }
    } else if (action.kind === "scroll" && action.at?.kind === "point") {
      stageAction = { kind: "scroll_delta", x: action.at.x, y: action.at.y,
        deltaX: action.deltaX, deltaY: action.deltaY, unit: action.unit, view: record.context.view,
        ...(action.confirmFocusForeground ? { confirmFocusForeground: true } : {}) };
    } else if (action.kind === "window_frame") {
      stageAction = { kind: "window_frame", view: "app", x: action.x, y: action.y, width: action.width, height: action.height };
    } else if (action.kind === "window_state") {
      stageAction = { kind: "window_state", view: "app", state: action.state };
    } else if (action.kind === "focus") {
      stageAction = { kind: "focus", view: "app", confirmFocusForeground: true };
    } else if (action.kind === "invoke_menu") {
      stageAction = { kind: "invoke_menu", view: "app", path: action.path };
    } else if (action.kind === "clipboard") {
      stageAction = action.mode === "read"
        ? { kind: "clipboard_read", view: "app", includeText: action.includeText === true,
          ...(action.confirmSharedClipboard ? { confirmSharedClipboard: true } : {}) }
        : { kind: "clipboard_write", view: "app", text: action.text, confirmSharedClipboard: true };
    } else {
      throw new Error(`The desktop route does not support ${action.kind}.`);
    }
    return deps.web.taskStageAction(token, record.context.taskId, stageAction, record.context.mode, action.operationId);
  }

  function refusal(action: ComputerUseAction, targetId: string, code: string, message: string,
    retry: "never" | "same-operation-id" | "refresh-target" | "new-operation-id" = "never", nextStep?: string) {
    const result = createComputerUseResult({
      operationId: action.operationId,
      targetId,
      dispatchStatus: "not-dispatched",
      effectStatus: "not-checked",
      error: { code, message: message.slice(0, 2_000), retry },
    });
    return toolResponse({ result, ...(nextStep ? { nextStep } : {}) }, undefined, true);
  }

  function uncertain(action: ComputerUseAction, targetId: string, routeId: string, code: string, message: string,
    retry: "never" | "same-operation-id" | "refresh-target" | "new-operation-id" = "never") {
    const result = createComputerUseResult({
      operationId: action.operationId,
      targetId,
      routeId,
      dispatchStatus: "unknown",
      effectStatus: "unknown",
      error: { code, message: message.slice(0, 2_000), retry },
    });
    return toolResponse({ result }, undefined, true);
  }

  function operationInput(identity: VerifiedIdentity, action: ComputerUseAction): ComputerOperationInput {
    return {
      handle: identity.handle,
      sessionId: identity.sessionId,
      targetId: action.targetId,
      operationId: action.operationId,
      fingerprint: createHash("sha256").update(JSON.stringify(action)).digest("hex"),
    };
  }

  function settleReceipt(input: ComputerOperationInput, state: "applied" | "uncertain"): StageOperationClaim {
    try {
      deps.store.settleComputerOperation({ ...input, state });
      return deps.store.inspectComputerOperation(input) ?? { state: "in_progress" };
    } catch {
      // The running claim remains a replay barrier even when finalization itself fails.
      return { state: "in_progress" };
    }
  }

  async function reconcileOperation(input: {
    action: ComputerUseAction;
    identity: VerifiedIdentity;
    receipt: StageOperationClaim;
    record?: TargetRecord;
    token: string;
    timing: ComputerUseTimingRecorder;
    reason?: string;
  }) {
    const { action, identity, receipt, record, token, timing, reason } = input;
    if (receipt.state === "conflict") {
      return refusal(action, action.targetId, "operation-id-conflict", "This operation ID is already bound to a different computer-use action. Use a new operation ID for different input.");
    }
    if (receipt.state === "claimed") {
      return uncertain(action, action.targetId, record?.route.routeId ?? "m9r-computer-use", "operation-claim-race",
        "Another call claimed this operation first. No second input was sent; retry the same operation ID to reconcile it.", "same-operation-id");
    }

    let refreshed: Awaited<ReturnType<typeof refreshRecord>> | undefined;
    let refreshError: string | undefined;
    if (receipt.state !== "in_progress" && record) {
      try { refreshed = await timing.measure("observationMs", () => refreshRecord(record, token, identity)); }
      catch (error) { refreshError = error instanceof Error ? error.message : "A fresh observation was unavailable."; }
    }
    const postconditionStatus = refreshed && action.postcondition
      ? timing.measureSync("verificationMs", () => verifyPostcondition(refreshed.record, action.postcondition!))
      : undefined;
    const effectStatus: ComputerUseResult["effectStatus"] = postconditionStatus
      ?? (receipt.state === "applied" && refreshed ? "observed" : "unknown");
    const dispatchStatus: ComputerUseResult["dispatchStatus"] = receipt.state === "applied" ? "dispatched" : "unknown";
    const receiptStatus = receipt.state === "applied" || receipt.state === "uncertain" || receipt.state === "in_progress"
      ? receipt.state : "in_progress";
    const baseMessage = receipt.state === "in_progress"
      ? "This operation is still in progress. No duplicate input was sent; reconcile again with the same operation ID."
      : receipt.state === "uncertain"
        ? "The prior browser/desktop result was ambiguous. No duplicate input was sent; inspect the fresh observation before deciding whether a new operation is needed."
        : action.postcondition && effectStatus !== "verified"
          ? effectStatus === "mismatch"
            ? "The operation was already dispatched, but the requested postcondition does not match the fresh observation.": "The operation was already dispatched, but the requested postcondition could not be confirmed from the fresh observation."
          : receipt.state === "applied" && !refreshed && !refreshError
            ? "The operation receipt proves prior dispatch, but the observation cache is unavailable. Re-observe the intended target; do not assume the effect or resend this input."
          : refreshError
            ? `The operation was already dispatched; no duplicate input was sent, but fresh observation failed: ${refreshError}`
            : "This operation was already dispatched. No duplicate input was sent; inspect the fresh observation before requesting a distinct next action.";
    const message = reason ? `${baseMessage} Route detail: ${reason}` : baseMessage;
    const errorCode = receipt.state === "in_progress" ? "operation-in-progress"
      : receipt.state === "uncertain" ? "operation-outcome-uncertain"
        : action.postcondition && effectStatus !== "verified" ? effectStatus === "mismatch" ? "postcondition-mismatch" : "postcondition-unverified"
          : refreshError ? "post-action-observation-failed"
            : receipt.state === "applied" && !refreshed && !refreshError ? "post-action-observation-unavailable" : undefined;
    const result = createComputerUseResult({
      operationId: action.operationId,
      targetId: action.targetId,
      ...(record ? { routeId: record.route.routeId } : {}),
      dispatchStatus,
      effectStatus,
      operationReceipt: { status: receiptStatus, ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}) },
      ...(refreshed ? { observation: { revision: refreshed.record.target.revision, observedAt: refreshed.record.target.observedAt, evidenceRef: refreshed.record.target.revision } } : {}),
      ...(errorCode ? { error: { code: errorCode, message: message.slice(0, 2_000), retry: errorCode === "post-action-observation-unavailable" ? "refresh-target" as const : "same-operation-id" as const } } : {}),
    });
    return toolResponse({
      result,
      operationReceipt: { status: receiptStatus, ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}) },
      ...(refreshed ? { target: refreshed.record.target, observation: refreshed.observation } : {}),
      ...(message ? { nextStep: message } : {}),
    }, refreshed?.image, Boolean(errorCode));
  }

  async function refreshStaleTarget(action: ComputerUseAction, identity: VerifiedIdentity, record: TargetRecord, token: string,
    timing: ComputerUseTimingRecorder, reason: string) {
    try {
      const refreshed = await timing.measure("observationMs", () => refreshRecord(record, token, identity));
      const result = createComputerUseResult({
        operationId: action.operationId,
        targetId: action.targetId,
        routeId: record.route.routeId,
        dispatchStatus: "not-dispatched",
        effectStatus: "not-checked",
        error: { code: "stale-observation", message: reason.slice(0, 2_000), retry: "refresh-target" },
      });
      return toolResponse({
        result,
        target: refreshed.record.target,
        observation: refreshed.observation,
        nextStep: "The action was not sent. Re-plan it against this fresh observation and use a new operation ID.",
      }, refreshed.image, true);
    } catch (error) {
      return refusal(action, action.targetId, "stale-observation",
        `${reason} A fresh observation also failed: ${error instanceof Error ? error.message : "unknown observation error"}`, "refresh-target");
    }
  }

  server.registerTool("m9r_computer_observe", {
    description: "Observe one M9R-managed target and return an opaque target ID, fresh revision, and only the capabilities that route currently advertises. Selected app windows default to a value-redacted UI Automation tree; desktop-wide targets default to a bounded composite of visible windows and controls with the same-capture visual fallback for taskbar, Start, and shell-owned controls. Request representation=visual when pixels are needed. Browser tabs return structured DOM controls; if that route cannot expose a needed capability, explicitly select/restore the browser and observe its exact app-window rather than silently switching routes. Use m9r_stage_app before app-window; this tool never launches an app. Re-observe after visible state changes; raw HWNDs and browser-process IDs are never exposed. Returns phase timing telemetry; timing is diagnostic, not proof of an effect.",
    inputSchema: inputSchemas.observe,
    outputSchema: COMPUTER_USE_OUTPUT_SCHEMA,
  }, withComputerUseTelemetry<ComputerUseObserveArgs>(async ({ token, target, taskId, mode, representation, tab }, timing) => {
    const identity = await deps.requireIdentity(token);
    const authToken = await deps.identityToken(identity, token);
    const at = now().getTime();
    pruneTargets(at);
    try {
      if (!COMPUTER_USE_OBSERVE_TARGETS.includes(target)) {
        throw new Error(`No computer-use route is registered for target ${String(target)}.`);
      }
      if (target === "browser-tab" && taskId !== undefined) throw new Error("Browser-tab observation does not take a desktop task ID.");
      if (target !== "browser-tab" && tab !== undefined) throw new Error("Desktop observations do not take a browser tab name.");
      if (target === "browser-tab" && representation === "visual") {
        throw new Error("The browser-tab route provides structured DOM observations. For a visual fallback, select or restore that exact browser window and observe it as app-window with representation 'visual'.");
      }
      const resolvedRepresentation = representation ?? "structured";
      const resolvedTaskId = target === "browser-tab" ? undefined : deps.resolveTaskId(identity, taskId);
      const observed = await timing.measure("observationMs", async () => target === "browser-tab"
        ? observeBrowser({ identity, tab })
        : resolvedTaskId
          ? observeDesktop({ token: authToken, identity, taskId: resolvedTaskId, mode: mode ?? "owner-preview", view: target === "app-window" ? "app" : "desktop",
              representation: resolvedRepresentation })
          : undefined);
      if (!observed) throw new Error("Desktop and app-window observations require an active authenticated task; browser-tab observations do not.");
      return toolResponse({ target: observed.record.target, observation: observed.observation }, observed.image);
    } catch (error) {
      return toolResponse({ error: error instanceof Error ? error.message : "Target observation failed." }, undefined, true);
    }
  }, monotonicNow));

  server.registerTool("m9r_computer_action", {
    description: "Route one provider-neutral action to the observed target's compatible M9R broker capability. The action must contain the exact target ID/revision and a stable operation ID. Mutations use durable one-shot receipts; reconcile a lost response with the same ID, never a new ID. Optional postconditions are checked against a fresh observation; transport success alone is never verified success. Route affinity, stale refs, broker claims/risk/owner approvals, and input-lease safety remain enforced; unsupported semantics refuse without fallback. Returns per-call phase timing and whether an earlier receipt was found; timing is diagnostic, not proof of an effect.",
    inputSchema: inputSchemas.action,
    outputSchema: COMPUTER_USE_OUTPUT_SCHEMA,
  }, withComputerUseTelemetry<ComputerUseActionArgs>(async ({ token, action: actionValue }, timing) => {
    const identity = await deps.requireIdentity(token);
    const authToken = await deps.identityToken(identity, token);
    let action: ComputerUseAction;
    try { action = parseComputerUseAction(normalizeComputerUseActionWire(actionValue)); }
    catch (error) { return toolResponse({ error: error instanceof Error ? error.message : "Invalid computer-use action." }, undefined, true); }
    const receiptInput = action.kind === "observe" ? undefined : operationInput(identity, action);
    if (receiptInput) {
      let previous: StageOperationClaim | undefined;
      try { previous = deps.store.inspectComputerOperation(receiptInput); }
      catch { return refusal(action, action.targetId, "operation-receipt-unavailable", "The durable operation receipt could not be read; no input was sent."); }
      if (previous) {
        timing.markPriorReceiptFound();
        const priorRecord = records.get(action.targetId);
        return reconcileOperation({ action, identity, receipt: previous, token: authToken,
          timing, ...(priorRecord?.identityKey === identityKey(identity) ? { record: priorRecord } : {}) });
      }
    }
    const record = records.get(action.targetId);
    if (!record || record.identityKey !== identityKey(identity)) {
      return refusal(action, action.targetId, "target-not-found", "This target is unknown to the current M9R session. Observe it again in this session.", "refresh-target");
    }
    const nowMs = now().getTime();
    pruneTargets(nowMs);
    if (!records.has(action.targetId) || record.target.revision !== action.targetRevision) {
      return refreshStaleTarget(action, identity, record, authToken, timing, "The action does not match the latest target revision.");
    }
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(record.target.observedAt)
      || nowMs < record.target.observedAt || nowMs - record.target.observedAt > MAX_OBSERVATION_AGE_MS) {
      return refreshStaleTarget(action, identity, record, authToken, timing, "The target observation is too old to use.");
    }
    const preflightError = actionPreflight(record, action);
    if (preflightError) {
      if (/stale|older observation|not present in this target observation/i.test(preflightError)) {
        return refreshStaleTarget(action, identity, record, authToken, timing, preflightError);
      }
      return refusal(action, action.targetId, "unsupported-target-action", preflightError);
    }
    const selection = timing.measureSync("routingMs", () => selectComputerUseRoute({
      sessionId: identity.sessionId,
      target: record.target,
      action,
      routes: [record.route],
      nowMs,
      maxObservationAgeMs: MAX_OBSERVATION_AGE_MS,
      ...(record.pinnedRouteId ? { pinnedRouteId: record.pinnedRouteId } : {}),
    }));
    if (!selection.ok) {
      const browserWindowFallback = selection.code === "unsupported-target-capability"
        && record.target.kind === "browser-tab"
        && selection.required?.some((capability) => capability.startsWith("input.click.")) === true;
      const detail = selection.code === "unsupported-target-capability" && selection.required?.length
        ? `The target did not advertise: ${selection.required.join(", ")}.`
        : selection.code === "owner-input-lease-required"
          ? "This route requires an explicit, visible owner input lease; no shared OS input was sent."
          : selection.code === "pinned-route-unavailable"
            ? "The route pinned for this target is unavailable; the router refused to switch routes silently."
            : selection.code === "no-compatible-route"
              ? "No registered adapter supports this target kind and action capability."
              : `No safe compatible route was selected (${selection.code}).`;
      const nextRoute = browserWindowFallback
        ? " Browser-page click input is unavailable. Use m9r_stage_app to select or restore the existing browser, then call m9r_computer_observe with target 'app-window' for a fresh platform-accessibility/screenshot observation; this is a new explicit route, not an automatic retry."
        : " Choose a target or action with an advertised capability.";
      const nextStep = browserWindowFallback
        ? "The browser click was not dispatched. Use m9r_stage_app to select or restore the existing browser, then call m9r_computer_observe for target 'app-window' and re-plan the click using its fresh exact-window observation. No automatic retry occurred."
        : undefined;
      return refusal(action, action.targetId, selection.code, `${detail}${nextRoute}`, "never", nextStep);
    }
    record.pinnedRouteId = selection.routeId;

    // Finding AE: the 30s observation-age check above only catches staleness by elapsed
    // time, not by what actually happened to the window since it was observed. One bounded
    // lifecycle probe (not a capture, not a retry loop) catches the window having been
    // closed, moved, or minimized in the meantime, so a coordinate from a now-meaningless
    // screenshot is never dispatched blind. It does not catch same-window content changes
    // (e.g. in-place navigation) -- that still requires a fresh observation, same as today.
    // A probe failure must not block a dispatch that might otherwise succeed.
    if (record.context.kind === "desktop" && record.context.view === "app" && action.kind !== "observe" && deps.web?.taskStageAction) {
      try {
        const status = await deps.web!.taskStageAction!(
          authToken, record.context.kind === "desktop" ? record.context.taskId : "", { kind: "window_status", view: "app" },
          record.context.kind === "desktop" ? record.context.mode : undefined);
        const windowState = status && typeof status === "object" && status.ok
          ? (status.result as Record<string, unknown> | undefined)?.windowState : undefined;
        if (typeof windowState === "string" && windowState !== "visible") {
          return refreshStaleTarget(action, identity, record, authToken, timing,
            `The target window is no longer visible (${windowState}); observe it again before acting.`);
        }
      } catch { /* the freshness probe is a bonus safety net, not a new point of failure */ }
    }

    let browserRequest: WebRequest | undefined;
    if (record.context.kind === "browser" && action.kind !== "observe") {
      if (!deps.web) return refusal(action, action.targetId, "browser-route-unavailable", "The M9R browser broker is unavailable.");
      try { browserRequest = webRequestForAction(record, action, identity); }
      catch (error) { return refusal(action, action.targetId, "unsupported-target-action", error instanceof Error ? error.message : "The browser route cannot represent this action."); }
    }

    if (receiptInput) {
      let claim: StageOperationClaim;
      try { claim = deps.store.claimComputerOperation(receiptInput); }
      catch (error) {
        return refusal(action, action.targetId, "operation-receipt-unavailable",
          error instanceof Error ? error.message : "The durable operation receipt could not be claimed; no input was sent.");
      }
      if (claim.state !== "claimed") {
        timing.markPriorReceiptFound();
        return reconcileOperation({ action, identity, receipt: claim, record, token: authToken, timing });
      }
    }

    if (action.kind === "observe") {
      try {
        const refreshed = await timing.measure("observationMs", () => record.context.kind === "browser"
          ? observeBrowser({ identity, tab: record.context.tab, logicalKey: record.scopeKey })
          : observeDesktop({ token: authToken, identity, taskId: record.context.taskId, mode: record.context.mode, view: record.context.view,
              representation: record.context.representation, logicalKey: record.scopeKey, inputSelectionConfirmed: record.context.inputSelectionConfirmed }));
        const effectStatus = action.postcondition
          ? timing.measureSync("verificationMs", () => verifyPostcondition(refreshed.record, action.postcondition!))
          : "observed";
        const result = createComputerUseResult({
          operationId: action.operationId,
          targetId: action.targetId,
          routeId: selection.routeId,
          dispatchStatus: "not-dispatched",
          effectStatus,
          observation: { revision: refreshed.record.target.revision, observedAt: refreshed.record.target.observedAt, evidenceRef: refreshed.record.target.revision },
          ...(action.postcondition && effectStatus !== "verified"
            ? { error: { code: effectStatus === "mismatch" ? "postcondition-mismatch" : "postcondition-unverified",
                message: "The fresh observation did not verify the requested postcondition.", retry: "refresh-target" as const } } : {}),
        });
        return toolResponse({ result, target: refreshed.record.target, observation: refreshed.observation }, refreshed.image,
          Boolean(action.postcondition && effectStatus !== "verified"));
      } catch (error) {
        return refusal(action, action.targetId, "observation-failed", error instanceof Error ? error.message : "The target refresh failed.", "refresh-target");
      }
    }

    if (record.context.kind === "desktop") {
      const desktopContext = record.context;
      let response: StageClientResult;
      try { response = await timing.measure("actionMs", () => dispatchDesktop(record, action, authToken)); }
      catch (error) {
        const receipt = receiptInput ? settleReceipt(receiptInput, "uncertain") : undefined;
        return reconcileOperation({ action, identity, receipt: receipt ?? { state: "uncertain" }, record, token: authToken,
          timing,
          reason: error instanceof Error ? error.message : "The desktop route outcome is unknown." });
      }
      const capture = stageCapture(response);
      const resultObject = recordOf(response.result);
      const outcome = recordOf(resultObject?.outcome);
      const nativePostcondition = recordOf(resultObject?.postcondition);
      const targetClosed = response.ok && nativePostcondition?.kind === "window-closed" && nativePostcondition.verified === true
        && typeof nativePostcondition.observedAt === "string" && Number.isFinite(Date.parse(nativePostcondition.observedAt))
        && typeof nativePostcondition.evidenceRef === "string";
      // Foreground delivery is itself sufficient proof of focus (real OS
      // SendInput to the actual foreground window), independent of whether
      // the driver can also confirm a separate visual effect -- see the
      // matching comment in cua-stage-driver.ts's click()/clickElement().
      const inputSelectionConfirmed = action.kind === "click"
        ? response.ok && (outcome?.status === "confirmed"
          || (action.confirmFocusForeground === true && outcome?.status !== "suspected-noop"))
        : (action.kind === "text" && action.mode === "insert" || action.kind === "key")
          ? response.ok && record.context.inputSelectionConfirmed
          : false;
      let updated: { record: TargetRecord; observation: Record<string, unknown>; image?: ImageBlock } | undefined;
      if (capture) {
        try {
          updated = await timing.measure("observationMs", () => observeDesktop({ token: authToken, identity, taskId: desktopContext.taskId, mode: desktopContext.mode, view: desktopContext.view,
            representation: desktopContext.representation, logicalKey: record.scopeKey, captureOverride: capture, inputSelectionConfirmed }));
          // The action response already contains this fresh capture; retain that exact observation as evidence.
          const recovery = recordOf(response.recovery);
          if (!response.ok && recovery?.kind !== "capture_refreshed") updated = undefined;
        } catch { /* Action receipt remains authoritative; absence of a post-action observation is reported honestly. */ }
      }
      const receipt = recordOf(resultObject?.operationReceipt);
      const actionExecuted = resultObject?.actionExecuted === true || receipt?.status === "applied" || receipt?.status === "already_applied";
      const dispatchStatus: ComputerUseResult["dispatchStatus"] = response.dispatchState === "not-dispatched"
        ? "not-dispatched"
        : actionExecuted ? "dispatched" : "unknown";
      let operationReceipt: StageOperationClaim | undefined;
      if (receiptInput) {
        if (dispatchStatus === "not-dispatched") {
          try {
            const released = deps.store.releaseComputerOperation(receiptInput);
            if (!released) operationReceipt = deps.store.inspectComputerOperation(receiptInput) ?? { state: "in_progress" };
          } catch { operationReceipt = { state: "in_progress" }; }
        } else {
          operationReceipt = settleReceipt(receiptInput, dispatchStatus === "dispatched" ? "applied" : "uncertain");
        }
      }
      const postconditionStatus = updated && action.postcondition
        ? timing.measureSync("verificationMs", () => verifyPostcondition(updated.record, action.postcondition!))
        : undefined;
      const effectStatus: ComputerUseResult["effectStatus"] = dispatchStatus === "not-dispatched"
        ? "not-checked"
        : targetClosed && !action.postcondition ? "verified"
          : postconditionStatus ?? (dispatchStatus === "dispatched" && updated ? "observed" : "unknown");
      const resultError = !response.ok
        ? { code: response.code ?? "desktop-action-failed", message: (response.error ?? "The desktop broker refused the action.").slice(0, 2_000),
            retry: response.dispatchState === "not-dispatched" ? "never" as const : "same-operation-id" as const }
        : dispatchStatus === "unknown"
          ? { code: "dispatch-outcome-unknown", message: "The desktop broker did not return a conclusive dispatch receipt. Reconcile with the same operation ID before doing anything else.", retry: "same-operation-id" as const }
          : dispatchStatus === "dispatched" && !updated && !targetClosed
            ? { code: "post-action-observation-failed", message: "Input was dispatched, but no fresh desktop observation is available. Reconcile with the same operation ID before another input.", retry: "same-operation-id" as const }
            : action.postcondition && effectStatus !== "verified"
              ? { code: effectStatus === "mismatch" ? "postcondition-mismatch" : "postcondition-unverified",
                  message: "The fresh desktop observation did not verify the requested postcondition.", retry: "refresh-target" as const }
              : undefined;
      const result = createComputerUseResult({
        operationId: action.operationId,
        targetId: action.targetId,
        routeId: selection.routeId,
        dispatchStatus,
        effectStatus,
        ...(operationReceipt && operationReceipt.state !== "claimed" && operationReceipt.state !== "conflict"
          ? { operationReceipt: { status: operationReceipt.state, ...(operationReceipt.updatedAt ? { updatedAt: operationReceipt.updatedAt } : {}) } } : {}),
        ...(updated ? { observation: { revision: updated.record.target.revision, observedAt: updated.record.target.observedAt, evidenceRef: updated.record.target.revision } }
          : targetClosed ? { observation: { revision: nativePostcondition!.evidenceRef as string, observedAt: Date.parse(nativePostcondition!.observedAt as string), evidenceRef: nativePostcondition!.evidenceRef as string } } : {}),
        ...(resultError ? { error: resultError } : {}),
      });
      const image = updated?.image ?? dataUrlImage(capture?.dataUrl);
      if (targetClosed) removeTarget(record.target.targetId);
      const nextStep = response.nextStep ?? (targetClosed ? "The exact window is verified closed; observe a new target before further input." : dispatchStatus === "unknown"
        ? "Reconcile with the same operation ID; do not send a second input."
        : dispatchStatus === "dispatched" && !action.postcondition
          ? updated ? "Inspect the fresh desktop observation before reporting task success; the effect is observed, not verified." : "Reconcile with the same operation ID to obtain a fresh observation."
          : action.postcondition && effectStatus !== "verified" ? "Refresh and inspect the target; do not report success until the postcondition is verified." : undefined);
      return toolResponse({ result, ...(nativePostcondition ? { nativePostcondition } : {}), ...(operationReceipt ? { operationReceipt: { status: operationReceipt.state, ...(operationReceipt.updatedAt ? { updatedAt: operationReceipt.updatedAt } : {}) } } : {}),
        ...(action.kind === "focus" || ("confirmFocusForeground" in action && action.confirmFocusForeground) ? { sharedInput: {
          foregroundMayChange: true,
          physicalPointerMayMove: action.kind === "click" || action.kind === "scroll" || action.kind === "drag",
          pointerIsolationVerified: false,
        } } : {}),
        ...(action.kind === "clipboard" && resultObject?.clipboard ? { clipboard: resultObject.clipboard, sharedClipboard: true } : {}),
        ...(updated ? { target: updated.record.target, observation: updated.observation } : {}), ...(nextStep ? { nextStep } : {}) },
        image, Boolean(resultError));
    }

    if (!deps.web || !browserRequest) {
      if (receiptInput) {
        try { deps.store.releaseComputerOperation(receiptInput); } catch { /* the running receipt still blocks replay */ }
      }
      return refusal(action, action.targetId, "browser-route-unavailable", "The M9R browser broker is unavailable.");
    }
    const browserTab = record.context.kind === "browser" ? record.context.tab : undefined;
    let response: WebResponse;
    try {
      response = await timing.measure("actionMs", () => deps.web!.run(browserRequest!));
    } catch (error) {
      const receipt = receiptInput ? settleReceipt(receiptInput, "uncertain") : { state: "uncertain" as const };
      return reconcileOperation({ action, identity, receipt, record, token: authToken, timing,
        reason: error instanceof Error ? error.message : "The browser route outcome is unknown." });
    }
    if (!response.ok) {
      const receipt = receiptInput ? settleReceipt(receiptInput, "uncertain") : { state: "uncertain" as const };
      return reconcileOperation({ action, identity, receipt, record, token: authToken, timing,
        reason: response.error ?? "The browser broker refused or lost the action." });
    }
    const receipt = receiptInput ? settleReceipt(receiptInput, "applied") : undefined;
    let refreshed: { record: TargetRecord; observation: Record<string, unknown> } | undefined;
    let refreshError: string | undefined;
    try {
      refreshed = await timing.measure("observationMs", () => observeBrowser({ identity, tab: browserTab, logicalKey: record.scopeKey }));
    } catch (error) { refreshError = error instanceof Error ? error.message : "The post-action browser observation failed."; }
    const effectStatus: ComputerUseResult["effectStatus"] = refreshed
      ? action.postcondition
        ? timing.measureSync("verificationMs", () => verifyPostcondition(refreshed.record, action.postcondition!))
        : "observed"
      : "unknown";
    const result = createComputerUseResult({
      operationId: action.operationId,
      targetId: action.targetId,
      routeId: selection.routeId,
      dispatchStatus: "dispatched",
      effectStatus,
      ...(receipt && receipt.state !== "claimed" && receipt.state !== "conflict"
        ? { operationReceipt: { status: receipt.state, ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}) } } : {}),
      ...(refreshed ? { observation: { revision: refreshed.record.target.revision, observedAt: refreshed.record.target.observedAt, evidenceRef: refreshed.record.target.revision } } : {}),
      ...(action.postcondition && effectStatus !== "verified"
        ? { error: { code: effectStatus === "mismatch" ? "postcondition-mismatch" : "postcondition-unverified",
            message: "The fresh browser observation did not verify the requested postcondition.", retry: "refresh-target" as const } }
        : !refreshed ? { error: { code: "post-action-observation-failed", message: (refreshError ?? "No post-action observation was available.").slice(0, 2_000), retry: "same-operation-id" as const } } : {}),
    });
    const nextStep = refreshError
      ? `The action was dispatched; refresh the same target before considering another input. ${refreshError}`
      : action.postcondition && effectStatus !== "verified"
        ? "Inspect or refresh the target; do not report task success until the requested postcondition is verified."
        : !action.postcondition && refreshed
          ? "Inspect the fresh browser observation before reporting task success; the effect is observed, not verified."
          : undefined;
    return toolResponse({ result, ...(receipt ? { operationReceipt: { status: receipt.state, ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}) } } : {}),
      ...(refreshed ? { target: refreshed.record.target, observation: refreshed.observation } : { actionResult: response.data }),
      ...(nextStep ? { nextStep } : {}) },
      undefined, Boolean(action.postcondition && effectStatus !== "verified" || !refreshed));
  }, monotonicNow));
}
