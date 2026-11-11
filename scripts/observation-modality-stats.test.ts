import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerComputerUseTools } from "../src/lib/native/computer-use-mcp";
import { createLocalStore } from "../src/lib/native/local-store";
import type { WebBrokerClient } from "../src/lib/native/web-broker-client";

// Item 7 of the latency plan: observeDesktop() already defaults to a structured (tree-only)
// observation and only falls back to a screenshot when the tree reports it can't answer.
// This exercises observationModalityStats(), the new pure-visibility counter that records
// how often each of the three real outcomes happens, with no change to that existing gating.

type Handler = (input: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown> }>;

function fixture(structureStatus: "complete" | "partial", label: string) {
  const temp = resolve(".test-tmp"); mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, "observation-modality-"));
  const store = createLocalStore(root);
  const token = store.issueIdentity("codex", "codex", "observation-modality").token;
  const identity = store.verifyIdentity(token)!;
  const handlers = new Map<string, Handler>();
  const capture = () => ({ dataUrl: "data:image/png;base64,eA==", width: 300, height: 200, capturedAt: new Date().toISOString() });
  const web: Pick<WebBrokerClient, "prepareTaskStage" | "taskStageAction"> = {
    prepareTaskStage: async () => ({ ok: true }),
    async taskStageAction(_token, _taskId, input) {
      const action = input as { kind: string };
      if (action.kind === "read_structure") {
        return { ok: true, result: { status: structureStatus, capturedAt: new Date().toISOString(),
          elements: [{ ref: "uia:1", label, role: "Button", enabled: true, actions: ["invoke"], rect: { x: 1, y: 2, width: 50, height: 20 } }],
          fallbackCapture: capture() } };
      }
      return { ok: true, result: { capture: capture(), outcome: { status: "confirmed" }, operationReceipt: { status: "applied" }, actionExecuted: true } };
    },
  };
  const result = registerComputerUseTools({ registerTool(name: string, _descriptor: unknown, handler: Handler) { handlers.set(name, handler); } } as never,
    { store, web: web as WebBrokerClient, requireIdentity: async () => identity, identityToken: async () => token, resolveTaskId: () => "T1" });
  return { stats: result.observationModalityStats,
    call: async (name: string, input: Record<string, unknown>) => (await handlers.get(name)!(input)).structuredContent,
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("a complete, fully-labeled tree observation counts as tree-only -- no screenshot needed", async () => {
  const f = fixture("complete", "Save");
  try {
    await f.call("m9r_computer_observe", { target: "app-window" });
    assert.deepEqual(f.stats(), { observations: 1, explicitVisual: 0, treeIncompleteFallback: 0, treeOnly: 1 });
  } finally { f.close(); }
});

test("a partial tree observation counts as the tree-incomplete screenshot fallback", async () => {
  const f = fixture("partial", "Save");
  try {
    await f.call("m9r_computer_observe", { target: "app-window" });
    assert.deepEqual(f.stats(), { observations: 1, explicitVisual: 0, treeIncompleteFallback: 1, treeOnly: 0 });
  } finally { f.close(); }
});

test("an explicit representation=visual request counts separately from a tree-driven fallback", async () => {
  const f = fixture("complete", "Save");
  try {
    await f.call("m9r_computer_observe", { target: "app-window", representation: "visual" });
    assert.deepEqual(f.stats(), { observations: 1, explicitVisual: 1, treeIncompleteFallback: 0, treeOnly: 0 });
  } finally { f.close(); }
});

test("stats accumulate across multiple observations instead of resetting", async () => {
  const f = fixture("complete", "Save");
  try {
    await f.call("m9r_computer_observe", { target: "app-window" });
    await f.call("m9r_computer_observe", { target: "app-window" });
    await f.call("m9r_computer_observe", { target: "app-window", representation: "visual" });
    assert.deepEqual(f.stats(), { observations: 3, explicitVisual: 1, treeIncompleteFallback: 0, treeOnly: 2 });
  } finally { f.close(); }
});
