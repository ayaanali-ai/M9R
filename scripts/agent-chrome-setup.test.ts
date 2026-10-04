import assert from "node:assert/strict";
import test from "node:test";
import { agentChromeOwnerSetupArgs } from "../src/lib/native/agent-chrome";

test("owner sign-in setup uses the isolated profile without an automation endpoint", () => {
  const args = agentChromeOwnerSetupArgs("C:\\Users\\owner\\.m9r\\agent-chrome\\chrome-profile");

  assert.deepEqual(args, [
    "--user-data-dir=C:\\Users\\owner\\.m9r\\agent-chrome\\chrome-profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ]);
  assert.equal(args.some((arg) => arg.startsWith("--remote-debugging-")), false);
  assert.equal(args.includes("--enable-automation"), false);
  assert.equal(args.includes("--disable-blink-features=AutomationControlled"), false);
});
