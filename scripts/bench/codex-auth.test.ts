import assert from "node:assert/strict";
import test from "node:test";
import { codexLoginStatusIsAuthenticated } from "./codex-auth-core";

test("Codex preflight requires a successful explicit logged-in status", () => {
  assert.equal(codexLoginStatusIsAuthenticated(0, "Logged in using ChatGPT"), true);
  assert.equal(codexLoginStatusIsAuthenticated(0, "Not logged in"), false);
  assert.equal(codexLoginStatusIsAuthenticated(0, ""), false);
  assert.equal(codexLoginStatusIsAuthenticated(1, "Logged in using ChatGPT"), false);
});
