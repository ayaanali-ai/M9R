import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { registerComputerUseTools } from "../src/lib/native/computer-use-mcp";
import { createLocalStore } from "../src/lib/native/local-store";
import type { WebBrokerClient } from "../src/lib/native/web-broker-client";
import type { ComputerUseTarget, ComputerUseResult } from "../src/lib/native/computer-use-contract";

type Payload = { target: ComputerUseTarget; result: ComputerUseResult; observation: { elements: { ref: string }[]; controls: { ref: string }[] }; content?: unknown };
type Handler = (input: Record<string, unknown>) => Promise<{ structuredContent: Payload; content?: { type: string }[] }>;
const ref = `e${"a".repeat(24)}_1`;

function fixture() {
  const temp = resolve(".test-tmp"); mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "execution-loop-"));
  const store = createLocalStore(root);
  const token = store.issueIdentity("codex", "codex", "execution-loop").token;
  const identity = store.verifyIdentity(token)!;
  const handlers = new Map<string, Handler>();
  const calls: { kind: string; operationId?: string }[] = [];
  let failure: "none" | "before" | "uncertain" = "none";
  let url = "https://fixture.test/";
  let unlabeled = false;
  let activeTaskId = "T1";
  const workRequests: unknown[] = [];
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 300, height: 200, capturedAt: new Date().toISOString(),
    structure: { status: "complete", capturedAt: new Date().toISOString(), elements: [{ ref: "uia:post-action", role: "Button", label: "Action", enabled: true, actions: ["invoke"], rect: { x: 1, y: 2, width: 50, height: 20 } }] } });
  const web: Pick<WebBrokerClient, "run" | "prepareTaskStage" | "taskStageAction"> = {
    prepareTaskStage: async () => ({ ok: true }),
    async run(request) {
      calls.push({ kind: request.action, operationId: request.operationId });
      if (request.work) workRequests.push(request.work);
      if (request.action === "snapshot") return { ok: true, data: { tab: request.tab ?? "one", browserInstanceId: "daemon-one", tabId: request.tab ?? "target-one", url, text: "Verified state", nativeClickAvailable: true,
        elements: [{ ref, role: "button", name: "Action", actions: ["click"], rect: { x: 1, y: 2, width: 50, height: 20 } }] } };
      if (failure === "before") return { ok: false, error: "Owner pointer is active", dispatchState: "not-dispatched" };
      if (failure === "uncertain") throw new Error("Response lost after input");
      if (request.action === "open" && request.url) url = request.url;
      if (request.action === "close") return { ok: true, data: { closed: true } };
      return { ok: true };
    },
    async taskStageAction(_token, _taskId, input, _mode, operationId) {
      const action = input as { kind: string };
      calls.push({ kind: action.kind, operationId });
      if (action.kind === "read_structure") return { ok: true, result: { status: unlabeled ? "complete" : "partial", capturedAt: new Date().toISOString(),
        elements: [{ ref: "uia:1", label: unlabeled ? "" : "Action", role: "Button", enabled: true, actions: ["invoke"], rect: { x: 1, y: 2, width: 50, height: 20 } }], fallbackCapture: capture() } };
      if (failure === "before") return { ok: false, error: "Owner pointer is active", dispatchState: "not-dispatched", gateCode: "foreground-lease" };
      if (failure === "uncertain") throw new Error("Response lost after input");
      return { ok: true, result: { capture: capture(), outcome: { status: "confirmed" }, operationReceipt: { status: "applied" }, actionExecuted: true } };
    },
  };
  registerComputerUseTools({ registerTool(name: string, _descriptor: unknown, handler: Handler) { handlers.set(name, handler); } } as never,
    { store, web: web as WebBrokerClient, requireIdentity: async () => identity, identityToken: async () => token, resolveTaskId: () => activeTaskId,
      resolveWorkIdentity: () => ({ workId: "work-original", planRevision: activeTaskId === "T1" ? 0 : 1 }), enableIsolatedBrowser: true });
  return { calls, workRequests, setTask: (taskId: string) => { activeTaskId = taskId; }, setFailure: (value: typeof failure) => { failure = value; }, setUnlabeled: () => { unlabeled = true; },
    call: async (name: string, input: Record<string, unknown>) => (await handlers.get(name)!(input)).structuredContent,
    callRaw: async (name: string, input: Record<string, unknown>) => handlers.get(name)!(input),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("m9r_browser_open is not registered unless the owner explicitly opts into the isolated browser", () => {
  const temp = resolve(".test-tmp"); mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "execution-loop-default-"));
  const store = createLocalStore(root);
  const token = store.issueIdentity("codex", "codex", "execution-loop-default").token;
  const identity = store.verifyIdentity(token)!;
  const handlers = new Map<string, Handler>();
  try {
    registerComputerUseTools({ registerTool(name: string, _descriptor: unknown, handler: Handler) { handlers.set(name, handler); } } as never,
      { store, requireIdentity: async () => identity, identityToken: async () => token, resolveTaskId: () => "T1" });
    assert.equal(handlers.has("m9r_browser_open"), false, "the agent must not be able to see or call the isolated-browser tool by default");
    assert.equal(handlers.has("m9r_browser_tabs"), false, "listing isolated-browser tabs has nothing to report when the isolated browser is off, so it is gated the same way");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function click(target: ComputerUseTarget, operationId = "click-one", elementRef = ref) {
  return { kind: "click", operationId, targetId: target.targetId, targetRevision: target.revision,
    locator: { kind: "element", ref: elementRef, snapshotId: target.revision },
    postcondition: { kind: "accessible-control-present", label: "Action" }, includeScreenshot: undefined as boolean | undefined };
}

test("canonical browser loop dispatches once, verifies, and reconciles the same operation without replay", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "browser-tab", tab: "one" });
    const action = click(observed.target);
    const first = await f.call("m9r_computer_action", { action });
    assert.deepEqual(first.result.deliveryReceipt, { delivery: "delivered", verification: "verified", retry: "new-operation-id" });
    const replay = await f.call("m9r_computer_action", { action });
    assert.equal(replay.result.dispatchStatus, "dispatched");
    assert.equal(f.calls.filter((call) => call.kind === "click").length, 1);
    assert.equal("telemetry" in first, false);
  } finally { f.close(); }
});

test("first-tab bootstrap uses the canonical loop and exact tab close returns verified evidence", async () => {
  const f = fixture(); try {
    const input = { tab: "new-tab", url: "https://fixture.test/new", operationId: "browser-bootstrap" };
    const opened = await f.call("m9r_browser_open", input);
    assert.equal(opened.result.deliveryReceipt?.verification, "verified");
    assert.equal(opened.target.kind, "browser-tab");
    await f.call("m9r_browser_open", input);
    assert.equal(f.calls.filter((call) => call.kind === "open").length, 1);
    const fresh = await f.call("m9r_computer_observe", { target: "browser-tab", tab: "new-tab" });
    const closed = await f.call("m9r_computer_action", { action: { kind: "browser_tab", operation: "close", operationId: "close-tab",
      targetId: fresh.target.targetId, targetRevision: fresh.target.revision } });
    assert.equal(closed.result.effectStatus, "verified");
    assert.equal(f.calls.filter((call) => call.kind === "close").length, 1);
  } finally { f.close(); }
});

test("subtree inspection remains revision-qualified and missing partial evidence stays unknown", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    const before = f.calls.length;
    const inspected = await f.call("m9r_computer_inspect", { targetId: observed.target.targetId, targetRevision: observed.target.revision,
      rootRef: observed.observation.controls[0]!.ref, query: "Action", limit: 1 });
    assert.equal(inspected.observation.controls.length, 1);
    assert.equal(f.calls.length, before, "inspection adds no redundant native runtime probe");
    assert.equal((inspected.observation as unknown as { absenceEvidence: string }).absenceEvidence, "unknown");
  } finally { f.close(); }
});

test("unlabeled controls qualify for the same-capture visual fallback even when the tree is complete", async () => {
  const f = fixture(); try {
    f.setUnlabeled();
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    assert.equal(observed.target.capabilities.includes("input.click.point"), true);
    assert.ok((observed.observation as unknown as { capture: unknown }).capture);
    assert.equal(f.calls.length, 1, "the accessibility capture already contained the needed frame");
  } finally { f.close(); }
});

test("redirected work fences the old observation and carries the new task revision to browser dispatch", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "browser-tab", tab: "one" });
    f.setTask("T2");
    const stale = await f.call("m9r_computer_action", { action: click(observed.target) });
    assert.equal(stale.result.error?.code, "task-context-changed");
    assert.equal(f.calls.filter((call) => call.kind === "click").length, 0);
    const current = await f.call("m9r_computer_observe", { target: "browser-tab", tab: "one" });
    await f.call("m9r_computer_action", { action: click(current.target, "redirected-click") });
    assert.deepEqual(f.workRequests.at(-1), { taskId: "T2", workId: "work-original", planRevision: 1 });
  } finally { f.close(); }
});

test("stale refs refresh evidence before any input and an uncertain response never replays", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "browser-tab", tab: "one" });
    const stale = { ...click(observed.target), targetRevision: "old-revision" };
    const refused = await f.call("m9r_computer_action", { action: stale });
    assert.equal(refused.result.error?.retry, "refresh-target");
    assert.equal(f.calls.filter((call) => call.kind === "click").length, 0);
    const fresh = await f.call("m9r_computer_observe", { target: "browser-tab", tab: "one" });
    const action = click(fresh.target, "uncertain-click");
    f.setFailure("uncertain");
    const uncertain = await f.call("m9r_computer_action", { action });
    assert.equal(uncertain.result.deliveryReceipt?.delivery, "uncertain");
    assert.equal(uncertain.result.error?.retry, "same-operation-id");
    await f.call("m9r_computer_action", { action });
    assert.equal(f.calls.filter((call) => call.kind === "click").length, 1);
  } finally { f.close(); }
});

test("partial desktop evidence uses its same-capture fallback and recoverable pointer refusals release claims", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    const element = observed.observation.controls[0]!;
    const action = click(observed.target, "desktop-click", element.ref);
    f.setFailure("before");
    const refused = await f.call("m9r_computer_action", { action });
    assert.equal(refused.result.deliveryReceipt?.delivery, "not-delivered");
    assert.equal(refused.result.error?.retry, "refresh-target");
    f.setFailure("none");
    const fresh = await f.call("m9r_computer_observe", { target: "app-window" });
    const success = await f.call("m9r_computer_action", { action: click(fresh.target, "desktop-click", fresh.observation.controls[0]!.ref) });
    assert.equal(success.result.dispatchStatus, "dispatched");
    assert.equal(f.calls.some((call) => call.kind === "window_status" || call.kind === "capture"), false, "no duplicate lifecycle/screenshot probe");
    assert.equal(f.calls.filter((call) => call.kind === "click_element").length, 2, "the first attempt was a proven pre-dispatch refusal");
  } finally { f.close(); }
});

test("desktop actions return a semantic change summary and only attach pixels when requested or structure is absent", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    const action = click(observed.target, "desktop-click-summary", observed.observation.controls[0]!.ref);
    const normal = await f.callRaw("m9r_computer_action", { action });
    const normalBody = normal.structuredContent as unknown as { observation?: { structure?: unknown; change?: { summary?: string } } };
    assert.equal(typeof normalBody.observation?.change?.summary, "string");
    assert.match(normalBody.observation!.change!.summary!, /structure|controls|changed|unchanged/i);
    assert.equal(normal.content?.some((item) => item.type === "image"), false,
      `structured actions should not repeat a screenshot by default (structure=${Boolean(normalBody.observation?.structure)}, content=${JSON.stringify(normal.content?.map((item) => item.type))})`);

    const nextTarget = normal.structuredContent.target;
    const visualAction = click(nextTarget, "desktop-click-explicit-image", normal.structuredContent.observation.controls[0]!.ref);
    visualAction.includeScreenshot = true;
    const visual = await f.callRaw("m9r_computer_action", { action: visualAction });
    assert.equal(visual.content?.some((item) => item.type === "image"), true, "the caller can request a screenshot explicitly");
  } finally { f.close(); }
});
