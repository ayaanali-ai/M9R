const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const pageActions = readFileSync(require("node:path").join(__dirname, "../extensions/browser/src/page-actions.js"), "utf8");

function assertPageResult(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

async function assertPageResultAsync(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(await actual)), expected);
}

class FakeElement {
  constructor() {
    this.tagName = "BUTTON";
    this.children = [];
    this.attributes = {};
    this.innerText = "visible page text";
    this.textContent = "visible page text";
    this.isContentEditable = false;
    this.autocomplete = "";
    this.disabled = false;
    this.display = "block";
    this.visibility = "visible";
    this.clicked = false;
    this.focused = false;
    this.scrolled = false;
    this.dispatched = [];
    this.rect = { left: 10, top: 20, width: 100, height: 30 };
  }
  scrollIntoView() { this.scrolled = true; }
  focus() { this.focused = true; }
  click() { this.clicked = true; }
  dispatchEvent(event) { this.dispatched.push(event); return true; }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return [this.rect]; }
  contains(target) { return target === this || target?.parentElement === this; }
  getAttribute(name) { return name === "autocomplete" ? this.autocomplete : this.attributes[name] ?? null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
}

class FakeInput extends FakeElement {
  constructor() { super(); this.tagName = "INPUT"; this.type = "text"; this._value = "input value"; }
  get value() { return this._value; }
  set value(value) { this._value = value; }
}

class FakeTextArea extends FakeElement {
  constructor() { super(); this.tagName = "TEXTAREA"; this._value = "textarea value"; }
  get value() { return this._value; }
  set value(value) { this._value = value; }
}

function createPage({ origin = "https://allowed.example", pathname = "/cart", element = new FakeElement(), hitTarget, onScroll, onFocus, refMap } = {}) {
  const body = new FakeElement();
  body.tagName = "BODY";
  body.children = [element];
  body.innerText = body.textContent = "body text";
  const target = hitTarget === undefined ? element : hitTarget;
  const queriedSelectors = [];
  let snapshotNonce = 0;
  const window = {
    __m9rPageActionRefMap: refMap,
    innerWidth: 1024,
    innerHeight: 768,
    crypto: { getRandomValues: (bytes) => { bytes.fill(++snapshotNonce); return bytes; } },
  };
  const context = {
    document: {
      body,
      title: "Test page",
      defaultView: { getComputedStyle: (node) => ({ display: node.display, visibility: node.visibility, opacity: "1" }) },
      querySelector: (selector) => { queriedSelectors.push(selector); return selector === "#target" ? element : null; },
      querySelectorAll: () => [element],
      elementFromPoint: () => target,
    },
    window,
    location: { origin, pathname },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    getComputedStyle: (node) => ({ display: node.display, visibility: node.visibility }),
    Event: class FakeEvent {
      constructor(type, init) { this.type = type; this.init = init; }
    },
    InputEvent: class FakeInputEvent {
      constructor(type, init) { this.type = type; this.init = init; }
    },
    KeyboardEvent: class FakeKeyboardEvent {
      constructor(type, init) { this.type = type; this.init = init; }
    },
    setTimeout,
    Date,
    Math,
  };
  element.ownerDocument = context.document;
  body.ownerDocument = context.document;
  if (onScroll) element.scrollIntoView = () => { element.scrolled = true; onScroll(context); };
  if (onFocus) element.focus = () => { element.focused = true; onFocus(context); };
  runInNewContext(pageActions, context);
  context.element = element;
  context.queriedSelectors = queriedSelectors;
  return context;
}

test("reads ordinary text and input values; types into textareas", async () => {
  const inputPage = createPage({ element: new FakeInput() });
  await assertPageResultAsync(inputPage.m9rPageRead("#target"), { ok: true, data: "input value" });

  const textareaPage = createPage({ element: new FakeTextArea() });
  await assertPageResultAsync(textareaPage.m9rPageRead("#target"), { ok: true, data: "textarea value" });
  await assertPageResultAsync(textareaPage.m9rPageType("#target", "updated note"), { ok: true, data: { typed: 12 } });
  assert.equal(textareaPage.element.value, "updated note");
});

test("refuses hidden, password, and sensitive-autocomplete inputs", async () => {
  const cases = [
    { type: "hidden" }, { type: "password" }, { autocomplete: "cc-number" },
    { autocomplete: "one-time-code" }, { autocomplete: "current-password" }, { autocomplete: "new-password" },
  ];
  for (const values of cases) {
    const page = createPage({ element: Object.assign(new FakeInput(), values) });
    await assertPageResultAsync(page.m9rPageRead("#target"), { ok: false, error: "sensitive fields are off limits" });
    await assertPageResultAsync(page.m9rPageType("#target", "new value"), { ok: false, error: "sensitive fields are off limits" });
    assert.equal(page.element.value, "input value");
  }
});

test("checks origin and path before click or typing mutations", async () => {
  const wrongOrigin = createPage({ origin: "https://attacker.example", element: new FakeInput() });
  assertPageResult(wrongOrigin.m9rPageClick("#target", "https://allowed.example"), { ok: false, error: "page origin does not match the granted site" });
  await assertPageResultAsync(wrongOrigin.m9rPageType("#target", "changed", "https://allowed.example"), { ok: false, error: "page origin does not match the granted site" });
  assert.equal(wrongOrigin.element.clicked, false);
  assert.equal(wrongOrigin.element.value, "input value");
  assert.equal(wrongOrigin.element.scrolled, false);
  assert.equal(wrongOrigin.element.focused, false);

  const wrongPath = createPage({ pathname: "/account", element: new FakeInput() });
  assertPageResult(wrongPath.m9rPageClick("#target", "https://allowed.example", "/cart"), { ok: false, error: "page path does not match the granted path" });
  await assertPageResultAsync(wrongPath.m9rPageType("#target", "changed", "https://allowed.example", "/cart"), { ok: false, error: "page path does not match the granted path" });
  assert.equal(wrongPath.element.clicked, false);
  assert.equal(wrongPath.element.value, "input value");
  assert.equal(wrongPath.element.scrolled, false);
  assert.equal(wrongPath.element.focused, false);
});

test("rechecks page origin after scrolling and focusing and before typing", async () => {
  for (const stage of ["scroll", "focus"]) {
    const element = new FakeInput();
    const changeOrigin = (page) => { page.location.origin = "https://attacker.example"; };
    const page = createPage({ element, ...(stage === "scroll" ? { onScroll: changeOrigin } : { onFocus: changeOrigin }) });
    await assertPageResultAsync(page.m9rPageType("#target", "changed", "https://allowed.example"), { ok: false, error: "page origin does not match the granted site" });
    assert.equal(element.value, "input value");
  }
});

test("click only activates a visible, enabled, unobscured element", () => {
  const disabled = createPage();
  disabled.element.disabled = true;
  assertPageResult(disabled.m9rPageClick("#target"), { ok: false, error: "element is disabled" });

  const hidden = createPage();
  hidden.element.visibility = "hidden";
  assertPageResult(hidden.m9rPageClick("#target"), { ok: false, error: "element is not visible" });

  const zeroArea = createPage();
  zeroArea.element.rect.width = 0;
  assertPageResult(zeroArea.m9rPageClick("#target"), { ok: false, error: "element has no visible area" });

  const covered = createPage({ element: new FakeElement(), hitTarget: new FakeElement() });
  assertPageResult(covered.m9rPageClick("#target"), { ok: false, error: "element is obscured" });
  assert.equal(covered.element.clicked, false);

  const visible = createPage();
  assertPageResult(visible.m9rPageClick("#target"), { ok: true, data: { clicked: true } });
  assert.equal(visible.element.clicked, true);
});

test("trusted click planning returns a bounded visible point without dispatching a DOM click", () => {
  const page = createPage();
  const plan = page.m9rPageClickPlan("#target", "https://allowed.example", "/cart", null, null, "left", 1);
  assert.equal(plan.ok, true);
  assert.equal(plan.data.viewportWidth, 1024);
  assert.equal(plan.data.viewportHeight, 768);
  assert.ok(plan.data.x >= 10 && plan.data.x <= 110);
  assert.ok(plan.data.y >= 20 && plan.data.y <= 50);
  assert.equal(page.element.clicked, false);
  assert.deepEqual(page.element.dispatched, []);
});

test("trusted click planning refuses bad grants, hidden, disabled, obscured, and out-of-viewport targets", () => {
  const wrongOrigin = createPage({ origin: "https://attacker.example" });
  assertPageResult(wrongOrigin.m9rPageClickPlan("#target", "https://allowed.example", "/cart", null, null, "left", 1), { ok: false, error: "page origin or path does not match the granted site" });
  const wrongPath = createPage({ pathname: "/account" });
  assertPageResult(wrongPath.m9rPageClickPlan("#target", "https://allowed.example", "/cart", null, null, "left", 1), { ok: false, error: "page origin or path does not match the granted site" });
  const disabled = createPage();
  disabled.element.disabled = true;
  assertPageResult(disabled.m9rPageClickPlan("#target", null, null, null, null, "left", 1), { ok: false, error: "element is disabled" });
  const hidden = createPage();
  hidden.element.visibility = "hidden";
  assertPageResult(hidden.m9rPageClickPlan("#target", null, null, null, null, "left", 1), { ok: false, error: "element is not visible" });
  const covered = createPage({ hitTarget: new FakeElement() });
  assertPageResult(covered.m9rPageClickPlan("#target", null, null, null, null, "left", 1), { ok: false, error: "element is obscured" });
  const outside = createPage();
  assertPageResult(outside.m9rPageClickPlan(null, null, null, 1024, 10, "left", 1), { ok: false, error: "click point is outside the visible page" });
});

test("trusted click planning samples actual inline fragments instead of empty space in their union rectangle", () => {
  const inline = new FakeElement();
  inline.rect = { left: 10, top: 20, right: 110, bottom: 50, width: 100, height: 30 };
  inline.getClientRects = () => [
    { left: 10, top: 20, right: 30, bottom: 50, width: 20, height: 30 },
    { left: 90, top: 20, right: 110, bottom: 50, width: 20, height: 30 },
  ];
  const page = createPage({ element: inline });
  page.document.elementFromPoint = (x, y) => (y >= 20 && y <= 50 && (x >= 10 && x <= 30 || x >= 90 && x <= 110)) ? inline : new FakeElement();

  const plan = page.m9rPageClickPlan("#target", null, null, null, null, "left", 1);
  assert.equal(plan.ok, true);
  assert.ok(plan.data.x >= 10 && plan.data.x <= 30 || plan.data.x >= 90 && plan.data.x <= 110);
  assert.equal(page.element.clicked, false);
});

test("rechecks page origin after scrolling and immediately before clicking", () => {
  const element = new FakeElement();
  const page = createPage({ element, onScroll: (context) => { context.location.origin = "https://attacker.example"; } });
  assertPageResult(page.m9rPageClick("#target", "https://allowed.example"), { ok: false, error: "page origin does not match the granted site" });
  assert.equal(element.clicked, false);
});

test("resolves exact @m9r-ref markers from the stored ref map for read, click, and type", async () => {
  const input = new FakeInput();
  const marker = "@m9r-ref:e0123456789abcdef01234567_12";
  const page = createPage({ element: input, refMap: new Map([["e0123456789abcdef01234567_12", input]]) });

  await assertPageResultAsync(page.m9rPageRead(marker), { ok: true, data: "input value" });
  assertPageResult(page.m9rPageClick(marker), { ok: true, data: { clicked: true } });
  await assertPageResultAsync(page.m9rPageType(marker, "via ref"), { ok: true, data: { typed: 7 } });
  assert.equal(input.value, "via ref");
  assert.deepEqual(page.queriedSelectors, []);
});

test("rejects missing or malformed ref markers without passing them to querySelector", async () => {
  const page = createPage({ element: new FakeInput(), refMap: {} });
  for (const marker of ["@m9r-ref:e0123456789abcdef01234567_12", "@m9r-ref:bad id"]) {
    await assertPageResultAsync(page.m9rPageRead(marker), { ok: false, error: "invalid page element ref" });
  }
  assert.deepEqual(page.queriedSelectors, []);
});

test("continues to pass ordinary CSS selectors to querySelector", async () => {
  const page = createPage({ element: new FakeInput() });
  await assertPageResultAsync(page.m9rPageRead("#target"), { ok: true, data: "input value" });
  assert.deepEqual(page.queriedSelectors, ["#target"]);
});

test("snapshot returns interactive refs and viewport rectangles and refreshes the ref map", () => {
  const button = new FakeElement();
  button.attributes["aria-label"] = "Search now";
  const page = createPage({ element: button });
  const result = page.m9rPageSnapshot("search", 150);
  assert.equal(result.ok, true);
  assert.equal(result.data.elements.length, 1);
  assert.match(result.data.elements[0].ref, /^e[a-f0-9]{24}_\d{1,3}$/);
  assert.equal(result.data.elements[0].name, "Search now");
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.elements[0].rect)), { x: 10, y: 20, width: 100, height: 30 });
  assertPageResult(page.m9rPageClick("@m9r-ref:" + result.data.elements[0].ref), { ok: true, data: { clicked: true } });
  assert.equal(page.m9rPageSnapshot("not-present", 150).data.elements.length, 0);
});

test("snapshot traverses open shadow roots and same-origin frames, caps results, and never returns field values", () => {
  const topButton = new FakeElement();
  topButton.tagName = "BUTTON";
  topButton.attributes["aria-label"] = "Top action";
  const shadowButton = new FakeElement();
  shadowButton.attributes["aria-label"] = "Shadow action";
  const frameButton = new FakeElement();
  frameButton.attributes["aria-label"] = "Frame action";
  const secret = new FakeInput();
  secret.type = "password";
  secret.value = "planted-not-for-snapshot";
  const page = createPage({ element: topButton });
  const shadowHost = new FakeElement();
  shadowHost.tagName = "DIV";
  shadowHost.shadowRoot = { children: [shadowButton] };
  const frameDoc = { children: [frameButton, secret], body: { children: [frameButton, secret], innerText: "frame text", textContent: "frame text" }, defaultView: page.document.defaultView, elementFromPoint: () => frameButton };
  const frame = new FakeElement();
  frame.tagName = "IFRAME";
  frame.contentDocument = frameDoc;
  frame.rect = { left: 200, top: 100, width: 300, height: 200 };
  frameButton.ownerDocument = frameDoc;
  secret.ownerDocument = frameDoc;
  frameDoc.defaultView.frameElement = frame;
  page.document.body.children = [topButton, shadowHost, frame];
  const result = page.m9rPageSnapshot(undefined, 2);
  assert.equal(result.ok, true);
  assert.equal(result.data.elements.length, 2, "respects the caller's cap");
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.elements.map((item) => item.name))), ["Top action", "Shadow action"]);
  assert.ok(!JSON.stringify(result).includes("planted-not-for-snapshot"));
  const all = page.m9rPageSnapshot(undefined, 150);
  assert.deepEqual(JSON.parse(JSON.stringify(all.data.elements.map((item) => item.name))), ["Top action", "Shadow action", "Frame action"]);
  assert.deepEqual(JSON.parse(JSON.stringify(all.data.elements[2].rect)), { x: 210, y: 120, width: 100, height: 30 });
  assertPageResult(page.m9rPageClick("@m9r-ref:" + all.data.elements[2].ref), { ok: true, data: { clicked: true } });
});

test("page power target returns the action rectangle, find and extract are structured and bounded", async () => {
  const button = new FakeElement();
  button.attributes["aria-label"] = "Search";
  const page = createPage({ element: button });
  const target = await page.m9rPagePower("target", "#target", {}, "https://allowed.example", "/cart");
  assert.equal(target.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(target.data.rect)), { x: 10, y: 20, width: 100, height: 30 });
  const found = await page.m9rPagePower("find", undefined, { query: "visible page" });
  assert.equal(found.ok, true);
  assert.ok(found.data.matches.length >= 1);

  const cells = ["A", "B"].map((value) => Object.assign(new FakeElement(), { innerText: value, textContent: value }));
  const row = { querySelectorAll: (selector) => selector === "th,td" ? cells : [], children: cells };
  const table = new FakeElement();
  table.tagName = "TABLE";
  table.querySelectorAll = (selector) => selector === "tr" ? [row] : [];
  page.document.querySelector = () => table;
  const extracted = await page.m9rPagePower("extract", "#target", { maxRows: 1 });
  assert.equal(extracted.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(extracted.data.rows)), [["A", "B"]]);
});

test("click dispatches page mouse events and type uses insertText with an input event when available", async () => {
  const input = new FakeInput();
  const page = createPage({ element: input });
  page.MouseEvent = class FakeMouseEvent {
    constructor(type, init) { this.type = type; this.init = init; }
  };
  const commands = [];
  page.document.execCommand = (command, _showUi, value) => {
    commands.push([command, value]);
    if (command === "insertText") {
      input.value = value;
      input.dispatchEvent({ type: "input", inputType: "insertText", data: value });
    }
    return command === "insertText";
  };
  assertPageResult(page.m9rPageClick("#target"), { ok: true, data: { clicked: true } });
  assert.ok(input.dispatched.some((event) => event.type === "mousedown"));
  assert.ok(input.dispatched.some((event) => event.type === "mouseup"));
  await assertPageResultAsync(page.m9rPageType("#target", "inserted"), { ok: true, data: { typed: 8 } });
  assert.deepEqual(commands.at(-1), ["insertText", "inserted"]);
  assert.ok(input.dispatched.some((event) => event.type === "input"));
});

test("live typing keeps a long value bounded instead of animating every character", async () => {
  const input = new FakeInput();
  const page = createPage({ element: input });
  const value = "x".repeat(600);
  const started = Date.now();
  const result = await page.m9rPageType("#target", value, undefined, undefined, true);
  assertPageResult(result, { ok: true, data: { typed: 600 } });
  assert.equal(input.value, value);
  assert.ok(Date.now() - started < 2500, "long typing should not block the agent turn for several seconds");
});
