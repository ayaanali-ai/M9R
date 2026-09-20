/**
 * Starts the Mission ACP Bridge as part of the local runtime
 * (scripts/oathlock-terminal-bridge.ts), using whichever agent connection
 * `oathlock init` already authenticated on this machine — the Buzz-parity
 * path: no separate cloud deployment, no API key, because the local
 * Codex/Claude Code CLI is already logged in via subscription and this
 * process just inherits that (same reasoning as Buzz's buzz-acp spawning a
 * child process that inherits the parent environment).
 *
 * Best-effort by design: a workspace with no local token yet, or an
 * unreachable app/relay, must never break the terminal bridge's own raw-PTY
 * functionality, which has nothing to do with this.
 */

import { readdir, readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { startMissionBridge, describeConnectionError, type MissionBridgeHandle } from "../../../services/mission-bridge/src/bridge-runtime";
import { parseProviderAdapterConfig, type ProviderAdapterConfig, PROVIDER_SLUG_PATTERN } from "../provider-adapter-config";
import { parseWatchdogLockPid, parseWatchdogLockStartedAt, shouldStartWatchdog, stillHoldsWatchdogLock } from "../oathlock-watchdog";
import { M9R_DIR } from "../oathlock-cli-core";

const DEFAULT_RELAY_PUBLIC_URL = "https://m9r-relay.m9r.workers.dev";
const DEFAULT_APP_URL = "https://app.m9r.workers.dev";
const LOCAL_TOKEN_PROVIDER_ORDER = ["claude-code", "codex", "opencode"] as const;

interface LocalAgentToken {
  token: string;
}

/** All connected provider names on this machine, in a stable order -- used to decide how many bridge processes to spawn, before any token is actually read. */
export async function listLocalConnectedProviders(repositoryRoot: string): Promise<string[]> {
  const found = new Set<string>();
  let entries: string[] = [];
  try {
    entries = await readdir(join(repositoryRoot, M9R_DIR, "agents"));
  } catch {
    return [];
  }
  const ordered = [...LOCAL_TOKEN_PROVIDER_ORDER, ...entries.filter((entry) => !LOCAL_TOKEN_PROVIDER_ORDER.includes(entry as typeof LOCAL_TOKEN_PROVIDER_ORDER[number])).sort()];
  for (const provider of ordered) {
    if (!PROVIDER_SLUG_PATTERN.test(provider)) continue;
    try {
      const raw = await readFile(join(repositoryRoot, M9R_DIR, "agents", provider, "local.json"), "utf8");
      const parsed = JSON.parse(raw) as LocalAgentToken;
      if (typeof parsed.token === "string" && parsed.token.trim()) found.add(provider);
    } catch {
      // Not connected under this provider name.
    }
  }
  return [...found];
}

/**
 * M9R_LOCAL_MISSION_BRIDGE_PROVIDER pins this process to exactly one
 * connected provider's token instead of "whichever is found first" -- set
 * by m9r-terminal-bridge.ts, which spawns one Mission Bridge child
 * process per connected provider (each its own OS process, so each has its
 * own real process.env -- startMissionBridge sets process.env.M9R_
 * AGENT_TOKEN globally, so running more than one provider's bridge inside
 * a single process would make them overwrite each other's token for every
 * dynamically-spawned dev-mcp-server session, not just the one that
 * started last). Falls back to "first found" only when unset, for any
 * caller that still wants the old single-bridge behavior.
 */
async function readLocalToken(repositoryRoot: string): Promise<{ provider: string; token: string } | null> {
  const pinned = process.env.OATHLOCK_LOCAL_MISSION_BRIDGE_PROVIDER?.trim();
  if (pinned && !PROVIDER_SLUG_PATTERN.test(pinned)) return null;
  const order = pinned ? [pinned] : await listLocalConnectedProviders(repositoryRoot);
  for (const provider of order) {
    if (!PROVIDER_SLUG_PATTERN.test(provider)) continue;
    try {
      const raw = await readFile(join(repositoryRoot, ".oathlock", "agents", provider, "local.json"), "utf8");
      const parsed = JSON.parse(raw) as LocalAgentToken;
      if (typeof parsed.token === "string" && parsed.token.trim()) return { provider, token: parsed.token.trim() };
    } catch {
      // Not connected under this provider name — try the next.
    }
  }
  return null;
}

/** Read an optional operator-authored generic ACP adapter for this provider. */
export async function readLocalProviderAdapter(repositoryRoot: string, provider: string): Promise<ProviderAdapterConfig | null> {
  if (!PROVIDER_SLUG_PATTERN.test(provider)) return null;
  if (["codex", "claude-code", "opencode"].includes(provider)) return null;
  try {
    const raw = JSON.parse(await readFile(join(repositoryRoot, ".oathlock", "agents", provider, "adapter.json"), "utf8")) as unknown;
    const parsed = parseProviderAdapterConfig(raw, provider);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

export type WhoamiOutcome = { kind: "ok"; workspaceId: string } | { kind: "revoked" } | { kind: "unresolved" };

/**
 * Only a 401 whose body says the agent token itself is invalid/expired/revoked counts as
 * "revoked". Any other failure (network error, 5xx, a 401 from a proxy in front of the wrong
 * host) is "unresolved" and must never cause a valid local token to be retired.
 */
export function classifyWhoamiResponse(status: number, bodyText: string): WhoamiOutcome {
  if (status === 401 && /invalid or expired agent token|revoked/i.test(bodyText)) return { kind: "revoked" };
  if (status < 200 || status >= 300) return { kind: "unresolved" };
  try {
    const body = JSON.parse(bodyText) as { workspaceId?: unknown };
    return typeof body.workspaceId === "string" && body.workspaceId ? { kind: "ok", workspaceId: body.workspaceId } : { kind: "unresolved" };
  } catch {
    return { kind: "unresolved" };
  }
}

async function resolveWorkspace(appUrl: string, token: string): Promise<WhoamiOutcome> {
  try {
    const response = await fetch(`${appUrl.replace(/\/$/, "")}/api/agent/whoami`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return classifyWhoamiResponse(response.status, await response.text().catch(() => ""));
  } catch {
    return { kind: "unresolved" };
  }
}

/**
 * A revoked connection's token can never work again, so leaving it as local.json makes the
 * runtime keep launching a bridge for it forever (and shows the provider as connected).
 * Move it aside rather than delete it: reversible, and `m9r init` writes a fresh local.json.
 */
export async function retireRevokedLocalToken(repositoryRoot: string, provider: string): Promise<string | null> {
  if (!PROVIDER_SLUG_PATTERN.test(provider)) return null;
  const dir = join(repositoryRoot, M9R_DIR, "agents", provider);
  const from = join(dir, "local.json");
  const to = join(dir, "local.revoked.json");
  try {
    await rename(from, to);
    return to;
  } catch {
    return null;
  }
}

export interface LocalMissionBridgeStartResult {
  ok: true;
  handle: MissionBridgeHandle;
  provider: string;
}
export interface LocalMissionBridgeSkipResult {
  ok: false;
  reason: "acp_bridge_disabled" | "no_local_token" | "workspace_unresolvable" | "connection_revoked" | "start_failed" | "already_running";
  detail?: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const bridgeLockPath = (repositoryRoot: string, provider: string) => join(repositoryRoot, M9R_DIR, "agents", provider, "bridge.lock");

/**
 * A real leader-election lock, one per (repositoryRoot, provider) pair --
 * without it, briefly overlapping bridge processes for the same connection
 * (confirmed live: caught mid-restart, old and new both alive together)
 * each ran their own independent copy of everything bridge-runtime.ts does,
 * not just the loop-hard-stop notice duplicated by that -- the notice was
 * only the visible symptom. Reuses the exact watchdog lock primitives
 * (oathlock-watchdog.ts): a lock file with `{pid, startedAt}`, stale if the
 * pid is dead or the lock is implausibly old (pid recycling), which is
 * already proven correct against this exact class of bug for the terminal
 * runtime's own watchdog.
 */
async function acquireBridgeLock(repositoryRoot: string, provider: string): Promise<boolean> {
  const path = bridgeLockPath(repositoryRoot, provider);
  let raw: string | null = null;
  try { raw = await readFile(path, "utf8"); } catch { /* no lock yet */ }
  if (!shouldStartWatchdog(parseWatchdogLockPid(raw), isPidAlive, parseWatchdogLockStartedAt(raw))) return false;
  await mkdir(join(repositoryRoot, ".oathlock", "agents", provider), { recursive: true });
  await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  // Two processes can both observe a free slot and both write within the
  // same few milliseconds -- the same race the watchdog itself has and
  // solves the same way: read back after writing, and only the write that's
  // actually still named by the file on disk is the real winner. The loser
  // must not proceed to start a second live bridge for this provider.
  const confirm = await readFile(path, "utf8").catch(() => null);
  return stillHoldsWatchdogLock(confirm, process.pid);
}

async function releaseBridgeLock(repositoryRoot: string, provider: string): Promise<void> {
  const path = bridgeLockPath(repositoryRoot, provider);
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!stillHoldsWatchdogLock(raw, process.pid)) return;
  await unlink(path).catch(() => undefined);
}

export async function startLocalMissionBridge(repositoryRoot: string): Promise<LocalMissionBridgeStartResult | LocalMissionBridgeSkipResult> {
  // Mention-triggered autonomous work is now the intended default experience
  // (running `oathlock terminal runtime` is already an explicit, deliberate
  // command — requiring a second env var on top of that was friction for a
  // path that used to be experimental and no longer is). Opt OUT with
  // ACP_BRIDGE_ENABLED=false, rather than needing to opt in with =true.
  // Set the literal env var (not just a local boolean) so the deeper,
  // independent fail-closed check in AcpSessionController -- which reads
  // process.env directly, several layers down -- sees the same decision
  // instead of silently disagreeing with it.
  if (process.env.ACP_BRIDGE_ENABLED?.trim().toLowerCase() === "false") return { ok: false, reason: "acp_bridge_disabled" };
  process.env.ACP_BRIDGE_ENABLED = "true";
  // Workspace messaging is part of the live bridge contract, not an optional
  // provider capability. Without the dev MCP server, sessions can still
  // launch and acknowledge a mention but they have no send_message tool, so
  // every real turn ends as "completed, but no message was posted". Keep the
  // explicit opt-out for operators that intentionally run a read-only bridge,
  // but make the normal local runtime self-contained for agent-to-agent work.
  if (process.env.MISSION_DEV_MCP_TOOLS_ENABLED?.trim().toLowerCase() !== "false") {
    process.env.MISSION_DEV_MCP_TOOLS_ENABLED = "true";
  }
  const local = await readLocalToken(repositoryRoot);
  if (!local) return { ok: false, reason: "no_local_token" };
  // Leader election, before anything about this provider's bridge actually
  // starts -- a losing process must never reach the point of holding a live
  // ACP session or a relay connection at all, since that's the state that
  // was actually duplicating (the loop-hard-stop notice was only the
  // visible symptom of it).
  if (!(await acquireBridgeLock(repositoryRoot, local.provider))) {
    return { ok: false, reason: "already_running", detail: `A live Mission Bridge for ${local.provider} already holds the lock at ${bridgeLockPath(repositoryRoot, local.provider)}.` };
  }
  const localAdapter = await readLocalProviderAdapter(repositoryRoot, local.provider);

  // OATHLOCK_API_URL is what the rest of the CLI (init, whoami, the terminal bridge) reads, so a
  // user who set it must not have the bridge silently talk to a different host.
  const appUrl = (process.env.OATHLOCK_APP_URL?.trim() || process.env.OATHLOCK_API_URL?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
  // Real bug fixed here: this read a var name (OATHLOCK_MISSION_RELAY_URL)
  // nothing else in the codebase sets -- MISSION_RELAY_PUBLIC_URL is the
  // actual documented name (.env.example, services/mission-bridge/src/index.ts's
  // production entrypoint, the Next app's own relay-token route). Confirmed
  // live: with the wrong name, every local bridge silently fell back to
  // DEFAULT_RELAY_PUBLIC_URL (the production relay), while the dashboard
  // browser connects to the local relay from MISSION_RELAY_PUBLIC_URL in
  // .env.local -- two different relay servers, so workspace.step/turn frames
  // a local bridge published were never seen by anyone locally, with no
  // error surfaced anywhere (the relay client's connection failures are
  // logged but easy to miss, and message delivery itself works fine over
  // plain HTTP regardless, so nothing else looked broken).
  const relayPublicUrl = process.env.MISSION_RELAY_PUBLIC_URL?.trim() || DEFAULT_RELAY_PUBLIC_URL;
  const workspace = await resolveWorkspace(appUrl, local.token);
  if (workspace.kind === "revoked") {
    await releaseBridgeLock(repositoryRoot, local.provider);
    const moved = await retireRevokedLocalToken(repositoryRoot, local.provider);
    return {
      ok: false,
      reason: "connection_revoked",
      detail: `the ${local.provider} connection was disconnected/revoked${moved ? ` -- its local token was moved to ${moved}` : ""}. Run: m9r init --agent-kind ${local.provider}`,
    };
  }
  if (workspace.kind !== "ok") { await releaseBridgeLock(repositoryRoot, local.provider); return { ok: false, reason: "workspace_unresolvable" }; }
  const workspaceId = workspace.workspaceId;

  try {
    const handle = await startMissionBridge({
      workspaceId,
      relayPublicUrl,
      // The relay accepts a plain agent bearer token as a valid Bridge
      // credential (mission-relay-production.ts's authenticateAgent
      // fallback) — no separate MISSION_RELAY_TOKEN_SECRET-signed token
      // needed for the local path.
      relayBridgeToken: local.token,
      appUrl,
      agentToken: local.token,
      // Each provider child is its own durable Bridge identity. Reusing a
      // fixed `local-${provider}` id across restarts makes presence and Bridge
      // telemetry sequences collide with the previous process and can leave
      // the new child looking connected locally but inactive on the server.
      bridgeInstanceId: `local-${local.provider}-${randomUUID()}`,
      repositoryRoot,
      localAdapter,
      // No initialSessions: sessions start dynamically per Mission-bound
      // @mention (bridge-runtime.ts's ensureDynamicSessionForConversation).
      // No healthCheckPort: the terminal bridge already owns /health on
      // this process's HTTP server.
      // Constrains this bridge to only ever start ITS OWN provider's
      // sessions -- see MissionBridgeConfig.localProvider's own comment for
      // why every bridge would otherwise happily start either.
      localProvider: local.provider,
    });
    // The handle resolves before registration/first-heartbeat finish (they
    // run in a detached background block in bridge-runtime.ts) -- listen so
    // a DNS failure or auth rejection that happens right after this point is
    // still visible, instead of silently leaving a handle that looks "ok"
    // but never actually reached the relay.
    handle.events.on("connectionError", ({ stage, error }: { stage: string; error: unknown }) => {
      console.error(`Mission Bridge (${local.provider}) failed to connect during ${stage}:`, describeConnectionError(error));
    });
    // The lock must outlive this function call (it's held for the process's
    // whole life), so it's released from the handle's own stop() -- the one
    // path every caller (SIGTERM/SIGINT in local-mission-bridge-runner.ts,
    // a stale-build self-restart) already goes through to shut down cleanly.
    const originalStop = handle.stop.bind(handle);
    handle.stop = async () => {
      await originalStop();
      await releaseBridgeLock(repositoryRoot, local.provider);
    };
    return { ok: true, handle, provider: local.provider };
  } catch (error) {
    await releaseBridgeLock(repositoryRoot, local.provider);
    return { ok: false, reason: "start_failed", detail: error instanceof Error ? error.message : String(error) };
  }
}
