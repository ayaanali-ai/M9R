import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const pageActions = readFileSync(new URL("../extensions/browser/src/page-actions.js", import.meta.url), "utf8");

async function assertPageResult(actual: unknown, expected: unknown): Promise<void> {
  assert.deepEqual(JSON.parse(JSON.stringify(await actual)), expected);
}

class FakeElement {
  innerText = "visible page text";
  textContent = "visible page text";
  tagName = "BUTTON";
  id = "";
  children: FakeElement[] = [];
  isConnected = true;
  isContentEditable = false;
  autocomplete = "";
  disabled = false;
  display = "block";
  visibility = "visible";
  clicked = false;
  focused = false;
  scrolled = false;
  scrollOptions: ScrollIntoViewOptions | undefined;
  dispatched: unknown[] = [];
  rect = { left: 10, top: 20, width: 100, height: 30 };

  scrollIntoView(options?: ScrollIntoViewOptions) { this.scrolled = true; this.scrollOptions = options; }
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
  m9rPageSnapshot: (query?: string | null, limit?: number | null) => { ok: boolean; data: { elements: Array<{ ref: string; name: string }> } };
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
    setTimeout,
  };
  runInNewContext(pageActions, context);
  return context as unknown as PageHarness;
}

function createSnapshotPage(elements: FakeElement[]): PageHarness {
  const body = new FakeElement();
  body.tagName = "BODY";
  body.children = elements;
  let nonce = 0;
  const document = {
    body,
    title: "snapshot test",
    defaultView: null as unknown,
    querySelectorAll: () => [],
  };
  const context: Record<string, unknown> = {
    document,
    location: { href: "https://allowed.example/", origin: "https://allowed.example", pathname: "/" },
    crypto: { getRandomValues: (bytes: Uint8Array) => { bytes.fill(++nonce); return bytes; } },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    getComputedStyle: (target: FakeElement) => ({ display: target.display, visibility: target.visibility }),
    setTimeout,
  };
  context.window = context;
  context.top = context;
  context.parent = context;
  document.defaultView = context;
  runInNewContext(pageActions, context);
  return context as unknown as PageHarness;
}

test("page actions refuse when the page origin changed after broker authorization", async () => {
  const page = createPage({ origin: "https://attacker.example", element: new FakeInput() });
  const expected = "https://allowed.example";
  await assertPageResult(page.m9rPageRead("#target", expected), { ok: false, error: "page origin does not match the granted site" });
  assertPageResult(page.m9rPageClick("#target", expected), { ok: false, error: "page origin does not match the granted site" });
  assertPageResult(page.m9rPageType("#target", "secret", expected), { ok: false, error: "page origin does not match the granted site" });
  assert.equal(page.element.clicked, false);
  assert.equal((page.element as FakeInput).value, "input value");
});

test("page actions refuse a path redirect immediately before reading, clicking, or typing", async () => {
  const element = new FakeInput();
  const page = createPage({ pathname: "/account", element });
  await assertPageResult(page.m9rPageRead("#target", "https://allowed.example", "/cart"), { ok: false, error: "page path does not match the granted path" });
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
    await t.test(name, async () => {
      const page = createPage({ element: Object.assign(new FakeInput(), values) });
      await assertPageResult(page.m9rPageRead("#target"), { ok: false, error: "sensitive fields are off limits" });
      assertPageResult(page.m9rPageType("#target", "new value"), { ok: false, error: "sensitive fields are off limits" });
    });
  }
});

test("visible text inputs can be read and textarea fields can be read and typed", async () => {
  const inputPage = createPage({ element: new FakeInput() });
  await assertPageResult(inputPage.m9rPageRead("#target"), { ok: true, data: "input value" });

  const textareaPage = createPage({ element: new FakeTextArea() });
  await assertPageResult(textareaPage.m9rPageRead("#target"), { ok: true, data: "textarea value" });
  assertPageResult(textareaPage.m9rPageType("#target", "updated note"), { ok: true, data: { typed: 12 } });
  assert.equal((textareaPage.element as FakeTextArea & { value: string }).value, "updated note");

  const sensitiveTextarea = createPage({ element: Object.assign(new FakeTextArea(), { autocomplete: "one-time-code" }) });
  await assertPageResult(sensitiveTextarea.m9rPageRead("#target"), { ok: false, error: "sensitive fields are off limits" });
  assertPageResult(sensitiveTextarea.m9rPageType("#target", "123456"), { ok: false, error: "sensitive fields are off limits" });
});

test("a snapshot ref keeps its original target after another snapshot on the shared page", async () => {
  const first = new FakeElement();
  first.innerText = "first target";
  first.textContent = first.innerText;
  const page = createSnapshotPage([first]);
  const firstSnapshot = page.m9rPageSnapshot();
  const firstRef = firstSnapshot.data.elements[0].ref;

  const second = new FakeElement();
  second.innerText = "second unrelated target";
  second.textContent = second.innerText;
  const refMap = (page as unknown as { __m9rPageActionRefMap: Map<string, FakeElement> }).__m9rPageActionRefMap;
  const nativeGet = Map.prototype.get;
  refMap.get = function (ref: string) {
    return ref === firstRef ? second : nativeGet.call(this, ref);
  };
  ((page as unknown as { document: { body: FakeElement } }).document.body).children = [second];
  const secondSnapshot = page.m9rPageSnapshot();

  await assertPageResult(page.m9rPageRead(`@m9r-ref:${firstRef}`), { ok: true, data: "first target" });
  assert.notEqual(firstRef, secondSnapshot.data.elements[0].ref, "refs from separate snapshots must not collide");
  await assertPageResult(page.m9rPageRead(`@m9r-ref:${secondSnapshot.data.elements[0].ref}`), { ok: true, data: "second unrelated target" });
});

test("a target that is not rendered yet (a virtualized feed catching up) is retried instead of failing at once", async () => {
  const element = new FakeElement();
  let calls = 0;
  const context = {
    document: { body: new FakeElement(), querySelector: (selector: string) => { calls += 1; return selector === "#target" && calls >= 3 ? element : null; } },
    location: { origin: "https://allowed.example", pathname: "/cart" },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    setTimeout,
  };
  runInNewContext(pageActions, context);
  const start = Date.now();
  const result = await (context as unknown as PageHarness).m9rPageRead("#target");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, data: "visible page text" });
  assert.equal(calls, 3, "the first two misses must be retried, not failed immediately");
  assert.ok(Date.now() - start < 1000, "the retry window must stay well under a second");
});

test("a selector that will never match still fails, bounded, instead of retrying forever", async () => {
  const context = {
    document: { body: new FakeElement(), querySelector: () => null },
    location: { origin: "https://allowed.example", pathname: "/cart" },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    setTimeout,
  };
  runInNewContext(pageActions, context);
  const start = Date.now();
  const result = await (context as unknown as PageHarness).m9rPageRead("#missing");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, error: "no element matches #missing" });
  assert.ok(Date.now() - start < 1000, "a truly missing element must still fail in well under a second");
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

test("native click planning uses an instant centered scroll before capturing coordinates", () => {
  const element = new FakeElement();
  const context = {
    window: { innerWidth: 1280, innerHeight: 720 },
    document: {
      querySelector: (selector: string) => selector === "#target" ? element : null,
      elementFromPoint: () => element,
    },
    location: { origin: "https://allowed.example", pathname: "/cart" },
    getComputedStyle: (target: FakeElement) => ({ display: target.display, visibility: target.visibility }),
  };
  runInNewContext(pageActions, context);
  const plan = (context as unknown as {
    m9rPageClickPlan: (...args: unknown[]) => { ok: boolean };
  }).m9rPageClickPlan("#target", null, null, null, null, "left", 1, "click");

  assert.equal(plan.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(element.scrollOptions)), {
    behavior: "instant",
    block: "center",
    inline: "center",
  });
});

test("click allows a hit-tested descendant of the target", () => {
  const child = new FakeElement();
  const target = new FakeElement();
  (child as FakeElement & { parentElement?: FakeElement }).parentElement = target;
  const page = createPage({ element: target, hitTarget: child });
  assertPageResult(page.m9rPageClick("#target"), { ok: true, data: { clicked: true } });
  assert.equal(page.element.clicked, true);
});
