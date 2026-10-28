import assert from "node:assert/strict";
import test from "node:test";
import {
  createTargetIdentityRegistry,
  targetIdentityKey,
  validateDistinctTargetBindings,
} from "../src/lib/native/multiplayer-target-identity";
import type { ComputerUseTarget } from "../src/lib/native/computer-use-contract";

const browserTarget = (overrides: Record<string, unknown> = {}) => ({
  kind: "browser-tab" as const,
  targetId: "target-codex",
  revision: "rev-1",
  observedAt: 100,
  capabilities: ["observe.dom" as const, "input.text.insert" as const],
  browserInstanceId: "browser-1",
  tabId: "tab-1",
  ...overrides,
});

const binding = (agentId: string, target: ComputerUseTarget = browserTarget(), surfaceId = "surface-1") => ({
  runId: "run-1",
  branchId: `${agentId}-branch`,
  agentId,
  surfaceId,
  target,
});

test("requires an explicit browser instance and tab identity for multiplayer bindings", () => {
  const missingTab = validateDistinctTargetBindings([binding("codex", browserTarget({ tabId: undefined }))]);
  assert.equal(missingTab.ok, false);
  if (!missingTab.ok) assert.equal(missingTab.error, "A browser-tab binding requires an opaque tabId; do not rely on the focused tab.");
  const valid = validateDistinctTargetBindings([binding("codex")]);
  assert.equal(valid.ok, true);
});

test("two agents may bind separate tabs, but a target identity cannot be silently shared", () => {
  const separate = validateDistinctTargetBindings([
    binding("codex"),
    binding("claude", browserTarget({ targetId: "target-claude", tabId: "tab-2" }), "surface-2"),
  ]);
  assert.equal(separate.ok, true);
  const duplicate = validateDistinctTargetBindings([
    binding("codex"),
    binding("claude", browserTarget(), "surface-2"),
  ]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.conflict?.existingAgentId, "codex");
});

test("the registry keeps ownership after a completed operation until the target is explicitly forgotten", () => {
  const registry = createTargetIdentityRegistry();
  const first = registry.claim(binding("codex"), "op-1");
  assert.deepEqual(first, { ok: true, duplicate: false, key: targetIdentityKey(browserTarget()) });
  registry.release("op-1");
  const otherAgent = registry.claim(binding("claude"), "op-2");
  assert.equal(otherAgent.ok, false);
  if (!otherAgent.ok) assert.equal(otherAgent.code, "duplicate-target");
  registry.forget(binding("codex"));
  const afterForget = registry.claim(binding("claude"), "op-2");
  assert.equal(afterForget.ok, true, "an explicit close/replacement forget permits a fresh agent binding");
});

test("desktop-window bindings preserve explicit windowRef and reject a missing reference", () => {
  const desktop = {
    kind: "desktop-window" as const,
    targetId: "desktop-target",
    revision: "rev-1",
    observedAt: 100,
    capabilities: ["window.state" as const],
    windowRef: "hwnd-1",
  };
  assert.equal(validateDistinctTargetBindings([binding("codex", desktop)]).ok, true);
  const missingWindow = { ...desktop, windowRef: undefined } as unknown as ComputerUseTarget;
  assert.equal(validateDistinctTargetBindings([binding("codex", missingWindow)]).ok, false);
});
