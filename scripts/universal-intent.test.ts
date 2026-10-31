import assert from "node:assert/strict";
import test from "node:test";
import { resolveUniversalIntent } from "../src/lib/native/universal-intent-resolver";

test("screen questions bind the live desktop and preserve no-submit/no-advance boundaries", () => {
  const intent = resolveUniversalIntent("Look at my screen, answer the question, but do not submit or advance.");
  assert.equal(intent.surface, "desktop");
  assert.equal(intent.action, "observe");
  assert.equal(intent.mode, "explain");
  assert.deepEqual(intent.constraints, { allowAdvance: false, allowSubmit: false });
  assert.deepEqual(intent.preferredObservation, "desktop");
  assert.deepEqual(intent.plan.map((step) => step.kind), ["bind-foreground", "observe-structure"]);
  assert.equal(intent.fallbackPolicy.currentForegroundFirst, true);
  assert.equal(intent.fallbackPolicy.screenshotFallback, true);
});

test("browser requests select an exact existing tab before structure and visual fallback", () => {
  const intent = resolveUniversalIntent("Use the Google Search tab and choose the answer in the dropdown.", {
    targetKind: "browser-tab",
    title: "Google Search",
    url: "https://www.google.com/search?q=m9r",
  });
  assert.equal(intent.surface, "browser");
  assert.equal(intent.action, "answer_in_place");
  assert.equal(intent.preferredObservation, "browser-tab");
  assert.deepEqual(intent.plan.map((step) => step.kind), [
    "bind-foreground", "browser-tab-select", "observe-structure", "semantic-target", "reobserve", "coordinate-fallback", "verify",
  ]);
});

test("system-control intents cover the supported Windows control families", () => {
  const cases = [
    ["increase display brightness", "display_brightness", "increase"],
    ["lower output audio", "output_audio", "decrease"],
    ["mute my microphone", "microphone", "mute"],
    ["pause media", "media", "play_pause"],
  ] as const;
  for (const [text, control, action] of cases) {
    const intent = resolveUniversalIntent(text);
    assert.equal(intent.surface, "system");
    assert.equal(intent.action, "system_control");
    assert.equal(intent.entities.systemControl, control);
    assert.equal(intent.entities.systemAction, action);
    assert.ok(intent.plan.some((step) => step.kind === "verify"));
  }
});

test("form preparation remains bounded when the user explicitly says not to advance or submit", () => {
  const intent = resolveUniversalIntent("Fill this form, answer the current item, do not advance, and do not submit.", {
    targetKind: "app-window",
    title: "Course discussion",
  });
  assert.equal(intent.surface, "app");
  assert.equal(intent.action, "answer_in_place");
  assert.equal(intent.mode, "prepare");
  assert.equal(intent.constraints.allowAdvance, false);
  assert.equal(intent.constraints.allowSubmit, false);
  assert.ok(intent.plan.some((step) => step.kind === "semantic-target"));
  assert.ok(intent.plan.some((step) => step.kind === "reobserve"));
  assert.ok(intent.plan.some((step) => step.kind === "verify"));
});

test("scroll intents select a live surface and require a fresh post-scroll observation", () => {
  const intent = resolveUniversalIntent("Scroll down until I can see the next section on the current page.", {
    targetKind: "browser-tab",
    title: "Current page",
    url: "https://example.test/",
  });
  assert.equal(intent.surface, "browser");
  assert.equal(intent.action, "scroll");
  assert.equal(intent.preferredObservation, "browser-tab");
  assert.deepEqual(intent.plan.map((step) => step.kind), [
    "bind-foreground", "browser-tab-select", "observe-structure", "semantic-target", "reobserve", "coordinate-fallback", "verify",
  ]);
});

