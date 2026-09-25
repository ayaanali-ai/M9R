import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const pageActions = readFileSync(new URL("../extensions/browser/src/page-actions.js", import.meta.url), "utf8");

function assertPageResult(actual: unknown, expected: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

class FakeElement {
  innerText = "visible page text";
  textContent = "visible page text";
  isContentEditable = false;
  autocomplete = "";
  disabled = false;
  display = "block";
  visibility = "visible";
  clicked = false;
  focused = false;
  scrolled = false;
  dispatched: unknown[] = [];
  rect = { left: 10, top: 20, width: 100, height: 30 };

  scrollIntoView() { this.scrolled = true; }
  focus() { this.focused = true; }
  click() { this.clicked = true; }
  dispatchEvent(event: unknown) { this.dispatched.push(event); return true; }
  getBoundingClientRect() { return this.rect; }
  contains(target: unknown) { return target === this || (target as { parentElement?: unknown } | null)?.parentElement === this; }
  getAttribute(name: string) { return name === "autocomplete" ? this.autocomplete : null; }
}

class FakeInput extends FakeElement {
  type = "text";
  _value = "input value";
  get value() { return this._value; }
  set value(value: string) { this._value = value; }
}

class FakeTextArea extends FakeElement {
  _value = "textarea value";
  get value() { return this._value; }
  set value(value: string) { this._value = value; }
}

interface PageHarness {
  m9rPageRead: (selector: string | null, expectOrigin?: string | null, expectPathPrefix?: string | null) => unknown;
  m9rPageClick: (selector: string, expectOrigin?: string | null, expectPathPrefix?: string | null) => unknown;
  m9rPageType: (selector: string, value: string, expectOrigin?: string | null, expectPathPrefix?: string | null) => unknown;
  element: FakeElement;
}

function createPage(options: { origin?: string; pathname?: string; element?: FakeElement; hitTarget?: unknown } = {}): PageHarness {
  const element = options.element ?? new FakeElement();
  const body = new FakeElement();
  body.innerText = "body text";
  body.textContent = "body text";
  const hitTarget = options.hitTarget === undefined ? element : options.hitTarget;
  const context = {
    element,
    document: {
      body,
      querySelector: (selector: string) => selector === "#target" ? element : null,
      elementFromPoint: () => hitTarget,
    },
    location: { origin: options.origin ?? "https://allowed.example", pathname: options.pathname ?? "/cart" },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    getComputedStyle: (target: FakeElement) => ({ display: target.display, visibility: target.visibility }),
    Event: class FakeEvent {
      type: string;
      init?: unknown;
      constructor(type: string, init?: unknown) { this.type = type; this.init = init; }
    },
  };
  runInNewContext(pageActions, context);
  return context as unknown as PageHarness;
}

test("page actions refuse when the page origin changed after broker authorization", () => {
  const page = createPage({ origin: "https://attacker.example", element: new FakeInput() });
  const expected = "https://allowed.example";
  assertPageResult(page.m9rPageRead("#target", expected), { ok: false, error: "page origin does not match the granted site" });
  assertPageResult(page.m9rPageClick("#target", expected), { ok: false, error: "page origin does not match the granted site" });
  assertPageResult(page.m9rPageType("#target", "secret", expected), { ok: false, error: "page origin does not match the granted site" });
  assert.equal(page.element.clicked, false);
  assert.equal((page.element as FakeInput).value, "input value");
});

test("page actions refuse a path redirect immediately before reading, clicking, or typing", () => {
  const element = new FakeInput();
  const page = createPage({ pathname: "/account", element });
  assertPageResult(page.m9rPageRead("#target", "https://allowed.example", "/cart"), { ok: false, error: "page path does not match the granted path" });
  assertPageResult(page.m9rPageClick("#target", "https://allowed.example", "/cart"), { ok: false, error: "page path does not match the granted path" });
  assertPageResult(page.m9rPageType("#target", "sensitive text", "https://allowed.example", "/cart"), { ok: false, error: "page path does not match the granted path" });
  assert.equal(element.clicked, false);
  assert.equal(element.value, "input value");
});

test("page read and type refuse hidden, password, and sensitive-autocomplete inputs", async (t) => {
  const cases = [
    ["hidden input", { type: "hidden" }],
    ["password input", { type: "password" }],
    ["credit-card autocomplete", { autocomplete: "cc-number" }],
    ["one-time-code autocomplete", { autocomplete: "one-time-code" }],
    ["current-password autocomplete", { autocomplete: "current-password" }],
    ["new-password autocomplete", { autocomplete: "new-password" }],
  ] as const;

  for (const [name, values] of cases) {
    await t.test(name, () => {
      const page = createPage({ element: Object.assign(new FakeInput(), values) });
      assertPageResult(page.m9rPageRead("#target"), { ok: false, error: "sensitive fields are off limits" });
      assertPageResult(page.m9rPageType("#target", "new value"), { ok: false, error: "sensitive fields are off limits" });
    });
  }
});

test("visible text inputs can be read and textarea fields can be read and typed", () => {
  const inputPage = createPage({ element: new FakeInput() });
  assertPageResult(inputPage.m9rPageRead("#target"), { ok: true, data: "input value" });

  const textareaPage = createPage({ element: new FakeTextArea() });
  assertPageResult(textareaPage.m9rPageRead("#target"), { ok: true, data: "textarea value" });
  assertPageResult(textareaPage.m9rPageType("#target", "updated note"), { ok: true, data: { typed: 12 } });
  assert.equal((textareaPage.element as FakeTextArea & { value: string }).value, "updated note");

  const sensitiveTextarea = createPage({ element: Object.assign(new FakeTextArea(), { autocomplete: "one-time-code" }) });
  assertPageResult(sensitiveTextarea.m9rPageRead("#target"), { ok: false, error: "sensitive fields are off limits" });
  assertPageResult(sensitiveTextarea.m9rPageType("#target", "123456"), { ok: false, error: "sensitive fields are off limits" });
});

test("click refuses disabled controls", () => {
  const page = createPage();
  page.element.disabled = true;
  assertPageResult(page.m9rPageClick("#target"), { ok: false, error: "element is disabled" });
  assert.equal(page.element.clicked, false);
});

test("click refuses controls with display none", () => {
  const page = createPage();
  page.element.display = "none";
  assertPageResult(page.m9rPageClick("#target"), { ok: false, error: "element is not visible" });
  assert.equal(page.element.clicked, false);
});

test("click refuses controls with hidden visibility", () => {
  const page = createPage();
  page.element.visibility = "hidden";
  assertPageResult(page.m9rPageClick("#target"), { ok: false, error: "element is not visible" });
  assert.equal(page.element.clicked, false);
});

test("click refuses controls with no bounding area", () => {
  const page = createPage();
  page.element.rect = { left: 10, top: 20, width: 0, height: 30 };
  assertPageResult(page.m9rPageClick("#target"), { ok: false, error: "element has no visible area" });
  assert.equal(page.element.clicked, false);
});

test("click refuses controls covered at their center point", () => {
  const page = createPage({ element: new FakeInput(), hitTarget: new FakeElement() });
  assertPageResult(page.m9rPageClick("#target"), { ok: false, error: "element is obscured" });
  assert.equal(page.element.clicked, false);
});

test("click allows a visible, enabled control that owns its center point", () => {
  const page = createPage();
  assertPageResult(page.m9rPageClick("#target"), { ok: true, data: { clicked: true } });
  assert.equal(page.element.clicked, true);
});

test("click allows a hit-tested descendant of the target", () => {
  const child = new FakeElement();
  const target = new FakeElement();
  (child as FakeElement & { parentElement?: FakeElement }).parentElement = target;
  const page = createPage({ element: target, hitTarget: child });
  assertPageResult(page.m9rPageClick("#target"), { ok: true, data: { clicked: true } });
  assert.equal(page.element.clicked, true);
});
