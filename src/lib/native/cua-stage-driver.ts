import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { defaultStoreRoot } from "./local-store";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionResult, ActionTarget, ClickPosition as CuaClickPosition, CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import { startCuaDriverHost, type CuaDriverHostConnection } from "./cua-driver-host";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "./windows-desktop-stage";
import type { VerifiedIdentity } from "./identity-core";

const CUA_PACKAGE = "@trycua/cua-driver";
const CUA_DRIVER_VERSION = "0.33.4";
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
    Element?: new (input: { elementToken: string }) => CuaClickPosition };
  InputDeliveryMode: { Background: number };
  ScrollDirection: { Up: number; Down: number };
  ScrollBy: { Line: number };
  CursorReducedMotion: { Auto: number };
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
}

export interface CuaStageCursorProof {
  x: number;
  y: number;
  enabled: true;
  visible: true;
}

export interface CuaStageDriverDependencies {
  stage?: WindowsStageDependencies;
  loadSdk?: () => Promise<CuaSdk>;
  connectRuntime?: CuaStageRuntimeConnector;
  now?: () => Date;
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

function stageCapture(capture: { dataUrl: string; width: number; height: number }, now: () => Date): CuaStageCapture {
  return { ...capture, capturedAt: now().toISOString() };
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
  let agentRuntimePromise: Promise<CuaRuntime> | undefined;

  async function createRuntime(): Promise<CuaRuntime> {
    const sdk = await loadSdk();
    const connection = deps.connectRuntime
      ? await deps.connectRuntime(sdk)
      : await startCuaDriverHost(sdk, { workingDirectory: process.cwd() });
    return { sdk, driver: connection.driver, close: connection.close };
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
      // Configuration is also idempotent. Reapply it in case Cua reclaimed and
      // recreated this named session while M9R was idle.
      resultError(await runtime.driver.setAgentCursorMotion({
        session: details.session,
        // Let Cua choose glide duration from travel distance. A fixed 220 ms
        // made long and short moves look equally abrupt. These values preserve
        // its smooth curved path while keeping the label visible after action.
        startHandle: 0.3,
        endHandle: 0.3,
        arcSize: 0.25,
        arcFlow: 0,
        spring: 0.72,
        glideDurationMs: 0,
        dwellAfterClickMs: 100,
        idleHideMs: 15_000,
        turnRadius: 80,
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

  async function moveAndVerifyCursor(input: { driver: CuaDriverLike; sdk: CuaSdk; session: string; pid: number; windowId: bigint }, x: number, y: number) {
    resultError(await input.driver.setAgentCursorEnabled({ session: input.session, enabled: true }), "Cua Driver could not enable the agent cursor.");
    const target = new input.sdk.ActionTarget.Window({ pid: input.pid, windowId: input.windowId });
    resultError(await input.driver.moveCursor({ x, y, target, session: input.session }), "Cua Driver could not move the agent cursor.");
    const state = cursorStateFromResult(await input.driver.getAgentCursorState({ session: input.session }));
    if (!state.enabled || state.x === undefined || state.y === undefined || Math.abs(state.x - x) > 1 || Math.abs(state.y - y) > 1) {
      throw new Error("Cua Driver did not confirm the requested agent cursor position on this stage window.");
    }
    const sessionState = await input.driver.getSession({ session: input.session });
    if (sessionState.cursorVisible !== true) throw new Error("Cua Driver moved the agent cursor but did not confirm that its desktop overlay is visible.");
    return { x: state.x, y: state.y, enabled: true as const, visible: true as const };
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
    capture: () => Promise<{ dataUrl: string; width: number; height: number }>;
    elementAt: (x: number, y: number) => Promise<string | undefined>;
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
        const state = await driver.getWindowState({
          pid,
          windowId,
          session,
          includeAccessibilityTree: false,
          includeScreenshot: true,
          maxImageDimension: MAX_IMAGE_DIMENSION,
          timeoutMs: 1_500,
        });
        const image = imageFromWindowState(state, pid, windowId);
        return { dataUrl: image.dataUrl, width: image.width, height: image.height };
      };
      const elementAt = async (x: number, y: number) => {
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
        return hits[0]?.elementToken;
      };
      return await run({ driver, sdk, session, pid, windowId, capture, elementAt });
    } finally {
      if (!persistent && started) {
        try { await driver.endSession({ session }); } catch { /* preserve the primary operation result */ }
      }
      if (!persistent) await disposeRuntime(runtime);
    }
  }

  async function capture(name: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageCapture> {
    return withRegisteredWindow(name, async ({ capture: captureWindow }) => ({
      ...await captureWindow(),
      capturedAt: now().toISOString(),
    }), cursorIdentity);
  }

  async function moveCursor(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity): Promise<{ capture: CuaStageCapture; cursor: CuaStageCursorProof }> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) throw new Error("Cursor coordinates must be non-negative whole screenshot pixels.");
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const captured = await captureWindow();
      if (x >= captured.width || y >= captured.height) throw new Error("Cursor coordinates must fall inside the current stage window snapshot.");
      const cursor = await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y);
      return {
        capture: stageCapture(captured, now),
        cursor,
      };
    }, cursorIdentity);
  }

  async function listWindows(name: string, ownedPid?: number): Promise<CuaStageWindowOption[]> {
    if (ownedPid !== undefined && (!Number.isSafeInteger(ownedPid) || ownedPid < 1)) throw new Error("Invalid owned application process.");
    // Inspecting the stage enforces the same interactive-owner and agent-context guard as stage changes.
    await manager.inspectStage(name);
    const runtime = await createRuntime();
    const { sdk, driver } = runtime;
    const session = safeSessionName(name);
    let started = false;
    try {
      await driver.startSession({ session });
      started = true;
      const result = await driver.listWindows({ onScreenOnly: ownedPid === undefined });
      return result.windows
        .filter((window) => Number.isSafeInteger(window.pid) && (window.pid ?? 0) > 0 && window.pid !== process.pid
          && typeof window.windowId === "bigint" && window.windowId > BigInt(0)
          && (ownedPid === undefined ? window.isOnScreen === true : window.pid === ownedPid) && window.minimized !== true
          && Number.isFinite(window.bounds.width) && Number.isFinite(window.bounds.height)
          && window.bounds.width >= 80 && window.bounds.height >= 60
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
      await disposeRuntime(runtime);
    }
  }

  async function click(name: string, x: number, y: number, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow, elementAt }) => {
      const before = await captureWindow();
      if (!validPoint(x, y, before)) throw new Error("Click coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y);
      if (await nativeControl(name, "click", { x, y, imageWidth: before.width, imageHeight: before.height })) return { capture: stageCapture(await captureWindow(), now),
        outcome: { status: "unverifiable", summary: "Routed the click to the exact native child control; application effect requires verification." } };
      const target = new sdk.ActionTarget.Window({ pid, windowId });
      const token = sdk.ClickPosition.Element ? await elementAt(x, y) : undefined;
      const result = await driver.click({
        target,
        position: token && sdk.ClickPosition.Element ? new sdk.ClickPosition.Element({ elementToken: token }) : new sdk.ClickPosition.Coordinates({ x, y }),
        deliveryMode: sdk.InputDeliveryMode.Background,
        session,
      });
      const outcome = actionOutcome(result, "Cua Driver could not click the registered stage window.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function typeText(name: string, text: string, cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_ACTION_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error(`Text must contain 1–${MAX_TEXT_ACTION_LENGTH} characters and no control characters.`);
    }
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      await captureWindow();
      if (await nativeControl(name, "type", undefined, { text })) return { capture: stageCapture(await captureWindow(), now),
        outcome: { status: "unverifiable", summary: "Posted text to the selected native edit control; application effect requires verification." } };
      const target = new sdk.ActionTarget.Window({ pid, windowId });
      const result = await driver.typeText({ text, target, session });
      const outcome = actionOutcome(result, "Cua Driver could not type into the registered stage window.");
      return { capture: stageCapture(await captureWindow(), now), outcome };
    }, cursorIdentity);
  }

  async function scroll(name: string, x: number, y: number, direction: "up" | "down", cursorIdentity?: CuaAgentCursorIdentity): Promise<CuaStageActionProof> {
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const before = await captureWindow();
      if (!validPoint(x, y, before)) throw new Error("Scroll coordinates must fall inside the current stage window snapshot.");
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, x, y);
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
      if (cursorIdentity) await moveAndVerifyCursor({ driver, sdk, session, pid, windowId }, fromX, fromY);
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
      finally { agentSessions.delete(details.key); }
    }
  }

  async function shutdown(): Promise<void> {
    const runtimePromise = agentRuntimePromise;
    agentRuntimePromise = undefined;
    const sessions = [...agentSessions.values()];
    agentSessions.clear();
    if (!runtimePromise) return;
    try {
      const runtime = await runtimePromise;
      for (const session of sessions) {
        try { await runtime.driver.endSession({ session: session.session }); } catch { /* continue closing remaining sessions */ }
      }
      await disposeRuntime(runtime);
    } catch { /* the runtime never initialized */ }
  }

  return { capture, moveCursor, listWindows, click, typeText, scroll, drag, closeAgentCursor, shutdown };
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
