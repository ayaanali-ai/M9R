import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { registerComputerUseTools } from "../src/lib/native/computer-use-mcp";
import { createLocalStore } from "../src/lib/native/local-store";
import type { WebBrokerClient } from "../src/lib/native/web-broker-client";
import type { ComputerUseTarget, ComputerUseResult } from "../src/lib/native/computer-use-contract";

type Payload = { target: ComputerUseTarget; result: ComputerUseResult; observation: { elements: { ref: string }[]; controls: { ref: string }[] }; content?: unknown };
type Handler = (input: Record<string, unknown>) => Promise<{ structuredContent: Payload }>;
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
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 300, height: 200, capturedAt: new Date().toISOString() });
  const web: Pick<WebBrokerClient, "run" | "prepareTaskStage" | "taskStageAction"> = {
    prepareTaskStage: async () => ({ ok: true }),
    async run(request) {
      calls.push({ kind: request.action, operationId: request.operationId });
      if (request.action === "snapshot") return { ok: true, data: { tab: request.tab ?? "one", browserInstanceId: "daemon-one", tabId: request.tab ?? "target-one", url: "https://fixture.test/", text: "Verified state", nativeClickAvailable: true,
        elements: [{ ref, role: "button", name: "Action", actions: ["click"], rect: { x: 1, y: 2, width: 50, height: 20 } }] } };
      if (failure === "before") return { ok: false, error: "Owner pointer is active", dispatchState: "not-dispatched" };
      if (failure === "uncertain") throw new Error("Response lost after input");
      return { ok: true };
    },
    async taskStageAction(_token, _taskId, input, _mode, operationId) {
      const action = input as { kind: string };
      calls.push({ kind: action.kind, operationId });
      if (action.kind === "read_structure") return { ok: true, result: { status: "partial", capturedAt: new Date().toISOString(),
        elements: [{ ref: "uia:1", label: "Action", role: "Button", enabled: true, actions: ["invoke"], rect: { x: 1, y: 2, width: 50, height: 20 } }], fallbackCapture: capture() } };
      if (failure === "before") return { ok: false, error: "Owner pointer is active", dispatchState: "not-dispatched", gateCode: "foreground-lease" };
      if (failure === "uncertain") throw new Error("Response lost after input");
      return { ok: true, result: { capture: capture(), outcome: { status: "confirmed" }, operationReceipt: { status: "applied" }, actionExecuted: true } };
    },
  };
  registerComputerUseTools({ registerTool(name: string, _descriptor: unknown, handler: Handler) { handlers.set(name, handler); } } as never,
    { store, web: web as WebBrokerClient, requireIdentity: async () => identity, identityToken: async () => token, resolveTaskId: () => "T1" });
  return { calls, setFailure: (value: typeof failure) => { failure = value; },
    call: async (name: string, input: Record<string, unknown>) => (await handlers.get(name)!(input)).structuredContent,
    close: () => rmSync(root, { recursive: true, force: true }) };
}

function click(target: ComputerUseTarget, operationId = "click-one", elementRef = ref) {
  return { kind: "click", operationId, targetId: target.targetId, targetRevision: target.revision,
    locator: { kind: "element", ref: elementRef, snapshotId: target.revision },
    postcondition: { kind: "accessible-control-present", label: "Action" } };
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
