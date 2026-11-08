import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { renameStateFile } from "./atomic-file";
import { DesktopInputNotDispatchedError } from "./desktop-input-errors";
import type { StageApprovalRequest } from "./web-broker-core";

export type OwnerWorkMode = "working" | "agents-free";
export function isOwnerWorkMode(value: unknown): value is OwnerWorkMode { return value === "working" || value === "agents-free"; }
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
      if (turn.grants.get(`desktop:app:${appId}`) === current.revision) turn.grants.set(`${pid}:${windowId}`, current.revision);
    },
    async authorize(request: Record<string, unknown>): Promise<void> {
      const turn = context.getStore();
      if (!turn) throw new DesktopInputNotDispatchedError("Foreground input requires an active broker-owned task turn; no input was sent.", "foreground-lease");
      turn.signal.throwIfAborted();
      turn.assertActive?.();
      const preference = readOwnerWorkPreference(root);
      if (preference.mode === "agents-free") return;
      if (request.op === "restoreCursorPosition" && [...turn.grants.values()].includes(preference.revision)) return;
      const target = `${request.pid ?? "desktop"}:${request.windowId ?? "desktop"}`;
      if (turn.grants.get(target) === preference.revision) return;
      const route = approvals();
      if (!route) throw new DesktopInputNotDispatchedError("I'm Working is active. This action needs a foreground turn; the owner approval route is unavailable. No input was sent.", "foreground-approval");
      const waiting = new AbortController();
      const cancel = () => waiting.abort(turn.signal.reason);
      turn.signal.addEventListener("abort", cancel, { once: true });
      const modePoll = setInterval(() => { try { if (readOwnerWorkPreference(root).revision !== preference.revision) waiting.abort(); } catch { waiting.abort(); } }, 100);
      modePoll.unref();
      let accepted: boolean;
      try { accepted = await route.requestApproval({ agent: turn.agent, provider: turn.provider, sessionId: turn.sessionId,
        step: `Allow a foreground turn for @${turn.agent}? Your current work may briefly lose focus.`, action: "foreground_turn", risk: "foreground-input", timeoutMs: 55_000, signal: waiting.signal }); }
      finally { clearInterval(modePoll); turn.signal.removeEventListener("abort", cancel); }
      turn.signal.throwIfAborted();
      turn.assertActive?.();
      const current = readOwnerWorkPreference(root);
      if (current.mode === "agents-free") return;
      if (current.revision !== preference.revision) throw new DesktopInputNotDispatchedError("The owner changed the work mode while this foreground turn was waiting. No input was sent; request a new turn.", "foreground-approval");
      if (!accepted) throw new DesktopInputNotDispatchedError("The foreground turn is waiting for owner approval. No input was sent; retry when approved or switch to Agents Free.", "foreground-approval");
      turn.grants.set(target, current.revision);
    },
  };
}
