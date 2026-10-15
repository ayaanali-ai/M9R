import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { defaultStoreRoot } from "./local-store";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionResult, ActionTarget, ClickPosition as CuaClickPosition, CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import { startCuaDriverHost, type CuaDriverHostConnection } from "./cua-driver-host";
import { createWindowsDesktopStageManager, type WindowsStageDependencies, type NativePointControl } from "./windows-desktop-stage";
import type { VerifiedIdentity } from "./identity-core";

const CUA_PACKAGE = "@trycua/cua-driver";
const CUA_DRIVER_VERSION = "0.34.0";
const CURSOR_SESSION_LABEL_MAX_LENGTH = 28;
const MAX_IMAGE_DIMENSION = 1024;
// Keep the base64 JSON response comfortably below the native pill's 4 MiB stdout cap.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_ACTION_LENGTH = 500;
const MAX_WINDOW_OPTIONS = 40;
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
  CursorMotionStyle: typeof import("@trycua/cua-driver").CursorMotionStyle;
  CursorMotionTiming: typeof import("@trycua/cua-driver").CursorMotionTiming;
};

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
}

export interface CuaStageActionProof {
  capture: CuaStageCapture;
  outcome: CuaStageActionOutcome;
}

export interface CuaStageCapture {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
  /** Cua's opaque ID for this exact desktop screenshot; used to bind visual coordinates. */
  captureId?: string;
  /** Bounded accessible targets from this same window snapshot, in screenshot pixels. */
  controls?: CuaStageTargetDescription[];
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

export type CuaDesktopClickOptions = { button?: "left" | "right"; count?: 1 | 2 };

export interface CuaStageDriverDependencies {
  stage?: WindowsStageDependencies;
  loadSdk?: () => Promise<CuaSdk>;
  connectRuntime?: CuaStageRuntimeConnector;
  now?: () => Date;
  windowAtPoint?: (x: number, y: number) => Promise<{ pid: number; windowId: bigint; shell?: boolean; keyboardWindow?: boolean; screenOrigin?: { x: number; y: number } }>;
  pointControl?: (x: number, y: number, expected?: NativePointControl) => Promise<NativePointControl>;
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

function elementAtScreenPoint(elements: readonly CuaWindowElement[], x: number, y: number) {
  return elements.filter((element) => {
    const frame = element.frame;
    return element.enabled !== false && element.elementToken && frame && frame.w > 0 && frame.h > 0
      && x >= frame.x && y >= frame.y && x < frame.x + frame.w && y < frame.y + frame.h;
  }).sort((a, b) => a.frame!.w * a.frame!.h - b.frame!.w * b.frame!.h)[0];
}

async function typeIntoExactField(driver: CuaDriverLike, selected: DesktopInputTarget, session: string, text: string) {
  if (!selected.field || !Number.isSafeInteger(Number(selected.windowId))) throw new Error("The selected text field has no representable exact window identity.");
  const state = await driver.getWindowState({ pid: selected.pid, windowId: selected.windowId, session,
    includeAccessibilityTree: true, includeScreenshot: false, maxElements: 512, maxDepth: 12, timeoutMs: 1_500 });
  if (state.pid !== selected.pid || state.windowId !== selected.windowId) throw new Error("The selected text field returned a different application window.");
  const element = elementAtScreenPoint(state.elements ?? [], selected.field.x, selected.field.y);
  if (!element?.elementToken || element.label !== selected.field.label || element.role !== selected.field.role
    || !element.actions?.includes("set_value")) throw new Error("The selected text field changed; no text was sent.");
  return actionOutcome(await driver.callTool("set_value", JSON.stringify({
    pid: selected.pid, window_id: Number(selected.windowId), element_token: element.elementToken,
    value: text, session,
  })), "Cua Driver could not type into the exact accessibility field.");
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
  try {
    return await import(CUA_PACKAGE) as CuaSdk;
  } catch (packageError) {
    const url = bundledSdkUrl();
    if (url) {
      try { return await import(url) as CuaSdk; } catch { /* report the actionable package error below */ }
    }
    const reason = packageError instanceof Error ? packageError.message : "module could not be loaded";
    throw new Error(`Cua Driver ${CUA_DRIVER_VERSION} is unavailable in this M9R runtime (${reason}). Reinstall the M9R Windows runtime with its Cua Driver files.`);
  }
}

function safeSessionName(stageName: string): string {
  return `${SESSION_PREFIX}${stageName}`.slice(0, 64);
}

function agentCursorDetails(identity: CuaAgentCursorIdentity): AgentCursorSession {
  const handle = identity.handle.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(handle) || typeof identity.sessionId !== "string"
    || identity.sessionId.length < 1 || identity.sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(identity.sessionId)) {
    throw new Error("The verified agent identity cannot be used for a Cua cursor session.");
  }
  const digest = createHash("sha256").update(`${handle}\0${identity.sessionId}`).digest("hex");
  const sessionTag = digest.slice(0, 8);
  const visibleHandle = handle.slice(0, CURSOR_SESSION_LABEL_MAX_LENGTH - sessionTag.length - 2);
  return {
    key: `${handle}\0${identity.sessionId}`,
    handle,
    sessionId: identity.sessionId,
    // Cua shows the session name in the native desktop cursor badge and
    // shortens labels longer than 28 characters. Keep the agent recognizable
    // while retaining a session-specific suffix inside that display limit.
    session: `@${visibleHandle}-${sessionTag}`,
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

function stageCapture(capture: { dataUrl: string; width: number; height: number; controls?: CuaStageTargetDescription[] }, now: () => Date): CuaStageCapture {
  return { dataUrl: capture.dataUrl, width: capture.width, height: capture.height,
    ...(capture.controls ? { controls: capture.controls } : {}),
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
  const agentSessions = new Map<string, AgentCursorSession>();
  const desktopCaptures = new Map<string, CachedDesktopCapture>();
  const desktopInputTargets = new Map<string, DesktopInputTarget>();
  let agentRuntimePromise: Promise<CuaRuntime> | undefined;

  async function createRuntime(): Promise<CuaRuntime> {
    const sdk = await loadSdk();
    const connection = deps.connectRuntime
      ? await deps.connectRuntime(sdk)
      : await startCuaDriverHost(sdk, { workingDirectory: process.cwd() });
    return { sdk, driver: connection.driver, processId: connection.processId, close: connection.close };
  }

  async function disposeRuntime(runtime: CuaRuntime): Promise<void> {
    if (runtime.close) await runtime.close();
    else try { await runtime.driver.shutdown(); } catch { /* preserve the primary stage result */ }
  }

  async function agentRuntime(): Promise<CuaRuntime> {
    if (!agentRuntimePromise) {
      const runtimePromise = createRuntime();
      agentRuntimePromise = runtimePromise;
      void runtimePromise.catch(() => {
        if (agentRuntimePromise === runtimePromise) agentRuntimePromise = undefined;
      });
    }
    return agentRuntimePromise;
  }

  async function ensureAgentSession(identity: CuaAgentCursorIdentity): Promise<{ runtime: CuaRuntime; session: AgentCursorSession }> {
    const details = agentCursorDetails(identity);
    const runtime = await agentRuntime();
    const alreadyTracked = agentSessions.has(details.key);
    if (!alreadyTracked && agentSessions.size >= 16) {
      throw new Error("This machine already has 16 active M9R agent cursor identities; close or revoke one before adding another.");
    }
    let started = false;
    try {
      // Cua reclaims named sessions after five minutes idle. startSession is
      // idempotent and refreshes that TTL, so do this for every authorized
      // action rather than trusting the broker's in-memory session map.
      await runtime.driver.startSession({
        session: details.session,
        cursorTheme: {
          themeId: "cua.default",
          reducedMotion: runtime.sdk.CursorReducedMotion.Auto as import("@trycua/cua-driver").CursorReducedMotion,
        },
      });
      started = true;
      // Configure adaptive motion before showing the cursor and reapply it in
      // case Cua reclaimed this named session while M9R was idle.
      resultError(await runtime.driver.setAgentCursorMotion({
        session: details.session,
        style: runtime.sdk.CursorMotionStyle.Adaptive,
        timing: runtime.sdk.CursorMotionTiming.Fitts,
        effects: { trail: true, glow: true },
        dwellAfterClickMs: 100,
        idleHideMs: 60_000,
      }), "Cua Driver could not configure the agent cursor motion.");
      agentSessions.set(details.key, details);
    } catch (error) {
      if (started && !alreadyTracked) {
        try { await runtime.driver.endSession({ session: details.session }); } catch { /* preserve the session setup error */ }
      }
      throw error;
    }
    return { runtime, session: agentSessions.get(details.key)! };
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
    const { runtime, session } = await ensureAgentSession(identity);
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
    const { runtime, session } = await ensureAgentSession(identity);
    await inspectOwnerDesktop(name, identity);
    const capture = currentDesktopCapture(name, identity);
    if (capture.stageName !== name || capture.identityKey !== session.key) throw new Error("The captured desktop does not belong to this agent's current stage session.");
    return run({ runtime, session, capture });
  }

  function desktopInputKey(name: string, identity: CuaAgentCursorIdentity): string {
    return `${name}\0${agentCursorDetails(identity).key}`;
  }

  function isBackgroundDeliveryUnavailable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /background delivery is not available for target window class/i.test(message);
  }

  async function deliverTextToExactWindow(input: {
    runtime: CuaRuntime;
    session: string;
    pid: number;
    windowId: string | bigint;
    text: string;
    selected?: DesktopInputTarget;
    nativeInput?: () => Promise<boolean>;
  }): Promise<CuaStageActionOutcome> {
    const windowId = input.windowId.toString();
    if (input.selected?.field) {
      return typeIntoExactField(input.runtime.driver, input.selected, input.session, input.text);
    }

    if (input.nativeInput && await input.nativeInput()) {
      return { status: "unverifiable", summary: "Posted text to the selected native edit control; application effect requires verification." };
    }

    try {
      return actionOutcome(await input.runtime.driver.typeText({
        text: input.text,
        target: new input.runtime.sdk.ActionTarget.Window({ pid: input.pid, windowId: parseWindowId(windowId) }),
        session: input.session,
      }), "Cua Driver could not type into the selected background window.");
    } catch (error) {
      if (isBackgroundDeliveryUnavailable(error)) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason} No text was sent and the stage will not activate the window as a fallback. This target needs an accessibility value adapter or an app-specific background input route.`);
      }
      throw error;
    }
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
      ...(includeAccessibilityTree ? { maxElements: 512, maxDepth: 12 } : {}) });
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
    if (!target) throw new Error("No agent input window is selected yet. Click the target on the captured desktop first; no keyboard input was sent.");
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
    if (!state.enabled || state.x === undefined || state.y === undefined
      || Math.abs(state.x - point.screenPoint.x) > 1 || Math.abs(state.y - point.screenPoint.y) > 1) {
      throw new Error(`Cua Driver did not confirm the requested desktop cursor position (expected ${point.screenPoint.x},${point.screenPoint.y}; actual ${state.x ?? "missing"},${state.y ?? "missing"}; enabled ${state.enabled}).`);
    }
    if ((await runtime.driver.getSession({ session: session.session })).cursorVisible !== true) {
      throw new Error("Cua Driver moved the cursor but did not confirm its overlay is visible on the owner's desktop.");
    }
    return { x: point.desktopPoint.x, y: point.desktopPoint.y, screenX: state.x, screenY: state.y, enabled: true, visible: true };
  }

  async function moveAndVerifyCursor(input: { driver: CuaDriverLike; sdk: CuaSdk; session: string; pid: number; windowId: bigint }, x: number, y: number, frame: CuaStageWindowFrame) {
    const point = cursorScreenPoint(x, y, frame);
    resultError(await input.driver.setAgentCursorEnabled({ session: input.session, enabled: true }), "Cua Driver could not enable the agent cursor.");
    resultError(await input.driver.moveCursor({ x, y, target: new input.sdk.ActionTarget.Window({ pid: input.pid, windowId: input.windowId }), session: input.session }), "Cua Driver could not move the agent cursor.");
    const state = cursorStateFromResult(await input.driver.getAgentCursorState({ session: input.session }));
    if (!state.enabled || state.x === undefined || state.y === undefined || Math.abs(state.x - point.x) > 1 || Math.abs(state.y - point.y) > 1) {
      throw new Error("Cua Driver did not confirm the requested agent cursor position on this stage window.");
    }
    const sessionState = await input.driver.getSession({ session: input.session });
    if (sessionState.cursorVisible !== true) throw new Error("Cua Driver moved the agent cursor but did not confirm that its desktop overlay is visible.");
    return { x, y, screenX: state.x, screenY: state.y, enabled: true as const, visible: true as const };
  }
  async function nativeControl(name: string, kind: "click" | "type" | "scroll", point?: { x: number; y: number; imageWidth: number; imageHeight: number }, extra?: { text?: string; direction?: "up" | "down" }) {
    const { stage, anchor } = await manager.inspectStage(name);
    if (!anchor) throw new Error("Stage has no registered app window.");
    const selectionPath = join(root, `stage-input-${stage.roomDesktopId}.json`);
    if (!point) {
      if (!existsSync(selectionPath)) return false;
      const saved = JSON.parse(readFileSync(selectionPath, "utf8")) as { windowId: string; pid: number; x: number; y: number; imageWidth: number; imageHeight: number };
      if (saved.pid !== anchor.pid || saved.windowId !== anchor.windowId || !Number.isSafeInteger(saved.x) || !Number.isSafeInteger(saved.y)) return false;
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

  async function withRegisteredWindow<T>(nameInput: string, run: (input: {
    driver: CuaDriverLike;
    sdk: CuaSdk;
    session: string;
    pid: number;
    windowId: bigint;
    capture: () => Promise<CuaStageWindowFrame>;
    elementAt: (x: number, y: number) => Promise<string | undefined>;
    elementAtPoint: (x: number, y: number) => Promise<CuaWindowElement | undefined>;
    captureTarget: (x: number, y: number) => Promise<CuaStageTargetDescription | undefined>;
  }) => Promise<T>, cursorIdentity?: CuaAgentCursorIdentity): Promise<T> {
    const { stage, anchor } = await manager.inspectStage(nameInput);
    if (!anchor) throw new Error(`Stage “${stage.name}” has no registered app window. Register an owned window before capturing or moving the Cua cursor.`);
    const pid = anchor.pid;
    const windowId = parseWindowId(anchor.windowId);
    const persistent = cursorIdentity ? await ensureAgentSession(cursorIdentity) : undefined;
    const runtime = persistent?.runtime ?? await createRuntime();
    const sdk = runtime.sdk;
    const driver = runtime.driver;
    const session = persistent?.session.session ?? safeSessionName(stage.name);
    let started = false;
    try {
      if (!persistent) {
        await driver.startSession({ session });
        started = true;
      }
      const capture = async () => {
        const request = {
          pid,
          windowId,
          session,
          includeAccessibilityTree: true,
          includeScreenshot: true,
          maxImageDimension: MAX_IMAGE_DIMENSION,
          maxElements: 200,
          maxDepth: 12,
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
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          for (const element of state.elements ?? []) {
            const frame = element.frame;
            if (element.enabled === false || !frame || frame.w <= 0 || frame.h <= 0) continue;
            const left = Math.max(0, (frame.x - bounds.x) * image.width / bounds.width);
            const top = Math.max(0, (frame.y - bounds.y) * image.height / bounds.height);
            const right = Math.min(image.width, (frame.x + frame.w - bounds.x) * image.width / bounds.width);
            const bottom = Math.min(image.height, (frame.y + frame.h - bounds.y) * image.height / bounds.height);
            if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
            controls.push({
              ...(element.label ? { label: element.label.replace(/[\r\n\t]+/g, " ").slice(0, 160) } : {}),
              ...(element.role ? { role: element.role.slice(0, 40) } : {}),
              rect: { x: left, y: top, width: right - left, height: bottom - top },
            });
            if (controls.length === 200) break;
          }
        }
        return {
          dataUrl: image.dataUrl,
          width: image.width,
          height: image.height,
          controls,
          ...(bounds ? { windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}),
        };
      };
      const hitTarget = async (x: number, y: number) => {
        const state = await driver.getWindowState({ pid, windowId, session, includeAccessibilityTree: true,
          includeScreenshot: true, maxImageDimension: MAX_IMAGE_DIMENSION, timeoutMs: 1500 });
        imageFromWindowState(state, pid, windowId);
        const bounds = state.windowBounds;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
        // Windows accessibility frames are screen coordinates, while the pill
        // passes scaled screenshot pixels. Convert before hit-testing.
        const screenX = bounds.x + x * bounds.width / state.screenshotWidth!;
        const screenY = bounds.y + y * bounds.height / state.screenshotHeight!;
        const hits = (state.elements ?? []).filter((element) => {
          const frame = element.frame;
          return element.enabled !== false && element.elementToken && frame && frame.w > 0 && frame.h > 0
            && screenX >= frame.x && screenY >= frame.y && screenX < frame.x + frame.w && screenY < frame.y + frame.h;
        }).sort((a, b) => a.frame!.w * a.frame!.h - b.frame!.w * b.frame!.h);
        return hits[0];
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
      return await run({ driver, sdk, session, pid, windowId, capture, captureTarget: describeAt, elementAt, elementAtPoint: hitTarget });
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

  async function captureDesktop(name: string, cursorIdentity: CuaAgentCursorIdentity): Promise<CuaStageCapture> {
    return captureOwnerDesktop(name, cursorIdentity, true);
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
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture, undefined, true);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      if (point.shellControl) {
        if (options.button === "right" || (options.count ?? 1) !== 1) throw new Error("This shell control supports accessibility activation, not a synthetic double or right click.");
        const activated = await (deps.pointControl ?? manager.pointControl)(point.screenPoint.x, point.screenPoint.y, point.shellControl);
        if (activated.confirmed === true && point.nativeKeyboardWindow === true) rememberDesktopInputTarget(name, identity, point.target);
        // Invocation is acknowledged, but the changed desktop capture proves
        // whether the app opened. Never bind keyboard input to the taskbar.
        return { status: "unverified" as const, summary: "Windows acknowledged exact shell control invocation; verify the returned capture." };
      }
      const target = new runtime.sdk.ActionTarget.Window(point.target);
      const semanticClick = options.button !== "right" && (options.count ?? 1) === 1
        && point.element?.elementToken && runtime.sdk.ClickPosition.Element;
      const position = semanticClick
        ? new runtime.sdk.ClickPosition.Element!({ elementToken: point.element!.elementToken! })
        : new runtime.sdk.ClickPosition.Coordinates(point.localPoint);
      const button = options.button === "right" ? runtime.sdk.ClickButton.Right : runtime.sdk.ClickButton.Left;
      const outcome = actionOutcome(await runtime.driver.click({ target, position, session: session.session,
        deliveryMode: runtime.sdk.InputDeliveryMode.Background, button, count: options.count ?? 1 }),
      "Cua Driver could not deliver background input to the exact window under the agent cursor.");
      // Only a driver-confirmed click can establish where later keyboard input
      // should go. Returning an unverified click is truthful; remembering its
      // HWND would let a follow-up type/hotkey act on an unconfirmed focus.
      if (point.element?.actions?.includes("set_value") && /^(?:Document|Edit|TextField|TextArea)$/i.test(point.element.role ?? "")) {
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

  async function typeTextDesktop(name: string, text: string, identity: CuaAgentCursorIdentity) {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        return await deliverTextToExactWindow({ runtime, session: session.session, pid: selected.pid,
          windowId: selected.windowId, selected, text });
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function scrollDesktop(name: string, x: number, y: number, direction: "up" | "down", identity: CuaAgentCursorIdentity) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session, capture }) => {
      if (!validPoint(x, y, capture)) throw new Error("Scroll coordinates must fall inside the latest desktop screenshot.");
      forgetDesktopInputTarget(name, identity);
      const screen = screenSizeFromResult(await runtime.driver.getScreenSize({ session: session.session }));
      const point = await resolveOwnerDesktopPoint(runtime, session, x, y, capture, screen);
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, point);
      await inspectOwnerDesktop(name, identity);
      const target = new runtime.sdk.ActionTarget.Window(point.target);
      const outcome = actionOutcome(await runtime.driver.scroll({ ...point.localPoint,
        direction: direction === "up" ? runtime.sdk.ScrollDirection.Up : runtime.sdk.ScrollDirection.Down,
        target, session: session.session, by: runtime.sdk.ScrollBy.Line, amount: BigInt(3) }),
      "Cua Driver could not scroll the exact window under the agent cursor.");
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function dragDesktop(name: string, fromX: number, fromY: number, toX: number, toY: number, identity: CuaAgentCursorIdentity) {
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
      const target = new runtime.sdk.ActionTarget.Window(start.target);
      const outcome = actionOutcome(await runtime.driver.drag({ fromX: start.localPoint.x, fromY: start.localPoint.y,
        toX: end.localPoint.x, toY: end.localPoint.y, target, session: session.session,
        durationMs: BigInt(500), steps: BigInt(10) }), "Cua Driver could not drag on the owner's current desktop.");
      await inspectOwnerDesktop(name, identity);
      await moveOwnerCursor(runtime, session, end);
      return outcome;
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function pressKeyDesktop(name: string, key: string, identity: CuaAgentCursorIdentity) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        return actionOutcome(await runtime.driver.pressKey({ key, target: new runtime.sdk.ActionTarget.Window(selected), session: session.session }),
          "Cua Driver could not press the requested key in the selected background window. No foreground retry was attempted.");
      } catch (error) {
        forgetDesktopInputTarget(name, identity);
        throw error;
      }
    });
    invalidateDesktopCaptures();
    return { capture: await captureOwnerDesktop(name, identity, true), outcome };
  }

  async function hotkeyDesktop(name: string, keys: string[], identity: CuaAgentCursorIdentity) {
    const outcome = await withOwnerDesktop(name, identity, async ({ runtime, session }) => {
      await inspectOwnerDesktop(name, identity);
      const selected = await verifiedDesktopInputTarget(runtime, name, identity);
      try {
        return actionOutcome(await runtime.driver.hotkey({ keys, target: new runtime.sdk.ActionTarget.Window(selected), session: session.session }),
          "Cua Driver could not send the key combination to the selected background window. No foreground retry was attempted.");
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
    const runtime = await agentRuntime();
    const { driver } = runtime;
    const session = safeSessionName(ownedPid === undefined ? "owner-visible" : `owned-${ownedPid}`);
    let started = false;
    try {
      await driver.startSession({ session });
      started = true;
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
    } finally {
      if (started) {
        try { await driver.endSession({ session }); } catch { /* preserve the primary operation result */ }
      }
      // Window enumeration shares the broker's host. Closing it on every
      // launch poll repeatedly cold-started Cua and exceeded the RPC deadline.
    }
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
      if (options.button === undefined && options.count === undefined
        && await nativeControl(name, "click", { x, y, imageWidth: before.width, imageHeight: before.height })) return { capture: stageCapture(await captureWindow(), now),
        outcome: { status: "unverifiable", summary: "Routed the click to the exact native child control; application effect requires verification." } };
      const target = new sdk.ActionTarget.Window({ pid, windowId });
      const element = sdk.ClickPosition.Element ? await elementAtPoint(x, y) : undefined;
      const token = element?.elementToken;
      const result = await driver.click({
        target,
        position: token && sdk.ClickPosition.Element ? new sdk.ClickPosition.Element({ elementToken: token }) : new sdk.ClickPosition.Coordinates({ x, y }),
        deliveryMode: sdk.InputDeliveryMode.Background,
        ...(options.button ? { button: options.button === "right" ? sdk.ClickButton.Right : sdk.ClickButton.Left } : {}),
        ...(options.count ? { count: options.count } : {}),
        session,
      });
      const outcome = actionOutcome(result, "Cua Driver could not click the registered stage window.");
      if (cursorIdentity) {
        forgetDesktopInputTarget(name, cursorIdentity);
        if (element?.actions?.includes("set_value") && /^(?:Document|Edit|TextField|TextArea)$/i.test(element.role ?? "")) {
          const point = cursorScreenPoint(x, y, before);
          rememberDesktopInputTarget(name, cursorIdentity, { pid, windowId, field: { ...point, label: element.label, role: element.role } });
        }
      }
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function pressKey(name: string, key: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      await captureWindow();
      const result = await driver.pressKey({ key, target: new sdk.ActionTarget.Window({ pid, windowId }), session });
      const outcome = actionOutcome(result, "Cua Driver could not press the requested key in the registered stage window.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function hotkey(name: string, keys: string[], cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      await captureWindow();
      const result = await driver.hotkey({ keys, target: new sdk.ActionTarget.Window({ pid, windowId }), session });
      const outcome = actionOutcome(result, "Cua Driver could not send the requested key combination to the registered stage window.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function typeText(name: string, text: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      await captureWindow();
      const selected = cursorIdentity ? desktopInputTargets.get(desktopInputKey(name, cursorIdentity)) : undefined;
      if (selected?.field) {
        if (selected.pid !== pid || selected.windowId !== windowId) throw new Error("The selected text field belongs to another application window.");
      }
      const outcome = await deliverTextToExactWindow({ runtime: { sdk, driver }, session, pid, windowId,
        text, selected, nativeInput: () => nativeControl(name, "type", undefined, { text }) });
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function scroll(name: string, x: number, y: number, direction: "up" | "down", cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      if (!validPoint(x, y, before)) throw new Error("Scroll coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y, before);
      if (await nativeControl(name, "scroll", { x, y, imageWidth: before.width, imageHeight: before.height }, { direction })) return { capture: stageCapture(await captureWindow(), now),
        outcome: { status: "unverifiable", summary: "Posted wheel input to the exact native child control; application effect requires verification." } };
      const target = new sdk.ActionTarget.Window({ pid, windowId });
      const result = await driver.scroll({
        x,
        y,
        direction: direction === "up" ? sdk.ScrollDirection.Up : sdk.ScrollDirection.Down,
        target,
        by: sdk.ScrollBy.Line,
        amount: BigInt(3),
        session,
      });
      const outcome = actionOutcome(result, "Cua Driver could not scroll the registered stage window.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function drag(name: string, fromX: number, fromY: number, toX: number, toY: number, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      if (!validPoint(fromX, fromY, before) || !validPoint(toX, toY, before)) {
        throw new Error("Both drag points must fall inside the current stage window snapshot.");
      }
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, fromX, fromY, before);
      const target = new sdk.ActionTarget.Window({ pid, windowId });
      const result = await driver.drag({
        fromX,
        fromY,
        toX,
        toY,
        target,
        durationMs: BigInt(500),
        steps: BigInt(10),
        session,
      });
      const outcome = actionOutcome(result, "Cua Driver could not drag in the registered stage window.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
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
        forgetAgentDesktopInputTargets(cursorIdentity);
      }
    }
  }

  async function shutdown(): Promise<void> {
    const runtimePromise = agentRuntimePromise;
    agentRuntimePromise = undefined;
    const sessions = [...agentSessions.values()];
    agentSessions.clear();
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

  return { capture, describeTarget, moveCursor, listWindows, listVisibleWindows, click, typeText, scroll, drag,
    captureDesktop, describeDesktopTarget, moveDesktopCursor, clickDesktop, typeTextDesktop, scrollDesktop, dragDesktop,
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
