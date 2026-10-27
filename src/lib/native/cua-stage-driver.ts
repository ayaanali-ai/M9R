import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { defaultStoreRoot } from "./local-store";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionResult, ActionTarget, ClickPosition as CuaClickPosition, CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import { DesktopInputNotDispatchedError } from "./desktop-input-errors";
import { startCuaDriverHost, type CuaDriverHostConnection } from "./cua-driver-host";
import { createWindowsDesktopStageManager, type WindowsStageDependencies, type NativePointControl } from "./windows-desktop-stage";
import type { VerifiedIdentity } from "./identity-core";
import { createForegroundInputLease, type ForegroundInputLease } from "./foreground-input-lease";

const CUA_PACKAGE = "@trycua/cua-driver";
const CUA_DRIVER_VERSION = "0.34.0";
const PUBLIC_CURSOR_LABEL_MAX_LENGTH = 28;
const MAX_IMAGE_DIMENSION = 1024;
// Keep the base64 JSON response comfortably below the native pill's 4 MiB stdout cap.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_ACTION_LENGTH = 500;
const DEFAULT_TYPE_DELAY_MS = 30;
const MAX_TYPE_DELAY_MS = 200;
const MAX_WINDOW_OPTIONS = 40;
const MAX_DESKTOP_STRUCTURE_WINDOWS = 12;
const MAX_DESKTOP_STRUCTURE_ELEMENTS = 256;
const SESSION_PREFIX = "m9r-stage-";

type WindowTargetFactory = {
  Window: new (input: { pid: number; windowId: bigint }) => ActionTarget;
};

type CuaSdk = {
  CuaDriver: {
    connect(socketPath: string | undefined): CuaDriverLike;
    create(options?: undefined): CuaDriverLike;
  };
  ActionTarget: WindowTargetFactory;
  ClickPosition: { Coordinates: new (input: { x: number; y: number }) => CuaClickPosition;
    CapturedCoordinates: new (input: { x: number; y: number; captureId: string }) => CuaClickPosition;
    Element?: new (input: { elementToken: string }) => CuaClickPosition };
  InputDeliveryMode: { Background: number; Foreground: number };
  CaptureScope: { Desktop: number };
  ClickButton: { Left: number; Right: number; Middle: number };
  ScrollDirection: { Up: number; Down: number };
  ScrollBy: { Line: number };
  VisualRegionKind: { Text: number; Icon: number };
  CursorReducedMotion: { Auto: number };
  /** Optional presentation features; their absence must never block stage boot. */
  CursorMotionStyle?: typeof import("@trycua/cua-driver").CursorMotionStyle;
  CursorMotionTiming?: typeof import("@trycua/cua-driver").CursorMotionTiming;
};

type RuntimeModuleRecord = Record<string, unknown>;

function runtimeModuleRecord(value: unknown): RuntimeModuleRecord | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? value as RuntimeModuleRecord
    : undefined;
}

/**
 * Dynamic imports are not guaranteed to have the same namespace shape in a
 * tsx test process, a Node package install, and the bundled Windows runtime.
 * Flatten only the module namespaces that can contain the Cua exports; this
 * keeps the adapter provider-neutral while avoiding a blind `as CuaSdk` cast.
 */
function collectRuntimeExports(value: unknown, output: RuntimeModuleRecord, seen: Set<unknown>, depth = 0): void {
  const record = runtimeModuleRecord(value);
  if (!record || seen.has(record) || depth > 3) return;
  seen.add(record);
  for (const [key, child] of Object.entries(record)) {
    if (key !== "default" && output[key] === undefined) output[key] = child;
  }
  for (const key of ["default", "cua_driver_contract", "cua_driver_sdk"]) {
    collectRuntimeExports(record[key], output, seen, depth + 1);
  }
}

function hasFunction(record: RuntimeModuleRecord | undefined, key: string): boolean {
  return typeof record?.[key] === "function";
}

function hasNumericMembers(record: RuntimeModuleRecord | undefined, keys: readonly string[]): boolean {
  return Boolean(record) && keys.every((key) => typeof record?.[key] === "number" && Number.isFinite(record[key]));
}

/**
 * Validate and normalize the Cua Driver runtime boundary before a native
 * session is created. TypeScript casts cannot validate a dynamic import at
 * runtime; without this check an absent motion enum throws later in
 * ensureAgentSession(), before the agent can observe or focus anything.
 */
export function normalizeCuaSdk(moduleValue: unknown, source = CUA_PACKAGE): CuaSdk {
  const exports: RuntimeModuleRecord = {};
  collectRuntimeExports(moduleValue, exports, new Set());
  const cuaDriver = runtimeModuleRecord(exports.CuaDriver);
  const actionTarget = runtimeModuleRecord(exports.ActionTarget);
  const clickPosition = runtimeModuleRecord(exports.ClickPosition);
  const missing: string[] = [];
  if (!hasFunction(cuaDriver, "create")) missing.push("CuaDriver.create");
  if (!hasFunction(cuaDriver, "connect")) missing.push("CuaDriver.connect");
  if (!hasFunction(actionTarget, "Window")) missing.push("ActionTarget.Window");
  if (!hasFunction(clickPosition, "Coordinates")) missing.push("ClickPosition.Coordinates");
  if (!hasFunction(clickPosition, "CapturedCoordinates")) missing.push("ClickPosition.CapturedCoordinates");
  if (!hasNumericMembers(runtimeModuleRecord(exports.InputDeliveryMode), ["Background", "Foreground"])) missing.push("InputDeliveryMode");
  if (!hasNumericMembers(runtimeModuleRecord(exports.CaptureScope), ["Desktop"])) missing.push("CaptureScope.Desktop");
  if (!hasNumericMembers(runtimeModuleRecord(exports.ClickButton), ["Left", "Right", "Middle"])) missing.push("ClickButton");
  if (!hasNumericMembers(runtimeModuleRecord(exports.ScrollDirection), ["Up", "Down"])) missing.push("ScrollDirection");
  if (!hasNumericMembers(runtimeModuleRecord(exports.ScrollBy), ["Line"])) missing.push("ScrollBy.Line");
  if (!hasNumericMembers(runtimeModuleRecord(exports.VisualRegionKind), ["Text", "Icon"])) missing.push("VisualRegionKind");
  if (!hasNumericMembers(runtimeModuleRecord(exports.CursorReducedMotion), ["Auto"])) missing.push("CursorReducedMotion.Auto");
  // Cursor motion is presentation-only. Older/newer Cua runtimes may omit
  // these enums; ensureAgentSession feature-detects them and keeps the
  // logical cursor and native stage usable without the animation preference.
  if (missing.length) {
    throw new Error(`Cua Driver ${CUA_DRIVER_VERSION} loaded from ${source} has an incompatible runtime contract; missing or invalid ${missing.join(", ")}. Reinstall the matching M9R Cua Driver runtime.`);
  }
  return exports as unknown as CuaSdk;
}

export type CuaAgentCursorIdentity = Pick<VerifiedIdentity, "handle" | "sessionId">;

interface AgentCursorSession {
  key: string;
  handle: string;
  sessionId: string;
  session: string;
  sessionTag: string;
}

interface CuaRuntime {
  sdk: CuaSdk;
  driver: CuaDriverLike;
  processId?: number;
  close?: () => Promise<void>;
}

export type CuaStageRuntimeConnector = (sdk: CuaSdk) => Promise<CuaDriverHostConnection>;

interface DriverActionParts {
  effect?: unknown;
  route?: unknown;
  summary?: unknown;
  error?: { code?: unknown; hint?: unknown };
}

export interface CuaStageWindowOption {
  pid: number;
  windowId: string;
  appName: string;
  title: string;
  width: number;
  height: number;
}

export interface CuaStageActionOutcome {
  status: "confirmed" | "partial" | "unverifiable" | "suspected-noop" | "unverified";
  route?: number;
  summary?: string;
  /** The target window was explicitly brought to the OS foreground before delivery. */
  foregroundConfirmed?: true;
}

export interface CuaStageActionProof {
  capture: CuaStageCapture;
  outcome: CuaStageActionOutcome;
}

export interface CuaStageWindowClosedProof {
  postcondition: { kind: "window-closed"; verified: true; observedAt: string; evidenceRef: string };
  outcome: CuaStageActionOutcome;
}

export interface CuaStageCapture {
  ownedPopups?: Array<{ dataUrl: string; width: number; height: number; capturedAt: string; coordinateSpace: "popup-local" }>;
  popupCaptureStatus?: "complete" | "unavailable";
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
  /** Cua's opaque ID for this exact desktop screenshot; used to bind visual coordinates. */
  captureId?: string;
  /** Bounded accessible targets from this same window snapshot, in screenshot pixels. */
  controls?: CuaStageTargetDescription[];
  /** True when `controls` was cut off at its element cap; the window has more controls than were returned. */
  controlsTruncated?: true;
}

/**
 * Structure-first observation returned by the exact-window Cua route.
 * Element refs are driver-owned opaque tokens; the provider-neutral computer
 * use layer remaps them before exposing an observation to an agent.
 */
export interface CuaStageStructure {
  status: "complete" | "partial" | "unavailable";
  capturedAt: string;
  appName?: string;
  windowTitle?: string;
  elements: Array<{
    ref: string;
    parentRef?: string;
    depth?: number;
    role?: string;
    label?: string;
    enabled?: boolean;
    selected?: boolean;
    actions?: string[];
    canReplaceValue?: boolean;
  }>;
  /** Same-call visual fallback when the accessibility tree is incomplete. */
  fallbackCapture?: CuaStageCapture;
}

/**
 * Provider-neutral composite observation of the owner's visible desktop.
 * Cua's native `getDesktopState` is intentionally pixel-only; this composite
 * pairs that exact capture with bounded accessibility reads for the visible
 * application windows. Window handles, PIDs, and driver element tokens never
 * leave the native stage boundary.
 */
export interface CuaDesktopStructureElement {
  ref: string;
  windowRef: string;
  rect?: { x: number; y: number; width: number; height: number };
  parentRef?: string;
  depth?: number;
  role?: string;
  label?: string;
  enabled?: boolean;
  selected?: boolean;
  actions?: string[];
  canReplaceValue?: boolean;
}

export interface CuaDesktopStructureWindow {
  ref: string;
  appName: string;
  title: string;
  rect: { x: number; y: number; width: number; height: number };
  frontmost?: boolean;
  minimized?: boolean;
  onCurrentSpace?: boolean;
  status: "complete" | "partial" | "unavailable";
  elements: CuaDesktopStructureElement[];
}

export interface CuaDesktopStructure {
  scope: "desktop";
  status: "complete" | "partial" | "unavailable";
  capturedAt: string;
  windows: CuaDesktopStructureWindow[];
  elements: CuaDesktopStructureElement[];
  /** The shell is represented by the same capture plus the native UIA tree when available. */
  shell: {
    status: "complete" | "partial" | "unavailable" | "visual-fallback";
    reason: string;
    elements?: CuaDesktopStructureElement[];
    truncated?: true;
  };
  /** The exact desktop pixels used for coordinate fallback and taskbar/Start recovery. */
  fallbackCapture: CuaStageCapture;
}

/** Private handle to one immutable desktop image; only the broker uses this to bind a click to its capture. */
export interface CuaDesktopTargetSnapshot extends CuaStageTargetDescription {
  captureId: string;
  width: number;
  height: number;
}

export interface CuaStageCursorProof {
  /** Requested point in the registered app's screenshot coordinates. */
  x: number;
  y: number;
  /** Confirmed position of the synthetic cursor in desktop screen coordinates. */
  screenX: number;
  screenY: number;
  enabled: true;
  visible: true;
}

interface CuaStageWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CuaStageWindowFrame {
  dataUrl: string;
  width: number;
  height: number;
  windowBounds?: CuaStageWindowBounds;
  controls?: CuaStageTargetDescription[];
}

export interface CuaStageTargetDescription {
  /** Accessible label of the smallest enabled control at the point, if the snapshot provided one. */
  label?: string;
  role?: string;
  /** Screenshot-pixel frame of the resolved control, when the snapshot provided one. */
  rect?: { x: number; y: number; width: number; height: number };
}

export type CuaStageInputOptions = {
  confirmFocusForeground?: boolean;
  expectedRole?: string;
  expectedLabel?: string;
  signal?: AbortSignal;
  /** Internal stage policy; background stages may never escalate to the owner's foreground. */
  deliveryMode?: "background" | "owner-preview";
};
export type CuaDesktopClickOptions = CuaStageInputOptions & { button?: "left" | "middle" | "right"; count?: 1 | 2 };
export type CuaStageTextOptions = CuaStageInputOptions & { mode?: "insert" | "replace"; x?: number; y?: number; expectedRole?: string; expectedLabel?: string; delayMs?: number };
export type CuaStageScrollOptions = CuaStageInputOptions;
export type CuaStageDragOptions = CuaStageInputOptions & { durationMs?: number };

export interface CuaStageDriverDependencies {
  stage?: WindowsStageDependencies;
  loadSdk?: () => Promise<CuaSdk>;
  connectRuntime?: CuaStageRuntimeConnector;
  now?: () => Date;
  windowAtPoint?: (x: number, y: number) => Promise<{ pid: number; windowId: bigint; shell?: boolean; keyboardWindow?: boolean; screenOrigin?: { x: number; y: number } }>;
  pointControl?: (x: number, y: number, expected?: NativePointControl) => Promise<NativePointControl>;
  /** Test seam: replaces the real native owner-pointer get/restore (production always uses the Windows stage manager's). */
  ownerPointer?: { get(): Promise<{ x: number; y: number }>; restore(x: number, y: number): Promise<void> };
  /** Optional privacy-safe phase timings for diagnosing live stage latency. */
  onTiming?: (event: CuaStageTimingEvent) => void;
  /** Broker-wide serialization for the one real Windows foreground input stream. */
  foregroundLease?: ForegroundInputLease;
}

export interface CuaStageTimingEvent {
  phase: "sdk-load" | "host-connect" | "runtime-acquire" | "session-start" | "cursor-motion";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  stageName?: string;
  cached?: boolean;
}

interface CachedDesktopCapture extends CuaDesktopTargetSnapshot {
  dataUrl: string;
  capturedAtMs: number;
  capturedAt: string;
  stageName: string;
  identityKey: string;
}

interface DesktopInputTarget {
  pid: number;
  windowId: bigint;
  /** An exact accessibility field does not depend on system keyboard focus. */
  field?: { x: number; y: number; label?: string; role?: string };
}

type CuaWindowInfo = Awaited<ReturnType<CuaDriverLike["listWindows"]>>["windows"][number];
type CuaWindowElement = NonNullable<Awaited<ReturnType<CuaDriverLike["getWindowState"]>>["elements"]>[number];

function elementAtScreenPoint(elements: readonly CuaWindowElement[], x: number, y: number,
  supports?: (element: CuaWindowElement) => boolean) {
  const hit = elements.filter((element) => {
    const frame = element.frame;
    return element.enabled !== false && element.elementToken && frame && frame.w > 0 && frame.h > 0
      && x >= frame.x && y >= frame.y && x < frame.x + frame.w && y < frame.y + frame.h;
  }).sort((a, b) => a.frame!.w * a.frame!.h - b.frame!.w * b.frame!.h)[0];
  if (!supports) return hit;
  // Follow real UIA ancestry, never a merely overlapping sibling. Bound cycles
  // and refuse disabled ancestors instead of turning hit testing into guessing.
  const parents = new Map(elements.map((element) => [element.elementIndex, element]));
  const visited = new Set<CuaWindowElement>();
  let current: CuaWindowElement | undefined = hit;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current.enabled === false) return undefined;
    if (current.elementToken && supports(current)) return current;
    current = current.parentIndex === undefined ? undefined : parents.get(current.parentIndex);
  }
  return undefined;
}

async function typeIntoExactField(driver: CuaDriverLike, selected: DesktopInputTarget, session: string, text: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!selected.field || !Number.isSafeInteger(Number(selected.windowId))) throw new Error("The selected text field has no representable exact window identity.");
  const state = await driver.getWindowState({ pid: selected.pid, windowId: selected.windowId, session,
    includeAccessibilityTree: true, includeScreenshot: false, maxElements: 512, maxDepth: 24, timeoutMs: 1_500 }, signal ? { signal } : undefined);
  if (state.pid !== selected.pid || state.windowId !== selected.windowId) throw new Error("The selected text field returned a different application window.");
  const element = elementAtScreenPoint(state.elements ?? [], selected.field.x, selected.field.y,
    (candidate) => candidate.actions?.includes("set_value") === true);
  const normalizeLabel = (value: string | undefined) => value?.replace(/[\r\n\t]+/g, " ").trim().toLocaleLowerCase();
  const expectedLabel = normalizeLabel(selected.field.label);
  const currentLabel = normalizeLabel(element?.label);
  // Editable controls often expose a value-derived accessible name (for
  // example "Search (before)") after the click. Keep the exact point/window,
  // role, and ValuePattern checks, but do not treat a harmless label extension
  // as a different control. A wholly unrelated label still fails closed.
  const labelsCompatible = expectedLabel === undefined || currentLabel === undefined
    || expectedLabel === currentLabel || expectedLabel.includes(currentLabel) || currentLabel.includes(expectedLabel);
  const roleCompatible = selected.field.role === undefined || element?.role === selected.field.role;
  if (!element?.elementToken || !labelsCompatible || !roleCompatible || !element.actions?.includes("set_value")) {
    throw new DesktopInputNotDispatchedError("The selected text field changed; no text was sent.");
  }
  // UIA ValuePattern has no caret/selection range in this driver contract.
  // Background insertion therefore appends to the freshly read value; never
  // replace existing content or invent an empty value when it is unavailable.
  if (typeof element.value !== "string") throw new DesktopInputNotDispatchedError("The selected field's current value is unavailable; no insertion was sent.");
  return actionOutcome(await driver.callTool("set_value", JSON.stringify({
    pid: selected.pid, window_id: Number(selected.windowId), element_token: element.elementToken,
    value: element.value + text, session,
  }), signal ? { signal } : undefined), "Cua Driver could not type into the exact accessibility field.");
}

function normalizeTypeDelayMs(value: number | undefined): number {
  const delay = value ?? DEFAULT_TYPE_DELAY_MS;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_TYPE_DELAY_MS) {
    throw new Error(`Text delay must be a whole number from 0 to ${MAX_TYPE_DELAY_MS} milliseconds.`);
  }
  return delay;
}

interface DesktopScreenSize {
  width: number;
  height: number;
}

interface ResolvedDesktopPoint {
  desktopPoint: { x: number; y: number };
  screenPoint: { x: number; y: number };
  target: DesktopInputTarget;
  localPoint: { x: number; y: number };
  shellControl?: NativePointControl;
  nativeKeyboardWindow?: boolean;
  element?: CuaWindowElement;
}

function bundledSdkUrl(): string | null {
  const packageRoot = join(dirname(process.execPath), "cua-driver-runtime", "node_modules", "@trycua", "cua-driver");
  const manifestPath = join(packageRoot, "package.json");
  const entryPath = join(packageRoot, "dist", "index.js");
  if (!existsSync(manifestPath) || !existsSync(entryPath)) return null;
  let version: unknown;
  try { version = JSON.parse(readFileSync(manifestPath, "utf8")).version; }
  catch { throw new Error("The bundled Cua Driver package metadata is unreadable. Reinstall the M9R Windows runtime."); }
  if (version !== CUA_DRIVER_VERSION) {
    throw new Error(`The bundled Cua Driver is ${String(version)}; M9R requires ${CUA_DRIVER_VERSION}. Reinstall the M9R Windows runtime with its matching Cua Driver files.`);
  }
  return pathToFileURL(entryPath).href;
}

async function loadCuaSdk(): Promise<CuaSdk> {
  let packageError: unknown;
  try {
    return normalizeCuaSdk(await import(CUA_PACKAGE), CUA_PACKAGE);
  } catch (error) {
    packageError = error;
  }
  const url = bundledSdkUrl();
  let bundledError: unknown;
  if (url) {
    try { return normalizeCuaSdk(await import(url), url); }
    catch (error) { bundledError = error; }
  }
  const reason = packageError instanceof Error ? packageError.message : "module could not be loaded";
  const bundledReason = bundledError instanceof Error ? ` Bundled runtime check: ${bundledError.message}` : "";
  throw new Error(`Cua Driver ${CUA_DRIVER_VERSION} is unavailable in this M9R runtime (${reason}).${bundledReason} Reinstall the M9R Windows runtime with its Cua Driver files.`);
}

function safeSessionName(stageName: string): string {
  return `${SESSION_PREFIX}${stageName}`.slice(0, 64);
}

/**
 * Cua renders the named session below the native cursor.  That is a user-facing
 * label, not an identity/debug channel: provider session IDs and derived
 * ownership tags stay in the broker's private registry only.
 */
function publicCursorLabel(handle: string): string {
  const normalized = handle.trim().toLowerCase();
  const known: Record<string, string> = {
    claude: "Claude",
    "claude-code": "Claude",
    codex: "Codex",
    opencode: "OpenCode",
    "open-code": "OpenCode",
  };
  const label = known[normalized] ?? normalized
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
  return (label || "Agent").slice(0, PUBLIC_CURSOR_LABEL_MAX_LENGTH).trim() || "Agent";
}

function agentCursorDetails(identity: CuaAgentCursorIdentity): AgentCursorSession {
  const handle = identity.handle.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(handle) || typeof identity.sessionId !== "string"
    || identity.sessionId.length < 1 || identity.sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(identity.sessionId)) {
    throw new Error("The verified agent identity cannot be used for a Cua cursor session.");
  }
  const digest = createHash("sha256").update(`${handle}\0${identity.sessionId}`).digest("hex");
  const sessionTag = digest.slice(0, 8);
  return {
    key: `${handle}\0${identity.sessionId}`,
    handle,
    sessionId: identity.sessionId,
    // Keep the session-specific tag private. Cua displays `session` in the
    // cursor badge, so it must remain a clean provider label with no session
    // ID, hash, token, or @-prefixed internal handle.
    session: publicCursorLabel(handle),
    sessionTag,
  };
}

function parseWindowId(value: string): bigint {
  try {
    const result = BigInt(value);
    if (result <= BigInt(0) || result > BigInt("18446744073709551615")) throw new Error("out of range");
    return result;
  } catch {
    throw new Error("The registered stage window handle is invalid for Cua Driver.");
  }
}

function checkImage(mimeType: unknown, dataBase64: unknown): { mimeType: "image/png" | "image/jpeg"; dataBase64: string; bytes: number } {
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error("Cua Driver returned an unsupported stage image format.");
  if (typeof dataBase64 !== "string" || dataBase64.length === 0 || dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
    throw new Error("Cua Driver returned an invalid or oversized stage image.");
  }
  const bytes = Buffer.from(dataBase64, "base64").byteLength;
  if (bytes < 1 || bytes > MAX_IMAGE_BYTES) throw new Error("Cua Driver returned an invalid or oversized stage image.");
  return { mimeType, dataBase64, bytes };
}

function imageFromWindowState(state: Awaited<ReturnType<CuaDriverLike["getWindowState"]>>, pid: number, windowId: bigint) {
  if (state.pid !== pid || state.windowId !== windowId) throw new Error("Cua Driver returned a snapshot for a different window.");
  if (state.screenshotFrameValid === false || !Number.isInteger(state.screenshotWidth) || !Number.isInteger(state.screenshotHeight)
    || (state.screenshotWidth ?? 0) < 1 || (state.screenshotHeight ?? 0) < 1
    || (state.screenshotWidth ?? 0) > 16_384 || (state.screenshotHeight ?? 0) > 16_384) {
    throw new Error(`Cua Driver could not verify a valid stage window snapshot (valid=${String(state.screenshotFrameValid)}, width=${String(state.screenshotWidth)}, height=${String(state.screenshotHeight)}, images=${state.images?.length ?? 0}).`);
  }
  const image = state.images[0];
  if (!image) throw new Error("Cua Driver did not return an image for this stage window.");
  const safe = checkImage(image.mimeType, image.dataBase64);
  // Driver 0.33.2 leaves this optional flag unset on Windows even for valid
  // captures. In that case require a PNG header whose dimensions agree with
  // the exact-window metadata; an explicitly invalid frame is always rejected.
  if (state.screenshotFrameValid === undefined) {
    const bytes = Buffer.from(safe.dataBase64, "base64");
    if (safe.mimeType !== "image/png" || bytes.length < 33
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.toString("ascii", 12, 16) !== "IHDR"
      || bytes.readUInt32BE(16) !== state.screenshotWidth || bytes.readUInt32BE(20) !== state.screenshotHeight) {
      throw new Error("Cua Driver returned an unverified frame without matching PNG dimensions.");
    }
  }
  return {
    dataUrl: `data:${safe.mimeType};base64,${safe.dataBase64}`,
    width: state.screenshotWidth!,
    height: state.screenshotHeight!,
  };
}

function actionParts(result: ActionResult | ToolResult): DriverActionParts {
  const wrapped = result as ToolResult;
  const direct = result as ActionResult;
  return (wrapped.action ?? direct) as DriverActionParts;
}

function resultError(result: { isError: boolean; text?: string }, fallback: string): void {
  if (!result.isError) return;
  const detail = typeof result.text === "string" ? result.text.replace(/[\r\n\t]+/g, " ").slice(0, 240).trim() : "";
  throw new Error(detail || fallback);
}

function actionError(result: ActionResult | ToolResult, fallback: string): string | null {
  const wrapped = result as ToolResult;
  if (wrapped.isError === true) {
    const detail = typeof wrapped.text === "string" ? wrapped.text.replace(/[\r\n\t]+/g, " ").slice(0, 240).trim() : "";
    return detail || fallback;
  }
  const parts = actionParts(result);
  if (parts.effect === 4 || parts.effect === "refused") {
    const code = typeof parts.error?.code === "string" ? parts.error.code : "action_refused";
    const hint = typeof parts.error?.hint === "string" ? parts.error.hint : fallback;
    return `${code}: ${hint}`.slice(0, 300);
  }
  return null;
}

function actionOutcome(result: ActionResult | ToolResult, fallback: string): CuaStageActionOutcome {
  const error = actionError(result, fallback);
  if (error) throw new Error(error);
  const parts = actionParts(result);
  const status = parts.effect === 0 || parts.effect === "confirmed" ? "confirmed"
    : parts.effect === 1 || parts.effect === "partial" ? "partial"
      : parts.effect === 2 || parts.effect === "unverifiable" ? "unverifiable"
        : parts.effect === 3 || parts.effect === "suspected_noop" ? "suspected-noop" : "unverified";
  return {
    status,
    ...(typeof parts.route === "number" ? { route: parts.route } : {}),
    ...(typeof parts.summary === "string" ? { summary: parts.summary.replace(/[\r\n\t]+/g, " ").slice(0, 180).trim() } : {}),
  };
}

function validPoint(x: number, y: number, capture: { width: number; height: number }): boolean {
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < capture.width && y < capture.height;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseStructuredJson(result: ToolResult, fallback: string): unknown {
  resultError(result, fallback);
  const encoded = result.structuredJson ?? result.rawJson;
  if (!encoded) throw new Error(fallback);
  try { return JSON.parse(encoded) as unknown; }
  catch { throw new Error("Cua Driver returned malformed structured data while preparing safe background input."); }
}

function screenSizeFromResult(result: ToolResult): DesktopScreenSize {
  const parsed = parseStructuredJson(result, "Cua Driver did not return screen coordinate dimensions; no input was sent.");
  const pending: unknown[] = [parsed];
  let visited = 0;
  while (pending.length > 0 && visited < 64) {
    const current = pending.shift();
    visited += 1;
    const record = jsonRecord(current);
    if (!record) continue;
    for (const [widthKey, heightKey] of [["width", "height"], ["screenWidth", "screenHeight"], ["screen_width", "screen_height"]]) {
      const width = record[widthKey!], height = record[heightKey!];
      if (Number.isSafeInteger(width) && Number.isSafeInteger(height)
        && (width as number) > 0 && (height as number) > 0
        && (width as number) <= 65_536 && (height as number) <= 65_536) return { width: width as number, height: height as number };
    }
    for (const child of Object.values(record)) if (child && typeof child === "object") pending.push(child);
  }
  throw new Error("Cua Driver returned no valid screen coordinate dimensions; no input was sent.");
}

/**
 * Convert a native screen-space rectangle into the pixel space of the one
 * desktop capture that will be handed to the provider. The Cua desktop image
 * can be scaled relative to the Windows coordinate space, so raw UIA frames
 * must never be exposed as if they were already screenshot coordinates.
 */
function desktopRectInCapture(
  rect: { x: number; y: number; width: number; height: number },
  screen: DesktopScreenSize,
  capture: Pick<CuaStageCapture, "width" | "height">,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number; width: number; height: number } | undefined {
  if (![rect.x, rect.y, rect.width, rect.height, screen.width, screen.height, origin.x, origin.y,
    capture.width, capture.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || screen.width <= 0 || screen.height <= 0
    || capture.width <= 0 || capture.height <= 0) return undefined;
  const left = Math.max(0, Math.min(capture.width, (rect.x - origin.x) * capture.width / screen.width));
  const top = Math.max(0, Math.min(capture.height, (rect.y - origin.y) * capture.height / screen.height));
  const right = Math.max(0, Math.min(capture.width, (rect.x + rect.width - origin.x) * capture.width / screen.width));
  const bottom = Math.max(0, Math.min(capture.height, (rect.y + rect.height - origin.y) * capture.height / screen.height));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function windowCoversPoint(window: CuaWindowInfo, x: number, y: number): boolean {
  const bounds = window.bounds;
  return window.isOnScreen === true && window.onCurrentSpace !== false && window.minimized !== true
    && Number.isSafeInteger(window.pid) && (window.pid ?? 0) > 0
    && typeof window.windowId === "bigint" && window.windowId > BigInt(0)
    && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width >= 1 && bounds.height >= 1
    && x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height
    && !/m9r(?:[- ]overlay)?|agent cursor overlay|cua cursor overlay/i.test(`${window.appName} ${window.title}`);
}

/** Resolve a screen point to one exact, topmost HWND. Ambiguous stacking order fails closed. */
export function topmostWindowAtScreenPoint(windows: readonly CuaWindowInfo[], x: number, y: number): CuaWindowInfo {
  const hits = windows.filter((window) => windowCoversPoint(window, x, y));
  if (hits.length === 0) throw new Error("No visible application window is under that desktop point; no input was sent.");
  if (hits.length === 1) return hits[0]!;
  if (hits.some((window) => typeof window.zIndex !== "bigint")) {
    throw new Error("Cua Driver did not provide window stacking order for this desktop point; no input was sent.");
  }
  const ordered = hits.slice().sort((a, b) => a.zIndex! > b.zIndex! ? -1 : a.zIndex! < b.zIndex! ? 1 : 0);
  if (ordered[0]!.zIndex === ordered[1]!.zIndex) {
    throw new Error("Cua Driver returned overlapping windows with ambiguous stacking order; no input was sent.");
  }
  return ordered[0]!;
}

function desktopPointOnScreen(x: number, y: number, capture: { width: number; height: number }, screen: DesktopScreenSize): { x: number; y: number } {
  if (!validPoint(x, y, capture)) throw new Error("Desktop coordinates must fall inside the latest capture.");
  return {
    x: Math.floor((x + 0.5) * screen.width / capture.width),
    y: Math.floor((y + 0.5) * screen.height / capture.height),
  };
}

function desktopPointInWindow(screenPoint: { x: number; y: number }, frame: CuaStageWindowFrame) {
  const bounds = frame.windowBounds;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0
    || screenPoint.x < bounds.x || screenPoint.y < bounds.y
    || screenPoint.x >= bounds.x + bounds.width || screenPoint.y >= bounds.y + bounds.height) {
    throw new Error("The selected desktop point is outside the exact window snapshot; no input was sent.");
  }
  const localX = Math.floor((screenPoint.x - bounds.x + 0.5) * frame.width / bounds.width);
  const localY = Math.floor((screenPoint.y - bounds.y + 0.5) * frame.height / bounds.height);
  if (!validPoint(localX, localY, frame)) throw new Error("The desktop point could not be mapped into the exact window snapshot; no input was sent.");
  return { x: localX, y: localY };
}

function stageCapture(capture: { dataUrl: string; width: number; height: number; controls?: CuaStageTargetDescription[]; capturedAt?: string;
  controlsTruncated?: true; ownedPopups?: CuaStageCapture["ownedPopups"]; popupCaptureStatus?: CuaStageCapture["popupCaptureStatus"] }, now: () => Date): CuaStageCapture {
  return { dataUrl: capture.dataUrl, width: capture.width, height: capture.height,
    ...(capture.controls ? { controls: capture.controls } : {}),
    ...(capture.controlsTruncated ? { controlsTruncated: capture.controlsTruncated } : {}),
    ...(capture.ownedPopups ? { ownedPopups: capture.ownedPopups } : {}),
    ...(capture.popupCaptureStatus ? { popupCaptureStatus: capture.popupCaptureStatus } : {}),
    capturedAt: "capturedAt" in capture && typeof capture.capturedAt === "string" ? capture.capturedAt : now().toISOString() };
}

function cursorScreenPoint(x: number, y: number, frame: CuaStageWindowFrame): { x: number; y: number } {
  const bounds = frame.windowBounds;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    throw new Error("Cua Driver did not provide valid screen bounds for this stage window.");
  }
  // Stage coordinates are pixels in the scaled window screenshot. Cua's
  // synthetic cursor API accepts desktop screen points, so map through the
  // exact window bounds instead of placing the cursor at the same raw numbers.
  return {
    x: bounds.x + x * bounds.width / frame.width,
    y: bounds.y + y * bounds.height / frame.height,
  };
}

function cursorStateFromResult(result: { isError: boolean; structuredJson?: string; rawJson?: string }): { enabled: boolean; x?: number; y?: number } {
  resultError(result, "Cua Driver could not read the stage cursor state.");
  const encoded = result.structuredJson ?? result.rawJson;
  if (!encoded) throw new Error("Cua Driver returned no stage cursor state.");
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); } catch { throw new Error("Cua Driver returned malformed stage cursor state."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Cua Driver returned malformed stage cursor state.");
  const value = parsed as { enabled?: unknown; position?: { x?: unknown; y?: unknown } | null };
  const x = value.position?.x;
  const y = value.position?.y;
  return {
    enabled: value.enabled === true,
    ...(typeof x === "number" && Number.isFinite(x) ? { x } : {}),
    ...(typeof y === "number" && Number.isFinite(y) ? { y } : {}),
  };
}

function findDesktopCaptureId(value: unknown): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 256) {
    const current = pending.shift()!;
    visited += 1;
    if (!current.value || typeof current.value !== "object" || Array.isArray(current.value) || current.depth > 5) continue;
    const record = current.value as Record<string, unknown>;
    for (const key of ["captureId", "capture_id"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256
        && !/[\u0000-\u001f\u007f]/.test(candidate)) return candidate;
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function desktopTargetAt(result: ToolResult, x: number, y: number): CuaStageTargetDescription | undefined {
  resultError(result, "Cua Driver could not identify the desktop control under the cursor.");
  const encoded = result.structuredJson ?? result.rawJson;
  if (!encoded) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); } catch { throw new Error("Cua Driver returned malformed desktop region data."); }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const regions = Array.isArray(record?.regions) ? record.regions : [];
  const hits = regions.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const region = item as Record<string, unknown>;
    const bounds = region.bounds && typeof region.bounds === "object" ? region.bounds as Record<string, unknown> : undefined;
    const rx = bounds?.x, ry = bounds?.y, width = bounds?.width, height = bounds?.height;
    if (![rx, ry, width, height].every((value) => typeof value === "number" && Number.isFinite(value))
      || (rx as number) > x || (ry as number) > y || (rx as number) + (width as number) <= x || (ry as number) + (height as number) <= y) return [];
    const label = typeof region.label === "string" && region.label.trim() ? region.label.trim()
      : typeof region.text === "string" && region.text.trim() ? region.text.trim() : undefined;
    if (!label) return [];
    return [{ label, area: (width as number) * (height as number), rect: { x: rx as number, y: ry as number, width: width as number, height: height as number } }];
  }).sort((left, right) => left.area - right.area);
  const hit = hits[0];
  return hit ? { label: hit.label.replace(/[\r\n\t]+/g, " ").slice(0, 160), rect: hit.rect } : undefined;
}

/**
 * Cua Driver window-only local desktop-stage adapter. Every action is addressed to the exact registered
 * PID/HWND pair; frames and window labels remain local to the native pill.
 */
export function createCuaStageDriver(deps: CuaStageDriverDependencies = {}) {
  const manager = createWindowsDesktopStageManager(deps.stage);
  const loadSdk = deps.loadSdk ?? loadCuaSdk;
  const now = deps.now ?? (() => new Date());
  const root = deps.stage?.root ?? defaultStoreRoot(homedir(), deps.stage?.env ?? process.env);
  // Provider workers are separate processes, but Windows still exposes one
  // foreground input stream. Share the lease through the M9R store so Paint,
  // Calculator, or any other target cannot be focused by two workers at once.
  const foregroundLease = deps.foregroundLease ?? createForegroundInputLease({ lockPath: join(root, "foreground-input-lease") });
  const agentSessions = new Map<string, AgentCursorSession>();
  const cursorStartSlots = new Map<string, number>();
  // Cursor presentation can be requested concurrently by several provider
  // deliveries. Keep slot reservation and the initial overlay move atomic so
  // two providers cannot observe the same free slot and overlap at startup.
  let cursorSlotQueue: Promise<void> = Promise.resolve();
  const desktopCaptures = new Map<string, CachedDesktopCapture>();
  const desktopInputTargets = new Map<string, DesktopInputTarget>();
  let agentRuntimePromise: Promise<CuaRuntime> | undefined;

  function emitTiming(event: CuaStageTimingEvent): void {
    try { deps.onTiming?.(event); } catch { /* diagnostics must never affect desktop control */ }
  }

  async function timed<T>(phase: CuaStageTimingEvent["phase"], action: () => Promise<T>, details: Omit<CuaStageTimingEvent, "phase" | "startedAt" | "endedAt" | "durationMs" | "status"> = {}): Promise<T> {
    const started = performance.now();
    const startedAt = now().toISOString();
    let status: CuaStageTimingEvent["status"] = "ok";
    try { return await action(); }
    catch (error) { status = "error"; throw error; }
    finally {
      emitTiming({ phase, startedAt, endedAt: now().toISOString(), durationMs: Math.round((performance.now() - started) * 100) / 100, status, ...details });
    }
  }

  async function createRuntime(stageName?: string): Promise<CuaRuntime> {
    const timingDetails = stageName ? { stageName } : {};
    const sdk = await timed("sdk-load", loadSdk, timingDetails);
    const connection = await timed("host-connect", () => deps.connectRuntime
      ? deps.connectRuntime(sdk)
      : startCuaDriverHost(sdk, { workingDirectory: process.cwd() }), timingDetails);
    return { sdk, driver: connection.driver, processId: connection.processId, close: connection.close };
  }

  async function disposeRuntime(runtime: CuaRuntime): Promise<void> {
    if (runtime.close) await runtime.close();
    else try { await runtime.driver.shutdown(); } catch { /* preserve the primary stage result */ }
  }

  /**
   * Only a genuine transport failure (the pipe/process the cached connection
   * depends on is actually gone) ever justifies dropping and replacing the
   * cached connection. A business-logic failure (a stale element, a disabled
   * control, an unsupported action) must never be mistaken for a dead
   * connection -- that was a real bug: an earlier version reset the cache on
   * ANY error, which could discard and orphan a perfectly healthy connection
   * over an unrelated failure.
   */
  function isConnectionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNRESET|EPIPE|ENOENT|broken pipe|pipe.*(?:clos|gone|lost)|(?:clos|gone|lost).*pipe|disconnect|not connected|named pipe/i.test(message);
  }

  /**
   * Drop the cached connection AND properly close the process behind it. A
   * previous version of this reset only cleared the in-memory reference,
   * never closing the stale host process or its cursor session -- the old
   * `cua-driver.exe` and its overlay cursor were silently orphaned, and
   * `shutdown()`/`closeAgentCursor` only ever knew about the newest
   * connection, so the leaked one's session was never cleanly ended. This is
   * the one place that resets the cache; every caller that detects a dead
   * connection must go through this, not clear `agentRuntimePromise` itself.
   */
  async function resetDeadRuntime(): Promise<void> {
    const stale = agentRuntimePromise;
    agentRuntimePromise = undefined;
    if (!stale) return;
    const old = await stale.catch(() => undefined);
    if (old) await disposeRuntime(old).catch(() => undefined);
  }

  async function agentRuntime(stageName?: string): Promise<CuaRuntime> {
    // No preflight liveness check here on purpose: this is called on every single
    // access, including inside tight polling loops (e.g. launch()'s up-to-60-attempt
    // window-discovery loop) -- adding a round-trip check to every one of those
    // calls was tried and measured to turn a normally-fast recovery into one slow
    // enough to blow through the 70s client timeout. Recovery from a connection
    // that died after a successful connect is handled where it is actually used
    // (withRegisteredWindow), reacting to a real failure instead of probing for one.
    const cached = Boolean(agentRuntimePromise);
    if (!agentRuntimePromise) {
      const runtimePromise = createRuntime(stageName);
      agentRuntimePromise = runtimePromise;
      void runtimePromise.catch(() => {
        if (agentRuntimePromise === runtimePromise) agentRuntimePromise = undefined;
      });
    }
    return timed("runtime-acquire", () => agentRuntimePromise!, { cached, ...(stageName ? { stageName } : {}) });
  }

  async function ensureAgentSession(identity: CuaAgentCursorIdentity, stageName?: string): Promise<{ runtime: CuaRuntime; session: AgentCursorSession }> {
    const details = agentCursorDetails(identity);
    const runtime = await agentRuntime(stageName);
    const alreadyTracked = agentSessions.has(details.key);
    if (!alreadyTracked && agentSessions.size >= 16) {
      throw new Error("This machine already has 16 active M9R agent cursor identities; close or revoke one before adding another.");
    }
    let started = false;
    try {
      // Cua reclaims named sessions after five minutes idle. startSession is
      // idempotent and refreshes that TTL, so do this for every authorized
      // action rather than trusting the broker's in-memory session map.
      await timed("session-start", () => runtime.driver.startSession({
        session: details.session,
        cursorTheme: {
          themeId: "cua.default",
          reducedMotion: runtime.sdk.CursorReducedMotion.Auto as import("@trycua/cua-driver").CursorReducedMotion,
        },
      }), { stageName, cached: alreadyTracked });
      started = true;
      // Motion is presentation-only. A driver that cannot apply the optional
      // style must not prevent the logical cursor from appearing or prevent
      // the stage from observing/focusing its target. The loader has already
      // validated the contract; this catch covers a runtime capability or
      // version mismatch returned by the native host itself. A later cursor
      // enable/session-state check still fails closed if the transport died.
      const motionStyle = runtime.sdk.CursorMotionStyle?.Adaptive;
      const motionTiming = runtime.sdk.CursorMotionTiming?.Fitts;
      if (typeof motionStyle === "number" && typeof motionTiming === "number") {
        try {
          const motion = await timed("cursor-motion", () => runtime.driver.setAgentCursorMotion({
            session: details.session,
            style: motionStyle,
            timing: motionTiming,
            effects: { trail: true, glow: true },
            dwellAfterClickMs: 100,
            idleHideMs: 60_000,
          }), { stageName, cached: alreadyTracked });
          resultError(motion, "Cua Driver could not configure the optional agent cursor motion.");
        } catch {
          // The native default motion remains valid; do not turn a visual
          // preference failure into a desktop-stage failure.
        }
      }
      agentSessions.set(details.key, details);
    } catch (error) {
      if (started && !alreadyTracked) {
        try { await runtime.driver.endSession({ session: details.session }); } catch { /* preserve the session setup error */ }
      }
      throw error;
    }
    return { runtime, session: agentSessions.get(details.key)! };
  }

  async function withCursorSlotLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = cursorSlotQueue;
    let release!: () => void;
    cursorSlotQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await run(); }
    finally { release(); }
  }

  /**
   * Make the provider cursor visible as soon as an approved stage is prepared,
   * before launch, capture, or the first input action.  This is intentionally
   * a cursor-overlay operation only: it does not focus a window or move the
   * owner's physical pointer.
   */
  async function showAgentCursor(name: string, identity: CuaAgentCursorIdentity): Promise<{ label: string; visible: true }> {
    const { runtime, session } = await ensureAgentSession(identity, name);
    resultError(await runtime.driver.setAgentCursorEnabled({ session: session.session, enabled: true }), "Cua Driver could not show the agent cursor before the first desktop action.");
    await withCursorSlotLock(async () => {
      if (cursorStartSlots.has(session.key)) return;
      const screen = screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
      const occupied = new Set(cursorStartSlots.values());
      let slot = 0;
      while (occupied.has(slot)) slot++;
      if (slot >= 16) throw new Error("No free agent cursor starting position is available.");
      cursorStartSlots.set(session.key, slot);
      const x = Math.floor(screen.width * ((slot % 4) + 1) / 5);
      const y = Math.floor(screen.height * (Math.floor(slot / 4) + 1) / 6);
      try {
        // The existing window scope is overlay-only in desktop-screen coordinates.
        // Desktop scope would move the real pointer and must never be used here.
        resultError(await runtime.driver.callTool("move_cursor", JSON.stringify({ scope: "window", x, y, session: session.session })), "Cua Driver could not place the agent cursor.");
        const state = cursorStateFromResult(await runtime.driver.getAgentCursorState({ session: session.session }));
        if (!state.enabled || state.x !== x || state.y !== y) throw new Error("Cua Driver did not confirm the agent cursor starting position.");
      } catch (error) {
        cursorStartSlots.delete(session.key);
        throw error;
      }
    });
    if ((await runtime.driver.getSession({ session: session.session })).cursorVisible !== true) {
      throw new Error("Cua Driver enabled the agent cursor but did not confirm that its desktop overlay is visible.");
    }
    return { label: session.session, visible: true };
  }

  async function inspectOwnerDesktop(name: string, identity: CuaAgentCursorIdentity) {
    const { stage, desktop, anchor } = await manager.inspectStage(name);
    const details = agentCursorDetails(identity);
    if (anchor) throw new Error("The owner-preview stage is not a desktop-wide mapping. Prepare it again to detach any stale app-window anchor.");
    if (!desktop.isCurrent) throw new Error("The owner-preview desktop is no longer the desktop shown to the owner. No desktop switch was made.");
    if (stage.agentAssignment?.handle !== details.handle || stage.agentAssignment.sessionTag !== details.sessionTag) {
      throw new Error("This Windows desktop is not assigned to the requesting M9R agent session.");
    }
    return { stage, desktop };
  }

  function desktopCaptureKey(name: string, identity: CuaAgentCursorIdentity): string {
    return `${name}\0${agentCursorDetails(identity).key}`;
  }

  function currentDesktopCapture(name: string, identity: CuaAgentCursorIdentity): CachedDesktopCapture {
    const key = desktopCaptureKey(name, identity);
    const capture = desktopCaptures.get(key);
    if (!capture || now().getTime() - capture.capturedAtMs > 30_000) {
      desktopCaptures.delete(key);
      throw new Error("The desktop view is missing or expired. Capture the current desktop again before acting on it.");
    }
    return capture;
  }

  function invalidateDesktopCaptures(): void {
    // Any input can change visible pixels, stacking, or coordinate meaning for every agent sharing this desktop.
    desktopCaptures.clear();
  }

  async function captureOwnerDesktop(name: string, identity: CuaAgentCursorIdentity, refresh = false): Promise<CuaStageCapture> {
    const details = agentCursorDetails(identity);
    const { runtime, session } = await ensureAgentSession(identity, name);
    await inspectOwnerDesktop(name, identity);
    if (!refresh) {
      try { return stageCapture(currentDesktopCapture(name, identity), now); } catch { /* take a new capture */ }
    }
    const result = await runtime.driver.getDesktopState({ session: session.session, maxImageDimension: MAX_IMAGE_DIMENSION });
    resultError(result, "Cua Driver could not capture the owner's current desktop.");
    const image = result.images?.[0];
    if (!image) throw new Error("Cua Driver returned no image for the owner's current desktop.");
    const safe = checkImage(image.mimeType, image.dataBase64);
    if (safe.mimeType !== "image/png") throw new Error("Cua Driver returned a desktop screenshot that is not PNG.");
    const bytes = Buffer.from(safe.dataBase64, "base64");
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("Cua Driver returned a desktop screenshot without a valid PNG frame.");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > 16_384 || height > 16_384) throw new Error("Cua Driver returned invalid desktop screenshot dimensions.");
    const encoded = result.structuredJson ?? result.rawJson;
    let metadata: unknown;
    try { metadata = encoded ? JSON.parse(encoded) : null; } catch { metadata = null; }
    const captureId = findDesktopCaptureId(metadata);
    if (!captureId) throw new Error("Cua Driver did not return the capture identity required to bind desktop actions to this exact screenshot.");
    await inspectOwnerDesktop(name, identity);
    const capturedAt = now();
    const cacheKey = `${name}\0${details.key}`;
    desktopCaptures.set(cacheKey, { captureId, width, height, stageName: name, identityKey: details.key,
      dataUrl: `data:image/png;base64,${safe.dataBase64}`, capturedAtMs: capturedAt.getTime(), capturedAt: capturedAt.toISOString() });
    return { dataUrl: `data:image/png;base64,${safe.dataBase64}`, width, height, capturedAt: capturedAt.toISOString() };
  }

  async function withOwnerDesktop<T>(name: string, identity: CuaAgentCursorIdentity, run: (input: {
    runtime: CuaRuntime;
    session: AgentCursorSession;
    capture: CachedDesktopCapture;
  }) => Promise<T>): Promise<T> {
    const { runtime, session } = await ensureAgentSession(identity, name);
    try {
      await inspectOwnerDesktop(name, identity);
      const capture = currentDesktopCapture(name, identity);
      if (capture.stageName !== name || capture.identityKey !== session.key) throw new Error("The captured desktop does not belong to this agent's current stage session.");
      return await run({ runtime, session, capture });
    } catch (error) {
      await hideAgentCursor(runtime.driver, session.session);
      throw error;
    }
  }

  function desktopInputKey(name: string, identity: CuaAgentCursorIdentity): string {
    return `${name}\0${agentCursorDetails(identity).key}`;
  }

function inputToolText(result: ToolResult): string {
  const parts = [result.text, result.rawJson, result.structuredJson,
    typeof (result as ToolResult & { errorCode?: unknown }).errorCode === "string"
      ? (result as ToolResult & { errorCode: string }).errorCode : undefined];
  if (result.action) parts.push(JSON.stringify(result.action));
  return parts.filter((value): value is string => typeof value === "string")
    .join(" ").replace(/[\r\n\t]+/g, " ").slice(0, 800);
}

function isBackgroundInputRefusal(value: unknown): boolean {
  const message = value instanceof Error ? value.message
    : value && typeof value === "object" ? inputToolText(value as ToolResult)
      : String(value);
  return /background[_ ](?:delivery|route).*?(?:unavailable|unsupported|refus|not available)|background_unavailable|target window class.*(?:background|input)|(?:background|posted) input.*(?:ignored|dropped)/i.test(message);
}

/** How long to wait once before deciding the owner is actively using the mouse right now. */
const OWNER_ACTIVITY_CHECK_MS = 150;
/** How far the real pointer has to move between two reads to count as the owner, not noise. */
const OWNER_ACTIVITY_THRESHOLD_PX = 3;

/**
 * Owner-cursor-isolation fix, owner-directed: before any real SendInput, capture the owner's
 * exact physical pointer position; if it visibly moved between two quick reads (the owner is
 * actively using the mouse right this moment), wait once for a natural gap instead of grabbing
 * control out from under them. After the action, restore the owner's pointer to exactly where it
 * was -- so regardless of whether the action started foreground or background, and regardless of
 * whether the owner touched their mouse during it, their pointer is never left wherever the
 * agent's action happened to leave it. If restoration cannot be confirmed after foreground input,
 * the call fails explicitly as uncertain instead of claiming clean pointer isolation.
 * Uses `deps.ownerPointer` when supplied (the test seam); production always uses the real native
 * Windows stage manager's get/restore, which is in closure scope here via `manager`.
 */
async function driverInputAction(driver: CuaDriverLike, name: string, args: Record<string, unknown>, fallback: string,
  options: { preferForeground?: boolean; signal?: AbortSignal; deliveryMode?: "background" | "owner-preview" } = {}) {
  options.signal?.throwIfAborted();
  const asyncOptions = options.signal ? { signal: options.signal } : undefined;
  const ownerPointer = deps.ownerPointer ?? { get: () => manager.getOwnerCursorPosition(), restore: (x: number, y: number) => manager.restoreOwnerCursorPosition(x, y) };
  const deliverForeground = async (): Promise<CuaStageActionOutcome> => {
    const pid = args.pid;
    const windowId = args.window_id;
    const session = args.session;
    if (!Number.isSafeInteger(pid) || (pid as number) < 1 || typeof windowId !== "number" || !Number.isFinite(windowId)
      || !Number.isInteger(windowId) || windowId < 1
      || typeof session !== "string" || session.length < 1) {
      throw new DesktopInputNotDispatchedError("The foreground action is missing the exact target window identity; no input was sent.");
    }
    const saved = await ownerPointer.get().catch(() => undefined);
    if (saved) {
      await delay(OWNER_ACTIVITY_CHECK_MS);
      const after = await ownerPointer.get().catch(() => undefined);
      if (after && (Math.abs(after.x - saved.x) > OWNER_ACTIVITY_THRESHOLD_PX || Math.abs(after.y - saved.y) > OWNER_ACTIVITY_THRESHOLD_PX)) {
        // The owner is actively moving the real pointer right now. Wait once for a natural
        // gap rather than holding indefinitely -- the task must still make progress.
        await delay(OWNER_ACTIVITY_CHECK_MS);
      }
    }
    // `delivery_mode: foreground` selects SendInput in the native driver, but
    // it does not itself activate a registered background window. Make the
    // ownership transition explicit before any keyboard/pointer event so the
    // visible app, the synthetic cursor, and the input target cannot diverge.
    options.signal?.throwIfAborted();
    actionOutcome(await driver.callTool("bring_to_front", JSON.stringify({ pid, window_id: windowId, session }), asyncOptions),
      "Cua Driver could not bring the exact target window to the foreground.");
    let outcome: CuaStageActionOutcome | undefined;
    let actionError: unknown;
    try {
      options.signal?.throwIfAborted();
      outcome = actionOutcome(await driver.callTool(name, JSON.stringify({ ...args, delivery_mode: "foreground" }), asyncOptions), fallback);
    } catch (error) {
      actionError = error;
    }
    let restoreError: unknown;
    if (saved) {
      try { await ownerPointer.restore(saved.x, saved.y); }
      catch (error) { restoreError = error; }
    }
    if (restoreError) {
      const detail = "Desktop input was dispatched, but the owner's pointer restoration could not be confirmed; the outcome is uncertain.";
      if (actionError instanceof Error) throw new Error(`${detail} Original action error: ${actionError.message}`, { cause: actionError });
      throw new Error(detail, { cause: restoreError });
    }
    if (actionError !== undefined) throw actionError;
    return { ...outcome!, foregroundConfirmed: true };
  };
  const runForeground = () => foregroundLease.run(name, options.signal, deliverForeground);
  if (options.deliveryMode === "background" && options.preferForeground) {
    throw new DesktopInputNotDispatchedError("A background stage cannot request foreground input; no input was sent. Use an owner-preview stage for an explicitly visible action.");
  }
  if (options.preferForeground) return runForeground();
  const backgroundArgs = JSON.stringify({ ...args, delivery_mode: "background" });
  try {
    const background = await driver.callTool(name, backgroundArgs, asyncOptions);
    if (!isBackgroundInputRefusal(background) && background.isError !== true) {
      return actionOutcome(background, fallback);
    }
    if (!isBackgroundInputRefusal(background)) return actionOutcome(background, fallback);
    if (options.deliveryMode === "background") {
      throw new DesktopInputNotDispatchedError("Background input is unavailable for the selected window; no foreground fallback was attempted and no input was sent.");
    }
  } catch (error) {
    if (!isBackgroundInputRefusal(error)) throw error;
    if (options.deliveryMode === "background") {
      throw new DesktopInputNotDispatchedError("Background input is unavailable for the selected window; no foreground fallback was attempted and no input was sent.");
    }
  }

  return runForeground();
}

  async function deliverTextToExactWindow(input: {
    runtime: CuaRuntime;
    session: string;
    pid: number;
    windowId: string | bigint;
    text: string;
    selected?: DesktopInputTarget;
    nativeInput?: () => Promise<boolean>;
    preferForeground?: boolean;
    deliveryMode?: "background" | "owner-preview";
    delayMs?: number;
    signal?: AbortSignal;
  }): Promise<CuaStageActionOutcome> {
    const windowId = input.windowId.toString();
    if (input.selected?.field && !input.preferForeground) {
      return typeIntoExactField(input.runtime.driver, input.selected, input.session, input.text, input.signal);
    }

    if (!input.signal && !input.preferForeground && input.nativeInput && await input.nativeInput()) {
      return { status: "unverifiable", summary: "Posted text to the selected native edit control; application effect requires verification." };
    }

    return driverInputAction(input.runtime.driver, "type_text", {
      pid: input.pid,
      window_id: Number.parseInt(windowId, 10),
      text: input.text,
      delay_ms: input.delayMs ?? DEFAULT_TYPE_DELAY_MS,
      session: input.session,
    }, "Cua Driver could not type into the selected window.", {
      preferForeground: input.preferForeground,
      deliveryMode: input.deliveryMode,
      signal: input.signal,
    });
  }

  function forgetDesktopInputTarget(name: string, identity: CuaAgentCursorIdentity): void {
    desktopInputTargets.delete(desktopInputKey(name, identity));
  }

  function forgetAgentDesktopInputTargets(identity: CuaAgentCursorIdentity): void {
    const suffix = `\0${agentCursorDetails(identity).key}`;
    for (const key of desktopInputTargets.keys()) if (key.endsWith(suffix)) desktopInputTargets.delete(key);
  }

  async function resolveOwnerWindowPoint(runtime: CuaRuntime, session: AgentCursorSession, screenPoint: { x: number; y: number }, includeAccessibilityTree = false) {
    // Win32 hit testing respects actual input regions instead of overlapping
    // rectangles. Shell HWNDs have no titles and are excluded by Cua snapshots.
    const selected = await (deps.windowAtPoint ?? manager.windowAtPoint)(screenPoint.x, screenPoint.y);
    if (selected.pid === runtime.processId) throw new Error("The desktop point resolves to the Cua overlay, not an application; no input was sent.");
    const { pid, windowId } = selected;
    if (selected.shell) {
      const origin = selected.screenOrigin;
      if (!origin || !Number.isSafeInteger(origin.x) || !Number.isSafeInteger(origin.y)) {
        throw new Error("Windows did not return the shell window origin; the stage cannot position its labeled cursor without moving the owner's pointer.");
      }
      const shellControl = await (deps.pointControl ?? manager.pointControl)(screenPoint.x, screenPoint.y);
      if (shellControl.windowPid !== pid || shellControl.windowId !== windowId.toString()) throw new Error("The shell control does not belong to the hit-tested window; no input was sent.");
      return { target: { pid, windowId }, localPoint: { x: screenPoint.x - origin.x, y: screenPoint.y - origin.y },
        shellControl, nativeKeyboardWindow: selected.keyboardWindow, state: undefined };
    }
    const state = await runtime.driver.getWindowState({ pid, windowId, session: session.session,
      includeAccessibilityTree, includeScreenshot: true, maxImageDimension: MAX_IMAGE_DIMENSION, timeoutMs: 1_500,
      ...(includeAccessibilityTree ? { maxElements: 512, maxDepth: 24 } : {}) });
    const image = imageFromWindowState(state, pid, windowId);
    const bounds = state.windowBounds;
    const frame: CuaStageWindowFrame = { ...image,
      ...(bounds ? { windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}) };
    const localPoint = desktopPointInWindow(screenPoint, frame);
    return { target: { pid, windowId }, localPoint, state,
      element: elementAtScreenPoint(state.elements ?? [], screenPoint.x, screenPoint.y) };
  }

  async function resolveOwnerDesktopPoint(runtime: CuaRuntime, session: AgentCursorSession, x: number, y: number,
    capture: CachedDesktopCapture, screen?: DesktopScreenSize, includeAccessibilityTree = false): Promise<ResolvedDesktopPoint> {
    if (!validPoint(x, y, capture)) throw new Error("Desktop coordinates must fall inside the latest desktop screenshot.");
    const screenSize = screen ?? screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
    const screenPoint = desktopPointOnScreen(x, y, capture, screenSize);
    const resolved = await resolveOwnerWindowPoint(runtime, session, screenPoint, includeAccessibilityTree);
    return { desktopPoint: { x, y }, screenPoint, ...resolved };
  }

  function rememberDesktopInputTarget(name: string, identity: CuaAgentCursorIdentity, target: DesktopInputTarget): void {
    const key = desktopInputKey(name, identity);
    desktopInputTargets.delete(key);
    desktopInputTargets.set(key, target);
    while (desktopInputTargets.size > 128) desktopInputTargets.delete(desktopInputTargets.keys().next().value!);
  }

  function activeDesktopInputTarget(name: string, identity: CuaAgentCursorIdentity): DesktopInputTarget {
    const target = desktopInputTargets.get(desktopInputKey(name, identity));
    if (!target) throw new DesktopInputNotDispatchedError("No agent input window is selected yet. Click the target on the captured desktop first; no keyboard input was sent.");
    return target;
  }

  async function verifiedDesktopInputTarget(runtime: CuaRuntime, name: string, identity: CuaAgentCursorIdentity): Promise<DesktopInputTarget> {
    const selected = activeDesktopInputTarget(name, identity);
    try {
      const listed = await runtime.driver.listWindows({ onScreenOnly: true });
      const stillVisible = listed.windows.some((window) => window.pid === selected.pid
        && window.windowId === selected.windowId && window.isOnScreen === true
        && window.onCurrentSpace !== false && window.minimized !== true);
      if (!stillVisible) throw new Error("The selected application window is no longer visible on the owner's desktop.");
      return selected;
    } catch (error) {
      forgetDesktopInputTarget(name, identity);
      const reason = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 180) : "window verification failed";
      throw new Error(`The selected background window could not be verified (${reason}); no keyboard input was sent.`);
    }
  }

  async function moveOwnerCursor(runtime: CuaRuntime, session: AgentCursorSession, point: ResolvedDesktopPoint): Promise<CuaStageCursorProof> {
    resultError(await runtime.driver.setAgentCursorEnabled({ session: session.session, enabled: true }), "Cua Driver could not enable the desktop agent cursor.");
    if (point.shellControl) {
      // The Windows shell HWND is not exposed by Cua's window inventory, so it
      // cannot be represented by ActionTarget.Window. Its documented window
      // scope moves only this agent's overlay in screen coordinates; Desktop
      // scope would move the owner's physical pointer and is never used.
      resultError(await runtime.driver.callTool("move_cursor", JSON.stringify({
        scope: "window", x: point.screenPoint.x, y: point.screenPoint.y, session: session.session,
      })), "Cua Driver could not move the labeled shell overlay cursor.");
    } else {
      const target = new runtime.sdk.ActionTarget.Window(point.target);
      resultError(await runtime.driver.moveCursor({ ...point.localPoint, target, session: session.session }), "Cua Driver could not move the labeled cursor on the exact window.");
    }
    const state = cursorStateFromResult(await runtime.driver.getAgentCursorState({ session: session.session }));
    // Cua reports a window-target cursor in the same window-local screenshot
    // space used by moveCursor. The legacy shell route reports desktop-screen
    // coordinates because it has no HWND target. Comparing both routes to the
    // physical screen point made every scaled desktop capture fail even though
    // the synthetic cursor had moved correctly.
    const expected = point.shellControl ? point.screenPoint : point.localPoint;
    if (!state.enabled || state.x === undefined || state.y === undefined
      || Math.abs(state.x - expected.x) > 1 || Math.abs(state.y - expected.y) > 1) {
      throw new Error(`Cua Driver did not confirm the requested desktop cursor position (expected ${expected.x},${expected.y}; actual ${state.x ?? "missing"},${state.y ?? "missing"}; enabled ${state.enabled}).`);
    }
    if ((await runtime.driver.getSession({ session: session.session })).cursorVisible !== true) {
      throw new Error("Cua Driver moved the cursor but did not confirm its overlay is visible on the owner's desktop.");
    }
    return { x: point.desktopPoint.x, y: point.desktopPoint.y, screenX: point.screenPoint.x, screenY: point.screenPoint.y, enabled: true, visible: true };
  }

  async function moveAndVerifyCursor(input: { driver: CuaDriverLike; sdk: CuaSdk; session: string; pid: number; windowId: bigint }, x: number, y: number, frame: CuaStageWindowFrame) {
    const point = cursorScreenPoint(x, y, frame);
    resultError(await input.driver.setAgentCursorEnabled({ session: input.session, enabled: true }), "Cua Driver could not enable the agent cursor.");
    resultError(await input.driver.moveCursor({ x, y, target: new input.sdk.ActionTarget.Window({ pid: input.pid, windowId: input.windowId }), session: input.session }), "Cua Driver could not move the agent cursor.");
    const state = cursorStateFromResult(await input.driver.getAgentCursorState({ session: input.session }));
    if (!state.enabled || state.x === undefined || state.y === undefined || Math.abs(state.x - x) > 1 || Math.abs(state.y - y) > 1) {
      throw new Error(`Cua Driver did not confirm the requested agent cursor position on this stage window (expected ${x},${y}; actual ${state.x ?? "missing"},${state.y ?? "missing"}).`);
    }
    const sessionState = await input.driver.getSession({ session: input.session });
    if (sessionState.cursorVisible !== true) throw new Error("Cua Driver moved the agent cursor but did not confirm that its desktop overlay is visible.");
    return { x, y, screenX: point.x, screenY: point.y, enabled: true as const, visible: true as const };
  }

  async function hideAgentCursor(driver: CuaDriverLike, session: string): Promise<void> {
    try {
      await driver.setAgentCursorEnabled({ session, enabled: false });
    } catch {
      // Cleanup must never mask the action's original error.
    }
  }
  async function nativeControl(name: string, kind: "click" | "type" | "scroll", point?: { x: number; y: number; imageWidth: number; imageHeight: number }, extra?: { text?: string; direction?: "up" | "down" }) {
    const { stage, anchor } = await manager.inspectStage(name);
    if (!anchor) throw new Error("Stage has no registered app window.");
    const selectionPath = join(root, `stage-input-${stage.roomDesktopId}.json`);
    if (!point) {
      if (!existsSync(selectionPath)) return false;
      let saved: { windowId: string; pid: number; x: number; y: number; imageWidth: number; imageHeight: number };
      try {
        saved = JSON.parse(readFileSync(selectionPath, "utf8")) as typeof saved;
      } catch {
        rmSync(selectionPath, { force: true });
        return false;
      }
      if (saved.pid !== anchor.pid || saved.windowId !== anchor.windowId
        || !Number.isSafeInteger(saved.x) || !Number.isSafeInteger(saved.y)
        || !Number.isSafeInteger(saved.imageWidth) || saved.imageWidth <= 0
        || !Number.isSafeInteger(saved.imageHeight) || saved.imageHeight <= 0) {
        rmSync(selectionPath, { force: true });
        return false;
      }
      point = { x: saved.x, y: saved.y, imageWidth: saved.imageWidth, imageHeight: saved.imageHeight };
    }
    try {
      await manager.controlInput(name, kind, { ...point, ...extra });
      if (kind === "click") writeFileSync(selectionPath, JSON.stringify({ pid: anchor.pid, windowId: anchor.windowId, ...point }), { mode: 0o600 });
      return true;
    } catch (error) {
      // Pixel/browser surfaces keep their Driver route. No other native failure
      // permits fallback, and there is never a foreground retry.
      if (error instanceof Error && error.message === "unsupported native-control window") return false;
      throw error;
    }
  }

  async function clearNativeInputSelection(name: string): Promise<void> {
    const stage = manager.list().find((item) => item.name === name);
    if (stage) rmSync(join(root, `stage-input-${stage.roomDesktopId}.json`), { force: true });
  }

  async function withRegisteredWindow<T>(nameInput: string, run: (input: {
    driver: CuaDriverLike;
    sdk: CuaSdk;
    session: string;
    pid: number;
    windowId: bigint;
    capture: () => Promise<CuaStageWindowFrame>;
    readStructure: () => Promise<CuaStageStructure>;
    elementAt: (x: number, y: number) => Promise<string | undefined>;
    elementAtPoint: (x: number, y: number, action?: "click" | "set_value") => Promise<CuaWindowElement | undefined>;
    elementByToken: (token: string, expected?: { role?: string; label?: string }) => Promise<{ element: CuaWindowElement; frame: CuaStageWindowFrame } | undefined>;
    captureTarget: (x: number, y: number) => Promise<CuaStageTargetDescription | undefined>;
  }) => Promise<T>, cursorIdentity?: CuaAgentCursorIdentity): Promise<T> {
    const { stage, anchor } = await manager.inspectStage(nameInput);
    if (!anchor) throw new Error(`Stage “${stage.name}” has no registered app window. Register an owned window before capturing or moving the Cua cursor.`);
    const pid = anchor.pid;
    const windowId = parseWindowId(anchor.windowId);
    const persistent = cursorIdentity ? await ensureAgentSession(cursorIdentity, nameInput) : undefined;
    const runtime = persistent?.runtime ?? await createRuntime(nameInput);
    const sdk = runtime.sdk;
    const driver = runtime.driver;
    const session = persistent?.session.session ?? safeSessionName(stage.name);
    let started = false;
    try {
      if (!persistent) {
        await driver.startSession({ session });
        started = true;
      }
      const captureOwnedPopups = async () => {
        const ownedPopups: NonNullable<CuaStageCapture["ownedPopups"]> = [];
        let popupCaptureStatus: "complete" | "unavailable" = "complete";
        try {
          const popups = await manager.ownedPopups(pid, windowId.toString());
          if (popups.length >= 8) popupCaptureStatus = "unavailable"; // bounded enumeration may have more surfaces
          for (const popup of popups) {
            const popupId = BigInt(popup.windowId);
            const snapshot = await driver.getWindowState({ pid, windowId: popupId, session, includeAccessibilityTree: false,
              includeScreenshot: true, maxImageDimension: MAX_IMAGE_DIMENSION, timeoutMs: 1_500 });
            const verified = (await manager.ownedPopups(pid, windowId.toString())).some((p) => p.windowId === popup.windowId);
            if (!verified) { popupCaptureStatus = "unavailable"; continue; }
            const image = imageFromWindowState(snapshot, pid, popupId);
            ownedPopups.push({ dataUrl: image.dataUrl, width: image.width, height: image.height, capturedAt: now().toISOString(), coordinateSpace: "popup-local" });
          }
        } catch { popupCaptureStatus = "unavailable"; }
        return { ownedPopups, popupCaptureStatus };
      };
      const capture = async () => {
        const request = {
          pid,
          windowId,
          session,
          includeAccessibilityTree: true,
          includeScreenshot: true,
          maxImageDimension: MAX_IMAGE_DIMENSION,
          maxElements: 512,
          maxDepth: 24,
          timeoutMs: 1_500,
        };
        let state: Awaited<ReturnType<CuaDriverLike["getWindowState"]>>;
        try { state = await driver.getWindowState(request); }
        catch (structureError) {
          // Some custom interfaces do not provide a usable accessibility tree.
          // Keep the same exact-window screenshot route; never change input/focus.
          try { state = await driver.getWindowState({ ...request, includeAccessibilityTree: false }); }
          catch (captureError) { throw new AggregateError([structureError, captureError], "Exact-window structure and screenshot capture both failed."); }
        }
        const image = imageFromWindowState(state, pid, windowId);
        const bounds = state.windowBounds;
        const controls: CuaStageTargetDescription[] = [];
        let controlsTruncated = false;
        const { ownedPopups, popupCaptureStatus } = await captureOwnedPopups();
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          for (const element of state.elements ?? []) {
            const frame = element.frame;
            if (element.enabled === false || !frame || frame.w <= 0 || frame.h <= 0) continue;
            const left = Math.max(0, (frame.x - bounds.x) * image.width / bounds.width);
            const top = Math.max(0, (frame.y - bounds.y) * image.height / bounds.height);
            const right = Math.min(image.width, (frame.x + frame.w - bounds.x) * image.width / bounds.width);
            const bottom = Math.min(image.height, (frame.y + frame.h - bounds.y) * image.height / bounds.height);
            if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
            if (controls.length === 200) { controlsTruncated = true; break; }
            controls.push({
              ...(element.label ? { label: element.label.replace(/[\r\n\t]+/g, " ").slice(0, 160) } : {}),
              ...(element.role ? { role: element.role.slice(0, 40) } : {}),
              rect: { x: left, y: top, width: right - left, height: bottom - top },
            });
          }
        }
        return {
          dataUrl: image.dataUrl,
          width: image.width,
          height: image.height,
          controls,
          ...(controlsTruncated ? { controlsTruncated: true as const } : {}),
          ownedPopups, popupCaptureStatus,
          ...(bounds ? { windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}),
        };
      };
      const readStructure = async (): Promise<CuaStageStructure> => {
        const request = {
          pid,
          windowId,
          session,
          includeAccessibilityTree: true,
          includeScreenshot: true,
          maxImageDimension: MAX_IMAGE_DIMENSION,
          maxElements: 512,
          maxDepth: 24,
          timeoutMs: 1_500,
        };
        let state: Awaited<ReturnType<CuaDriverLike["getWindowState"]>>;
        let accessibilityAvailable = true;
        try {
          // A window queried immediately after launch may not have finished exposing its
          // accessibility surface yet -- this is a timing race, not an app-specific limitation,
          // and it affects any freshly-opened app the same way. A couple of short, bounded
          // retries lets that race resolve itself before falling back to a plain screenshot;
          // an already-ready window (the normal case) succeeds on the first attempt as before,
          // with no added latency.
          let lastError: unknown;
          state = undefined as unknown as Awaited<ReturnType<CuaDriverLike["getWindowState"]>>;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              state = await driver.getWindowState(request);
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;
              if (attempt < 2) await delay(250);
            }
          }
          if (lastError) throw lastError;
        } catch {
          accessibilityAvailable = false;
          // A tree failure must not turn into an unbounded retry loop. One
          // exact-window screenshot is the documented visual fallback.
          state = await driver.getWindowState({ ...request, includeAccessibilityTree: false });
        }
        const fallback = { ...imageFromWindowState(state, pid, windowId), ...await captureOwnedPopups() };
        const byIndex = new Map((state.elements ?? []).map((element) => [element.elementIndex.toString(), element]));
        const elements = (state.elements ?? []).flatMap((element) => {
          if (!element.elementToken) return [];
          const actions = Array.isArray(element.actions)
            ? element.actions.filter((action): action is string => typeof action === "string" && action.length > 0)
                .slice(0, 16).map((action) => action.slice(0, 40))
            : [];
          const parent = element.parentIndex === undefined ? undefined : byIndex.get(element.parentIndex.toString());
          return [{
            ref: element.elementToken,
            ...(parent?.elementToken ? { parentRef: parent.elementToken } : {}),
            ...(Number.isSafeInteger(element.depth) && element.depth >= 0 ? { depth: element.depth } : {}),
            ...(typeof element.role === "string" && element.role ? { role: element.role.slice(0, 80) } : {}),
            ...(typeof element.label === "string" && element.label.trim() ? { label: element.label.replace(/[\r\n\t]+/g, " ").slice(0, 160) } : {}),
            ...(typeof element.enabled === "boolean" ? { enabled: element.enabled } : {}),
            ...(typeof element.selected === "boolean" ? { selected: element.selected } : {}),
            ...(actions.length ? { actions } : {}),
            ...(actions.includes("set_value") ? { canReplaceValue: true } : {}),
          }];
        });
        const hasTree = Array.isArray(state.elements);
        const status = !accessibilityAvailable ? "unavailable" : !hasTree || state.truncated === true || state.elementsComplete === false || state.degraded === true || fallback.ownedPopups.length > 0 ? "partial" : "complete";
        return {
          status,
          capturedAt: now().toISOString(),
          ...(typeof state.appName === "string" ? { appName: state.appName.slice(0, 120) } : {}),
          ...(typeof state.windowTitle === "string" ? { windowTitle: state.windowTitle.slice(0, 240) } : {}),
          elements,
          ...(status !== "complete" ? { fallbackCapture: stageCapture({ ...fallback, capturedAt: now().toISOString() }, now) } : {}),
        };
      };
      const hitTarget = async (x: number, y: number, action?: "click" | "set_value") => {
        const state = await driver.getWindowState({ pid, windowId, session, includeAccessibilityTree: true,
          includeScreenshot: true, maxImageDimension: MAX_IMAGE_DIMENSION, maxElements: 512, maxDepth: 24, timeoutMs: 1500 });
        imageFromWindowState(state, pid, windowId);
        const bounds = state.windowBounds;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
        // Windows accessibility frames are screen coordinates, while the pill
        // passes scaled screenshot pixels. Convert before hit-testing.
        const screenX = bounds.x + x * bounds.width / state.screenshotWidth!;
        const screenY = bounds.y + y * bounds.height / state.screenshotHeight!;
        return elementAtScreenPoint(state.elements ?? [], screenX, screenY, action === undefined ? undefined
          : (element) => action === "set_value" ? element.actions?.includes("set_value") === true
            : (element.actions === undefined && !/^(?:Text|StaticText|Label)$/i.test(element.role ?? ""))
              || element.actions?.some((name) => /^(?:click|invoke|press|expand|toggle|select)$/i.test(name)) === true);
      };
      const elementByToken = async (token: string, expected?: { role?: string; label?: string }) => {
        const state = await driver.getWindowState({ pid, windowId, session, includeAccessibilityTree: true,
          includeScreenshot: true, maxImageDimension: MAX_IMAGE_DIMENSION, maxElements: 512, maxDepth: 24, timeoutMs: 1_500 });
        const image = imageFromWindowState(state, pid, windowId);
        const candidates = state.elements ?? [];
        // elementToken is prefixed with something that changes on every independent
        // getWindowState call (confirmed empirically: the same, unchanged control got a
        // different full token on two back-to-back reads), while the suffix after the
        // last ":" stayed identical both times. An exact match can therefore fail for
        // the overwhelming majority of real calls even when the target control plainly
        // still exists and is unchanged -- this was the actual cause behind every
        // "stale or disabled" click failure tonight, not real staleness. Try the exact
        // token first in case a future driver version makes it stable, then fall back
        // to the empirically-stable suffix.
        //
        // The suffix alone is only the element's position in THIS walk's tree, not a
        // real identity -- if the tree genuinely changed (an item was added/removed, a
        // dialog opened) between the read the caller saw and this walk, the same
        // suffix can now belong to a DIFFERENT control. Silently acting on it would be
        // worse than the original "stale" error it replaced. When the caller supplies
        // the role/label it actually saw (expectedRole/expectedLabel on the action),
        // a suffix match is trusted only if it also matches those -- a real identity
        // check, not just a position guess. Without hints, a suffix match is
        // never trusted: uniqueness only proves that one control currently
        // occupies the position, not that it is the control the caller saw.
        let element = candidates.find((candidate) => candidate.elementToken === token);
        if (!element) {
          const suffix = token.includes(":") ? token.slice(token.lastIndexOf(":")) : undefined;
          if (suffix) {
            const suffixMatches = candidates.filter((candidate) => candidate.elementToken?.endsWith(suffix));
            if (expected?.role !== undefined || expected?.label !== undefined) {
              element = suffixMatches.find((candidate) =>
                (expected.role === undefined || candidate.role === expected.role)
                && (expected.label === undefined || candidate.label === expected.label));
            }
          }
        }
        if (!element) return undefined;
        return { element, frame: { ...image, ...(state.windowBounds ? { windowBounds: { x: state.windowBounds.x, y: state.windowBounds.y, width: state.windowBounds.width, height: state.windowBounds.height } } : {}) } };
      };
      const elementAt = async (x: number, y: number) => (await hitTarget(x, y))?.elementToken;
      const describeAt = async (x: number, y: number): Promise<CuaStageTargetDescription | undefined> => {
        const hit = await hitTarget(x, y);
        if (!hit) return undefined;
        const description: CuaStageTargetDescription = {};
        if (typeof hit.label === "string" && hit.label.trim()) description.label = hit.label.replace(/[\r\n\t]+/g, " ").slice(0, 160);
        if (typeof hit.role === "string" && hit.role.trim()) description.role = hit.role.slice(0, 40);
        const frame = hit.frame;
        if (frame && frame.w > 0 && frame.h > 0) description.rect = { x: frame.x, y: frame.y, width: frame.w, height: frame.h };
        return description;
      };
      return await run({ driver, sdk, session, pid, windowId, capture, readStructure, captureTarget: describeAt, elementAt, elementAtPoint: hitTarget, elementByToken });
    } catch (error) {
      if (cursorIdentity) await hideAgentCursor(driver, session);
      // A genuine connection failure here means the cached connection (shared by
      // every persistent-identity call, not just this one) is dead. This never
      // retries the current call -- a click or type whose outcome is unknown must
      // never be silently replayed here; that risk is owned by the operation-
      // receipt system one layer up. It only makes sure every call AFTER this one
      // gets a fresh connection instead of repeating the exact same failure
      // forever, which is what happened before this was centralized.
      if (persistent && isConnectionError(error)) await resetDeadRuntime().catch(() => undefined);
      throw error;
    } finally {
      if (!persistent && started) {
        try { await driver.endSession({ session }); } catch { /* preserve the primary operation result */ }
      }
      if (!persistent) await disposeRuntime(runtime);
    }
  }

  async function capture(name: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageCapture> {
    return withRegisteredWindow(name, async ({ capture: captureWindow }) => stageCapture(await captureWindow(), now), cursorIdentity);
  }

  async function readStructure(name: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageStructure> {
    try {
      return await withRegisteredWindow(name, async ({ readStructure: read }) => read(), cursorIdentity);
    } catch (error) {
      // read_structure never mutates anything, so retrying it carries none of the
      // duplicate-action risk a click or type retry would. But only a genuine
      // connection failure justifies the retry -- a business-logic failure (the
      // window closed, a real accessibility error) must surface immediately, not
      // be masked by a pointless reconnect-and-retry that will just fail the
      // same way again for an unrelated reason.
      if (!isConnectionError(error)) throw error;
      await resetDeadRuntime();
      return withRegisteredWindow(name, async ({ readStructure: read }) => read(), cursorIdentity)
        .catch(() => { throw error; });
    }
  }

  async function moveCursor(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity): Promise<{ capture: CuaStageCapture; cursor: CuaStageCursorProof }> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) throw new Error("Cursor coordinates must be non-negative whole screenshot pixels.");
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const captured = await captureWindow();
      if (x >= captured.width || y >= captured.height) throw new Error("Cursor coordinates must fall inside the current stage window snapshot.");
      const cursor = await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, captured);
      return {
        capture: stageCapture(captured, now),
        cursor,
      };
    }, cursorIdentity);
  }

  async function describeTarget(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageTargetDescription | undefined> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) throw new Error("Target coordinates must be non-negative whole screenshot pixels.");
    return withRegisteredWindow(name, async ({ capture: captureWindow, captureTarget }) => {
      const captured = await captureWindow();
      if (x >= captured.width || y >= captured.height) throw new Error("Target coordinates must fall inside the current stage window snapshot.");
      return captureTarget(x, y);
    }, cursorIdentity);
  }

  /**
   * Same purpose as describeTarget (feeding the money gate a real label before a
   * click is allowed through), but for click_element, which has no x/y at all --
   * only a ref. click_element and middle_click skipping the money gate entirely
   * was a real, confirmed security gap: an element-ref click or a middle click on
   * a payment-shaped control went through with no owner approval whatsoever.
   */
  async function describeElementTarget(name: string, ref: string, expected: { role?: string; label?: string }, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageTargetDescription | undefined> {
    return withRegisteredWindow(name, async ({ elementByToken }) => {
      const selected = await elementByToken(ref, expected);
      if (!selected) return undefined;
      const description: CuaStageTargetDescription = {};
      if (typeof selected.element.label === "string" && selected.element.label.trim()) description.label = selected.element.label.replace(/[\r\n\t]+/g, " ").slice(0, 160);
      if (typeof selected.element.role === "string" && selected.element.role.trim()) description.role = selected.element.role.slice(0, 40);
      const rect = selected.element.frame;
      if (rect && rect.w > 0 && rect.h > 0) description.rect = { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
      return description;
    }, cursorIdentity);
  }

  async function captureDesktop(name: string, cursorIdentity: CuaAgentCursorIdentity): Promise<CuaStageCapture> {
    return captureOwnerDesktop(name, cursorIdentity, true);
  }

  /**
   * Read one generic desktop snapshot. The native Windows layer supplies a
   * bounded whole-desktop UIA tree when available; Cua's per-window trees and
   * the exact same desktop pixels remain the complementary fallback. There is
   * one provider-neutral target model, not an app or provider route.
   */
  async function readDesktopStructure(name: string, identity: CuaAgentCursorIdentity): Promise<CuaDesktopStructure> {
    await captureOwnerDesktop(name, identity, true);
    return withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      const screen = screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
      const fallbackCapture = stageCapture(capture, now);
      let shell: CuaDesktopStructure["shell"] = {
        status: "visual-fallback" as const,
        reason: "Native Windows UI Automation was unavailable; the same desktop capture remains the bounded visual fallback.",
      };
      let listed: Awaited<ReturnType<CuaDriverLike["listWindows"]>>;
      try {
        listed = await runtime.driver.listWindows({ onScreenOnly: true });
      } catch {
        return {
          scope: "desktop" as const,
          status: "unavailable" as const,
          capturedAt: capture.capturedAt,
          windows: [],
          elements: [],
          shell,
          fallbackCapture,
        };
      }

      const candidates = (listed.windows ?? []).filter((window): window is CuaWindowInfo => {
        const bounds = window.bounds;
        return window.isOnScreen === true && window.onCurrentSpace !== false && window.minimized !== true
          && Number.isSafeInteger(window.pid) && (window.pid ?? 0) > 0
          && typeof window.windowId === "bigint" && window.windowId > BigInt(0)
          && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
          && bounds.width > 0 && bounds.height > 0
          && !/m9r(?:[- ]overlay)?|agent cursor overlay|cua cursor overlay/i.test(`${window.appName} ${window.title}`);
      }).slice(0, MAX_DESKTOP_STRUCTURE_WINDOWS);
      const zIndexed = candidates.filter((window) => typeof window.zIndex === "bigint");
      let frontmostWindowId: bigint | undefined;
      if (zIndexed.length > 0 && zIndexed.every((window) => typeof window.zIndex === "bigint")) {
        const highest = zIndexed.reduce((current, window) => window.zIndex! > current ? window.zIndex! : current, zIndexed[0]!.zIndex!);
        if (zIndexed.filter((window) => window.zIndex === highest).length === 1) frontmostWindowId = zIndexed.find((window) => window.zIndex === highest)!.windowId;
      }

      const windows: CuaDesktopStructureWindow[] = [];
      const elements: CuaDesktopStructureElement[] = [];
      const fallbackControls: CuaStageTargetDescription[] = [];

      // Native UIA is the structure-first shell and whole-screen route. The
      // native response contains screen-space rectangles, so map them into the
      // one exact Cua desktop capture before exposing them to the broker.
      try {
        const nativeStructure = await manager.desktopStructure({ maxElements: 64, maxDepth: 10 });
        const nativeElements: CuaDesktopStructureElement[] = [];
        for (const nativeElement of nativeStructure.elements) {
          const rect = desktopRectInCapture(nativeElement.rect, screen, capture, nativeStructure.screen);
          if (!rect) continue;
          const publicElement: CuaDesktopStructureElement = {
            ref: `desktop-shell:${nativeElement.ref}`,
            windowRef: "desktop-shell",
            rect,
            depth: nativeElement.depth,
            ...(nativeElement.role.trim() ? { role: nativeElement.role.slice(0, 80) } : {}),
            ...(nativeElement.label.trim() ? { label: nativeElement.label.replace(/[\r\n\t]+/g, " ").slice(0, 160) } : {}),
            enabled: nativeElement.enabled,
          };
          nativeElements.push(publicElement);
          fallbackControls.push({
            ...(publicElement.label ? { label: publicElement.label } : {}),
            ...(publicElement.role ? { role: publicElement.role } : {}),
            rect,
          });
        }
        elements.push(...nativeElements.slice(0, MAX_DESKTOP_STRUCTURE_ELEMENTS));
        shell = {
          status: nativeStructure.status,
          reason: nativeStructure.truncated
            ? "Native Windows UI Automation captured a bounded whole-desktop control tree; the tree was capped and the exact capture remains available for fallback."
            : "Native Windows UI Automation captured the bounded whole-desktop control tree in the same observation cycle.",
          ...(nativeElements.length ? { elements: nativeElements } : {}),
          ...(nativeStructure.truncated ? { truncated: true as const } : {}),
        };
      } catch {
        // Native UIA is optional at this boundary. Keep one bounded visual
        // fallback rather than probing another route or failing observation.
      }

      for (let index = 0; index < candidates.length; index++) {
        const window = candidates[index]!;
        const windowRect = desktopRectInCapture(window.bounds, screen, capture);
        if (!windowRect) continue;
        const ref = `desktop-window-${index + 1}`;
        const baseWindow = {
          ref,
          appName: window.appName.slice(0, 120),
          title: window.title.slice(0, 240),
          rect: windowRect,
          ...(frontmostWindowId === window.windowId ? { frontmost: true } : {}),
          ...(window.minimized !== undefined ? { minimized: window.minimized } : {}),
          ...(window.onCurrentSpace !== undefined ? { onCurrentSpace: window.onCurrentSpace } : {}),
        };
        fallbackControls.push({ label: window.title.slice(0, 160) || window.appName.slice(0, 160), role: "desktop-window", rect: windowRect });
        try {
          const state = await runtime.driver.getWindowState({
            pid: window.pid!,
            windowId: window.windowId,
            session: session.session,
            includeAccessibilityTree: true,
            includeScreenshot: false,
            maxElements: 128,
            maxDepth: 16,
            timeoutMs: 900,
          });
          if (state.pid !== window.pid || state.windowId !== window.windowId) throw new Error("window identity changed");
          const sourceElements = Array.isArray(state.elements) ? state.elements.slice(0, 128) : [];
          const byIndex = new Map(sourceElements.map((element) => [String(element.elementIndex), element]));
          const refByIndex = new Map<string, string>();
          const remainingElements = Math.max(0, MAX_DESKTOP_STRUCTURE_ELEMENTS - elements.length);
          const pending = sourceElements.filter((element) => typeof element.elementToken === "string").slice(0, remainingElements);
          for (let elementIndex = 0; elementIndex < pending.length; elementIndex++) {
            refByIndex.set(String(pending[elementIndex]!.elementIndex), `${ref}:element-${elementIndex + 1}`);
          }
          const windowElements: CuaDesktopStructureElement[] = [];
          for (const element of pending) {
            const actions = Array.isArray(element.actions)
              ? element.actions.filter((action): action is string => typeof action === "string" && action.length > 0)
                .slice(0, 16).map((action) => action.slice(0, 40))
              : [];
            const parent = element.parentIndex === undefined ? undefined : byIndex.get(String(element.parentIndex));
            const rect = element.frame ? desktopRectInCapture({ x: element.frame.x, y: element.frame.y, width: element.frame.w, height: element.frame.h }, screen, capture) : undefined;
            const publicElement: CuaDesktopStructureElement = {
              ref: refByIndex.get(String(element.elementIndex))!,
              windowRef: ref,
              ...(rect ? { rect } : {}),
              ...(parent?.elementToken && refByIndex.has(String(parent.elementIndex)) ? { parentRef: refByIndex.get(String(parent.elementIndex))! } : {}),
              ...(Number.isSafeInteger(element.depth) && element.depth >= 0 ? { depth: element.depth } : {}),
              ...(typeof element.role === "string" && element.role ? { role: element.role.slice(0, 80) } : {}),
              ...(typeof element.label === "string" && element.label.trim() ? { label: element.label.replace(/[\r\n\t]+/g, " ").slice(0, 160) } : {}),
              ...(typeof element.enabled === "boolean" ? { enabled: element.enabled } : {}),
              ...(typeof element.selected === "boolean" ? { selected: element.selected } : {}),
              ...(actions.length ? { actions } : {}),
              ...(actions.includes("set_value") ? { canReplaceValue: true } : {}),
            };
            windowElements.push(publicElement);
            elements.push(publicElement);
            if (rect && (publicElement.label || publicElement.role)) {
              fallbackControls.push({
                ...(publicElement.label ? { label: publicElement.label } : {}),
                ...(publicElement.role ? { role: publicElement.role } : {}),
                rect,
              });
            }
          }
          const complete = Array.isArray(state.elements) && state.truncated !== true && state.elementsComplete !== false
            && state.degraded !== true;
          windows.push({ ...baseWindow, status: complete ? "complete" : "partial", elements: windowElements });
        } catch {
          windows.push({ ...baseWindow, status: "unavailable", elements: [] });
        }
        if (elements.length >= MAX_DESKTOP_STRUCTURE_ELEMENTS) break;
      }
      const controls = fallbackControls.slice(0, 200);
      const capped = fallbackControls.length > controls.length;
      const boundedFallback: CuaStageCapture = {
        ...fallbackCapture,
        ...(controls.length ? { controls } : {}),
        ...(capped ? { controlsTruncated: true as const } : {}),
      };
      return {
        scope: "desktop" as const,
        status: shell.status === "complete" && windows.every((window) => window.status === "complete") && !capped
          ? "complete" as const : "partial" as const,
        capturedAt: capture.capturedAt,
        windows,
        elements,
        shell,
        fallbackCapture: boundedFallback,
      };
    });
  }

  async function describeDesktopTarget(name: string, x: number, y: number, cursorIdentity: CuaAgentCursorIdentity): Promise<CuaStageTargetDescription | undefined> {
    return withOwnerDesktop(name, cursorIdentity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new Error("Target coordinates must fall inside the latest desktop screenshot.");
      const size = screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
      const point = desktopPointOnScreen(x, y, capture, size);
      const { state, shellControl } = await resolveOwnerWindowPoint(runtime, session, point, true);
      if (shellControl) return { label: shellControl.label, role: "shell-control", rect: shellControl.rect };
      // Native controls have meaningful accessibility names even when OCR cannot
      // describe an icon. Identify the smallest named control before resorting
      // to visual regions; otherwise a normal Start/taskbar click asks for money
      // approval merely because an OCR region was absent.
      const hit = (state?.elements ?? []).filter((element) => {
        const frame = element.frame;
        return element.enabled !== false && typeof element.label === "string" && element.label.trim()
          && frame && frame.w > 0 && frame.h > 0 && point.x >= frame.x && point.y >= frame.y
          && point.x < frame.x + frame.w && point.y < frame.y + frame.h;
      }).sort((a, b) => a.frame!.w * a.frame!.h - b.frame!.w * b.frame!.h)[0];
      if (hit) return { label: hit.label!.replace(/[\r\n\t]+/g, " ").slice(0, 160), role: hit.role?.slice(0, 40),
        rect: { x: hit.frame!.x, y: hit.frame!.y, width: hit.frame!.w, height: hit.frame!.h } };
      const result = await runtime.driver.parseVisualRegions({
        captureId: capture.captureId,
        options: { kinds: [runtime.sdk.VisualRegionKind.Text, runtime.sdk.VisualRegionKind.Icon], minConfidence: 0.35, maxRegions: 128 },
      });
      return desktopTargetAt(result, x, y);
    });
  }

  async function moveDesktopCursor(name: string, x: number, y: number, identity: CuaAgentCursorIdentity) {
    const result = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture);
      await inspectOwnerDesktop(name, identity);
      const cursor = await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      return { capture: stageCapture(capture, now), cursor };
    });
    // Moving the synthetic cursor does not change desktop pixels or invalidate
    // the immutable capture used to bind the next coordinate action.
    return result;
  }

  async function clickDesktop(name: string, x: number, y: number, identity: CuaAgentCursorIdentity, options: CuaDesktopClickOptions = {}) {
    const result = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new Error("Click coordinates must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      await clearNativeInputSelection(name);
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture, undefined, true);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      if (point.shellControl) {
        if (options.button === "right" || options.button === "middle" || (options.count ?? 1) !== 1) throw new Error("This shell control supports accessibility activation, not a synthetic non-left click.");
        const activated = await (deps.pointControl ?? manager.pointControl)(point.screenPoint.x, point.screenPoint.y, point.shellControl);
        if (activated.confirmed === true && point.nativeKeyboardWindow === true) rememberDesktopInputTarget(name, identity, point.target);
        // Invocation is acknowledged, but the changed desktop capture proves
        // whether the app opened. Never bind keyboard input to the taskbar.
        return { status: "unverified" as const, summary: "Windows acknowledged exact shell control invocation; verify the returned capture." };
      }
      const semanticClick = (options.button ?? "left") === "left" && (options.count ?? 1) === 1
        && point.element?.elementToken && runtime.sdk.ClickPosition.Element;
      const outcome = await driverInputAction(runtime.driver, "click", {
        pid: point.target.pid,
        window_id: Number(point.target.windowId),
        ...(semanticClick ? { element_token: point.element!.elementToken! } : { x: point.localPoint.x, y: point.localPoint.y }),
        button: options.button === "right" ? "right" : options.button === "middle" ? "middle" : "left",
        count: options.count ?? 1,
        session: session.session,
      }, "Cua Driver could not click the exact window under the agent cursor.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      // Only a driver-confirmed click can establish where later keyboard input
      // should go. Returning an unverified click is truthful; remembering its
      // HWND would let a follow-up type/hotkey act on an unconfirmed focus.
      if (outcome.status === "confirmed" && point.element?.actions?.includes("set_value") && /^(?:Document|Edit|TextField|TextArea|ComboBox)$/i.test(point.element.role ?? "")) {
        // The click remains unverified. Subsequent typing addresses this exact
        // field explicitly, so it never depends on an unconfirmed focus change.
        rememberDesktopInputTarget(name, identity, { ...point.target, field: {
          ...point.screenPoint, label: point.element.label, role: point.element.role,
        } });
      }
      else if (outcome.status === "confirmed") rememberDesktopInputTarget(name, identity, point.target);
      else forgetDesktopInputTarget(name, identity);
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome: result };
  }

  async function typeTextDesktop(name: string, text: string, identity: CuaAgentCursorIdentity, options: CuaStageTextOptions = {}) {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    const delayMs = normalizeTypeDelayMs(options.delayMs);
    // This desktop-wide route ignored `options.mode` entirely before, always using
    // whatever field a prior click remembered regardless of what the caller asked
    // for -- the same "replace never replaces" bug as the app-window route, fixed
    // the same way: look up the real field at the given point and replace its
    // value directly, instead of silently reusing an unrelated remembered target.
    if (options.mode === "replace") {
      if (options.x === undefined || options.y === undefined) throw new Error("Replace mode requires an exact field point; no text was sent.");
      const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
        await inspectOwnerDesktop(name, identity);
        const point = await resolveOwnerDesktopPoint(runtime, session, options.x!, options.y!, capture, undefined, true);
        const element = point.element;
        if (!element?.elementToken || element.enabled === false || !element.actions?.includes("set_value")) {
          throw new DesktopInputNotDispatchedError("No replaceable text field was found at the given point; no text was sent.");
        }
        if ((options.expectedRole !== undefined && element.role !== options.expectedRole)
          || (options.expectedLabel !== undefined && element.label !== options.expectedLabel)) {
          throw new Error("The field at the given point could not be confirmed as the same one you observed; no text was sent.");
        }
        await inspectOwnerDesktop(name, identity);
        await moveOwnerCursor(runtime, session, point);
        await inspectOwnerDesktop(name, identity);
        forgetDesktopInputTarget(name, identity);
        return actionOutcome(await runtime.driver.callTool("set_value", JSON.stringify({
          pid: point.target.pid, window_id: Number(point.target.windowId), element_token: element.elementToken, value: text, session: session.session,
        }), options.signal ? { signal: options.signal } : undefined), "Cua Driver could not replace the field's value.");
      });
      invalidateDesktopCaptures();
      return { capture: await captureOwnerDesktop(name, identity, true), outcome };
    }
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        if (selected.field) {
          const point = await resolveOwnerWindowPoint(runtime, session, selected.field);
          if (point.target.pid !== selected.pid || point.target.windowId !== selected.windowId) {
            throw new Error("The selected text field moved to another application window; no keyboard input was sent.");
          }
          await inspectOwnerDesktop(name, identity);
          await moveOwnerCursor(runtime, session, {
            ...point,
            desktopPoint: { x: selected.field.x, y: selected.field.y },
            screenPoint: { x: selected.field.x, y: selected.field.y },
          });
          await inspectOwnerDesktop(name, identity);
        }
        return await deliverTextToExactWindow({ runtime, session: session.session, pid: selected.pid,
          windowId: selected.windowId, selected, text, delayMs, preferForeground: options.confirmFocusForeground,
          deliveryMode: options.deliveryMode, signal: options.signal });
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function scrollDesktop(name: string, x: number, y: number, direction: "up" | "down", identity: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new Error("Scroll coordinates must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const screen = screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture, screen);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      const outcome = await driverInputAction(runtime.driver, "scroll", {
        pid: point.target.pid, window_id: Number(point.target.windowId), x: point.localPoint.x, y: point.localPoint.y,
        direction, by: "line", amount: 3, session: session.session,
      }, "Cua Driver could not scroll the exact window under the agent cursor.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function scrollDeltaDesktop(name: string, x: number, y: number, deltaX: number, deltaY: number,
    unit: "pixel" | "line" | "page", identity: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}) {
    const scroll = scrollDeltaAmount(deltaX, deltaY, unit);
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new Error("Scroll coordinates must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const screen = screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture, screen);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      return driverInputAction(runtime.driver, "scroll", {
        pid: point.target.pid, window_id: Number(point.target.windowId), x: point.localPoint.x, y: point.localPoint.y,
        direction: scroll.direction, by: scroll.by, amount: scroll.amount, session: session.session,
      }, "Cua Driver could not scroll the exact window under the agent cursor.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function dragDesktop(name: string, fromX: number, fromY: number, toX: number, toY: number, identity: CuaAgentCursorIdentity, options: CuaStageDragOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(fromX, fromY, capture) || !validPoint(toX, toY, capture)) throw new Error("Both drag points must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const screen = screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
      const start = await resolveOwnerDesktopPoint(runtime, session, fromX, fromY, capture, screen);
      const end = await resolveOwnerDesktopPoint(runtime, session, toX, toY, capture, screen);
      if (start.target.pid !== end.target.pid || start.target.windowId !== end.target.windowId) {
        throw new Error("A background drag must stay inside one exact window; no drag was sent.");
      }
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, start);
      await inspectOwnerDesktop(name, identity);
      const outcome = await driverInputAction(runtime.driver, "drag", {
        pid: start.target.pid, window_id: Number(start.target.windowId),
        from_x: start.localPoint.x, from_y: start.localPoint.y,
        to_x: end.localPoint.x, to_y: end.localPoint.y,
        duration_ms: options.durationMs ?? 500, steps: 10, session: session.session,
      }, "Cua Driver could not drag on the owner's current desktop.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, end);
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function pressKeyDesktop(name: string, key: string, identity: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        return driverInputAction(runtime.driver, "press_key", {
          pid: selected.pid, window_id: Number(selected.windowId), key, session: session.session,
        }, "Cua Driver could not press the requested key in the selected window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function hotkeyDesktop(name: string, keys: string[], identity: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        return driverInputAction(runtime.driver, "hotkey", {
          pid: selected.pid, window_id: Number(selected.windowId), keys, session: session.session,
        }, "Cua Driver could not send the key combination to the selected window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function listWindowOptions(ownedPid?: number, onScreenOnly = ownedPid === undefined): Promise<CuaStageWindowOption[]> {
    if (ownedPid !== undefined && (!Number.isSafeInteger(ownedPid) || ownedPid < 1)) throw new Error("Invalid owned application process.");
    try {
      return await listWindowOptionsOnce(ownedPid, onScreenOnly);
    } catch (error) {
      // This is the window-enumeration call launch()'s up-to-60-attempt polling
      // loop depends on. Before this fix, a connection that died mid-session kept
      // being reused here forever -- every launch failed until some unrelated
      // read_structure call happened to reset the cache first. Read-only, so a
      // retry here carries no duplicate-action risk, only on a genuine
      // connection failure, never on an unrelated one.
      if (!isConnectionError(error)) throw error;
      await resetDeadRuntime();
      return listWindowOptionsOnce(ownedPid, onScreenOnly);
    }
  }

  async function listWindowOptionsOnce(ownedPid: number | undefined, onScreenOnly: boolean): Promise<CuaStageWindowOption[]> {
    const runtime = await agentRuntime();
    const { driver } = runtime;
    // Window enumeration is read-only and uses the already-connected driver
    // transport. Starting and ending a named session for every launch poll
    // repeatedly cold-started Cua and made ordinary app discovery needlessly
    // slow. Agent cursor sessions remain explicit and persistent in
    // ensureAgentSession; this path must not create a throwaway one.
    const result = await driver.listWindows({ onScreenOnly });
    return result.windows
      .filter((window) => Number.isSafeInteger(window.pid) && (window.pid ?? 0) > 0 && window.pid !== process.pid
        && typeof window.windowId === "bigint" && window.windowId > BigInt(0)
        && (ownedPid === undefined ? (!onScreenOnly || window.isOnScreen === true) : window.pid === ownedPid)
        && (!onScreenOnly || window.minimized !== true)
        && Number.isFinite(window.bounds.width) && Number.isFinite(window.bounds.height)
        && (window.minimized === true && !onScreenOnly || window.bounds.width >= 80 && window.bounds.height >= 60)
        && typeof window.title === "string" && window.title.trim().length > 0
        && !/m9r[- ]overlay/i.test(`${window.appName} ${window.title}`)
        && !/^m9r(?: overlay)?$/i.test(window.title.trim()))
      .slice(0, MAX_WINDOW_OPTIONS)
      .map((window) => ({
        pid: window.pid!,
        windowId: window.windowId.toString(),
        appName: window.appName.slice(0, 80),
        title: window.title.replace(/[\r\n\t]+/g, " ").slice(0, 160),
        width: Math.trunc(window.bounds.width),
        height: Math.trunc(window.bounds.height),
      }));
  }

  async function listVisibleWindows(options: { onScreenOnly?: boolean } = {}): Promise<CuaStageWindowOption[]> {
    // The registry read supplies the same Windows/interactive-owner and
    // agent-context guard as other stage operations without requiring an
    // existing stage name. This is used only to adopt a newly-created window
    // from the user's personal browser process.
    manager.list();
    return listWindowOptions(undefined, options.onScreenOnly ?? true);
  }

  async function listWindows(name: string, ownedPid?: number): Promise<CuaStageWindowOption[]> {
    if (ownedPid !== undefined && (!Number.isSafeInteger(ownedPid) || ownedPid < 1)) throw new Error("Invalid owned application process.");
    // Inspecting the stage enforces the same interactive-owner and agent-context guard as stage changes.
    await manager.inspectStage(name);
    return listWindowOptions(ownedPid);
  }

  async function click(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity, options: CuaDesktopClickOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow, elementAtPoint }) => {
      const before = await captureWindow();
      if (!validPoint(x, y, before)) throw new Error("Click coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, before);
      if (cursorIdentity) forgetDesktopInputTarget(name, cursorIdentity);
      if (!options.confirmFocusForeground && options.button === undefined && options.count === undefined
        && await nativeControl(name, "click", { x, y, imageWidth: before.width, imageHeight: before.height })) return { capture: stageCapture(await captureWindow(), now),
        outcome: { status: "unverifiable", summary: "Routed the click to the exact native child control; application effect requires verification." } };
      await clearNativeInputSelection(name);
      const element = sdk.ClickPosition.Element ? await elementAtPoint(x, y, "click") : undefined;
      const token = element?.elementToken;
      const outcome = await driverInputAction(driver, "click", {
        pid,
        window_id: Number(windowId),
        ...(token && sdk.ClickPosition.Element ? { element_token: token } : { x, y }),
        ...(options.button ? { button: options.button === "right" ? "right" : options.button === "middle" ? "middle" : "left" } : {}),
        ...(options.count ? { count: options.count } : {}),
        session,
      }, "Cua Driver could not click the registered stage window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      if (cursorIdentity) {
        if (outcome.status === "confirmed" && element?.actions?.includes("set_value") && /^(?:Document|Edit|TextField|TextArea|ComboBox)$/i.test(element.role ?? "")) {
          const point = cursorScreenPoint(x, y, before);
          rememberDesktopInputTarget(name, cursorIdentity, { pid, windowId, field: { ...point, label: element.label, role: element.role } });
        }
      }
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  // A remembered field that belongs to a window other than the one this call is
  // actually targeting (e.g. the app was relaunched since the field was
  // remembered) is not a reason to block the action -- it just means there is
  // nothing to reposition the cursor to, same as if nothing had been selected.
  function fieldStillInThisWindow(selected: DesktopInputTarget | undefined, pid: number, windowId: bigint): DesktopInputTarget | undefined {
    return selected?.field && selected.pid === pid && selected.windowId === windowId ? selected : undefined;
  }

  async function pressKey(name: string, key: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      const selected = cursorIdentity
        ? fieldStillInThisWindow(desktopInputTargets.get(desktopInputKey(name, cursorIdentity)), pid, windowId)
        : undefined;
      if (cursorIdentity && selected?.field) {
        const point = desktopPointInWindow(selected.field, before);
        await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, before);
      }
      const outcome = await driverInputAction(driver, "press_key", {
        pid, window_id: Number(windowId), key, session,
      }, "Cua Driver could not press the requested key in the registered stage window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function hotkey(name: string, keys: string[], cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof | CuaStageWindowClosedProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      const selected = cursorIdentity
        ? fieldStillInThisWindow(desktopInputTargets.get(desktopInputKey(name, cursorIdentity)), pid, windowId)
        : undefined;
      if (cursorIdentity && selected?.field) {
        const point = desktopPointInWindow(selected.field, before);
        await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, before);
      }
      const outcome = await driverInputAction(driver, "hotkey", {
        pid, window_id: Number(windowId), keys, session,
      }, "Cua Driver could not send the requested key combination to the registered stage window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      try { return { capture: stageCapture(await captureWindow(), now), outcome }; }
      catch (captureFailure) {
        let state: string | undefined;
        try { state = await manager.windowStatus(pid, windowId.toString()); } catch { /* lack of lifecycle proof remains uncertain */ }
        if (state !== "closed") throw captureFailure;
        if (cursorIdentity) forgetDesktopInputTarget(name, cursorIdentity);
        const observedAt = now().toISOString();
        return { postcondition: { kind: "window-closed" as const, verified: true as const, observedAt,
          evidenceRef: `window-closed-${createHash("sha256").update(`${pid}:${windowId}:${observedAt}`).digest("hex").slice(0, 24)}` },
          outcome: { status: "confirmed" as const, summary: "The exact target window is confirmed closed after keyboard input." } };
      }
    }, cursorIdentity);
  }

  async function typeText(name: string, text: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageTextOptions = {}): Promise<CuaStageActionProof> {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    const delayMs = normalizeTypeDelayMs(options.delayMs);
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow, elementAtPoint }) => {
      const before = await captureWindow();
      // "replace" mode never actually replaced anything -- it discarded the
      // remembered field and fell through to the generic append path
      // (`type_text`), even though the schema requires an exact point for it and
      // documents it as a real field replacement. This is the real mechanism:
      // look up the actual field at that point and replace its value directly,
      // the same way replaceElement() does, instead of silently appending text
      // wherever focus happens to be.
      if (options.mode === "replace") {
        if (options.x === undefined || options.y === undefined) throw new Error("Replace mode requires an exact field point; no text was sent.");
        const element = await elementAtPoint(options.x, options.y, "set_value");
        if (!element?.elementToken || element.enabled === false || !element.actions?.includes("set_value")) {
          throw new DesktopInputNotDispatchedError("No replaceable text field was found at the given point; no text was sent.");
        }
        if ((options.expectedRole !== undefined && element.role !== options.expectedRole)
          || (options.expectedLabel !== undefined && element.label !== options.expectedLabel)) {
          throw new Error("The field at the given point could not be confirmed as the same one you observed; no text was sent.");
        }
        if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, options.x, options.y, before);
        const outcome = actionOutcome(await driver.callTool("set_value", JSON.stringify({
          pid, window_id: Number(windowId), element_token: element.elementToken, value: text, session,
        }), options.signal ? { signal: options.signal } : undefined), "Cua Driver could not replace the field's value.");
        return { capture: stageCapture(await captureWindow(), now), outcome };
      }
      // A remembered field from a window that is no longer this one (e.g. the
      // app was relaunched since it was remembered) is not a reason to refuse
      // typing in the current, perfectly valid window -- it just means there is
      // no remembered field to use; fall through to the generic focus-based path.
      const selected = cursorIdentity
        ? fieldStillInThisWindow(desktopInputTargets.get(desktopInputKey(name, cursorIdentity)), pid, windowId)
        : undefined;
      if (cursorIdentity && selected?.field) {
        const point = desktopPointInWindow(selected.field, before);
        await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, before);
      }
      const outcome = await deliverTextToExactWindow({ runtime: { sdk, driver }, session, pid, windowId,
        text, selected, nativeInput: () => nativeControl(name, "type", undefined, { text }),
        delayMs, preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function scroll(name: string, x: number, y: number, direction: "up" | "down", cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      if (!validPoint(x, y, before)) throw new Error("Scroll coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, before);
      if (!options.confirmFocusForeground && await nativeControl(name, "scroll", { x, y, imageWidth: before.width, imageHeight: before.height }, { direction })) return { capture: stageCapture(await captureWindow(), now),
        outcome: { status: "unverifiable", summary: "Posted wheel input to the exact native child control; application effect requires verification." } };
      const outcome = await driverInputAction(driver, "scroll", {
        pid, window_id: Number(windowId), x, y,
        direction, by: "line", amount: 3, session,
      }, "Cua Driver could not scroll the registered stage window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function drag(name: string, fromX: number, fromY: number, toX: number, toY: number, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageDragOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      if (!validPoint(fromX, fromY, before) || !validPoint(toX, toY, before)) {
        throw new Error("Both drag points must fall inside the current stage window snapshot.");
      }
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, fromX, fromY, before);
      const outcome = await driverInputAction(driver, "drag", {
        pid, window_id: Number(windowId), from_x: fromX, from_y: fromY, to_x: toX, to_y: toY,
        duration_ms: options.durationMs ?? 500, steps: 10, session,
      }, "Cua Driver could not drag in the registered stage window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  function elementCursorPoint(element: CuaWindowElement, frame: CuaStageWindowFrame): { x: number; y: number } | undefined {
    const bounds = frame.windowBounds;
    const rect = element.frame;
    if (!bounds || !rect || bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0) return undefined;
    const x = Math.floor((rect.x + rect.w / 2 - bounds.x) * frame.width / bounds.width);
    const y = Math.floor((rect.y + rect.h / 2 - bounds.y) * frame.height / bounds.height);
    return validPoint(x, y, frame) ? { x, y } : undefined;
  }

  async function clickElement(name: string, ref: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow, elementByToken }) => {
      const selected = await elementByToken(ref, { role: options.expectedRole, label: options.expectedLabel });
      if (!selected?.element.elementToken || selected.element.enabled === false) {
        throw new DesktopInputNotDispatchedError(options.expectedRole !== undefined || options.expectedLabel !== undefined
          ? "The accessibility element could not be confirmed as the same control you observed (role/label did not match); no click was sent."
          : "The accessibility element is stale or disabled; no click was sent.");
      }
      // Confirmed live against the real driver: a collapsed menu item/tree node/combo
      // box commonly advertises only "expand" (never "invoke"/"click"/"press"), and a
      // selectable row commonly advertises only "select"/"toggle" -- restricting this
      // to click/invoke/press alone rejected those real, legitimate click targets.
      if (selected.element.actions && !selected.element.actions.some((action) => /^(?:click|invoke|press|expand|toggle|select)$/i.test(action))) throw new DesktopInputNotDispatchedError("The accessibility element does not advertise a click action; no click was sent.");
      const point = elementCursorPoint(selected.element, selected.frame);
      if (cursorIdentity && point) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, selected.frame);
      if (cursorIdentity) forgetDesktopInputTarget(name, cursorIdentity);
      await clearNativeInputSelection(name);
      const outcome = await driverInputAction(driver, "click", {
        pid, window_id: Number(windowId), element_token: selected.element.elementToken, button: "left", count: 1, session,
      }, "Cua Driver could not click the selected accessibility element.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      if (cursorIdentity && point && outcome.status === "confirmed" && selected.element.actions?.includes("set_value")
        && /^(?:Document|Edit|TextField|TextArea|ComboBox)$/i.test(selected.element.role ?? "")) {
        rememberDesktopInputTarget(name, cursorIdentity, { pid, windowId,
          field: { ...cursorScreenPoint(point.x, point.y, selected.frame), label: selected.element.label, role: selected.element.role } });
      }
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function replaceElement(name: string, ref: string, text: string, cursorIdentity?: CuaAgentCursorIdentity,
    options: CuaStageInputOptions & { expectedRole?: string; expectedLabel?: string } = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow, elementByToken }) => {
      options.signal?.throwIfAborted();
      const selected = await elementByToken(ref, { role: options.expectedRole, label: options.expectedLabel });
      if (!selected?.element.elementToken || selected.element.enabled === false || !selected.element.actions?.includes("set_value")) {
        throw new DesktopInputNotDispatchedError("The accessibility element is stale, disabled, could not be confirmed as the same control, or does not support value replacement; no text was sent.");
      }
      const point = elementCursorPoint(selected.element, selected.frame);
      if (cursorIdentity && point) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, selected.frame);
      const outcome = actionOutcome(await driver.callTool("set_value", JSON.stringify({
        pid, window_id: Number(windowId), element_token: selected.element.elementToken, value: text, session,
      }), options.signal ? { signal: options.signal } : undefined), "Cua Driver could not replace the selected accessibility value.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  function scrollDeltaAmount(deltaX: number, deltaY: number, unit: "pixel" | "line" | "page"): { direction: "up" | "down" | "left" | "right"; amount: number; by: "line" | "page" } {
    if (unit === "pixel") throw new Error("The installed Cua Driver exposes line/page scrolling, not pixel scrolling, for native windows; no scroll was sent.");
    const delta = deltaX !== 0 ? deltaX : deltaY;
    return { direction: deltaX !== 0 ? (deltaX < 0 ? "left" : "right") : (delta < 0 ? "up" : "down"), amount: Math.abs(delta), by: unit };
  }

  async function scrollDelta(name: string, x: number, y: number, deltaX: number, deltaY: number, unit: "pixel" | "line" | "page", cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}): Promise<CuaStageActionProof> {
    const scroll = scrollDeltaAmount(deltaX, deltaY, unit);
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      if (!validPoint(x, y, before)) throw new Error("Scroll coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, before);
      const outcome = await driverInputAction(driver, "scroll", {
        pid, window_id: Number(windowId), x, y, direction: scroll.direction, by: scroll.by, amount: scroll.amount, session,
      }, "Cua Driver could not scroll the registered stage window.", { preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function windowFrame(name: string, x: number, y: number, width: number, height: number,
    cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, session, pid, windowId, capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      const outcome = actionOutcome(await driver.setWindowFrame({ pid, windowId, x, y, width, height, session },
        options.signal ? { signal: options.signal } : undefined), "Cua Driver could not set the selected window frame.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function focusWindow(name: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    if (options.deliveryMode === "background") {
      throw new DesktopInputNotDispatchedError("A background stage cannot bring a window to the owner's foreground; no input was sent.");
    }
    return withRegisteredWindow(name, async ({ driver, session, pid, windowId, capture: captureWindow }) =>
      foregroundLease.run(name, options.signal, async () => {
        const outcome = actionOutcome(await driver.callTool("bring_to_front", JSON.stringify({ pid, window_id: Number(windowId), session }),
          options.signal ? { signal: options.signal } : undefined), "Cua Driver could not bring the selected window to the foreground.");
        return { capture: stageCapture(await captureWindow(), now), outcome };
      }), cursorIdentity);
  }

  async function invokeMenu(name: string, path: string[], cursorIdentity?: CuaAgentCursorIdentity,
    options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, session, pid, windowId, capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      const outcome = actionOutcome(await driver.invokeMenu({ pid, windowId, path, session },
        options.signal ? { signal: options.signal } : undefined), "Cua Driver could not invoke the selected application menu.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  function clipboardValue(result: ToolResult): unknown {
    const encoded = result.structuredJson ?? result.rawJson;
    if (!encoded) return undefined;
    try { return JSON.parse(encoded) as unknown; } catch { return undefined; }
  }

  async function clipboardRead(name: string, includeText: boolean, cursorIdentity?: CuaAgentCursorIdentity,
    options: CuaStageInputOptions = {}) {
    return withRegisteredWindow(name, async ({ driver, session, capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      const result = await driver.clipboardRead({ includeText, session }, options.signal ? { signal: options.signal } : undefined);
      const outcome = actionOutcome(result, "Cua Driver could not read the shared clipboard.");
      return { capture: stageCapture(await captureWindow(), now), outcome, clipboard: clipboardValue(result) };
    }, cursorIdentity);
  }

  async function clipboardWrite(name: string, text: string, cursorIdentity?: CuaAgentCursorIdentity,
    payload?: { imagePath?: string; filePath?: string }, options: CuaStageInputOptions = {}) {
    return withRegisteredWindow(name, async ({ driver, session, capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      const result = await driver.clipboardWrite({ ...(payload?.imagePath ? { imagePath: payload.imagePath }
        : payload?.filePath ? { filePath: payload.filePath } : { text }), session },
      options.signal ? { signal: options.signal } : undefined);
      const outcome = actionOutcome(result, "Cua Driver could not write the shared clipboard.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function windowState(name: string, state: "minimized" | "maximized" | "restored") {
    await manager.setWindowState(name, state);
    return { outcome: { status: "confirmed" as const, summary: `Exact window state verified: ${state}.` },
      postcondition: { kind: "window-state", state, verified: true } };
  }

  async function closeAgentCursor(cursorIdentity: CuaAgentCursorIdentity): Promise<void> {
    const details = agentCursorDetails(cursorIdentity);
    if (!agentRuntimePromise || !agentSessions.has(details.key)) return;
    const runtime = await agentRuntimePromise;
    try {
      resultError(await runtime.driver.setAgentCursorEnabled({ session: details.session, enabled: false }), "Cua Driver could not hide the revoked agent cursor.");
    } finally {
      try { await runtime.driver.endSession({ session: details.session }); }
      finally {
        agentSessions.delete(details.key);
        cursorStartSlots.delete(details.key);
        forgetAgentDesktopInputTargets(cursorIdentity);
      }
    }
  }

  async function shutdown(): Promise<void> {
    const runtimePromise = agentRuntimePromise;
    agentRuntimePromise = undefined;
    const sessions = [...agentSessions.values()];
    agentSessions.clear();
    cursorStartSlots.clear();
    desktopInputTargets.clear();
    if (!runtimePromise) return;
    try {
      const runtime = await runtimePromise;
      for (const session of sessions) {
        try { await runtime.driver.endSession({ session: session.session }); } catch { /* continue closing remaining sessions */ }
      }
      await disposeRuntime(runtime);
    } catch { /* the runtime never initialized */ }
  }

  return { capture, readStructure, readDesktopStructure, describeTarget, describeElementTarget, showAgentCursor, moveCursor, listWindows, listVisibleWindows, click, typeText, scroll, scrollDelta, drag,
    clickElement, replaceElement, windowFrame, windowState, focusWindow, invokeMenu, clipboardRead, clipboardWrite,
    captureDesktop, describeDesktopTarget, moveDesktopCursor, clickDesktop, typeTextDesktop, scrollDesktop, scrollDeltaDesktop, dragDesktop,
    pressKey, hotkey, pressKeyDesktop, hotkeyDesktop, closeAgentCursor, shutdown };
}

async function readStageTextFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > 8 * 1024) throw new Error("The stage text request exceeded its safe input size.");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The stage text request was not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).some((key) => key !== "text") || typeof (parsed as { text?: unknown }).text !== "string") {
    throw new Error("The stage text request must contain only a text string.");
  }
  return (parsed as { text: string }).text;
}

export async function runCuaStageDriverCli(args: string[], deps: CuaStageDriverDependencies = {}): Promise<number> {
  const json = args.includes("--json");
  const stdinJson = args.includes("--stdin-json");
  const commandArgs = args.filter((arg) => arg !== "--json" && arg !== "--stdin-json");
  const [action, name, ...values] = commandArgs;
  const parseCoordinate = (value: string | undefined): number => {
    if (!value || !/^\d{1,5}$/.test(value)) throw new Error("Coordinates must be whole screenshot pixels from 0 to 99999.");
    return Number(value);
  };
  try {
    if (!json) throw new Error("Cua stage actions require --json so binary image data and coordinates stay structured.");
    const driver = createCuaStageDriver(deps);
    if (action === "capture" && commandArgs.length === 2) {
      process.stdout.write(`${JSON.stringify({ ok: true, capture: await driver.capture(name!) })}\n`);
      return 0;
    }
    if (action === "windows" && commandArgs.length === 2) {
      process.stdout.write(`${JSON.stringify({ ok: true, windows: await driver.listWindows(name!) })}\n`);
      return 0;
    }
    if (action === "cursor" && values.length === 2) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...await driver.moveCursor(name!, parseCoordinate(values[0]), parseCoordinate(values[1])) })}\n`);
      return 0;
    }
    if (action === "click" && values.length === 2) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...await driver.click(name!, parseCoordinate(values[0]), parseCoordinate(values[1])) })}\n`);
      return 0;
    }
    if (action === "type" && ((values.length === 1 && !stdinJson) || (values.length === 0 && stdinJson))) {
      const text = stdinJson ? await readStageTextFromStdin() : values[0]!;
      process.stdout.write(`${JSON.stringify({ ok: true, ...await driver.typeText(name!, text) })}\n`);
      return 0;
    }
    if (action === "scroll" && values.length === 3 && (values[2] === "up" || values[2] === "down")) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...await driver.scroll(name!, parseCoordinate(values[0]), parseCoordinate(values[1]), values[2])})}\n`);
      return 0;
    }
    if (action === "drag" && values.length === 4) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...await driver.drag(name!, parseCoordinate(values[0]), parseCoordinate(values[1]), parseCoordinate(values[2]), parseCoordinate(values[3]))})}\n`);
      return 0;
    }
    throw new Error("Usage: m9r web stage windows <name> --json | capture <name> --json | cursor|click <name> <x> <y> --json | type <name> <text> --json | scroll <name> <x> <y> up|down --json | drag <name> <from-x> <from-y> <to-x> <to-y> --json");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cua stage action failed.";
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message.slice(0, 500) })}\n`);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
}
