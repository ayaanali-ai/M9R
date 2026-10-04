import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { isAgentContext } from "./approval-core";
import { defaultStoreRoot } from "./local-store";
import { agentChromePaths, approvedSite, changeApprovedSite, launchAgentChrome, readApprovedSites } from "./agent-chrome";
import { loadOrCreateBrokerKey, startWebBroker, tightenKeyFileAcl } from "./web-broker-server";
import { brokerKeyPath } from "./web-broker-paths";

export function agentChromePageSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = [join(here, "extension/src/page-actions.js"), join(here, "../../../extensions/browser/src/page-actions.js")].find(existsSync);
  if (!source) throw new Error("The M9R browser action engine is missing; reinstall M9R.");
  return readFileSync(source, "utf8");
}

/** Separate opt-in broker/profile; never changes the ordinary extension's settings. */
export async function runAgentChromeCli(args: string[]): Promise<number> {
  const root = join(defaultStoreRoot(homedir(), process.env), "agent-chrome");
  const port = 47822;
  const action = args[0];
  if (action === "approve" || action === "revoke") {
    if (!process.stdin.isTTY || !process.stdout.isTTY || isAgentContext(process.env)) throw new Error("Site permissions require the owner at a terminal; agents cannot grant themselves access.");
    const origin = approvedSite(args[1] ?? "");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question(`${action === "approve" ? "Allow agents to read and control" : "Remove agent access to"} ${origin}? Type ${action.toUpperCase()}: `);
      if (answer.trim() !== action.toUpperCase()) return 1;
      changeApprovedSite(root, origin, action === "approve");
      // The transport may read site permissions; the sandbox must not be able to rewrite them.
      tightenKeyFileAcl(agentChromePaths(root).sites);
      console.log(`${action === "approve" ? "Approved" : "Revoked"}: ${origin}`);
      return 0;
    } finally { terminal.close(); }
  }
  if (action === "sites") { console.log(readApprovedSites(root).join("\n") || "No sites approved."); return 0; }
  if (action === "start") {
    const key = loadOrCreateBrokerKey(brokerKeyPath(root));
    const browser = await launchAgentChrome({ root, pageActionsSource: agentChromePageSource() });
    let server;
    try { server = await startWebBroker({ key, port, browserTransport: browser }); }
    catch (error) { await browser.close(); throw error; }
    console.log(`Agent Chrome ready on localhost:${server.port}. Profile: ${browser.profile}`);
    console.log("Sign in manually in this window. Approve each site with: m9r web chrome approve <site-url>");
    console.log(`For agents using this channel: M9R_HOME=${root} M9R_WEB_BROKER_PORT=${server.port}`);
    await new Promise<void>((resolve) => {
      let closing = false;
      const stop = () => { if (closing) return; closing = true; void server.close().finally(resolve); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      browser.subscribe(() => undefined, stop);
    });
    return 0;
  }
  console.log("m9r web chrome start | approve <site-url> | revoke <site-url> | sites");
  return action ? 1 : 0;
}
