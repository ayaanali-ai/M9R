/**
 * Starts the local web broker the M9R browser extension connects to. Spike entry point: run with
 * `npx tsx scripts/m9r-web-broker.ts`. The fixed development extension ID is allow-listed; M9R_WEB_BROKER_PORT
 * overrides the port. This entry point never enables arbitrary extension origins.
 */
import { homedir } from "node:os";
import { defaultStoreRoot } from "@/lib/native/local-store";
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
  const broker = await startWebBroker({ key, port, allowedExtensionIds: [WEB_EXTENSION_ID], ownerId, authority, authorityStore });
  process.stdout.write(`M9R web broker listening on 127.0.0.1:${broker.port}\n`);
  const stop = () => void broker.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  process.stderr.write(`M9R web broker failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
