/**
 * Channel workflow automation — schema parsing/validation unit tests.
 * ----------------------------------------------------------------------------
 * Covers the deliberately narrower port of Buzz's crates/buzz-workflow
 * schema (see mission-workflow-schema.ts's module comment for scope).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";

import {
  parseChannelWorkflowDefinition,
  renderWorkflowTemplate,
  matchesMessagePostedFilter,
  parseIntervalMs,
  isScheduleTriggerFireable,
  EXECUTABLE_TRIGGERS,
  WorkflowDefinitionError,
  type MessagePostedTrigger,
  type ScheduleTrigger,
} from "../src/lib/mission/mission-workflow-schema.ts";

function parseYamlDef(yaml: string) {
  return parseChannelWorkflowDefinition(parseYaml(yaml));
}

test("parses a minimal message_posted -> send_message workflow from YAML", () => {
  const def = parseYamlDef(`
name: Welcome bot
trigger:
  on: message_posted
  filter: hello
steps:
  - id: greet
    action: send_message
    text: "Hi {{trigger.author}}!"
`);
  assert.equal(def.name, "Welcome bot");
  assert.equal(def.trigger.on, "message_posted");
  assert.equal((def.trigger as MessagePostedTrigger).filter, "hello");
  assert.equal(def.steps.length, 1);
  assert.equal(def.steps[0].action.action, "send_message");
  assert.equal(def.enabled, true);
});

test("parses a schedule trigger with cron", () => {
  const def = parseYamlDef(`
name: Nightly check
trigger:
  on: schedule
  cron: "0 9 * * *"
steps:
  - id: ping
    action: send_message
    text: "Daily check-in"
`);
  assert.equal(def.trigger.on, "schedule");
});

test("rejects a schedule trigger with both cron and interval", () => {
  assert.throws(() => parseYamlDef(`
name: Bad schedule
trigger:
  on: schedule
  cron: "0 9 * * *"
  interval: "1h"
steps:
  - id: ping
    action: send_message
    text: "x"
`), WorkflowDefinitionError);
});

test("rejects a schedule trigger with neither cron nor interval", () => {
  assert.throws(() => parseYamlDef(`
name: Bad schedule
trigger:
  on: schedule
steps:
  - id: ping
    action: send_message
    text: "x"
`), WorkflowDefinitionError);
});

test("rejects an unsupported trigger kind (e.g. Buzz's webhook, not ported)", () => {
  assert.throws(() => parseYamlDef(`
name: Unsupported
trigger:
  on: webhook
steps:
  - id: ping
    action: send_message
    text: "x"
`), WorkflowDefinitionError);
});

test("rejects an unsupported action kind (e.g. Buzz's call_webhook, deliberately not ported)", () => {
  assert.throws(() => parseYamlDef(`
name: Unsupported action
trigger:
  on: message_posted
steps:
  - id: hook
    action: call_webhook
    url: "https://example.com"
`), WorkflowDefinitionError);
});

test("rejects an empty step list", () => {
  assert.throws(() => parseYamlDef(`
name: Empty
trigger:
  on: message_posted
steps: []
`), WorkflowDefinitionError);
});

test("rejects duplicate step ids", () => {
  assert.throws(() => parseYamlDef(`
name: Dup ids
trigger:
  on: message_posted
steps:
  - id: a
    action: send_message
    text: "one"
  - id: a
    action: send_message
    text: "two"
`), WorkflowDefinitionError);
});

test("rejects an invalid step id (non-alphanumeric)", () => {
  assert.throws(() => parseYamlDef(`
name: Bad id
trigger:
  on: message_posted
steps:
  - id: "not valid!"
    action: send_message
    text: "x"
`), WorkflowDefinitionError);
});

test("rejects a missing/empty workflow name", () => {
  assert.throws(() => parseYamlDef(`
trigger:
  on: message_posted
steps:
  - id: a
    action: send_message
    text: "x"
`), WorkflowDefinitionError);
});

test("request_approval action parses with a required message", () => {
  const def = parseYamlDef(`
name: Needs approval
trigger:
  on: message_posted
  filter: deploy
steps:
  - id: gate
    action: request_approval
    message: "Deploy requested via chat"
`);
  assert.equal(def.steps[0].action.action, "request_approval");
});

test("request_approval rejects an empty message", () => {
  assert.throws(() => parseYamlDef(`
name: Needs approval
trigger:
  on: message_posted
steps:
  - id: gate
    action: request_approval
    message: ""
`), WorkflowDefinitionError);
});

test("renderWorkflowTemplate substitutes trigger.body and trigger.author", () => {
  const rendered = renderWorkflowTemplate("From {{trigger.author}}: {{trigger.body}}", { body: "deploy prod", author: "Alice" });
  assert.equal(rendered, "From Alice: deploy prod");
});

test("renderWorkflowTemplate leaves unknown variables untouched rather than dropping them", () => {
  const rendered = renderWorkflowTemplate("{{trigger.unknown}} stays literal", { body: "x", author: "y" });
  assert.equal(rendered, "{{trigger.unknown}} stays literal");
});

test("matchesMessagePostedFilter with no filter matches every message", () => {
  const trigger: MessagePostedTrigger = { on: "message_posted" };
  assert.equal(matchesMessagePostedFilter(trigger, "anything at all"), true);
});

test("matchesMessagePostedFilter is a case-insensitive substring match, not an expression language", () => {
  const trigger: MessagePostedTrigger = { on: "message_posted", filter: "Deploy" };
  assert.equal(matchesMessagePostedFilter(trigger, "please deploy prod now"), true);
  assert.equal(matchesMessagePostedFilter(trigger, "unrelated message"), false);
});

test("parseChannelWorkflowDefinition is idempotent: re-parsing its own output succeeds unchanged", () => {
  // Regression: mission-workflow-store.ts's toRecord re-validates
  // definition_json read back from storage through this same parser. What's
  // stored there is already parseChannelWorkflowDefinition's OWN output
  // (step.action nested), not the original flat YAML shape a step author
  // writes. A parser that only accepted the flat shape corrupted every
  // workflow on the very next read after creation.
  const first = parseYamlDef(`
name: Idempotency check
trigger:
  on: message_posted
steps:
  - id: greet
    action: send_message
    text: "Hi {{trigger.author}}!"
  - id: approve
    action: request_approval
    message: "please review"
`);
  const second = parseChannelWorkflowDefinition(first);
  assert.deepEqual(second, first);
});

test("parseChannelWorkflowDefinition rejects a non-object input", () => {
  assert.throws(() => parseChannelWorkflowDefinition("not an object"), WorkflowDefinitionError);
  assert.throws(() => parseChannelWorkflowDefinition(null), WorkflowDefinitionError);
});

test("a schedule -> interval workflow parses and is executable", () => {
  const def = parseYamlDef(`
name: Daily digest
trigger:
  on: schedule
  interval: 1d
steps:
  - id: digest
    action: send_message
    text: "Daily digest"
`);
  assert.equal(def.trigger.on, "schedule");
  assert.equal((def.trigger as ScheduleTrigger).interval, "1d");
  assert.equal(EXECUTABLE_TRIGGERS.has("schedule"), true);
  assert.equal(isScheduleTriggerFireable(def.trigger), true);
});

test("a schedule -> cron workflow still parses (round-trips) but is not fireable yet", () => {
  const def = parseYamlDef(`
name: Cron digest
trigger:
  on: schedule
  cron: "0 9 * * 1"
steps:
  - id: digest
    action: send_message
    text: "Weekly digest"
`);
  assert.equal((def.trigger as ScheduleTrigger).cron, "0 9 * * 1");
  assert.equal(isScheduleTriggerFireable(def.trigger), false);
});

test("schedule trigger rejects specifying both cron and interval", () => {
  assert.throws(() => parseYamlDef(`
name: Bad
trigger:
  on: schedule
  cron: "0 9 * * 1"
  interval: 1d
steps:
  - id: s
    action: send_message
    text: x
`), WorkflowDefinitionError);
});

test("schedule trigger rejects neither cron nor interval", () => {
  assert.throws(() => parseYamlDef(`
name: Bad
trigger:
  on: schedule
steps:
  - id: s
    action: send_message
    text: x
`), WorkflowDefinitionError);
});

test("schedule trigger rejects an unparseable interval string", () => {
  assert.throws(() => parseYamlDef(`
name: Bad
trigger:
  on: schedule
  interval: "soon"
steps:
  - id: s
    action: send_message
    text: x
`), WorkflowDefinitionError);
});

test("parseIntervalMs parses whole-unit durations", () => {
  assert.equal(parseIntervalMs("30m"), 30 * 60_000);
  assert.equal(parseIntervalMs("6h"), 6 * 3_600_000);
  assert.equal(parseIntervalMs("1d"), 86_400_000);
  assert.equal(parseIntervalMs("90s"), 90_000);
});

test("parseIntervalMs rejects below the 60s floor a periodic sweep can honor", () => {
  assert.equal(parseIntervalMs("30s"), null);
  assert.equal(parseIntervalMs("0s"), null);
});

test("parseIntervalMs rejects garbage and bare cron-shaped strings", () => {
  assert.equal(parseIntervalMs("not-an-interval"), null);
  assert.equal(parseIntervalMs("0 9 * * 1"), null);
  assert.equal(parseIntervalMs(""), null);
});

test("isScheduleTriggerFireable is false for message_posted (only schedule+interval fires)", () => {
  const trigger: MessagePostedTrigger = { on: "message_posted" };
  assert.equal(isScheduleTriggerFireable(trigger), false);
});
