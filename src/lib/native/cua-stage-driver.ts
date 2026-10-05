import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionTarget, CuaDriverLike } from "@trycua/cua-driver";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "./windows-desktop-stage";

const CUA_PACKAGE = "@trycua/cua-driver";
const MAX_IMAGE_DIMENSION = 1024;
// Keep the base64 JSON response comfortably below the native pill's 4 MiB stdout cap.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SESSION_PREFIX = "m9r-stage-";

type WindowTargetFactory = {
  Window: new (input: { pid: number; windowId: bigint }) => ActionTarget;
};

type CuaSdk = {
  CuaDriver: { create(options?: undefined): CuaDriverLike };
  ActionTarget: WindowTargetFactory;
};

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
}

export interface CuaStageDriverDependencies {
  stage?: WindowsStageDependencies;
  loadSdk?: () => Promise<CuaSdk>;
  now?: () => Date;
}

function bundledSdkUrl(): string | null {
  const path = join(dirname(process.execPath), "cua-driver-runtime", "node_modules", "@trycua", "cua-driver", "dist", "index.js");
  return existsSync(path) ? pathToFileURL(path).href : null;
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
    throw new Error(`Cua Driver 0.33.2 is unavailable in this M9R runtime (${reason}). Reinstall the M9R Windows runtime with its Cua Driver files.`);
  }
}

function safeSessionName(stageName: string): string {
  return `${SESSION_PREFIX}${stageName}`.slice(0, 64);
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
  if (state.screenshotFrameValid !== true || !Number.isInteger(state.screenshotWidth) || !Number.isInteger(state.screenshotHeight)
    || (state.screenshotWidth ?? 0) < 1 || (state.screenshotHeight ?? 0) < 1
    || (state.screenshotWidth ?? 0) > 16_384 || (state.screenshotHeight ?? 0) > 16_384) {
    throw new Error("Cua Driver could not verify a valid stage window snapshot.");
  }
  const image = state.images[0];
  if (!image) throw new Error("Cua Driver did not return an image for this stage window.");
  const safe = checkImage(image.mimeType, image.dataBase64);
  return {
    dataUrl: `data:${safe.mimeType};base64,${safe.dataBase64}`,
    width: state.screenshotWidth!,
    height: state.screenshotHeight!,
  };
}

function resultError(result: { isError: boolean; text?: string }, fallback: string): void {
  if (result.isError) {
    const detail = typeof result.text === "string" ? result.text.replace(/[\r\n\t]+/g, " ").slice(0, 240).trim() : "";
    throw new Error(detail || fallback);
  }
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
 * Cua Driver window-only local snapshot and cursor adapter for a registered stage anchor.
 * It never captures a full desktop, enumerates unrelated windows, or sends the frame over the network.
 */
export function createCuaStageDriver(deps: CuaStageDriverDependencies = {}) {
  const manager = createWindowsDesktopStageManager(deps.stage);
  const loadSdk = deps.loadSdk ?? loadCuaSdk;
  const now = deps.now ?? (() => new Date());

  async function withRegisteredWindow<T>(nameInput: string, run: (input: {
    driver: CuaDriverLike;
    sdk: CuaSdk;
    session: string;
    pid: number;
    windowId: bigint;
    capture: () => Promise<{ dataUrl: string; width: number; height: number }>;
  }) => Promise<T>): Promise<T> {
    const { stage, anchor } = await manager.inspectStage(nameInput);
    if (!anchor) throw new Error(`Stage “${stage.name}” has no registered app window. Register an owned window before capturing or moving the Cua cursor.`);
    const pid = anchor.pid;
    const windowId = parseWindowId(anchor.windowId);
    const sdk = await loadSdk();
    const driver = sdk.CuaDriver.create(undefined);
    const session = safeSessionName(stage.name);
    let started = false;
    try {
      await driver.startSession({ session });
      started = true;
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
      return await run({ driver, sdk, session, pid, windowId, capture });
    } finally {
      if (started) {
        try { await driver.endSession({ session }); } catch { /* preserve the primary operation result */ }
      }
      try { await driver.shutdown(); } catch { /* repeated shutdown is harmless; preserve the primary result */ }
    }
  }

  async function capture(name: string): Promise<CuaStageCapture> {
    return withRegisteredWindow(name, async ({ capture: captureWindow }) => ({
      ...await captureWindow(),
      capturedAt: now().toISOString(),
    }));
  }

  async function moveCursor(name: string, x: number, y: number): Promise<{ capture: CuaStageCapture; cursor: CuaStageCursorProof }> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) throw new Error("Cursor coordinates must be non-negative whole screenshot pixels.");
    return withRegisteredWindow(name, async ({ driver, sdk, session, pid, windowId, capture: captureWindow }) => {
      const captured = await captureWindow();
      if (x >= captured.width || y >= captured.height) throw new Error("Cursor coordinates must fall inside the current stage window snapshot.");
      const enabled = await driver.setAgentCursorEnabled({ session, enabled: true });
      resultError(enabled, "Cua Driver could not enable the stage cursor.");
      const target = new sdk.ActionTarget.Window({ pid, windowId });
      const moved = await driver.moveCursor({ x, y, target, session });
      resultError(moved, "Cua Driver could not move the stage cursor.");
      const state = cursorStateFromResult(await driver.getAgentCursorState({ session }));
      if (!state.enabled || state.x === undefined || state.y === undefined || Math.abs(state.x - x) > 1 || Math.abs(state.y - y) > 1) {
        throw new Error("Cua Driver did not confirm the requested cursor position on this stage window.");
      }
      return {
        capture: { ...captured, capturedAt: now().toISOString() },
        cursor: { x: state.x, y: state.y, enabled: true },
      };
    });
  }

  return { capture, moveCursor };
}

export async function runCuaStageDriverCli(args: string[], deps: CuaStageDriverDependencies = {}): Promise<number> {
  const json = args.includes("--json");
  const commandArgs = args.filter((arg) => arg !== "--json");
  const [action, name, xInput, yInput] = commandArgs;
  try {
    if (!json) throw new Error("Cua stage actions require --json so binary image data and coordinates stay structured.");
    const driver = createCuaStageDriver(deps);
    if (action === "capture" && commandArgs.length === 2) {
      process.stdout.write(`${JSON.stringify({ ok: true, capture: await driver.capture(name!) })}\n`);
      return 0;
    }
    if (action === "cursor" && commandArgs.length === 4) {
      if (!/^\d{1,5}$/.test(xInput!) || !/^\d{1,5}$/.test(yInput!)) throw new Error("Cursor coordinates must be whole screenshot pixels.");
      process.stdout.write(`${JSON.stringify({ ok: true, ...await driver.moveCursor(name!, Number(xInput), Number(yInput)) })}\n`);
      return 0;
    }
    throw new Error("Usage: m9r web stage capture <name> --json | cursor <name> <x> <y> --json");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cua stage action failed.";
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message.slice(0, 500) })}\n`);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
}
