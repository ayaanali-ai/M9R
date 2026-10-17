import assert from "node:assert/strict";
import test from "node:test";
import {
  computerUseActionSchema,
  computerUseActionRequirements,
  computerUseResultSchema,
  computerUseTargetSchema,
  checkComputerUseAction,
  isComputerUseTargetFresh,
  parseComputerUseAction,
  parseComputerUseResult,
  parseComputerUseTarget,
} from "../src/lib/native/computer-use-contract";

const observedAt = 1_797_000_000_000;
const sharedTarget = {
  targetId: "target_1",
  revision: "revision_1",
  observedAt,
  capabilities: ["observe.screenshot", "input.click.point"],
};

test("window geometry, menus, and shared clipboard are distinct capabilities with explicit scope", () => {
  const envelope = { operationId: "system-action", targetId: "target_1", targetRevision: "revision_1" };
  for (const action of [
    { ...envelope, kind: "window_frame", x: -100, y: 100, width: 800, height: 600 },
    { ...envelope, kind: "invoke_menu", path: ["Edit", "Select All"] },
    { ...envelope, kind: "clipboard", mode: "read", includeText: false },
    { ...envelope, kind: "clipboard", mode: "write", text: "scratch", confirmSharedClipboard: true },
  ]) assert.ok(computerUseActionSchema.safeParse(action).success);
  assert.equal(computerUseActionSchema.safeParse({ ...envelope, kind: "clipboard", mode: "read", includeText: true }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...envelope, kind: "window_frame", x: 1, y: 1, width: 0, height: 10 }).success, false);
});

const targetFamilies = [
  { ...sharedTarget, kind: "desktop" },
  { ...sharedTarget, kind: "desktop-window", processId: 4321, windowRef: "window_1" },
  { ...sharedTarget, kind: "browser-chrome", browserInstanceId: "browser_1" },
  { ...sharedTarget, kind: "browser-tab", browserInstanceId: "browser_1", tabId: "tab_1", url: "https://example.test/" },
  { ...sharedTarget, kind: "browser-frame", browserInstanceId: "browser_1", tabId: "tab_1", frameId: "frame_1", origin: "https://example.test" },
  { ...sharedTarget, kind: "web-element", browserInstanceId: "browser_1", tabId: "tab_1", frameId: "frame_1", documentId: "document_1", snapshotId: "snapshot_1", elementRef: "element_1" },
];

test("the shared target contract represents desktop, browser chrome, tab, frame, and page-element targets", () => {
  for (const target of targetFamilies) {
    assert.deepEqual(parseComputerUseTarget(target), target);
  }
  assert.equal(parseComputerUseTarget({ ...sharedTarget, kind: "browser-tab" }).kind, "browser-tab",
    "the broker may not expose a real browser-process or tab ID; the opaque observation target remains sufficient");
});

test("target identity requires an observation revision and known capabilities", () => {
  assert.equal(computerUseTargetSchema.safeParse({ ...targetFamilies[0], revision: "" }).success, false);
  assert.equal(computerUseTargetSchema.safeParse({ ...targetFamilies[0], capabilities: ["input.magic"] }).success, false);
  assert.equal(computerUseTargetSchema.safeParse({ ...targetFamilies[0], surprise: true }).success, false);
});

test("target freshness uses its observed timestamp, explicit max age, and rejects future clocks", () => {
  const target = parseComputerUseTarget(targetFamilies[0]);
  assert.equal(isComputerUseTargetFresh(target, observedAt + 500, 1_000), true);
  assert.equal(isComputerUseTargetFresh(target, observedAt + 1_001, 1_000), false);
  assert.equal(isComputerUseTargetFresh(target, observedAt - 1, 1_000), false);
  assert.equal(isComputerUseTargetFresh(target, observedAt + 1, -1), false);
});

test("action compatibility rejects mismatched targets, stale observations, and unadvertised capabilities", () => {
  const target = parseComputerUseTarget(targetFamilies[0]);
  const pointClick = parseComputerUseAction({
    operationId: "op_point",
    targetId: target.targetId,
    targetRevision: target.revision,
    kind: "click",
    locator: { kind: "point", x: 1, y: 2, coordinateSpace: "target-local" },
  });
  assert.deepEqual(checkComputerUseAction(target, pointClick), { ok: true });
  assert.deepEqual(checkComputerUseAction(target, { ...pointClick, targetId: "other_target" }), {
    ok: false,
    code: "target-mismatch",
  });
  assert.deepEqual(checkComputerUseAction(target, { ...pointClick, targetRevision: "old_revision" }), {
    ok: false,
    code: "stale-observation",
  });

  const elementClick = parseComputerUseAction({
    ...pointClick,
    operationId: "op_element",
    locator: { kind: "element", ref: "element_1", snapshotId: "snapshot_1" },
  });
  assert.deepEqual(checkComputerUseAction(target, elementClick), {
    ok: false,
    code: "unsupported-capability",
    required: ["input.click.element"],
    match: "all",
  });
  const doubleClick = parseComputerUseAction({
    operationId: "op_double",
    targetId: target.targetId,
    targetRevision: target.revision,
    kind: "click",
    locator: { kind: "point", x: 1, y: 2, coordinateSpace: "target-local" },
    count: 2,
  });
  assert.deepEqual(checkComputerUseAction(target, doubleClick), {
    ok: false,
    code: "unsupported-capability",
    required: ["input.click.point", "input.click.double.point"],
    match: "all",
  });
  const rightClick = parseComputerUseAction({ ...doubleClick, operationId: "op_right", count: 1, button: "right" });
  assert.deepEqual(checkComputerUseAction(target, rightClick), {
    ok: false,
    code: "unsupported-capability",
    required: ["input.click.point", "input.click.right"],
    match: "all",
  });

  const observe = parseComputerUseAction({ operationId: "op_observe", targetId: target.targetId, targetRevision: target.revision, kind: "observe" });
  assert.deepEqual(checkComputerUseAction(target, observe), { ok: true });
  const insert = parseComputerUseAction({
    operationId: "op_insert_capability",
    targetId: target.targetId,
    targetRevision: target.revision,
    kind: "text",
    mode: "insert",
    text: "continue",
  });
  assert.deepEqual(checkComputerUseAction(target, insert), {
    ok: false,
    code: "unsupported-capability",
    required: ["input.text.insert"],
    match: "all",
  });
  const insertCapableTarget = parseComputerUseTarget({ ...target, capabilities: [...target.capabilities, "input.text.insert"] });
  assert.deepEqual(checkComputerUseAction(insertCapableTarget, insert), { ok: true });
  const replace = parseComputerUseAction({
    operationId: "op_replace_capability",
    targetId: target.targetId,
    targetRevision: target.revision,
    kind: "text",
    mode: "replace",
    text: "replace all",
  });
  assert.deepEqual(checkComputerUseAction(insertCapableTarget, replace), {
    ok: false,
    code: "unsupported-capability",
    required: ["input.text.replace"],
    match: "all",
  });
});

test("text actions make caret insertion and whole-value replacement distinct intents", () => {
  const insert = {
    operationId: "op_insert",
    targetId: "target_1",
    targetRevision: "revision_1",
    kind: "text",
    mode: "insert",
    text: "continue here",
  };
  const replace = { ...insert, operationId: "op_replace", mode: "replace", text: "replace all" };
  assert.deepEqual(parseComputerUseAction(insert), insert);
  assert.deepEqual(parseComputerUseAction(replace), replace);
  const browserReplace = {
    ...replace,
    locator: { kind: "element", ref: "e1", snapshotId: "snapshot_1" },
  };
  assert.deepEqual(parseComputerUseAction(browserReplace), browserReplace);
  assert.equal(computerUseActionSchema.safeParse({ ...insert, mode: undefined }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...insert, text: "bad\u0000text" }).success, false);
});

test("generic postconditions are bounded and require a meaningful accessible-control predicate", () => {
  const base = { operationId: "verify_1", targetId: "target_1", targetRevision: "revision_1", kind: "observe" };
  assert.equal(computerUseActionSchema.safeParse({ ...base, postcondition: { kind: "url-equals", url: "https://example.test/path" } }).success, true);
  assert.equal(computerUseActionSchema.safeParse({ ...base, postcondition: { kind: "url-equals", url: "file:///private/data" } }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...base, postcondition: { kind: "visible-text-contains", text: "Saved" } }).success, true);
  assert.equal(computerUseActionSchema.safeParse({ ...base, postcondition: { kind: "accessible-control-present", label: "Saved" } }).success, true);
  assert.equal(computerUseActionSchema.safeParse({ ...base, postcondition: { kind: "accessible-control-present" } }).success, false);
});

test("point actions are explicitly target-local and bounded; element actions retain snapshot identity", () => {
  const click = {
    operationId: "op_click",
    targetId: "target_1",
    targetRevision: "revision_1",
    kind: "click",
    locator: { kind: "point", x: 100, y: 50, coordinateSpace: "target-local" },
    button: "left",
    count: 1,
  };
  const semanticClick = {
    ...click,
    locator: { kind: "element", ref: "element_1", snapshotId: "snapshot_1" },
  };
  assert.deepEqual(parseComputerUseAction(click), { ...click, button: "left", count: 1 });
  assert.deepEqual(parseComputerUseAction(semanticClick), { ...semanticClick, button: "left", count: 1 });
  assert.equal(computerUseActionSchema.safeParse({
    ...click,
    locator: { kind: "point", x: -1920, y: -40, coordinateSpace: "desktop-screen" },
  }).success, true, "virtual-screen coordinates can be negative when a monitor is left or above the primary display");
  assert.equal(computerUseActionSchema.safeParse({ ...click, locator: { ...click.locator, x: 20_000 } }).success, false);
  assert.equal(computerUseActionSchema.safeParse({
    ...click,
    locator: { kind: "point", x: -1, y: 2, coordinateSpace: "page-viewport" },
  }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...click, locator: { kind: "point", x: 1, y: 2 } }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...click, count: 2, button: "right" }).success, false,
    "double-click has one canonical left-button semantic rather than implying unsupported compound actions");
});

test("other common intents share one envelope without requiring an app-specific action schema", () => {
  const envelope = { operationId: "op_2", targetId: "target_1", targetRevision: "revision_1" };
  for (const action of [
    { ...envelope, kind: "observe" },
    { ...envelope, kind: "focus" },
    { ...envelope, kind: "key", key: "Enter", modifiers: ["Control"] },
    { ...envelope, kind: "select_text", locator: { kind: "element", ref: "e1", snapshotId: "snapshot_1" }, selection: { kind: "all" } },
    { ...envelope, kind: "scroll", unit: "pixel", deltaX: 0, deltaY: 600 },
    { ...envelope, kind: "drag", from: { kind: "point", x: 1, y: 2, coordinateSpace: "target-local" }, to: { kind: "point", x: 3, y: 4, coordinateSpace: "target-local" } },
    { ...envelope, kind: "navigate", url: "https://example.test/" },
  ]) {
    assert.equal(parseComputerUseAction(action).kind, action.kind);
  }
  const horizontalScroll = parseComputerUseAction({ ...envelope, kind: "scroll", unit: "line", deltaX: 200, deltaY: 0 });
  assert.deepEqual(computerUseActionRequirements(horizontalScroll), { capabilities: ["input.scroll.line.horizontal"], match: "all" });
  const pixelScroll = parseComputerUseAction({ ...envelope, kind: "scroll", unit: "pixel", deltaX: 0, deltaY: -300 });
  assert.deepEqual(computerUseActionRequirements(pixelScroll), {
    capabilities: ["input.scroll.pixel.vertical"],
    match: "all",
  });
  const pageScroll = parseComputerUseAction({ ...envelope, kind: "scroll", unit: "page", deltaX: 0, deltaY: 1 });
  assert.deepEqual(computerUseActionRequirements(pageScroll), {
    capabilities: ["input.scroll.page.vertical"],
    match: "all",
  });
  const timedDrag = parseComputerUseAction({
    ...envelope,
    kind: "drag",
    from: { kind: "point", x: 1, y: 2, coordinateSpace: "target-local" },
    to: { kind: "point", x: 3, y: 4, coordinateSpace: "target-local" },
    durationMs: 1_250,
  });
  assert.deepEqual(computerUseActionRequirements(timedDrag), {
    capabilities: ["input.drag", "input.drag.duration"],
    match: "all",
  });
  assert.equal(computerUseActionSchema.safeParse({ ...timedDrag, durationMs: 0 }).success, false,
    "an explicit drag duration must be positive rather than silently mapping zero to a default");
  assert.equal(computerUseActionSchema.safeParse({ ...timedDrag, durationMs: 10_001 }).success, false);
  const selectAll = parseComputerUseAction({ ...envelope, kind: "select_text", locator: { kind: "element", ref: "e1", snapshotId: "revision_1" }, selection: { kind: "all" } });
  assert.deepEqual(computerUseActionRequirements(selectAll), { capabilities: ["input.select-text.all"], match: "all" });
  const selectPhrase = parseComputerUseAction({ ...envelope, kind: "select_text", locator: { kind: "element", ref: "e1", snapshotId: "revision_1" }, selection: { kind: "text", text: "phrase" } });
  assert.deepEqual(computerUseActionRequirements(selectPhrase), { capabilities: ["input.select-text.text"], match: "all" });
  assert.equal(computerUseActionSchema.safeParse({ ...envelope, kind: "select_text", selection: { kind: "all" } }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...envelope, kind: "navigate", url: "javascript:alert(1)" }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...envelope, kind: "scroll", unit: "pixel", deltaX: 0, deltaY: 0 }).success, false);
  assert.equal(computerUseActionSchema.safeParse({ ...envelope, kind: "scroll", deltaX: 0, deltaY: 100 }).success, false,
    "a scroll distance without a unit is semantically ambiguous");
  assert.equal(computerUseActionSchema.safeParse({ ...envelope, kind: "scroll", unit: "pixel", deltaX: 100, deltaY: 100 }).success, false,
    "one route call represents one axis so partial diagonal dispatch cannot be misreported as atomic");
  assert.equal(computerUseActionSchema.safeParse({
    ...envelope,
    kind: "drag",
    from: { kind: "point", x: 1, y: 2, coordinateSpace: "desktop-screen" },
    to: { kind: "point", x: 3, y: 4, coordinateSpace: "target-local" },
  }).success, false, "a point drag cannot mix coordinate frames");
});

test("result contract distinguishes input dispatch from observed and verified effect", () => {
  const deliveredButUnverified = {
    operationId: "op_3",
    targetId: "target_1",
    dispatchStatus: "dispatched",
    effectStatus: "unknown",
    routeId: "route_uia_1",
  };
  assert.equal(parseComputerUseResult(deliveredButUnverified).effectStatus, "unknown");

  const verified = {
    ...deliveredButUnverified,
    effectStatus: "verified",
    observation: { revision: "revision_2", observedAt: observedAt + 1, evidenceRef: "capture_2" },
  };
  assert.equal(parseComputerUseResult(verified).effectStatus, "verified");
  assert.equal(parseComputerUseResult({
    ...verified,
    operationReceipt: { status: "applied", updatedAt: new Date(observedAt).toISOString() },
  }).operationReceipt?.status, "applied");
  assert.equal(computerUseResultSchema.safeParse({ ...verified, observation: undefined }).success, false);
  assert.equal(computerUseResultSchema.safeParse({ ...deliveredButUnverified, dispatchStatus: "success" }).success, false);
});

test("confirmFocusForeground requires input.shared-os, only on an exact app-window click, and only one dispatch", () => {
  const appWindowTarget = parseComputerUseTarget({
    ...sharedTarget,
    kind: "desktop-window",
    windowRef: "window_app_1",
    capabilities: ["observe.screenshot", "input.click.element", "input.click.point"],
  });
  const foregroundClick = parseComputerUseAction({
    operationId: "op_foreground_click",
    targetId: appWindowTarget.targetId,
    targetRevision: appWindowTarget.revision,
    kind: "click",
    locator: { kind: "point", x: 1, y: 2, coordinateSpace: "target-local" },
    confirmFocusForeground: true,
  });
  assert.deepEqual(computerUseActionRequirements(foregroundClick).capabilities, ["input.click.point", "input.shared-os"]);
  assert.deepEqual(checkComputerUseAction(appWindowTarget, foregroundClick), {
    ok: false,
    code: "unsupported-capability",
    required: ["input.click.point", "input.shared-os"],
    match: "all",
  });
  const sharedOsTarget = parseComputerUseTarget({ ...appWindowTarget, capabilities: [...appWindowTarget.capabilities, "input.shared-os"] });
  assert.deepEqual(checkComputerUseAction(sharedOsTarget, foregroundClick), { ok: true });

  // A plain click on the very same target, without the explicit opt-in, never requires or implies input.shared-os.
  const plainClick = parseComputerUseAction({ ...foregroundClick, operationId: "op_plain_click", confirmFocusForeground: undefined });
  assert.deepEqual(computerUseActionRequirements(plainClick).capabilities, ["input.click.point"]);

  const foregroundScroll = parseComputerUseAction({
    operationId: "op_foreground_scroll",
    targetId: appWindowTarget.targetId,
    targetRevision: appWindowTarget.revision,
    kind: "scroll",
    unit: "line",
    deltaX: 0,
    deltaY: 3,
    confirmFocusForeground: true,
  });
  assert.deepEqual(computerUseActionRequirements(foregroundScroll).capabilities, ["input.scroll.line.vertical", "input.shared-os"]);
  const scrollCapableTarget = parseComputerUseTarget({ ...sharedOsTarget, capabilities: [...sharedOsTarget.capabilities, "input.scroll.line.vertical"] });
  assert.deepEqual(checkComputerUseAction(scrollCapableTarget, foregroundScroll), { ok: true });
});

test("foreground delivery requires shared-OS capability on every non-browser CUA input action", () => {
  const appTarget = parseComputerUseTarget({
    ...sharedTarget,
    kind: "desktop-window",
    windowRef: "foreground-window",
    capabilities: ["input.text.insert", "input.key", "input.scroll.line.vertical", "input.drag"],
  });
  const base = { operationId: "op_shared_input", targetId: appTarget.targetId, targetRevision: appTarget.revision };
  const foregroundActions = [
    { ...base, kind: "text", mode: "insert", text: "hello", confirmFocusForeground: true },
    { ...base, kind: "key", key: "Enter", confirmFocusForeground: true },
    { ...base, kind: "scroll", unit: "line", deltaX: 0, deltaY: 2, confirmFocusForeground: true },
    { ...base, kind: "drag", from: { kind: "point", x: 1, y: 2, coordinateSpace: "target-local" },
      to: { kind: "point", x: 3, y: 4, coordinateSpace: "target-local" }, confirmFocusForeground: true },
  ];
  for (const value of foregroundActions) {
    const action = parseComputerUseAction(value);
    const required = computerUseActionRequirements(action).capabilities;
    assert.ok(required.includes("input.shared-os"), `${action.kind} must explicitly claim the shared OS input route`);
    assert.deepEqual(checkComputerUseAction(appTarget, action), {
      ok: false, code: "unsupported-capability", required, match: "all",
    }, `${action.kind} cannot silently use foreground input without the advertised capability`);
    const authorizedTarget = parseComputerUseTarget({ ...appTarget, capabilities: [...appTarget.capabilities, "input.shared-os"] });
    assert.deepEqual(checkComputerUseAction(authorizedTarget, action), { ok: true });
  }
  assert.equal(computerUseActionSchema.safeParse({ ...foregroundActions[0], mode: "replace" }).success, false,
    "foreground typing must not turn explicit field replacement into key input");
});
