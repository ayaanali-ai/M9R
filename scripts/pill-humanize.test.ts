import assert from "node:assert/strict";
import test from "node:test";
import { plainStep } from "../pill/src/core/humanize.ts";
import type { AgentTask } from "../pill/src/core/state.ts";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "T1",
    name: "Codex",
    provider: "codex",
    color: "#268be8",
    state: "working",
    runState: "working",
    stepIndex: 0,
    steps: [],
    ...overrides,
  };
}

test("pill progress removes first-person narration and keeps the useful action", () => {
  assert.equal(plainStep(task(), "I’m opening Calculator now."), "Opening Calculator now");
  assert.equal(plainStep(task(), "Now, I'll check the result."), "Checking the result");
});

test("pill progress hides internal tool and dispatch vocabulary", () => {
  assert.equal(plainStep(task(), "m9r_stage_action returned dispatchState=dispatched"), "On it");
  assert.equal(plainStep(task(), "The broker returned a provider-turn RPC timeout"), "On it");
});

test("pill progress replaces long or multi-paragraph narration with a concise state", () => {
  const paragraph = "I checked the page, then I opened the menu, then I retried the action and I am waiting for another provider response now.";
  assert.equal(plainStep(task(), paragraph), "On it");
  assert.equal(plainStep(task(), "First line\nSecond line"), "On it");
});

test("finished and approval states get useful fallback copy", () => {
  assert.equal(plainStep(task({ state: "finished", runState: "idle" }), undefined), "Finished what you asked");
  assert.equal(plainStep(task({ state: "approval", runState: "blocked" }), ""), "Waiting on your OK");
});
