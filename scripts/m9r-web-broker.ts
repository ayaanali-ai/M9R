/**
 * Starts the local web broker the M9R browser extension connects to. Spike entry point: run with
 * `npx tsx scripts/m9r-web-broker.ts`. M9R_WEB_BROKER_PORT overrides the port; M9R_EXTENSION_IDS (comma separated)
 * restricts which extension may connect. M9R_ALLOW_ANY_EXTENSION=1 opts into any extension for local development
 * only, and is ignored when an extension allow-list is configured.
 */
import { homedir } from "node:os";
import { defaultStoreRoot } from "@/lib/native/local-store";
import { DEFAULT_BROKER_PORT, brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";

async function main(): Promise<void> {
  const root = defaultStoreRoot(homedir(), process.env);
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const ownerId = process.env.M9R_OWNER_ID?.trim() || "local-machine";
  const authorityStore = createWebAuthorityStore(root);
  const authority = createWebAuthority({ ownerId });
  authority.restore(authorityStore.load());
  const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
  const allowedExtensionIds = (process.env.M9R_EXTENSION_IDS ?? "").split(",").map((id) => id.trim());
  const allowAnyExtension = process.env.M9R_ALLOW_ANY_EXTENSION === "1";
  const broker = await startWebBroker({ key, port, allowedExtensionIds, allowAnyExtension, ownerId, authority, authorityStore });
  process.stdout.write(`M9R web broker listening on 127.0.0.1:${broker.port}\n`);
  if (allowedExtensionIds.filter(Boolean).length === 0) {
    process.stdout.write(allowAnyExtension
      ? "Warning: M9R_ALLOW_ANY_EXTENSION=1 permits any browser extension; use only for local development.\n"
      : "No extension ID is allow-listed; /ext connections will be refused. Set M9R_EXTENSION_IDS or explicitly opt in to development access with M9R_ALLOW_ANY_EXTENSION=1.\n");
  }
  const stop = () => void broker.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  process.stderr.write(`M9R web broker failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
