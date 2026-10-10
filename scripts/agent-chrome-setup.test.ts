import assert from "node:assert/strict";
import test from "node:test";
import { agentChromeOwnerSetupArgs, validateAgentChromeUrl } from "../src/lib/native/agent-chrome";

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

test("the owner's Agent Chrome accepts any valid HTTP(S) site without a site catalog", () => {
  assert.equal(validateAgentChromeUrl("https://arbitrary.example/path?q=1"), "https://arbitrary.example");
  assert.equal(validateAgentChromeUrl("http://localhost:4317/"), "http://localhost:4317");
  assert.throws(() => validateAgentChromeUrl("file:///C:/Windows/win.ini"), /HTTP\(S\)/);
  assert.throws(() => validateAgentChromeUrl("https://user:secret@example.com/"), /without credentials/);
});

test("explicit cross-owner origin and path grants remain enforced", () => {
  assert.equal(validateAgentChromeUrl("https://shop.example/cart/items", {
    expectOrigin: "https://shop.example", expectPathPrefix: "/cart",
  }), "https://shop.example");
  assert.throws(() => validateAgentChromeUrl("https://other.example/cart", { expectOrigin: "https://shop.example" }), /granted site/);
  assert.throws(() => validateAgentChromeUrl("https://shop.example/account", { expectPathPrefix: "/cart" }), /granted path/);
});
