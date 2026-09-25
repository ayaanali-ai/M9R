import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../extensions/browser/src/permission-logic.js", import.meta.url), "utf8");

function logic() {
  const window: Record<string, unknown> = {};
  runInNewContext(source, { window, URL });
  return window.M9RPermissionLogic as {
    permissionPattern: (value: string) => string | null;
    mayActOnUrl: (url: string, expectedOrigin: string | null, grants: string[], pathPrefix?: string) => boolean;
    normalizeApprovedGrant: (value: unknown) => { grantId: string; origin: string; pathPrefix: string; actions: string[] } | null;
  };
}

test("site permission patterns are origin-only, canonical, and refuse unsafe schemes", () => {
  const api = logic();
  assert.equal(api.permissionPattern("https://shop.example/cart?session=private"), "https://shop.example/*");
  assert.equal(api.permissionPattern("http://localhost:3000/path"), "http://localhost:3000/*");
  assert.equal(api.permissionPattern("javascript:alert(1)"), null);
  assert.equal(api.permissionPattern("https://user:pass@shop.example/"), null);
});

test("browser actions require the exact granted site and enforce the narrower path scope", () => {
  const api = logic();
  const grants = ["https://shop.example/*"];
  assert.equal(api.mayActOnUrl("https://shop.example/cart/123", "https://shop.example", grants, "/cart"), true);
  assert.equal(api.mayActOnUrl("https://shop.example/account", "https://shop.example", grants, "/cart"), false);
  assert.equal(api.mayActOnUrl("https://shop.example/cartoon", "https://shop.example", grants, "/cart"), false);
  assert.equal(api.mayActOnUrl("https://evil.example/cart", "https://shop.example", grants, "/cart"), false);
  assert.equal(api.mayActOnUrl("https://shop.example/cart", "https://shop.example", [], "/cart"), false);
});

test("approved grant messages are normalized before constructing the consent request", () => {
  const api = logic();
  assert.deepEqual(JSON.parse(JSON.stringify(api.normalizeApprovedGrant({
    grantId: "grant-1", origin: "https://shop.example/cart", pathPrefix: "/cart", actions: ["read", "click", "unknown"],
  }))), { grantId: "grant-1", origin: "https://shop.example", pathPrefix: "/cart", actions: ["read", "click"] });
  assert.equal(api.normalizeApprovedGrant({ grantId: "", origin: "file:///secret" }), null);
});
