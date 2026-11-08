import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { renameStateFile } from "./atomic-file";
import { DesktopInputNotDispatchedError } from "./desktop-input-errors";
import type { StageApprovalRequest } from "./web-broker-core";

export type OwnerWorkMode = "working" | "agents-free";
export function isOwnerWorkMode(value: unknown): value is OwnerWorkMode { return value === "working" || value === "agents-free"; }
export interface ForegroundAuthorizationResult { readonly restoreOwnerContext: boolean }

function foregroundGrantKey(pid: unknown, windowId: unknown): string | undefined {
  const processId = typeof pid === "number" ? pid : typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : NaN;
  const handle = typeof windowId === "string" && /^(?:0[xX][0-9a-f]+|[0-9]+)$/i.test(windowId) ? windowId : undefined;
  if (!Number.isSafeInteger(processId) || processId < 1 || !handle) return undefined;
  try { return `foreground:${processId}:${BigInt(handle).toString()}`; } catch { return undefined; }
}
export function readOwnerWorkPreference(root: string): { mode: OwnerWorkMode; revision: string } {
  const path = join(root, "owner-work-mode.json");
  if (!existsSync(path)) return { mode: "working", revision: "unset" };
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 1 || !isOwnerWorkMode(value.mode) || (value.revision !== undefined && !/^[a-f0-9-]{36}$/.test(value.revision))) throw new Error("The owner work-mode preference is invalid; foreground input remains unavailable until it is set again.");
  return { mode: value.mode, revision: value.revision ?? "legacy" };
}
export function readOwnerWorkMode(root: string): OwnerWorkMode { return readOwnerWorkPreference(root).mode; }
export function setOwnerWorkMode(root: string, mode: OwnerWorkMode): void {
  if (!isOwnerWorkMode(mode)) throw new Error("Invalid owner work mode.");
  mkdirSync(root, { recursive: true });
  const temporary = join(root, `owner-work-mode.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ version: 1, mode, revision: randomUUID() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameStateFile(temporary, join(root, "owner-work-mode.json"));
}

type Turn = { agent: string; provider: string; sessionId: string; taskId: string; signal: AbortSignal; grants: Map<string, string>; assertActive?: () => void };
/** One authorization scope per ordered agent operation; never shared across tasks. */
export function createOwnerWorkPolicy(root: string, approvals: () => { requestApproval(request: StageApprovalRequest): Promise<boolean> } | undefined) {
  const context = new AsyncLocalStorage<Turn>();
  return {
    run<T>(turn: Omit<Turn, "grants">, operation: () => Promise<T>): Promise<T> {
      return context.run({ ...turn, grants: new Map() }, operation);
    },
    /** Called only after the launcher resolves and natively attaches its new app HWND. Not an agent API. */
    carryLaunchGrant(appId: string, pid: number, windowId: string): void {
      const turn = context.getStore();
      if (!turn || !Number.isSafeInteger(pid) || pid < 1 || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(windowId)) throw new DesktopInputNotDispatchedError("The launched window has no exact foreground authorization context.", "foreground-approval");
      turn.signal.throwIfAborted(); turn.assertActive?.();
      const current = readOwnerWorkPreference(root);
      if (current.mode === "agents-free") return;
      if (turn.grants.get(`desktop:app:${appId}`) === current.revision) {
        const key = foregroundGrantKey(pid, windowId);
        if (key) turn.grants.set(key, current.revision);
      }
    },
    async authorize(request: Record<string, unknown>): Promise<ForegroundAuthorizationResult> {
      const turn = context.getStore();
      if (!turn) throw new DesktopInputNotDispatchedError("Foreground input requires an active broker-owned task turn; no input was sent.", "foreground-lease");
      turn.signal.throwIfAborted();
      turn.assertActive?.();
      const preference = readOwnerWorkPreference(root);
      if (preference.mode === "agents-free") return { restoreOwnerContext: false };
      if (request.op === "restoreForegroundContext") {
        const key = foregroundGrantKey(request.pid, request.windowId);
        return { restoreOwnerContext: Boolean(key && turn.grants.get(key) === preference.revision) };
      }
      const globalMediaInput = request.op === "systemControl" && request.control === "media";
      if (globalMediaInput && !["play_pause", "next", "previous"].includes(String(request.action))) {
        throw new DesktopInputNotDispatchedError("The requested global media key is not supported; no media input was sent.", "foreground-approval");
      }
      if (request.op === "restoreCursorPosition" && [...turn.grants.entries()].some(([key, revision]) =>
        key.startsWith("foreground:") && revision === preference.revision)) return { restoreOwnerContext: false };
      const launchTarget = request.op === "launch" && typeof request.windowId === "string"
        && /^app:[a-z0-9._-]{1,80}$/i.test(request.windowId)
        ? `desktop:${request.windowId}` : undefined;
      const target = globalMediaInput
        ? `global:media:${String(request.action)}`
        : launchTarget ?? foregroundGrantKey(request.pid, request.windowId) ?? `foreground:desktop:${String(request.windowId ?? "desktop")}`;
      if (turn.grants.get(target) === preference.revision) return { restoreOwnerContext: !globalMediaInput };
      const route = approvals();
      if (!route) throw new DesktopInputNotDispatchedError(globalMediaInput
        ? "I'm Working is active. This global media action needs owner approval; the approval route is unavailable. No media key was sent."
        : "I'm Working is active. This action needs a foreground turn; the owner approval route is unavailable. No input was sent.", "foreground-approval");
      const waiting = new AbortController();
      const cancel = () => waiting.abort(turn.signal.reason);
      turn.signal.addEventListener("abort", cancel, { once: true });
      const modePoll = setInterval(() => { try { if (readOwnerWorkPreference(root).revision !== preference.revision) waiting.abort(); } catch { waiting.abort(); } }, 100);
      modePoll.unref();
      let accepted: boolean;
      const approval = globalMediaInput
        ? { step: `Allow @${turn.agent} to send the ${String(request.action).replaceAll("_", " ")} media key? It may control the active media app.`,
            action: "global_media_key", risk: "global-media-input" }
        : { step: `Allow a foreground turn for @${turn.agent}? Your current work may briefly lose focus.`,
            action: "foreground_turn", risk: "foreground-input" };
      try { accepted = await route.requestApproval({ agent: turn.agent, provider: turn.provider, sessionId: turn.sessionId,
        ...approval, timeoutMs: 55_000, signal: waiting.signal }); }
      finally { clearInterval(modePoll); turn.signal.removeEventListener("abort", cancel); }
      turn.signal.throwIfAborted();
      turn.assertActive?.();
      const current = readOwnerWorkPreference(root);
      if (current.mode === "agents-free") return { restoreOwnerContext: false };
      if (current.revision !== preference.revision) throw new DesktopInputNotDispatchedError("The owner changed the work mode while this foreground turn was waiting. No input was sent; request a new turn.", "foreground-approval");
      if (!accepted) throw new DesktopInputNotDispatchedError(globalMediaInput
        ? "The global media action is waiting for owner approval. No media key was sent; retry when approved or switch to Agents Free."
        : "The foreground turn is waiting for owner approval. No input was sent; retry when approved or switch to Agents Free.", "foreground-approval");
      turn.grants.set(target, current.revision);
      return { restoreOwnerContext: !globalMediaInput };
    },
  };
}
