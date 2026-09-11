/**
 * Dev-only terminal host.
 *
 * Runs the same MissionPtyRuntime + MissionRelayClient path the Bridge now
 * uses (see ensureTerminalPane in bridge-runtime.ts), just without booting ACP
 * sessions -- so a terminal pane can be exercised end to end without starting
 * real agents.
 *
 *   npx tsx --env-file=.env.local scripts/pty-host-dev.ts <workspaceId> <channelId>
 */
import { mintMissionRelayToken } from "../src/lib/mission/mission-relay-token.ts";
import { MissionRelayClient } from "../src/lib/mission/mission-relay-client.ts";
import { MissionPtyRuntime, WorkspaceRoomReadiness, createNodePtySpawner } from "../src/lib/mission/mission-pty-runtime.ts";

const [workspaceId, channelId, connectionId] = process.argv.slice(2);
if (!workspaceId || !channelId || !connectionId) {
  // The Relay resolves a bridge principal to a real agent_connections row and
  // requires it to be a member of the channel, so a made-up subject is
  // rejected at subscribe time. Pass the connection this machine already owns.
  console.error("Usage: pty-host-dev.ts <workspaceId> <channelId> <agentConnectionId>");
  process.exit(1);
}

async function main(): Promise<void> {
  const relayUrl = (process.env.MISSION_RELAY_PUBLIC_URL ?? "ws://127.0.0.1:8787").replace(/^http/, "ws");
  const credential = mintMissionRelayToken({ subject: connectionId, kind: "bridge", workspaceId, ttlSeconds: 3600 });

  let runtime: MissionPtyRuntime | null = null;
  const readiness = new WorkspaceRoomReadiness();
  const relayClient = new MissionRelayClient({
    url: relayUrl,
    workspaceId,
    credential,
    onFrame: (frame) => {
      readiness.observe(frame);
      // A rejected terminal frame is the failure mode worth seeing here --
      // silently ignoring relay.error makes a refused pty.open look like a
      // pane that simply never appeared.
      if (frame.type === "relay.error") console.error("[relay.error]", JSON.stringify(frame.payload));
      if (frame.type.startsWith("pty.")) runtime?.handleFrame(frame);
    },
  });

  runtime = new MissionPtyRuntime({
    spawn: await createNodePtySpawner(),
    transport: relayClient,
    onError: (error) => console.warn(`[terminal] ${error.message}`),
  });

  await relayClient.connect();
  // The host must be subscribed to the room before the Relay will accept its
  // terminal frames -- same rule that stops a non-member reaching a shell.
  await relayClient.subscribeWorkspace(channelId, null);
  // subscribeWorkspace resolves once the frame is written, not once the Relay
  // has registered the subscription -- announcing before it lands is refused.
  await readiness.wait(channelId);

  const sessionId = await runtime.open({ channelId, cols: 80, rows: 24, title: "dev terminal" });
  console.log(`Terminal session ${sessionId} is live in channel ${channelId}.`);
  console.log("Open /dev/terminal in the app, enter the same workspace and channel ids, and connect.");

  const shutdown = () => { runtime?.closeAll(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
