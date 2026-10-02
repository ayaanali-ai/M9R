// Native node:test VM fixture intentionally uses CommonJS in this .js test module.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const source = readFileSync(join(__dirname, "../extensions/browser/src/quiet-input.js"), "utf8");

function slot() {
  const listeners = [];
  return { addListener: (l) => listeners.push(l), emit: (...a) => listeners.forEach((l) => l(...a)) };
}

function harness({ attachError, targets = [], idleMs = 50 } = {}) {
  const calls = [];
  const state = { dropNext: false };
  const timers = [];
  const onDetach = slot();
  const onRemoved = slot();
  const api = {
    runtime: { id: "ext-me" },
    tabs: { onRemoved },
    debugger: {
      onDetach,
      attach: async (target, version) => { calls.push(["attach", target.tabId, version]); if (attachError) throw new Error(attachError); },
      detach: async (target) => { calls.push(["detach", target.tabId]); },
      sendCommand: async (target, method, params) => {
        if (state.dropNext && method === "Input.dispatchMouseEvent") { state.dropNext = false; throw new Error("Debugger is not attached to the tab with id: " + target.tabId); }
        calls.push([method, target.tabId, params]);
        return {};
      },
      getTargets: async () => targets,
    },
  };
  const root = {};
  runInNewContext(source, { globalThis: root, setTimeout, clearTimeout, console }, { filename: "quiet-input.js" });
  const quiet = root.M9RQuietInput.create(api, {
    idleMs,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  });
  return { quiet, calls, timers, onDetach, onRemoved, root, state };
}
const names = (calls) => calls.map((c) => c[0]);

test("a click attaches, enables focus emulation, sends a full press sequence, and arms an idle detach", async () => {
  const { quiet, calls, timers } = harness();
  const result = await quiet.click(7, { x: 120, y: 80, button: "left", clickCount: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { route: "quiet", trusted: true });
  assert.deepEqual(names(calls), ["attach", "Emulation.setFocusEmulationEnabled", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
  assert.deepEqual(calls.filter((c) => c[0] === "Input.dispatchMouseEvent").map((c) => c[2].type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(timers.filter((t) => !t.cleared).length, 1, "one idle timer is armed");
  assert.equal(timers[0].ms, 50);
});

test("idle timer detaches; a second action while attached reuses the attachment and re-arms the timer", async () => {
  const { quiet, calls, timers } = harness();
  await quiet.click(7, { x: 1, y: 1 });
  await quiet.click(7, { x: 2, y: 2 });
  assert.equal(names(calls).filter((n) => n === "attach").length, 1, "attached once");
  assert.equal(timers[0].cleared, true, "the first idle timer was cleared by the second action");
  timers.find((t) => !t.cleared).fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(names(calls).at(-1), "detach");
});

test("double click sends two press/release pairs with clickCount 1 then 2; right click uses the right button", async () => {
  const { quiet, calls } = harness();
  await quiet.click(3, { x: 5, y: 5, clickCount: 2 });
  const presses = calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed");
  assert.deepEqual(presses.map((c) => c[2].clickCount), [1, 2]);
  await quiet.click(3, { x: 5, y: 5, button: "right" });
  const last = calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed").at(-1);
  assert.equal(last[2].button, "right");
  assert.equal(last[2].buttons, 2);
});

test("beforePress runs after attach and can veto the click, which sends no mouse event", async () => {
  const { quiet, calls } = harness();
  await assert.rejects(
    quiet.click(4, { x: 9, y: 9, beforePress: async () => { throw Object.assign(new Error("stopped"), { code: "stopped_by_owner" }); } }),
    (error) => error.code === "stopped_by_owner",
  );
  assert.equal(names(calls).includes("Input.dispatchMouseEvent"), false);
});

test("attach failures map to stable refusal codes and never fall back", async () => {
  for (const [message, code] of [["Another debugger is already attached to the tab", "devtools_open"], ["Cannot access a chrome:// URL", "restricted_page"], ["boom", "tab_not_attachable"]]) {
    const { quiet, calls } = harness({ attachError: message });
    await assert.rejects(quiet.click(1, { x: 1, y: 1 }), (error) => error.code === code);
    assert.equal(names(calls).includes("Input.dispatchMouseEvent"), false);
  }
});

test("the owner cancelling the debugging banner turns quiet input off for that tab until reset", async () => {
  const { quiet, calls, onDetach } = harness();
  await quiet.click(5, { x: 1, y: 1 });
  onDetach.emit({ tabId: 5 }, "canceled_by_user");
  await assert.rejects(quiet.click(5, { x: 1, y: 1 }), (error) => error.code === "debugger_cancelled");
  const attaches = names(calls).filter((n) => n === "attach").length;
  quiet.reset(5);
  await quiet.click(5, { x: 1, y: 1 });
  assert.equal(names(calls).filter((n) => n === "attach").length, attaches + 1);
});

test("only the allow-listed protocol methods can ever be sent", () => {
  const { root } = harness();
  assert.deepEqual([...root.M9RQuietInput.ALLOWED_METHODS].sort(), ["Emulation.setFocusEmulationEnabled", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.insertText"]);
});

test("invalid coordinates and text are refused before any attach", async () => {
  const { quiet, calls } = harness();
  await assert.rejects(quiet.click(1, { x: NaN, y: 1 }), (error) => error.code === "bad_coordinates");
  await assert.rejects(quiet.click(1, { x: -4, y: 1 }), (error) => error.code === "bad_coordinates");
  await assert.rejects(quiet.insertText(1, 42), (error) => error.code === "bad_text");
  assert.equal(calls.length, 0);
});

test("overlapping actions on one tab run one at a time, in order", async () => {
  const { quiet, calls } = harness();
  await Promise.all([quiet.click(8, { x: 1, y: 1 }), quiet.click(8, { x: 2, y: 2 })]);
  const moves = calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mouseMoved").map((c) => c[2].x);
  assert.deepEqual(moves, [1, 2]);
});

test("after a worker restart, adoptAndRelease detaches only this extension's own attachments", async () => {
  const { quiet, calls } = harness({ targets: [
    { tabId: 1, attached: true, extensionId: "ext-me" },
    { tabId: 2, attached: true, extensionId: "other" },
    { tabId: 3, attached: true },
    { tabId: 4, attached: false, extensionId: "ext-me" },
  ] });
  assert.equal(await quiet.adoptAndRelease(), 1);
  assert.deepEqual(calls, [["detach", 1]]);
});

test("a closed tab drops its session", async () => {
  const { quiet, onRemoved } = harness();
  await quiet.click(6, { x: 1, y: 1 });
  onRemoved.emit(6);
  assert.equal(quiet._sessions.has(6), false);
});

test("a stale attachment (dropped behind the worker's back) is re-attached once and the click still lands", async () => {
  const { quiet, calls, state, timers } = harness();
  await quiet.click(9, { x: 1, y: 1 });
  state.dropNext = true;
  const result = await quiet.click(9, { x: 2, y: 2 });
  assert.equal(result.route, "quiet");
  assert.equal(names(calls).filter((n) => n === "attach").length, 2, "attached again after the drop");
  assert.equal(calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mouseReleased" && c[2].x === 2).length, 1);
  const live = timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1, "exactly one idle timer is armed after the retry");
  live[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(names(calls).at(-1), "detach", "the idle timer still detaches after a retry");
});

test("a veto from beforePress is surfaced as is and is not retried", async () => {
  const { quiet, calls } = harness();
  let runs = 0;
  await assert.rejects(quiet.click(2, { x: 1, y: 1, beforePress: async () => { runs += 1; throw Object.assign(new Error("url changed"), { code: "url_changed" }); } }), (e) => e.code === "url_changed");
  assert.equal(runs, 1);
  assert.equal(names(calls).filter((n) => n === "attach").length, 1);
});
