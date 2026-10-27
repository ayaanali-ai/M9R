import assert from "node:assert/strict";
import test from "node:test";
import { parseComputerUseAction, parseComputerUseTarget } from "../src/lib/native/computer-use-contract";
import { selectComputerUseRoute, type ComputerUseRouteDescriptor } from "../src/lib/native/computer-use-router";

const nowMs = 1_797_000_100_000;
const desktop = parseComputerUseTarget({
  kind: "desktop-window",
  targetId: "desktop_1",
  windowRef: "window_1",
  revision: "revision_1",
  observedAt: nowMs - 100,
  capabilities: ["observe.screenshot", "input.click.point", "input.click.element", "input.shared-os"],
});
const pointClick = parseComputerUseAction({
  operationId: "operation_1",
  targetId: desktop.targetId,
  targetRevision: desktop.revision,
  kind: "click",
  locator: { kind: "point", x: 20, y: 30, coordinateSpace: "target-local" },
});

function route(overrides: Partial<ComputerUseRouteDescriptor> & Pick<ComputerUseRouteDescriptor, "routeId" | "capabilities">): ComputerUseRouteDescriptor {
  return {
    targetKinds: ["desktop-window"],
    priority: 0,
    requiresOwnerInputLease: false,
    ...overrides,
  };
}

test("selects only a route matching both target kind and semantic capability", () => {
  const result = selectComputerUseRoute({
    sessionId: "session_1", target: desktop, action: pointClick, nowMs, maxObservationAgeMs: 1_000,
    routes: [
      route({ routeId: "browser_dom", targetKinds: ["web-element"], capabilities: ["input.click.point"] }),
      route({ routeId: "semantic_only", capabilities: ["input.click.element"] }),
      route({ routeId: "desktop_point", capabilities: ["input.click.point"] }),
    ],
  });
  assert.deepEqual(result, { ok: true, routeId: "desktop_point", pinned: false });
});

test("prefers a non-shared-input route over a higher-priority physical-input route", () => {
  const result = selectComputerUseRoute({
    sessionId: "session_1", target: desktop, action: pointClick, nowMs, maxObservationAgeMs: 1_000,
    routes: [
      route({ routeId: "native_pointer", capabilities: ["input.click.point"], requiresOwnerInputLease: true, priority: 100 }),
      route({ routeId: "isolated_point", capabilities: ["input.click.point"], priority: -10 }),
    ],
  });
  assert.deepEqual(result, { ok: true, routeId: "isolated_point", pinned: false });
});

test("requires a visible owner-acknowledged lease before selecting a shared OS-input route", () => {
  const routes = [route({ routeId: "native_pointer", capabilities: ["input.click.point"], requiresOwnerInputLease: true })];
  const withoutLease = selectComputerUseRoute({
    sessionId: "session_1", target: desktop, action: pointClick, nowMs, maxObservationAgeMs: 1_000, routes,
  });
  assert.deepEqual(withoutLease, { ok: false, code: "owner-input-lease-required" });

  const withLease = selectComputerUseRoute({
    sessionId: "session_1", target: desktop, action: pointClick, nowMs, maxObservationAgeMs: 1_000, routes,
    ownerInputLease: { sessionId: "session_1", targetId: desktop.targetId, grantedAt: nowMs - 10, expiresAt: nowMs + 1_000, visibleNoticeId: "notice_1" },
  });
  assert.deepEqual(withLease, { ok: true, routeId: "native_pointer", pinned: false });
});

test("rejects expired, wrong-session, wrong-target, or not-yet-active leases", () => {
  const routes = [route({ routeId: "native_pointer", capabilities: ["input.click.point"], requiresOwnerInputLease: true })];
  for (const lease of [
    { sessionId: "session_1", targetId: desktop.targetId, grantedAt: nowMs - 1_000, expiresAt: nowMs, visibleNoticeId: "notice_1" },
    { sessionId: "other_session", targetId: desktop.targetId, grantedAt: nowMs - 10, expiresAt: nowMs + 1_000, visibleNoticeId: "notice_1" },
    { sessionId: "session_1", targetId: "other_target", grantedAt: nowMs - 10, expiresAt: nowMs + 1_000, visibleNoticeId: "notice_1" },
    { sessionId: "session_1", targetId: desktop.targetId, grantedAt: nowMs + 1, expiresAt: nowMs + 1_000, visibleNoticeId: "notice_1" },
  ]) {
    assert.deepEqual(selectComputerUseRoute({
      sessionId: "session_1", target: desktop, action: pointClick, nowMs, maxObservationAgeMs: 1_000,
      routes, ownerInputLease: lease,
    }), { ok: false, code: "owner-input-lease-required" });
  }
});

test("pins a route for the task and refuses instead of silently switching when it disappears", () => {
  const routes = [
    route({ routeId: "cdp", targetKinds: ["browser-tab"], capabilities: ["input.click.element"], priority: 1 }),
    route({ routeId: "extension", targetKinds: ["browser-tab"], capabilities: ["input.click.element"], priority: 5 }),
  ];
  const browserTarget = parseComputerUseTarget({
    kind: "browser-tab", targetId: "tab_target", browserInstanceId: "browser_1", tabId: "tab_1",
    revision: "snapshot_1", observedAt: nowMs - 10, capabilities: ["observe.dom", "input.click.element"],
  });
  const action = parseComputerUseAction({
    operationId: "operation_2", targetId: browserTarget.targetId, targetRevision: browserTarget.revision,
    kind: "click", locator: { kind: "element", ref: "e1", snapshotId: "snapshot_1" },
  });
  assert.deepEqual(selectComputerUseRoute({
    sessionId: "session_1", target: browserTarget, action, nowMs, maxObservationAgeMs: 1_000, routes, pinnedRouteId: "cdp",
  }), { ok: true, routeId: "cdp", pinned: true });
  assert.deepEqual(selectComputerUseRoute({
    sessionId: "session_1", target: browserTarget, action, nowMs, maxObservationAgeMs: 1_000, routes: [routes[1]!], pinnedRouteId: "cdp",
  }), { ok: false, code: "pinned-route-unavailable" });
});

test("fails closed for stale snapshots and target capability gaps before routing", () => {
  assert.deepEqual(selectComputerUseRoute({
    sessionId: "session_1", target: desktop, action: pointClick, nowMs, maxObservationAgeMs: 10,
    routes: [route({ routeId: "desktop_point", capabilities: ["input.click.point"] })],
  }), { ok: false, code: "stale-observation" });
  const screenshotOnly = parseComputerUseTarget({ ...desktop, capabilities: ["observe.screenshot"] });
  assert.deepEqual(selectComputerUseRoute({
    sessionId: "session_1", target: screenshotOnly, action: pointClick, nowMs, maxObservationAgeMs: 1_000,
    routes: [route({ routeId: "desktop_point", capabilities: ["input.click.point"] })],
  }), { ok: false, code: "unsupported-target-capability", required: ["input.click.point"], match: "all" });
});

test("route priority ties use stable route ID order", () => {
  const result = selectComputerUseRoute({
    sessionId: "session_1", target: desktop, action: pointClick, nowMs, maxObservationAgeMs: 1_000,
    routes: [
      route({ routeId: "route_z", capabilities: ["input.click.point"], priority: 1 }),
      route({ routeId: "route_a", capabilities: ["input.click.point"], priority: 1 }),
    ],
  });
  assert.deepEqual(result, { ok: true, routeId: "route_a", pinned: false });
});

test("an explicit drag duration routes only through an adapter that advertises duration support", () => {
  const target = parseComputerUseTarget({
    ...desktop,
    capabilities: [...desktop.capabilities, "input.drag", "input.drag.duration"],
  });
  const action = parseComputerUseAction({
    operationId: "timed_drag",
    targetId: target.targetId,
    targetRevision: target.revision,
    kind: "drag",
    from: { kind: "point", x: 10, y: 20, coordinateSpace: "target-local" },
    to: { kind: "point", x: 30, y: 40, coordinateSpace: "target-local" },
    durationMs: 1_250,
  });
  const request = {
    sessionId: "session_1", target, action, nowMs, maxObservationAgeMs: 1_000,
  };
  assert.deepEqual(selectComputerUseRoute({
    ...request,
    routes: [route({ routeId: "instant-drag", capabilities: ["input.drag"] })],
  }), { ok: false, code: "no-compatible-route" });
  assert.deepEqual(selectComputerUseRoute({
    ...request,
    routes: [route({ routeId: "timed-drag", capabilities: ["input.drag", "input.drag.duration"] })],
  }), { ok: true, routeId: "timed-drag", pinned: false });
});

test("the selector handles desktop, window, browser chrome, tab, frame, and element target identities", () => {
  const cases = [
    { kind: "desktop", capabilities: ["observe.screenshot"] },
    { kind: "desktop-window", windowRef: "window_2", capabilities: ["observe.accessibility"] },
    { kind: "browser-chrome", capabilities: ["observe.accessibility"] },
    { kind: "browser-tab", url: "https://example.test/", capabilities: ["observe.dom"] },
    { kind: "browser-frame", origin: "https://example.test", capabilities: ["observe.dom"] },
    { kind: "web-element", snapshotId: "snapshot_1", elementRef: "element_1", capabilities: ["observe.dom"] },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const target = parseComputerUseTarget({
      ...item,
      targetId: `family_${index}`,
      revision: `revision_${index}`,
      observedAt: nowMs - 1,
    });
    const action = parseComputerUseAction({
      operationId: `observe_${index}`,
      targetId: target.targetId,
      targetRevision: target.revision,
      kind: "observe",
    });
    assert.deepEqual(selectComputerUseRoute({
      sessionId: "session_1",
      target,
      action,
      nowMs,
      maxObservationAgeMs: 1_000,
      routes: [{
        routeId: `route_${index}`,
        targetKinds: [target.kind],
        capabilities: [...target.capabilities],
      }],
    }), { ok: true, routeId: `route_${index}`, pinned: false }, target.kind);
  }
});

test("an unregistered target family refuses instead of borrowing an unrelated adapter", () => {
  const browserChrome = parseComputerUseTarget({
    kind: "browser-chrome",
    targetId: "browser_chrome_1",
    revision: "browser_chrome_revision_1",
    observedAt: nowMs - 1,
    capabilities: ["input.click.point"],
  });
  const action = parseComputerUseAction({
    operationId: "browser_chrome_click",
    targetId: browserChrome.targetId,
    targetRevision: browserChrome.revision,
    kind: "click",
    locator: { kind: "point", x: 10, y: 10, coordinateSpace: "target-local" },
  });
  assert.deepEqual(selectComputerUseRoute({
    sessionId: "session_1",
    target: browserChrome,
    action,
    nowMs,
    maxObservationAgeMs: 1_000,
    routes: [route({ routeId: "desktop-stage", capabilities: ["input.click.point"] })],
  }), { ok: false, code: "no-compatible-route" });
});
