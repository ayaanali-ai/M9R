import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = resolve(repositoryRoot, "extensions/browser/newtab.html");
const scriptPath = resolve(repositoryRoot, "extensions/browser/src/newtab.js");

async function readPageFiles() {
  const [html, css, script] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(resolve(repositoryRoot, "extensions/browser/newtab.css"), "utf8"),
    readFile(scriptPath, "utf8"),
  ]);
  return { html, css, script };
}

function createPageHarness(searchApi, savedProvider) {
  const elements = new Map();
  const navigations = [];
  const stored = [];

  class ElementHarness {
    listeners = new Map();
    value = "";
    hidden = true;
    textContent = "";
    focused = false;

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    focus() {
      this.focused = true;
    }

    async dispatch(type, event = {}) {
      const listener = this.listeners.get(type);
      assert.ok(listener, `expected a ${type} listener`);
      await listener({ preventDefault() {}, ...event });
    }
  }

  for (const selector of ["#search-form", "#search-input", "#search-status", "#search-provider"]) {
    elements.set(selector, new ElementHarness());
  }
  elements.get("#search-provider").value = "browser";

  vm.runInNewContext(
    readFileSync(scriptPath, "utf8"),
    {
      chrome: {
        search: searchApi,
        storage: { local: {
          get: async () => ({ m9rSearchProvider: savedProvider }),
          set: async (value) => stored.push(value),
        } },
      },
      document: { querySelector: (selector) => elements.get(selector) ?? null },
      location: { assign: (url) => navigations.push(url) },
    },
    { filename: scriptPath },
  );

  return {
    form: elements.get("#search-form"),
    input: elements.get("#search-input"),
    status: elements.get("#search-status"),
    provider: elements.get("#search-provider"),
    navigations,
    stored,
  };
}

test("New Tab is an accessible, offline M9R search surface using the supplied assets", async () => {
  const { html, css } = await readPageFiles();

  assert.match(html, /<html\s+lang="en"/i);
  assert.match(html, /<main\b/i);
  assert.match(html, /<form\b[^>]*\brole="search"/i);
  assert.match(html, /<label\b[^>]*\bfor="search-input"/i);
  assert.match(html, /<input\b[^>]*\bid="search-input"[^>]*\btype="search"/i);
  assert.match(html, /Search the web/);
  assert.doesNotMatch(html, /enter a web address/i, "the default-provider search field must not promise URL navigation it does not perform");
  assert.match(html, /<button\b[^>]*\btype="submit"/i);
  assert.match(html, /<select\b[^>]*\bid="search-provider"/i);
  assert.match(html, /<option\b[^>]*\bvalue="google"/i);
  assert.match(html, /<option\b[^>]*\bvalue="browser"[^>]*selected/i);
  assert.match(html, /id="search-status"[^>]*role="status"[^>]*aria-live="polite"/i);
  assert.match(html, /assets\/m9r-mark\.jpg/);
  assert.match(html, /<link\b[^>]*\brel="icon"[^>]*\bhref="assets\/m9r-mark\.jpg"/i);
  assert.match(css, /assets\/m9r-newtab-background\.jpg/);
  assert.match(html, /href="newtab\.css"/);
  assert.match(html, /src="src\/newtab\.js"/);
  assert.match(html, /M9R/i);
  assert.doesNotMatch(html, /page-footer|topbar-note|Your next tab/i);
  assert.doesNotMatch(css, /#9ae2d3|#a6f3e2/i, "the old green accent must be gone");

  for (const [name, content] of Object.entries({ html, css })) {
    assert.doesNotMatch(content, /https?:\/\//i, `${name} must not make external requests`);
  }
});

test("New Tab boots the same room-presence overlay as ordinary pages", async () => {
  const { html } = await readPageFiles();
  const expected = [
    "src/presence-logic.js",
    "src/dock-logic.js",
    "src/presence-overlay.js",
    "src/content.js",
  ];
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [...expected, "src/newtab.js"]);
  const bridge = await readFile(resolve(repositoryRoot, "extensions/browser/src/pill-bridge.js"), "utf8");
  assert.match(bridge, /sender\.url === chrome\.runtime\.getURL\("newtab\.html"\)/);
});

test("the untouched New Tab respects Chrome's default provider", async () => {
  const calls = [];
  const page = createPageHarness({ query: async (request) => calls.push(request) });
  page.input.value = "  M9R shared browser work  ";

  await page.form.dispatch("submit");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "M9R shared browser work");
  assert.deepEqual(page.navigations, []);
  assert.equal(page.status.hidden, true);
});

test("explicitly selecting Google sends a URL encoded query to Google", async () => {
  const page = createPageHarness();
  page.provider.value = "google";
  await page.provider.dispatch("change");
  page.input.value = "  M9R shared browser work  ";
  await page.form.dispatch("submit");
  assert.deepEqual(page.navigations, ["https://www.google.com/search?q=M9R%20shared%20browser%20work"]);
});

test("provider dropdown persists a choice and rejects unknown providers", async () => {
  const fallbackCalls = [];
  const page = createPageHarness({ query: async (request) => fallbackCalls.push(request) });
  page.provider.value = "duckduckgo";
  await page.provider.dispatch("change");
  page.input.value = "agent rooms & cursors";
  await page.form.dispatch("submit");

  assert.equal(page.stored.length, 1);
  assert.equal(page.stored[0].m9rSearchProvider, "duckduckgo");
  assert.deepEqual(page.navigations, ["https://duckduckgo.com/?q=agent%20rooms%20%26%20cursors"]);
  page.provider.value = "https://attacker.example";
  await page.form.dispatch("submit");
  assert.equal(page.navigations.length, 1);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].text, "agent rooms & cursors");
});

test("a stored provider is restored, but cannot overwrite a fresh owner selection", async () => {
  const restored = createPageHarness(undefined, "bing");
  await Promise.resolve();
  assert.equal(restored.provider.value, "bing");

  const changed = createPageHarness(undefined, "bing");
  changed.provider.value = "duckduckgo";
  await changed.provider.dispatch("change");
  await Promise.resolve();
  assert.equal(changed.provider.value, "duckduckgo");
});

test("browser default option submits trimmed text through Chrome's selected provider", async () => {
  const calls = [];
  const page = createPageHarness({
    query: async (request) => calls.push(request),
  });
  page.provider.value = "browser";
  page.input.value = "  M9R shared browser work  ";

  await page.form.dispatch("submit");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "M9R shared browser work");
  assert.equal(page.status.hidden, true);
});

test("an unavailable Chrome search API keeps the query and announces the address-bar fallback", async () => {
  const page = createPageHarness(undefined);
  page.provider.value = "browser";
  page.input.value = "research agent presence";

  await page.form.dispatch("submit");

  assert.equal(page.status.hidden, false);
  assert.match(page.status.textContent, /address bar/i);
  assert.equal(page.input.value, "research agent presence");
  assert.equal(page.input.focused, true);
});

test("a failed default-provider request announces the same local fallback", async () => {
  const page = createPageHarness({
    query: async () => {
      throw new Error("permission unavailable");
    },
  });
  page.provider.value = "browser";
  page.input.value = "shared workspaces";

  await page.form.dispatch("submit");

  assert.equal(page.status.hidden, false);
  assert.match(page.status.textContent, /address bar/i);
  assert.equal(page.input.value, "shared workspaces");
  assert.equal(page.input.focused, true);
});
