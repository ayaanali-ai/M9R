import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../extensions/browser/src/powers.js", import.meta.url), "utf8");

class FakeElement {
  tagName = "INPUT";
  type = "search";
  disabled = false;
  isContentEditable = false;
  parentElement: FakeElement | null = null;
  form: { requestSubmit: () => void; submit?: () => void } | null = null;
  dispatchEvent(event: { type: string }) { this.onEvent?.(event); return true; }
  closest() { return null; }
  focus() {}
  onEvent?: (event: { type: string }) => void;
}

class FakeKeyboardEvent {
  readonly type: string;
  readonly init: Record<string, unknown>;
  constructor(type: string, init: Record<string, unknown>) { this.type = type; this.init = init; }
  get key() { return this.init.key; }
}

async function pressPage(onKey?: (event: FakeKeyboardEvent, page: { href: string; text: string }) => void) {
  const page = { href: "https://search.example/", text: "Search" };
  const body = { innerText: page.text, textContent: page.text };
  const input = new FakeElement();
  input.onEvent = (event) => {
    onKey?.(event as FakeKeyboardEvent, page);
    body.innerText = body.textContent = page.text;
  };
  const context: Record<string, unknown> = {
    document: { body, title: "Search", activeElement: input, querySelector: () => input },
    window: {},
    location: {
      origin: "https://search.example",
      pathname: "/",
      get href() { return page.href; },
      set href(value: string) { page.href = value; },
    },
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLTextAreaElement: class extends FakeElement {},
    HTMLButtonElement: class extends FakeElement {},
    HTMLAnchorElement: class extends FakeElement {},
    KeyboardEvent: FakeKeyboardEvent,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setTimeout,
    Math,
  };
  runInNewContext(source, context);
  const run = context.m9rPageMine as (...args: unknown[]) => Promise<{ ok: boolean; data?: Record<string, unknown> }>;
  return run("press", null, { key: "Enter" }, "https://search.example", "/");
}

async function pressWithModifier(key: string) {
  const page = { href: "https://search.example/", text: "Checkout" };
  const submitted: string[] = [];
  const observed: Array<Record<string, unknown>> = [];
  const form = { requestSubmit: () => submitted.push("requestSubmit"), submit: () => submitted.push("submit") };
  const input = new FakeElement();
  input.form = form;
  input.onEvent = (event) => {
    const keyboardEvent = event as FakeKeyboardEvent;
    if (keyboardEvent.type === "keydown") observed.push(keyboardEvent.init);
  };
  const context: Record<string, unknown> = {
    document: { body: { innerText: page.text, textContent: page.text }, title: "Checkout", activeElement: input, querySelector: () => input },
    window: {},
    location: { origin: "https://search.example", pathname: "/checkout", href: page.href },
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLTextAreaElement: class extends FakeElement {},
    HTMLButtonElement: class extends FakeElement {},
    HTMLAnchorElement: class extends FakeElement {},
    KeyboardEvent: FakeKeyboardEvent,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setTimeout,
    Math,
  };
  runInNewContext(source, context);
  const run = context.m9rPageMine as (...args: unknown[]) => Promise<{ ok: boolean; data?: Record<string, unknown> }>;
  const result = await run("press", null, { key }, "https://search.example", "/checkout");
  return { result, submitted, observed };
}

test("press reports a visible-content change caused by the key", async () => {
  const result = await pressPage((event, page) => {
    if (event.type === "keydown" && event.key === "Enter") page.text = "Search results";
  });
  assert.equal(result.ok, true);
  assert.equal(result.data?.pageChanged, true, JSON.stringify(result));
});

test("press reports URL changes and explains when neither URL nor visible content changes", async () => {
  const navigated = await pressPage((event, page) => {
    if (event.type === "keydown" && event.key === "Enter") page.href = "https://search.example/results";
  });
  assert.equal(navigated.data?.pageChanged, true, JSON.stringify(navigated));

  const unchanged = await pressPage();
  assert.equal(unchanged.data?.pageChanged, false);
  assert.match(String(unchanged.data?.hint), /Nothing visibly changed after Enter/);
});

test("press normalizes modifier and Enter names before dispatching a form submission", async () => {
  for (const [key, modifier] of [["Control+Enter", "ctrlKey"], ["Alt+Enter", "altKey"], ["control+enter", "ctrlKey"], ["ALT+Return", "altKey"]] as const) {
    const { result, submitted, observed } = await pressWithModifier(key);
    assert.equal(result.ok, true, key);
    assert.equal(observed[0]?.key, "Enter", key);
    assert.equal(observed[0]?.[modifier], true, key);
    assert.deepEqual(submitted, ["requestSubmit"], key);
  }
});
