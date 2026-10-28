import assert from "node:assert/strict";
import test from "node:test";
import {
  createM9RSurfaceAdapter,
  createM9RSurfaceAdapterCatalog,
} from "../src/lib/native/multiplayer-surface";
import type { ComputerUseTarget } from "../src/lib/native/computer-use-contract";

const browserTarget: ComputerUseTarget = {
  kind: "browser-tab",
  targetId: "tab-1",
  tabId: "tab-1",
  browserInstanceId: "browser-1",
  revision: "rev-1",
  observedAt: 100,
  capabilities: ["observe.dom", "input.click.element", "input.text.insert", "browser.navigate"],
};

const desktopTarget: ComputerUseTarget = {
  kind: "desktop-window",
  targetId: "window-1",
  windowRef: "window-1",
  revision: "rev-2",
  observedAt: 100,
  capabilities: ["observe.screenshot", "observe.accessibility", "input.click.point", "input.text.insert"],
};

test("the built-in catalog preserves the existing broker-owned browser and desktop routes", () => {
  const catalog = createM9RSurfaceAdapterCatalog();
  const browser = catalog.bind("surface-browser", browserTarget);
  const desktop = catalog.bind("surface-desktop", desktopTarget);
  assert.equal(browser.ok, true);
  assert.equal(desktop.ok, true);
  if (browser.ok) {
    assert.equal(browser.binding.adapterId, "m9r-browser-cdp");
    assert.equal(browser.binding.level, "browser-cdp");
    assert.equal(browser.binding.route.routeId, "m9r-browser-broker");
    assert.deepEqual(browser.binding.route.capabilities, browserTarget.capabilities);
  }
  if (desktop.ok) {
    assert.equal(desktop.binding.adapterId, "m9r-ui-automation");
    assert.equal(desktop.binding.route.routeId, "m9r-desktop-stage");
  }
});

test("document and visual adapters are extensible without pretending they are browser routes", () => {
  const catalog = createM9RSurfaceAdapterCatalog();
  catalog.register(createM9RSurfaceAdapter({
    adapterId: "m9r-document-word",
    level: "document-application",
    routeId: "m9r-document-word",
    targetKinds: ["desktop-window"],
    priority: 200,
    availability: "configured",
  }));
  catalog.register(createM9RSurfaceAdapter({
    adapterId: "m9r-visual-fallback",
    level: "visual-physical",
    routeId: "m9r-visual-fallback",
    targetKinds: ["desktop"],
    priority: -10,
    availability: "configured",
  }));
  const document = catalog.bind("surface-document", desktopTarget);
  assert.equal(document.ok, true);
  if (document.ok) {
    assert.equal(document.binding.level, "document-application");
    assert.equal(document.binding.route.routeId, "m9r-document-word");
  }
  assert.equal(catalog.descriptors().some((descriptor) => descriptor.level === "visual-physical"), true);
});

test("preferred adapter selection is explicit and stale/unknown target kinds fail closed", () => {
  const catalog = createM9RSurfaceAdapterCatalog();
  const preferred = catalog.bind("surface-browser", browserTarget, "m9r-ui-automation");
  assert.equal(preferred.ok, false);
  assert.equal(catalog.bind("surface-browser", browserTarget, "missing-adapter").ok, false);
  assert.equal(catalog.bind("surface-browser", { ...browserTarget, kind: "desktop" } as ComputerUseTarget, "m9r-browser-cdp").ok, false);
});
