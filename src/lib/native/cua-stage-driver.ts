import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { defaultStoreRoot } from "./local-store";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ActionResult, ActionTarget, ClickPosition as CuaClickPosition, CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import { DesktopInputNotDispatchedError, DesktopInputOutcomeUnknownError } from "./desktop-input-errors";
import { StageCaptureRefreshError } from "./stage-errors";
import { CUA_DRIVER_VERSION, startCuaDriverHost, validateCuaDriverPackageVersion, type CuaDriverHostConnection } from "./cua-driver-host";
import { createWindowsDesktopStageManager, type WindowsStageDependencies, type NativePointControl, type NativeWindowStructureElement, type WindowsSystemControlRequest } from "./windows-desktop-stage";
import type { VerifiedIdentity } from "./identity-core";
import { createForegroundInputLease, ForegroundInputLeaseError, type ForegroundInputLease } from "./foreground-input-lease";
import { classifySaveAsConflict, findDialogButton, findSaveAsButton, findSaveAsNameField, resolveSaveAsTarget } from "./stage-save-as";
import { nativeValueControlRegion, sameNativeControlEpoch } from "./native-control-region";
import { createAgentCursorOverlayHost, type AgentCursorOverlayHost } from "./agent-cursor-overlay-host";

const CUA_PACKAGE = "@trycua/cua-driver";
const PUBLIC_CURSOR_LABEL_MAX_LENGTH = 28;
const MAX_IMAGE_DIMENSION = 2048;
// Keep the base64 JSON response comfortably below the native pill's 4 MiB stdout cap.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_ACTION_LENGTH = 5_000;
// Keep typing visibly human while avoiding the sluggish 30ms default that made
// longer composer edits feel artificially slow. Callers may still choose a
// bounded custom delay through the existing action contract.
const DEFAULT_TYPE_DELAY_MS = 15;
const MAX_TYPE_DELAY_MS = 200;
const MAX_DESKTOP_STRUCTURE_ELEMENTS = 4096;
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
  ScrollBy: { Line: number; Page?: number };
  VisualRegionKind: { Text: number; Icon: number };
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
 * Validate and normalize the optional Cua Driver adapter when a caller
 * explicitly loads it. Production stage actions and M9R cursor presentation
 * use the native host and do not load or depend on this adapter.
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
  escalation?: { target?: unknown; reason?: unknown };
}

export interface CuaStageWindowOption {
  pid: number;
  windowId: string;
  appName: string;
  title: string;
  width: number;
  height: number;
  isOnScreen?: boolean;
  minimized?: boolean;
  zIndex?: string;
}

export interface CuaStageActionOutcome {
  status: "confirmed" | "partial" | "unverifiable" | "suspected-noop" | "unverified";
  route?: number;
  summary?: string;
  /** Bounded native receipt for background WM_CHAR text delivery; never includes HWND/PID. */
  dispatch?: {
    channel: "wm-char";
    state: "dispatched" | "acknowledged";
    route?: "wm-char-post-message";
    targetMatches?: boolean;
  };
  /** Exact outer-window bounds observed after a native geometry operation. */
  windowFrame?: {
    requested: { x: number; y: number; width: number; height: number };
    actual: { x: number; y: number; width: number; height: number };
    verified: boolean;
  };
  /** The target window was explicitly brought to the OS foreground before delivery. */
  foregroundConfirmed?: true;
}

export interface CuaStageActionProof {
  capture: CuaStageCapture;
  /** Popup-local fallback pixels must never be mistaken for the parent app observation. */
  captureScope?: "app" | "popup";
  outcome: CuaStageActionOutcome;
  /** Exact-path persistence evidence from the generic Windows Save As workflow. */
  saveAs?: { path: string; directory: string; fileName: string; persisted: boolean; sizeBytes?: string; directoryCreated?: boolean };
}

function sameWindowFrame(
  requested: { x: number; y: number; width: number; height: number },
  actual: { x: number; y: number; width: number; height: number },
): boolean {
  return requested.x === actual.x && requested.y === actual.y
    && requested.width === actual.width && requested.height === actual.height;
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
  /** Virtual-screen origin for a native full-desktop capture. */
  origin?: { x: number; y: number };
  /** Bounded accessible targets from this same window snapshot, in screenshot pixels. */
  controls?: CuaStageTargetDescription[];
  /** True when `controls` was cut off at its element cap; the window has more controls than were returned. */
  controlsTruncated?: true;
  /**
   * The same-call accessibility tree, when an action's own post-dispatch
   * capture already paired one (see captureWithStructure below). Lets the MCP
   * observation layer skip a second, separate read_structure round trip for
   * the same post-dispatch moment -- the duplicate read measured in T276.
   */
  structure?: Omit<CuaStageStructure, "fallbackCapture">;
}

/**
 * Structure-first observation returned by the exact-window Cua route.
 * Element refs are driver-owned opaque tokens; the provider-neutral computer
 * use layer remaps them before exposing an observation to an agent.
 */
export interface CuaStageStructure {
  status: "complete" | "partial" | "unavailable";
  /** Current viewport was observed; a complete UIA walk does not prove there is no offscreen content. */
  coverage: CuaContentCoverage;
  capturedAt: string;
  /** Absolute outer-window bounds for window placement; element rects remain screenshot-local. */
  screenRect?: CuaStageWindowBounds;
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
    focused?: boolean;
    actions?: string[];
    canReplaceValue?: boolean;
    canReadValue?: boolean;
    scroll?: NativeWindowStructureElement["scroll"];
    rect?: { x: number; y: number; width: number; height: number };
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
  /** Screenshot-local bounds used for coordinate actions. */
  rect: { x: number; y: number; width: number; height: number };
  /** Absolute virtual-screen bounds for window placement, including negative monitor origins. */
  screenRect: { x: number; y: number; width: number; height: number };
  frontmost?: boolean;
  minimized?: boolean;
  status: "complete" | "partial" | "unavailable";
  coverage: CuaContentCoverage;
  elements: CuaDesktopStructureElement[];
}

/** Privacy-safe signal about visible and potentially scrollable content. */
export interface CuaContentCoverage {
  scope: "window" | "desktop";
  visibleViewport: "observed";
  scrollability: "indicated" | "unknown";
  offscreenContent: "possible" | "unknown";
}

export interface CuaDesktopStructure {
  scope: "desktop";
  status: "complete" | "partial" | "unavailable";
  coverage: CuaContentCoverage;
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
  enabled: boolean;
  visible: boolean;
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
  capturedAt?: string;
  stageName?: string;
  identityKey?: string;
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
  /** Internal stage policy: background work may request one owner-approved foreground fallback. */
  deliveryMode?: "background" | "owner-preview";
  /** Only used after an exact semantic route is unavailable; native owner policy still authorizes dispatch. */
  allowForegroundEscalation?: boolean;
  /** Internal region-fence contract: this action may not fall back to shared caret/OS input. */
  semanticOnly?: boolean;
};
export type CuaDesktopClickOptions = CuaStageInputOptions & { button?: "left" | "middle" | "right"; count?: 1 | 2 };
export type CuaStageTextOptions = CuaStageInputOptions & { mode?: "insert" | "replace"; x?: number; y?: number; expectedRole?: string; expectedLabel?: string; delayMs?: number };
export type CuaStageScrollOptions = CuaStageInputOptions & {
  /** Wheel notches to scroll; omitted defaults to 3 (one typical mouse-wheel click). */
  amount?: number;
};
export type CuaStageDragOptions = CuaStageInputOptions & { durationMs?: number };

export interface CuaStageDriverDependencies {
  stage?: WindowsStageDependencies;
  /**
   * The broker-owned desktop-stage manager.  Production task stages pass the
   * manager they already created so the driver shares one native helper and
   * one stage/IPC lifecycle instead of spawning a second host for the same
   * broker process.  Tests and the standalone CLI may omit it.
   */
  manager?: ReturnType<typeof createWindowsDesktopStageManager>;
  /** Deprecated test compatibility seams; the M9R cursor path intentionally never invokes CUA. */
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
  /** Optional M9R-owned marker renderer; absence reports presentation unavailable without blocking native input. */
  cursorOverlayHost?: AgentCursorOverlayHost;
}
const CURSOR_PRESENTATION_LEAD_BUDGET_MS = 250;

type CursorPresentationOutcome = {
  status: "completed" | "timed-out" | "superseded" | "failed";
  error?: unknown;
};

type PendingCursorPresentation = {
  generation: number;
  run: () => Promise<unknown>;
  resolve: (outcome: CursorPresentationOutcome) => void;
};

type CursorPresentationWork = {
  generation: number;
  running: boolean;
  pending?: PendingCursorPresentation;
};

export interface CuaStageTimingEvent {
  phase: "sdk-load" | "host-connect" | "runtime-acquire" | "session-start" | "cursor-motion" | "cursor-position" | "cursor-visible" | "cursor-overlay"
    | "foreground-lease" | "background-dispatch" | "window-capture" | "accessibility-read" | "target-resolution"
    | "input-dispatch" | "post-action-observation";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  stageName?: string;
  cached?: boolean;
  /** Bounded, privacy-safe diagnostic detail; never contains task text or credentials. */
  detail?: string;
}

interface CachedDesktopCapture extends CuaDesktopTargetSnapshot {
  dataUrl: string;
  capturedAtMs: number;
  capturedAt: string;
  stageName: string;
  identityKey: string;
  origin?: { x: number; y: number };
}

interface DesktopInputTarget {
  pid: number;
  windowId: bigint;
  /** An exact accessibility field does not depend on system keyboard focus. */
  field?: { x: number; y: number; label?: string; role?: string };
}

type CuaWindowInfo = Awaited<ReturnType<CuaDriverLike["listWindows"]>>["windows"][number];
type CuaWindowElement = NonNullable<Awaited<ReturnType<CuaDriverLike["getWindowState"]>>["elements"]>[number];

function contentCoverage(scope: CuaContentCoverage["scope"], elements?: readonly { role?: string; actions?: readonly string[] }[]): CuaContentCoverage {
  const scrollabilityIndicated = elements?.some((element) => {
    const role = typeof element.role === "string" ? element.role.toLowerCase().replace(/[\s_-]+/g, "") : "";
    const roleIndicatesScrolling = /^(?:scrollbar|scrollarea|scrollview|scrollcontainer)$/.test(role);
    const actionsIndicateScrolling = element.actions?.some((action) => /^(?:scroll|scrollby|scrollto|scrollintoview)$/i.test(action)) === true;
    return roleIndicatesScrolling || actionsIndicateScrolling;
  }) === true;
  return {
    scope,
    visibleViewport: "observed",
    scrollability: scrollabilityIndicated ? "indicated" : "unknown",
    offscreenContent: scrollabilityIndicated ? "possible" : "unknown",
  };
}

function normalizeAccessibleLabel(value: string | undefined, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function aggregateDesktopCoverage(windows: readonly CuaDesktopStructureWindow[]): CuaContentCoverage {
  const indicated = windows.some((window) => window.coverage.scrollability === "indicated");
  return {
    scope: "desktop",
    visibleViewport: "observed",
    scrollability: indicated ? "indicated" : "unknown",
    offscreenContent: indicated ? "possible" : "unknown",
  };
}

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
  windowCaptureSize?: { width: number; height: number };
  shellControl?: NativePointControl;
  nativeKeyboardWindow?: boolean;
  element?: CuaWindowElement;
  nativeElement?: NativeWindowStructureElement;
}

function bundledSdkUrl(): string | null {
  const packageRoot = join(dirname(process.execPath), "cua-driver-runtime", "node_modules", "@trycua", "cua-driver");
  const manifestPath = join(packageRoot, "package.json");
  const entryPath = join(packageRoot, "dist", "index.js");
  if (!existsSync(manifestPath) || !existsSync(entryPath)) return null;
  let version: unknown;
  try { version = JSON.parse(readFileSync(manifestPath, "utf8")).version; }
  catch { throw new Error("The bundled Cua Driver package metadata is unreadable. Reinstall the M9R Windows runtime."); }
  validateCuaDriverPackageVersion(version, "Bundled Cua Driver package");
  return pathToFileURL(entryPath).href;
}

function installedCuaDriverPackageVersion(): unknown {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packageRoot = join(directory, "node_modules", "@trycua", "cua-driver");
    const manifestPath = join(packageRoot, "package.json");
    if (existsSync(manifestPath)) {
      let metadata: unknown;
      try { metadata = JSON.parse(readFileSync(manifestPath, "utf8")); }
      catch (error) { throw new Error(`Installed Cua Driver package metadata is unreadable at ${manifestPath}.`, { cause: error }); }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
        || (metadata as { name?: unknown }).name !== CUA_PACKAGE) {
        throw new Error(`Installed Cua Driver package metadata is invalid at ${manifestPath}.`);
      }
      return (metadata as { version?: unknown }).version;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function loadCuaSdk(): Promise<CuaSdk> {
  let packageError: unknown;
  try {
    const packageVersion = installedCuaDriverPackageVersion();
    validateCuaDriverPackageVersion(packageVersion, "Installed Cua Driver package");
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
 * The native overlay renders this named agent label. Provider session IDs and
 * derived ownership tags stay in the broker's private registry only.
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
    throw new Error("The verified agent identity cannot be used for a cursor overlay.");
  }
  const digest = createHash("sha256").update(`${handle}\0${identity.sessionId}`).digest("hex");
  const sessionTag = digest.slice(0, 8);
  return {
    key: `${handle}\0${identity.sessionId}`,
    handle,
    sessionId: identity.sessionId,
    // Cua renders this field beside the cursor. The broker allocates a public
    // ordinal when two identities share this name; credentials stay private.
    session: publicCursorLabel(handle).slice(0, PUBLIC_CURSOR_LABEL_MAX_LENGTH),
    sessionTag,
  };
}

// Hand-picked, maximally-separated hues (one per the 16-identity cap below) so two
// concurrently active agent cursors are never visually indistinguishable the way a
// hash-derived hue occasionally produced (two near-identical oranges, for example).
const CURSOR_COLOR_PALETTE: readonly (readonly [number, number, number])[] = [
  [230, 60, 60], [60, 170, 230], [60, 200, 110], [230, 170, 40],
  [170, 80, 230], [230, 100, 170], [40, 200, 200], [230, 130, 40],
  [120, 200, 60], [100, 100, 230], [230, 60, 140], [60, 230, 170],
  [200, 200, 60], [150, 60, 60], [60, 150, 150], [150, 150, 230],
];

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

/**
 * The ghost-cursor overlay is presentation, never a real OS mutation -- but
 * `resultError` previously threw a plain Error for its own background
 * refusal, which the stage layer then recorded as "uncertain" and used to
 * lock the surface, even though no dispatch to the real application window
 * was ever attempted. A window class that refuses background mouse-move
 * presentation (Chrome foremost) is therefore a clean pre-dispatch refusal,
 * not an ambiguous one.
 */
function resultErrorTyped(result: { isError: boolean; text?: string }, fallback: string): void {
  try {
    resultError(result, fallback);
  } catch (error) {
    if (backgroundInputRefused(error)) {
      throw new DesktopInputNotDispatchedError(
        `${error instanceof Error ? error.message : fallback} The agent cursor overlay could not be positioned; no real input was sent.`,
        "background-unavailable",
      );
    }
    throw error;
  }
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

const backgroundRefusalPattern = /background[_ ](?:delivery|route).*?(?:unavailable|unsupported|refus|not available)|background_unavailable|target window class.*(?:background|input)|(?:background|posted) input.*(?:ignored|dropped)/i;

/**
 * The driver's own contract: `effect: refused` means it sent no input, and
 * `escalation` names the route that can deliver instead. A refusal is therefore
 * a clean pre-dispatch outcome, never an uncertain one.
 */
function driverRefusal(result: ActionResult | ToolResult): { message: string; foreground: boolean } | undefined {
  const parts = actionParts(result);
  if (!parts || !(parts.effect === 4 || parts.effect === "refused")) return undefined;
  const code = typeof parts.error?.code === "string" ? parts.error.code : "action_refused";
  const hint = typeof parts.error?.hint === "string" ? parts.error.hint : "";
  const escalation = parts.escalation?.target;
  const foreground = escalation === 1 || escalation === "foreground" || backgroundRefusalPattern.test(`${code} ${hint}`);
  return { message: `${code}: ${hint || "the driver refused the action"}`.replace(/[\r\n\t]+/g, " ").slice(0, 300), foreground };
}

function actionOutcome(result: ActionResult | ToolResult, fallback: string): CuaStageActionOutcome {
  const refusal = driverRefusal(result);
  if (refusal) {
    throw new DesktopInputNotDispatchedError(`${refusal.message} No input was sent.`,
      refusal.foreground ? "background-unavailable" : "driver-refused");
  }
  const error = actionError(result, fallback);
  const parts = actionParts(result);
  if (error) {
    // A transport-level error without an explicit effect is a pre-dispatch
    // refusal: the compatibility adapter did not provide evidence that any
    // input reached the OS. Keep the result typed so the caller can reobserve
    // or choose a new route without fencing unrelated work.
    if (parts.effect === undefined || parts.effect === null) {
      throw new DesktopInputNotDispatchedError(`${error} No input was sent.`, "driver-refused");
    }
    throw new Error(error);
  }
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

function assertNotAbortedBeforeInput(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DesktopInputNotDispatchedError("The desktop action was canceled before target input was sent.", "dispatch-gate");
  }
}

function inputToolTextForRefusal(result: ToolResult): string {
  const parts = [result.text, result.rawJson, result.structuredJson,
    typeof (result as ToolResult & { errorCode?: unknown }).errorCode === "string"
      ? (result as ToolResult & { errorCode: string }).errorCode : undefined];
  if (result.action) parts.push(JSON.stringify(result.action));
  return parts.filter((value): value is string => typeof value === "string")
    .join(" ").replace(/[\r\n\t]+/g, " ").slice(0, 800);
}

function backgroundInputRefused(value: unknown): boolean {
  const message = value instanceof Error ? value.message
    : value && typeof value === "object" ? inputToolTextForRefusal(value as ToolResult)
      : String(value);
  return /background[_ ](?:delivery|route).*?(?:unavailable|unsupported|refus|not available)|background_unavailable|target window class.*(?:background|input)|(?:background|posted) input.*(?:ignored|dropped)/i.test(message);
}

function validPoint(x: number, y: number, capture: { width: number; height: number }): boolean {
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < capture.width && y < capture.height;
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
  return window.isOnScreen === true && window.minimized !== true
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
  if (hits.length === 0) throw new DesktopInputNotDispatchedError("No visible application window is under that desktop point; no input was sent.");
  if (hits.length === 1) return hits[0]!;
  if (hits.some((window) => typeof window.zIndex !== "bigint")) {
    throw new DesktopInputNotDispatchedError("Cua Driver did not provide window stacking order for this desktop point; no input was sent.");
  }
  const ordered = hits.slice().sort((a, b) => a.zIndex! > b.zIndex! ? -1 : a.zIndex! < b.zIndex! ? 1 : 0);
  if (ordered[0]!.zIndex === ordered[1]!.zIndex) {
    throw new DesktopInputNotDispatchedError("Cua Driver returned overlapping windows with ambiguous stacking order; no input was sent.");
  }
  return ordered[0]!;
}

function desktopPointOnScreen(x: number, y: number, capture: { width: number; height: number }, screen: DesktopScreenSize): { x: number; y: number } {
  if (!validPoint(x, y, capture)) throw new DesktopInputNotDispatchedError("Desktop coordinates must fall inside the latest capture.");
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
    throw new DesktopInputNotDispatchedError("The selected desktop point is outside the exact window snapshot; no input was sent.");
  }
  const localX = Math.floor((screenPoint.x - bounds.x + 0.5) * frame.width / bounds.width);
  const localY = Math.floor((screenPoint.y - bounds.y + 0.5) * frame.height / bounds.height);
  if (!validPoint(localX, localY, frame)) throw new DesktopInputNotDispatchedError("The desktop point could not be mapped into the exact window snapshot; no input was sent.");
  return { x: localX, y: localY };
}

function boundsAtWindowCapture(image: { width: number; height: number; originX: number; originY: number }): CuaStageWindowBounds {
  return { x: image.originX, y: image.originY, width: image.width, height: image.height };
}

function stageCapture(capture: { dataUrl: string; width: number; height: number; captureId?: string; controls?: CuaStageTargetDescription[]; capturedAt?: string;
  controlsTruncated?: true; ownedPopups?: CuaStageCapture["ownedPopups"]; popupCaptureStatus?: CuaStageCapture["popupCaptureStatus"] }, now: () => Date): CuaStageCapture {
  return { dataUrl: capture.dataUrl, width: capture.width, height: capture.height,
    ...(capture.controls ? { controls: capture.controls } : {}),
    ...(capture.controlsTruncated ? { controlsTruncated: capture.controlsTruncated } : {}),
    ...(capture.ownedPopups ? { ownedPopups: capture.ownedPopups } : {}),
    ...(capture.popupCaptureStatus ? { popupCaptureStatus: capture.popupCaptureStatus } : {}),
    capturedAt: "capturedAt" in capture && typeof capture.capturedAt === "string" ? capture.capturedAt : now().toISOString() };
}

/**
 * Build a post-dispatch capture that already carries the accessibility tree,
 * instead of the image-only capture most action handlers return. The MCP
 * observation layer (computer-use-mcp.ts's observeDesktop) only issues its own
 * separate read_structure round trip when the capture it was handed has no
 * `.structure` -- so this is what lets that second native call be skipped for
 * an action whose caller wants a structured post-action observation, instead
 * of paying for the same window's tree twice (once here, once there).
 */
async function captureWithStructure(readStructure: () => Promise<CuaStageStructure>, now: () => Date): Promise<CuaStageCapture> {
  const structure = await readStructure();
  const { fallbackCapture, ...structureWithoutImage } = structure;
  const base = fallbackCapture ?? { dataUrl: "", width: 0, height: 0 };
  return { ...stageCapture(base, now), structure: structureWithoutImage };
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
  return hit ? { label: normalizeAccessibleLabel(hit.label) ?? "", rect: hit.rect } : undefined;
}

/**
 * Cua Driver window-only local desktop-stage adapter. Every action is addressed to the exact registered
 * PID/HWND pair; frames and window labels remain local to the native pill.
 */
export function createCuaStageDriver(deps: CuaStageDriverDependencies = {}) {
  const manager = deps.manager ?? createWindowsDesktopStageManager(deps.stage);
  const timingContext = new AsyncLocalStorage<{ stageName: string; afterDispatch: boolean }>();
  // M9R's Direct2D host is the only visible agent cursor. The Cua package
  // remains an action/perception adapter; its separate cursor is never started
  // or moved, and a native failure never switches to a second cursor engine.

  /**
   * Build one native sender for a registered stage. Semantic UIA operations
   * can remain headless. When a control requires OS input, the exact window
   * must already be on the owner's currently visible desktop and uses the
   * shared foreground lease; computer-use actions never create or activate a
   * separate Windows virtual desktop.
   */
  function nativeStageInput(pid: number, windowId: string | bigint,
    send: () => Promise<void>, refocus?: () => Promise<void>) {
    const target = windowId.toString();
    return {
      bringToFront: () => manager.bringToForeground(pid, target),
      send: () => timedInputDispatch("native", send),
      ...(refocus ? { refocus: () => timedInputDispatch("native-refocus", refocus) } : {}),
    };
  }

  function nativeWindowClick(pid: number, windowId: string | bigint, x: number, y: number,
    options: { button?: "left" | "right" | "middle"; count?: 1 | 2 | 3 } = {}) {
    const target = windowId.toString();
    return { route: "PostMessageW", send: () => manager.postClickToWindow(pid, target, x, y, options) };
  }

  function nativeWindowScroll(pid: number, windowId: string | bigint, x: number, y: number, amount: number,
    axis: "horizontal" | "vertical" = "vertical") {
    const target = windowId.toString();
    return { route: "PostMessageW", send: () => manager.postScrollToWindow(pid, target, x, y, amount, axis) };
  }

  function invokeWindowElementTimed(pid: number, windowId: string, input: Parameters<typeof manager.invokeWindowElement>[2]) {
    return timedInputDispatch("uia-element", () => manager.invokeWindowElement(pid, windowId, input), (result) => result.dispatched);
  }

  async function nativeReplaceTextAtScreenPoint(pid: number, windowId: string | bigint, x: number, y: number, text: string,
    input: { session: string; signal?: AbortSignal; deliveryMode?: "background" | "owner-preview"; preferForeground?: boolean; allowForegroundEscalation?: boolean }): Promise<CuaStageActionOutcome> {
    const targetWindowId = windowId.toString();
    const outcome = await driverInputAction("type_text", {
      pid, window_id: Number(targetWindowId), x, y, text, session: input.session,
    }, "M9R could not replace text in the selected field.", {
      signal: input.signal,
      deliveryMode: input.deliveryMode,
      preferForeground: input.preferForeground,
      allowForegroundEscalation: input.allowForegroundEscalation,
      nativeForeground: nativeStageInput(pid, targetWindowId, async () => {
        // Replacement is one logical action but three OS dispatches. If a later
        // SendInput fails after an earlier event was accepted, retrying the
        // whole replacement could duplicate or corrupt the user's text.
        let dispatched = false;
        try {
          await manager.sendClick(pid, targetWindowId, x, y, {});
          dispatched = true;
          await manager.sendKeyCombo(pid, targetWindowId, ["CTRL", "A"]);
          await manager.sendText(pid, targetWindowId, text);
        } catch (error) {
          if (dispatched) {
            throw new DesktopInputOutcomeUnknownError(
              `Text replacement partially dispatched to the exact window; inspect the field before retrying. ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          throw error;
        }
      }),
    });
    return { ...outcome, summary: "Native text replacement was delivered; the refreshed UI state is the separate semantic verification." };
  }
  const now = deps.now ?? (() => new Date());
  const root = deps.stage?.root ?? defaultStoreRoot(homedir(), deps.stage?.env ?? process.env);
  // Provider workers are separate processes, but Windows still exposes one
  // foreground input stream. Share the lease through the M9R store so Paint,
  // Calculator, or any other target cannot be focused by two workers at once.
  const foregroundLease = deps.foregroundLease ?? createForegroundInputLease({ lockPath: join(root, "foreground-input-lease") });
  const cursorOverlayExecutable = deps.stage?.nativeHostPath ?? join(root, "bin", "m9r-native-input-host.exe");
  // Build this unconditionally on Windows rather than gating it on an
  // existsSync() check taken once, right now: the host itself rechecks the
  // exe's presence on every spawn attempt, so a broker that starts slightly
  // ahead of an in-progress install can still pick up cursor presentation
  // once the exe lands, instead of staying permanently without it for its
  // whole lifetime.
  const cursorOverlayHost = deps.cursorOverlayHost
    ?? (process.platform === "win32" ? createAgentCursorOverlayHost({ executablePath: cursorOverlayExecutable }) : undefined);
  // The renderer is transparent and non-activating before it receives a
  // marker. Warm it during broker startup so the first task avoids cold spawn.
  void cursorOverlayHost?.warm?.().catch(() => undefined);
  const agentSessions = new Map<string, AgentCursorSession>();
  const cursorColorAssignments = new Map<string, readonly [number, number, number]>();
  function assignCursorColor(identityKey: string): readonly [number, number, number] {
    const existing = cursorColorAssignments.get(identityKey);
    if (existing) return existing;
    const used = new Set(
      [...agentSessions.keys()].map((key) => cursorColorAssignments.get(key)).filter(Boolean),
    );
    const color = CURSOR_COLOR_PALETTE.find((candidate) => !used.has(candidate)) ?? CURSOR_COLOR_PALETTE[0]!;
    cursorColorAssignments.set(identityKey, color);
    return color;
  }
  const cursorSessionNames = new Map<string, string>();
  const cursorOverlayPresentations = new Map<string, { id: string; label: string; color: readonly [number, number, number] }>();
  const cursorStartSlots = new Map<string, number>();
  const cursorPresentationQueues = new Map<string, Promise<void>>();
  const cursorPresentationWork = new Map<string, CursorPresentationWork>();
  // Cursor presentation can be requested concurrently by several provider
  // deliveries. Keep slot reservation and the initial overlay move atomic so
  // two providers cannot observe the same free slot and overlap at startup.
  let cursorSlotQueue: Promise<void> = Promise.resolve();

  async function withCursorPresentation<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = cursorPresentationQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    const tail = current.then(() => undefined, () => undefined);
    cursorPresentationQueues.set(key, tail);
    try { return await current; }
    finally { if (cursorPresentationQueues.get(key) === tail) cursorPresentationQueues.delete(key); }
  }

  async function bestEffortCursorPresentation(key: string, run: () => Promise<unknown>): Promise<{
    outcome: CursorPresentationOutcome;
    settled: Promise<CursorPresentationOutcome>;
    requestedAt: { perf: number; iso: string };
    stageName?: string;
  }> {
    const requestedAt = { perf: performance.now(), iso: now().toISOString() };
    const stageName = timingContext.getStore()?.stageName;
    // Overlay movement is presentation-only and must never hold up native
    // input. Keep at most one in-flight move and one latest requested move per
    // agent: if IPC is slow, intermediate targets are discarded instead of
    // replaying a stale cursor trail after the task has already moved on.
    let work = cursorPresentationWork.get(key);
    if (!work) {
      work = { generation: 0, running: false };
      cursorPresentationWork.set(key, work);
    }
    work.generation += 1;
    const generation = work.generation;
    if (work.pending) {
      work.pending.resolve({ status: "superseded" });
      work.pending = undefined;
    }
    let resolve!: (outcome: CursorPresentationOutcome) => void;
    const completion = new Promise<CursorPresentationOutcome>((done) => { resolve = done; });
    work.pending = { generation, run, resolve };

    if (!work.running) {
      work.running = true;
      void (async () => {
        try {
          while (work!.pending) {
            const request = work!.pending;
            work!.pending = undefined;
            let error: unknown;
            try { await withCursorPresentation(key, request.run); }
            catch (caught) { error = caught; }
            request.resolve(work!.generation === request.generation
              ? error === undefined ? { status: "completed" } : { status: "failed", error }
              : { status: "superseded", ...(error === undefined ? {} : { error }) });
          }
        } finally {
          work!.running = false;
          if (!work!.pending && cursorPresentationWork.get(key) === work) cursorPresentationWork.delete(key);
        }
      })();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([completion, new Promise<CursorPresentationOutcome>((done) => {
        timer = setTimeout(() => done({ status: "timed-out" }), CURSOR_PRESENTATION_LEAD_BUDGET_MS);
      })]);
      return { outcome, settled: completion, requestedAt, ...(stageName ? { stageName } : {}) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const desktopCaptures = new Map<string, CachedDesktopCapture>();
  const desktopInputTargets = new Map<string, DesktopInputTarget>();
  // Keep the semantics from the observation that issued each raw UIA ref.
  // Native token prefixes rotate on every walk, including the money-gate read.
  //
  // Each key used to hold only its single latest generation, replaced wholesale
  // on every read -- including a window's own routine pre/post-dispatch reads,
  // which run on every action, not just ones that call read_structure directly.
  // That meant a ref handed to the agent from one observation could stop
  // resolving the instant *any* later, unrelated read ran for the same window,
  // even with no real UI change (confirmed live, T324: a click_element call
  // using a ref from an earlier read failed instantly, with the control still
  // present and unchanged). Retaining a short, bounded history of recent
  // generations lets a ref be reconciled against one it actually belongs to,
  // not just whichever read happened to run most recently.
  const MAX_OBSERVATION_GENERATIONS = 4;
  function pushObservationGeneration<V>(store: Map<string, Map<string, V>[]>, key: string, generation: Map<string, V>): void {
    const history = store.get(key) ?? [];
    history.push(generation);
    while (history.length > MAX_OBSERVATION_GENERATIONS) history.shift();
    store.set(key, history);
  }
  function findInObservationHistory<V>(store: Map<string, Map<string, V>[]>, key: string, token: string): V | undefined {
    const history = store.get(key);
    if (!history) return undefined;
    for (let index = history.length - 1; index >= 0; index--) {
      const found = history[index]!.get(token);
      if (found) return found;
    }
    return undefined;
  }
  function latestObservationGeneration<V>(store: Map<string, Map<string, V>[]>, key: string): Map<string, V> | undefined {
    return store.get(key)?.at(-1);
  }
  const observedElements = new Map<string, Map<string, CuaWindowElement>[]>();
  // Native UIA refs belong to the native tree, never to Cua Driver's opaque
  // element-token namespace. Keep the exact observation identity locally so
  // the native dispatcher can re-resolve and validate the same control.
  const nativeObservedElements = new Map<string, Map<string, NativeWindowStructureElement>[]>();
  const nativeObservedComplete = new Map<string, boolean>();

  function emitTiming(event: CuaStageTimingEvent): void {
    try { deps.onTiming?.(event); } catch { /* diagnostics must never affect desktop control */ }
  }

  async function updateM9rCursorOverlay(session: AgentCursorSession | string, x: number, y: number): Promise<boolean> {
    const presentation = cursorOverlayPresentations.get(typeof session === "string" ? session : session.session);
    if (!cursorOverlayHost || !presentation) return false;
    const startedAt = performance.now();
    let visible = false;
    try {
      visible = await cursorOverlayHost.upsert({ ...presentation, x, y });
    } catch { /* presentation must never change the input action result */ }
    emitTiming({ phase: "cursor-overlay", startedAt: now().toISOString(), endedAt: now().toISOString(),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100, status: visible ? "ok" : "error",
      detail: `renderer=m9r;screenPoint=verified;visible=${visible}` });
    return visible;
  }

  async function sayAgentCursor(
    fromIdentity: CuaAgentCursorIdentity,
    _toIdentity: CuaAgentCursorIdentity,
    text: string,
  ): Promise<boolean> {
    if (!cursorOverlayHost) return false;
    try {
      const from = agentCursorDetails(fromIdentity);
      const speaker = agentSessions.get(from.key);
      const speakerPresentation = speaker && cursorOverlayPresentations.get(speaker.session);
      if (!speakerPresentation) return false;
      return await cursorOverlayHost.say({ id: speakerPresentation.id, text });
    } catch {
      return false;
    }
  }

  function recordCursorPresentation(
    presentation: { outcome: CursorPresentationOutcome; settled: Promise<CursorPresentationOutcome>; requestedAt: { perf: number; iso: string }; stageName?: string },
    detail: string,
    explicitStageName?: string,
  ): void {
    const stageName = explicitStageName ?? presentation.stageName ?? timingContext.getStore()?.stageName;
    const emit = (outcome: CursorPresentationOutcome, arrival: "before-dispatch" | "after-dispatch") => {
      const ok = outcome.status === "superseded" || outcome.status === "completed";
      const reason = ok ? "" : `;${outcome.error instanceof Error ? outcome.error.message.replace(/[\r\n\t;]+/g, " ").slice(0, 160) : outcome.status}`;
      emitTiming({ phase: "cursor-position", startedAt: presentation.requestedAt.iso, endedAt: now().toISOString(),
        durationMs: Math.round((performance.now() - presentation.requestedAt.perf) * 100) / 100,
        status: ok ? "ok" : "error", detail: `${detail};presentation=${outcome.status};arrival=${arrival}${reason}`,
        ...(stageName ? { stageName } : {}) });
    };
    if (presentation.outcome.status !== "timed-out") {
      emit(presentation.outcome, "before-dispatch");
      return;
    }
    // The lead budget only limits how long an action waits for a visual marker.
    // Record the actual renderer result when it settles; a slow overlay is not
    // falsely reported as a failed desktop action or cursor position.
    void presentation.settled.then((outcome) => emit(outcome, "after-dispatch"), () => undefined);
  }

  type TimingDetails = Omit<CuaStageTimingEvent, "phase" | "startedAt" | "endedAt" | "durationMs" | "status">
    | (() => Omit<CuaStageTimingEvent, "phase" | "startedAt" | "endedAt" | "durationMs" | "status">);

  async function timed<T>(phase: CuaStageTimingEvent["phase"], action: () => Promise<T>, details: TimingDetails = {}): Promise<T> {
    const started = performance.now();
    const startedAt = now().toISOString();
    let status: CuaStageTimingEvent["status"] = "ok";
    try { return await action(); }
    catch (error) { status = "error"; throw error; }
    finally {
      const resolvedDetails = typeof details === "function" ? details() : details;
      const context = timingContext.getStore();
      emitTiming({ phase, startedAt, endedAt: now().toISOString(), durationMs: Math.round((performance.now() - started) * 100) / 100,
        status, ...resolvedDetails, ...(!resolvedDetails.stageName && context ? { stageName: context.stageName } : {}) });
    }
  }

  async function timedInputDispatch<T>(route: string, action: () => Promise<T>, wasDispatched: (result: T) => boolean = () => true): Promise<T> {
    const result = await timed("input-dispatch", action, { detail: `route=${route}` });
    if (wasDispatched(result)) {
      const context = timingContext.getStore();
      if (context) context.afterDispatch = true;
    }
    return result;
  }

  async function ensureAgentSession(identity: CuaAgentCursorIdentity, _stageName?: string): Promise<{ session: AgentCursorSession }> {
    const details = agentCursorDetails(identity);
    if (!cursorSessionNames.has(details.key) && cursorSessionNames.size >= 16) {
      throw new Error("This machine already has 16 active M9R agent cursor identities; close or revoke one before adding another.");
    }
    let label = cursorSessionNames.get(details.key);
    if (!label) {
      const occupied = new Set(cursorSessionNames.values());
      const base = details.session;
      label = base;
      for (let ordinal = 2; occupied.has(label); ordinal++) {
        const suffix = ` ${ordinal}`;
        label = `${base.slice(0, PUBLIC_CURSOR_LABEL_MAX_LENGTH - suffix.length)}${suffix}`;
      }
      cursorSessionNames.set(details.key, label);
    }
    details.session = label;
    cursorOverlayPresentations.set(label, {
      id: `agent-${createHash("sha256").update(details.key).digest("hex")}`,
      label,
      color: assignCursorColor(details.key),
    });
    // Cursor identity is M9R-owned presentation state. It deliberately does
    // not start a CUA driver session; native input dispatch has its own path.
    agentSessions.set(details.key, details);
    return { session: details };
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
  async function showAgentCursor(name: string, identity: CuaAgentCursorIdentity): Promise<{ label: string; visible: boolean }> {
    const { session } = await ensureAgentSession(identity, name);
    let overlayScreenPoint: { x: number; y: number } | undefined;
    await withCursorSlotLock(async () => {
      let foreground: Awaited<ReturnType<typeof manager.currentForegroundWindow>> | undefined;
      let bounds: CuaStageWindowBounds | undefined;
      try {
        foreground = await manager.currentForegroundWindow();
        if (foreground.visible && !foreground.minimized
          && !/m9r(?:[- ]overlay)?|agent cursor overlay|cua cursor overlay/i.test(`${foreground.title} ${foreground.className}`)) {
          bounds = await manager.windowRect(foreground.pid, foreground.windowId);
        }
      } catch {
        // Startup presentation is best-effort. The first target action will
        // position the marker from its own fresh capture.
      }
      if (!foreground || !bounds || bounds.width < 1 || bounds.height < 1) return;
      let slot = cursorStartSlots.get(session.key);
      if (slot === undefined) {
        const occupied = new Set(cursorStartSlots.values());
        slot = 0;
        while (occupied.has(slot)) slot++;
        if (slot >= 16) return;
        cursorStartSlots.set(session.key, slot);
      }
      overlayScreenPoint = {
        x: Math.floor(bounds.x + bounds.width * ((slot % 4) + 1) / 5),
        y: Math.floor(bounds.y + bounds.height * (Math.floor(slot / 4) + 1) / 5),
      };
    });

    if (!overlayScreenPoint) return { label: session.session, visible: false };
    let visible = false;
    const presentation = await bestEffortCursorPresentation(session.key, async () => {
      visible = await updateM9rCursorOverlay(session, overlayScreenPoint!.x, overlayScreenPoint!.y);
      if (!visible) throw new Error("M9R's native cursor overlay did not acknowledge the initial marker.");
    });
    recordCursorPresentation(presentation, "renderer=m9r;scope=initial-overlay;best-effort=true", name);
    return { label: session.session, visible: presentation.outcome.status === "completed" && visible };
  }

  async function inspectOwnerDesktop(name: string, identity: CuaAgentCursorIdentity) {
    const { stage, anchor } = await manager.inspectStage(name);
    const details = agentCursorDetails(identity);
    // These checks run inside the stage's dispatch window, so they must say plainly that nothing was sent;
    // a plain error there is recorded as an uncertain outcome and locks the surface.
    if (anchor) throw new DesktopInputNotDispatchedError("The owner-preview stage is bound to an app window. Refresh the desktop stage before sending desktop-wide input.", "target-identity");
    if (stage.agentAssignment?.handle !== details.handle || stage.agentAssignment.sessionTag !== details.sessionTag) {
      throw new DesktopInputNotDispatchedError("This Windows desktop is not assigned to the requesting M9R agent session. No input was sent.", "target-identity");
    }
    return { stage };
  }

  function desktopCaptureKey(name: string, identity: CuaAgentCursorIdentity): string {
    return `${name}\0${agentCursorDetails(identity).key}`;
  }

  function currentDesktopCapture(name: string, identity: CuaAgentCursorIdentity): CachedDesktopCapture {
    const key = desktopCaptureKey(name, identity);
    const capture = desktopCaptures.get(key);
    if (!capture || now().getTime() - capture.capturedAtMs > 30_000) {
      desktopCaptures.delete(key);
      throw new DesktopInputNotDispatchedError("The desktop view is missing or expired. Capture the current desktop again before acting on it. No input was sent.", "target-identity");
    }
    return capture;
  }

  function invalidateDesktopCaptures(): void {
    // Any input can change visible pixels, stacking, or coordinate meaning for every agent sharing this desktop.
    desktopCaptures.clear();
  }

  async function captureOwnerDesktop(name: string, identity: CuaAgentCursorIdentity, refresh = false,
    postActionObservation = false): Promise<CuaStageCapture> {
    const details = agentCursorDetails(identity);
    await inspectOwnerDesktop(name, identity);
    if (!refresh) {
      try { return stageCapture(currentDesktopCapture(name, identity), now); } catch { /* take a new capture */ }
    }
    // Native Win32 capture is the production observation path. It is not tied
    // to a Cua capture token and therefore cannot lose the desktop identity
    // when the optional presentation adapter is restarted.
    const native = await timed(postActionObservation ? "post-action-observation" : "window-capture",
      () => manager.captureDesktop(), { stageName: name, detail: "scope=owner-desktop" });
    const captureId = `native-desktop-${createHash("sha256").update(native.dataUrl).digest("hex").slice(0, 24)}`;
    await inspectOwnerDesktop(name, identity);
    const capturedAt = now();
    const cacheKey = `${name}\0${details.key}`;
    desktopCaptures.set(cacheKey, { captureId, width: native.width, height: native.height, stageName: name, identityKey: details.key,
      ...(Number.isSafeInteger(native.originX) && Number.isSafeInteger(native.originY) ? { origin: { x: native.originX!, y: native.originY! } } : {}),
      dataUrl: native.dataUrl, capturedAtMs: capturedAt.getTime(), capturedAt: capturedAt.toISOString() });
    // The capture key is private bookkeeping. Providers act against the
    // broker's latest identity-bound capture; exposing a hash of screenshot
    // pixels is neither needed for dispatch nor part of the observation API.
    return { dataUrl: native.dataUrl, width: native.width, height: native.height, capturedAt: capturedAt.toISOString(),
      ...((Number.isSafeInteger(native.originX) && Number.isSafeInteger(native.originY))
        ? { origin: { x: native.originX!, y: native.originY! } } : {}) };
  }

  async function withOwnerDesktop<T>(name: string, identity: CuaAgentCursorIdentity, run: (input: {
    runtime?: CuaRuntime;
    session: AgentCursorSession;
    capture: CachedDesktopCapture;
  }) => Promise<T>): Promise<T> {
    const session = agentCursorDetails(identity);
    const { stage } = await inspectOwnerDesktop(name, identity);
    let capture: CachedDesktopCapture;
    try {
      capture = currentDesktopCapture(name, identity);
    } catch (error) {
      if (!(error instanceof Error) || !/desktop view is missing or expired/i.test(error.message)) throw error;
      const refreshed = await captureOwnerDesktop(name, identity, true);
      throw new StageCaptureRefreshError(refreshed,
        "The desktop observation was missing or expired. A fresh owner-desktop capture is attached; no input was sent. Inspect it and retry the intended action.");
    }
    if (capture.stageName !== name || capture.identityKey !== session.key) throw new DesktopInputNotDispatchedError("The captured desktop does not belong to this agent's current stage identity.", "target-identity");
    return timingContext.run({ stageName: stage.name, afterDispatch: false }, () => run({ runtime: undefined, session, capture }));
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
  if (value instanceof DesktopInputNotDispatchedError) return value.code === "background-unavailable";
  // A typed driver result keeps its refusal in `error`/`escalation`, not in the text fields read below.
  if (value && typeof value === "object" && !(value instanceof Error) && driverRefusal(value as ToolResult)?.foreground) return true;
  const message = value instanceof Error ? value.message
    : value && typeof value === "object" ? inputToolText(value as ToolResult)
      : String(value);
  return backgroundRefusalPattern.test(message);
}

function backgroundRefusalMessage(value: unknown): string {
  const detail = value instanceof Error ? value.message : inputToolText(value as ToolResult);
  const clean = detail.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
  return `${clean || "Background delivery is not available for the selected window."} No text was sent; M9R will not activate the window as a fallback.`;
}

/**
 * Dispatch through the exact-window native sender. Owner-pointer preservation
 * is a best-effort courtesy only; inability to sample or restore the pointer
 * must never prevent an otherwise valid action or turn a delivered action
 * into a reported failure.
 */
async function driverInputAction(name: string, args: Record<string, unknown>, fallback: string,
  options: { preferForeground?: boolean; signal?: AbortSignal; deliveryMode?: "background" | "owner-preview"; allowForegroundEscalation?: boolean;
    nativeHeadless?: { route: string; send: () => Promise<{ route: string; target: string; dispatched: true }> };
    nativeForeground?: { bringToFront: () => Promise<void>; send: () => Promise<void>; refocus?: () => Promise<void> } } = {}) {
  assertNotAbortedBeforeInput(options.signal);
  // Omitted mode follows the owner-visible stage contract. Background is an
  // explicit request and may only use a semantic caller path that does not
  // reach this physical sender.
  const deliveryMode = options.deliveryMode ?? "owner-preview";
  const ownerPointer = deps.ownerPointer ?? { get: () => manager.getOwnerCursorPosition(), restore: (x: number, y: number) => manager.restoreOwnerCursorPosition(x, y) };
  const deliverForeground = async (headlessAlreadyAttempted: boolean): Promise<CuaStageActionOutcome> => {
    const pid = args.pid;
    const windowId = args.window_id;
    if (!Number.isSafeInteger(pid) || (pid as number) < 1 || typeof windowId !== "number" || !Number.isFinite(windowId)
      || !Number.isInteger(windowId) || windowId < 1) {
      throw new DesktopInputNotDispatchedError("The foreground action is missing the exact target window identity; no input was sent.", "target-identity");
    }
    const targetPid = pid as number;
    const targetWindowId = windowId as number;
    let saved: { x: number; y: number } | undefined;
    // The manager's native owner-work policy authorizes this exact foreground
    // operation before it reaches this callback. Pointer movement is not used
    // as a dispatch gate; its resting position is preserved for restoration.
    assertNotAbortedBeforeInput(options.signal);
    if (!options.nativeForeground) throw new DesktopInputNotDispatchedError(
      "Native desktop input is unavailable for the exact target window; no input was sent.", "native-dispatch-unavailable");
    let outcome: CuaStageActionOutcome | undefined;
    let actionError: unknown;
    try {
      assertNotAbortedBeforeInput(options.signal);
      try {
        await options.nativeForeground.bringToFront();
      } catch (error) {
        if (error instanceof DesktopInputNotDispatchedError) throw error;
        throw new DesktopInputNotDispatchedError(
          `The target window could not be brought to the foreground; no target input was sent. ${error instanceof Error ? error.message : String(error)}`,
          "foreground-lease",
        );
      }
      assertNotAbortedBeforeInput(options.signal);
      // When preferForeground is false, the caller already tried this exact
      // headless route moments ago (see the top-level attempt below) and it
      // already failed -- bringToFront() in between does not change whether
      // the target exposes a same-process child window at this point (that
      // is a structural property of the app, e.g. a WinUI-hosted control
      // such as Calculator, not a transient foreground/visibility state).
      // Retrying it here was a second guaranteed-failing native call on
      // every single such dispatch. Only attempt it here when it genuinely
      // has not been tried yet (preferForeground skipped the earlier block).
      if (options.nativeHeadless && !headlessAlreadyAttempted && !options.preferForeground) {
        try {
          const dispatched = await timedInputDispatch(options.nativeHeadless.route, options.nativeHeadless.send,
            (result) => result.dispatched === true);
          outcome = { status: "unverified",
            summary: `Windows queued the input to the exact target window through ${dispatched.route}; the refreshed app state is the effect check.` };
        } catch (error) {
          if (!(error instanceof DesktopInputNotDispatchedError)) throw error;
          // Only a proven pre-dispatch refusal permits the authorized physical
          // input fallback. An accepted or uncertain message is never replayed.
        }
      }
      if (!outcome) {
        // Sample and restore the owner pointer only if the target-message route
        // proved unavailable and we are about to use global SendInput.
        saved = await ownerPointer.get().catch(() => undefined);
        // bringToFront only activates the top-level HWND; it does not establish
        // *where inside* that window keyboard focus lands. For a window hosting a
        // modern XAML/WinUI island (e.g. the Store Paint app), that distinction
        // matters: the posted (PostMessageW) click that placed the caret earlier
        // dispatches through the window's message queue, not the real hardware
        // input pipeline WinUI's own pointer/focus routing listens to, so it can
        // leave logical focus wherever it already was (e.g. a ribbon button)
        // instead of the just-placed text field. Confirmed live (T324, Paint
        // Text tool): both text entries used this exact foreground route with
        // identical PostMessageW clicks beforehand, but only the first -- which
        // happened to coincide with the window's first real activation -- landed
        // in the text field; the second typed into whatever already had focus
        // and the text never appeared. A real SendInput click at the remembered
        // field point, right before SendInput keystrokes, re-establishes focus
        // through the same input pipeline WinUI itself relies on.
        if (options.nativeForeground.refocus) {
          try { await options.nativeForeground.refocus(); }
          catch { /* best-effort: typing still proceeds against whatever currently has focus */ }
        }
        if (process.env.M9R_DEBUG_CHILD_EDIT_LOOKUP) {
          const foreground = await manager.currentForegroundWindow().catch((error) => `<error: ${error instanceof Error ? error.message : error}>`);
          console.error(`[deliverForeground] about to SendInput targetPid=${targetPid} targetWindowId=${targetWindowId} currentForeground=${JSON.stringify(foreground)}`);
        }
        await options.nativeForeground.send();
        // Native SendInput reports only OS-level delivery. The caller's
        // refreshed UIA capture is the separate semantic verification signal.
        outcome = { status: "unverified" };
      }
    } catch (error) {
      actionError = error;
    }
    let restoreError: unknown;
    if (saved) {
      try { await ownerPointer.restore(saved.x, saved.y); }
      catch (error) { restoreError = error; }
    }
    if (actionError !== undefined) throw actionError;
    return { ...outcome!, foregroundConfirmed: true,
      ...(restoreError ? { summary: "Native input was delivered. Restoring the owner's pointer was unavailable; this presentation detail did not affect delivery." } : {}) };
  };
  const runForeground = async (headlessAlreadyAttempted: boolean) => {
    // The owner-work policy inside the native manager gates the foreground
    // activation. The target-message route stays off the user's global pointer;
    // pointer preservation is needed only if the authorized action must fall
    // back to SendInput.
    return timed("foreground-lease", () => foregroundLease.run(name, options.signal, () => deliverForeground(headlessAlreadyAttempted)), {
    detail: `action=${name};delivery=foreground`,
  }).catch((error) => {
    if (error instanceof ForegroundInputLeaseError) {
      throw new DesktopInputNotDispatchedError(error.message, "foreground-lease");
    }
    throw error;
    });
  };
  // Try an exact-window, per-agent message route before any foreground lease
  // or SendInput path. Windows accepting PostMessage proves only queueing, so
  // the caller must still refresh the app and verify the requested effect.
  // An uncertain result is never replayed through foreground input.
  const headlessAttemptedHere = !options.preferForeground && Boolean(options.nativeHeadless);
  if (headlessAttemptedHere && options.nativeHeadless) {
    try {
      const dispatched = await timedInputDispatch(options.nativeHeadless.route, options.nativeHeadless.send,
        (result) => result.dispatched === true);
      return { status: "unverified" as const,
        summary: `Windows queued the input to the exact target window through ${dispatched.route}; the refreshed app state is the effect check.` };
    } catch (error) {
      if (!(error instanceof DesktopInputNotDispatchedError)) throw error;
      // Only a proven pre-dispatch refusal may fall through to a separately
      // authorized foreground path. The target helper never uses the physical
      // pointer for the successful message route.
    }
  }
  // Semantic UIA actions are dispatched headlessly by their call sites. A
  // background request must never fall through to SendInput, because Windows
  // delivers it to the real foreground window and physical pointer. The one
  // explicit fallback flag may pass this planner guard, but the native manager
  // still requires a scoped owner approval or Agents Free mode before dispatch.
  if (deliveryMode === "background" && !options.allowForegroundEscalation) {
    throw new DesktopInputNotDispatchedError(
      `${fallback} This target has no supported headless semantic route; background mode sent no input and did not activate a window.`,
      "background-unavailable",
    );
  }
  if (options.nativeForeground) return runForeground(headlessAttemptedHere);
  throw new DesktopInputNotDispatchedError(
    `${fallback} Native foreground delivery is unavailable for this target and no input was sent.`, "native-dispatch-unavailable");
}

  async function deliverTextToExactWindow(input: {
    session: string;
    pid: number;
    windowId: string | bigint;
    text: string;
    selected?: DesktopInputTarget;
    nativeInput?: () => Promise<boolean>;
    preferForeground?: boolean;
    deliveryMode?: "background" | "owner-preview";
    allowForegroundEscalation?: boolean;
    delayMs?: number;
    nativeForeground?: { bringToFront: () => Promise<void>; send: () => Promise<void>; refocus?: () => Promise<void> };
    signal?: AbortSignal;
  }): Promise<CuaStageActionOutcome> {
    const windowId = input.windowId.toString();
    if (process.env.M9R_DEBUG_CHILD_EDIT_LOOKUP) {
      console.error(`[deliverTextToExactWindow] entry pid=${input.pid} windowId=${windowId} deliveryMode=${input.deliveryMode} preferForeground=${input.preferForeground} signalAborted=${input.signal?.aborted} hasNativeInput=${Boolean(input.nativeInput)}`);
    }
    // A live, not-yet-aborted signal is the normal case for every real call (act()
    // always hands one in, purely so an in-flight action can be cancelled). Only an
    // *already aborted* signal is a reason to skip these fast, headless-safe paths;
    // the mere presence of a cancellable signal is not.
    if (!input.signal?.aborted && !input.preferForeground && input.nativeInput && await input.nativeInput()) {
      return { status: "unverifiable", summary: "Posted text to the selected native edit control; application effect requires verification." };
    }
    // A plain Win32 control that lacks a UIA value pattern still has a real
    // headless route: WM_CHAR posted straight to its own message queue, which
    // never requires and never steals OS foreground. This used to be tried
    // only in "background" delivery mode, so every ordinary (non-background)
    // type-into-a-focused-field call skipped straight to foreground SendInput
    // -- moving the owner's real cursor to focus the field even when WM_CHAR
    // could have reached it headlessly (confirmed live: a new Sticky Note).
    // Try it first regardless of delivery mode; only background mode keeps
    // its original fail-closed rule of never escalating to SendInput itself.
    if (!input.signal?.aborted && !input.preferForeground) {
      // Some real apps (e.g. Windows 11 Notepad) host their actual classic
      // Edit-class text surface as a CHILD window of the top-level frame
      // we're given, rather than being an Edit control themselves; posting
      // WM_CHAR to the frame is correctly queued but never reaches the real
      // text surface. Prefer a classic Edit-class descendant when one
      // exists; a control with no such descendant (including one that IS
      // itself already an Edit control, which has no children to find) is
      // untouched -- this never changes where WM_CHAR lands for anything
      // that already worked.
      let target = windowId;
      let childLookupError: unknown;
      try {
        const child = await manager.findEditChildWindow(input.pid, windowId);
        if (child) target = child;
      } catch (error) { childLookupError = error; /* best-effort: fall back to the originally selected window */ }
      if (process.env.M9R_DEBUG_CHILD_EDIT_LOOKUP) {
        console.error(`[deliverTextToExactWindow] pid=${input.pid} windowId=${windowId} resolvedTarget=${target} childFound=${target !== windowId} error=${childLookupError instanceof Error ? childLookupError.message : childLookupError}`);
        if (target === windowId) {
          try {
            const classes = await manager.listChildWindowClasses(input.pid, windowId);
            console.error(`[deliverTextToExactWindow] no Edit-class child found; all descendant classes: ${JSON.stringify(classes)}`);
          } catch (error) { console.error(`[deliverTextToExactWindow] listChildWindowClasses also failed: ${error instanceof Error ? error.message : error}`); }
        }
      }
      // Background mode already accepted the risk below (posting to the
      // top-level frame itself on the chance it IS an Edit control) for its
      // existing known-good apps. Outside background mode, that same
      // "untouched, hope it's an Edit control" case is no longer safe to
      // trust silently: a modern XAML/UWP app (Sticky Notes, confirmed live)
      // has no Edit-class window anywhere in its tree, yet PostMessage still
      // succeeds and `sendTextToWindow` reports "acknowledged" even though
      // the text never reaches the real text surface -- a false positive
      // that used to be impossible here simply because this branch never ran
      // outside background mode. Require an actual found child before
      // trusting this route; with none, skip straight to the exact same
      // foreground fallback this delivery mode already used before.
      if (target !== windowId || input.deliveryMode === "background") {
      try {
        const receipt = await manager.sendTextToWindow(input.pid, target, input.text);
        const targetMismatch = receipt.targetMatches === false;
        return {
          status: "unverifiable",
          summary: targetMismatch
            ? "The native helper reported WM_CHAR dispatch, but its returned target identity did not match the requested window; the application effect remains unverified."
            : "The native helper acknowledged background text delivery (WM_CHAR); the application effect requires verification.",
          dispatch: {
            channel: "wm-char",
            state: receipt.dispatchState ?? "acknowledged",
            ...(receipt.route ? { route: receipt.route } : {}),
            ...(receipt.targetMatches !== undefined ? { targetMatches: receipt.targetMatches } : {}),
          },
        };
      } catch (error) {
        // The native helper explicitly proved zero WM_CHAR delivery. Only that
        // typed pre-dispatch result may move to the owner-approved foreground
        // route; an uncertain outcome must never be replayed. Background mode
        // keeps its original fail-closed rule (never escalate without
        // explicit permission); every other delivery mode already ends at
        // foreground SendInput today regardless of this flag, so a proven
        // WM_CHAR miss there falls through exactly as it always has.
        const backgroundLocked = input.deliveryMode === "background" && !input.allowForegroundEscalation;
        if (!(error instanceof DesktopInputNotDispatchedError)
          || error.code !== "native-dispatch-unavailable" || backgroundLocked) throw error;
      }
      }
    }

    if (process.env.M9R_DEBUG_CHILD_EDIT_LOOKUP) {
      console.error(`[deliverTextToExactWindow] pid=${input.pid} windowId=${windowId} no headless route matched; falling through to foreground type_text (bringToFront + SendInput)`);
    }
    return driverInputAction("type_text", {
      pid: input.pid,
      window_id: Number.parseInt(windowId, 10),
      text: input.text,
      delay_ms: input.delayMs ?? DEFAULT_TYPE_DELAY_MS,
      session: input.session,
    }, "Cua Driver could not type into the selected window.", {
      preferForeground: input.preferForeground,
      deliveryMode: input.deliveryMode,
      signal: input.signal,
      allowForegroundEscalation: input.allowForegroundEscalation,
      nativeForeground: input.nativeForeground,
    });
  }

  function forgetDesktopInputTarget(name: string, identity: CuaAgentCursorIdentity): void {
    desktopInputTargets.delete(desktopInputKey(name, identity));
  }

  function forgetAgentDesktopInputTargets(identity: CuaAgentCursorIdentity): void {
    const suffix = `\0${agentCursorDetails(identity).key}`;
    for (const key of desktopInputTargets.keys()) if (key.endsWith(suffix)) desktopInputTargets.delete(key);
  }

  async function resolveOwnerWindowPoint(_runtime: CuaRuntime | undefined, _session: AgentCursorSession,
    screenPoint: { x: number; y: number }, includeAccessibilityTree = false) {
    // Win32 hit testing and our own UIA walker resolve the real HWND/control.
    const selected = await (deps.windowAtPoint ?? manager.windowAtPoint)(screenPoint.x, screenPoint.y);
    const { pid, windowId } = selected;
    if (selected.shell) {
      const origin = selected.screenOrigin;
      if (!origin || !Number.isSafeInteger(origin.x) || !Number.isSafeInteger(origin.y)) {
        throw new DesktopInputNotDispatchedError("Windows did not return the shell window origin; the stage cannot position its labeled cursor without moving the owner's pointer.");
      }
      const shellControl = await timed("target-resolution", () => (deps.pointControl ?? manager.pointControl)(screenPoint.x, screenPoint.y),
        { detail: "source=uia-element-at-point" });
      if (shellControl.windowPid !== pid || shellControl.windowId !== windowId.toString()) throw new DesktopInputNotDispatchedError("The shell control does not belong to the hit-tested window; no input was sent.");
      return { target: { pid, windowId }, localPoint: { x: screenPoint.x - origin.x, y: screenPoint.y - origin.y },
        shellControl, nativeKeyboardWindow: selected.keyboardWindow, state: undefined };
    }
    // Capture used to be performed here only to learn the origin and dimensions
    // for coordinate conversion. `windowRect` is the same GetWindowRect source
    // used by captureWindow, without encoding/copying a screenshot before each
    // desktop-coordinate action.
    const bounds = await manager.windowRect(pid, windowId.toString());
    const localPoint = { x: Math.floor(screenPoint.x - bounds.x), y: Math.floor(screenPoint.y - bounds.y) };
    if (localPoint.x < 0 || localPoint.y < 0 || localPoint.x >= bounds.width || localPoint.y >= bounds.height) {
      throw new DesktopInputNotDispatchedError("The screen point moved outside the exact target window before coordinate mapping; no input was sent.", "target-identity");
    }
    let elements: CuaWindowElement[] = [];
    if (includeAccessibilityTree) {
      const structure = await manager.windowStructure(pid, windowId.toString(), { maxElements: 4096, maxDepth: 64 });
      const nativeElements = structure.elements;
      elements = nativeElements.map((item, index) => {
        const actions = [
          ...(item.actions?.invoke ? ["invoke"] : []),
          ...(item.actions?.select ? ["select"] : []),
          ...(item.actions?.toggle ? ["toggle"] : []),
          ...(item.actions?.legacy ? ["click"] : []),
          ...(item.actions?.setValue ? ["set_value"] : []),
          ...(item.actions?.scroll ? ["scroll"] : []),
        ];
        return { elementToken: item.ref, elementIndex: BigInt(index), depth: item.depth, role: item.role,
          label: normalizeAccessibleLabel(item.label) ?? "", enabled: item.enabled, actions,
          frame: { x: item.rect.x, y: item.rect.y, w: item.rect.width, h: item.rect.height } } as unknown as CuaWindowElement;
      });
      const element = elementAtScreenPoint(elements, screenPoint.x, screenPoint.y,
        (candidate) => candidate.actions?.some((name) => /^(?:click|invoke|press|expand|toggle|select)$/i.test(name)) === true);
      return { target: { pid, windowId }, localPoint, state: { elements }, element,
        ...(element?.elementToken ? { nativeElement: nativeElements.find((item) => item.ref === element.elementToken) } : {}) };
    }
    return { target: { pid, windowId }, localPoint,
      windowCaptureSize: { width: bounds.width, height: bounds.height }, state: { elements } };
  }

  async function resolveOwnerDesktopPoint(runtime: CuaRuntime | undefined, session: AgentCursorSession, x: number, y: number,
    capture: CachedDesktopCapture, _screen?: DesktopScreenSize, includeAccessibilityTree = false): Promise<ResolvedDesktopPoint> {
    if (!validPoint(x, y, capture)) throw new DesktopInputNotDispatchedError("Desktop coordinates must fall inside the latest desktop screenshot. No input was sent.", "target-identity");
    const screenPoint = { x: (capture.origin?.x ?? 0) + x, y: (capture.origin?.y ?? 0) + y };
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
    if (!target) throw new DesktopInputNotDispatchedError("The desktop-wide view has no input window, so no keyboard input was sent. To type, observe target 'app-window' (bindForeground for the visible window) and act on that target, or click the intended window on this desktop first.", "target-identity");
    return target;
  }

  async function verifiedDesktopInputTarget(_runtime: CuaRuntime | undefined, name: string, identity: CuaAgentCursorIdentity): Promise<DesktopInputTarget> {
    const selected = activeDesktopInputTarget(name, identity);
    try {
      const listed = await manager.listVisibleWindows();
      const stillVisible = listed.some((window) => window.pid === selected.pid && window.windowId === selected.windowId.toString());
      if (!stillVisible) throw new Error("The selected application window is no longer visible on the owner's desktop.");
      return selected;
    } catch (error) {
      forgetDesktopInputTarget(name, identity);
      const reason = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 180) : "window verification failed";
      throw new DesktopInputNotDispatchedError(`The selected background window could not be verified (${reason}); no keyboard input was sent.`, "target-identity");
    }
  }

  async function presentM9rCursor(session: AgentCursorSession | string, key: string, screenPoint: { x: number; y: number },
    requireProof: boolean, detail: string, stageName?: string): Promise<boolean> {
    const present = async () => {
      if (!await updateM9rCursorOverlay(session, screenPoint.x, screenPoint.y)) {
        throw new DesktopInputNotDispatchedError("M9R's cursor overlay did not acknowledge the requested screen position.", "overlay-not-visible");
      }
    };
    if (requireProof) {
      return withCursorPresentation(key, async () => timed("cursor-position", present, { detail: `renderer=m9r;space=screen;${detail}` }).then(() => true));
    }
    const presentation = await bestEffortCursorPresentation(key, present);
    recordCursorPresentation(presentation, `renderer=m9r;space=screen;best-effort=true;${detail}`, stageName);
    return presentation.outcome.status === "completed";
  }

  async function moveOwnerCursor(session: AgentCursorSession, point: ResolvedDesktopPoint,
    requireProof = false): Promise<CuaStageCursorProof> {
    const screenPoint = await desktopPointToCurrentScreen(point);
    const visible = await presentM9rCursor(session, session.key, screenPoint, requireProof, "scope=owner-desktop");
    return { x: point.desktopPoint.x, y: point.desktopPoint.y, screenX: screenPoint.x, screenY: screenPoint.y,
      enabled: visible, visible };
  }

  async function moveAndVerifyCursor(input: { session: string; pid: number; windowId: bigint },
    x: number, y: number, frame: CuaStageWindowFrame, requireProof = false): Promise<CuaStageCursorProof> {
    if (![x, y, frame.width, frame.height].every(Number.isFinite) || frame.width < 1 || frame.height < 1
      || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
      throw new DesktopInputNotDispatchedError("The cursor point is outside the current stage capture; no cursor position was confirmed.", "position-unconfirmed");
    }
    let screenPoint: { x: number; y: number };
    try {
      screenPoint = await localToScreenPoint(input.pid, input.windowId, x, y, frame.width, frame.height, frame.windowBounds);
    } catch (error) {
      if (requireProof) throw error;
      return { x, y, screenX: x, screenY: y, enabled: false, visible: false };
    }
    const cursor = [...agentSessions.values()].find((candidate) => candidate.session === input.session);
    if (!cursor) {
      if (requireProof) throw new DesktopInputNotDispatchedError("The M9R agent cursor identity is not registered; no cursor position was confirmed.", "target-identity");
      return { x, y, screenX: screenPoint.x, screenY: screenPoint.y, enabled: false, visible: false };
    }
    const visible = await presentM9rCursor(cursor, cursor.key, screenPoint, requireProof, "scope=registered-window", timingContext.getStore()?.stageName);
    return { x, y, screenX: screenPoint.x, screenY: screenPoint.y, enabled: visible, visible };
  }
  async function withRegisteredWindow<T>(nameInput: string, run: (input: {
    driver?: CuaDriverLike;
    sdk?: CuaSdk;
    session: string;
    pid: number;
    windowId: bigint;
    captureFrame: () => Promise<CuaStageWindowFrame>;
    capture: () => Promise<CuaStageWindowFrame>;
    readStructure: () => Promise<CuaStageStructure>;
    elementAt: (x: number, y: number) => Promise<string | undefined>;
    elementAtPoint: (x: number, y: number, action?: "click" | "set_value") => Promise<CuaWindowElement | undefined>;
    observedElementByToken: (token: string, expected?: { role?: string; label?: string }) => CuaWindowElement | undefined;
    observedNativeElementByToken: (token: string, expected?: { role?: string; label?: string }) => NativeWindowStructureElement | undefined;
    observedNativeElements: () => readonly NativeWindowStructureElement[];
    elementByToken: (token: string, expected?: { role?: string; label?: string; allowDisabled?: boolean }) => Promise<{
      element: CuaWindowElement;
      /** Fresh UIA bounds are already in virtual-screen coordinates. */
      screenRect: NativeWindowStructureElement["rect"];
      nativeElement?: NativeWindowStructureElement;
    } | undefined>;
    captureTarget: (x: number, y: number) => Promise<CuaStageTargetDescription | undefined>;
  }) => Promise<T>, cursorIdentity?: CuaAgentCursorIdentity): Promise<T> {
    let inspected: Awaited<ReturnType<typeof manager.inspectStage>>;
    try {
      inspected = await manager.inspectStage(nameInput);
    } catch (error) {
      if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
      // This is a read-only target preflight. If native inventory/helper access
      // fails here, the callback (and therefore target input) has not started.
      throw new DesktopInputNotDispatchedError(
        `The exact stage window could not be inspected; no target input was sent. ${error instanceof Error ? error.message : String(error)}`,
        "target-identity",
      );
    }
    const { stage, anchor } = inspected;
    if (!anchor) throw new DesktopInputNotDispatchedError("Stage " + stage.name + " has no registered app window. Register an owned window before capturing or acting.", "target-identity");
    const pid = anchor.pid;
    const windowId = parseWindowId(anchor.windowId);
    const cursorDetails = cursorIdentity ? agentCursorDetails(cursorIdentity) : undefined;
    const cursorSession = cursorDetails ? agentSessions.get(cursorDetails.key) : undefined;
    // The M9R cursor overlay is a separate native presentation process. No
    // CUA driver session is started or consulted for cursor visibility.
    const driver = undefined;
    const sdk = undefined;
    const session = cursorSession?.session ?? (cursorDetails ? cursorDetails.session : safeSessionName(stage.name));
    const observationKey = stage.name + "\0" + (cursorDetails?.key ?? session) + "\0" + pid + "\0" + windowId + "\0" + (anchor.processGeneration ?? "");

    const readNativeElements = async () => {
      const timing = timingContext.getStore();
      // Item #21 (live, 2026-11-13): every action pays for a full UIA tree read
      // twice -- once pre-dispatch to resolve the click/type target, once
      // post-dispatch to observe the result -- at ~1.4s average each, the
      // single biggest contributor to per-action latency (avg 7.16s/action
      // across 851 real actions). The pre-dispatch read must stay full
      // fidelity: it is what target resolution and the money-gate actually
      // reconcile against. The post-dispatch read only needs to show the
      // agent what changed, not re-resolve anything -- trimmed here instead.
      const afterDispatch = timing?.afterDispatch === true;
      const structure = await timed("accessibility-read", () => manager.windowStructure(pid, windowId.toString(),
        afterDispatch ? { maxElements: 2048, maxDepth: 40 } : { maxElements: 4096, maxDepth: 64 }),
        { detail: `scope=window;point=${afterDispatch ? "post-dispatch" : "pre-dispatch"}` });
      const indexByPath = new Map<string, bigint>();
      structure.elements.forEach((element, index) => indexByPath.set(JSON.stringify(element.path), BigInt(index)));
      const elements = structure.elements.map((element, index) => {
        const parentIndex = element.path.length ? indexByPath.get(JSON.stringify(element.path.slice(0, -1))) : undefined;
        const actions = [
          ...(element.actions?.invoke ? ["invoke"] : []),
          ...(element.actions?.select ? ["select"] : []),
          ...(element.actions?.toggle ? ["toggle"] : []),
          ...(element.actions?.legacy ? ["click"] : []),
          ...(element.actions?.setValue ? ["set_value"] : []),
          ...(element.actions?.readValue ? ["read_value"] : []),
          ...(element.actions?.scroll ? ["scroll"] : []),
        ];
        const mapped = {
          elementToken: element.ref, elementIndex: BigInt(index),
          ...(parentIndex !== undefined ? { parentIndex } : {}),
          depth: element.depth, role: element.role, label: normalizeAccessibleLabel(element.label) ?? "", enabled: element.enabled, actions,
          frame: { x: element.rect.x, y: element.rect.y, w: element.rect.width, h: element.rect.height },
        } as unknown as CuaWindowElement;
        return { native: element, mapped };
      });
      pushObservationGeneration(observedElements, observationKey, new Map(elements.map(({ native, mapped }) => [native.ref, mapped])));
      pushObservationGeneration(nativeObservedElements, observationKey, new Map(structure.elements.map((element) => [element.ref, element])));
      nativeObservedComplete.set(observationKey, structure.status === "complete" && !structure.truncated);
      while (observedElements.size > 64) observedElements.delete(observedElements.keys().next().value!);
      while (nativeObservedElements.size > 64) {
        const oldest = nativeObservedElements.keys().next().value!;
        nativeObservedElements.delete(oldest);
        nativeObservedComplete.delete(oldest);
      }
      return { structure, elements };
    };

    const captureNativeFrame = async (): Promise<CuaStageWindowFrame> => {
      const timing = timingContext.getStore();
      const image = await timed(timing?.afterDispatch ? "post-action-observation" : "window-capture",
        () => manager.captureWindow(pid, windowId.toString()), { detail: "scope=registered-window" });
      return { dataUrl: image.dataUrl, width: image.width, height: image.height,
        windowBounds: boundsAtWindowCapture(image), capturedAt: now().toISOString(), stageName: stage.name,
        identityKey: cursorDetails?.key ?? session };
    };

    const captureNativeWindowWithStructure = async (): Promise<{
      frame: CuaStageWindowFrame;
      observed?: Awaited<ReturnType<typeof readNativeElements>>;
    }> => {
      // Both observations are read-only and independently anchored to the same
      // registered HWND. Start them together so a slow screenshot encoder does
      // not make the UIA walk wait (or vice versa). The tree may still change
      // while either observation is in flight; every mutating action re-resolves
      // its selected node immediately before dispatch, so this overlap does not
      // relax the stale-target guard.
      const [imageFrame, observed] = await Promise.all([
        captureNativeFrame(),
        readNativeElements().catch(() => undefined),
      ]);
      const bounds = imageFrame.windowBounds!;
      const image = { dataUrl: imageFrame.dataUrl, width: imageFrame.width, height: imageFrame.height };
      let controls: CuaStageTargetDescription[] = [];
      let controlsTruncated = false;
      if (observed) {
        controls = observed.structure.elements.flatMap((element) => {
          const left = Math.max(0, (element.rect.x - bounds.x) * image.width / bounds.width);
          const top = Math.max(0, (element.rect.y - bounds.y) * image.height / bounds.height);
          const right = Math.min(image.width, (element.rect.x + element.rect.width - bounds.x) * image.width / bounds.width);
          const bottom = Math.min(image.height, (element.rect.y + element.rect.height - bounds.y) * image.height / bounds.height);
          if (element.enabled === false || ![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return [];
          const label = normalizeAccessibleLabel(element.label);
          return [{ ...(label ? { label } : {}), ...(element.role ? { role: element.role } : {}),
            rect: { x: left, y: top, width: right - left, height: bottom - top } }];
        });
        controlsTruncated = observed.structure.truncated;
      }
      return { frame: { ...imageFrame, controls,
        ...(controlsTruncated ? { controlsTruncated: true as const } : {}),
      }, ...(observed ? { observed } : {}) };
    };
    const captureNativeWindow = async (): Promise<CuaStageWindowFrame> => (await captureNativeWindowWithStructure()).frame;

    const captureOwnedPopups = async () => {
      const ownedPopups: NonNullable<CuaStageCapture["ownedPopups"]> = [];
      let popupCaptureStatus: "complete" | "unavailable" = "complete";
      try {
        const timing = timingContext.getStore();
        const popups = await timed("accessibility-read", () => manager.ownedPopups(pid, windowId.toString()),
          { detail: `scope=owned-popups;point=${timing?.afterDispatch ? "post-dispatch" : "pre-dispatch"}` });
        // The first list is the ownership snapshot for this observation. A
        // second full popup enumeration before every screenshot serialized N
        // helper round-trips without strengthening input safety (popup input
        // independently rechecks ownership immediately before dispatch).
        const captured = await Promise.all(popups.map(async (popup) => {
          try {
            const currentTiming = timingContext.getStore();
            const image = await timed(currentTiming?.afterDispatch ? "post-action-observation" : "window-capture",
              () => manager.captureWindow(pid, popup.windowId), { detail: "scope=owned-popup" });
            return { dataUrl: image.dataUrl, width: image.width, height: image.height,
              capturedAt: now().toISOString(), coordinateSpace: "popup-local" as const };
          } catch {
            popupCaptureStatus = "unavailable";
            return undefined;
          }
        }));
        ownedPopups.push(...captured.filter((popup): popup is NonNullable<typeof popup> => popup !== undefined));
      } catch { popupCaptureStatus = "unavailable"; }
      return { ownedPopups, popupCaptureStatus };
    };

    const capture = async (): Promise<CuaStageWindowFrame> => {
      const [frame, popups] = await Promise.all([captureNativeWindow(), captureOwnedPopups()]);
      return { ...frame, ...popups };
    };

    const readStructure = async (): Promise<CuaStageStructure> => {
      const { frame, observed } = await captureNativeWindowWithStructure();
      const capturedAt = frame.capturedAt ?? now().toISOString();
      if (observed) {
        const { structure, elements } = observed;
        return {
          status: structure.status === "partial" || structure.truncated ? "partial" : "complete",
          coverage: contentCoverage("window", elements.map(({ mapped }) => mapped)),
          capturedAt,
          ...(frame.windowBounds ? { screenRect: frame.windowBounds } : {}),
          elements: elements.map(({ native, mapped }) => ({
            ref: native.ref, depth: native.depth, role: native.role, label: normalizeAccessibleLabel(native.label) ?? "", enabled: native.enabled, focused: native.focused,
            ...(typeof native.selected === "boolean" ? { selected: native.selected } : {}),
            actions: mapped.actions, ...(native.actions?.setValue ? { canReplaceValue: true } : {}),
            ...(native.actions?.readValue ? { canReadValue: true } : {}),
            ...(native.scroll ? { scroll: native.scroll } : {}),
            rect: { x: (native.rect.x - frame.windowBounds!.x) * frame.width / frame.windowBounds!.width,
              y: (native.rect.y - frame.windowBounds!.y) * frame.height / frame.windowBounds!.height,
              width: native.rect.width * frame.width / frame.windowBounds!.width,
              height: native.rect.height * frame.height / frame.windowBounds!.height },
          })),
          fallbackCapture: stageCapture({ ...frame, ...await captureOwnedPopups() }, now),
        };
      }
      return { status: "unavailable", coverage: contentCoverage("window"), capturedAt,
        ...(frame.windowBounds ? { screenRect: frame.windowBounds } : {}),
        elements: [], fallbackCapture: stageCapture({ ...frame, ...await captureOwnedPopups() }, now) };
    };

    const hitTarget = async (x: number, y: number, action?: "click" | "set_value") => timed("target-resolution", async () => {
      const { frame, observed } = await captureNativeWindowWithStructure();
      const bounds = frame.windowBounds;
      if (!bounds || !observed) return undefined;
      if (bounds.width <= 0 || bounds.height <= 0) return undefined;
      const screenX = bounds.x + x * bounds.width / frame.width;
      const screenY = bounds.y + y * bounds.height / frame.height;
      const elements = observed.elements.map(({ mapped }) => mapped);
      return elementAtScreenPoint(elements, screenX, screenY, action === undefined ? undefined
        : (element) => action === "set_value" ? element.actions?.includes("set_value") === true
          : element.actions?.some((name) => /^(?:click|invoke|press|expand|toggle|select)$/i.test(name)) === true);
    }, { detail: `source=accessibility-tree;action=${action ?? "point"}` });

    const elementByToken = async (token: string, expected?: { role?: string; label?: string; allowDisabled?: boolean }) => {
      const observed = findInObservationHistory(nativeObservedElements, observationKey, token);
      if (!observed) return undefined;
      const normalizedLabel = normalizeAccessibleLabel(observed.label) ?? "";
      if ((expected?.role !== undefined && observed.role !== expected.role)
        || (expected?.label !== undefined && normalizedLabel !== expected.label)) return undefined;
      const { structure, elements } = await readNativeElements();
      const candidates = structure.elements.filter((candidate) => sameNativeControlEpoch(observed, candidate));
      const current = candidates.length === 1 ? candidates[0] : undefined;
      if (!current || (current.enabled === false && expected?.allowDisabled !== true)) return undefined;
      const fresh = elements.find(({ native }) => native === current);
      if (!fresh) return undefined;
      // UIA BoundingRectangle is already expressed in screen coordinates.
      // Keep cursor presentation on that semantic geometry and do not take an
      // extra screenshot just to convert a ref into a cursor point. A fresh
      // frame is captured later only if a pixel fallback actually needs one.
      return { element: { ...fresh.mapped, elementToken: token } as CuaWindowElement,
        screenRect: current.rect, nativeElement: current };
    };

    const elementAt = async (x: number, y: number) => (await hitTarget(x, y))?.elementToken;
    const observedElementByToken = (token: string, expected?: { role?: string; label?: string }) => {
      const observed = findInObservationHistory(observedElements, observationKey, token);
      if (!observed || (expected?.role !== undefined && observed.role !== expected.role)
        || (expected?.label !== undefined && normalizeAccessibleLabel(observed.label) !== expected.label)) return undefined;
      return observed;
    };
    const observedNativeElementByToken = (token: string, expected?: { role?: string; label?: string }) => {
      const observed = findInObservationHistory(nativeObservedElements, observationKey, token);
      if (!observed || (expected?.role !== undefined && observed.role !== expected.role)
        || (expected?.label !== undefined && normalizeAccessibleLabel(observed.label) !== expected.label)) return undefined;
      return observed;
    };
    const captureTarget = async (x: number, y: number): Promise<CuaStageTargetDescription | undefined> => {
      // This description is used immediately before a coordinate click to
      // decide whether the readable control label requires owner approval. A
      // full accessibility-tree walk is unnecessary here: UIA's native
      // ElementFromPoint is the exact target-resolution mechanism, and avoids
      // sending thousands of unrelated controls just to inspect one point.
      // Only bounds/width/height (never pixels) are used below, so read
      // geometry alone rather than paying for a PrintWindow/BitBlt capture
      // whose image is discarded; windowRect and window-capture derive their
      // bounds from the same GetWindowRect call, so this is the same
      // coordinate space.
      const windowGeometry = await timed("target-resolution", () => manager.windowRect(pid, windowId.toString()), { detail: "scope=target-resolution" });
      const image = { width: windowGeometry.width, height: windowGeometry.height };
      const bounds = windowGeometry;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) {
        throw new DesktopInputNotDispatchedError("Target coordinates must fall inside the current stage window snapshot.");
      }
      if (bounds.width <= 0 || bounds.height <= 0) return undefined;
      const screenX = bounds.x + Math.floor((x + 0.5) * bounds.width / image.width);
      const screenY = bounds.y + Math.floor((y + 0.5) * bounds.height / image.height);
      let hit: NativePointControl;
      try { hit = await timed("target-resolution", () => manager.pointControl(screenX, screenY), { detail: "source=uia-element-at-point" }); }
      catch { return undefined; }
      const rect = {
        x: (hit.rect.x - bounds.x) * image.width / bounds.width,
        y: (hit.rect.y - bounds.y) * image.height / bounds.height,
        width: hit.rect.width * image.width / bounds.width,
        height: hit.rect.height * image.height / bounds.height,
      };
      return {
        ...(normalizeAccessibleLabel(hit.label) ? { label: normalizeAccessibleLabel(hit.label)! } : {}),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    };

    return timingContext.run({ stageName: stage.name, afterDispatch: false }, () => run({ driver, sdk, session, pid, windowId,
      captureFrame: captureNativeFrame, capture, readStructure, elementAt, elementAtPoint: hitTarget,
      observedElementByToken, observedNativeElementByToken,
      observedNativeElements: () => nativeObservedComplete.get(observationKey)
        ? [...(latestObservationGeneration(nativeObservedElements, observationKey)?.values() ?? [])] : [],
      elementByToken, captureTarget }));
  }

  async function capture(name: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageCapture> {
    return withRegisteredWindow(name, async ({ capture: captureWindow }) => stageCapture(await captureWindow(), now), cursorIdentity);
  }

  async function readStructure(name: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageStructure> {
    return withRegisteredWindow(name, async ({ readStructure: read }) => read(), cursorIdentity);
  }

  async function readElementValue(name: string, ref: string, cursorIdentity?: CuaAgentCursorIdentity,
    options: { expectedRole?: string; expectedLabel?: string; maxChars?: number } = {}): Promise<{
      status: "read" | "redacted"; value?: string; truncated?: boolean;
    }> {
    const maxChars = options.maxChars ?? 512;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 4096) {
      throw new DesktopInputNotDispatchedError("The requested accessible-value limit must be from 1 to 4096 characters.");
    }
    return withRegisteredWindow(name, async ({ pid, windowId, elementByToken }) => {
      const selected = await elementByToken(ref, { role: options.expectedRole, label: options.expectedLabel, allowDisabled: true });
      if (!selected?.nativeElement || !selected.nativeElement.actions?.readValue) {
        throw new DesktopInputNotDispatchedError("The exact observed control is stale, unavailable, or does not expose a readable non-password UI Automation value.", "target-identity");
      }
      const observed = await manager.invokeWindowElement(pid, windowId.toString(), {
        path: selected.nativeElement.path,
        action: "readValue",
        expectedRole: selected.nativeElement.role,
        expectedLabel: selected.nativeElement.label,
        expectedClassName: selected.nativeElement.className,
        expectedAutomationId: selected.nativeElement.automationId,
        maxChars,
      });
      if (observed.redacted) return { status: "redacted" };
      if (!observed.read || typeof observed.value !== "string") {
        throw new DesktopInputNotDispatchedError("The exact UI Automation value could not be read; no input was sent.", "target-identity");
      }
      return { status: "read", value: observed.value, truncated: observed.truncated === true };
    }, cursorIdentity);
  }

  async function moveCursor(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity): Promise<{ capture: CuaStageCapture; cursor: CuaStageCursorProof }> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) throw new Error("Cursor coordinates must be non-negative whole screenshot pixels.");
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const captured = await captureWindow();
      if (x >= captured.width || y >= captured.height) throw new Error("Cursor coordinates must fall inside the current stage window snapshot.");
      const cursor = await moveAndVerifyCursor({ session, pid, windowId }, x, y, captured, true);
      return {
        capture: stageCapture(captured, now),
        cursor,
      };
    }, cursorIdentity);
  }

  async function describeTarget(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageTargetDescription | undefined> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) throw new Error("Target coordinates must be non-negative whole screenshot pixels.");
    return withRegisteredWindow(name, async ({ captureTarget }) => captureTarget(x, y), cursorIdentity);
  }

  /**
   * Same purpose as describeTarget (feeding the money gate a real label before a
   * click is allowed through), but for click_element, which has no x/y at all --
   * only a ref. click_element and middle_click skipping the money gate entirely
   * was a real, confirmed security gap: an element-ref click or a middle click on
   * a payment-shaped control went through with no owner approval whatsoever.
   */
  async function describeElementTarget(name: string, ref: string, expected: { role?: string; label?: string }, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageTargetDescription | undefined> {
    return withRegisteredWindow(name, async ({ observedElementByToken }) => {
      // The money gate is deciding whether this previously observed control
      // needs owner review. Its semantic label is already in the ref's
      // observation cache; rereading UIA here duplicated the live resolution
      // the click path performs immediately before dispatch.
      const element = observedElementByToken(ref, expected);
      if (!element) return undefined;
      const description: CuaStageTargetDescription = {};
      const label = normalizeAccessibleLabel(element.label);
      if (label) description.label = label;
      if (typeof element.role === "string" && element.role.trim()) description.role = element.role.slice(0, 40);
      const rect = element.frame;
      if (rect && rect.w > 0 && rect.h > 0) description.rect = { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
      return description;
    }, cursorIdentity);
  }

  /** Only a direct ValuePattern mutation can safely reserve one control rather than its whole window. */
  async function valueMutationRegion(name: string, ref: string, expected: { role?: string; label?: string }, cursorIdentity?: CuaAgentCursorIdentity): Promise<string | undefined> {
    return withRegisteredWindow(name, async ({ observedNativeElementByToken, observedNativeElements }) => {
      const element = observedNativeElementByToken(ref, expected);
      return element ? nativeValueControlRegion(element, observedNativeElements(), true) : undefined;
    }, cursorIdentity);
  }
  async function observedValueMutationRegions(name: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<string[]> {
    return withRegisteredWindow(name, async ({ observedNativeElements }) => {
      // Reuse the exact observation. A second walk here would invalidate the refs
      // being returned to the agent and incorrectly bless a different snapshot.
      const elements = observedNativeElements();
      return [...new Set(elements.map((element) => nativeValueControlRegion(element, elements, true))
        .filter((region): region is string => Boolean(region)))];
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
    const captured = await captureOwnerDesktop(name, identity, true);
    // Native desktop enumeration and window-scoped UIA are the production
    // structure route. A Cua inventory is available only to injected tests or
    // an explicit compatibility opt-in; it is never silently selected after a
    // native observation failure in the shipped broker.
    try {
      const visible = await timed("accessibility-read", () => manager.listVisibleWindows(),
        { stageName: name, detail: "source=visible-window-inventory" });
      const origin = captured.origin ?? { x: 0, y: 0 };
      const screen = { width: captured.width, height: captured.height };
      const desktop = await timed("accessibility-read", () => manager.desktopStructure({ maxElements: MAX_DESKTOP_STRUCTURE_ELEMENTS, maxDepth: 64 })
        .catch(() => undefined), { stageName: name, detail: "scope=desktop-tree" });
      const current = await manager.currentForegroundWindow().catch(() => undefined);
      const windows: CuaDesktopStructureWindow[] = [];
      const elements: CuaDesktopStructureElement[] = [];
      let nativeElementsTruncated = false;
      const rankedVisible = [...visible].sort((left, right) => {
        const leftFrontmost = current && current.pid === left.pid && current.windowId === left.windowId ? 1 : 0;
        const rightFrontmost = current && current.pid === right.pid && current.windowId === right.windowId ? 1 : 0;
        if (leftFrontmost !== rightFrontmost) return rightFrontmost - leftFrontmost;
        return (right.width * right.height) - (left.width * left.height);
      });
      for (let index = 0; index < rankedVisible.length; index++) {
        const item = rankedVisible[index]!;
        if (/m9r(?:[- ]overlay)?|agent cursor overlay|cua cursor overlay/i.test(`${item.className ?? ""} ${item.title}`)) continue;
        const x = Number.isFinite(item.x) ? item.x! : 0;
        const y = Number.isFinite(item.y) ? item.y! : 0;
        const screenRect = { x, y, width: item.width, height: item.height };
        const rect = { x: x - origin.x, y: y - origin.y, width: item.width, height: item.height };
        if (rect.width <= 0 || rect.height <= 0 || rect.x + rect.width <= 0 || rect.y + rect.height <= 0
          || rect.x >= screen.width || rect.y >= screen.height) continue;
        const ref = `desktop-window-${windows.length + 1}`;
        let status: CuaDesktopStructureWindow["status"] = "unavailable";
        let coverage: CuaContentCoverage = contentCoverage("window");
        const windowElements: CuaDesktopStructureElement[] = [];
        try {
          const structure = await timed("accessibility-read", () => manager.windowStructure(item.pid, item.windowId, { maxElements: 512, maxDepth: 24 }),
            { stageName: name, detail: "scope=desktop-window;maxElements=512;maxDepth=24" });
          status = structure.status === "complete" ? "complete" : "partial";
          const observedCoverage = contentCoverage("window", structure.elements.map((element) => ({
            role: element.role,
            actions: Object.entries(element.actions ?? {}).filter(([, enabled]) => enabled).map(([action]) => action),
          })));
          coverage = structure.status === "complete"
            ? observedCoverage
            : { ...observedCoverage, offscreenContent: "possible" };
          for (const element of structure.elements) {
            const er = element.rect;
            const mapped = er ? { x: er.x - origin.x, y: er.y - origin.y, width: er.width, height: er.height } : undefined;
            const elementRef = `${ref}:${element.ref}`;
            const publicElement: CuaDesktopStructureElement = {
              ref: elementRef, windowRef: ref,
              ...(mapped ? { rect: mapped } : {}),
              depth: element.depth, role: element.role || undefined, label: normalizeAccessibleLabel(element.label),
              enabled: element.enabled, ...(element.focused ? { selected: true } : {}),
              ...(element.actions ? { actions: Object.entries(element.actions).filter(([, enabled]) => enabled).map(([action]) => action) } : {}),
            };
            windowElements.push(publicElement);
            if (elements.length < MAX_DESKTOP_STRUCTURE_ELEMENTS) elements.push(publicElement);
            else nativeElementsTruncated = true;
          }
        } catch {
          // Preserve the visible window even if one app's UIA provider fails.
          // Its exact screenshot remains available in the returned fallback.
        }
        windows.push({ ref, appName: (item.processName ?? item.className ?? "").slice(0, 120), title: item.title.slice(0, 240), rect, screenRect,
          ...(current && current.pid === item.pid && current.windowId === item.windowId ? { frontmost: true } : {}),
          minimized: false, status, coverage, elements: windowElements });
      }
      const shellElements = desktop?.elements.map((element) => ({
        ref: `desktop-shell:${element.ref}`, windowRef: "desktop-shell", rect: { x: element.rect.x - origin.x, y: element.rect.y - origin.y, width: element.rect.width, height: element.rect.height },
        depth: element.depth, role: element.role, label: normalizeAccessibleLabel(element.label) ?? "", enabled: element.enabled,
      } as CuaDesktopStructureElement)) ?? [];
      const combinedElements = [...shellElements, ...elements];
      const allElements = combinedElements.slice(0, MAX_DESKTOP_STRUCTURE_ELEMENTS);
      const allElementsTruncated = nativeElementsTruncated || combinedElements.length > allElements.length;
      return { scope: "desktop", status: allElementsTruncated || desktop?.status === "partial" || windows.some((window) => window.status !== "complete") ? "partial" : "complete",
        coverage: aggregateDesktopCoverage(windows), capturedAt: captured.capturedAt, windows, elements: allElements,
        shell: desktop ? { status: desktop.status,
          reason: desktop.truncated || allElementsTruncated ? "Native desktop UIA structure reached its documented element bound; the screenshot remains available for the rest." : "Native desktop UIA tree captured.",
          ...(desktop.truncated || allElementsTruncated ? { truncated: true as const } : {}) }
          : { status: "unavailable", reason: "Native desktop shell UIA was unavailable." },
        fallbackCapture: captured };
    } catch (error) {
      return {
        scope: "desktop",
        status: "unavailable",
        coverage: aggregateDesktopCoverage([]),
        capturedAt: captured.capturedAt,
        windows: [],
        elements: [],
        shell: { status: "unavailable", reason: `Native desktop UI Automation failed; the current screenshot remains available. ${error instanceof Error ? error.message : String(error)}` },
        fallbackCapture: captured,
      };
    }
  }
  async function describeDesktopTarget(name: string, x: number, y: number, cursorIdentity: CuaAgentCursorIdentity): Promise<CuaStageTargetDescription | undefined> {
    return withOwnerDesktop(name, cursorIdentity, async ({ capture }) => {
      if (!validPoint(x, y, capture)) throw new DesktopInputNotDispatchedError("Desktop coordinates must fall inside the latest desktop screenshot.");
      const origin = capture.origin ?? { x: 0, y: 0 };
      let control: NativePointControl;
      try { control = await timed("target-resolution", () => (deps.pointControl ?? manager.pointControl)(origin.x + x, origin.y + y),
        { detail: "source=uia-element-at-point" }); }
      catch { return undefined; }
      const label = normalizeAccessibleLabel(control.label);
      return {
        ...(label ? { label } : {}),
        rect: { x: control.rect.x - origin.x, y: control.rect.y - origin.y,
          width: control.rect.width, height: control.rect.height },
      };
    });
  }
  async function moveDesktopCursor(name: string, x: number, y: number, identity: CuaAgentCursorIdentity) {
    const result = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture);
      await inspectOwnerDesktop(name, identity);
      // The overlay is presentation only. A missing/late cursor must not
      // prevent a correctly resolved native click from being dispatched.
      const cursor = await moveOwnerCursor(session, point, true);
      await inspectOwnerDesktop(name, identity);
      return { capture: stageCapture(capture, now), cursor };
    });
    // Moving the synthetic cursor does not change desktop pixels or invalidate
    // the immutable capture used to bind the next coordinate action.
    return result;
  }

  async function clickDesktop(name: string, x: number, y: number, identity: CuaAgentCursorIdentity, options: CuaDesktopClickOptions = {}) {
    const result = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new DesktopInputNotDispatchedError("Click coordinates must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture, undefined, false);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(session, point);
      await inspectOwnerDesktop(name, identity);
      if (point.shellControl) {
        if (options.button === "right" || options.button === "middle" || (options.count ?? 1) !== 1) throw new DesktopInputNotDispatchedError("This shell control supports accessibility activation, not a synthetic non-left click.");
        const activated = await timedInputDispatch("uia-point", () => (deps.pointControl ?? manager.pointControl)(
          point.screenPoint.x, point.screenPoint.y, point.shellControl), (result) => result.confirmed === true);
        if (activated.confirmed === true && point.nativeKeyboardWindow === true) rememberDesktopInputTarget(name, identity, point.target);
        // Invocation is acknowledged, but the changed desktop capture proves
        // whether the app opened. Never bind keyboard input to the taskbar.
        return { status: "unverified" as const, summary: "Windows acknowledged exact shell control invocation; verify the returned capture." };
      }
      if (!options.confirmFocusForeground && (options.button === undefined || options.button === "left") && (options.count ?? 1) === 1) {
        // UIA's point hit-test is authoritative for a coordinate action. A
        // smallest-rectangle search can select an overlapping sibling (for
        // example, a popup suggestion over a page control), so only invoke the
        // exact live hit if it belongs to the HWND resolved from this point.
        let control: Awaited<ReturnType<typeof manager.pointControl>> | undefined;
        try { control = await timed("target-resolution", () => manager.pointControl(point.screenPoint.x, point.screenPoint.y),
          { detail: "source=uia-element-at-point" }); }
        catch { /* an inspection miss has dispatched no input; physical fallback remains available */ }
        // A control without InvokePattern will fail every invoke attempt, not
        // just sometimes (T276: 5 identical failures on Chrome's address
        // bar, each misread as an ambiguous "uncertain" outcome that blocks
        // a safe fallback). The uninvoked inspection above already reports
        // this; skip the doomed attempt instead of paying its full
        // dispatch-and-verify round trip for a known outcome.
        if (control?.windowPid === point.target.pid && control.windowId === point.target.windowId.toString()
          && control.supportsInvoke !== false) {
          try {
            const invoked = await timedInputDispatch("uia-point", () => manager.pointControl(point.screenPoint.x, point.screenPoint.y, control),
              (result) => result.invoked === true);
            if (invoked.invoked) {
              rememberDesktopInputTarget(name, identity, point.target);
              return { status: "unverified" as const,
                summary: "Native UI Automation invoked the exact control under the observed point; the refreshed desktop capture is the separate effect check." };
            }
          } catch (error) {
            // Retry through physical input only when the native layer proved
            // the semantic attempt sent nothing. An uncertain result must be
            // observed, never replayed.
            if (!(error instanceof DesktopInputNotDispatchedError)) throw error;
          }
        }
      }
      // Element tokens are observation metadata, not an input transport. The
      // native sender owns the actual click and uses the already verified
      // window-local point; this keeps semantic clicks from silently falling
      // back into the vendored Cua action endpoint.
      const outcome = await driverInputAction("click", {
        pid: point.target.pid,
        window_id: Number(point.target.windowId),
        x: point.localPoint.x, y: point.localPoint.y,
        button: options.button === "right" ? "right" : options.button === "middle" ? "middle" : "left",
        count: options.count ?? 1,
        session: session.session,
      }, "Cua Driver could not click the exact window under the agent cursor.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeHeadless: nativeWindowClick(point.target.pid, point.target.windowId,
          point.screenPoint.x, point.screenPoint.y, {
            ...(options.button ? { button: options.button } : {}), ...(options.count ? { count: options.count } : {}),
          }),
        nativeForeground: nativeStageInput(point.target.pid, point.target.windowId, async () => {
            const screen = await desktopPointToCurrentScreen(point);
            await manager.sendClick(point.target.pid, point.target.windowId.toString(), screen.x, screen.y, {
              ...(options.button ? { button: options.button } : {}),
              ...(options.count ? { count: options.count } : {}),
            });
          }),
      });
      // SendInput acceptance is not semantic app confirmation, but it does
      // establish the exact window the owner-visible click targeted. Preserve
      // that HWND so a subsequent key/type action can independently revalidate
      // it and acquire the normal foreground lease. Never infer that the app
      // changed state from this bookkeeping.
      //
      // This used to only attach `.field` when the clicked element's role matched
      // a narrow allowlist (Document/Edit/TextField/TextArea/ComboBox with
      // set_value). That gate meant the refocus-before-type step in typeText()/
      // pressKey()/hotkey() (which only fires when `.field` is set) silently did
      // nothing whenever a click landed on something UIA didn't classify that way
      // -- confirmed live via Paint's Text tool (T324): the click that placed a
      // *new* text box on Paint's raw canvas wasn't recognized as one of those
      // roles (no stable UIA element exists for a transient canvas text-entry
      // overlay), so no `.field` was stored, the refocus click before typing was
      // skipped, and the subsequent raw-foreground SendInput typed into whatever
      // already had OS focus instead of the just-clicked spot -- the text never
      // appeared. `.field` is documented as "an exact accessibility field [that]
      // does not depend on system keyboard focus", not as "a field we're sure is
      // a text input" -- always remember the click's exact point so the refocus
      // step runs for every click, not just the ones UIA happens to label a
      // known text-control role.
      rememberDesktopInputTarget(name, identity, { ...point.target, field: {
        ...point.screenPoint, label: point.element?.label, role: point.element?.role,
      } });
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true, true), outcome: result };
  }

  async function typeTextDesktop(name: string, text: string, identity: CuaAgentCursorIdentity, options: CuaStageTextOptions = {}) {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new DesktopInputNotDispatchedError(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    const delayMs = normalizeTypeDelayMs(options.delayMs);
    // This desktop-wide route ignored `options.mode` entirely before, always using
    // whatever field a prior click remembered regardless of what the caller asked
    // for -- the same "replace never replaces" bug as the app-window route, fixed
    // the same way: look up the real field at the given point and replace its
    // value directly, instead of silently reusing an unrelated remembered target.
    if (options.mode === "replace") {
      if (options.x === undefined || options.y === undefined) throw new DesktopInputNotDispatchedError("Replace mode requires an exact field point; no text was sent.");
      const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
        await inspectOwnerDesktop(name, identity);
        const point = await resolveOwnerDesktopPoint(runtime, session, options.x!, options.y!, capture, undefined, true);
        const element = point.element;
        if (!element?.elementToken || element.enabled === false || !element.actions?.includes("set_value")) {
          throw new DesktopInputNotDispatchedError("No replaceable text field was found at the given point; no text was sent.");
        }
        if ((options.expectedRole !== undefined && element.role !== options.expectedRole)
          || (options.expectedLabel !== undefined && element.label !== options.expectedLabel)) {
          throw new DesktopInputNotDispatchedError("The field at the given point could not be confirmed as the same one you observed; no text was sent.");
        }
        await inspectOwnerDesktop(name, identity);
        await moveOwnerCursor(session, point);
        await inspectOwnerDesktop(name, identity);
        forgetDesktopInputTarget(name, identity);
        return nativeReplaceTextAtScreenPoint(point.target.pid, point.target.windowId, point.screenPoint.x, point.screenPoint.y, text,
          { session: session.session, signal: options.signal, deliveryMode: options.deliveryMode,
            preferForeground: options.confirmFocusForeground, allowForegroundEscalation: options.allowForegroundEscalation });
      });
      invalidateDesktopCaptures();
      return { capture: await captureOwnerDesktop(name, identity, true, true), outcome };
    }
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        if (selected.field) {
          const point = await resolveOwnerWindowPoint(runtime, session, selected.field);
          if (point.target.pid !== selected.pid || point.target.windowId !== selected.windowId) {
            throw new DesktopInputNotDispatchedError("The selected text field moved to another application window; no keyboard input was sent.");
          }
          await inspectOwnerDesktop(name, identity);
          await moveOwnerCursor(session, {
            ...point,
            desktopPoint: { x: selected.field.x, y: selected.field.y },
            screenPoint: { x: selected.field.x, y: selected.field.y },
          });
          await inspectOwnerDesktop(name, identity);
        }
        return await deliverTextToExactWindow({ session: session.session, pid: selected.pid,
          windowId: selected.windowId, selected, text, delayMs, preferForeground: options.confirmFocusForeground,
          deliveryMode: options.deliveryMode, allowForegroundEscalation: options.allowForegroundEscalation,
          nativeForeground: nativeStageInput(selected.pid, selected.windowId, () => manager.sendText(selected.pid, selected.windowId.toString(), text)),
          signal: options.signal });
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true, true), outcome };
  }

  async function scrollDesktop(name: string, x: number, y: number, direction: "up" | "down", identity: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new DesktopInputNotDispatchedError("Scroll coordinates must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const point = await resolveOwnerDesktopPoint(undefined, session, x, y, capture);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(session, point);
      await inspectOwnerDesktop(name, identity);
      const amount = Math.min(50, Math.max(1, Math.round(options.amount ?? 3)));
      const outcome = await driverInputAction("scroll", {
        pid: point.target.pid, window_id: Number(point.target.windowId), x: point.localPoint.x, y: point.localPoint.y,
        direction, by: "line", amount, session: session.session,
      }, "Cua Driver could not scroll the exact window under the agent cursor.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeHeadless: nativeWindowScroll(point.target.pid, point.target.windowId, point.screenPoint.x, point.screenPoint.y,
          direction === "up" ? amount : -amount),
        nativeForeground: nativeStageInput(point.target.pid, point.target.windowId, async () => {
            const screen = await desktopPointToCurrentScreen(point);
            await manager.sendScroll(point.target.pid, point.target.windowId.toString(), screen.x, screen.y, direction === "up" ? amount : -amount);
          }),
      });
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true, true), outcome };
  }

  async function scrollDeltaDesktop(name: string, x: number, y: number, deltaX: number, deltaY: number,
    unit: "pixel" | "line" | "page", identity: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}) {
    const scroll = scrollDeltaAmount(deltaX, deltaY, unit);
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new DesktopInputNotDispatchedError("Scroll coordinates must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const point = await resolveOwnerDesktopPoint(undefined, session, x, y, capture);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(session, point);
      await inspectOwnerDesktop(name, identity);
      const scrollScreenPoint = point.screenPoint;
      const scrollAmount = (scroll.direction === "up" || scroll.direction === "right") ? scroll.amount : -scroll.amount;
      const scrollAxis = (scroll.direction === "left" || scroll.direction === "right") ? "horizontal" : "vertical";
      return driverInputAction("scroll", {
        pid: point.target.pid, window_id: Number(point.target.windowId), x: point.localPoint.x, y: point.localPoint.y,
        direction: scroll.direction, by: scroll.by, amount: scroll.amount, session: session.session,
      }, "Cua Driver could not scroll the exact window under the agent cursor.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeHeadless: nativeWindowScroll(point.target.pid, point.target.windowId,
          scrollScreenPoint.x, scrollScreenPoint.y, scrollAmount, scrollAxis),
        nativeForeground: nativeStageInput(point.target.pid, point.target.windowId, async () => {
            const foregroundPoint = await desktopPointToCurrentScreen(point);
            await manager.sendScroll(point.target.pid, point.target.windowId.toString(), foregroundPoint.x, foregroundPoint.y,
              scrollAmount, scrollAxis);
          }),
      });
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true, true), outcome };
  }

  async function dragDesktop(name: string, fromX: number, fromY: number, toX: number, toY: number, identity: CuaAgentCursorIdentity, options: CuaStageDragOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(fromX, fromY, capture) || !validPoint(toX, toY, capture)) throw new DesktopInputNotDispatchedError("Both drag points must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const start = await resolveOwnerDesktopPoint(undefined, session, fromX, fromY, capture);
      const end = await resolveOwnerDesktopPoint(undefined, session, toX, toY, capture);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(session, start);
      await inspectOwnerDesktop(name, identity);
      const outcome = await driverInputAction("drag", {
        pid: start.target.pid, window_id: Number(start.target.windowId),
        from_x: start.localPoint.x, from_y: start.localPoint.y,
        to_x: end.localPoint.x, to_y: end.localPoint.y,
        duration_ms: options.durationMs ?? 500, steps: 10, session: session.session,
      }, "Cua Driver could not drag on the owner's current desktop.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(start.target.pid, start.target.windowId, async () => {
            const fromScreen = await desktopPointToCurrentScreen(start);
            const toScreen = await desktopPointToCurrentScreen(end);
            await manager.sendDrag(start.target.pid, start.target.windowId.toString(), fromScreen.x, fromScreen.y, toScreen.x, toScreen.y, options.durationMs ?? 500);
          }),
      });
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(session, end);
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true, true), outcome };
  }

  async function pressKeyDesktop(name: string, key: string, identity: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        return await driverInputAction("press_key", {
          pid: selected.pid, window_id: Number(selected.windowId), key, session: session.session,
        }, "Cua Driver could not press the requested key in the selected window.", {
          preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
          nativeForeground: nativeStageInput(selected.pid, selected.windowId, () => manager.sendKeyCombo(selected.pid, selected.windowId.toString(), [key])),
        });
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true, true), outcome };
  }

  async function hotkeyDesktop(name: string, keys: string[], identity: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        return await driverInputAction("hotkey", {
          pid: selected.pid, window_id: Number(selected.windowId), keys, session: session.session,
        }, "Cua Driver could not send the key combination to the selected window.", {
          preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
          nativeForeground: nativeStageInput(selected.pid, selected.windowId, () => manager.sendKeyCombo(selected.pid, selected.windowId.toString(), keys)),
        });
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true, true), outcome };
  }

  async function listWindowOptions(ownedPid?: number, onScreenOnly = ownedPid === undefined, sessionName?: string): Promise<CuaStageWindowOption[]> {
    if (ownedPid !== undefined && (!Number.isSafeInteger(ownedPid) || ownedPid < 1)) throw new Error("Invalid owned application process.");
    return listWindowOptionsOnce(ownedPid, onScreenOnly, sessionName);
  }

  async function listWindowOptionsOnce(ownedPid: number | undefined, onScreenOnly: boolean, _sessionName?: string): Promise<CuaStageWindowOption[]> {
    // App discovery and launch verification belong to M9R's native owner-side
    // window inventory. The old implementation loaded and queried the Cua
    // daemon on each launch path, so an overlay startup/inventory failure could
    // masquerade as an app-launch failure and stretch launch latency by tens of
    // seconds. The native list is already HWND/PID-bound and filters cloaked,
    // minimized, and non-visible windows at the OS boundary.
    const windows = ownedPid === undefined
      ? await manager.listVisibleWindows()
      : await manager.listOwnedWindowsForProcess(ownedPid);
    return windows
      .filter((window) => window.pid !== process.pid
        && (!onScreenOnly || (window.width >= 20 && window.height >= 20))
        && (window.title.trim().length > 0 || Boolean(window.processName?.trim()) || Boolean(window.className?.trim()))
        && !/m9r[- ]overlay|agent cursor overlay|cua cursor overlay/i.test(`${window.processName ?? ""} ${window.className ?? ""} ${window.title}`)
        && !/^m9r(?: overlay)?$/i.test(window.title.trim()))
      .map((window) => {
        const appName = window.processName?.trim() || window.className?.trim() || "Windows application";
        const title = window.title.trim() || appName;
        return {
          pid: window.pid,
          windowId: window.windowId,
          appName: appName.slice(0, 80),
          title: title.replace(/[\r\n\t]+/g, " ").slice(0, 160),
          width: Math.trunc(window.width),
          height: Math.trunc(window.height),
          isOnScreen: true,
          minimized: false,
          ...(Number.isSafeInteger(window.zOrder) ? { zIndex: BigInt(window.zOrder!).toString() } : {}),
        };
      });
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
    return listWindowOptions(ownedPid, true, name);
  }

  /**
   * Maps a capture-local point (screenshot pixels, the same space every
   * click/drag coordinate in this file is already given in) to a real
   * absolute screen point, using the window's own current screen bounds --
   * read directly from our native host, with no Cua Driver involvement.
   * Native SendInput dispatch always needs real screen coordinates; it has
   * no notion of "a point inside this app's screenshot."
   */
  async function localToScreenPoint(pid: number, windowId: bigint, localX: number, localY: number,
    captureWidth: number, captureHeight: number, fallbackBounds?: CuaStageWindowBounds): Promise<{ x: number; y: number }> {
    let rect: CuaStageWindowBounds;
    try { rect = await manager.windowRect(pid, windowId.toString()); }
    catch (error) {
      if (!fallbackBounds) {
        if (error instanceof DesktopInputNotDispatchedError) throw error;
        throw new DesktopInputNotDispatchedError(
          `The target window bounds could not be refreshed; no pointer input was sent. ${error instanceof Error ? error.message : String(error)}`,
          "target-identity",
        );
      }
      rect = fallbackBounds;
    }
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) {
      throw new DesktopInputNotDispatchedError("The target window bounds do not provide a valid screen coordinate space; no cursor position was confirmed.", "position-unconfirmed");
    }
    return {
      x: rect.x + Math.floor((localX + 0.5) * rect.width / captureWidth),
      y: rect.y + Math.floor((localY + 0.5) * rect.height / captureHeight),
    };
  }

  async function desktopPointToCurrentScreen(point: ResolvedDesktopPoint): Promise<{ x: number; y: number }> {
    // Desktop coordinates are first resolved into the exact hit window's own
    // screenshot space. Reproject with that screenshot's dimensions, never the
    // full desktop capture dimensions; otherwise a restored window's click is
    // scaled toward its upper-left corner.
    if (!point.windowCaptureSize) return point.screenPoint;
    return localToScreenPoint(point.target.pid, BigInt(point.target.windowId), point.localPoint.x, point.localPoint.y,
      point.windowCaptureSize.width, point.windowCaptureSize.height);
  }

  async function click(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity, options: CuaDesktopClickOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      // Only geometry is needed before dispatch (bounds-check the point,
      // reproject it to screen space); a full captureFrame() here would pay
      // for a PrintWindow/BitBlt pixel capture whose pixels are never
      // examined. windowRect and the window-capture path both derive their
      // bounds from the same GetWindowRect call (native_screenshot.rs), so
      // this is the identical coordinate space at a fraction of the cost.
      const rect = await timed("target-resolution", () => manager.windowRect(pid, windowId.toString()), { detail: "source=window-rect" });
      const before: CuaStageWindowFrame = { dataUrl: "", width: rect.width, height: rect.height, windowBounds: rect };
      if (!validPoint(x, y, before)) throw new DesktopInputNotDispatchedError("Click coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ session, pid, windowId }, x, y, before);
      // A coordinate click means the observed point, not the smallest
      // accessibility rectangle that overlaps it. Overlapping UIA siblings
      // (autocomplete popups, menus, embedded browser views) can make a tree
      // bounding-box heuristic activate a different control than the agent
      // selected. First let UIA hit-test and activate the exact live control at
      // that screen point (a headless action); if it has no semantic action,
      // the owner-visible route falls through to native pointer input.
      let targetScreenPoint: { x: number; y: number } | undefined;
      if (!options.confirmFocusForeground && (options.button === undefined || options.button === "left") && (options.count ?? 1) === 1) {
        targetScreenPoint = await localToScreenPoint(pid, windowId, x, y, before.width, before.height, before.windowBounds);
        let control: NativePointControl | undefined;
        try { control = await timed("target-resolution", () => manager.pointControl(targetScreenPoint!.x, targetScreenPoint!.y),
          { detail: "source=uia-element-at-point" }); }
        catch { /* an inspection miss sends nothing; the owner-visible fallback remains available */ }
        // supportsInvoke === false (a raw drawing surface like Paint's canvas:
        // plain pixels, no accessible children) means UIA itself already
        // knows this control has no semantic action. Attempting the
        // invocation anyway risks an ambiguous native outcome that can't
        // safely fall through to the pointer-input route below; skip straight
        // to it instead, the same way the shellControl branch above does.
        if (control?.pid === pid && control.windowPid === pid && control.windowId === windowId.toString() && control.supportsInvoke !== false) {
          try {
            const invoked = await timedInputDispatch("uia-point", () => manager.pointControl(targetScreenPoint!.x, targetScreenPoint!.y, control),
              (result) => result.invoked === true);
            if (invoked.invoked) {
              return { capture: stageCapture(await captureWindow(), now), outcome: {
                status: "unverified" as const,
                summary: "Native UI Automation activated the exact control at the observed point; the refreshed window capture is the separate effect check.",
              } };
            }
          } catch (error) {
            // A semantic invocation can only fall through when native code
            // proves it dispatched no input. Unknown outcomes are never replayed.
            if (!(error instanceof DesktopInputNotDispatchedError)) throw error;
          }
        }
      }
      targetScreenPoint ??= await localToScreenPoint(pid, windowId, x, y, before.width, before.height, before.windowBounds);
      const outcome = await driverInputAction("click", {
        pid,
        window_id: Number(windowId),
        x, y,
        ...(options.button ? { button: options.button === "right" ? "right" : options.button === "middle" ? "middle" : "left" } : {}),
        ...(options.count ? { count: options.count } : {}),
        session,
      }, "Cua Driver could not click the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeHeadless: nativeWindowClick(pid, windowId, targetScreenPoint.x, targetScreenPoint.y, {
          ...(options.button ? { button: options.button } : {}), ...(options.count ? { count: options.count } : {}),
        }),
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            await manager.sendClick(pid, windowId.toString(), targetScreenPoint!.x, targetScreenPoint!.y, {
              ...(options.button ? { button: options.button } : {}),
              ...(options.count ? { count: options.count } : {}),
            });
          }),
      });
      // A coordinate click has no stable semantic field identity -- never infer
      // one from an overlapping UIA rectangle, and ref-based field actions keep
      // their exact identity through clickElement/replaceElement regardless.
      // But the plain screen point this click just landed on IS worth keeping:
      // "keyboard delivery follows the OS focus established by the click" does
      // not hold for a window hosting a modern XAML/WinUI island (confirmed
      // live, T324, Paint's Text tool) -- the posted click that places a new
      // text field there doesn't reliably move focus through WinUI's own
      // pointer/focus routing the way real hardware input does, so a later
      // typeText() for the SAME click can silently land wherever focus already
      // was. Remembering the point (not a semantic field/role) lets typeText()
      // re-click it for real immediately before sending keystrokes.
      if (cursorIdentity) rememberDesktopInputTarget(name, cursorIdentity, { pid, windowId, field: { x: targetScreenPoint.x, y: targetScreenPoint.y } });
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
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow }) => {
      const before = await captureFrame();
      const selected = cursorIdentity
        ? fieldStillInThisWindow(desktopInputTargets.get(desktopInputKey(name, cursorIdentity)), pid, windowId)
        : undefined;
      if (cursorIdentity && selected?.field) {
        const point = desktopPointInWindow(selected.field, before);
        await moveAndVerifyCursor({ session, pid, windowId }, point.x, point.y, before);
      }
      const outcome = await driverInputAction("press_key", {
        pid, window_id: Number(windowId), key, session,
      }, "Cua Driver could not press the requested key in the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        // Every key name reaching this point was already validated upstream
        // (task-stage-actions.ts's validKey/KEY_NAMES) against exactly the
        // set our own native vk_for_key_name mapping covers.
        nativeForeground: nativeStageInput(pid, windowId, () => manager.sendKeyCombo(pid, windowId.toString(), [key])),
      });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function hotkey(name: string, keys: string[], cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof | CuaStageWindowClosedProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow }) => {
      const before = await captureFrame();
      const selected = cursorIdentity
        ? fieldStillInThisWindow(desktopInputTargets.get(desktopInputKey(name, cursorIdentity)), pid, windowId)
        : undefined;
      if (cursorIdentity && selected?.field) {
        const point = desktopPointInWindow(selected.field, before);
        await moveAndVerifyCursor({ session, pid, windowId }, point.x, point.y, before);
      }
      const outcome = await driverInputAction("hotkey", {
        pid, window_id: Number(windowId), keys, session,
      }, "Cua Driver could not send the requested key combination to the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, windowId, () => manager.sendKeyCombo(pid, windowId.toString(), keys)),
      });
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

  // Owned popups (a Windows error dialog, a "Save As" box -- a separate
  // top-level window the app owns on top of itself) were previously
  // screenshot-only: ownedPopups/captureOwnedPopups exists purely to show the
  // agent that a popup is there, with no way to click or type into it at all.
  // Every click/key dispatch is bound to the registered app's own windowId,
  // which the popup is not -- so a click aimed "at the dialog" always landed
  // on the app window behind it, never the dialog itself. These functions
  // resolve the app's current owned popup and dispatch straight to its own
  // pid/windowId through the same native SendInput path as the app window.
  async function withRegisteredPopup<T>(nameInput: string, run: (input: {
    driver?: CuaDriverLike; session: string; pid: number; parentWindowId: bigint; popupWindowId: bigint;
    capture: () => Promise<CuaStageCapture>;
  }) => Promise<T>): Promise<T> {
    let inspected: Awaited<ReturnType<typeof manager.inspectStage>>;
    try { inspected = await manager.inspectStage(nameInput); }
    catch (error) {
      if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
      throw new DesktopInputNotDispatchedError(
        `The exact app stage could not be inspected before popup input; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
        "target-identity",
      );
    }
    const { stage, anchor } = inspected;
    if (!anchor) throw new DesktopInputNotDispatchedError(`Stage “${stage.name}” has no registered app window.`);
    const pid = anchor.pid;
    const windowId = parseWindowId(anchor.windowId);
    let popups: Awaited<ReturnType<typeof manager.ownedPopups>>;
    try { popups = await manager.ownedPopups(pid, windowId.toString()); }
    catch (error) {
      if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
      throw new DesktopInputNotDispatchedError(
        `Owned popup observation failed before input; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
        "target-identity",
      );
    }
    if (popups.length === 0) throw new DesktopInputNotDispatchedError("This app owns no popup window right now; nothing to interact with.");
    let popupWindowId: bigint;
    if (popups.length === 1) popupWindowId = BigInt(popups[0]!.windowId);
    else {
      // Enumeration order is not z-order. With multiple owned dialogs, use the
      // actual foreground identity; never guess based on list position.
      let foreground: Awaited<ReturnType<typeof manager.currentForegroundWindow>>;
      try { foreground = await manager.currentForegroundWindow(); }
      catch (error) {
        throw new DesktopInputNotDispatchedError(
          `The active owned popup could not be identified; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
          "target-identity",
        );
      }
      const matches = popups.filter((popup) => BigInt(popup.windowId) === BigInt(foreground.windowId));
      if (foreground.pid !== pid || matches.length !== 1) {
        throw new DesktopInputNotDispatchedError("More than one owned popup is open and none uniquely matches the foreground window; no input was sent.", "target-identity");
      }
      popupWindowId = BigInt(matches[0]!.windowId);
    }
    const session = safeSessionName(stage.name);
    const capture = async (): Promise<CuaStageCapture> => {
      try {
        const stillOwned = (await manager.ownedPopups(pid, windowId.toString())).some((popup) => BigInt(popup.windowId) === popupWindowId);
        if (!stillOwned) throw new DesktopInputNotDispatchedError("The popup window closed or changed before input; no input was sent.", "target-identity");
        const [image, structure] = await Promise.all([
          manager.captureWindow(pid, popupWindowId.toString()),
          manager.windowStructure(pid, popupWindowId.toString(), { maxElements: 4096, maxDepth: 64 }).catch(() => undefined),
        ]);
        const bounds = boundsAtWindowCapture(image);
        const controls = structure?.elements.flatMap((element) => {
          const left = Math.max(0, (element.rect.x - bounds.x) * image.width / bounds.width);
          const top = Math.max(0, (element.rect.y - bounds.y) * image.height / bounds.height);
          const right = Math.min(image.width, (element.rect.x + element.rect.width - bounds.x) * image.width / bounds.width);
          const bottom = Math.min(image.height, (element.rect.y + element.rect.height - bounds.y) * image.height / bounds.height);
          return [left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top
            ? [{ ...(element.label ? { label: element.label } : {}), ...(element.role ? { role: element.role } : {}),
              rect: { x: left, y: top, width: right - left, height: bottom - top } }]
            : [];
        });
        return stageCapture({ ...image, ...(controls ? { controls, ...(structure?.truncated ? { controlsTruncated: true as const } : {}) } : {}) }, now);
      } catch (error) {
        if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
        throw new DesktopInputNotDispatchedError(
          `Owned popup observation failed before input; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
          "target-identity",
        );
      }
    };
    return run({ driver: undefined, session, pid, parentWindowId: windowId, popupWindowId, capture });
  }

  async function captureAfterPopupDispatch(name: string, before: CuaStageCapture,
    outcome: CuaStageActionOutcome): Promise<CuaStageActionProof> {
    try {
      // Keep the target observation in the parent app's coordinate space. The
      // app capture also carries any still-owned popup images; a popup-local
      // frame is never mislabeled as an app-window frame after an action.
      const parentCapture = await withRegisteredWindow(name, async ({ capture }) => stageCapture(await capture(), now));
      return { capture: parentCapture, captureScope: "app", outcome: { ...outcome,
        summary: [outcome.summary, "The parent app and its current owned popups were recaptured. Inspect the requested filename, any conflict prompt, and the saved result separately."].filter(Boolean).join(" ") } };
    } catch {
      // Input already returned successfully. Keep its dispatch result, but mark
      // the stale popup pixels as popup-scoped context so computer-use cannot
      // feed them back as a fresh parent-app observation.
      return { capture: before, captureScope: "popup", outcome: { ...outcome, status: "unverified",
        summary: [outcome.summary, "A fresh parent-app capture could not be obtained after popup input. The returned popup image is prior context only; inspect the app before continuing."].filter(Boolean).join(" ") } };
    }
  }

  function popupElementsForHitTest(structure: Awaited<ReturnType<typeof manager.windowStructure>>) {
    const indexByPath = new Map<string, bigint>();
    structure.elements.forEach((element, index) => indexByPath.set(JSON.stringify(element.path), BigInt(index)));
    return structure.elements.map((element, index) => {
      const parentIndex = element.path.length ? indexByPath.get(JSON.stringify(element.path.slice(0, -1))) : undefined;
      const actions = [
        ...(element.actions?.invoke ? ["invoke"] : []),
        ...(element.actions?.select ? ["select"] : []),
        ...(element.actions?.toggle ? ["toggle"] : []),
        ...(element.actions?.legacy ? ["click"] : []),
        ...(element.actions?.setValue ? ["set_value"] : []),
        ...(element.actions?.scroll ? ["scroll"] : []),
      ];
      return { elementToken: element.ref, elementIndex: BigInt(index), ...(parentIndex !== undefined ? { parentIndex } : {}),
        depth: element.depth, role: element.role, label: normalizeAccessibleLabel(element.label) ?? "", enabled: element.enabled, actions,
        frame: { x: element.rect.x, y: element.rect.y, w: element.rect.width, h: element.rect.height } } as unknown as CuaWindowElement;
    });
  }

  async function clickPopup(name: string, x: number, y: number, options: CuaDesktopClickOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredPopup(name, async ({ driver, session, pid, popupWindowId, capture }) => {
      const before = await capture();
      if (!validPoint(x, y, before)) throw new DesktopInputNotDispatchedError("Click coordinates must fall inside the current popup window snapshot.");
      const screen = await localToScreenPoint(pid, popupWindowId, x, y, before.width, before.height);
      const outcome = await driverInputAction("click", {
        pid, window_id: Number(popupWindowId), x, y,
        ...(options.button ? { button: options.button === "right" ? "right" : options.button === "middle" ? "middle" : "left" } : {}),
        ...(options.count ? { count: options.count } : {}),
        session,
      }, "Cua Driver could not click the owned popup window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeHeadless: nativeWindowClick(pid, popupWindowId, screen.x, screen.y, {
          ...(options.button ? { button: options.button } : {}), ...(options.count ? { count: options.count } : {}),
        }),
        nativeForeground: nativeStageInput(pid, popupWindowId, async () => {
            await manager.sendClick(pid, popupWindowId.toString(), screen.x, screen.y, {
              ...(options.button ? { button: options.button } : {}),
              ...(options.count ? { count: options.count } : {}),
            });
          }),
      });
      return captureAfterPopupDispatch(name, before, outcome);
    });
  }

  async function pressKeyPopup(name: string, key: string, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredPopup(name, async ({ driver, session, pid, popupWindowId, capture }) => {
      const before = await capture();
      const outcome = await driverInputAction("press_key", {
        pid, window_id: Number(popupWindowId), key, session,
      }, "Cua Driver could not press the requested key in the owned popup window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, popupWindowId, () => manager.sendKeyCombo(pid, popupWindowId.toString(), [key])),
      });
      return captureAfterPopupDispatch(name, before, outcome);
    });
  }

  async function hotkeyPopup(name: string, keys: string[], options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredPopup(name, async ({ driver, session, pid, popupWindowId, capture }) => {
      const before = await capture();
      const outcome = await driverInputAction("hotkey", {
        pid, window_id: Number(popupWindowId), keys, session,
      }, "Cua Driver could not send the requested key combination to the owned popup window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, popupWindowId, () => manager.sendKeyCombo(pid, popupWindowId.toString(), keys)),
      });
      return captureAfterPopupDispatch(name, before, outcome);
    });
  }

  async function typeTextPopup(name: string, text: string, options: CuaStageTextOptions = {}): Promise<CuaStageActionProof> {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new DesktopInputNotDispatchedError(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    let delayMs: number;
    try { delayMs = normalizeTypeDelayMs(options.delayMs); }
    catch (error) {
      throw new DesktopInputNotDispatchedError(
        `${error instanceof Error ? error.message : String(error)} No popup input was sent.`,
        "native-dispatch-unavailable",
      );
    }
    return withRegisteredPopup(name, async ({ session, pid, popupWindowId, capture }) => {
      const before = await capture();
      let outcome: CuaStageActionOutcome;
      if (options.mode === "replace") {
        if (options.x === undefined || options.y === undefined) throw new DesktopInputNotDispatchedError("Replace mode requires an exact popup field point; no text was sent.");
        if (!validPoint(options.x, options.y, before)) throw new DesktopInputNotDispatchedError("Replace coordinates must fall inside the current popup snapshot.", "target-identity");
        let structure: Awaited<ReturnType<typeof manager.windowStructure>>;
        let screen: { x: number; y: number };
        try {
          structure = await manager.windowStructure(pid, popupWindowId.toString(), { maxElements: 4096, maxDepth: 64 });
          screen = await localToScreenPoint(pid, popupWindowId, options.x, options.y, before.width, before.height);
        } catch (error) {
          if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
          throw new DesktopInputNotDispatchedError(
            `The popup field could not be resolved before text replacement; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
            "target-identity",
          );
        }
        const element = elementAtScreenPoint(popupElementsForHitTest(structure), screen.x, screen.y,
          (candidate) => candidate.actions?.includes("set_value") === true);
        const nativeElement = element?.elementToken
          ? structure.elements.find((candidate) => candidate.ref === element.elementToken)
          : undefined;
        if (!nativeElement || nativeElement.enabled === false || !nativeElement.actions?.setValue) {
          throw new DesktopInputNotDispatchedError("No accessible replaceable text field was found at that popup point; no text was sent.", "target-identity");
        }
        if ((options.expectedRole !== undefined && nativeElement.role !== options.expectedRole)
          || (options.expectedLabel !== undefined && normalizeAccessibleLabel(nativeElement.label) !== options.expectedLabel)) {
          throw new DesktopInputNotDispatchedError("The popup field at that point does not match the observed role and label; no text was sent.", "target-identity");
        }
        let semantic: Awaited<ReturnType<typeof manager.invokeWindowElement>>;
        try {
          semantic = await invokeWindowElementTimed(pid, popupWindowId.toString(), {
            path: nativeElement.path, action: "setValue", expectedRole: nativeElement.role,
            expectedLabel: nativeElement.label, expectedClassName: nativeElement.className,
            expectedAutomationId: nativeElement.automationId, text,
          });
        } catch (error) {
          if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
          throw new DesktopInputNotDispatchedError(
            `The popup field could not be set before native input; no text was sent. ${error instanceof Error ? error.message : String(error)}`,
            "target-identity",
          );
        }
        if (semantic.dispatched) {
          outcome = { status: "unverified", summary: `Native UI Automation replaced the exact popup field value via ${semantic.mechanism ?? "the value pattern"}; the refreshed popup capture is the separate effect check.` };
        } else {
          const screenPoint = await localToScreenPoint(pid, popupWindowId, options.x, options.y, before.width, before.height);
          outcome = await nativeReplaceTextAtScreenPoint(pid, popupWindowId, screenPoint.x, screenPoint.y, text,
            { session, signal: options.signal, deliveryMode: options.deliveryMode,
              preferForeground: options.confirmFocusForeground, allowForegroundEscalation: options.allowForegroundEscalation });
        }
      } else {
        outcome = await deliverTextToExactWindow({ session, pid, windowId: popupWindowId, text, delayMs,
          preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode,
          allowForegroundEscalation: options.allowForegroundEscalation,
          nativeForeground: nativeStageInput(pid, popupWindowId, () => manager.sendText(pid, popupWindowId.toString(), text)),
          signal: options.signal });
      }
      return captureAfterPopupDispatch(name, before, outcome);
    });
  }

  async function saveAs(name: string, requestedPath: string, options: {
    createParentDirectories?: boolean; replaceExisting?: boolean; signal?: AbortSignal;
  } = {}): Promise<CuaStageActionProof> {
    let target: ReturnType<typeof resolveSaveAsTarget>;
    try { target = resolveSaveAsTarget(requestedPath, win32); }
    catch (error) {
      throw new DesktopInputNotDispatchedError(error instanceof Error ? error.message : "Invalid Save As path.", "target-identity");
    }
    options.signal?.throwIfAborted();
    const statOrMissing = (path: string): ReturnType<typeof statSync> | undefined => {
      try { return statSync(path); }
      catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw new DesktopInputNotDispatchedError(
          `Save As could not safely inspect the requested path (${code || "filesystem error"}); no dialog input was sent.`,
          "target-identity",
        );
      }
    };
    const beforeStat = statOrMissing(target.path);
    const beforeVersion = beforeStat ? { size: beforeStat.size, mtimeMs: beforeStat.mtimeMs, ctimeMs: beforeStat.ctimeMs } : undefined;
    const baseEvidence = { path: target.path, directory: target.directory, fileName: target.fileName };
    return withRegisteredPopup(name, async ({ pid, parentWindowId, popupWindowId, capture }) => {
      const before = await capture();
      const inspect = async (windowId: bigint) => manager.windowStructure(pid, windowId.toString(), { maxElements: 4096, maxDepth: 64 });
      let structure: Awaited<ReturnType<typeof manager.windowStructure>>;
      try { structure = await inspect(popupWindowId); }
      catch (error) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `Save As stopped before dispatch because the owned dialog structure could not be read. ${error instanceof Error ? error.message : String(error)}` },
          saveAs: { ...baseEvidence, persisted: false } };
      }
      const controls = structure.elements;
      const nameField = findSaveAsNameField(controls);
      const saveButton = findSaveAsButton(controls);
      if (structure.status !== "complete" || structure.truncated || !nameField || !saveButton) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `Save As stopped before dispatch: the owned dialog exposed ${structure.elements.length} accessible control(s) and was ${structure.status}${structure.truncated ? " and truncated" : ""}; unique accessible filename field=${Boolean(nameField)}, Save button=${Boolean(saveButton)}.` },
          saveAs: { ...baseEvidence, persisted: false } };
      }
      if (beforeStat && !beforeStat.isFile()) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "The requested destination exists but is not a file. No Save As input was sent." },
          saveAs: { ...baseEvidence, persisted: false } };
      }
      if (beforeStat && !options.replaceExisting) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "The exact destination file already exists. It was preserved because replacement was not authorized." },
          saveAs: { ...baseEvidence, persisted: false, sizeBytes: String(beforeStat.size) } };
      }
      let existingDirectory: ReturnType<typeof statSync> | undefined;
      try { existingDirectory = statOrMissing(target.directory); }
      catch (error) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `Save As stopped before dialog input because the requested destination folder could not be safely inspected. ${error instanceof Error ? error.message : String(error)}` },
          saveAs: { ...baseEvidence, persisted: false } };
      }
      const directoryAlreadyExists = existingDirectory !== undefined;
      if (existingDirectory && !existingDirectory.isDirectory()) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "The requested destination parent exists but is not a folder. No Save As input was sent." },
          saveAs: { ...baseEvidence, persisted: false } };
      }
      if (!directoryAlreadyExists && !options.createParentDirectories) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "The requested destination folder does not exist. No Save As input was sent; create that folder only if the task requests it." },
          saveAs: { ...baseEvidence, persisted: false } };
      }
      let directoryCreated = false;
      try {
        if (!directoryAlreadyExists) {
          directoryCreated = typeof mkdirSync(target.directory, { recursive: true }) === "string";
        }
        if (!statSync(target.directory).isDirectory()) throw new Error("The destination parent path is not a folder.");
      } catch (error) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `Save As stopped before dialog input because the destination folder could not be prepared. ${error instanceof Error ? error.message : String(error)}` },
          saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
      }

      options.signal?.throwIfAborted();
      let setPath: Awaited<ReturnType<typeof manager.invokeWindowElement>>;
      try {
        setPath = await invokeWindowElementTimed(pid, popupWindowId.toString(), {
          path: nameField.path, action: "setValue", expectedRole: nameField.role,
          expectedLabel: nameField.label, expectedClassName: nameField.className,
          expectedAutomationId: nameField.automationId, text: target.path,
        });
      } catch (error) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `Save As could not set the exact requested path in the current accessible filename field. ${error instanceof Error ? error.message : String(error)}` },
          saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
      }
      if (!setPath.dispatched) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "The current filename field did not accept an accessible value replacement; Save was not activated." },
          saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
      }
      if (setPath.valueConfirmed !== true) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "The filename field did not confirm the exact requested path after replacement; Save was not activated." },
          saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
      }

      // Re-resolve the dialog controls after setting the full target path. The
      // path is internally split and validated above; Windows common Save As
      // dialogs accept an absolute path in their File name field, which avoids
      // guessing at a localized address-bar control or accidentally saving to
      // the currently displayed folder.
      let currentStructure: Awaited<ReturnType<typeof manager.windowStructure>>;
      try { currentStructure = await inspect(popupWindowId); }
      catch (error) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `The filename was entered, but the Save button could not be safely re-resolved; inspect the dialog before continuing. ${error instanceof Error ? error.message : String(error)}` },
          saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
      }
      const currentSave = currentStructure.status === "complete" && !currentStructure.truncated
        ? findSaveAsButton(currentStructure.elements) : undefined;
      if (!currentSave || JSON.stringify(currentSave.path) !== JSON.stringify(saveButton.path)
        || currentSave.label !== saveButton.label || currentSave.automationId !== saveButton.automationId) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "The filename was entered, but the Save control changed or became ambiguous; it was not activated." },
          saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
      }
      options.signal?.throwIfAborted();
      const saveDispatch = await invokeWindowElementTimed(pid, popupWindowId.toString(), {
        path: currentSave.path, action: "activate", expectedRole: currentSave.role,
        expectedLabel: currentSave.label, expectedClassName: currentSave.className,
        expectedAutomationId: currentSave.automationId,
      });
      if (!saveDispatch.dispatched) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: "Windows did not dispatch the exact accessible Save control; the file was not reported saved." },
          saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
      }

      const inspectOwnedPopups = async () => {
        const owned = await manager.ownedPopups(pid, parentWindowId.toString());
        const results: Array<{ windowId: bigint; structure?: Awaited<ReturnType<typeof manager.windowStructure>> }> = [];
        for (const popup of owned) {
          const id = BigInt(popup.windowId);
          try { results.push({ windowId: id, structure: await inspect(id) }); }
          catch { results.push({ windowId: id }); }
        }
        return results;
      };
      let conflictHandled = false;
      let handledConflictWindowId: bigint | undefined;
      let latestPopups: Awaited<ReturnType<typeof inspectOwnedPopups>> = [];
      let targetStat: ReturnType<typeof statSync> | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        options.signal?.throwIfAborted();
        latestPopups = await inspectOwnedPopups();
        const conflicts = latestPopups.filter((popup) => popup.structure
          && classifySaveAsConflict(popup.structure.elements, target.fileName, options.replaceExisting === true).recognized);
        if (conflicts.length > 1 || (handledConflictWindowId !== undefined
          && conflicts.some((popup) => popup.windowId !== handledConflictWindowId))) {
          return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
            summary: "More than one exact-target overwrite prompt appeared; no additional prompt was acted on." },
            saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
        }
        const conflict = conflicts[0];
        // A modal may remain enumerable for a short time after its button was
        // dispatched. Never click that same prompt twice while waiting for it
        // to close and for the file system effect to become observable.
        if (conflict && conflict.windowId === handledConflictWindowId) {
          await delay(100);
          continue;
        }
        if (conflict?.structure) {
          const decision = classifySaveAsConflict(conflict.structure.elements, target.fileName, options.replaceExisting === true);
          const actionLabel = decision.confirm ? /^(?:replace|yes|overwrite)$/i : decision.dismiss ? /^(?:no|cancel|keep both)$/i : undefined;
          const button = actionLabel && conflict.structure.elements.filter((element) => element.enabled
            && /^button$/i.test(element.role) && (element.actions?.invoke || element.actions?.legacy)
            && actionLabel.test(element.label.replace(/&/g, "").replace(/[.…]+$/g, "").trim()));
          if (!button || button.length !== 1) {
            return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
              summary: decision.reason ?? "The exact filename conflict could not be resolved safely; the prompt remains open for inspection." },
              saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
          }
          const resolved = await invokeWindowElementTimed(pid, conflict.windowId.toString(), {
            path: button[0]!.path, action: "activate", expectedRole: button[0]!.role,
            expectedLabel: button[0]!.label, expectedClassName: button[0]!.className,
            expectedAutomationId: button[0]!.automationId,
          });
          if (!resolved.dispatched) {
            return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
              summary: "The recognized exact-file conflict button was not dispatched; the file was not reported saved." },
              saveAs: { ...baseEvidence, persisted: false, ...(directoryCreated ? { directoryCreated } : {}) } };
          }
          conflictHandled = decision.confirm === true;
          handledConflictWindowId = conflict.windowId;
          if (decision.dismiss) {
            return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
              summary: decision.reason ?? "The existing file was preserved; no replacement occurred." },
              saveAs: { ...baseEvidence, persisted: false, ...(beforeStat ? { sizeBytes: String(beforeStat.size) } : {}), ...(directoryCreated ? { directoryCreated } : {}) } };
          }
        }
        try { targetStat = statOrMissing(target.path); }
        catch {
          // The file may have been written, but inaccessible metadata is not
          // persistence proof. Keep observing until the bounded wait ends.
          targetStat = undefined;
        }
        const originalDialogOpen = latestPopups.some((popup) => popup.windowId === popupWindowId);
        const sameVersion = Boolean(beforeVersion && targetStat
          && beforeVersion.size === targetStat.size
          && beforeVersion.mtimeMs === targetStat.mtimeMs
          && beforeVersion.ctimeMs === targetStat.ctimeMs);
        if (targetStat?.isFile() && (!beforeVersion || (options.replaceExisting === true && !sameVersion)) && !originalDialogOpen
          && !latestPopups.some((popup) => popup.windowId !== popupWindowId && popup.structure === undefined)) break;
        await delay(100);
      }
      const originalDialogOpen = latestPopups.some((popup) => popup.windowId === popupWindowId);
      const sameVersion = Boolean(beforeVersion && targetStat
        && beforeVersion.size === targetStat.size
        && beforeVersion.mtimeMs === targetStat.mtimeMs
        && beforeVersion.ctimeMs === targetStat.ctimeMs);
      const persisted = Boolean(targetStat?.isFile() && (!beforeVersion || (options.replaceExisting === true && !sameVersion))
        && !originalDialogOpen && !latestPopups.some((popup) => popup.windowId !== popupWindowId && popup.structure === undefined));
      const outcome: CuaStageActionOutcome = persisted
        ? { status: "confirmed", summary: "The exact requested file path exists after the owned Save As dialog closed. This confirms path persistence, not document-content correctness; reopen and inspect the saved output before reporting the task complete." }
        : { status: "partial", summary: "The Save control was dispatched, but M9R could not confirm that the exact requested file exists after the dialog closed. Inspect the current app and owned dialogs before retrying." };
      if (beforeVersion && persisted) outcome.summary = `The exact requested file path was updated${conflictHandled ? " after an explicitly authorized overwrite prompt" : " under the explicit replacement authorization"}, and the owned Save As dialog closed. Reopen and inspect the saved output before reporting the task complete.`;
      const result = await captureAfterPopupDispatch(name, before, outcome);
      return { ...result, saveAs: { ...baseEvidence, persisted, ...(targetStat ? { sizeBytes: String(targetStat.size) } : {}), ...(directoryCreated ? { directoryCreated } : {}) } };
    });
  }

  async function capturePopup(name: string): Promise<CuaStageCapture> {
    return withRegisteredPopup(name, async ({ capture }) => capture());
  }

  async function describePopupTarget(name: string, x: number, y: number): Promise<CuaStageTargetDescription | undefined> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
      throw new DesktopInputNotDispatchedError("Popup target coordinates must be non-negative whole popup-snapshot pixels; no input was sent.", "target-identity");
    }
    return withRegisteredPopup(name, async ({ pid, popupWindowId }) => {
      let image: Awaited<ReturnType<typeof manager.captureWindow>>;
      try {
        image = await timed("window-capture", () => manager.captureWindow(pid, popupWindowId.toString()),
          { stageName: name, detail: "scope=popup-target-resolution" });
      } catch (error) {
        if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
        throw new DesktopInputNotDispatchedError(
          `The owned popup could not be captured to describe the click target; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
          "target-identity",
        );
      }
      if (!validPoint(x, y, image)) throw new DesktopInputNotDispatchedError("Click coordinates must fall inside the current popup window snapshot; no input was sent.", "target-identity");
      const bounds = boundsAtWindowCapture(image);
      if (bounds.width <= 0 || bounds.height <= 0) return undefined;
      const screenX = bounds.x + Math.floor((x + 0.5) * bounds.width / image.width);
      const screenY = bounds.y + Math.floor((y + 0.5) * bounds.height / image.height);
      let hit: NativePointControl;
      try {
        hit = await timed("target-resolution", () => (deps.pointControl ?? manager.pointControl)(screenX, screenY),
          { stageName: name, detail: "source=uia-element-at-point;scope=owned-popup" });
      } catch { return undefined; }
      if (hit.windowPid !== pid || BigInt(hit.windowId) !== popupWindowId) return undefined;
      const label = normalizeAccessibleLabel(hit.label);
      return {
        ...(label ? { label } : {}),
        rect: {
          x: (hit.rect.x - bounds.x) * image.width / bounds.width,
          y: (hit.rect.y - bounds.y) * image.height / bounds.height,
          width: hit.rect.width * image.width / bounds.width,
          height: hit.rect.height * image.height / bounds.height,
        },
      };
    });
  }

  /**
   * Answers an ordinary confirm/prompt dialog (e.g. an app's "Do you want to
   * save changes?" with Save / Don't Save / Cancel) by invoking exactly one
   * enabled button matched by its exact accessible label, via UI Automation
   * only -- never SendInput, never a point click, never foreground. This is
   * the generic sibling of saveAs's own Save-button invoke for dialogs that
   * have no file name field at all; clickPopup's x,y click correctly refuses
   * in background mode (there is no semantic target behind a bare point), so
   * this is the only background-safe way to answer such a dialog.
   */
  async function confirmDialogButton(name: string, label: string, options: { signal?: AbortSignal } = {}): Promise<CuaStageActionProof> {
    if (typeof label !== "string" || label.length < 1 || label.length > 64) {
      throw new DesktopInputNotDispatchedError("A dialog button label is required; no dialog input was sent.");
    }
    return withRegisteredPopup(name, async ({ pid, popupWindowId, capture }) => {
      const before = await capture();
      options.signal?.throwIfAborted();
      let structure: Awaited<ReturnType<typeof manager.windowStructure>>;
      try { structure = await manager.windowStructure(pid, popupWindowId.toString(), { maxElements: 4096, maxDepth: 64 }); }
      catch (error) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `Could not read the owned dialog's structure before dispatch. ${error instanceof Error ? error.message : String(error)}` } };
      }
      const button = findDialogButton(structure.elements, label);
      if (structure.status !== "complete" || structure.truncated || !button) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: `Could not uniquely resolve an enabled "${label}" button in the owned dialog (status=${structure.status}${structure.truncated ? ", truncated" : ""}).` } };
      }
      options.signal?.throwIfAborted();
      const dispatch = await invokeWindowElementTimed(pid, popupWindowId.toString(), {
        path: button.path, action: "activate", expectedRole: button.role,
        expectedLabel: button.label, expectedClassName: button.className, expectedAutomationId: button.automationId,
      });
      if (!dispatch.dispatched) {
        return { capture: before, captureScope: "popup" as const, outcome: { status: "partial" as const,
          summary: dispatch.reason ?? `Windows did not confirm the "${label}" button was activated.` } };
      }
      return captureAfterPopupDispatch(name, before, { status: "unverified" as const,
        summary: `Activated the "${label}" button via its exact UI Automation invoke pattern; the refreshed capture and any requested effect check are the separate verification.` });
    });
  }

  async function typeText(name: string, text: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageTextOptions = {}): Promise<CuaStageActionProof> {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new DesktopInputNotDispatchedError(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    const delayMs = normalizeTypeDelayMs(options.delayMs);
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow, elementAtPoint, elementByToken }) => {
      // Same reasoning as click()/drag()/scroll(): this step only ever uses
      // geometry (field/point mapping, screen reprojection), never pixels.
      const rect = await timed("target-resolution", () => manager.windowRect(pid, windowId.toString()), { detail: "source=window-rect" });
      const before: CuaStageWindowFrame = { dataUrl: "", width: rect.width, height: rect.height, windowBounds: rect };
      // "replace" mode never actually replaced anything -- it discarded the
      // remembered field and fell through to the generic append path
      // (`type_text`), even though the schema requires an exact point for it and
      // documents it as a real field replacement. This is the real mechanism:
      // look up the actual field at that point and replace its value directly,
      // the same way replaceElement() does, instead of silently appending text
      // wherever focus happens to be.
      if (options.mode === "replace") {
        if (options.x === undefined || options.y === undefined) throw new DesktopInputNotDispatchedError("Replace mode requires an exact field point; no text was sent.");
        const element = await elementAtPoint(options.x, options.y, "set_value");
        if (!element?.elementToken || element.enabled === false || !element.actions?.includes("set_value")) {
          throw new DesktopInputNotDispatchedError("No replaceable text field was found at the given point; no text was sent.");
        }
        if ((options.expectedRole !== undefined && element.role !== options.expectedRole)
          || (options.expectedLabel !== undefined && element.label !== options.expectedLabel)) {
          throw new DesktopInputNotDispatchedError("The field at the given point could not be confirmed as the same one you observed; no text was sent.");
        }
        if (cursorIdentity) await moveAndVerifyCursor({ session, pid, windowId }, options.x, options.y, before);
        let selected = await elementByToken(element.elementToken, { role: element.role, label: element.label });
        if (!selected?.nativeElement) {
          // A host app can reflow its own UI tree (e.g. Notepad adding a tab)
          // in the moments between the point lookup above and this token
          // re-check, rolling the field's token over even though the exact
          // same control -- by role and label, at the same point -- is still
          // there. That is real, ordinary app churn, not a wrong target, and
          // failing on it here cost a full extra agent turn (re-observe,
          // re-decide, re-issue) every time Notepad's tab bar changed. Take
          // one fresh look at the same point before giving up: if a control
          // matching the same expected role/label is still there, its token
          // is already current, so there's nothing stale to retry against.
          // If it is not -- a different control, or none -- this still fails
          // exactly as before; the identity requirement itself is unchanged.
          const reobserved = await elementAtPoint(options.x, options.y, "set_value");
          if (reobserved?.elementToken && reobserved.enabled !== false && reobserved.actions?.includes("set_value")
            && (options.expectedRole === undefined || reobserved.role === options.expectedRole)
            && (options.expectedLabel === undefined || reobserved.label === options.expectedLabel)) {
            selected = await elementByToken(reobserved.elementToken, { role: reobserved.role, label: reobserved.label });
          }
        }
        if (!selected?.nativeElement) {
          throw new DesktopInputNotDispatchedError("The observed text field changed before replacement; no text was sent. Re-observe the field and retry.", "target-identity");
        }
        if (selected.nativeElement.actions?.setValue) {
          const semantic = await invokeWindowElementTimed(pid, windowId.toString(), {
            path: selected.nativeElement.path,
            action: "setValue",
            expectedRole: selected.nativeElement.role,
            expectedLabel: selected.nativeElement.label,
            expectedClassName: selected.nativeElement.className,
            expectedAutomationId: selected.nativeElement.automationId,
            text,
          });
          if (semantic.dispatched) {
            return { capture: stageCapture(await captureWindow(), now), outcome: {
              status: "unverified" as const,
              summary: `Native UI Automation replaced the exact observed field value via ${semantic.mechanism ?? "the value pattern"}; the refreshed window capture is the separate effect check.`,
            } };
          }
        }
        const screen = await localToScreenPoint(pid, windowId, options.x, options.y, before.width, before.height, before.windowBounds);
        const outcome = await nativeReplaceTextAtScreenPoint(pid, windowId, screen.x, screen.y, text,
          { session, signal: options.signal, deliveryMode: options.deliveryMode,
            preferForeground: options.confirmFocusForeground, allowForegroundEscalation: options.allowForegroundEscalation });
        return { capture: stageCapture(await captureWindow(), now), outcome };
      }
      // A remembered field from a window that is no longer this one (e.g. the
      // app was relaunched since it was remembered) is not a reason to refuse
      // typing in the current, perfectly valid window -- it just means there is
      // no remembered field to use; fall through to the generic focus-based path.
      const selected = cursorIdentity
        ? fieldStillInThisWindow(desktopInputTargets.get(desktopInputKey(name, cursorIdentity)), pid, windowId)
        : undefined;
      let refocusScreenPoint: { x: number; y: number } | undefined;
      if (cursorIdentity && selected?.field) {
        const point = desktopPointInWindow(selected.field, before);
        await moveAndVerifyCursor({ session, pid, windowId }, point.x, point.y, before);
        // Re-derive the screen point from the reprojected local point (not
        // selected.field directly) so a window that moved between the click
        // and this type action still gets refocused at the right spot.
        refocusScreenPoint = await localToScreenPoint(pid, windowId, point.x, point.y, before.width, before.height, before.windowBounds);
      }
      const outcome = await deliverTextToExactWindow({ session, pid, windowId,
        text, selected, allowForegroundEscalation: options.allowForegroundEscalation,
        delayMs, preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode,
        nativeForeground: nativeStageInput(pid, windowId, () => manager.sendText(pid, windowId.toString(), text),
          refocusScreenPoint ? () => manager.sendClick(pid, windowId.toString(), refocusScreenPoint!.x, refocusScreenPoint!.y, {}) : undefined),
        signal: options.signal });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function scroll(name: string, xInput: number | undefined, yInput: number | undefined, direction: "up" | "down", cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      // Same reasoning as click() and drag(): only geometry is needed before
      // dispatch here, never pixels.
      const rect = await timed("target-resolution", () => manager.windowRect(pid, windowId.toString()), { detail: "source=window-rect" });
      const before: CuaStageWindowFrame = { dataUrl: "", width: rect.width, height: rect.height, windowBounds: rect };
      // A scroll targets one already-exact window; unlike a click or a drag,
      // there is nothing ambiguous about defaulting to its center when no
      // point was given -- scrolling the window itself is what was meant.
      const x = xInput ?? Math.floor(before.width / 2);
      const y = yInput ?? Math.floor(before.height / 2);
      const amount = Math.min(50, Math.max(1, Math.round(options.amount ?? 3)));
      if (!validPoint(x, y, before)) throw new DesktopInputNotDispatchedError("Scroll coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ session, pid, windowId }, x, y, before);
      const screen = await localToScreenPoint(pid, windowId, x, y, before.width, before.height, before.windowBounds);
      const outcome = await driverInputAction("scroll", {
        pid, window_id: Number(windowId), x, y,
        direction, by: "line", amount, session,
      }, "Cua Driver could not scroll the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeHeadless: nativeWindowScroll(pid, windowId, screen.x, screen.y, direction === "up" ? amount : -amount),
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            await manager.sendScroll(pid, windowId.toString(), screen.x, screen.y, direction === "up" ? amount : -amount, "vertical");
          }),
      });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function drag(name: string, fromX: number, fromY: number, toX: number, toY: number, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageDragOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      // Same reasoning as click(): drag's pre-dispatch step only needs
      // geometry to bounds-check both endpoints and reproject them to screen
      // space, never pixels.
      const rect = await timed("target-resolution", () => manager.windowRect(pid, windowId.toString()), { detail: "source=window-rect" });
      const before: CuaStageWindowFrame = { dataUrl: "", width: rect.width, height: rect.height, windowBounds: rect };
      if (!validPoint(fromX, fromY, before) || !validPoint(toX, toY, before)) {
        throw new DesktopInputNotDispatchedError("Both drag points must fall inside the current stage window snapshot.");
      }
      if (cursorIdentity) await moveAndVerifyCursor({ session, pid, windowId }, fromX, fromY, before);
      const outcome = await driverInputAction("drag", {
        pid, window_id: Number(windowId), from_x: fromX, from_y: fromY, to_x: toX, to_y: toY,
        duration_ms: options.durationMs ?? 500, steps: 10, session,
      }, "Cua Driver could not drag in the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            const fromScreen = await localToScreenPoint(pid, windowId, fromX, fromY, before.width, before.height, before.windowBounds);
            const toScreen = await localToScreenPoint(pid, windowId, toX, toY, before.width, before.height, before.windowBounds);
            await manager.sendDrag(pid, windowId.toString(), fromScreen.x, fromScreen.y, toScreen.x, toScreen.y, options.durationMs ?? 500);
          }),
      });
      // The native pointer ends at the drop point. Keep the presentation cursor
      // there as well so a successful drag does not leave the agent marker at
      // its old start position after the owner's physical pointer is restored.
      if (cursorIdentity) await moveAndVerifyCursor({ session, pid, windowId }, toX, toY, before);
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  function elementScreenPoint(rect: NativeWindowStructureElement["rect"]): { x: number; y: number } | undefined {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return undefined;
    const x = Math.floor(rect.x + rect.width / 2);
    const y = Math.floor(rect.y + rect.height / 2);
    return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : undefined;
  }

  function screenToCapturePoint(point: { x: number; y: number }, frame: CuaStageWindowFrame): { x: number; y: number } | undefined {
    const bounds = frame.windowBounds;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, frame.width, frame.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0) return undefined;
    const x = Math.floor((point.x - bounds.x) * frame.width / bounds.width);
    const y = Math.floor((point.y - bounds.y) * frame.height / bounds.height);
    return validPoint(x, y, frame) ? { x, y } : undefined;
  }

  async function moveElementCursorToScreen(session: string, point: { x: number; y: number }): Promise<void> {
    const cursor = [...agentSessions.values()].find((candidate) => candidate.session === session);
    if (!cursor) return;
    // Cursor presence is a visual aid. If its compositor is temporarily
    // unavailable, keep the actual semantic action independent of rendering.
    await presentM9rCursor(cursor, cursor.key, point, false, "target=ui-automation-bounds", timingContext.getStore()?.stageName);
  }

  async function clickElement(name: string, ref: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, readStructure, elementByToken }) => {
      const selected = await elementByToken(ref, { role: options.expectedRole, label: options.expectedLabel });
      if (!selected?.element.elementToken || selected.element.enabled === false) {
        throw new DesktopInputNotDispatchedError(options.expectedRole !== undefined || options.expectedLabel !== undefined
          ? "The accessibility element could not be confirmed as the same control you observed (role/label did not match); no click was sent."
          : "The accessibility element is stale or disabled; no click was sent.");
      }
      // UIA action metadata describes which semantic patterns are available;
      // it is not a veto on a physical click at the exact, freshly revalidated
      // screen point. Some controls expose only focus/scroll or no patterns at
      // all while remaining clickable. Try the semantic route when the native
      // identity is strong enough, then use the exact point through the normal
      // owner-preview input lease when UIA reports no activation pattern.
      const screenPoint = elementScreenPoint(selected.screenRect);
      const selectedElementToken = selected.element.elementToken;
      if (!selectedElementToken) throw new DesktopInputNotDispatchedError("The accessibility element is missing its driver token; no click was sent.");
      if (cursorIdentity && screenPoint) await moveElementCursorToScreen(session, screenPoint);
      if (cursorIdentity) forgetDesktopInputTarget(name, cursorIdentity);
      if (!options.confirmFocusForeground && selected.nativeElement && typeof manager.invokeWindowElement === "function"
        && selected.nativeElement.role.trim()
        && (selected.nativeElement.label.trim() || selected.nativeElement.automationId.trim())) {
        let semantic: Awaited<ReturnType<typeof manager.invokeWindowElement>>;
        try {
          semantic = await invokeWindowElementTimed(pid, windowId.toString(), {
            path: selected.nativeElement.path,
            action: "activate",
            expectedRole: selected.nativeElement.role,
            expectedLabel: selected.nativeElement.label,
            expectedClassName: selected.nativeElement.className,
            expectedAutomationId: selected.nativeElement.automationId,
          });
        } catch (error) {
          if (error instanceof DesktopInputNotDispatchedError) throw error;
          // The semantic request can fail after the provider begins an Invoke
          // call. Preserve uncertainty and never replay it as a coordinate click.
          throw error;
        }
        if (semantic.dispatched) {
          return {
            capture: await captureWithStructure(readStructure, now),
            outcome: { status: "unverified", summary: `Native UI Automation dispatched ${semantic.mechanism ?? "the control action"}; the refreshed window capture is the separate effect check.` },
          };
        }
      }
      if (!screenPoint) throw new DesktopInputNotDispatchedError("The accessibility element has no usable screen point and no semantic activation route; no click was sent.", "target-identity");
      const frame = await captureFrame();
      const point = screenToCapturePoint(screenPoint, frame);
      if (!point) throw new DesktopInputNotDispatchedError("The accessibility element is outside the current window capture; no coordinate click was sent.", "target-identity");
      const outcome = await driverInputAction("click", {
        pid, window_id: Number(windowId), x: point.x, y: point.y, button: "left", count: 1, session,
      }, "Cua Driver could not click the selected accessibility element.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        allowForegroundEscalation: options.allowForegroundEscalation,
        nativeHeadless: nativeWindowClick(pid, windowId, screenPoint.x, screenPoint.y),
        nativeForeground: nativeStageInput(pid, windowId, () => manager.sendClick(pid, windowId.toString(), screenPoint.x, screenPoint.y, {})),
      });
      if (cursorIdentity && outcome.status === "confirmed" && selected.element.actions?.includes("set_value")
        && /^(?:Document|Edit|TextField|TextArea|ComboBox)$/i.test(selected.element.role ?? "")) {
        rememberDesktopInputTarget(name, cursorIdentity, { pid, windowId,
          field: { x: screenPoint.x, y: screenPoint.y, label: selected.element.label, role: selected.element.role } });
      }
      return { capture: await captureWithStructure(readStructure, now), outcome };
    }, cursorIdentity);
  }

  async function scrollElement(name: string, ref: string, direction: "up" | "down" | "left" | "right",
    cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions & { granularity?: "small" | "large" } = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow, elementByToken }) => {
      assertNotAbortedBeforeInput(options.signal);
      const selected = await elementByToken(ref, { role: options.expectedRole, label: options.expectedLabel });
      if (!selected?.nativeElement || selected.element.enabled === false) {
        throw new DesktopInputNotDispatchedError("The scroll container ref is stale, disabled, or no longer matches the observed control; no scroll was sent.", "target-identity");
      }
      const nativeElement = selected.nativeElement;
      const screenPoint = elementScreenPoint(selected.screenRect);
      if (cursorIdentity && screenPoint) await moveElementCursorToScreen(session, screenPoint);
      if (nativeElement.actions?.scroll && typeof manager.invokeWindowElement === "function") {
        const semantic = await invokeWindowElementTimed(pid, windowId.toString(), {
          path: nativeElement.path, action: "scroll", expectedRole: nativeElement.role,
          expectedLabel: nativeElement.label, expectedClassName: nativeElement.className,
          expectedAutomationId: nativeElement.automationId, direction, granularity: options.granularity ?? "small",
        });
        if (semantic.dispatched) {
          const before = semantic.scrollBefore?.[direction === "up" || direction === "down" ? "vertical" : "horizontal"];
          const after = semantic.scrollAfter?.[direction === "up" || direction === "down" ? "vertical" : "horizontal"];
          const progress = after === null || after === undefined ? "position unavailable" : `position ${after.toFixed(1)}%`;
          const summary = semantic.moved === true
            ? `Scrolled the observed UI Automation container by one ${options.granularity ?? "small"} ${direction} increment; ${progress}.`
            : semantic.moved === false
              ? `UI Automation accepted the ${direction} scroll request but reported no position change (${before === null || before === undefined ? "previous position unavailable" : `previous position ${before.toFixed(1)}%`}; ${progress}). Treat this as a boundary or provider no-op and inspect the refreshed view before continuing.`
              : `UI Automation accepted one ${direction} scroll request; ${progress} could not be confirmed. Inspect the refreshed view before continuing.`;
          return { capture: stageCapture(await captureWindow(), now), outcome: {
            status: semantic.moved === true ? "confirmed" : semantic.moved === false ? "partial" : "unverified", summary,
          } };
        }
        if (semantic.reason !== "scroll-pattern-unavailable") {
          throw new DesktopInputNotDispatchedError(`The observed UI Automation scroll container could not scroll (${semantic.reason ?? "unknown reason"}); no wheel fallback was attempted.`, "target-identity");
        }
      }

      // A visible wheel fallback is only used when this container does not
      // implement ScrollPattern. Keep it to one notch so each task-stage call
      // is a bounded movement followed by a fresh capture; the model can then
      // stop at the requested item instead of firing an endpoint-sized jump.
      if (!screenPoint) throw new DesktopInputNotDispatchedError("The observed scroll container has no usable point for the one-notch wheel fallback; no scroll was sent.", "target-identity");
      const before = await captureFrame();
      const point = screenToCapturePoint(screenPoint, before);
      if (!point) throw new DesktopInputNotDispatchedError("The observed scroll container is outside the current window capture; no wheel input was sent.", "target-identity");
      const screen = await localToScreenPoint(pid, windowId, point.x, point.y, before.width, before.height, before.windowBounds);
      const horizontal = direction === "left" || direction === "right";
      const signedAmount = direction === "up" || direction === "right" ? 1 : -1;
      const outcome = await driverInputAction("scroll", {
        pid, window_id: Number(windowId), x: point.x, y: point.y, direction: signedAmount > 0 ? "up" : "down",
        by: "line", amount: 1, session,
      }, "Cua Driver could not scroll the observed container by one wheel notch.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        allowForegroundEscalation: options.allowForegroundEscalation,
        nativeHeadless: nativeWindowScroll(pid, windowId, screen.x, screen.y, signedAmount,
          horizontal ? "horizontal" : "vertical"),
        nativeForeground: nativeStageInput(pid, windowId, () => manager.sendScroll(pid, windowId.toString(), screen.x, screen.y, signedAmount, horizontal ? "horizontal" : "vertical")),
      });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function replaceElement(name: string, ref: string, text: string, cursorIdentity?: CuaAgentCursorIdentity,
    options: CuaStageInputOptions & { expectedRole?: string; expectedLabel?: string } = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow, elementByToken }) => {
      assertNotAbortedBeforeInput(options.signal);
      const selected = await elementByToken(ref, { role: options.expectedRole, label: options.expectedLabel });
      const identityUsable = Boolean(selected?.element.elementToken) && selected?.element.enabled !== false;
      if (identityUsable && selected!.nativeElement && typeof manager.invokeWindowElement === "function") {
        const screenPoint = elementScreenPoint(selected!.screenRect);
        if (cursorIdentity && screenPoint) await moveElementCursorToScreen(session, screenPoint);
        const semantic = await invokeWindowElementTimed(pid, windowId.toString(), {
          path: selected!.nativeElement.path,
          action: "setValue",
          expectedRole: selected!.nativeElement.role,
          expectedLabel: selected!.nativeElement.label,
          expectedClassName: selected!.nativeElement.className,
          expectedAutomationId: selected!.nativeElement.automationId,
          ...(selected!.nativeElement.runtimeId?.length ? { expectedRuntimeId: selected!.nativeElement.runtimeId } : {}),
          text,
        });
        if (semantic.dispatched) {
          return {
            capture: stageCapture(await captureWindow(), now),
            outcome: { status: "unverified", summary: "Native UI Automation set the exact observed value; the refreshed window capture is the separate effect check." },
          };
        }
      }
      // WM_CHAR inserts at an existing caret; it cannot implement replacement
      // of this exact observed field. Use the verified replacement sequence
      // below, or refuse when the caller only owns an independent UIA region.
      if (!identityUsable) {
        throw new DesktopInputNotDispatchedError("The accessibility element is stale, disabled, could not be confirmed as the same control, or does not support text replacement; no text was sent.");
      }
      const screenPoint = elementScreenPoint(selected!.screenRect);
      if (cursorIdentity && screenPoint) await moveElementCursorToScreen(session, screenPoint);
      if (options.semanticOnly) throw new DesktopInputNotDispatchedError(
        "The independently claimed control no longer supports direct UI Automation value replacement; no caret or foreground fallback was sent.", "background-unavailable");
      if (!screenPoint) throw new DesktopInputNotDispatchedError("The selected accessibility field has no usable screen point; no text was sent.", "target-identity");
      const before = await captureFrame();
      const localPoint = screenToCapturePoint(screenPoint, before);
      if (!localPoint) throw new DesktopInputNotDispatchedError("The selected accessibility field is outside the current window capture; no text was sent.", "target-identity");
      const screen = await localToScreenPoint(pid, windowId, localPoint.x, localPoint.y, before.width, before.height, before.windowBounds);
      const outcome = await nativeReplaceTextAtScreenPoint(pid, windowId, screen.x, screen.y, text,
        { session, signal: options.signal, deliveryMode: options.deliveryMode,
          preferForeground: options.confirmFocusForeground, allowForegroundEscalation: options.allowForegroundEscalation });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  // One typical UI text line is roughly this many pixels tall; the installed
  // Cua Driver only exposes line/page scrolling for native windows, not pixel
  // scrolling, so a pixel request is converted to its nearest line-scroll
  // equivalent instead of being refused outright -- the public contract
  // accepts pixel units, and silently rejecting every one of those calls cost
  // a failed action and a recovery turn for no reason.
  const PIXELS_PER_SCROLL_LINE = 24;
  function scrollDeltaAmount(deltaX: number, deltaY: number, unit: "pixel" | "line" | "page"): { direction: "up" | "down" | "left" | "right"; amount: number; by: "line" | "page" } {
    const delta = deltaX !== 0 ? deltaX : deltaY;
    const by = unit === "page" ? "page" : "line";
    const amount = unit === "pixel" ? Math.max(1, Math.round(Math.abs(delta) / PIXELS_PER_SCROLL_LINE)) : Math.abs(delta);
    return { direction: deltaX !== 0 ? (deltaX < 0 ? "left" : "right") : (delta < 0 ? "up" : "down"), amount, by };
  }

  async function scrollDelta(name: string, xInput: number | undefined, yInput: number | undefined, deltaX: number, deltaY: number, unit: "pixel" | "line" | "page", cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}): Promise<CuaStageActionProof> {
    const scroll = scrollDeltaAmount(deltaX, deltaY, unit);
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow }) => {
      const before = await captureFrame();
      // Same reasoning as scroll(): this targets one already-exact window,
      // so an omitted point defaults to its center rather than being required.
      const x = xInput ?? Math.floor(before.width / 2);
      const y = yInput ?? Math.floor(before.height / 2);
      if (!validPoint(x, y, before)) throw new DesktopInputNotDispatchedError("Scroll coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ session, pid, windowId }, x, y, before);
      const screen = await localToScreenPoint(pid, windowId, x, y, before.width, before.height, before.windowBounds);
      const signedAmount = (scroll.direction === "up" || scroll.direction === "right") ? scroll.amount : -scroll.amount;
      const axis = (scroll.direction === "left" || scroll.direction === "right") ? "horizontal" : "vertical";
      const outcome = await driverInputAction("scroll", {
        pid, window_id: Number(windowId), x, y, direction: scroll.direction, by: scroll.by, amount: scroll.amount, session,
      }, "Cua Driver could not scroll the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeHeadless: nativeWindowScroll(pid, windowId, screen.x, screen.y, signedAmount, axis),
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            await manager.sendScroll(pid, windowId.toString(), screen.x, screen.y, signedAmount, axis);
          }),
      });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function windowFrame(name: string, x: number, y: number, width: number, height: number,
    cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, session, pid, windowId, capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      const requested = { x, y, width, height };
      const actual = await manager.setWindowFrame(pid, windowId.toString(), requested);
      const verified = sameWindowFrame(requested, actual);
      const outcome: CuaStageActionOutcome = {
        status: verified ? "confirmed" : "partial",
        summary: verified
          ? "The selected window now has the requested screen bounds."
          : `Windows adjusted the selected window bounds; actual frame is ${actual.x},${actual.y},${actual.width},${actual.height}.`,
        windowFrame: { requested, actual, verified },
      };
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  /**
   * Docks a window to a side/corner of its own monitor's real usable work
   * area -- screen bounds with the taskbar already subtracted, read fresh
   * from the native host, not guessed from full screen/monitor bounds and
   * not dependent on a drag happening to land on the exact physical edge
   * pixel Windows' own Aero Snap requires. This is the reliable way to
   * "snap"/"dock" a window; a plain drag can miss the edge trigger and just
   * reposition the window at its original size, which can end up hanging
   * over the taskbar.
   */
  async function snapWindow(name: string, position: "left" | "right" | "top" | "bottom" | "maximize",
    cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, session, pid, windowId, capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      const work = await manager.workArea(pid, windowId.toString());
      const half = (dimension: number) => Math.max(1, Math.floor(dimension / 2));
      const frame = position === "maximize" ? { x: work.x, y: work.y, width: work.width, height: work.height }
        : position === "left" ? { x: work.x, y: work.y, width: half(work.width), height: work.height }
          : position === "right" ? { x: work.x + work.width - half(work.width), y: work.y, width: half(work.width), height: work.height }
            : position === "top" ? { x: work.x, y: work.y, width: work.width, height: half(work.height) }
              : { x: work.x, y: work.y + work.height - half(work.height), width: work.width, height: half(work.height) };
      const actual = await manager.setWindowFrame(pid, windowId.toString(), frame);
      const verified = sameWindowFrame(frame, actual);
      const outcome: CuaStageActionOutcome = {
        status: verified ? "confirmed" : "partial",
        summary: verified
          ? `The selected window is docked ${position} in its monitor's usable work area.`
          : `Windows adjusted the selected window bounds while docking ${position}; actual frame is ${actual.x},${actual.y},${actual.width},${actual.height}.`,
        windowFrame: { requested: frame, actual, verified },
      };
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function focusWindow(name: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    if (options.deliveryMode === "background") {
      throw new DesktopInputNotDispatchedError("A background stage cannot bring a window to the owner's foreground; no input was sent.");
    }
    return withRegisteredWindow(name, async ({ driver, session, pid, windowId, capture: captureWindow }) =>
      foregroundLease.run(name, options.signal, async () => {
        let outcome: CuaStageActionOutcome;
        try {
          await manager.bringToForeground(pid, windowId.toString());
          outcome = { status: "unverified" };
        } catch (error) {
          throw new DesktopInputNotDispatchedError(error instanceof Error ? error.message : String(error), "foreground-lease");
        }
        options.signal?.throwIfAborted();
        const foreground = await manager.foregroundWindow(pid, windowId.toString(), 500);
        if (foreground.pid !== pid || BigInt(foreground.windowId) !== windowId) {
          throw new Error("Windows focused a different window; the selected application was not confirmed in front.");
        }
        return { capture: stageCapture(await captureWindow(), now), outcome };
      }), cursorIdentity);
  }

  async function systemControl(request: WindowsSystemControlRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const result = await manager.systemControl(request);
    signal?.throwIfAborted();
    return result;
  }

  async function invokeMenu(name: string, path: string[], cursorIdentity?: CuaAgentCursorIdentity,
    options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, session, pid, windowId, capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      if (!Array.isArray(path) || path.length === 0 || path.some((part) => typeof part !== "string" || !part.trim())) {
        throw new DesktopInputNotDispatchedError("The menu path is empty or invalid; no menu action was sent.", "target-identity");
      }
      let completedSegments = 0;
      try {
        // UIA menu invocation is resolved afresh at each level. This avoids
        // holding a stale COM element across a menu opening and works for
        // classic Win32, WinUI, and Electron menu providers alike.
        for (const segment of path) {
          const structure = await timed("accessibility-read", () => manager.windowStructure(pid, windowId.toString(), { maxElements: 4096, maxDepth: 64 }),
            { detail: "scope=window;purpose=menu-path" });
          const match = structure.elements.find((element) => element.enabled !== false
            && element.label.trim().localeCompare(segment.trim(), undefined, { sensitivity: "accent" }) === 0
            && (!element.actions || element.actions.invoke || element.actions.select || element.actions.toggle));
          if (!match?.rect) throw new DesktopInputNotDispatchedError(`No enabled menu control named “${segment}” was found in the exact window; no menu action was sent.`, "target-identity");
          const x = Math.floor(match.rect.x + match.rect.width / 2);
          const y = Math.floor(match.rect.y + match.rect.height / 2);
          // `pointControl(expected)` re-resolves this exact accessible control
          // and invokes it in one native request. Calling it twice used to
          // activate every menu segment twice, often toggling the menu closed.
          const result = await timedInputDispatch("uia-point", () => manager.pointControl(x, y, { label: match.label, pid, windowId: windowId.toString(), windowPid: pid,
            rect: match.rect, invoked: false }), (value) => value.invoked === true);
          if (!result.invoked) {
            if (completedSegments > 0) throw new DesktopInputOutcomeUnknownError(
              `Menu path stopped after ${completedSegments} segment(s); inspect the current menu before retrying.`);
            throw new DesktopInputNotDispatchedError(`Windows did not confirm menu segment “${segment}”; inspect the window before retrying.`, "driver-refused");
          }
          completedSegments++;
        }
        const outcome: CuaStageActionOutcome = { status: "unverified", summary: "Native UI Automation invoked each menu path segment; the refreshed capture is the semantic verification." };
        return { capture: stageCapture(await captureWindow(), now), outcome };
      } catch (error) {
        if (completedSegments > 0 && !(error instanceof DesktopInputOutcomeUnknownError)) {
          throw new DesktopInputOutcomeUnknownError(
            `Menu path partially dispatched ${completedSegments} segment(s); inspect the current menu before retrying. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (error instanceof DesktopInputOutcomeUnknownError) throw error;
        if (error instanceof DesktopInputNotDispatchedError) throw error;
        throw new DesktopInputNotDispatchedError(
          `Native menu invocation did not dispatch input. ${error instanceof Error ? error.message : String(error)}`,
          "driver-refused",
        );
      }
    }, cursorIdentity);
  }

  async function clipboardRead(name: string, includeText: boolean, cursorIdentity?: CuaAgentCursorIdentity,
    options: CuaStageInputOptions = {}) {
    return withRegisteredWindow(name, async ({ capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      const text = includeText ? await manager.clipboardRead() : undefined;
      return { capture: stageCapture(await captureWindow(), now), outcome: { status: "unverified" as const,
        summary: includeText ? "Native clipboard text was read." : "Native clipboard availability was read." },
        clipboard: includeText ? { text } : { available: true } };
    }, cursorIdentity);
  }

  async function clipboardWrite(name: string, text: string, cursorIdentity?: CuaAgentCursorIdentity,
    payload?: { imagePath?: string; filePath?: string }, options: CuaStageInputOptions = {}) {
    return withRegisteredWindow(name, async ({ capture: captureWindow }) => {
      options.signal?.throwIfAborted();
      if (payload?.imagePath || payload?.filePath) throw new DesktopInputNotDispatchedError(
        "The native stage clipboard currently accepts text only; no clipboard payload was written.", "native-dispatch-unavailable");
      await manager.clipboardWrite(text);
      return { capture: stageCapture(await captureWindow(), now), outcome: { status: "unverified" as const,
        summary: "Native clipboard text was written." } };
    }, cursorIdentity);
  }

  async function windowState(name: string, state: "minimized" | "maximized" | "restored") {
    await manager.setWindowState(name, state);
    return { outcome: { status: "confirmed" as const, summary: `Exact window state verified: ${state}.` },
      postcondition: { kind: "window-state", state, verified: true } };
  }

  async function closeAgentCursor(cursorIdentity: CuaAgentCursorIdentity): Promise<void> {
    const details = agentCursorDetails(cursorIdentity);
    const overlaySession = cursorSessionNames.get(details.key) ?? details.session;
    const presentation = cursorOverlayPresentations.get(overlaySession);
    // The real retry loop is the caller's: task-desktop-stage.ts's cursor reaper
    // polls every 250ms for as long as the entry stays in activeAgentCursors,
    // and its own catch blocks are written to keep an entry around on failure.
    // This function used to delete the presentation record and swallow every
    // failure *before* that loop ever saw one, which both lied about success
    // and destroyed the one thing (the presentation id) a later retry would
    // need -- so a hide that failed even once orphaned the marker forever. Now:
    // keep the presentation until hide actually succeeds, and let failure
    // propagate so the caller's forever-retry loop actually gets to retry.
    if (presentation && cursorOverlayHost) {
      let hidden = false;
      for (let attempt = 0; attempt < 3 && !hidden; attempt++) {
        hidden = await cursorOverlayHost.hide(presentation.id).catch(() => false);
        if (!hidden && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!hidden) throw new Error("cursor overlay hide ack never arrived");
    }
    cursorOverlayPresentations.delete(overlaySession);
    // The input target registry is owned by the logical agent identity, not by
    // the optional cursor process. A target may have been remembered while the
    // cursor overlay was absent; revoking/closing that agent must clear it too.
    agentSessions.delete(details.key);
    cursorSessionNames.delete(details.key);
    cursorStartSlots.delete(details.key);
    cursorPresentationWork.delete(details.key);
    forgetAgentDesktopInputTargets(cursorIdentity);
  }

  async function shutdown(): Promise<void> {
    agentSessions.clear();
    cursorSessionNames.clear();
    cursorOverlayPresentations.clear();
    cursorStartSlots.clear();
    desktopInputTargets.clear();
    await cursorOverlayHost?.close().catch(() => undefined);
  }

  return { capture, readStructure, readElementValue, readDesktopStructure, describeTarget, describeElementTarget, valueMutationRegion, observedValueMutationRegions, showAgentCursor, sayAgentCursor, moveCursor, listWindows, listVisibleWindows, click, typeText, scroll, scrollDelta, scrollElement, drag,
    clickElement, replaceElement, windowFrame, snapWindow, windowState, focusWindow, systemControl, invokeMenu, clipboardRead, clipboardWrite,
    captureDesktop, describeDesktopTarget, moveDesktopCursor, clickDesktop, typeTextDesktop, scrollDesktop, scrollDeltaDesktop, dragDesktop,
    pressKey, hotkey, pressKeyDesktop, hotkeyDesktop, closeAgentCursor, shutdown,
    clickPopup, pressKeyPopup, hotkeyPopup, typeTextPopup, capturePopup, describePopupTarget, saveAs, confirmDialogButton };
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
