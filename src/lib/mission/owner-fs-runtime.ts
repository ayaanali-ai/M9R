import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MissionRelayClient } from "./mission-relay-client";
import { FsTreeHost } from "../bridge/fs-tree-host";
import { parseFsTreeRequestPayload, parseFsReadRequestPayload } from "./mission-fs-protocol";
import type { RelayFrame } from "./mission-relay-protocol";

/**
 * Item #9 Phase 1a: the machine-level bootstrap for resident-served real
 * files, no Tauri needed (see M9R_MASTER_BUILD_PLAN.md's #9 section). Runs
 * once per machine alongside owner-pty-runtime.ts, same "any one connected
 * provider's token is good enough" identity posture -- fs access is a
 * property of the machine, not of any one connected agent.
 *
 * Unlike PTY/Codex, there is no session state to keep: a directory listing
 * or file read is answered once and forgotten, so this only ever reacts to
 * fs.tree.request/fs.read.request, never opens anything on its own.
 */

const LOCAL_PROVIDER_NAMES = ["claude-code", "codex", "opencode"] as const;

async function readLocalToken(repositoryRoot: string, provider: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(repositoryRoot, ".oathlock", "agents", provider, "local.json"), "utf8");
    const parsed = JSON.parse(raw) as { token?: string };
    return typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : null;
  } catch {
    return null;
  }
}

async function anyConnectedProviderToken(repositoryRoot: string): Promise<string | null> {
  for (const provider of LOCAL_PROVIDER_NAMES) {
    const token = await readLocalToken(repositoryRoot, provider);
    if (token) return token;
  }
  return null;
}

function websocketUrl(value: string): string {
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  return value;
}

interface WhoamiResponse {
  workspaceId?: string;
  connectionId?: string;
}

interface ConversationListResponse {
  conversations?: Array<{ id?: string }>;
}

export interface OwnerFsRuntimeOptions {
  repositoryRoot: string;
  appUrl?: string;
  relayPublicUrl?: string;
  onLog?: (message: string) => void;
  discoveryIntervalMs?: number;
}

/** Started once per machine. Resolves quietly (does nothing) if no provider is connected yet, same posture as owner-pty-runtime.ts. */
export async function startOwnerFsRuntime(options: OwnerFsRuntimeOptions): Promise<void> {
  const appUrl = (options.appUrl ?? process.env.OATHLOCK_API_URL ?? "https://m9r-dashboard.onrender.com").replace(/\/+$/, "");
  const relayPublicUrl = options.relayPublicUrl ?? process.env.MISSION_RELAY_PUBLIC_URL?.trim() ?? "https://m9r-mission-relay.onrender.com";
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 15_000;
  const log = options.onLog ?? ((message: string) => console.log(`[owner-fs] ${message}`));

  let token: string | null = null;
  let connectionId: string | null = null;
  let workspaceId: string | null = null;
  let relayClient: MissionRelayClient | null = null;
  const host = new FsTreeHost(options.repositoryRoot);
  const subscribedChannels = new Set<string>();

  async function ensureIdentity(): Promise<boolean> {
    if (connectionId && workspaceId && relayClient) return true;
    const nextToken = await anyConnectedProviderToken(options.repositoryRoot);
    if (!nextToken) return false;
    token = nextToken;
    try {
      const res = await fetch(`${appUrl}/api/agent/whoami`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as WhoamiResponse | null;
      if (!body?.connectionId || !body.workspaceId) {
        log("this machine's connections have no resolvable identity yet -- retrying later.");
        return false;
      }
      connectionId = body.connectionId;
      workspaceId = body.workspaceId;
    } catch {
      return false;
    }
    if (!relayClient) {
      relayClient = new MissionRelayClient({
        url: websocketUrl(relayPublicUrl),
        workspaceId,
        credential: token,
        onFrame: (frame) => { void handleFrame(frame); },
      });
    }
    return true;
  }

  async function handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.type === "fs.tree.request" && frame.channelId) {
      const payload = parseFsTreeRequestPayload(frame.payload);
    // Broadcast-and-self-filter, the same pattern used by terminal requests:
      // relay has no durable concept of "this machine" to address directly.
      if (!payload || payload.connectionId !== connectionId) return;
      const result = await host.listTree(payload.path);
      if ("error" in result) {
        await sendError(frame.channelId, payload.requestId, result.error, "Could not list that directory.");
        return;
      }
      await relayClient!.sendFsFrame({ channelId: frame.channelId, type: "fs.tree", payload: { ...result, requestId: payload.requestId } });
      return;
    }
    if (frame.type === "fs.read.request" && frame.channelId) {
      const payload = parseFsReadRequestPayload(frame.payload);
      if (!payload || payload.connectionId !== connectionId) return;
      const result = await host.readFileChunks(payload.path);
      if ("error" in result) {
        await sendError(frame.channelId, payload.requestId, result.error, "Could not read that file.");
        return;
      }
      for (const chunk of result) {
        await relayClient!.sendFsFrame({ channelId: frame.channelId, type: "fs.content.chunk", payload: { ...chunk, requestId: payload.requestId } });
      }
    }
  }

  async function sendError(channelId: string, requestId: string, reason: "not_found" | "too_large" | "not_a_file" | "outside_workspace" | "read_failed", message: string): Promise<void> {
    try {
      await relayClient!.sendFsFrame({ channelId, type: "fs.error", payload: { requestId, reason, message } });
    } catch (error) {
      log(`could not report fs error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function discoverAndSubscribe(): Promise<void> {
    if (!(await ensureIdentity()) || !token || !relayClient) return;
    let conversations: Array<{ id?: string }> = [];
    try {
      const res = await fetch(`${appUrl}/api/agent/conversations`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as ConversationListResponse | null;
      conversations = body?.conversations ?? [];
    } catch {
      return;
    }
    for (const conversation of conversations) {
      const id = conversation.id;
      if (typeof id !== "string" || subscribedChannels.has(id)) continue;
      subscribedChannels.add(id);
      await relayClient.subscribeWorkspace(id).catch(() => { subscribedChannels.delete(id); });
    }
  }

  await discoverAndSubscribe();
  setInterval(() => { void discoverAndSubscribe(); }, discoveryIntervalMs).unref();
}
