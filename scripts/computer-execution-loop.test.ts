import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { registerComputerUseTools } from "../src/lib/native/computer-use-mcp";
import { createLocalStore } from "../src/lib/native/local-store";
import type { WebBrokerClient } from "../src/lib/native/web-broker-client";
import type { ComputerUseTarget, ComputerUseResult } from "../src/lib/native/computer-use-contract";

type Payload = { target: ComputerUseTarget; result: ComputerUseResult; observation: {
  elements: { ref: string }[];
  controls: { ref: string; label?: string }[];
  structure?: { status: string };
  capture?: unknown;
}; content?: unknown };
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
  const actionsSent: unknown[] = [];
  let failure: "none" | "before" | "uncertain" = "none";
  let batchFailure: "none" | "partial" = "none";
  let unlabeled = false;
  let popupCaptureFallback = false;
  let structureCoverage: Record<string, unknown> | undefined;
  let activeTaskId = "T1";
  let clockMs: number | undefined;
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 300, height: 200, capturedAt: new Date().toISOString() });
  const web: Pick<WebBrokerClient, "prepareTaskStage" | "taskStageAction"> = {
    prepareTaskStage: async () => ({ ok: true }),
    async taskStageAction(_token, _taskId, input, _mode, operationId) {
      const action = input as { kind: string };
      calls.push({ kind: action.kind, operationId });
      actionsSent.push(input);
      if (action.kind === "read_structure") return { ok: true, result: { status: unlabeled ? "complete" : "partial", capturedAt: new Date().toISOString(),
        ...(structureCoverage ? { coverage: structureCoverage } : {}),
        elements: [{ ref: "uia:1", label: unlabeled ? "" : "Action", role: "Button", enabled: true, actions: ["invoke"], rect: { x: 1, y: 2, width: 50, height: 20 } }], fallbackCapture: capture() } };
      if (failure === "before") return { ok: false, error: "Owner pointer is active", dispatchState: "not-dispatched", gateCode: "foreground-lease" };
      if (failure === "uncertain") throw new Error("Response lost after input");
      if (action.kind === "type_then_enter") return { ok: true, result: { capture: capture(), outcome: { status: "confirmed" },
        batchOutcome: batchFailure === "partial"
          ? { status: "partial", completedSteps: 1, totalSteps: 2, stoppedAt: "enter", message: "Owner interaction paused before Enter; no key was sent." }
          : { status: "complete", completedSteps: 2, totalSteps: 2 },
        operationReceipt: { status: "applied" }, actionExecuted: true } };
      const outcome = (input as { kind: string; view?: string }).kind === "click" && (input as { view?: string }).view === "popup"
        ? { status: "unverified", foregroundConfirmed: true }
        : { status: "confirmed" };
      return { ok: true, result: { ...(popupCaptureFallback && (input as { view?: string }).view === "popup" ? { captureScope: "popup" } : {}),
        capture: capture(), outcome, operationReceipt: { status: "applied" }, actionExecuted: true } };
    },
  };
  registerComputerUseTools({ registerTool(name: string, _descriptor: unknown, handler: Handler) { handlers.set(name, handler); } } as never,
    { store, web: web as WebBrokerClient, requireIdentity: async () => identity, identityToken: async () => token, resolveTaskId: () => activeTaskId,
      resolveWorkIdentity: () => ({ workId: "work-original", planRevision: activeTaskId === "T1" ? 0 : 1 }),
      now: () => new Date(clockMs ?? Date.now()) });
  return { calls, actionsSent, setTask: (taskId: string) => { activeTaskId = taskId; }, setFailure: (value: typeof failure) => { failure = value; }, setUnlabeled: () => { unlabeled = true; },
    setPopupCaptureFallback: () => { popupCaptureFallback = true; },
    setCoverage: (value: Record<string, unknown>) => { structureCoverage = value; },
    setBatchFailure: (value: typeof batchFailure) => { batchFailure = value; },
    setNow: (value: number) => { clockMs = value; },
    call: async (name: string, input: Record<string, unknown>) => (await handlers.get(name)!(input)).structuredContent,
    callRaw: async (name: string, input: Record<string, unknown>) => handlers.get(name)!(input),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("isolated-browser tools remain unregistered even if the retired opt-in variable is set", () => {
  const temp = resolve(".test-tmp"); mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "execution-loop-default-"));
  const store = createLocalStore(root);
  const token = store.issueIdentity("codex", "codex", "execution-loop-default").token;
  const identity = store.verifyIdentity(token)!;
  const handlers = new Map<string, Handler>();
  const priorOptIn = process.env.M9R_ENABLE_ISOLATED_BROWSER;
  try {
    process.env.M9R_ENABLE_ISOLATED_BROWSER = "1";
    registerComputerUseTools({ registerTool(name: string, _descriptor: unknown, handler: Handler) { handlers.set(name, handler); } } as never,
      { store, requireIdentity: async () => identity, identityToken: async () => token, resolveTaskId: () => "T1" });
    assert.equal(handlers.has("m9r_browser_open"), false, "the retired isolated-browser launch tool must not be registered");
    assert.equal(handlers.has("m9r_browser_tabs"), false, "the retired isolated-browser tab tool must not be registered");
  } finally {
    if (priorOptIn === undefined) delete process.env.M9R_ENABLE_ISOLATED_BROWSER;
    else process.env.M9R_ENABLE_ISOLATED_BROWSER = priorOptIn;
    rmSync(root, { recursive: true, force: true });
  }
});

function click(target: ComputerUseTarget, operationId = "click-one", elementRef = ref) {
  return { kind: "click", operationId, targetId: target.targetId, targetRevision: target.revision,
    locator: { kind: "element", ref: elementRef, snapshotId: target.revision },
    postcondition: { kind: "accessible-control-present", label: "Action" }, includeScreenshot: undefined as boolean | undefined };
}

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

test("desktop observation exposes only the bounded scroll-coverage contract", async () => {
  const f = fixture(); try {
    f.setCoverage({ scope: "window", visibleViewport: "observed", scrollability: "indicated", offscreenContent: "possible",
      min: 0, max: 99, currentValue: "must-not-leak" });
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    assert.deepEqual((observed.observation as unknown as { structure: { coverage: unknown } }).structure.coverage,
      { scope: "window", visibleViewport: "observed", scrollability: "indicated", offscreenContent: "possible" });
    assert.equal(JSON.stringify(observed.observation).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(observed.observation).includes("\"max\""), false);
  } finally { f.close(); }
});

test("post-action pixel captures are paired with a fresh accessibility structure read", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    const structureReadsBefore = f.calls.filter((call) => call.kind === "read_structure").length;
    const result = await f.call("m9r_computer_action", { action: click(observed.target, "post-action-uia-refresh", observed.observation.controls[0]!.ref) });

    assert.equal(f.calls.filter((call) => call.kind === "read_structure").length, structureReadsBefore + 1,
      "the changed surface must be re-read after the action instead of returning pixels as if they were a structured observation");
    assert.equal(result.observation.structure?.status, "partial");
    assert.equal(result.observation.controls.some((control: { label?: string }) => control.label === "Action"), true,
      "fresh semantic controls remain available for the next decision");
    assert.ok(result.observation.capture, "the refreshed tree retains its same-read screenshot fallback");
  } finally { f.close(); }
});

test("popup field clicks select the owned modal and allow subsequent popup text insertion", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    const selected = await f.call("m9r_computer_action", { action: {
      kind: "click", operationId: "save-dialog-field", targetId: observed.target.targetId, targetRevision: observed.target.revision,
      locator: { kind: "point", x: 46, y: 18, coordinateSpace: "target-local" }, targetPopup: true,
    } });
    const freshTarget = selected.target;
    const entered = await f.call("m9r_computer_action", { action: {
      kind: "text", mode: "insert", text: "M9R-demo-smoke.txt", targetPopup: true,
      operationId: "save-dialog-filename", targetId: freshTarget.targetId, targetRevision: freshTarget.revision,
    } });
    assert.equal(entered.result.dispatchStatus, "dispatched");
    assert.deepEqual(f.actionsSent.filter((action) => ["click", "type"].includes((action as { kind: string }).kind))
      .map((action) => ({ kind: (action as { kind: string }).kind, view: (action as { view?: string }).view })),
    [{ kind: "click", view: "popup" }, { kind: "type", view: "popup" }]);
    const dispatchedBeforeInvalidReplace = f.actionsSent.length;
    const invalidReplace = await f.callRaw("m9r_computer_action", { action: {
      kind: "text", mode: "replace", text: "bad", targetPopup: true, operationId: "popup-replace-no-ref",
      targetId: freshTarget.targetId, targetRevision: freshTarget.revision,
    } });
    assert.match(JSON.stringify(invalidReplace), /Popup text insertion/);
    assert.equal(f.actionsSent.length, dispatchedBeforeInvalidReplace, "popup replacement is rejected before dispatch because it has no exact popup-local field point");
  } finally { f.close(); }
});

test("popup-local fallback pixels are never reused as a fresh app observation", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    const structureReadsBefore = f.calls.filter((call) => call.kind === "read_structure").length;
    f.setPopupCaptureFallback();
    const result = await f.call("m9r_computer_action", { action: {
      kind: "click", operationId: "popup-close-no-parent-capture", targetId: observed.target.targetId,
      targetRevision: observed.target.revision,
      locator: { kind: "point", x: 46, y: 18, coordinateSpace: "target-local" }, targetPopup: true,
    } });

    assert.equal(result.result.dispatchStatus, "dispatched", "the successful input receipt survives the missing parent capture");
    assert.equal(result.result.effectStatus, "unknown", "the popup-local image cannot verify an app-window effect");
    assert.equal(result.result.error?.code, "post-action-observation-failed");
    assert.equal(f.calls.filter((call) => call.kind === "read_structure").length, structureReadsBefore,
      "popup-local pixels must not trigger an app-window UIA reread using the wrong coordinate frame");
    assert.equal(result.observation, undefined, "no popup-scoped pixels are presented as the app target's latest observation");
  } finally { f.close(); }
});

test("retired browser targets fail explicitly instead of waiting for an extension", async () => {
  const f = fixture(); try {
    const result = await f.callRaw("m9r_computer_observe", { target: "browser-tab", tab: "one" });
    assert.match(JSON.stringify(result), /extension-backed browser route is retired|stage_app/i);
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

test("observation refs expire on a new revision, not on wall-clock age", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    f.setNow(observed.target.observedAt + 180_000);
    const result = await f.call("m9r_computer_action", { action: click(observed.target, "aged-but-current-ref", observed.observation.controls[0]!.ref) });
    assert.equal(result.result.dispatchStatus, "dispatched");
    assert.equal(f.calls.filter((call) => call.kind === "click_element").length, 1, "the still-current ref is dispatched instead of rejected and refreshed");
  } finally { f.close(); }
});

test("desktop text-then-Enter batches require a selected exact app target and never replay or bypass no-submit intent", async () => {
  const f = fixture(); try {
    const observed = await f.call("m9r_computer_observe", { target: "app-window" });
    const selected = await f.call("m9r_computer_action", { action: click(observed.target, "batch-select", observed.observation.controls[0]!.ref) });
    const target = selected.target;
    const action = { kind: "text_then_enter", operationId: "text-enter-once", targetId: target.targetId, targetRevision: target.revision, text: "bounded query" };
    const completed = await f.call("m9r_computer_action", { action });
    assert.equal(completed.result.dispatchStatus, "dispatched");
    assert.deepEqual(completed.result.batchOutcome, { status: "complete", completedSteps: 2, totalSteps: 2 });
    await f.call("m9r_computer_action", { action });
    assert.equal(f.calls.filter((call) => call.kind === "type_then_enter").length, 1, "same operation receipt prevents replay");

    const after = await f.call("m9r_computer_observe", { target: "app-window" });
    const selectedAgain = await f.call("m9r_computer_action", { action: click(after.target, "batch-select-no-submit", after.observation.controls[0]!.ref) });
    const noSubmitAction = { kind: "text_then_enter", operationId: "text-enter-forbidden", targetId: selectedAgain.target.targetId,
      targetRevision: selectedAgain.target.revision, text: "must stay local", intent: { mode: "prepare", allowAdvance: false, allowSubmit: false } };
    const beforeForbidden = f.calls.filter((call) => call.kind === "type_then_enter").length;
    const refused = await f.call("m9r_computer_action", { action: noSubmitAction });
    assert.equal(refused.result.dispatchStatus, "not-dispatched");
    assert.match(refused.result.error?.message ?? "", /forbids submit-like Enter/);
    assert.equal(f.calls.filter((call) => call.kind === "type_then_enter").length, beforeForbidden, "no-submit blocks both batch steps before text dispatch");

    const fresh = await f.call("m9r_computer_observe", { target: "app-window" });
    const selectedPartial = await f.call("m9r_computer_action", { action: click(fresh.target, "batch-select-partial", fresh.observation.controls[0]!.ref) });
    const partialAction = { kind: "text_then_enter", operationId: "text-enter-partial", targetId: selectedPartial.target.targetId,
      targetRevision: selectedPartial.target.revision, text: "already inserted" };
    f.setBatchFailure("partial");
    const partial = await f.call("m9r_computer_action", { action: partialAction });
    assert.equal(partial.result.dispatchStatus, "dispatched", "the text step was delivered");
    assert.deepEqual(partial.result.batchOutcome, { status: "partial", completedSteps: 1, totalSteps: 2,
      stoppedAt: "enter", message: "Owner interaction paused before Enter; no key was sent." });
    assert.equal(partial.result.error?.retry, "never", "the completed text step must not be replayed");
  } finally { f.close(); }
});
