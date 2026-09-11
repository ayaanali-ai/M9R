import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MissionRelayClient } from "./mission-relay-client";
import { MissionPtyRuntime, WorkspaceRoomReadiness, createNodePtySpawner } from "./mission-pty-runtime";
import type { RelayFrame } from "./mission-relay-protocol";

/**
 * Item #28 Part A: exactly one real, general-purpose shell per PERSON, not
 * one per connected agent provider.
 *
 * Before this, `ensureTerminalPane` lived inside bridge-runtime.ts, which
 * runs as a separate OS process per connected provider (claude-code, codex,
 * opencode each their own resident) -- so a person with all three connected
 * got three separate terminals auto-opened in the same channel, each
 * implicitly "belonging" to whichever provider's bridge happened to open
 * it. That is backwards from a real terminal: it should be the person's
 * own shell, with whatever CLI they choose running inside it, not a
 * provider-flavored artifact.
 *
 * This runs exactly once per machine (called once from the top-level
 * `m9r-cli terminal runtime` command, alongside -- not replacing -- that
 * command's other existing jobs), owns exactly one MissionPtyRuntime, and
 * never opens a pty on its own initiative. It only reacts to an explicit
 * "pty.requested" frame (sent by that person's own browser clicking "Open
 * my terminal here" -- see TerminalWorkspace.tsx), and only when the
 * request's requestedByUserId actually matches this machine's own owner --
 * the relay broadcasts that request to every subscriber of the room, since
 * it has no durable concept of "this specific person's one machine
 * process" to address directly, so self-filtering here is what keeps a
 * request meant for one person's machine from being acted on by anyone
 * else's.
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

/** Any one connected provider's token is good enough here, same posture
 * `anyConnectedProviderToken` in oathlock-terminal-bridge.ts already uses
 * for its own machine-level (not provider-specific) operations. */
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
  ownerUserId?: string | null;
}

interface ConversationListResponse {
  conversations?: Array<{ id?: string }>;
}

export interface OwnerPtyRuntimeOptions {
  repositoryRoot: string;
  /** Defaults to OATHLOCK_API_URL, same env var oathlock-terminal-bridge.ts already reads. */
  appUrl?: string;
  /** Defaults to MISSION_RELAY_PUBLIC_URL, same env var every bridge already reads. */
  relayPublicUrl?: string;
  onLog?: (message: string) => void;
  /** How often to re-poll the conversation list for newly-joined channels to subscribe to. */
  discoveryIntervalMs?: number;
}

/** Started once per machine. Resolves quietly (does nothing) if no provider
 * is connected yet -- a machine with no connected agent has no token to
 * authenticate a relay connection with, and that is not an error, just
 * nothing to do yet. Retries on the same discovery interval, so connecting
 * an agent later picks this up on its own without a restart. */
export async function startOwnerPtyRuntime(options: OwnerPtyRuntimeOptions): Promise<void> {
  const appUrl = (options.appUrl ?? process.env.OATHLOCK_API_URL ?? "https://m9r-dashboard.onrender.com").replace(/\/+$/, "");
  const relayPublicUrl = options.relayPublicUrl ?? process.env.MISSION_RELAY_PUBLIC_URL?.trim() ?? "https://m9r-mission-relay.onrender.com";
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 15_000;
  const log = options.onLog ?? ((message: string) => console.log(`[owner-terminal] ${message}`));

  let token: string | null = null;
  let ownerUserId: string | null = null;
  let workspaceId: string | null = null;
  let relayClient: MissionRelayClient | null = null;
  let ptyRuntime: MissionPtyRuntime | null = null;
  const roomReadiness = new WorkspaceRoomReadiness();
  const subscribedChannels = new Set<string>();
  const openChannels = new Set<string>();

  async function ensureIdentity(): Promise<boolean> {
    if (ownerUserId && workspaceId && relayClient) return true;
    const nextToken = await anyConnectedProviderToken(options.repositoryRoot);
    if (!nextToken) return false;
    token = nextToken;
    try {
      const res = await fetch(`${appUrl}/api/agent/whoami`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as WhoamiResponse | null;
      if (!body?.ownerUserId || !body.workspaceId) {
        log("this machine's connections have no resolvable owner yet -- retrying later.");
        return false;
      }
      ownerUserId = body.ownerUserId;
      workspaceId = body.workspaceId;
    } catch {
      return false;
    }
    if (!relayClient) {
      relayClient = new MissionRelayClient({
        url: websocketUrl(relayPublicUrl),
        workspaceId,
        credential: token,
        onFrame: (frame) => { roomReadiness.observe(frame); void handleFrame(frame); },
      });
    }
    return true;
  }

  async function handleFrame(frame: RelayFrame): Promise<void> {
    if (frame.type.startsWith("pty.")) {
      ptyRuntime?.handleFrame(frame);
    }
    if (frame.type === "pty.requested" && frame.channelId) {
      const payload = frame.payload as { requestedByUserId?: unknown } | undefined;
      if (typeof payload?.requestedByUserId !== "string" || payload.requestedByUserId !== ownerUserId) return; // Not this machine's request.
      await openTerminalIn(frame.channelId);
    }
  }

  async function openTerminalIn(channelId: string): Promise<void> {
    if (openChannels.has(channelId) || !relayClient) return;
    openChannels.add(channelId);
    try {
      await roomReadiness.wait(channelId);
      if (!ptyRuntime) {
        ptyRuntime = new MissionPtyRuntime({
          spawn: await createNodePtySpawner(),
          transport: relayClient,
          onError: (error) => log(`terminal error: ${error.message}`),
        });
      }
      // A real, general-purpose login shell -- no title implying a specific
      // provider "owns" this pane, since it never does anymore. Whoever
      // types `claude`, `codex`, or anything else into it is what actually
      // ends up running here, same as a normal terminal.
      await ptyRuntime.open({ channelId, cols: 80, rows: 24, title: "Terminal" });
    } catch (error) {
      openChannels.delete(channelId);
      log(`could not open the requested terminal in ${channelId}: ${error instanceof Error ? error.message : String(error)}`);
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
      // Subscribing is enough to be able to receive pty.requested and to
      // relay an eventual pty.open announcement -- unlike the old per-
      // provider ensureTerminalPane, this never opens anything on its own.
      await relayClient.subscribeWorkspace(id).catch(() => { subscribedChannels.delete(id); });
    }
  }

  await discoverAndSubscribe();
  setInterval(() => { void discoverAndSubscribe(); }, discoveryIntervalMs).unref();
}
