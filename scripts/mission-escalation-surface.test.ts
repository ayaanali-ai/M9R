import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync("src/lib/mission/mission-application-service.ts", "utf8");
const handler = readFileSync("src/lib/mission/mission-command-handler.ts", "utf8");
const presenter = readFileSync("src/lib/mission/mission-ui-presenter.ts", "utf8");

test("mission review supports escalation only with a bounded resume target", () => {
  assert.match(service, /case "escalate"/);
  assert.match(service, /input\.resumeTo !== "reviewing" && input\.resumeTo !== "verifying"/);
  assert.match(service, /type: "EscalateMission"/);
  assert.match(service, /resumeTo: input\.resumeTo/);
});

test("mission command handling records escalation and resumes to the selected review state", () => {
  assert.match(handler, /decision === "escalate"/);
  assert.match(handler, /type: "mission\.decision_recorded"/);
  assert.match(handler, /resumeTo/);
  assert.match(presenter, /escalate: "Escalated"/);
});
