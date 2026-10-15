import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentContext } from "./approval-core";
import { defaultStoreRoot } from "./local-store";
import { launchAgentChrome, launchAgentChromeOwnerSetup } from "./agent-chrome";
import { loadOrCreateBrokerKey, startWebBroker } from "./web-broker-server";
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
  if (action === "setup") {
    if (!process.stdin.isTTY || !process.stdout.isTTY || isAgentContext(process.env)) {
      throw new Error("Owner Chrome setup requires a person at a terminal; agents cannot sign in or change the dedicated profile.");
    }
    const setup = await launchAgentChromeOwnerSetup({ root });
    console.log(`Owner sign-in Chrome is open. Profile: ${setup.profile}`);
    console.log("Sign in normally in that window, then close the window when the session is saved. M9R does not read or copy credentials.");
    const result = await setup.done;
    if (result.code !== 0) {
      console.error(`Owner sign-in Chrome closed unexpectedly (exit ${result.code ?? "unknown"}).`);
      return 1;
    }
    console.log("Owner sign-in profile saved. Next run: m9r web chrome start");
    return 0;
  }
  if (action === "start") {
    const key = loadOrCreateBrokerKey(brokerKeyPath(root));
    const browser = await launchAgentChrome({ root, pageActionsSource: agentChromePageSource() });
    let server;
    try { server = await startWebBroker({ key, port, browserTransport: browser }); }
    catch (error) { await browser.close(); throw error; }
    console.log(`Agent Chrome ready on localhost:${server.port}. Profile: ${browser.profile}`);
    console.log("Sign in manually in this window. Agents can navigate to any HTTP(S) site; high-impact actions still follow the room approval policy.");
    console.log(`For agents using this channel: M9R_HOME=${root} M9R_WEB_BROKER_PORT=${server.port}`);
    await new Promise<void>((resolve) => {
      let closing = false;
      const stop = () => { if (closing) return; closing = true; void server.close().finally(resolve); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      browser.subscribe(() => undefined, stop);
    });
    return 0;
  }
  console.log("m9r web chrome setup | start");
  return action ? 1 : 0;
}
