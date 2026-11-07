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
import { classifySaveAsConflict, findSaveAsButton, findSaveAsNameField, resolveSaveAsTarget } from "./stage-save-as";

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
const CURSOR_THEME_ID = /^[A-Za-z0-9._:-]{1,64}$/.test(process.env.M9R_CURSOR_THEME ?? "")
  ? process.env.M9R_CURSOR_THEME!
  : "cua.default";

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
  /** Internal stage policy; background stages may never escalate to the owner's foreground. */
  deliveryMode?: "background" | "owner-preview";
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
  /** Bounded confirmation window for Cua's compositor-backed cursor overlay. */
  cursorVisiblePoll?: CursorVisiblePoll;
}

interface CursorVisiblePoll {
  attempts: number;
  intervalMs: number;
}

/**
 * Cua can return from enabling/moving a cursor before Windows has committed
 * the overlay window. A single immediate read therefore races the compositor
 * and produces a false "overlay not visible" failure. Keep the retry bounded:
 * a cursor that never confirms still fails closed and no input is sent.
 */
const DEFAULT_CURSOR_VISIBLE_POLL: CursorVisiblePoll = { attempts: 6, intervalMs: 150 };
const CURSOR_PRESENTATION_ACTION_WAIT_MS = 250;

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

function validCursorVisiblePoll(poll: CursorVisiblePoll | undefined): CursorVisiblePoll {
  if (poll === undefined) return DEFAULT_CURSOR_VISIBLE_POLL;
  if (!Number.isSafeInteger(poll.attempts) || poll.attempts < 1 || poll.attempts > 20
    || !Number.isSafeInteger(poll.intervalMs) || poll.intervalMs < 0 || poll.intervalMs > 1_000) {
    throw new Error("Invalid cursor visibility poll: attempts must be 1-20 and intervalMs 0-1000.");
  }
  return poll;
}

async function waitForCursorVisible(
  readSession: () => Promise<{ cursorVisible?: boolean }>,
  poll: CursorVisiblePoll,
  onAttempt?: (attempt: number) => void,
): Promise<boolean> {
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    onAttempt?.(attempt + 1);
    if ((await readSession()).cursorVisible === true) return true;
    if (attempt < poll.attempts - 1) await delay(poll.intervalMs);
  }
  return false;
}

export interface CuaStageTimingEvent {
  phase: "sdk-load" | "host-connect" | "runtime-acquire" | "session-start" | "cursor-motion" | "cursor-position" | "cursor-visible"
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
    // Cua renders this field beside the cursor. The broker allocates a public
    // ordinal when two identities share this name; credentials stay private.
    session: publicCursorLabel(handle).slice(0, PUBLIC_CURSOR_LABEL_MAX_LENGTH),
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

function cursorScreenPoint(x: number, y: number, frame: CuaStageWindowFrame): { x: number; y: number } {
  const bounds = frame.windowBounds;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    throw new Error("Cua Driver did not provide valid screen bounds for this stage window.");
  }
  // Stage coordinates are pixels in the native window screenshot. Expose the
  // corresponding screen location separately for evidence; the Cua cursor API
  // itself receives coordinates in Cua's own window screenshot space.
  return {
    x: bounds.x + x * bounds.width / frame.width,
    y: bounds.y + y * bounds.height / frame.height,
  };
}

interface CuaWindowCursorTarget {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
}

function cursorPointInCuaWindow(screenPoint: { x: number; y: number }, state: Awaited<ReturnType<CuaDriverLike["getWindowState"]>>,
  image: { width: number; height: number }): CuaWindowCursorTarget {
  const bounds = state.windowBounds;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("Cua Driver did not return valid bounds for its window screenshot; cursor alignment is unknown.");
  }
  const x = Math.floor((screenPoint.x - bounds.x + 0.5) * image.width / bounds.width);
  const y = Math.floor((screenPoint.y - bounds.y + 0.5) * image.height / bounds.height);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new Error("The native target point is outside Cua Driver's current window screenshot; cursor alignment is unknown.");
  }
  return { x, y, screenX: screenPoint.x, screenY: screenPoint.y, width: image.width, height: image.height };
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
  return hit ? { label: normalizeAccessibleLabel(hit.label) ?? "", rect: hit.rect } : undefined;
}

/**
 * Cua Driver window-only local desktop-stage adapter. Every action is addressed to the exact registered
 * PID/HWND pair; frames and window labels remain local to the native pill.
 */
export function createCuaStageDriver(deps: CuaStageDriverDependencies = {}) {
  const manager = deps.manager ?? createWindowsDesktopStageManager(deps.stage);
  const timingContext = new AsyncLocalStorage<{ stageName: string; afterDispatch: boolean }>();
  // The Cua package is only the visual cursor overlay. Perception and input
  // belong to M9R's native Windows stage host; there is no compatibility route
  // that can silently switch to a second engine after a native failure.

  /**
   * Build one native sender for a registered stage. Semantic UIA operations
   * can remain headless. When a control requires OS input, the exact window
   * must already be on the owner's currently visible desktop and uses the
   * shared foreground lease; computer-use actions never create or activate a
   * separate Windows virtual desktop.
   */
  function nativeStageInput(pid: number, windowId: string | bigint,
    send: () => Promise<void>) {
    const target = windowId.toString();
    return {
      bringToFront: () => manager.bringToForeground(pid, target),
      send: () => timedInputDispatch("native", send),
    };
  }

  function invokeWindowElementTimed(pid: number, windowId: string, input: Parameters<typeof manager.invokeWindowElement>[2]) {
    return timedInputDispatch("uia-element", () => manager.invokeWindowElement(pid, windowId, input), (result) => result.dispatched);
  }

  async function nativeReplaceTextAtScreenPoint(pid: number, windowId: string | bigint, x: number, y: number, text: string,
    input: { session: string; signal?: AbortSignal; deliveryMode?: "background" | "owner-preview"; preferForeground?: boolean }): Promise<CuaStageActionOutcome> {
    const targetWindowId = windowId.toString();
    const outcome = await driverInputAction("type_text", {
      pid, window_id: Number(targetWindowId), x, y, text, session: input.session,
    }, "M9R could not replace text in the selected field.", {
      signal: input.signal,
      deliveryMode: input.deliveryMode,
      preferForeground: input.preferForeground,
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
  const loadSdk = deps.loadSdk ?? loadCuaSdk;
  const now = deps.now ?? (() => new Date());
  const cursorVisiblePoll = validCursorVisiblePoll(deps.cursorVisiblePoll);
  const root = deps.stage?.root ?? defaultStoreRoot(homedir(), deps.stage?.env ?? process.env);
  // Provider workers are separate processes, but Windows still exposes one
  // foreground input stream. Share the lease through the M9R store so Paint,
  // Calculator, or any other target cannot be focused by two workers at once.
  const foregroundLease = deps.foregroundLease ?? createForegroundInputLease({ lockPath: join(root, "foreground-input-lease") });
  const agentSessions = new Map<string, AgentCursorSession>();
  const cursorSessionNames = new Map<string, string>();
  const sessionRefreshedAt = new Map<string, number>();
  const sessionRefreshes = new Map<string, Promise<void>>();
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

  async function bestEffortCursorPresentation(key: string, run: () => Promise<unknown>): Promise<CursorPresentationOutcome> {
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
      return await Promise.race([completion, new Promise<CursorPresentationOutcome>((done) => {
        timer = setTimeout(() => done({ status: "timed-out" }), CURSOR_PRESENTATION_ACTION_WAIT_MS);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const desktopCaptures = new Map<string, CachedDesktopCapture>();
  const desktopInputTargets = new Map<string, DesktopInputTarget>();
  // Keep the semantics from the observation that issued each raw UIA ref.
  // Native token prefixes rotate on every walk, including the money-gate read.
  const observedElements = new Map<string, Map<string, CuaWindowElement>>();
  // Native UIA refs belong to the native tree, never to Cua Driver's opaque
  // element-token namespace. Keep the exact observation identity locally so
  // the native dispatcher can re-resolve and validate the same control.
  const nativeObservedElements = new Map<string, Map<string, NativeWindowStructureElement>>();
  let agentRuntimePromise: Promise<CuaRuntime> | undefined;
  let agentRuntimeReady: CuaRuntime | undefined;

  function emitTiming(event: CuaStageTimingEvent): void {
    try { deps.onTiming?.(event); } catch { /* diagnostics must never affect desktop control */ }
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

  async function mapNativeStagePointToCuaWindow(driver: CuaDriverLike, session: string, pid: number, windowId: bigint,
    x: number, y: number, captureWidth: number, captureHeight: number): Promise<CuaWindowCursorTarget> {
    if (![x, y, captureWidth, captureHeight].every(Number.isFinite) || captureWidth <= 0 || captureHeight <= 0) {
      throw new Error("The native window capture has no valid coordinate space; cursor alignment is unknown.");
    }
    // M9R's stage helper and Cua Driver can capture the same HWND at different
    // pixel scales. Cursor coordinates must be expressed in Cua's own fresh
    // window screenshot space, then mapped from the current native HWND bounds.
    // Passing the raw M9R pixels through caused the overlay to land on a
    // different control when these capture sizes differed.
    const state = await timed("window-capture", () => driver.getWindowState({
      pid,
      windowId,
      session,
      includeAccessibilityTree: false,
      includeScreenshot: true,
      maxImageDimension: 0,
    }), { detail: "scope=cursor-coordinate-map;source=cua-window-screenshot" });
    const image = imageFromWindowState(state, pid, windowId);
    const rect = await manager.windowRect(pid, windowId.toString());
    const screenPoint = {
      x: rect.x + Math.floor((x + 0.5) * rect.width / captureWidth),
      y: rect.y + Math.floor((y + 0.5) * rect.height / captureHeight),
    };
    return cursorPointInCuaWindow(screenPoint, state, image);
  }

  /**
   * Record the bounded compositor confirmation separately from cursor motion.
   * This is diagnostics only: the same bounded poll and fail-closed result are
   * preserved, while the owner broker can now distinguish a motion/position
   * failure from an overlay that became visible too late or never appeared.
   */
  async function confirmCursorVisible(
    stageName: string | undefined,
    readSession: () => Promise<{ cursorVisible?: boolean }>,
  ): Promise<boolean> {
    // `waitForCursorVisible` returns false for a bounded miss rather than
    // throwing, but the timing contract needs that miss to be recorded as an
    // error. Convert only this local sentinel back to `false` so callers keep
    // their existing error messages and fail-closed behavior.
    const notVisible = new Error("cursor overlay visibility was not confirmed");
    let attempts = 0;
    try {
      return await timed("cursor-visible", async () => {
        if (!await waitForCursorVisible(readSession, cursorVisiblePoll, (attempt) => { attempts = attempt; })) throw notVisible;
        return true;
      }, () => ({
        ...(stageName ? { stageName } : {}),
        detail: `attempts=${attempts};maxAttempts=${cursorVisiblePoll.attempts};intervalMs=${cursorVisiblePoll.intervalMs}`,
      }));
    } catch (error) {
      if (error === notVisible) return false;
      throw error;
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

  async function agentRuntime(stageName?: string): Promise<CuaRuntime> {
    // No preflight liveness check here on purpose: this is called on every single
    // access. This runtime owns only the optional cursor overlay, never the
    // native perception or action pipeline. A cursor failure cannot reset or
    // replay a native app action.
    const cached = Boolean(agentRuntimePromise);
    if (!agentRuntimePromise) {
      const runtimePromise = createRuntime(stageName);
      agentRuntimePromise = runtimePromise;
      void runtimePromise.then((runtime) => {
        if (agentRuntimePromise === runtimePromise) agentRuntimeReady = runtime;
      }, () => undefined);
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
    const refreshedAt = sessionRefreshedAt.get(details.key);
    const at = now().getTime();
    if (alreadyTracked && refreshedAt !== undefined && at >= refreshedAt && at - refreshedAt < 60_000) {
      return { runtime, session: agentSessions.get(details.key)! };
    }
    const pending = sessionRefreshes.get(details.key);
    if (pending) {
      await pending;
      return { runtime, session: agentSessions.get(details.key)! };
    }
    const refresh = (async () => {
    let started = false;
    try {
      // Refresh well within Cua's five-minute idle TTL. A warm action reuses
      // the broker session instead of paying two presentation RPCs per probe.
      const motionStyle = runtime.sdk.CursorMotionStyle?.Adaptive;
      const motionTiming = runtime.sdk.CursorMotionTiming?.Native;
      const cursorMotion = typeof motionStyle === "number" && typeof motionTiming === "number"
        ? { style: motionStyle, timing: motionTiming, glideDurationMs: 140,
          effects: { trail: true, glow: true }, dwellAfterClickMs: 80, idleHideMs: 0 }
        : undefined;
      const startedSession = await timed("session-start", () => runtime.driver.startSession({
        session: details.session,
        cursorTheme: {
          // Presentation is deliberately configurable without changing the
          // native targeting/action contract. The default remains the current
          // Cua overlay until M9R's own cursor artwork is shipped.
          themeId: CURSOR_THEME_ID,
          reducedMotion: runtime.sdk.CursorReducedMotion.Auto as import("@trycua/cua-driver").CursorReducedMotion,
        },
        ...(cursorMotion ? { cursorMotion } : {}),
      }), { stageName, cached: alreadyTracked, detail: cursorMotion ? "cursorMotion=initial;idleHideMs=0" : "cursorMotion=runtime-default" });
      started = true;
      // Configure persistence before first visibility. If an older native
      // host does not echo the initial configuration, use the session setter
      // as a compatibility path. This preference is presentation-only: a
      // failed setting is recorded, but it must not suppress desktop actions.
      const initialMotionApplied = startedSession.cursorMotion?.idleHideMs === 0;
      if (cursorMotion && !initialMotionApplied) {
        try {
          const motion = await timed("cursor-motion", () => runtime.driver.setAgentCursorMotion({
            session: details.session,
            ...cursorMotion,
          }), { stageName, cached: alreadyTracked });
          resultError(motion, "Cua Driver could not configure the optional agent cursor motion.");
        } catch {
          // The owner-visible cursor path is best-effort. Keep the failure in
          // timing evidence and let the action path proceed independently.
        }
      }
      agentSessions.set(details.key, details);
      sessionRefreshedAt.set(details.key, now().getTime());
    } catch (error) {
      if (started && !alreadyTracked) {
        try { await runtime.driver.endSession({ session: details.session }); } catch { /* preserve the session setup error */ }
      }
      throw error;
    }
    })();
    sessionRefreshes.set(details.key, refresh);
    try { await refresh; }
    finally { if (sessionRefreshes.get(details.key) === refresh) sessionRefreshes.delete(details.key); }
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
  async function showAgentCursor(name: string, identity: CuaAgentCursorIdentity): Promise<{ label: string; visible: boolean }> {
    const { runtime, session } = await ensureAgentSession(identity, name);
    let positioned = false;
    const presentation = await bestEffortCursorPresentation(session.key, async () => {
      resultError(await runtime.driver.setAgentCursorEnabled({ session: session.session, enabled: true }), "Cua Driver could not show the agent cursor before the first desktop action.");
      await withCursorSlotLock(async () => {
        if (cursorStartSlots.has(session.key)) { positioned = true; return; }
        // The previous startup position was a fixed grid over the whole
        // display, so the agent marker could appear detached from every app
        // before it had made its first move. Anchor the idle marker inside the
        // owner's verified foreground window instead. This is overlay-only;
        // it never repositions the owner's physical pointer or activates a
        // window. If the owner window cannot be inspected, the first actual
        // action will establish the cursor position from its fresh target.
        let foreground: Awaited<ReturnType<typeof manager.currentForegroundWindow>> | undefined;
        let bounds: CuaStageWindowBounds | undefined;
        try {
          foreground = await manager.currentForegroundWindow();
          if (foreground.visible && !foreground.minimized
            && !/m9r(?:[- ]overlay)?|agent cursor overlay|cua cursor overlay/i.test(`${foreground.title} ${foreground.className}`)) {
            bounds = await manager.windowRect(foreground.pid, foreground.windowId);
          }
        } catch {
          // Startup presentation is best-effort. The task action path will
          // still place the marker when it has a concrete target.
        }
        if (!foreground || !bounds || bounds.width < 1 || bounds.height < 1) return;
        const occupied = new Set(cursorStartSlots.values());
        let slot = 0;
        while (occupied.has(slot)) slot++;
        if (slot >= 16) {
          await timed("cursor-position", async () => { throw new Error("No free agent cursor starting position is available."); },
            { stageName: name, detail: "scope=initial-overlay;best-effort=true" }).catch(() => undefined);
          return;
        }
        const screenX = Math.floor(bounds.x + bounds.width * ((slot % 4) + 1) / 5);
        const screenY = Math.floor(bounds.y + bounds.height * (Math.floor(slot / 4) + 1) / 5);
        try {
          const pid = foreground.pid;
          const windowId = parseWindowId(foreground.windowId);
          const snapshot = await timed("window-capture", () => runtime.driver.getWindowState({
            pid, windowId, session: session.session, includeAccessibilityTree: false, includeScreenshot: true, maxImageDimension: 0,
          }), { stageName: name, detail: "scope=initial-cursor-coordinate-map;source=cua-window-screenshot" });
          const image = imageFromWindowState(snapshot, pid, windowId);
          const target = cursorPointInCuaWindow({ x: screenX, y: screenY }, snapshot, image);
          // Window-target cursor motion is presentation-only. A desktop target
          // would move the owner's physical pointer, so keep the exact HWND
          // target and convert the point to Cua's screenshot coordinate space.
          resultError(await runtime.driver.moveCursor({ x: target.x, y: target.y,
            target: new runtime.sdk.ActionTarget.Window({ pid, windowId }), session: session.session }), "Cua Driver could not place the agent cursor.");
          const cursorState = cursorStateFromResult(await runtime.driver.getAgentCursorState({ session: session.session }));
          if (!cursorState.enabled || cursorState.x !== target.x || cursorState.y !== target.y) {
            throw new DesktopInputNotDispatchedError("Cua Driver did not confirm the agent cursor starting position.", "position-unconfirmed");
          }
          cursorStartSlots.set(session.key, slot);
          positioned = true;
        } catch (error) {
          await timed("cursor-position", async () => { throw error; },
            { stageName: name, detail: "scope=initial-overlay;best-effort=true" }).catch(() => undefined);
        }
      });
    });
    if (presentation.status === "failed") {
      await timed("cursor-visible", async () => {
        throw presentation.error instanceof Error ? presentation.error : new Error("The initial cursor overlay could not be presented.");
      }, { stageName: name, detail: "scope=initial-overlay;best-effort=true" }).catch(() => undefined);
      await hideAgentCursor(runtime.driver, session.session);
    }
    if (presentation.status === "timed-out") {
      await timed("cursor-position", async () => { throw new Error("The initial cursor presentation exceeded its bounded wait."); },
        { stageName: name, detail: "scope=initial-overlay;best-effort=true" }).catch(() => undefined);
      return { label: session.session, visible: false };
    }
    if (!positioned) {
      try { await runtime.driver.setAgentCursorEnabled({ session: session.session, enabled: false }); }
      catch { /* a misplaced visual marker must not become an input gate */ }
      return { label: session.session, visible: false };
    }
    // Cursor rendering is a best-effort visual aid. A missing compositor or
    // incorrect initial marker position must be visible in diagnostics, but
    // cannot gate a separate native/semantic app action.
    const visible = await confirmCursorVisible(name, () => runtime.driver.getSession({ session: session.session })).catch(() => false);
    return { label: session.session, visible };
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
    return timingContext.run({ stageName: stage.name, afterDispatch: false }, () => run({ runtime: agentRuntimeReady, session, capture }));
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
  options: { preferForeground?: boolean; signal?: AbortSignal; deliveryMode?: "background" | "owner-preview";
    nativeForeground?: { bringToFront: () => Promise<void>; send: () => Promise<void> } } = {}) {
  assertNotAbortedBeforeInput(options.signal);
  // Omitted mode follows the owner-visible stage contract. Background is an
  // explicit request and may only use a semantic caller path that does not
  // reach this physical sender.
  const deliveryMode = options.deliveryMode ?? "owner-preview";
  const ownerPointer = deps.ownerPointer ?? { get: () => manager.getOwnerCursorPosition(), restore: (x: number, y: number) => manager.restoreOwnerCursorPosition(x, y) };
  let foregroundPointer: { x: number; y: number } | undefined;
  const deliverForeground = async (): Promise<CuaStageActionOutcome> => {
    const pid = args.pid;
    const windowId = args.window_id;
    if (!Number.isSafeInteger(pid) || (pid as number) < 1 || typeof windowId !== "number" || !Number.isFinite(windowId)
      || !Number.isInteger(windowId) || windowId < 1) {
      throw new DesktopInputNotDispatchedError("The foreground action is missing the exact target window identity; no input was sent.", "target-identity");
    }
    const targetPid = pid as number;
    const targetWindowId = windowId as number;
    const saved = foregroundPointer;
    // The owner has explicitly opted into sharing real input: the agent dispatches
    // regardless of concurrent owner pointer movement. Only the pointer's resting
    // position is preserved below, for a clean restore after the action.
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
      await options.nativeForeground.send();
      // Native SendInput reports only OS-level delivery. The caller's refreshed
      // UIA capture is the separate semantic verification signal.
      outcome = { status: "unverified" };
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
  const runForeground = async () => {
    // The owner has explicitly opted into agents sharing real foreground input on
    // their own machine: concurrent pointer movement is never a reason to wait or
    // refuse. Only the resting position is captured here, purely so it can be
    // restored after the action -- not to gate dispatch on it.
    const saved = await ownerPointer.get().catch(() => undefined);
    foregroundPointer = saved;
    return timed("foreground-lease", () => foregroundLease.run(name, options.signal, deliverForeground), {
    detail: `action=${name};delivery=foreground`,
  }).catch((error) => {
    if (error instanceof ForegroundInputLeaseError) {
      throw new DesktopInputNotDispatchedError(error.message, "foreground-lease");
    }
    throw error;
    });
  };
  // Semantic UIA actions are dispatched headlessly by their call sites. A
  // background request must never fall through to SendInput, because Windows
  // delivers it to the real foreground window and physical pointer. Only the
  // owner-visible mode may acquire the short global input lease.
  if (deliveryMode === "background") {
    throw new DesktopInputNotDispatchedError(
      `${fallback} This target has no supported headless semantic route; background mode sent no input and did not activate a window.`,
      "background-unavailable",
    );
  }
  if (options.nativeForeground) return runForeground();
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
    delayMs?: number;
    nativeForeground?: { bringToFront: () => Promise<void>; send: () => Promise<void> };
    signal?: AbortSignal;
  }): Promise<CuaStageActionOutcome> {
    const windowId = input.windowId.toString();
    // A live, not-yet-aborted signal is the normal case for every real call (act()
    // always hands one in, purely so an in-flight action can be cancelled). Only an
    // *already aborted* signal is a reason to skip these fast, headless-safe paths;
    // the mere presence of a cancellable signal is not.
    if (!input.signal?.aborted && !input.preferForeground && input.nativeInput && await input.nativeInput()) {
      return { status: "unverifiable", summary: "Posted text to the selected native edit control; application effect requires verification." };
    }
    // Background mode must never fall through to SendInput (see the fail-closed guard in
    // driverInputAction below), but a plain Win32 control that lacks a UIA value pattern still
    // has a real headless route: WM_CHAR posted straight to its own message queue, which never
    // requires and never steals OS foreground. Try it before giving up as unavailable.
    if (!input.signal?.aborted && !input.preferForeground && input.deliveryMode === "background") {
      await manager.sendTextToWindow(input.pid, windowId, input.text);
      return { status: "unverifiable", summary: "Posted text to the target window's own message queue (WM_CHAR, no OS foreground required); application effect requires verification." };
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
    const image = await manager.captureWindow(pid, windowId.toString());
    const frame: CuaStageWindowFrame = { ...image, windowBounds: boundsAtWindowCapture(image) };
    const localPoint = desktopPointInWindow(screenPoint, frame);
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
      windowCaptureSize: { width: frame.width, height: frame.height }, state: { elements } };
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

  async function moveOwnerCursor(runtime: CuaRuntime | undefined, session: AgentCursorSession, point: ResolvedDesktopPoint, requireProof = false): Promise<CuaStageCursorProof> {
    if (!runtime) {
      if (requireProof) throw new DesktopInputNotDispatchedError("The cursor overlay is unavailable; no cursor movement was confirmed.", "overlay-not-visible");
      return { x: point.desktopPoint.x, y: point.desktopPoint.y, screenX: point.screenPoint.x, screenY: point.screenPoint.y, enabled: false, visible: false };
    }
    if (!requireProof) {
      let positionVerified = false;
      let mappedTarget: CuaWindowCursorTarget | undefined;
      const presentation = await bestEffortCursorPresentation(session.key, async () => {
        resultError(await runtime.driver.setAgentCursorEnabled({ session: session.session, enabled: true }), "Cursor presentation unavailable.");
        if (point.shellControl) {
          await runtime.driver.callTool("move_cursor", JSON.stringify({ scope: "window", x: point.screenPoint.x, y: point.screenPoint.y, session: session.session }));
        } else {
          const size = point.windowCaptureSize;
          if (!size) throw new Error("The native stage did not retain its source capture size; cursor alignment is unknown.");
          mappedTarget = await mapNativeStagePointToCuaWindow(runtime.driver, session.session, point.target.pid,
            BigInt(point.target.windowId), point.localPoint.x, point.localPoint.y, size.width, size.height);
          await runtime.driver.moveCursor({ x: mappedTarget.x, y: mappedTarget.y,
            target: new runtime.sdk.ActionTarget.Window(point.target), session: session.session });
        }
        const state = cursorStateFromResult(await runtime.driver.getAgentCursorState({ session: session.session }));
        const targetPoint = point.shellControl ? point.screenPoint : mappedTarget;
        if (!targetPoint) throw new Error("No exact cursor coordinate mapping was available.");
        positionVerified = state.enabled && state.x === targetPoint.x && state.y === targetPoint.y;
        if (!positionVerified) throw new Error(`The overlay position did not match the target (${state.x ?? "missing"},${state.y ?? "missing"}).`);
      });
      if (presentation.status === "failed") await hideAgentCursor(runtime.driver, session.session);
      try {
        await timed("cursor-position", async () => {
          if (presentation.status !== "completed" || !positionVerified) {
            const reason = presentation.error instanceof Error ? presentation.error.message : presentation.status;
            throw new Error(`presentation=${presentation.status};${reason}`);
          }
        }, () => ({ detail: `${point.shellControl ? "space=desktop-screen" : "space=cua-window-screenshot"};best-effort=true;presentation=${presentation.status}` }));
      } catch {
        // A visual-only failure is evidence, not a reason to block native input.
      }
      const aligned = presentation.status === "completed" && positionVerified;
      return { x: point.desktopPoint.x, y: point.desktopPoint.y, screenX: point.screenPoint.x, screenY: point.screenPoint.y,
        enabled: aligned, visible: aligned };
    }
    return withCursorPresentation(session.key, async () => {
      resultError(await runtime.driver.setAgentCursorEnabled({ session: session.session, enabled: true }), "Cua Driver could not enable the desktop agent cursor.");
      let mappedTarget: CuaWindowCursorTarget | undefined;
      if (point.shellControl) {
        // The Windows shell HWND is not exposed by Cua's window inventory, so it
        // cannot be represented by ActionTarget.Window. Its documented window
        // scope moves only this agent's overlay in screen coordinates; Desktop
        // scope would move the owner's physical pointer and is never used.
        resultError(await runtime.driver.callTool("move_cursor", JSON.stringify({
          scope: "window", x: point.screenPoint.x, y: point.screenPoint.y, session: session.session,
        })), "Cua Driver could not move the labeled shell overlay cursor.");
      } else {
        const size = point.windowCaptureSize;
        if (!size) throw new DesktopInputNotDispatchedError("The native stage did not retain its source capture size; cursor position cannot be proven.", "position-unconfirmed");
        mappedTarget = await mapNativeStagePointToCuaWindow(runtime.driver, session.session, point.target.pid,
          BigInt(point.target.windowId), point.localPoint.x, point.localPoint.y, size.width, size.height);
        const target = new runtime.sdk.ActionTarget.Window(point.target);
        resultError(await runtime.driver.moveCursor({ x: mappedTarget.x, y: mappedTarget.y, target, session: session.session }), "Cua Driver could not move the labeled cursor on the exact window.");
      }
      const state = cursorStateFromResult(await runtime.driver.getAgentCursorState({ session: session.session }));
      // Cua reports a window-target cursor in the same window-local screenshot
      // space used by moveCursor. The legacy shell route reports desktop-screen
      // coordinates because it has no HWND target. Comparing both routes to the
      // physical screen point made every scaled desktop capture fail even though
      // the synthetic cursor had moved correctly.
      const expected = point.shellControl ? point.screenPoint : mappedTarget;
      if (!expected) throw new DesktopInputNotDispatchedError("No exact cursor coordinate mapping was available.", "position-unconfirmed");
      await timed("cursor-position", async () => {
        if (!state.enabled || state.x === undefined || state.y === undefined
          || Math.abs(state.x - expected.x) > 1 || Math.abs(state.y - expected.y) > 1) {
          throw new DesktopInputNotDispatchedError(`Cua Driver did not confirm the requested desktop cursor position (expected ${expected.x},${expected.y}; actual ${state.x ?? "missing"},${state.y ?? "missing"}; enabled ${state.enabled}).`, "position-unconfirmed");
        }
      }, { detail: point.shellControl ? "space=desktop-screen" : "space=cua-window-screenshot" });
      if (!await confirmCursorVisible(undefined, () => runtime.driver.getSession({ session: session.session }))) {
        throw new DesktopInputNotDispatchedError("Cua Driver moved the cursor but did not confirm its overlay is visible on the owner's desktop within the bounded confirmation window.", "overlay-not-visible");
      }
      return { x: point.desktopPoint.x, y: point.desktopPoint.y, screenX: point.screenPoint.x, screenY: point.screenPoint.y, enabled: true, visible: true };
    });
  }

  async function moveAndVerifyCursor(input: { driver?: CuaDriverLike; sdk?: CuaSdk; session: string; pid: number; windowId: bigint }, x: number, y: number, frame: CuaStageWindowFrame, requireProof = false): Promise<CuaStageCursorProof> {
    const driver = input.driver;
    const sdk = input.sdk;
    if (!driver || !sdk) {
      if (requireProof) throw new DesktopInputNotDispatchedError("The cursor overlay is unavailable; no cursor movement was confirmed.", "overlay-not-visible");
      return { x, y, screenX: x, screenY: y, enabled: false, visible: false };
    }
    if (!requireProof) {
      let positionVerified = false;
      let mappedTarget: CuaWindowCursorTarget | undefined;
      const presentation = await bestEffortCursorPresentation(input.session, async () => {
        resultError(await driver.setAgentCursorEnabled({ session: input.session, enabled: true }), "Cursor presentation unavailable.");
        mappedTarget = await mapNativeStagePointToCuaWindow(driver, input.session, input.pid, input.windowId,
          x, y, frame.width, frame.height);
        await driver.moveCursor({ x: mappedTarget.x, y: mappedTarget.y,
          target: new sdk.ActionTarget.Window({ pid: input.pid, windowId: input.windowId }), session: input.session });
        const state = cursorStateFromResult(await driver.getAgentCursorState({ session: input.session }));
        positionVerified = state.enabled && state.x === mappedTarget.x && state.y === mappedTarget.y;
        if (!positionVerified) throw new Error(`The overlay position did not match the target (${state.x ?? "missing"},${state.y ?? "missing"}).`);
      });
      if (presentation.status === "failed") await hideAgentCursor(driver, input.session);
      try {
        await timed("cursor-position", async () => {
          if (presentation.status !== "completed" || !positionVerified) {
            const reason = presentation.error instanceof Error ? presentation.error.message : presentation.status;
            throw new Error(`presentation=${presentation.status};${reason}`);
          }
        }, () => ({ detail: `space=cua-window-screenshot;best-effort=true;presentation=${presentation.status}` }));
      } catch {
        // A visual-only failure is evidence, not a reason to block native input.
      }
      const point = mappedTarget ?? { x, y, screenX: x, screenY: y, width: frame.width, height: frame.height };
      const aligned = presentation.status === "completed" && positionVerified;
      return { x, y, screenX: point.screenX, screenY: point.screenY, enabled: aligned, visible: aligned };
    }
    return withCursorPresentation(input.session, async () => {
      const point = await mapNativeStagePointToCuaWindow(driver, input.session, input.pid, input.windowId,
        x, y, frame.width, frame.height);
      resultErrorTyped(await driver.setAgentCursorEnabled({ session: input.session, enabled: true }), "Cua Driver could not enable the agent cursor.");
      resultErrorTyped(await driver.moveCursor({ x: point.x, y: point.y,
        target: new sdk.ActionTarget.Window({ pid: input.pid, windowId: input.windowId }), session: input.session }), "Cua Driver could not move the agent cursor.");
      const state = cursorStateFromResult(await driver.getAgentCursorState({ session: input.session }));
      await timed("cursor-position", async () => {
        if (!state.enabled || state.x === undefined || state.y === undefined || Math.abs(state.x - point.x) > 1 || Math.abs(state.y - point.y) > 1) {
          throw new DesktopInputNotDispatchedError(`Cua Driver did not confirm the requested agent cursor position on this stage window (expected ${point.x},${point.y}; actual ${state.x ?? "missing"},${state.y ?? "missing"}).`, "position-unconfirmed");
        }
      }, { detail: "space=cua-window-screenshot" });
      if (!await confirmCursorVisible(undefined, () => driver.getSession({ session: input.session }))) {
        throw new DesktopInputNotDispatchedError("Cua Driver moved the agent cursor but did not confirm that its desktop overlay is visible within the bounded confirmation window.", "overlay-not-visible");
      }
      return { x, y, screenX: point.screenX, screenY: point.screenY, enabled: true as const, visible: true as const };
    });
  }

  async function hideAgentCursor(driver: CuaDriverLike, session: string): Promise<void> {
    try {
      await driver.setAgentCursorEnabled({ session, enabled: false });
    } catch {
      // Cleanup must never mask the action's original error.
    }
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
    elementByToken: (token: string, expected?: { role?: string; label?: string; allowDisabled?: boolean }) => Promise<{ element: CuaWindowElement; frame: CuaStageWindowFrame; nativeElement?: NativeWindowStructureElement } | undefined>;
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
    const runtime = cursorSession && agentRuntimeReady ? agentRuntimeReady : undefined;
    const driver = runtime?.driver;
    const sdk = runtime?.sdk;
    const session = cursorSession?.session ?? (cursorDetails ? cursorDetails.session : safeSessionName(stage.name));
    const observationKey = stage.name + "\0" + (cursorDetails?.key ?? session) + "\0" + pid + "\0" + windowId + "\0" + (anchor.processGeneration ?? "");

    const readNativeElements = async () => {
      const timing = timingContext.getStore();
      const structure = await timed("accessibility-read", () => manager.windowStructure(pid, windowId.toString(), { maxElements: 4096, maxDepth: 64 }),
        { detail: `scope=window;point=${timing?.afterDispatch ? "post-dispatch" : "pre-dispatch"}` });
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
      observedElements.set(observationKey, new Map(elements.map(({ native, mapped }) => [native.ref, mapped])));
      nativeObservedElements.set(observationKey, new Map(structure.elements.map((element) => [element.ref, element])));
      while (observedElements.size > 64) observedElements.delete(observedElements.keys().next().value!);
      while (nativeObservedElements.size > 64) nativeObservedElements.delete(nativeObservedElements.keys().next().value!);
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
      const imageFrame = await captureNativeFrame();
      const bounds = imageFrame.windowBounds!;
      const image = { dataUrl: imageFrame.dataUrl, width: imageFrame.width, height: imageFrame.height };
      let controls: CuaStageTargetDescription[] = [];
      let controlsTruncated = false;
      let observed: Awaited<ReturnType<typeof readNativeElements>> | undefined;
      try {
        observed = await readNativeElements();
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
      } catch {
        // A window without a usable UIA provider still returns its native frame.
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
            ref: native.ref, depth: native.depth, role: native.role, label: normalizeAccessibleLabel(native.label) ?? "", enabled: native.enabled,
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
      const observed = nativeObservedElements.get(observationKey)?.get(token);
      if (!observed) return undefined;
      const normalizedLabel = normalizeAccessibleLabel(observed.label) ?? "";
      if ((expected?.role !== undefined && observed.role !== expected.role)
        || (expected?.label !== undefined && normalizedLabel !== expected.label)) return undefined;
      const { structure, elements } = await readNativeElements();
      const current = structure.elements.find((candidate) => JSON.stringify(candidate.path) === JSON.stringify(observed.path)
        && candidate.role === observed.role && candidate.label === observed.label
        && candidate.className === observed.className && candidate.automationId === observed.automationId);
      if (!current || (current.enabled === false && expected?.allowDisabled !== true)) return undefined;
      const fresh = elements.find(({ native }) => native === current);
      if (!fresh) return undefined;
      const frame = await captureNativeFrame();
      const rect = current.rect;
      const mappedFrame = { x: (rect.x - frame.windowBounds!.x) * frame.width / frame.windowBounds!.width,
        y: (rect.y - frame.windowBounds!.y) * frame.height / frame.windowBounds!.height,
        w: rect.width * frame.width / frame.windowBounds!.width,
        h: rect.height * frame.height / frame.windowBounds!.height };
      return { element: { ...fresh.mapped, elementToken: token, frame: mappedFrame } as CuaWindowElement,
        frame, nativeElement: current };
    };

    const elementAt = async (x: number, y: number) => (await hitTarget(x, y))?.elementToken;
    const observedElementByToken = (token: string, expected?: { role?: string; label?: string }) => {
      const observed = observedElements.get(observationKey)?.get(token);
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
      const image = await timed("window-capture", () => manager.captureWindow(pid, windowId.toString()),
        { detail: "scope=target-resolution" });
      const bounds = boundsAtWindowCapture(image);
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
      observedElementByToken, elementByToken, captureTarget }));
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
      const cursor = await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, captured, true);
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
      const cursor = await moveOwnerCursor(runtime, session, point, true);
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
      await moveOwnerCursor(runtime, session, point);
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
      if ((options.button === undefined || options.button === "left") && (options.count ?? 1) === 1) {
        // UIA's point hit-test is authoritative for a coordinate action. A
        // smallest-rectangle search can select an overlapping sibling (for
        // example, a popup suggestion over a page control), so only invoke the
        // exact live hit if it belongs to the HWND resolved from this point.
        let control: Awaited<ReturnType<typeof manager.pointControl>> | undefined;
        try { control = await timed("target-resolution", () => manager.pointControl(point.screenPoint.x, point.screenPoint.y),
          { detail: "source=uia-element-at-point" }); }
        catch { /* an inspection miss has dispatched no input; physical fallback remains available */ }
        if (control?.windowPid === point.target.pid && control.windowId === point.target.windowId.toString()) {
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
      const editable = point.element?.actions?.includes("set_value")
        && /^(?:Document|Edit|TextField|TextArea|ComboBox)$/i.test(point.element.role ?? "");
      rememberDesktopInputTarget(name, identity, editable ? { ...point.target, field: {
        ...point.screenPoint, label: point.element?.label, role: point.element?.role,
      } } : point.target);
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
        await moveOwnerCursor(runtime, session, point);
        await inspectOwnerDesktop(name, identity);
        forgetDesktopInputTarget(name, identity);
        return nativeReplaceTextAtScreenPoint(point.target.pid, point.target.windowId, point.screenPoint.x, point.screenPoint.y, text,
          { session: session.session, signal: options.signal, deliveryMode: options.deliveryMode, preferForeground: options.confirmFocusForeground });
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
          await moveOwnerCursor(runtime, session, {
            ...point,
            desktopPoint: { x: selected.field.x, y: selected.field.y },
            screenPoint: { x: selected.field.x, y: selected.field.y },
          });
          await inspectOwnerDesktop(name, identity);
        }
        return await deliverTextToExactWindow({ session: session.session, pid: selected.pid,
          windowId: selected.windowId, selected, text, delayMs, preferForeground: options.confirmFocusForeground,
          deliveryMode: options.deliveryMode,
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
      await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      const amount = Math.min(50, Math.max(1, Math.round(options.amount ?? 3)));
      const outcome = await driverInputAction("scroll", {
        pid: point.target.pid, window_id: Number(point.target.windowId), x: point.localPoint.x, y: point.localPoint.y,
        direction, by: "line", amount, session: session.session,
      }, "Cua Driver could not scroll the exact window under the agent cursor.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
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
      await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      return driverInputAction("scroll", {
        pid: point.target.pid, window_id: Number(point.target.windowId), x: point.localPoint.x, y: point.localPoint.y,
        direction: scroll.direction, by: scroll.by, amount: scroll.amount, session: session.session,
      }, "Cua Driver could not scroll the exact window under the agent cursor.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(point.target.pid, point.target.windowId, async () => {
            const screen = await desktopPointToCurrentScreen(point);
            await manager.sendScroll(point.target.pid, point.target.windowId.toString(), screen.x, screen.y,
              (scroll.direction === "up" || scroll.direction === "right") ? scroll.amount : -scroll.amount,
              (scroll.direction === "left" || scroll.direction === "right") ? "horizontal" : "vertical");
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
      await moveOwnerCursor(runtime, session, start);
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
      await moveOwnerCursor(runtime, session, end);
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
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow }) => {
      const before = await captureFrame();
      if (!validPoint(x, y, before)) throw new DesktopInputNotDispatchedError("Click coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, before);
      if (cursorIdentity) forgetDesktopInputTarget(name, cursorIdentity);
      // A coordinate click means the observed point, not the smallest
      // accessibility rectangle that overlaps it. Overlapping UIA siblings
      // (autocomplete popups, menus, embedded browser views) can make a tree
      // bounding-box heuristic activate a different control than the agent
      // selected. First let UIA hit-test and activate the exact live control at
      // that screen point (a headless action); if it has no semantic action,
      // the owner-visible route falls through to native pointer input.
      if ((options.button === undefined || options.button === "left") && (options.count ?? 1) === 1) {
        const screen = await localToScreenPoint(pid, windowId, x, y, before.width, before.height, before.windowBounds);
        let control: NativePointControl | undefined;
        try { control = await timed("target-resolution", () => manager.pointControl(screen.x, screen.y),
          { detail: "source=uia-element-at-point" }); }
        catch { /* an inspection miss sends nothing; the owner-visible fallback remains available */ }
        if (control?.pid === pid && control.windowPid === pid && control.windowId === windowId.toString()) {
          try {
            const invoked = await timedInputDispatch("uia-point", () => manager.pointControl(screen.x, screen.y, control),
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
      const outcome = await driverInputAction("click", {
        pid,
        window_id: Number(windowId),
        x, y,
        ...(options.button ? { button: options.button === "right" ? "right" : options.button === "middle" ? "middle" : "left" } : {}),
        ...(options.count ? { count: options.count } : {}),
        session,
      }, "Cua Driver could not click the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            const screen = await localToScreenPoint(pid, windowId, x, y, before.width, before.height, before.windowBounds);
            await manager.sendClick(pid, windowId.toString(), screen.x, screen.y, {
              ...(options.button ? { button: options.button } : {}),
              ...(options.count ? { count: options.count } : {}),
            });
          }),
      });
      // A coordinate click has no stable semantic field identity. Do not infer
      // one from an overlapping UIA rectangle: keyboard delivery follows the
      // OS focus established by the click, and ref-based field actions retain
      // their exact identity through clickElement/replaceElement.
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
        await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, before);
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
        await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, before);
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
    return run({ driver: agentRuntimeReady?.driver, session, pid, parentWindowId: windowId, popupWindowId, capture });
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
      const outcome = await driverInputAction("click", {
        pid, window_id: Number(popupWindowId), x, y,
        ...(options.button ? { button: options.button === "right" ? "right" : options.button === "middle" ? "middle" : "left" } : {}),
        ...(options.count ? { count: options.count } : {}),
        session,
      }, "Cua Driver could not click the owned popup window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, popupWindowId, async () => {
            const screen = await localToScreenPoint(pid, popupWindowId, x, y, before.width, before.height);
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
            { session, signal: options.signal, deliveryMode: options.deliveryMode, preferForeground: options.confirmFocusForeground });
        }
      } else {
        outcome = await deliverTextToExactWindow({ session, pid, windowId: popupWindowId, text, delayMs,
          preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode,
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

  async function typeText(name: string, text: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageTextOptions = {}): Promise<CuaStageActionProof> {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new DesktopInputNotDispatchedError(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    const delayMs = normalizeTypeDelayMs(options.delayMs);
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow, elementAtPoint, elementByToken }) => {
      const before = await captureFrame();
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
        if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, options.x, options.y, before);
        const selected = await elementByToken(element.elementToken, { role: element.role, label: element.label });
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
          { session, signal: options.signal, deliveryMode: options.deliveryMode, preferForeground: options.confirmFocusForeground });
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
      const outcome = await deliverTextToExactWindow({ session, pid, windowId,
        text, selected,
        delayMs, preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode,
        nativeForeground: nativeStageInput(pid, windowId, () => manager.sendText(pid, windowId.toString(), text)),
        signal: options.signal });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function scroll(name: string, xInput: number | undefined, yInput: number | undefined, direction: "up" | "down", cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageScrollOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow }) => {
      const before = await captureFrame();
      // A scroll targets one already-exact window; unlike a click or a drag,
      // there is nothing ambiguous about defaulting to its center when no
      // point was given -- scrolling the window itself is what was meant.
      const x = xInput ?? Math.floor(before.width / 2);
      const y = yInput ?? Math.floor(before.height / 2);
      const amount = Math.min(50, Math.max(1, Math.round(options.amount ?? 3)));
      if (!validPoint(x, y, before)) throw new DesktopInputNotDispatchedError("Scroll coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, before);
      const outcome = await driverInputAction("scroll", {
        pid, window_id: Number(windowId), x, y,
        direction, by: "line", amount, session,
      }, "Cua Driver could not scroll the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            const screen = await localToScreenPoint(pid, windowId, x, y, before.width, before.height, before.windowBounds);
            await manager.sendScroll(pid, windowId.toString(), screen.x, screen.y, direction === "up" ? amount : -amount, "vertical");
          }),
      });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function drag(name: string, fromX: number, fromY: number, toX: number, toY: number, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageDragOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow }) => {
      const before = await captureFrame();
      if (!validPoint(fromX, fromY, before) || !validPoint(toX, toY, before)) {
        throw new DesktopInputNotDispatchedError("Both drag points must fall inside the current stage window snapshot.");
      }
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, fromX, fromY, before);
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
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, toX, toY, before);
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  function elementCursorPoint(element: CuaWindowElement, frame: CuaStageWindowFrame): { x: number; y: number } | undefined {
    const rect = element.frame;
    // `elementByToken` re-resolves native UIA refs and maps their absolute
    // screen rectangle into this exact window screenshot's local pixel space.
    // Subtracting the window origin here a second time made refs on any window
    // whose top/left was nonzero resolve outside the screenshot and fail before
    // dispatch. Keep this conversion local to the ref path; coordinate actions
    // still convert local screenshot pixels to screen space at the sender.
    if (!rect || frame.width <= 0 || frame.height <= 0) return undefined;
    const x = Math.floor(rect.x + rect.w / 2);
    const y = Math.floor(rect.y + rect.h / 2);
    return validPoint(x, y, frame) ? { x, y } : undefined;
  }

  async function clickElement(name: string, ref: string, cursorIdentity?: CuaAgentCursorIdentity, options: CuaStageInputOptions = {}): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, captureFrame, capture: captureWindow, elementByToken }) => {
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
      const point = elementCursorPoint(selected.element, selected.frame);
      const selectedElementToken = selected.element.elementToken;
      if (!selectedElementToken) throw new DesktopInputNotDispatchedError("The accessibility element is missing its driver token; no click was sent.");
      if (!point) throw new DesktopInputNotDispatchedError("The accessibility element has no usable screen point; no click was sent.", "target-identity");
      if (cursorIdentity && point) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, selected.frame);
      if (cursorIdentity) forgetDesktopInputTarget(name, cursorIdentity);
      if (selected.nativeElement && typeof manager.invokeWindowElement === "function"
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
            capture: stageCapture(await captureWindow(), now),
            outcome: { status: "unverified", summary: `Native UI Automation dispatched ${semantic.mechanism ?? "the control action"}; the refreshed window capture is the separate effect check.` },
          };
        }
      }
      const outcome = await driverInputAction("click", {
        pid, window_id: Number(windowId), x: point.x, y: point.y, button: "left", count: 1, session,
      }, "Cua Driver could not click the selected accessibility element.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            const screen = await localToScreenPoint(pid, windowId, point.x, point.y, selected.frame.width, selected.frame.height, selected.frame.windowBounds);
            await manager.sendClick(pid, windowId.toString(), screen.x, screen.y, {});
          }),
      });
      if (cursorIdentity && point && outcome.status === "confirmed" && selected.element.actions?.includes("set_value")
        && /^(?:Document|Edit|TextField|TextArea|ComboBox)$/i.test(selected.element.role ?? "")) {
        rememberDesktopInputTarget(name, cursorIdentity, { pid, windowId,
          field: { ...cursorScreenPoint(point.x, point.y, selected.frame), label: selected.element.label, role: selected.element.role } });
      }
      return { capture: stageCapture(await captureWindow(), now), outcome };
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
      const point = elementCursorPoint(selected.element, selected.frame);
      if (!point) throw new DesktopInputNotDispatchedError("The observed scroll container has no usable point for the one-notch wheel fallback; no scroll was sent.", "target-identity");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, selected.frame);
      const before = await captureFrame();
      const screen = await localToScreenPoint(pid, windowId, point.x, point.y, before.width, before.height, before.windowBounds);
      const horizontal = direction === "left" || direction === "right";
      const signedAmount = direction === "up" || direction === "right" ? 1 : -1;
      const outcome = await driverInputAction("scroll", {
        pid, window_id: Number(windowId), x: point.x, y: point.y, direction: signedAmount > 0 ? "up" : "down",
        by: "line", amount: 1, session,
      }, "Cua Driver could not scroll the observed container by one wheel notch.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
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
      if (!selected?.element.elementToken || selected.element.enabled === false
        || (!selected.nativeElement && !selected.element.actions?.includes("set_value"))) {
        throw new DesktopInputNotDispatchedError("The accessibility element is stale, disabled, could not be confirmed as the same control, or does not support text replacement; no text was sent.");
      }
      const point = elementCursorPoint(selected.element, selected.frame);
      if (!point) throw new DesktopInputNotDispatchedError("The selected accessibility field has no usable point; no text was sent.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, point.x, point.y, selected.frame);
      if (selected.nativeElement && typeof manager.invokeWindowElement === "function") {
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
          return {
            capture: stageCapture(await captureWindow(), now),
            outcome: { status: "unverified", summary: "Native UI Automation set the exact observed value; the refreshed window capture is the separate effect check." },
          };
        }
      }
      const before = await captureFrame();
      const screen = await localToScreenPoint(pid, windowId, point.x, point.y, before.width, before.height, before.windowBounds);
      const outcome = await nativeReplaceTextAtScreenPoint(pid, windowId, screen.x, screen.y, text,
        { session, signal: options.signal, deliveryMode: options.deliveryMode, preferForeground: options.confirmFocusForeground });
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
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, before);
      const outcome = await driverInputAction("scroll", {
        pid, window_id: Number(windowId), x, y, direction: scroll.direction, by: scroll.by, amount: scroll.amount, session,
      }, "Cua Driver could not scroll the registered stage window.", {
        preferForeground: options.confirmFocusForeground, deliveryMode: options.deliveryMode, signal: options.signal,
        nativeForeground: nativeStageInput(pid, windowId, async () => {
            const screen = await localToScreenPoint(pid, windowId, x, y, before.width, before.height);
            await manager.sendScroll(pid, windowId.toString(), screen.x, screen.y,
              (scroll.direction === "up" || scroll.direction === "right") ? scroll.amount : -scroll.amount,
              (scroll.direction === "left" || scroll.direction === "right") ? "horizontal" : "vertical");
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
    // The input target registry is owned by the logical agent identity, not by
    // the optional cursor process. A target may have been remembered while the
    // cursor overlay was absent; revoking/closing that agent must clear the
    // target even when there is no overlay session to dispose.
    if (!agentRuntimePromise || !agentSessions.has(details.key)) {
      forgetAgentDesktopInputTargets(cursorIdentity);
      return;
    }
    details.session = agentSessions.get(details.key)!.session;
    const runtime = await agentRuntimePromise;
    try {
      resultError(await runtime.driver.setAgentCursorEnabled({ session: details.session, enabled: false }), "Cua Driver could not hide the revoked agent cursor.");
    } finally {
      try { await runtime.driver.endSession({ session: details.session }); }
      finally {
        agentSessions.delete(details.key);
        sessionRefreshedAt.delete(details.key);
        cursorSessionNames.delete(details.key);
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
    cursorSessionNames.clear();
    sessionRefreshedAt.clear();
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

  return { capture, readStructure, readElementValue, readDesktopStructure, describeTarget, describeElementTarget, showAgentCursor, moveCursor, listWindows, listVisibleWindows, click, typeText, scroll, scrollDelta, scrollElement, drag,
    clickElement, replaceElement, windowFrame, snapWindow, windowState, focusWindow, systemControl, invokeMenu, clipboardRead, clipboardWrite,
    captureDesktop, describeDesktopTarget, moveDesktopCursor, clickDesktop, typeTextDesktop, scrollDesktop, scrollDeltaDesktop, dragDesktop,
    pressKey, hotkey, pressKeyDesktop, hotkeyDesktop, closeAgentCursor, shutdown,
    clickPopup, pressKeyPopup, hotkeyPopup, typeTextPopup, capturePopup, saveAs };
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
