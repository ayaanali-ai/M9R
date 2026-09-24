import assert from "node:assert/strict";
import test from "node:test";
import { generateBench } from "./bench/bench-data";
import { ROLES, buildPrompt, rolesFor } from "./bench/prompts";
import { CONDITIONS } from "./bench/strategies";

const base = "http://127.0.0.1:9999";
const prompt = (task: "trip" | "search", condition: (typeof CONDITIONS)[number], role: "a1" | "a2" | "a3") =>
  buildPrompt({ task, condition, role, token: `tok-${role}`, baseUrl: base });

test("no prompt contains the answer, and every prompt carries its own token and the site address", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const data = generateBench(seed);
    const secrets = [...Object.values(data.trip.truth), data.search.truth.item, data.search.targetCode];
    for (const task of ["trip", "search"] as const) {
      for (const condition of CONDITIONS) {
        for (const role of rolesFor(condition)) {
          const text = prompt(task, condition, role);
          for (const secret of secrets) assert.ok(!text.includes(secret), `${task}/${condition}/${role} leaks ${secret}`);
          assert.ok(text.includes(`tok-${role}`), `${task}/${condition}/${role} has its token`);
          assert.ok(text.includes(base), `${task}/${condition}/${role} has the site address`);
        }
      }
    }
  }
});

test("solo runs one agent and the team conditions run three", () => {
  assert.deepEqual([...rolesFor("solo")], ["a1"]);
  assert.deepEqual([...rolesFor("parallel")], [...ROLES]);
  assert.deepEqual([...rolesFor("coordinated")], [...ROLES]);
});

test("the solo prompt never mentions teammates or messaging", () => {
  for (const task of ["trip", "search"] as const) {
    const text = prompt(task, "solo", "a1");
    assert.ok(!/m9r_send|m9r_inbox|teammate/.test(text), task);
  }
});

test("parallel agents are told to stay silent until they finish; coordinated agents are told to share at once", () => {
  for (const task of ["trip", "search"] as const) {
    for (const role of ROLES) {
      assert.match(prompt(task, "parallel", role), /do not message anyone|Do not message anyone|before you say anything|say anything to anyone/i, `${task}/parallel/${role}`);
      assert.ok(!/waitSeconds 0/.test(prompt(task, "parallel", role)), `${task}/parallel/${role} does not poll mid-task`);
    }
    for (const role of ["a2", "a3"] as const) {
      assert.match(prompt(task, "coordinated", role), /waitSeconds 0/, `${task}/coordinated/${role} checks for teammates' findings while working`);
    }
  }
});

test("only a1 submits in the team conditions, and workers are told not to", () => {
  for (const task of ["trip", "search"] as const) {
    for (const condition of ["parallel", "coordinated"] as const) {
      assert.match(prompt(task, condition, "a1"), /To submit:/);
      for (const role of ["a2", "a3"] as const) assert.ok(!/To submit:/.test(prompt(task, condition, role)), `${task}/${condition}/${role}`);
    }
  }
});

test("search agents are pointed at their own list page", () => {
  assert.ok(prompt("search", "coordinated", "a1").includes("/search/list-1"));
  assert.ok(prompt("search", "parallel", "a2").includes("your share is product list 2"));
  assert.ok(prompt("search", "parallel", "a3").includes("your share is product list 3"));
});
