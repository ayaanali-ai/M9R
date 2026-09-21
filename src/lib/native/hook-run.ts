/**
 * One hook call, as a function: given the event JSON an agent sent, return the text the hook prints. Used by the small hook
 * program (`m9r-hook.js`) and by the resident engine's hook server, so there is a single copy of the logic.
 */
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "./local-store";
import { handleHookEvent, type HookInput } from "./hook-handler";
import { collectCodexResults, deliverToCodex, realDeps, spawnDeliveryRunner } from "./codex-delivery";

export interface HookRequest {
  event: string;
  provider: string;
  input: HookInput | null;
  /** Only the few settings the hook reads (M9R_HOME, CODEX_HOME, PATH...); the caller's own environment, not the server's. */
  env?: Record<string, string | undefined>;
}

/**
 * `runnerEntry` is what a detached Codex push re-launches: the engine executable, or the hook script for node. With
 * `inProcess` (the resident engine) the push runs right here instead: starting a second copy of the 92 MB engine cold took
 * 5 s or more, which is most of the delay between typing `@codex` and Codex receiving it.
 */
export function runHookRequest(req: HookRequest, runnerEntry: string, baseEnv: Record<string, string | undefined> = process.env, inProcess = false): string {
  const env = { ...baseEnv, ...(req.env ?? {}) };
  const store = createLocalStore(defaultStoreRoot(homedir(), env));
  const deps = realDeps(env);
  const input: HookInput = { ...(req.input ?? {}) };
  if (!input.hook_event_name && req.event) input.hook_event_name = req.event;
  const result = handleHookEvent(input, {
    provider: req.provider,
    store,
    dispatch: (id) => { if (inProcess) void deliverToCodex(store, id, deps).catch(() => undefined); else spawnDeliveryRunner(runnerEntry, id, env); },
    collect: () => { collectCodexResults(store, deps); },
  });
  return result ? JSON.stringify(result) : "";
}
