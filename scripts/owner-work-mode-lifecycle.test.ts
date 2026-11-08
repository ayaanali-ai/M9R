import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createOwnerWorkPolicy, setOwnerWorkMode } from "../src/lib/native/owner-work-mode";

test("foreground approval persists across task actions and expires on input, mode, stop, or task end", async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-owner-monitor-lifecycle-"));
  let active = true;
  let epoch = 0;
  let approvalCount = 0;
  let captureCount = 0;
  let releaseCount = 0;
  let monitorActive = false;
  const policy = createOwnerWorkPolicy(root, () => ({ requestApproval: async () => { approvalCount++; return true; } }), {
    isTaskActive: taskId => active && taskId === "T1",
    onTaskRevoked: () => { releaseCount++; monitorActive = false; },
  });
  const run = (op: Record<string, unknown>) => policy.run({ agent: "codex", provider: "codex", sessionId: "s1", taskId: "T1",
    signal: new AbortController().signal,
    assertActive: () => { if (!active) throw new Error("task is not active"); },
    readOwnerInputEpoch: async () => epoch,
    captureOwnerInputEpoch: async () => { captureCount++; monitorActive = true; return epoch; },
    releaseOwnerInputMonitor: async () => { releaseCount++; monitorActive = false; },
  }, () => policy.authorize(op));

  try {
    const first = await run({ op: "sendClick", pid: 123, windowId: "456" });
    assert.equal(first.ownerInputEpoch, 0);
    assert.equal(approvalCount, 1);
    assert.equal(captureCount, 1);
    assert.equal(monitorActive, true);

    await run({ op: "sendKeyCombo", pid: 123, windowId: "0x1c8" });
    assert.equal(approvalCount, 1, "the same exact task/window reuses the approved foreground turn");
    assert.equal(captureCount, 1, "the physical input monitor remains active across tool calls");

    epoch++;
    const renewed = await run({ op: "sendText", pid: 123, windowId: "456" });
    assert.equal(renewed.ownerInputEpoch, 1);
    assert.equal(approvalCount, 2, "physical owner input expires the prior turn and requires fresh approval");
    assert.equal(captureCount, 2);
    assert.equal(monitorActive, true, "the renewed grant is retained after its monitor is recaptured");

    policy.revokeTask({ agent: "codex", provider: "provider-alias", sessionId: "s1", taskId: "T1" });
    assert.equal(monitorActive, false, "task stop revokes the grant even when cleanup knows a provider alias");
    await run({ op: "sendClick", pid: 123, windowId: "456" });
    assert.equal(approvalCount, 3, "a revoked task grant cannot be reused");

    setOwnerWorkMode(root, "agents-free");
    policy.reapRevokedGrants();
    assert.equal(monitorActive, false, "changing modes reaps the old foreground monitor");
    setOwnerWorkMode(root, "working");
    await run({ op: "sendClick", pid: 123, windowId: "456" });
    assert.equal(approvalCount, 4, "returning to Working does not resurrect a prior foreground grant");

    active = false;
    policy.reapRevokedGrants();
    assert.equal(monitorActive, false, "task completion/pause releases the monitor without needing another task action");
    await assert.rejects(run({ op: "sendClick", pid: 123, windowId: "456" }), /not active/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("foreground grants stay inside the exact agent session, task, and HWND", async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-owner-work-scope-"));
  const activeTasks = new Set(["T1", "T2"]);
  const approvals: string[] = [];
  const policy = createOwnerWorkPolicy(root, () => ({ requestApproval: async request => {
    approvals.push(`${request.agent}:${request.sessionId}`);
    return true;
  } }), { isTaskActive: taskId => activeTasks.has(taskId) });
  const run = (agent: string, sessionId: string, taskId: string, windowId: string) => policy.run({
    agent, provider: agent, sessionId, taskId, signal: new AbortController().signal,
    readOwnerInputEpoch: async () => 0,
    captureOwnerInputEpoch: async () => 0,
  }, () => policy.authorize({ op: "sendText", pid: 123, windowId }));

  try {
    await run("codex", "session-a", "T1", "456");
    await run("codex", "session-a", "T1", "0x1c8");
    assert.equal(approvals.length, 1, "decimal and hexadecimal forms of the same HWND share a grant");

    await run("codex", "session-a", "T1", "789");
    await run("codex", "session-a", "T2", "456");
    await run("codex", "session-b", "T1", "456");
    await run("claude", "session-a", "T1", "456");
    assert.equal(approvals.length, 5, "a different target, task, session, or agent cannot inherit another grant");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
