import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../extensions/browser/src/retired-pages.js", import.meta.url), "utf8");

function load() {
  const context = { URL, Set, globalThis: {} };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.M9RRetiredPages;
}

test("the fast-path sync check still matches only M9R's removed new-tab page", () => {
  const retired = load();
  assert.equal(retired.isRetiredUrl("chrome-extension://m9r/newtab.html", "m9r"), true);
  assert.equal(retired.isRetiredUrl("chrome-extension://m9r/newtab.html?old=1", "m9r"), true);
  assert.equal(retired.isRetiredUrl("chrome-extension://m9r/permission.html", "m9r"), false);
  assert.equal(retired.isRetiredUrl("chrome-extension://other/newtab.html", "m9r"), false);
  assert.equal(retired.isRetiredUrl("https://example.com/newtab.html", "m9r"), false);
});

test("ownExtensionPath isolates this extension's own URLs from everything else", () => {
  const retired = load();
  assert.equal(retired.ownExtensionPath("chrome-extension://m9r/old-dock.html", "m9r"), "/old-dock.html");
  assert.equal(retired.ownExtensionPath("chrome-extension://other/old-dock.html", "m9r"), null);
  assert.equal(retired.ownExtensionPath("https://example.com/", "m9r"), null);
});

test("generic repair redirects any tab whose own-extension file is genuinely gone, by real existence, not a fixed filename list", async () => {
  const retired = load();
  const updates = [];
  const tabs = [
    { id: 1, url: "chrome-extension://m9r/newtab.html" },        // a previously-known retired page
    { id: 2, url: "https://example.com/" },                       // ordinary site: untouched
    { id: 3, url: "chrome-extension://other/newtab.html" },       // another extension: untouched
    { id: 4, url: "chrome-extension://m9r/permission.html" },     // this extension's real, still-shipping page
    { id: 5, url: "chrome-extension://m9r/old-codex-dock.html" }, // a page never hand-enumerated anywhere, but genuinely gone now
  ];
  const packaged = new Set(["/permission.html"]);
  const fetchImpl = async (url) => ({ ok: packaged.has(new URL(url).pathname) });
  const chromeApi = {
    runtime: { id: "m9r", getURL: (path) => `chrome-extension://m9r${path}` },
    tabs: {
      async query() { return tabs; },
      async update(id, changes) { updates.push({ id, changes }); },
    },
  };
  const count = await retired.repair(chromeApi, fetchImpl);
  assert.equal(count, 2);
  assert.equal(
    JSON.stringify(updates.sort((a, b) => a.id - b.id)),
    JSON.stringify([
      { id: 1, changes: { url: "chrome://newtab/" } },
      { id: 5, changes: { url: "chrome://newtab/" } },
    ]),
  );
});

test("repair does nothing without a usable extension id or fetch implementation", async () => {
  const retired = load();
  const chromeApi = { runtime: { id: "" }, tabs: { async query() { return []; }, async update() {} } };
  assert.equal(await retired.repair(chromeApi, async () => ({ ok: true })), 0);
  const chromeApi2 = { runtime: { id: "m9r" }, tabs: { async query() { return []; }, async update() {} } };
  assert.equal(await retired.repair(chromeApi2, undefined), 0);
});
