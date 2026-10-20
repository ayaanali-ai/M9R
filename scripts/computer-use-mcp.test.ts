import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createM9rMcpServer } from "../src/lib/native/mcp-server";
import { computerUseTelemetrySchema, isComputerUseTargetFresh } from "../src/lib/native/computer-use-contract";
import { createLocalStore, type LocalStore } from "../src/lib/native/local-store";
import type { WebBrokerClient } from "../src/lib/native/web-broker-client";

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);
const TOKEN_LOCAL = "c".repeat(32);
const REF_PREFIX = "e0123456789abcdef01234567";

type ToolReply = {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
};
type ToolServer = {
  _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolReply> }>;
};

function createHarness(web: WebBrokerClient, now = () => new Date(), monotonicNow?: () => number) {
  const computerOperations = new Map<string, { fingerprint: string; state: "running" | "applied" | "uncertain"; updatedAt: string }>();
  const operationKey = (input: { handle: string; sessionId: string; targetId: string; operationId: string }) =>
    JSON.stringify([input.handle, input.sessionId, input.targetId, input.operationId]);
  const store = {
    root: "C:/tmp/m9r-computer-use-test",
    verifyIdentity: (token: string) => token === TOKEN_A
      ? { handle: "codex", provider: "codex", sessionId: "session-a" }
      : token === TOKEN_B
        ? { handle: "claude", provider: "claude-code", sessionId: "session-b" }
        : token === TOKEN_LOCAL
          ? { handle: "hermes-local", provider: "hermes", sessionId: "session-local" }
        : null,
    inspectComputerOperation: (input: { handle: string; sessionId: string; targetId: string; operationId: string; fingerprint: string }) => {
      const existing = computerOperations.get(operationKey(input));
      if (!existing) return undefined;
      if (existing.fingerprint !== input.fingerprint) return { state: "conflict" };
      return { state: existing.state === "running" ? "in_progress" : existing.state, updatedAt: existing.updatedAt };
    },
    claimComputerOperation: (input: { handle: string; sessionId: string; targetId: string; operationId: string; fingerprint: string }) => {
      const key = operationKey(input);
      const existing = computerOperations.get(key);
      if (existing) return existing.fingerprint === input.fingerprint
        ? { state: existing.state === "running" ? "in_progress" : existing.state, updatedAt: existing.updatedAt }
        : { state: "conflict" };
      const updatedAt = new Date().toISOString();
      computerOperations.set(key, { fingerprint: input.fingerprint, state: "running", updatedAt });
      return { state: "claimed", updatedAt };
    },
    releaseComputerOperation: (input: { handle: string; sessionId: string; targetId: string; operationId: string; fingerprint: string }) => {
      const key = operationKey(input);
      const existing = computerOperations.get(key);
      if (!existing || existing.fingerprint !== input.fingerprint || existing.state !== "running") return false;
      computerOperations.delete(key);
      return true;
    },
    settleComputerOperation: (input: { handle: string; sessionId: string; targetId: string; operationId: string; fingerprint: string; state: "applied" | "uncertain" }) => {
      const existing = computerOperations.get(operationKey(input));
      if (!existing || existing.fingerprint !== input.fingerprint) return false;
      if (existing.state === input.state) return true;
      if (existing.state !== "running") return false;
      existing.state = input.state;
      existing.updatedAt = new Date().toISOString();
      return true;
    },
  } as unknown as LocalStore;
  const server = createM9rMcpServer({ store, web, now, monotonicNow });
  const tools = (server as unknown as ToolServer)._registeredTools;
  return {
    server,
    tools,
    call: (name: string, args: unknown) => tools[name]!.handler(args),
  };
}

// The test exercises several distinct MCP envelopes and narrows only the fields under assertion.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic test-only JSON assertion envelope
type AssertionBody = Record<string, any>;

function body(reply: ToolReply): AssertionBody {
  const text = reply.content.find((part) => part.type === "text")?.text;
  assert.ok(text, "tool response includes JSON text");
  return JSON.parse(text) as AssertionBody;
}

function browserSnapshot(index: number) {
  const ref = `e${index.toString(16).padStart(24, "0")}_1`;
  return {
    url: "https://example.test/",
    title: "Example",
    text: "Search page",
    nativeClickAvailable: true,
    elements: [{ ref, role: "textbox", name: "Search", rect: { x: 10, y: 20, width: 120, height: 24 }, sensitive: false }],
  };
}

test("browser observations advertise clicks only when the broker confirms a native click route", async (t) => {
  for (const [label, nativeClickAvailable] of [["explicitly unavailable", false], ["unknown", undefined]] as const) {
    await t.test(label, async (subtest) => {
      const requests: Array<Record<string, unknown>> = [];
      const web: WebBrokerClient = {
        run: async (request) => {
          requests.push(request as unknown as Record<string, unknown>);
          if (request.action === "snapshot") {
            const snapshot = browserSnapshot(1);
            if (nativeClickAvailable === undefined) delete (snapshot as { nativeClickAvailable?: boolean }).nativeClickAvailable;
            else snapshot.nativeClickAvailable = nativeClickAvailable;
            return { ok: true, data: snapshot };
          }
          return { ok: true, data: { clicked: true } };
        },
      };
      const h = createHarness(web);
      subtest.after(async () => { await h.server.close(); });

      const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "research" }));
      for (const capability of [
        "input.click.point", "input.click.middle", "input.click.right", "input.click.element", "input.click.double.element",
      ]) {
        assert.equal(observed.target.capabilities.includes(capability), false,
          `${capability} must not be advertised when the page route has no confirmed native-click backend`);
      }
      assert.ok(observed.target.capabilities.includes("input.key"), "unrelated supported capabilities remain available");
      assert.ok(observed.target.capabilities.includes("observe.dom"));

      const refused = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
        operationId: `no-native-click-${label.replaceAll(" ", "-")}`,
        targetId: observed.target.targetId,
        targetRevision: observed.target.revision,
        kind: "click",
        locator: { kind: "element", ref: observed.observation.elements[0].ref, snapshotId: observed.target.revision },
      } });
      assert.equal(body(refused).result.dispatchStatus, "not-dispatched");
      assert.match(body(refused).result.error.message, /m9r_stage_app.*app-window/i,
        "an unavailable page click should direct the agent to the generic browser-window route");
      assert.match(body(refused).nextStep, /not dispatched.*m9r_stage_app.*app-window.*fresh/i,
        "the fallback must be an explicit fresh route transition, never an automatic retry");
      assert.equal(requests.filter((request) => request.action !== "snapshot").length, 0,
        "an unavailable browser click is refused before broker dispatch");
    });
  }
});

test("app-window observations are structure-first and semantic clicks stay on the OS CUA route", async (t) => {
  const stageActions: Array<{ action: unknown; operationId?: string }> = [];
  const structure = {
    status: "complete",
    capturedAt: new Date().toISOString(),
    appName: "chrome.exe",
    windowTitle: "Example Domain",
    elements: [
      { ref: "01234567-89ab-4cde-8fab-0123456789aa", role: "window", label: "Example Domain", depth: 0, enabled: true, actions: [] },
      { ref: "01234567-89ab-4cde-8fab-0123456789ab", parentRef: "01234567-89ab-4cde-8fab-0123456789aa",
        role: "link", label: "Learn more", depth: 1, enabled: true, actions: ["click"] },
    ],
  };
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "the extension browser route must not receive this app-window test" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action, _mode, operationId) => {
      stageActions.push({ action, operationId });
      const kind = (action as { kind?: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      if (kind === "read_structure") return { ok: true, result: structure };
      if (kind === "click_element") return { ok: true, result: {
        capture: { dataUrl: "data:image/png;base64,", width: 640, height: 480, capturedAt: new Date().toISOString(),
          accessibilityStatus: "complete", structure },
        actionExecuted: true, outcome: { status: "confirmed" }, operationReceipt: { status: "applied" },
      } };
      return { ok: false, error: `unexpected stage action ${String(kind)}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T902", mode: "owner-preview",
  }));
  assert.equal(observed.observation.structure.status, "complete");
  assert.equal(observed.observation.structure.windowTitle, "Example Domain");
  assert.equal("data" in observed.observation, false);
  assert.equal(observed.image, undefined);
  const root = observed.observation.structure.elements.find((element: { label?: string }) => element.label === "Example Domain");
  const link = observed.observation.structure.elements.find((element: { label?: string }) => element.label === "Learn more");
  assert.ok(root);
  assert.ok(link);
  assert.equal(link.parentRef, root.ref, "native UIA parent-child relationships survive the generic contract");
  assert.notEqual(link.ref, "01234567-89ab-4cde-8fab-0123456789ab", "driver tokens stay private behind generic refs");
  assert.equal("rect" in link, false, "structured observations do not leak coordinate controls");
  assert.ok(observed.target.capabilities.includes("input.click.element"));

  const clicked = body(await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "semantic-site-link",
    targetId: observed.target.targetId,
    targetRevision: observed.target.revision,
    kind: "click",
    locator: { kind: "element", ref: link.ref, snapshotId: observed.target.revision },
    postcondition: { kind: "accessible-control-present", label: "Learn more" },
  } }));
  assert.equal(clicked.result.dispatchStatus, "dispatched");
  assert.equal(clicked.result.effectStatus, "verified");
  assert.deepEqual(stageActions.map(({ action }) => (action as { kind: string }).kind), ["read_structure", "window_status", "click_element"]);
  assert.equal(stageActions[2]?.operationId, "semantic-site-link");
});

test("same-target observations report semantic change status without treating fresh revisions as UI changes", async (t) => {
  let structure: Record<string, unknown> = {
    status: "complete",
    capturedAt: new Date().toISOString(),
    appName: "notepad.exe",
    windowTitle: "Untitled",
    elements: [{ ref: "driver-root", role: "window", label: "Untitled", depth: 0, enabled: true, actions: [] }],
  };
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "unused browser route" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind?: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      if (kind === "read_structure") return { ok: true, result: structure };
      return { ok: false, error: `unexpected stage action ${String(kind)}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const first = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview" }));
  const second = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview" }));
  assert.equal(first.observation.structure.change.status, "initial");
  assert.notEqual(first.target.revision, second.target.revision, "freshness revisions remain unique per observation");
  assert.equal(second.observation.structure.change.status, "unchanged");
  assert.equal(second.observation.structure.change.comparedToRevision, first.target.revision);
  assert.deepEqual(second.observation.structure.change.counts, { added: 0, removed: 0, updated: 0 });

  structure = {
    ...structure,
    elements: [{ ref: "another-driver-root", role: "window", label: "Untitled", depth: 0, enabled: true, actions: [] }],
  };
  const refOnly = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview" }));
  assert.equal(refOnly.observation.structure.change.status, "unchanged", "opaque driver refs are not semantic changes");
  assert.deepEqual(refOnly.observation.structure.change.counts, { added: 0, removed: 0, updated: 0 });

  structure = {
    ...structure,
    elements: [{ ref: "new-driver-root", role: "window", label: "Renamed", depth: 0, enabled: true, actions: ["click"] }],
  };
  const third = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview" }));
  assert.equal(third.observation.structure.change.status, "changed");
  assert.deepEqual(third.observation.structure.change.counts, { added: 1, removed: 1, updated: 0 });
});

test("incomplete structure observations never claim semantic equality", async (t) => {
  const structure = {
    status: "partial",
    capturedAt: new Date().toISOString(),
    appName: "notepad.exe",
    windowTitle: "Untitled",
    elements: [{ ref: "partial-root", role: "window", label: "Untitled", depth: 0, enabled: true, actions: [] }],
  };
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "unused browser route" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind?: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      if (kind === "read_structure") return { ok: true, result: structure };
      if (kind === "capture") return { ok: true, result: {
        dataUrl: "data:image/png;base64,", width: 640, height: 480, capturedAt: structure.capturedAt, structure,
      } };
      return { ok: false, error: `unexpected stage action ${String(kind)}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const first = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T905", mode: "owner-preview" }));
  const second = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T905", mode: "owner-preview" }));
  assert.equal(first.observation.structure.change.status, "unknown");
  assert.equal(second.observation.structure.change.status, "unknown");
  assert.equal(second.observation.structure.change.geometry.status, "unknown");
});

test("visual fallback geometry is tracked separately from semantic structure", async (t) => {
  let x = 10;
  const structure = () => ({
    status: "partial",
    capturedAt: new Date().toISOString(),
    appName: "notepad.exe",
    windowTitle: "Untitled",
    elements: [{ ref: "driver-root", role: "window", label: "Untitled", depth: 0, enabled: true, actions: [] }],
    fallbackCapture: {
      dataUrl: "data:image/png;base64,", width: 640, height: 480, capturedAt: new Date().toISOString(),
      controls: [{ elementRef: "driver-root", role: "window", label: "Untitled", rect: { x, y: 10, width: 200, height: 100 } }],
    },
  });
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "unused browser route" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind?: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      if (kind === "read_structure") return { ok: true, result: structure() };
      return { ok: false, error: `unexpected stage action ${String(kind)}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const first = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T906", mode: "owner-preview" }));
  x = 40;
  const second = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T906", mode: "owner-preview" }));
  assert.equal(second.observation.structure.change.status, "unknown", "partial structure does not become semantically trusted because geometry changed");
  assert.equal(first.observation.structure.change.geometry.status, "initial");
  assert.equal(second.observation.structure.change.geometry.status, "changed");
});

test("an observation that silently drops elements past 200 is reported partial, never complete", async (t) => {
  const structure = {
    status: "complete",
    capturedAt: new Date().toISOString(),
    appName: "chrome.exe",
    windowTitle: "Huge Tree",
    elements: Array.from({ length: 250 }, (_, i) => ({ ref: `item-${i}`, role: "text", label: `item ${i}`, depth: 0, enabled: true, actions: [] })),
  };
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "the extension browser route must not receive this app-window test" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind?: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      if (kind === "read_structure") return { ok: true, result: structure };
      return { ok: false, error: `unexpected stage action ${String(kind)}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T903", mode: "owner-preview",
  }));
  assert.equal(observed.observation.structure.elements.length, 200, "the wrapper's own cap still applies");
  assert.equal(observed.observation.structure.status, "partial",
    "a driver status of complete must be downgraded once this wrapper's own 200-element cap drops elements, so callers never trust an undercounted tree as complete");
});

test("explicit app-window focus stays on the OS route for configured and arbitrary provider identities", async (t) => {
  const stageActions: Array<{ token: string; action: unknown }> = [];
  const browserActions: string[] = [];
  const structure = { status: "complete", capturedAt: new Date().toISOString(), appName: "chrome.exe", windowTitle: "Example Domain", elements: [] };
  const web: WebBrokerClient = {
    run: async (request) => { browserActions.push(request.action); return { ok: false, error: "OS focus must never invoke the extension route" }; },
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (token, _taskId, action, _mode, operationId) => {
      stageActions.push({ token, action });
      const kind = (action as { kind: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      if (kind === "read_structure") return { ok: true, result: structure };
      if (kind === "focus") return { ok: true, result: {
        capture: { dataUrl: "data:image/png;base64,", width: 640, height: 480, capturedAt: new Date().toISOString(),
          accessibilityStatus: "complete", structure },
        actionExecuted: true, outcome: { status: "confirmed", summary: "exact app window is foreground" },
        operationReceipt: { status: "applied", operationId },
      } };
      return { ok: false, error: `unexpected stage action ${kind}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  for (const [token, taskId] of [[TOKEN_A, "focus-codex"], [TOKEN_B, "focus-claude"], [TOKEN_LOCAL, "focus-hermes"]]) {
    const observed = body(await h.call("m9r_computer_observe", { token, target: "app-window", taskId, mode: "owner-preview" }));
    assert.ok(observed.target.capabilities.includes("input.focus"), "the exact app-window route advertises its implemented focus capability");
    const reply = body(await h.call("m9r_computer_action", { token, action: {
      operationId: `focus-${taskId}`, targetId: observed.target.targetId, targetRevision: observed.target.revision,
      kind: "focus",
    } }));
    assert.equal(reply.result.routeId, "m9r-desktop-stage");
    assert.equal(reply.result.dispatchStatus, "dispatched");
    assert.equal(reply.result.effectStatus, "observed");
  }

  assert.deepEqual(stageActions.map(({ action }) => (action as { kind: string }).kind), [
    "read_structure", "window_status", "focus", "read_structure", "window_status", "focus", "read_structure", "window_status", "focus",
  ]);
  assert.deepEqual(stageActions.filter(({ action }) => (action as { kind: string }).kind === "focus")
    .map(({ action }) => action), [
    { kind: "focus", view: "app", confirmFocusForeground: true },
    { kind: "focus", view: "app", confirmFocusForeground: true },
    { kind: "focus", view: "app", confirmFocusForeground: true },
  ]);
  assert.deepEqual(browserActions, [], "native app focus never dispatches through the extension/browser adapter");
});

test("app-window screenshot is returned only as the same-call fallback for an incomplete UIA tree", async (t) => {
  const calls: string[] = [];
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "browser route must not receive app-window fallback" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      calls.push(kind);
      if (kind !== "read_structure") return { ok: false, error: `unexpected ${kind}`, dispatchState: "not-dispatched" };
      return { ok: true, result: {
        status: "partial", capturedAt: new Date().toISOString(), elements: [],
        fallbackCapture: { dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==", width: 640, height: 480,
          capturedAt: new Date().toISOString(), accessibilityStatus: "partial", controls: [] },
      } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const reply = await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview",
  });
  const repeated = body(reply);
  assert.equal(repeated.observation.structure.status, "partial");
  assert.ok(reply.content.some((part) => part.type === "image"), "visual fallback is available for incomplete accessibility");
  assert.equal("fallbackCapture" in repeated.observation.structure, false, "internal screenshot bytes are not embedded in structure JSON");
  assert.equal(JSON.stringify(repeated).includes("c2NyZWVuc2hvdA=="), false, "image bytes are returned only as image content");
  assert.deepEqual(calls, ["read_structure"], "the incomplete tree and its screenshot fallback share one capture");
});

test("explicit visual observation requests one exact app-window screenshot", async (t) => {
  const calls: string[] = [];
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "browser route must not receive visual app-window capture" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      calls.push(kind);
      if (kind === "capture") return { ok: true, result: { capture: {
        dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==", width: 640, height: 480,
        capturedAt: new Date().toISOString(), accessibilityStatus: "complete", controls: [],
      } } };
      return { ok: false, error: `unexpected ${kind}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const reply = await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T905", mode: "owner-preview", representation: "visual",
  });
  const observed = body(reply);
  assert.deepEqual(calls, ["capture"]);
  assert.ok(reply.content.some((part) => part.type === "image"));
  assert.equal(observed.observation.capture.accessibilityStatus, "complete");
});

test("oversized visual fallbacks are bounded instead of flooding the provider turn", async (t) => {
  const calls: string[] = [];
  const oversized = `data:image/png;base64,${"a".repeat(700_000)}`;
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "browser route must not receive app-window fallback" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      calls.push(kind);
      if (kind !== "read_structure") return { ok: false, error: `unexpected ${kind}`, dispatchState: "not-dispatched" };
      return { ok: true, result: {
        status: "partial", capturedAt: new Date().toISOString(), elements: [],
        fallbackCapture: { dataUrl: oversized, width: 1024, height: 768, capturedAt: new Date().toISOString(), accessibilityStatus: "partial", controls: [] },
      } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const reply = await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T906", mode: "owner-preview",
  });
  const observed = body(reply) as { imageDelivery?: { status: string; omitted: number; delivered: number } };
  assert.deepEqual(calls, ["read_structure"]);
  assert.equal(reply.content.some((part) => part.type === "image"), false);
  assert.deepEqual(observed.imageDelivery, { status: "bounded", delivered: 0, omitted: 1, maxBytes: 512 * 1024 });
});

for (const semanticAction of ["expand", "toggle", "select"]) test(`native ${semanticAction} controls advertise and dispatch semantic clicks`, async (t) => {
  const calls: string[] = [];
  const structure = { status: "complete", capturedAt: new Date().toISOString(), elements: [
    { ref: "snapshot:action", role: "TreeItem", label: "Safe control", enabled: true, actions: [semanticAction] },
  ] };
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "wrong route" }),
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      calls.push(kind);
      if (kind === "read_structure") return { ok: true, result: structure };
      return { ok: true, result: { actionExecuted: true, outcome: { status: "confirmed" }, operationReceipt: { status: "applied" } } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });
  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T906", representation: "structured" }));
  assert.ok(observed.target.capabilities.includes("input.click.element"));
  const element = observed.observation.structure.elements[0];
  const reply = body(await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: `semantic-${semanticAction}`, targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "click", locator: { kind: "element", ref: element.ref, snapshotId: observed.target.revision },
  } }));
  assert.equal(reply.result.dispatchStatus, "dispatched");
  assert.ok(calls.includes("click_element"));
});

test("a native verified close is not downgraded by the absence of a post-close screenshot", async (t) => {
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    run: async () => ({ ok: false, error: "wrong route" }),
    taskStageAction: async (_token, _taskId, action) => {
      if ((action as { kind: string }).kind === "capture") return { ok: true, result: { capture: {
        dataUrl: "data:image/png;base64,eA==", width: 200, height: 100, capturedAt: new Date().toISOString(), controls: [],
      } } };
      return { ok: true, result: { actionExecuted: true, operationReceipt: { status: "applied" }, outcome: { status: "confirmed" },
        postcondition: { kind: "window-closed", verified: true, observedAt: new Date().toISOString(), evidenceRef: "native-window-closed-proof" } } };
    },
  };
  const h = createHarness(web); t.after(async () => { await h.server.close(); });
  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "app-window", taskId: "T12", representation: "visual" }));
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "native-close-proof", targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "key", key: "F4", modifiers: ["Alt"], confirmFocusForeground: true,
  } });
  assert.equal(reply.isError, undefined);
  assert.equal(body(reply).result.effectStatus, "verified");
  assert.equal(body(reply).nativePostcondition.kind, "window-closed");
});

test("desktop field replacement dispatches by fresh UIA element ref, not a derived point", async (t) => {
  const stageActions: Array<{ kind: string; operationId?: string }> = [];
  const structure = { status: "complete", capturedAt: new Date().toISOString(), appName: "notepad.exe", windowTitle: "Untitled",
    elements: [{ ref: "11234567-89ab-4cde-8fab-0123456789ab", role: "Edit", label: "Document", depth: 1,
      enabled: true, actions: ["click", "set_value"], canReplaceValue: true }] };
  const web: WebBrokerClient = {
    run: async () => ({ ok: false, error: "extension/browser route must not receive native field replacement" }),
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, _taskId, action, _mode, operationId) => {
      const kind = (action as { kind: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      stageActions.push({ kind, operationId });
      if (kind === "read_structure") return { ok: true, result: structure };
      if (kind === "replace_element") return { ok: true, result: {
        capture: { dataUrl: "data:image/png;base64,", width: 640, height: 480, capturedAt: new Date().toISOString(),
          accessibilityStatus: "complete", structure },
        actionExecuted: true, outcome: { status: "confirmed" }, operationReceipt: { status: "applied" },
      } };
      return { ok: false, error: `unexpected stage action ${kind}`, dispatchState: "not-dispatched" };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T906", mode: "owner-preview",
  }));
  const field = observed.observation.structure.elements[0];
  const updated = body(await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "semantic-field-replace", targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "text", mode: "replace", text: "scratch only",
    locator: { kind: "element", ref: field.ref, snapshotId: observed.target.revision },
  } }));
  assert.equal(updated.result.dispatchStatus, "dispatched");
  assert.equal(updated.result.effectStatus, "observed");
  assert.deepEqual(stageActions.map(({ kind }) => kind), ["read_structure", "replace_element"]);
  assert.equal(stageActions[1]?.operationId, "semantic-field-replace");
});

test("browser observations preserve safe DOM parent-child relationships", async (t) => {
  const web: WebBrokerClient = {
    run: async (request) => request.action === "snapshot" ? { ok: true, data: {
      ...browserSnapshot(12),
      elements: [
        { ref: `e${"0".repeat(23)}c_1`, role: "button", name: "Container", depth: 2, actions: ["click"] },
        { ref: `e${"0".repeat(23)}c_2`, role: "link", name: "Open details", parentRef: `e${"0".repeat(23)}c_1`,
          depth: 3, actions: ["click"], sensitive: false },
      ],
    } } : { ok: true, data: {} },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab" }));
  assert.equal(observed.observation.elements[1].parentRef, observed.observation.elements[0].ref);
  assert.equal(observed.observation.elements[1].depth, 3);
  assert.deepEqual(observed.observation.elements[1].actions, ["click"]);
});

test("an unavailable browser click can continue on a freshly observed exact app-window route without duplicate dispatch", async (t) => {
  const browserRequests: Array<Record<string, unknown>> = [];
  const stageApps: Array<Record<string, unknown>> = [];
  const stageActions: Array<{ taskId: string; action: unknown; operationId?: string }> = [];
  const capture = {
    dataUrl: "data:image/png;base64,",
    width: 640,
    height: 480,
    capturedAt: new Date().toISOString(),
    accessibilityStatus: "complete",
    controls: [{ role: "button", label: "Search", rect: { x: 40, y: 60, width: 100, height: 30 } }],
  };
  const web: WebBrokerClient = {
    run: async (request) => {
      browserRequests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: {
        ...browserSnapshot(9), nativeClickAvailable: false,
      } };
      return { ok: false, error: "no browser action should reach this route" };
    },
    taskStageApp: async (_token, taskId, appId, mode, operationId) => {
      stageApps.push({ taskId, appId, mode, operationId });
      return { ok: true, result: { running: true, reused: true, view: "app" } };
    },
    prepareTaskStage: async () => ({ ok: true, result: { prepared: true } }),
    taskStageAction: async (_token, taskId, action, _mode, operationId) => {
      stageActions.push({ taskId, action, operationId });
      return { ok: true, result: {
        capture,
        actionExecuted: (action as { kind?: string }).kind !== "capture",
        ...( (action as { kind?: string }).kind === "capture" ? {} : { outcome: { status: "confirmed" } }),
        ...((action as { kind?: string }).kind === "capture" ? {} : { operationReceipt: { status: "applied" } }),
      } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const browser = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "browser-tab", tab: "research",
  }));
  const refused = body(await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-click-unavailable",
    targetId: browser.target.targetId,
    targetRevision: browser.target.revision,
    kind: "click",
    locator: { kind: "element", ref: browser.observation.elements[0].ref, snapshotId: browser.target.revision },
  } }));
  assert.equal(refused.result.dispatchStatus, "not-dispatched");
  assert.match(refused.nextStep, /not dispatched.*m9r_stage_app.*app-window.*fresh/i);
  assert.equal(browserRequests.filter((request) => request.action !== "snapshot").length, 0);
  assert.equal(stageActions.length, 0, "the failed browser attempt does not dispatch to the desktop route");

  const selected = body(await h.call("m9r_stage_app", {
    token: TOKEN_A, taskId: "T901", operation: "launch", appId: "chrome", mode: "owner-preview", operationId: "select-browser-window",
  }));
  assert.equal(selected.ok, true);
  const freshWindow = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T901", mode: "owner-preview", representation: "visual",
  }));
  assert.equal(freshWindow.target.kind, "desktop-window");
  assert.equal(freshWindow.observation.capture.accessibilityStatus, "complete");
  const search = freshWindow.observation.controls.find((control: { label?: string }) => control.label === "Search");
  assert.ok(search);

  const clicked = body(await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "app-window-search-click",
    targetId: freshWindow.target.targetId,
    targetRevision: freshWindow.target.revision,
    kind: "click",
    locator: { kind: "element", ref: search.ref, snapshotId: freshWindow.target.revision },
  } }));
  assert.equal(clicked.result.dispatchStatus, "dispatched");
  assert.equal(clicked.result.routeId, "m9r-desktop-stage");
  assert.deepEqual(stageApps, [{ taskId: "T901", appId: "chrome", mode: "owner-preview", operationId: "select-browser-window" }]);
  assert.equal(stageActions.filter(({ action }) => (action as { kind?: string }).kind === "click").length, 1,
    "the action is dispatched once, only after replanning from the fresh exact-window observation");
  assert.deepEqual(browserRequests.filter((request) => request.action !== "snapshot"), []);
});

test("generic browser observations route through the existing M9R browser broker and refresh refs after actions", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: browserSnapshot(++snapshots) };
      return { ok: true, data: { clicked: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const initialReply = await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "browser-tab", tab: "research", mode: "owner-preview",
  });
  assert.equal(initialReply.isError, undefined);
  const initial = body(initialReply);
  assert.equal(initial.target.kind, "browser-tab");
  assert.equal(initial.target.tabId, undefined, "the router does not invent a browser tab/process ID the broker did not provide");
  assert.ok(initial.target.capabilities.includes("input.click.element"));
  assert.equal(requests[0]?.action, "snapshot");
  assert.equal(requests[0]?.agent, "codex");
  assert.equal(requests[0]?.tab, "research");

  const ref = initial.observation.elements[0].ref as string;
  const actionReply = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "browser-click-1",
      targetId: initial.target.targetId,
      targetRevision: initial.target.revision,
      kind: "click",
      locator: { kind: "element", ref, snapshotId: initial.target.revision },
    },
  });
  assert.equal(actionReply.isError, undefined);
  const acted = body(actionReply);
  assert.equal(acted.result.routeId, "m9r-browser-broker");
  assert.equal(acted.result.dispatchStatus, "dispatched");
  assert.equal(acted.result.effectStatus, "observed", "post-action DOM observation is not called verified");
  assert.equal(acted.result.operationReceipt.status, "applied");
  assert.notEqual(acted.target.revision, initial.target.revision);
  assert.equal(requests[1]?.action, "click");
  assert.equal(requests[1]?.selector, `@m9r-ref:${ref}`);
  assert.equal(requests[1]?.sessionId, "session-a");
  assert.equal(requests[2]?.action, "snapshot", "the broker is asked for a new snapshot after dispatch");

  const replayReply = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "browser-click-1",
      targetId: initial.target.targetId,
      targetRevision: initial.target.revision,
      kind: "click",
      locator: { kind: "element", ref, snapshotId: initial.target.revision },
    },
  });
  assert.equal(replayReply.isError, undefined);
  assert.equal(body(replayReply).result.operationReceipt.status, "applied");
  assert.equal(body(replayReply).result.effectStatus, "observed");
  assert.equal(requests[3]?.action, "snapshot", "same-ID recovery observes without redispatching the click");
  assert.equal(requests.filter((request) => request.action === "click").length, 1);

  const reusedId = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-click-1", targetId: initial.target.targetId, targetRevision: initial.target.revision,
    kind: "key", key: "Enter",
  } });
  assert.equal(reusedId.isError, true);
  assert.equal(body(reusedId).result.error.code, "operation-id-conflict");
  assert.equal(requests.length, 4, "reusing an operation ID for different input is rejected before dispatch");

  const staleReply = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "browser-click-stale",
      targetId: initial.target.targetId,
      targetRevision: initial.target.revision,
      kind: "click",
      locator: { kind: "element", ref, snapshotId: initial.target.revision },
    },
  });
  assert.equal(staleReply.isError, true);
  assert.equal(body(staleReply).result.error.code, "stale-observation");
  assert.equal(requests[4]?.action, "snapshot", "a stale action returns a fresh observation without dispatching input");
  assert.equal(body(staleReply).result.dispatchStatus, "not-dispatched");
  assert.equal(requests.filter((request) => request.action === "click").length, 1, "stale refs never reach the broker as input");

  const otherSessionReply = await h.call("m9r_computer_action", {
    token: TOKEN_B,
    action: {
      operationId: "cross-session-click",
      targetId: acted.target.targetId,
      targetRevision: acted.target.revision,
      kind: "click",
      locator: { kind: "element", ref: acted.observation.elements[0].ref, snapshotId: acted.target.revision },
    },
  });
  assert.equal(otherSessionReply.isError, true);
  assert.equal(body(otherSessionReply).result.error.code, "target-not-found");
  assert.equal(requests.length, 5, "observation handles are bound to the verified M9R session");
});

test("browser observation freshness is anchored before the broker roundtrip, not when its response returns", async (t) => {
  let clock = 1_797_000_000_000;
  const capturedAt = clock;
  const web: WebBrokerClient = {
    run: async (request) => {
      if (request.action !== "snapshot") return { ok: true, data: {} };
      // Model a snapshot captured when requested but delayed in transit beyond
      // the generic router's 30-second observation freshness window.
      const data = browserSnapshot(1);
      clock += 31_000;
      return { ok: true, data };
    },
  };
  const h = createHarness(web, () => new Date(clock));
  t.after(async () => { await h.server.close(); });

  const reply = await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab" });
  const target = body(reply).target;
  assert.equal(target.observedAt, capturedAt, "a delayed broker response must not reset the target's freshness clock");
  assert.equal(isComputerUseTargetFresh(target, clock, 30_000), false,
    "the delayed target must be stale at response time rather than receiving a fresh 30-second window");
});

test("browser point, button, key, and navigation capabilities map to their registered broker actions", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: browserSnapshot(++snapshots) };
      return { ok: true, data: { dispatched: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  let current = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab" }));
  assert.ok(current.target.capabilities.includes("input.click.point"));
  assert.ok(current.target.capabilities.includes("input.click.middle"));
  assert.ok(current.target.capabilities.includes("input.click.right"));
  assert.ok(current.target.capabilities.includes("input.click.double.element"));
  const act = async (action: Record<string, unknown>) => {
    const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
      operationId: `browser-matrix-${requests.filter((request) => request.action !== "snapshot").length + 1}`,
      targetId: current.target.targetId, targetRevision: current.target.revision, ...action,
    } });
    assert.equal(reply.isError, undefined);
    current = body(reply);
  };

  await act({ kind: "click", locator: { kind: "point", x: 25, y: 35, coordinateSpace: "page-viewport" } });
  const doubleClickRef = current.observation.elements[0].ref as string;
  await act({ kind: "click", locator: { kind: "element", ref: doubleClickRef, snapshotId: current.target.revision }, count: 2 });
  const rightClickRef = current.observation.elements[0].ref as string;
  await act({ kind: "click", locator: { kind: "element", ref: rightClickRef, snapshotId: current.target.revision }, button: "right" });
  await act({ kind: "click", locator: { kind: "point", x: 26, y: 36, coordinateSpace: "page-viewport" }, button: "middle" });
  await act({ kind: "click", locator: { kind: "point", x: 27, y: 37, coordinateSpace: "page-viewport" }, button: "right" });

  const inputRequests = requests.filter((request) => request.action !== "snapshot");
  assert.deepEqual(inputRequests.map((request) => request.action), ["click_at", "double_click", "right_click", "click_at", "click_at"]);
  assert.deepEqual(inputRequests[0]?.args, { x: 25, y: 35, button: "left" });
  assert.equal(inputRequests[1]?.selector, `@m9r-ref:${doubleClickRef}`);
  assert.equal(inputRequests[2]?.selector, `@m9r-ref:${rightClickRef}`);
  assert.deepEqual(inputRequests[3]?.args, { x: 26, y: 36, button: "middle" });
  assert.deepEqual(inputRequests[4]?.args, { x: 27, y: 37, button: "right" });
});

test("browser key and navigation capabilities dispatch only through the browser broker", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: { url: "https://example.test/", title: "Empty", text: "", elements: [] } };
      return { ok: true, data: { dispatched: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  let current = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab" }));
  assert.ok(current.target.capabilities.includes("input.key"));
  assert.ok(current.target.capabilities.includes("browser.navigate"));
  assert.equal(current.target.capabilities.includes("input.click.element"), false);
  const keyReply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-empty-page-key", targetId: current.target.targetId, targetRevision: current.target.revision,
    kind: "key", key: "Enter",
  } });
  assert.equal(keyReply.isError, undefined);
  current = body(keyReply);
  const navigateReply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-empty-page-navigate", targetId: current.target.targetId, targetRevision: current.target.revision,
    kind: "navigate", url: "https://example.test/next",
  } });
  assert.equal(navigateReply.isError, undefined);
  const inputs = requests.filter((request) => request.action !== "snapshot");
  assert.deepEqual(inputs.map((request) => request.action), ["press", "open"]);
  assert.deepEqual(inputs[0]?.args, { key: "Enter" });
  assert.equal(inputs[1]?.url, "https://example.test/next");
});

test("generic computer-use reports phase timings and whether a durable receipt was replayed", async (t) => {
  let snapshots = 0;
  let clock = 0;
  const web: WebBrokerClient = {
    run: async (request) => request.action === "snapshot"
      ? { ok: true, data: browserSnapshot(++snapshots) }
      : { ok: true, data: { clicked: true } },
  };
  const h = createHarness(web, () => new Date(), () => ++clock);
  t.after(async () => { await h.server.close(); });

  const initial = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "browser-tab", tab: "timing",
  }));
  assert.equal(computerUseTelemetrySchema.safeParse(initial.telemetry).success, true);
  assert.equal(initial.telemetry.priorReceiptFound, false);
  assert.ok(Number.isFinite(initial.telemetry.timingsMs.totalMs));
  assert.ok(Number.isFinite(initial.telemetry.timingsMs.observationMs));

  const action = {
    operationId: "timing-click-1",
    targetId: initial.target.targetId,
    targetRevision: initial.target.revision,
    kind: "click" as const,
    locator: { kind: "element" as const, ref: initial.observation.elements[0].ref as string, snapshotId: initial.target.revision },
    postcondition: { kind: "visible-text-contains" as const, text: "Search" },
  };
  const first = body(await h.call("m9r_computer_action", { token: TOKEN_A, action }));
  assert.equal(first.result.effectStatus, "verified");
  assert.equal(first.telemetry.priorReceiptFound, false);
  for (const phase of ["routingMs", "actionMs", "observationMs", "verificationMs", "totalMs"]) {
    assert.ok(Number.isFinite(first.telemetry.timingsMs[phase]), `${phase} is measured for a verified browser action`);
    assert.ok(first.telemetry.timingsMs[phase] >= 0, `${phase} is a non-negative duration`);
  }

  const replay = body(await h.call("m9r_computer_action", { token: TOKEN_A, action }));
  assert.equal(computerUseTelemetrySchema.safeParse(replay.telemetry).success, true);
  assert.equal(replay.telemetry.priorReceiptFound, true, "same-ID receipt recovery is visible as a replay, not a new dispatch");
  assert.ok(Number.isFinite(replay.telemetry.timingsMs.totalMs));
});

test("generic browser URL postconditions report a confirmed mismatch instead of success", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      return request.action === "snapshot"
        ? { ok: true, data: { ...browserSnapshot(++snapshots), url: "https://example.test/current" } }
        : { ok: true, data: { navigated: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });
  const observed = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "browser-tab", tab: "postcondition-mismatch",
  }));
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "url-postcondition-mismatch",
    targetId: observed.target.targetId,
    targetRevision: observed.target.revision,
    kind: "navigate",
    url: "https://example.test/expected",
    postcondition: { kind: "url-equals", url: "https://example.test/expected" },
  } });
  assert.equal(reply.isError, true);
  assert.equal(body(reply).result.dispatchStatus, "dispatched");
  assert.equal(body(reply).result.effectStatus, "mismatch");
  assert.equal(body(reply).result.error.code, "postcondition-mismatch");
  assert.equal(requests.filter((request) => request.action === "open").length, 1);
});

test("an accessibility-poor browser keeps only page-level capabilities and never borrows desktop input", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: {
        url: "https://example.test/canvas", title: "Canvas", text: "Canvas surface", nativeClickAvailable: true, elements: [],
      } };
      return { ok: true, data: { dispatched: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "canvas" }));
  assert.deepEqual(observed.observation.elements, []);
  assert.ok(observed.target.capabilities.includes("input.click.point"));
  assert.ok(observed.target.capabilities.includes("input.key"));
  for (const capability of ["input.click.element", "input.text.replace", "input.select-text.text", "input.drag"]) {
    assert.equal(observed.target.capabilities.includes(capability), false,
      `an empty accessibility snapshot must not advertise ${capability}`);
  }

  const clicked = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "canvas-point-click", targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "click", locator: { kind: "point", x: 35, y: 42, coordinateSpace: "page-viewport" },
  } });
  assert.equal(clicked.isError, undefined);
  const afterClick = body(clicked);
  assert.equal(afterClick.result.routeId, "m9r-browser-broker");
  const keyed = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "canvas-key", targetId: afterClick.target.targetId, targetRevision: afterClick.target.revision,
    kind: "key", key: "Enter",
  } });
  assert.equal(keyed.isError, undefined);
  assert.deepEqual(requests.filter((request) => request.action !== "snapshot").map((request) => request.action), ["click_at", "press"]);
  assert.equal(requests.filter((request) => request.action !== "snapshot").every((request) => request.agent === "codex"), true);
});

test("a restricted browser surface refuses at observation and never falls back to desktop input", async (t) => {
  let browserSnapshots = 0;
  let desktopPrepares = 0;
  let desktopActions = 0;
  const web: WebBrokerClient = {
    run: async (request) => {
      if (request.action === "snapshot") {
        browserSnapshots += 1;
        return { ok: false, error: "Cannot access a chrome:// URL: restricted_page" };
      }
      return { ok: false, error: "No browser input should be dispatched" };
    },
    prepareTaskStage: async () => { desktopPrepares += 1; return { ok: true }; },
    taskStageAction: async () => { desktopActions += 1; return { ok: false, error: "No desktop action should be dispatched" }; },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const reply = await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "restricted" });
  assert.equal(reply.isError, true);
  assert.match(body(reply).error, /restricted_page/);
  assert.equal(browserSnapshots, 1);
  assert.equal(desktopPrepares, 0);
  assert.equal(desktopActions, 0);
});

test("browser capabilities follow fresh accessible controls and replacement is limited to editable roles", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let snapshotIndex = 0;
  const snapshots = [
    { url: "https://example.test/", title: "Buttons only", text: "Save", elements: [
      { ref: `${REF_PREFIX}_1`, role: "button", name: "Save", sensitive: false },
    ] },
    { url: "https://example.test/", title: "Editable field", text: "Search", elements: [
      { ref: `${REF_PREFIX}_2`, role: "input", name: "Search", rect: { x: 10, y: 40, width: 120, height: 24 }, sensitive: false, canReplaceValue: true },
    ] },
    { url: "https://example.test/", title: "Disabled field", text: "Search", elements: [
      { ref: `${REF_PREFIX}_3`, role: "textbox", name: "Search", rect: { x: 10, y: 70, width: 120, height: 24 }, sensitive: false, disabled: true, canReplaceValue: false },
    ] },
    { url: "https://example.test/", title: "Drag targets", text: "Source Destination", elements: [
      { ref: `${REF_PREFIX}_4`, role: "button", name: "Source", rect: { x: 10, y: 100, width: 60, height: 24 }, sensitive: false, canSelectText: true },
      { ref: `${REF_PREFIX}_5`, role: "button", name: "Destination", rect: { x: 100, y: 100, width: 80, height: 24 }, sensitive: false, canSelectText: true },
    ] },
  ];
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: {
        ...snapshots[Math.min(snapshotIndex++, snapshots.length - 1)], nativeClickAvailable: true,
      } };
      return { ok: true, data: { typed: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const buttonObservation = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "research" }));
  assert.ok(buttonObservation.target.capabilities.includes("input.click.element"));
  assert.equal(buttonObservation.target.capabilities.includes("input.text.replace"), false, "a button is not an editable target");
  assert.equal(buttonObservation.target.capabilities.includes("input.drag"), false, "one accessible element is insufficient for drag");
  const refused = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "replace-button-1", targetId: buttonObservation.target.targetId, targetRevision: buttonObservation.target.revision,
    kind: "text", mode: "replace", text: "must not type into a button",
    locator: { kind: "element", ref: `${REF_PREFIX}_1`, snapshotId: buttonObservation.target.revision },
  } });
  assert.equal(refused.isError, true);
  assert.equal(body(refused).result.error.code, "unsupported-target-action");
  assert.equal(requests.some((request) => request.action === "type"), false, "incompatible roles must refuse before browser input");

  const middleClick = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "middle-click-without-bounds", targetId: buttonObservation.target.targetId,
    targetRevision: buttonObservation.target.revision, kind: "click", button: "middle",
    locator: { kind: "element", ref: `${REF_PREFIX}_1`, snapshotId: buttonObservation.target.revision },
  } });
  assert.equal(middleClick.isError, true);
  assert.equal(body(middleClick).result.error.code, "unsupported-target-action");
  assert.equal(requests.some((request) => request.action === "click_at"), false, "missing element geometry must refuse before browser input");

  const textboxObservation = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "research" }));
  assert.ok(textboxObservation.target.capabilities.includes("input.text.replace"));
  const replaced = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "replace-textbox-1", targetId: textboxObservation.target.targetId, targetRevision: textboxObservation.target.revision,
    kind: "text", mode: "replace", text: "query",
    locator: { kind: "element", ref: `${REF_PREFIX}_2`, snapshotId: textboxObservation.target.revision },
  } });
  assert.equal(replaced.isError, undefined);
  assert.equal(body(replaced).result.dispatchStatus, "dispatched");
  assert.equal(requests.filter((request) => request.action === "type").length, 1);

  const disabledObservation = body(replaced);
  assert.equal(disabledObservation.target.capabilities.includes("input.text.replace"), false,
    "an explicit non-editable observation overrides its generic textbox role");
  assert.equal(disabledObservation.target.capabilities.includes("input.click.element"), false,
    "disabled controls do not establish an actionable element-click capability");
  assert.equal(disabledObservation.target.capabilities.includes("input.drag"), false,
    "a single disabled control does not establish an actionable drag route");
  const disabledReplace = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "replace-disabled-textbox", targetId: disabledObservation.target.targetId,
    targetRevision: disabledObservation.target.revision, kind: "text", mode: "replace", text: "not sent",
    locator: { kind: "element", ref: `${REF_PREFIX}_3`, snapshotId: disabledObservation.target.revision },
  } });
  assert.equal(disabledReplace.isError, true);
  assert.equal(body(disabledReplace).result.error.code, "unsupported-target-action");
  assert.equal(requests.filter((request) => request.action === "type").length, 1, "explicitly disabled controls never reach the type route");

  const dragObservation = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "research" }));
  assert.ok(dragObservation.target.capabilities.includes("input.drag"), "two fresh, enabled DOM controls support the generic drag route");
  const dragReply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "drag-observed-browser-controls", targetId: dragObservation.target.targetId,
    targetRevision: dragObservation.target.revision, kind: "drag",
    from: { kind: "element", ref: `${REF_PREFIX}_4`, snapshotId: dragObservation.target.revision },
    to: { kind: "element", ref: `${REF_PREFIX}_5`, snapshotId: dragObservation.target.revision },
  } });
  assert.equal(dragReply.isError, undefined);
  assert.equal(body(dragReply).result.routeId, "m9r-browser-broker");
  assert.equal(requests.find((request) => request.action === "drag")?.selector, `@m9r-ref:${REF_PREFIX}_4`);
  assert.equal(requests.find((request) => request.action === "drag")?.endSelector, `@m9r-ref:${REF_PREFIX}_5`);
});

test("generic browser text insertion preserves the caret route through the browser broker", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let snapshotIndex = 0;
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") {
        const ref = `${REF_PREFIX}_${++snapshotIndex}`;
        return { ok: true, data: { url: "https://example.test/", title: "Editor", text: "Draft", elements: [
          { ref, role: "textbox", name: "Editor", sensitive: false, canReplaceValue: true, canInsertText: true },
        ] } };
      }
      return { ok: true, data: { inserted: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observation = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "editor" }));
  assert.ok(observation.target.capabilities.includes("input.text.insert"));
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-caret-insert-1", targetId: observation.target.targetId,
    targetRevision: observation.target.revision, kind: "text", mode: "insert", text: " brave",
    locator: { kind: "element", ref: `${REF_PREFIX}_1`, snapshotId: observation.target.revision },
  } });

  assert.equal(reply.isError, undefined);
  const request = requests.find((item) => item.action === "paste");
  assert.equal(request?.selector, `@m9r-ref:${REF_PREFIX}_1`);
  assert.deepEqual(request?.args, { valueText: " brave" });
  assert.equal(requests.some((item) => item.action === "type"), false, "caret insertion never uses the whole-field replacement route");
});

test("legacy browser snapshots without explicit caret support never advertise or dispatch insertion", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: { url: "https://example.test/", title: "Legacy editor", text: "Draft", elements: [
        { ref: `${REF_PREFIX}_1`, role: "textbox", name: "Editor", sensitive: false, canReplaceValue: true },
      ] } };
      return { ok: true, data: { inserted: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observation = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "legacy-editor" }));
  assert.equal(observation.target.capabilities.includes("input.text.replace"), true);
  assert.equal(observation.target.capabilities.includes("input.text.insert"), false);
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "legacy-browser-caret-insert", targetId: observation.target.targetId,
    targetRevision: observation.target.revision, kind: "text", mode: "insert", text: " appended",
    locator: { kind: "element", ref: `${REF_PREFIX}_1`, snapshotId: observation.target.revision },
  } });
  assert.equal(reply.isError, true);
  assert.equal(body(reply).result.error.code, "unsupported-target-action");
  assert.equal(requests.some((request) => request.action === "paste"), false);
});

test("a browser target that supports replacement but not caret ranges never advertises insertion", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: { url: "https://example.test/", title: "Number field", text: "42", elements: [
        { ref: `${REF_PREFIX}_1`, role: "spinbutton", name: "Quantity", sensitive: false, canReplaceValue: true, canInsertText: false },
      ] } };
      return { ok: true, data: { typed: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observation = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "quantity" }));
  assert.equal(observation.target.capabilities.includes("input.text.replace"), true);
  assert.equal(observation.target.capabilities.includes("input.text.insert"), false);
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-unsupported-caret-insert", targetId: observation.target.targetId,
    targetRevision: observation.target.revision, kind: "text", mode: "insert", text: "3",
    locator: { kind: "element", ref: `${REF_PREFIX}_1`, snapshotId: observation.target.revision },
  } });
  assert.equal(reply.isError, true);
  assert.equal(requests.some((request) => request.action === "paste"), false, "unsupported input semantics must refuse before dispatch");
});

test("the registered desktop-wide target uses the actual desktop-stage route", async (t) => {
  const stageActions: Array<{ action: unknown; mode?: string }> = [];
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 160, height: 90, capturedAt: new Date().toISOString() });
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action, mode) => {
      stageActions.push({ action, mode });
      return (action as { kind?: string }).kind === "capture"
        ? { ok: true, result: { capture: capture() } }
        : { ok: true, result: { capture: capture(), actionExecuted: true, outcome: { status: "confirmed" } } };
    },
    run: async () => ({ ok: false, error: "unused browser broker" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "desktop", taskId: "T22", mode: "owner-preview" }));
  assert.equal(observed.target.kind, "desktop");
  assert.equal(observed.target.capabilities.includes("input.key"), false, "desktop-wide keys require a confirmed target window");
  assert.equal(observed.target.capabilities.includes("input.text.insert"), false, "desktop-wide typing requires a confirmed target window");
  const prematureKey = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-key-before-selection", targetId: observed.target.targetId,
    targetRevision: observed.target.revision, kind: "key", key: "Enter",
  } });
  assert.equal(prematureKey.isError, true);
  assert.match(body(prematureKey).result.error.message, /confirmed target-window selection/);
  assert.equal(stageActions.length, 1, "desktop-wide keys refuse before an input window is selected");
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-wide-point-click", targetId: observed.target.targetId,
    targetRevision: observed.target.revision, kind: "click",
    locator: { kind: "point", x: 22, y: 34, coordinateSpace: "target-local" },
  } });
  assert.equal(reply.isError, undefined);
  assert.equal(body(reply).result.routeId, "m9r-desktop-stage");
  assert.ok(body(reply).target.capabilities.includes("input.key"));
  assert.ok(body(reply).target.capabilities.includes("input.text.insert"));
  assert.deepEqual(stageActions[1], { action: { kind: "click", x: 22, y: 34, view: "desktop" }, mode: "owner-preview" });
});

test("desktop-stage drag preserves an explicitly requested duration", async (t) => {
  const stageActions: Array<{ action: unknown; mode?: string }> = [];
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 160, height: 90, capturedAt: new Date().toISOString() });
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action, mode) => {
      stageActions.push({ action, mode });
      return (action as { kind?: string }).kind === "capture"
        ? { ok: true, result: { capture: capture() } }
        : { ok: true, result: { capture: capture(), actionExecuted: true, outcome: { status: "confirmed" } } };
    },
    run: async () => ({ ok: false, error: "unused browser broker" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "desktop", taskId: "T23", mode: "owner-preview" }));
  assert.ok(observed.target.capabilities.includes("input.drag.duration"));
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-timed-drag", targetId: observed.target.targetId,
    targetRevision: observed.target.revision, kind: "drag", durationMs: 1_250,
    from: { kind: "point", x: 10, y: 12, coordinateSpace: "target-local" },
    to: { kind: "point", x: 100, y: 50, coordinateSpace: "target-local" },
  } });
  assert.equal(reply.isError, undefined);
  assert.equal(body(reply).result.dispatchStatus, "dispatched");
  assert.deepEqual(stageActions[1], { action: {
    kind: "drag", fromX: 10, fromY: 12, toX: 100, toY: 50, durationMs: 1_250, view: "desktop",
  }, mode: "owner-preview" });
});

test("browser drag refuses explicit duration when the page adapter does not advertise it", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: {
        url: "https://example.test/", title: "Drag", text: "Source Destination", elements: [
          { ref: `${REF_PREFIX}_6`, role: "button", name: "Source", rect: { x: 10, y: 10, width: 40, height: 20 }, sensitive: false },
          { ref: `${REF_PREFIX}_7`, role: "button", name: "Destination", rect: { x: 80, y: 10, width: 50, height: 20 }, sensitive: false },
        ],
      } };
      return { ok: true, data: { dragged: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "duration" }));
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-timed-drag", targetId: observed.target.targetId,
    targetRevision: observed.target.revision, kind: "drag", durationMs: 1_250,
    from: { kind: "element", ref: `${REF_PREFIX}_6`, snapshotId: observed.target.revision },
    to: { kind: "element", ref: `${REF_PREFIX}_7`, snapshotId: observed.target.revision },
  } });
  assert.equal(reply.isError, true);
  assert.equal(body(reply).result.dispatchStatus, "not-dispatched");
  assert.equal(body(reply).result.error.code, "unsupported-target-capability");
  assert.equal(requests.filter((request) => request.action === "drag").length, 0,
    "unsupported duration semantics must refuse before the broker can perform an instant drag");
});

test("exact app-window observations stay isolated across tasks and reject refs from an older window snapshot", async (t) => {
  const stageActions: Array<{ taskId: string; action: unknown }> = [];
  const captures = new Map<string, number>();
  const captureFor = (taskId: string) => {
    const sequence = (captures.get(taskId) ?? 0) + 1;
    captures.set(taskId, sequence);
    const label = taskId === "T102" ? `Search ${sequence}` : `Compose ${sequence}`;
    return {
      dataUrl: "data:image/png;base64,eA==", width: 200, height: 100, capturedAt: new Date().toISOString(),
      accessibilityStatus: "partial",
      controls: [{ label, role: "Edit", canReplaceValue: true, rect: { x: taskId === "T102" ? 10 : 100, y: 20, width: 40, height: 12 } }],
    };
  };
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, taskId, action) => {
      const kind = (action as { kind?: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      stageActions.push({ taskId, action });
      if (kind === "capture") return { ok: true, result: { capture: captureFor(taskId) } };
      return { ok: true, result: { capture: captureFor(taskId), actionExecuted: true,
        ...(kind === "click" ? { outcome: { status: "confirmed" } } : {}) } };
    },
    run: async () => ({ ok: false, error: "unused browser route" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const firstWindow = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T102", mode: "owner-preview", representation: "visual",
  }));
  const secondWindow = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T103", mode: "owner-preview", representation: "visual",
  }));
  assert.notEqual(firstWindow.target.targetId, secondWindow.target.targetId, "separate task/window scopes receive separate opaque targets");
  assert.equal(firstWindow.observation.capture.accessibilityStatus, "partial",
    "the generic MCP observation must preserve the desktop adapter's completeness status");

  const clickFirst = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "window-102-click", targetId: firstWindow.target.targetId, targetRevision: firstWindow.target.revision,
    kind: "click", locator: { kind: "element", ref: firstWindow.observation.controls[0].ref, snapshotId: firstWindow.target.revision },
  } });
  assert.equal(clickFirst.isError, undefined);
  assert.deepEqual(stageActions.find((entry) => (entry.action as { kind?: string }).kind === "click"), {
    taskId: "T102", action: { kind: "click", x: 30, y: 26, view: "app" },
  });
  const clickSecond = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "window-103-click", targetId: secondWindow.target.targetId, targetRevision: secondWindow.target.revision,
    kind: "click", locator: { kind: "element", ref: secondWindow.observation.controls[0].ref, snapshotId: secondWindow.target.revision },
  } });
  assert.equal(clickSecond.isError, undefined);
  assert.deepEqual(stageActions.filter((entry) => (entry.action as { kind?: string }).kind === "click").map((entry) => entry.taskId), ["T102", "T103"]);

  const refreshedFirst = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T102", mode: "owner-preview", representation: "visual",
  }));
  assert.equal(refreshedFirst.target.targetId, firstWindow.target.targetId);
  assert.notEqual(refreshedFirst.target.revision, body(clickFirst).target.revision);
  const staleClick = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "window-102-stale-ref", targetId: refreshedFirst.target.targetId,
    targetRevision: body(clickFirst).target.revision, kind: "click",
    locator: { kind: "element", ref: body(clickFirst).observation.controls[0].ref, snapshotId: body(clickFirst).target.revision },
  } });
  assert.equal(staleClick.isError, true);
  assert.equal(body(staleClick).result.error.code, "stale-observation");
  assert.equal(stageActions.filter((entry) => (entry.action as { kind?: string }).kind === "click").length, 2,
    "stale refs after window reuse/refresh must not be retargeted or dispatched");
});

test("an acknowledged but unverified desktop click does not unlock keys or caret insertion", async (t) => {
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 160, height: 90, capturedAt: new Date().toISOString() });
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action) => (action as { kind?: string }).kind === "capture"
      ? { ok: true, result: { capture: capture() } }
      : { ok: true, result: { capture: capture(), actionExecuted: true, outcome: { status: "unverifiable" } } },
    run: async () => ({ ok: false, error: "unused browser broker" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "desktop", taskId: "T24", mode: "owner-preview" }));
  const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "unverified-desktop-click", targetId: observed.target.targetId,
    targetRevision: observed.target.revision, kind: "click",
    locator: { kind: "point", x: 22, y: 34, coordinateSpace: "target-local" },
  } });
  assert.equal(reply.isError, undefined);
  const updated = body(reply);
  assert.equal(updated.result.dispatchStatus, "dispatched");
  assert.equal(updated.target.capabilities.includes("input.key"), false);
  assert.equal(updated.target.capabilities.includes("input.text.insert"), false);
});

test("computer-use observation refuses unregistered browser chrome and frame targets without rerouting", async (t) => {
  let stagePrepares = 0;
  let browserActions = 0;
  const web: WebBrokerClient = {
    prepareTaskStage: async () => { stagePrepares += 1; return { ok: true }; },
    taskStageAction: async () => ({ ok: false }),
    run: async () => { browserActions += 1; return { ok: false }; },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  for (const target of ["browser-chrome", "browser-frame", "web-element"]) {
    const reply = await h.call("m9r_computer_observe", { token: TOKEN_A, target, taskId: "T23" });
    assert.equal(reply.isError, true, `${target} must be rejected until a matching adapter is registered`);
    assert.match(body(reply).error, /No computer-use route is registered/);
  }
  assert.equal(stagePrepares, 0, "unsupported browser targets must not be coerced into desktop input");
  assert.equal(browserActions, 0, "unsupported browser targets must not be sent to the page broker");
});

test("generic browser operation receipts serialize concurrent calls and prevent replay after an ambiguous response", async (t) => {
  let snapshots = 0;
  let clickCount = 0;
  let releaseClick: ((response: { ok: boolean; data?: unknown }) => void) | undefined;
  let signalClickStarted: (() => void) | undefined;
  const clickStarted = new Promise<void>((resolve) => { signalClickStarted = resolve; });
  const web: WebBrokerClient = {
    run: async (request) => {
      if (request.action === "snapshot") return { ok: true, data: browserSnapshot(++snapshots) };
      clickCount += 1;
      signalClickStarted?.();
      return new Promise((resolve) => { releaseClick = resolve; });
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "concurrent" }));
  const action = {
    operationId: "browser-concurrent-click", targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "click", locator: { kind: "element", ref: observed.observation.elements[0].ref, snapshotId: observed.target.revision },
  };
  const first = h.call("m9r_computer_action", { token: TOKEN_A, action });
  await clickStarted;

  const concurrent = await h.call("m9r_computer_action", { token: TOKEN_A, action });
  assert.equal(concurrent.isError, true);
  assert.equal(body(concurrent).result.operationReceipt.status, "in_progress");
  assert.equal(body(concurrent).result.dispatchStatus, "unknown");
  assert.equal(clickCount, 1, "a simultaneous same-ID caller observes the in-flight claim, not a second input");

  releaseClick?.({ ok: true, data: { clicked: true } });
  const completed = await first;
  assert.equal(body(completed).result.operationReceipt.status, "applied");
  assert.equal(clickCount, 1);

  const uncertainWeb: WebBrokerClient = {
    run: async (request) => request.action === "snapshot"
      ? { ok: true, data: browserSnapshot(++snapshots) }
      : (clickCount += 1, { ok: false, error: "extension response timed out" }),
  };
  const uncertainHarness = createHarness(uncertainWeb);
  t.after(async () => { await uncertainHarness.server.close(); });
  const uncertainTarget = body(await uncertainHarness.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab", tab: "uncertain" }));
  const uncertainAction = {
    operationId: "browser-uncertain-click", targetId: uncertainTarget.target.targetId, targetRevision: uncertainTarget.target.revision,
    kind: "click", locator: { kind: "element", ref: uncertainTarget.observation.elements[0].ref, snapshotId: uncertainTarget.target.revision },
    postcondition: { kind: "visible-text-contains", text: "Confirmed" },
  };
  const ambiguous = await uncertainHarness.call("m9r_computer_action", { token: TOKEN_A, action: uncertainAction });
  assert.equal(ambiguous.isError, true);
  assert.equal(body(ambiguous).result.operationReceipt.status, "uncertain");
  assert.equal(body(ambiguous).result.dispatchStatus, "unknown");
  const recovered = await uncertainHarness.call("m9r_computer_action", { token: TOKEN_A, action: uncertainAction });
  assert.equal(recovered.isError, true);
  assert.equal(body(recovered).result.operationReceipt.status, "uncertain");
  assert.equal(body(recovered).result.effectStatus, "unknown");
  assert.equal(clickCount, 2, "the ambiguous click ran once; same-ID reconciliation only takes snapshots");
});

test("generic computer-use receipts survive MCP server recreation and block a second browser dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-computer-mcp-restart-"));
  try {
    const firstStore = createLocalStore(root);
    const identity = firstStore.issueIdentity("codex", "codex", "persistent-session");
    let snapshots = 0;
    let clickCount = 0;
    const web: WebBrokerClient = {
      run: async (request) => {
        if (request.action === "snapshot") return { ok: true, data: browserSnapshot(++snapshots) };
        clickCount += 1;
        return { ok: true, data: { clicked: true } };
      },
    };
    const makeHarness = (store: LocalStore) => {
      const server = createM9rMcpServer({ store, web });
      const tools = (server as unknown as ToolServer)._registeredTools;
      return { server, call: (name: string, args: unknown) => tools[name]!.handler(args) };
    };
    const first = makeHarness(firstStore);
    const observed = body(await first.call("m9r_computer_observe", { token: identity.token, target: "browser-tab", tab: "restart-test" }));
    const action = {
      operationId: "restart-safe-click", targetId: observed.target.targetId, targetRevision: observed.target.revision,
      kind: "click", locator: { kind: "element", ref: observed.observation.elements[0].ref, snapshotId: observed.target.revision },
    };
    const dispatched = await first.call("m9r_computer_action", { token: identity.token, action });
    assert.equal(body(dispatched).result.operationReceipt.status, "applied");
    assert.equal(clickCount, 1);
    await first.server.close();

    const second = makeHarness(createLocalStore(root));
    try {
      const replay = await second.call("m9r_computer_action", { token: identity.token, action });
      assert.equal(replay.isError, true, "receipt-only recovery remains explicitly unverified after the observation cache is lost");
      assert.equal(body(replay).result.operationReceipt.status, "applied");
      assert.equal(body(replay).result.dispatchStatus, "dispatched");
      assert.equal(body(replay).result.effectStatus, "unknown");
      assert.equal(clickCount, 1, "durable same-ID recovery never resends the browser click after MCP recreation");
    } finally { await second.server.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a window closed, moved, or minimized since it was observed refuses dispatch instead of acting on a stale point (Finding AE)", async (t) => {
  const stageActions: string[] = [];
  let windowState: "visible" | "closed" | "minimized" = "visible";
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action) => {
      const kind = (action as { kind?: string }).kind;
      stageActions.push(String(kind));
      if (kind === "window_status") return { ok: true, result: { windowState } };
      return { ok: true, result: { capture: { dataUrl: "data:image/png;base64,eA==", width: 200, height: 100,
        capturedAt: new Date().toISOString(), controls: [] },
        ...(kind === "capture" ? {} : { actionExecuted: true, outcome: { status: "confirmed" }, operationReceipt: { status: "applied" } }) } };
    },
    run: async () => ({ ok: false, error: "unused browser route" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });
  const observed = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview", representation: "visual",
  }));

  windowState = "closed";
  const refused = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "stale-point-click", targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "click", locator: { kind: "point", x: 45, y: 55, coordinateSpace: "target-local" },
  } });
  assert.equal(refused.isError, true, "a window reported closed by the freshness probe must refuse, not dispatch blind");
  assert.notEqual(body(refused).result.error.message.toLowerCase().includes("closed"), false);
  assert.equal(stageActions.includes("click"), false, "the stale click itself must never reach the native stage broker");

  windowState = "visible";
  const observedAgain = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview", representation: "visual",
  }));
  const succeeded = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "fresh-point-click", targetId: observedAgain.target.targetId, targetRevision: observedAgain.target.revision,
    kind: "click", locator: { kind: "point", x: 45, y: 55, coordinateSpace: "target-local" },
  } });
  assert.equal(succeeded.isError, undefined, "a window the probe reports visible must dispatch normally, with no added friction");
  assert.equal(stageActions.includes("click"), true);
});

test("generic desktop actions use the prepared exact stage target and refuse unsupported capabilities before dispatch", async (t) => {
  const stageActions: Array<{ taskId: string; action: unknown; mode?: string; operationId?: string }> = [];
  // The Finding AE freshness probe (window_status) now runs before every dispatched action; it is
  // bookkeeping, not one of the logical actions this test is asserting about, so it is filtered out
  // here rather than renumbering every index below.
  const dispatched = () => stageActions.filter((entry) => (entry.action as { kind?: string }).kind !== "window_status");
  let prepares = 0;
  let captureSequence = 0;
  const capture = () => ({
    dataUrl: "data:image/png;base64,eA==",
    width: 200,
    height: 100,
    capturedAt: new Date().toISOString(),
    controls: [{ label: "Search", role: "Edit", canReplaceValue: true, rect: { x: 10, y: 20, width: 20, height: 10 } }],
  });
  const web: WebBrokerClient = {
    prepareTaskStage: async () => { prepares += 1; return { ok: true }; },
    taskStageAction: async (_token, taskId, action, mode, operationId) => {
      const input = action as { kind?: string };
      stageActions.push({ taskId, action, mode, operationId });
      if (input.kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      if (input.kind === "capture") return { ok: true, result: { capture: capture() } };
      return {
        ok: true,
        result: {
          capture: capture(),
          operationReceipt: { operationId, status: "applied", driverReturned: true },
          actionExecuted: true,
          ...(input.kind === "click" ? { outcome: { status: "confirmed" } } : {}),
          sequence: ++captureSequence,
        },
      };
    },
    run: async () => ({ ok: false, error: "unused browser route" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const initialReply = await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T12", mode: "owner-preview", representation: "visual",
  });
  const initial = body(initialReply);
  assert.equal(initial.target.kind, "desktop-window");
  assert.equal(initialReply.content[1]?.type, "image");
  assert.equal(prepares, 1);
  assert.equal(initial.target.capabilities.includes("input.text.insert"), false,
    "the app window cannot advertise caret insertion before an agent input target has been confirmed");
  assert.ok(initial.target.capabilities.includes("input.text.replace"));
  assert.ok(initial.target.capabilities.includes("input.scroll.line.vertical"));
  assert.equal(initial.target.capabilities.includes("input.scroll.pixel.vertical"), false);
  const prematureInsert = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-insert-before-click", targetId: initial.target.targetId, targetRevision: initial.target.revision,
    kind: "text", mode: "insert", text: "must not be sent yet",
  } });
  assert.equal(prematureInsert.isError, true);
  assert.equal(body(prematureInsert).result.error.code, "unsupported-target-action");
  assert.match(body(prematureInsert).result.error.message, /confirmed input selection/);
  assert.equal(dispatched().length, 1, "unselected typing is rejected before a stage operation receipt or input dispatch");
  const control = initial.observation.controls[0];
  const actionReply = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "desktop-click-1",
      targetId: initial.target.targetId,
      targetRevision: initial.target.revision,
      kind: "click",
      locator: { kind: "element", ref: control.ref, snapshotId: initial.target.revision },
      postcondition: { kind: "accessible-control-present", role: "Edit", label: "Search" },
    },
  });
  const acted = body(actionReply);
  assert.equal(acted.result.routeId, "m9r-desktop-stage");
  assert.equal(acted.result.dispatchStatus, "dispatched");
  assert.equal(acted.result.effectStatus, "verified");
  assert.equal(acted.result.operationReceipt.status, "applied");
  assert.ok(acted.target.capabilities.includes("input.text.insert"), "a confirmed click unlocks caret insertion on the exact window");
  assert.notEqual(acted.target.revision, initial.target.revision);
  assert.equal(dispatched().length, 2, "the action's own fresh capture is reused rather than recaptured");
  assert.deepEqual(dispatched()[1], {
    taskId: "T12",
    action: { kind: "click", x: 20, y: 25, view: "app" },
    mode: "owner-preview",
    operationId: "desktop-click-1",
  });

  const insertReply = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "desktop-text-insert-1",
      targetId: acted.target.targetId,
      targetRevision: acted.target.revision,
      kind: "text",
      mode: "insert",
      text: "append at the confirmed caret",
    },
  });
  assert.equal(insertReply.isError, undefined);
  const inserted = body(insertReply);
  assert.deepEqual(dispatched()[2], {
    taskId: "T12",
    action: { kind: "type", mode: "insert", text: "append at the confirmed caret", view: "app" },
    mode: "owner-preview",
    operationId: "desktop-text-insert-1",
  });

  const refreshedControl = inserted.observation.controls[0];
  const replaceReply = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "desktop-text-replace-1",
      targetId: inserted.target.targetId,
      targetRevision: inserted.target.revision,
      kind: "text",
      mode: "replace",
      text: "new field value",
      locator: { kind: "element", ref: refreshedControl.ref, snapshotId: inserted.target.revision },
    },
  });
  assert.equal(replaceReply.isError, undefined);
  const replaced = body(replaceReply);
  assert.equal(replaced.result.dispatchStatus, "dispatched");
  assert.deepEqual(dispatched()[3], {
    taskId: "T12",
    action: { kind: "type", mode: "replace", x: 20, y: 25, expectedRole: "Edit", expectedLabel: "Search", text: "new field value", view: "app" },
    mode: "owner-preview",
    operationId: "desktop-text-replace-1",
  });

  const scrollReply = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "desktop-scroll-page-1",
      targetId: replaced.target.targetId,
      targetRevision: replaced.target.revision,
      kind: "scroll",
      unit: "page",
      deltaX: 0,
      deltaY: 1,
      at: { kind: "point", x: 40, y: 60, coordinateSpace: "target-local" },
    },
  });
  assert.equal(scrollReply.isError, undefined);
  assert.deepEqual(dispatched()[4], {
    taskId: "T12",
    action: { kind: "scroll_delta", x: 40, y: 60, deltaX: 0, deltaY: 1, unit: "page", view: "app" },
    mode: "owner-preview",
    operationId: "desktop-scroll-page-1",
  });

  const refreshedControlAfterScroll = body(scrollReply).observation.controls[0];
  const doubled = await h.call("m9r_computer_action", {
    token: TOKEN_A,
    action: {
      operationId: "desktop-double-1",
      targetId: body(scrollReply).target.targetId,
      targetRevision: body(scrollReply).target.revision,
      kind: "click",
      locator: { kind: "element", ref: refreshedControlAfterScroll.ref, snapshotId: body(scrollReply).target.revision },
      count: 2,
    },
  });
  assert.equal(doubled.isError, undefined);
  assert.equal(body(doubled).result.dispatchStatus, "dispatched");
  assert.deepEqual(dispatched()[5], {
    taskId: "T12",
    action: { kind: "double_click", x: 20, y: 25, view: "app" },
    mode: "owner-preview",
    operationId: "desktop-double-1",
  });

  const middleClick = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-middle-1",
    targetId: body(doubled).target.targetId,
    targetRevision: body(doubled).target.revision,
    kind: "click",
    button: "middle",
    locator: { kind: "point", x: 45, y: 55, coordinateSpace: "target-local" },
  } });
  assert.equal(middleClick.isError, true);
  assert.equal(body(middleClick).result.error.code, "unsupported-target-capability");
  assert.match(body(middleClick).result.error.message, /input\.click\.middle/);
  assert.equal(dispatched().length, 6, "unsupported middle clicks never reach the native stage broker");

  const replay = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-click-1", targetId: initial.target.targetId, targetRevision: initial.target.revision,
    kind: "click", locator: { kind: "element", ref: control.ref, snapshotId: initial.target.revision },
    postcondition: { kind: "accessible-control-present", role: "Edit", label: "Search" },
  } });
  assert.equal(replay.isError, undefined);
  assert.equal(body(replay).result.effectStatus, "verified");
  assert.equal(body(replay).result.operationReceipt.status, "applied");
  assert.equal(dispatched().length, 7, "same-ID desktop recovery performs only a fresh capture, not the click again");
  assert.equal(dispatched().filter((entry) => (entry.action as { kind?: string }).kind === "click").length, 1);
  assert.equal(dispatched().filter((entry) => (entry.action as { kind?: string }).kind === "double_click").length, 1);
});

test("foreground confirmation is forwarded end-to-end for every shared app-window input family", async (t) => {
  const stageActions: Array<{ taskId: string; action: unknown; mode?: string; operationId?: string }> = [];
  const capture = () => ({
    dataUrl: "data:image/png;base64,eA==",
    width: 200,
    height: 100,
    capturedAt: new Date().toISOString(),
    controls: [{ label: "Scratch editor", role: "Document", canReplaceValue: true,
      rect: { x: 10, y: 10, width: 180, height: 80 } }],
  });
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, taskId, action, mode, operationId) => {
      stageActions.push({ taskId, action, mode, operationId });
      const kind = (action as { kind?: string }).kind;
      if (kind === "window_status") return { ok: true, result: { windowState: "visible" } };
      return { ok: true, result: {
        capture: capture(),
        ...(kind === "capture" ? {} : {
          actionExecuted: true,
          outcome: { status: "confirmed" },
          operationReceipt: { operationId, status: "applied", driverReturned: true },
        }),
      } };
    },
    run: async () => ({ ok: false, error: "browser route must not be used" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  let current = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T160-fixture", mode: "owner-preview", representation: "visual",
  }));
  assert.ok(current.target.capabilities.includes("input.shared-os"));

  const inputs = [
    { operationId: "foreground-click", kind: "click", locator: { kind: "point", x: 30, y: 40, coordinateSpace: "target-local" },
      confirmFocusForeground: true },
    { operationId: "foreground-insert", kind: "text", mode: "insert", text: "scratch input", confirmFocusForeground: true },
    { operationId: "foreground-key", kind: "key", key: "Enter", confirmFocusForeground: true },
    { operationId: "foreground-hotkey", kind: "key", key: "A", modifiers: ["Control"], confirmFocusForeground: true },
    { operationId: "foreground-scroll", kind: "scroll", unit: "line", deltaX: 0, deltaY: 2,
      at: { kind: "point", x: 50, y: 60, coordinateSpace: "target-local" }, confirmFocusForeground: true },
    { operationId: "foreground-drag", kind: "drag",
      from: { kind: "point", x: 60, y: 60, coordinateSpace: "target-local" },
      to: { kind: "point", x: 80, y: 70, coordinateSpace: "target-local" }, durationMs: 500, confirmFocusForeground: true },
    { operationId: "foreground-right-click", kind: "click", button: "right",
      locator: { kind: "point", x: 90, y: 40, coordinateSpace: "target-local" }, confirmFocusForeground: true },
    { operationId: "foreground-double-click", kind: "click", count: 2,
      locator: { kind: "point", x: 100, y: 40, coordinateSpace: "target-local" }, confirmFocusForeground: true },
  ];

  for (const action of inputs) {
    const reply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
      ...action,
      targetId: current.target.targetId,
      targetRevision: current.target.revision,
    } });
    assert.equal(reply.isError, undefined, `${action.operationId} should dispatch on the advertised exact app target`);
    assert.equal(body(reply).result.dispatchStatus, "dispatched");
    const sharedInput = body(reply).sharedInput as {
      foregroundMayChange?: boolean;
      physicalPointerMayMove?: boolean;
      pointerIsolationVerified?: boolean;
    } | undefined;
    assert.equal(sharedInput?.foregroundMayChange, true,
      `${action.operationId} must disclose that foreground delivery can change the visible foreground`);
    assert.equal(sharedInput?.physicalPointerMayMove, ["click", "scroll", "drag"].includes((action as { kind: string }).kind),
      `${action.operationId} must disclose the shared Windows pointer risk for pointer actions only`);
    assert.equal(sharedInput?.pointerIsolationVerified, false,
      `${action.operationId} must never claim pointer isolation without live evidence`);
    current = body(reply);
  }

  const dispatched = stageActions.slice(1).filter((entry) => (entry.action as { kind?: string }).kind !== "window_status");
  assert.deepEqual(dispatched.map(({ action }) => (action as { kind: string }).kind), [
    "click", "type", "press_key", "hotkey", "scroll_delta", "drag", "right_click", "double_click",
  ]);
  for (const entry of dispatched) {
    assert.equal((entry.action as { confirmFocusForeground?: boolean }).confirmFocusForeground, true,
      "every shared input action must preserve the explicit foreground option through MCP dispatch");
    assert.equal(entry.mode, "owner-preview");
  }
  assert.equal(stageActions[0]?.taskId, "T160-fixture");
});

test("an ambiguous exact-window action is durably reconciled without a second desktop dispatch", async (t) => {
  const stageActions: Array<{ action: unknown; operationId?: string }> = [];
  let clickDispatches = 0;
  const capture = () => ({
    dataUrl: "data:image/png;base64,eA==",
    width: 200,
    height: 100,
    capturedAt: new Date().toISOString(),
    controls: [],
  });
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action, _mode, operationId) => {
      stageActions.push({ action, operationId });
      if ((action as { kind?: string }).kind === "click") {
        clickDispatches += 1;
        throw new Error("stage transport lost after dispatch may have begun");
      }
      return { ok: true, result: { capture: capture() } };
    },
    run: async () => ({ ok: false, error: "unused browser route" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });
  const observed = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T905", mode: "owner-preview", representation: "visual",
  }));
  const action = {
    operationId: "ambiguous-exact-window-click",
    targetId: observed.target.targetId,
    targetRevision: observed.target.revision,
    kind: "click",
    locator: { kind: "point", x: 45, y: 55, coordinateSpace: "target-local" },
  };

  const first = await h.call("m9r_computer_action", { token: TOKEN_A, action });
  assert.equal(first.isError, true);
  assert.equal(body(first).result.operationReceipt.status, "uncertain");
  assert.equal(body(first).result.dispatchStatus, "unknown");
  assert.equal(body(first).result.effectStatus, "unknown");

  const recovered = await h.call("m9r_computer_action", { token: TOKEN_A, action });
  assert.equal(recovered.isError, true);
  assert.equal(body(recovered).result.operationReceipt.status, "uncertain");
  assert.equal(body(recovered).result.effectStatus, "unknown");
  assert.equal(clickDispatches, 1, "same-ID reconciliation observes the exact window but never retries the click");
  assert.deepEqual(stageActions.map(({ action: value }) => (value as { kind?: string }).kind).filter((kind) => kind !== "window_status"),
    ["capture", "click", "capture", "capture"]);
});

test("system actions use the same exact-window route for both provider identities", async (t) => {
  const inputs: Array<{ token: string; action: { kind: string }; taskId: string }> = [];
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    run: async () => { throw new Error("system APIs must not use the extension"); },
    taskStageAction: async (token, taskId, action) => {
      inputs.push({ token, taskId, action: action as { kind: string } });
      return { ok: true, result: {
        capture: { dataUrl: "data:image/png;base64,eA==", width: 200, height: 100, capturedAt: new Date().toISOString(), controls: [] },
        ...((action as { kind: string }).kind === "capture" ? {} : { actionExecuted: true, operationReceipt: { status: "applied" } }),
        ...((action as { kind: string }).kind === "clipboard_read" ? { clipboard: { types: ["text/plain"] } } : {}),
      } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });
  for (const token of [TOKEN_A, TOKEN_B]) {
    let current = body(await h.call("m9r_computer_observe", { token, target: "app-window", taskId: "system-fixture", representation: "visual" }));
    for (const action of [
      { kind: "window_frame", x: -100, y: 100, width: 800, height: 600 },
      { kind: "invoke_menu", path: ["Edit", "Select All"] },
      { kind: "clipboard", mode: "read", includeText: false },
      { kind: "clipboard", mode: "write", text: "scratch", confirmSharedClipboard: true },
    ]) {
      const reply = await h.call("m9r_computer_action", { token, action: { ...action, operationId: `system-${action.kind}-${inputs.length}`,
        targetId: current.target.targetId, targetRevision: current.target.revision } });
      assert.equal(reply.isError, undefined);
      if (action.kind === "clipboard" && action.mode === "read") assert.deepEqual(body(reply).clipboard, { types: ["text/plain"] });
      current = body(reply);
    }
  }
  assert.deepEqual(inputs.filter(({ action }) => action.kind !== "capture" && action.kind !== "window_status").map(({ action }) => action.kind),
    ["window_frame", "invoke_menu", "clipboard_read", "clipboard_write", "window_frame", "invoke_menu", "clipboard_read", "clipboard_write"]);
});

test("exact app-window capabilities expose supported right and double clicks without claiming middle click", async (t) => {
  const stageActions: Array<{ action: unknown; operationId?: string }> = [];
  const dispatched = () => stageActions.filter((entry) => (entry.action as { kind?: string }).kind !== "window_status");
  const capture = () => ({
    dataUrl: "data:image/png;base64,eA==",
    width: 200,
    height: 100,
    capturedAt: new Date().toISOString(),
    accessibilityStatus: "complete",
    controls: [{ label: "Open item", role: "button", rect: { x: 10, y: 20, width: 30, height: 10 } }],
  });
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action, _mode, operationId) => {
      stageActions.push({ action, operationId });
      return { ok: true, result: {
        capture: capture(),
        ...((action as { kind?: string }).kind === "capture" ? {} : {
          outcome: { status: "confirmed" }, actionExecuted: true, operationReceipt: { status: "applied" },
        }),
      } };
    },
    run: async () => ({ ok: false, error: "unused browser route" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const initial = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T902", mode: "owner-preview", representation: "visual",
  }));
  for (const capability of ["input.click.right", "input.click.double.element", "input.click.double.point"]) {
    assert.ok(initial.target.capabilities.includes(capability), `${capability} is implemented by the exact-window driver`);
  }
  assert.equal(initial.target.capabilities.includes("input.click.middle"), false,
    "the exact-window CUA click API does not support middle-click");

  const control = initial.observation.controls[0];
  const right = body(await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-right-click",
    targetId: initial.target.targetId,
    targetRevision: initial.target.revision,
    kind: "click",
    button: "right",
    locator: { kind: "element", ref: control.ref, snapshotId: initial.target.revision },
  } }));
  assert.equal(right.result.dispatchStatus, "dispatched");
  assert.deepEqual(dispatched()[1], {
    operationId: "desktop-right-click",
    action: { kind: "right_click", x: 25, y: 25, view: "app" },
  });

  const doubled = body(await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-double-click",
    targetId: right.target.targetId,
    targetRevision: right.target.revision,
    kind: "click",
    count: 2,
    locator: { kind: "point", x: 40, y: 50, coordinateSpace: "target-local" },
  } }));
  assert.equal(doubled.result.dispatchStatus, "dispatched");
  assert.deepEqual(dispatched()[2], {
    operationId: "desktop-double-click",
    action: { kind: "double_click", x: 40, y: 50, view: "app" },
  });

  const middle = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "desktop-middle-click",
    targetId: doubled.target.targetId,
    targetRevision: doubled.target.revision,
    kind: "click",
    button: "middle",
    locator: { kind: "point", x: 40, y: 50, coordinateSpace: "target-local" },
  } });
  assert.equal(middle.isError, true);
  assert.equal(body(middle).result.error.code, "unsupported-target-capability");
  assert.equal(dispatched().length, 3, "unsupported middle clicks never reach the native stage broker");

  const desktop = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "desktop", taskId: "T903", mode: "owner-preview",
  }));
  for (const capability of ["input.click.right", "input.click.double.element", "input.click.double.point"]) {
    assert.equal(desktop.target.capabilities.includes(capability), false);
  }
});

test("desktop replacement capability requires the role used by its dispatch preflight", async (t) => {
  const stageActions: Array<{ action: unknown }> = [];
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action) => {
      stageActions.push({ action });
      return { ok: true, result: { capture: {
        dataUrl: "data:image/png;base64,eA==",
        width: 200,
        height: 100,
        capturedAt: new Date().toISOString(),
        controls: [{ label: "Unroled field", canReplaceValue: true, rect: { x: 10, y: 20, width: 30, height: 10 } }],
      } } };
    },
    run: async () => ({ ok: false, error: "unused browser route" }),
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", {
    token: TOKEN_A, target: "app-window", taskId: "T904", mode: "owner-preview", representation: "visual",
  }));
  assert.equal(observed.target.capabilities.includes("input.text.replace"), false,
    "replacement is unavailable when the accessible control lacks a role");

  const refused = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "unroled-field-replacement",
    targetId: observed.target.targetId,
    targetRevision: observed.target.revision,
    kind: "text",
    mode: "replace",
    text: "must not dispatch",
    locator: { kind: "element", ref: observed.observation.controls[0].ref, snapshotId: observed.target.revision },
  } });
  assert.equal(refused.isError, true);
  assert.equal(stageActions.length, 1, "the pre-dispatch refusal takes no stage action after the observation");
});

test("generic browser scrolling preserves pixel magnitude and refuses unsupported axes or units", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: browserSnapshot(++snapshots) };
      return { ok: true, data: { scrolled: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });
  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab" }));
  const scrolledReply = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-scroll-pixels", targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "scroll", unit: "pixel", deltaX: 0, deltaY: -420,
  } });
  assert.equal(scrolledReply.isError, undefined);
  assert.equal(requests[1]?.action, "scroll");
  assert.deepEqual(requests[1]?.args, { by: -420 });
  assert.equal(requests[1]?.selector, undefined);

  const fresh = body(scrolledReply);
  const horizontal = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-scroll-horizontal", targetId: fresh.target.targetId, targetRevision: fresh.target.revision,
    kind: "scroll", unit: "pixel", deltaX: 100, deltaY: 0,
  } });
  assert.equal(horizontal.isError, true);
  assert.match(body(horizontal).result.error.message, /vertical page scrolling only/);
  const lines = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-scroll-lines", targetId: fresh.target.targetId, targetRevision: fresh.target.revision,
    kind: "scroll", unit: "line", deltaX: 0, deltaY: 3,
  } });
  assert.equal(lines.isError, true);
  assert.match(body(lines).result.error.message, /pixels only/);
  assert.equal(requests.length, 3, "unsupported browser scroll semantics are refused before dispatch");
});

test("generic selection semantics route only the supported browser operation and refuse unsupported focus or select-all", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  const web: WebBrokerClient = {
    run: async (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      if (request.action === "snapshot") return { ok: true, data: {
        url: "https://example.test/", title: "Search results", text: "Search results",
        nativeClickAvailable: true,
        elements: [{ ref: `${REF_PREFIX}_${++snapshots}`, role: "button", name: "Search results", sensitive: false, canSelectText: true }],
      } };
      return { ok: true, data: { selected: true } };
    },
  };
  const h = createHarness(web);
  t.after(async () => { await h.server.close(); });

  const observed = body(await h.call("m9r_computer_observe", { token: TOKEN_A, target: "browser-tab" }));
  const element = observed.observation.elements[0];
  const selected = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-select-phrase", targetId: observed.target.targetId, targetRevision: observed.target.revision,
    kind: "select_text", locator: { kind: "element", ref: element.ref, snapshotId: observed.target.revision },
    selection: { kind: "text", text: "Search" },
    postcondition: { kind: "visible-text-contains", text: "Search" },
  } });
  assert.equal(selected.isError, undefined);
  assert.equal(body(selected).result.effectStatus, "verified");
  assert.equal(requests[1]?.action, "select_text");
  assert.equal(requests[1]?.selector, `@m9r-ref:${element.ref}`);
  assert.deepEqual(requests[1]?.args, { text: "Search" });

  const fresh = body(selected);
  const focus = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-focus-unsupported", targetId: fresh.target.targetId, targetRevision: fresh.target.revision,
    kind: "focus",
  } });
  assert.equal(focus.isError, true);
  assert.match(body(focus).result.error.message, /[Ss]tandalone focus/);

  const selectAll = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-select-all-unsupported", targetId: fresh.target.targetId, targetRevision: fresh.target.revision,
    kind: "select_text", locator: { kind: "element", ref: fresh.observation.elements[0].ref, snapshotId: fresh.target.revision },
    selection: { kind: "all" },
  } });
  assert.equal(selectAll.isError, true);
  assert.match(body(selectAll).result.error.message, /not select-all/);
  assert.equal(requests.length, 3, "focus and select-all are refused before dispatch; only the supported phrase selection and its observation reach the broker");

  const unverified = await h.call("m9r_computer_action", { token: TOKEN_A, action: {
    operationId: "browser-select-unknown-postcondition", targetId: fresh.target.targetId, targetRevision: fresh.target.revision,
    kind: "click", locator: { kind: "element", ref: fresh.observation.elements[0].ref, snapshotId: fresh.target.revision },
    postcondition: { kind: "visible-text-contains", text: "A text change not in this bounded snapshot" },
  } });
  assert.equal(unverified.isError, true);
  assert.equal(body(unverified).result.effectStatus, "unknown", "absence from a bounded text snapshot cannot prove mismatch");
  assert.equal(body(unverified).result.operationReceipt.status, "applied");
});
