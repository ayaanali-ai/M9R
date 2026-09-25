/**
 * Starts the local web broker the M9R browser extension connects to. Spike entry point: run with
 * `npx tsx scripts/m9r-web-broker.ts`. The fixed development extension ID is allow-listed; M9R_WEB_BROKER_PORT
 * overrides the port. This entry point never enables arbitrary extension origins.
 */
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { writeWebActivity } from "@/lib/native/feed-writer";
import { apiKeyLaunchBlock } from "@/lib/native/vendor-launch-core";
import { createWebLiveSessions, loadAgentsConfig } from "@/lib/native/web-live-sessions";
import { createWebUiBridge } from "@/lib/native/web-ui-bridge";
import { DEFAULT_BROKER_PORT, brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";
import { WEB_EXTENSION_ID } from "@/lib/native/web-setup-core";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const homeIndex = args.indexOf("--home");
  if (homeIndex >= 0 && args[homeIndex + 1]) process.env.M9R_HOME = args[homeIndex + 1];
  const portIndex = args.indexOf("--port");
  if (portIndex >= 0 && args[portIndex + 1]) process.env.M9R_WEB_BROKER_PORT = args[portIndex + 1];
  const root = defaultStoreRoot(homedir(), process.env);
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const ownerId = process.env.M9R_OWNER_ID?.trim() || "local-machine";
  const authorityStore = createWebAuthorityStore(root);
  const authority = createWebAuthority({ ownerId });
  authority.restore(authorityStore.load());
  const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
  // The in-page pill: agents the owner types to, one live session per agent and folder (web-live-sessions.ts).
  const ui = createWebUiBridge();
  const broker = await startWebBroker({ key, port, allowedExtensionIds: [WEB_EXTENSION_ID], ownerId, authority, authorityStore, ui, loopGuard: { repeat: 3, budget: 120, windowMs: 10 * 60_000 } });
  const config = loadAgentsConfig(root, { cwd: process.cwd() });
  const sessions = createWebLiveSessions({
    agents: config.agents, storeRoot: root, repoRoot: process.cwd(), brokerPort: broker.port,
    store: createLocalStore(root), onEvent: (event) => ui.onSessionEvent(event),
  });
  ui.attachSessions(sessions);
  process.stdout.write(`M9R web broker listening on 127.0.0.1:${broker.port}\n`);
  process.stdout.write(`Agents (${config.source === "default" ? "defaults; add agents.json to your M9R folder to change" : config.source}): ${config.agents.map((a) => `@${a.handle} (${a.provider}, ${a.folder})`).join(", ")}\n`);
  for (const problem of config.problems) process.stdout.write(`  note: ${problem}\n`);
  const blocked = apiKeyLaunchBlock(process.env, false);
  if (blocked) process.stdout.write(`  warning: agents will not start. ${blocked}\n`);
  // feed.json's web[] for the desktop pill: written next to feed.json, merged in by the feed writer.
  let lastWeb = "";
  const webTimer = setInterval(() => {
    const body = JSON.stringify(ui.recentWeb());
    if (body === lastWeb) return;
    lastWeb = body;
    try { writeWebActivity(root, ui.recentWeb()); } catch { /* the pill feed is optional */ }
  }, 1000);
  const stop = () => { clearInterval(webTimer); sessions.close(); ui.close(); void broker.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// A single failed background write must not take the owner's broker down in the middle of a demo.
process.on("uncaughtException", (error) => { process.stderr.write(`M9R web broker: recovered from an unexpected error: ${error instanceof Error ? error.message : String(error)}
`); });
process.on("unhandledRejection", (error) => { process.stderr.write(`M9R web broker: recovered from an unhandled rejection: ${error instanceof Error ? error.message : String(error)}
`); });

main().catch((error) => {
  process.stderr.write(`M9R web broker failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
