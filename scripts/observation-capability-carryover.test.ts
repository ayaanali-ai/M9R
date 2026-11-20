import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerComputerUseTools } from "../src/lib/native/computer-use-mcp";
import { createLocalStore } from "../src/lib/native/local-store";
import type { WebBrokerClient } from "../src/lib/native/web-broker-client";

// A pure visual ("capture") observation carries no accessibility tree at all --
// capture() in cua-stage-driver.ts is image-only by design, distinct from
// captureWithStructure(). Before this fix, a capture-only observation of a
// control a structured read had just proven editable/focused would silently
// report it as neither, because nothing carried that capability forward across
// calls. This exercises the carry-forward merge in observeDesktop(): the same
// logical target (matched by identity + logicalKey, then by the control's
// stable stageRef) keeps its last-known canReplaceValue/focused state when a
// later observation of it is visual-only.

type Handler = (input: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown> }>;

function fixture() {
  const temp = resolve(".test-tmp"); mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "observation-carryover-"));
  const store = createLocalStore(root);
  const token = store.issueIdentity("codex", "codex", "observation-carryover").token;
  const identity = store.verifyIdentity(token)!;
  const handlers = new Map<string, Handler>();
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 300, height: 200, capturedAt: new Date().toISOString() });
  const web: Pick<WebBrokerClient, "prepareTaskStage" | "taskStageAction"> = {
    prepareTaskStage: async () => ({ ok: true }),
    async taskStageAction(_token, _taskId, input) {
      const action = input as { kind: string };
      if (action.kind === "read_structure") {
        return { ok: true, result: { status: "complete", capturedAt: new Date().toISOString(),
          elements: [{ ref: "uia:1", label: "Notes", role: "Edit", enabled: true, canReplaceValue: true, focused: true,
            actions: ["setValue"], rect: { x: 1, y: 2, width: 50, height: 20 } }],
          fallbackCapture: capture() } };
      }
      // The plain capture() path: no structure at all, and its lightweight
      // `controls` entries never carry canReplaceValue/focused -- only rect
      // and identity (elementRef), matching the real native payload shape.
      return { ok: true, result: { capture: { ...capture(),
        controls: [{ elementRef: "uia:1", role: "Edit", rect: { x: 1, y: 2, width: 50, height: 20 } }] },
        outcome: { status: "confirmed" }, operationReceipt: { status: "applied" }, actionExecuted: true } };
    },
  };
  registerComputerUseTools({ registerTool(name: string, _descriptor: unknown, handler: Handler) { handlers.set(name, handler); } } as never,
    { store, web: web as WebBrokerClient, requireIdentity: async () => identity, identityToken: async () => token, resolveTaskId: () => "T1" });
  return { call: async (name: string, input: Record<string, unknown>) => (await handlers.get(name)!(input)).structuredContent,
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("a visual-only observation carries canReplaceValue/focused forward from the prior structured read of the same target", async () => {
  const f = fixture();
  try {
    const structured = await f.call("m9r_computer_observe", { target: "app-window" });
    const structuredObservation = structured.observation as Record<string, unknown>;
    const structuredControls = structuredObservation.controls as Array<Record<string, unknown>>;
    assert.equal(structuredControls.length, 1, "the structured read should report the one Edit control");
    assert.equal(structuredControls[0].canReplaceValue, true);

    const visual = await f.call("m9r_computer_observe", { target: "app-window", representation: "visual" });
    const visualObservation = visual.observation as Record<string, unknown>;
    assert.equal(visualObservation.representation, "visual");
    const visualControls = visualObservation.controls as Array<Record<string, unknown>>;
    assert.equal(visualControls.length, 1, "the capture-only response's own control entry should still surface");
    assert.equal(visualControls[0].canReplaceValue, true,
      "canReplaceValue must be carried forward from the prior structured read, not silently dropped");
  } finally { f.close(); }
});

test("a visual-only observation of a target never seen structured carries nothing forward (no false positive)", async () => {
  const f = fixture();
  try {
    const visual = await f.call("m9r_computer_observe", { target: "app-window", representation: "visual" });
    const visualObservation = visual.observation as Record<string, unknown>;
    const visualControls = visualObservation.controls as Array<Record<string, unknown>>;
    assert.equal(visualControls.length, 1);
    assert.equal(visualControls[0].canReplaceValue, undefined,
      "with no prior structured observation to carry forward, canReplaceValue must stay absent rather than guessed");
  } finally { f.close(); }
});
