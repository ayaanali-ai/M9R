import assert from "node:assert/strict";
import test from "node:test";
import { normalizeManagedProviderProfile, type ManagedProviderConnectionProfile, type ManagedProviderConnectionSnapshot, type ManagedProviderEvent, type ManagedProviderTask } from "@/lib/native/managed-provider-contract";
import { runControlledRuntimeUpdate, type ControlledRuntimeUpdateSupervisor } from "@/lib/native/managed-runtime-update";

function profile(): ManagedProviderConnectionProfile {
  return normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "C:/Work/Project" });
}

function fakeSupervisor(log: string[], options: { drain?: () => Promise<void> } = {}): ControlledRuntimeUpdateSupervisor {
  const snapshot: ManagedProviderConnectionSnapshot = {
    connectionId: "m9r:claude:claude-code:c%3A%2Fwork%2Fproject",
    handle: "claude",
    provider: "claude-code",
    cwd: "c:/work/project",
    status: "ready",
    generation: 1,
    doing: "Ready",
  };
  return {
    async drain() { log.push("drain"); await options.drain?.(); },
    async stop() { log.push("stop"); },
    async restore() { log.push("restore"); return [snapshot]; },
    snapshots() { return [snapshot]; },
  };
}

test("drains, stops, replaces, starts, restores, and cleans in one ordered update", async () => {
  const log: string[] = [];
  const result = await runControlledRuntimeUpdate({
    supervisor: fakeSupervisor(log),
    profiles: [profile()],
    currentGeneration: "gen-1",
    replaceStablePackage: async () => { log.push("replace"); return { generation: "gen-2" }; },
    verifyStablePackage: async (generation) => { log.push(`verify:${generation}`); },
    startGeneration: async (generation) => { log.push(`start:${generation}`); },
    cleanupRetiredArtifacts: async () => { log.push("cleanup"); return { remaining: [] }; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.phase, "succeeded");
  assert.deepEqual(log, ["drain", "stop", "replace", "verify:gen-2", "start:gen-2", "restore", "cleanup"]);
});

test("does not claim success or leave retired artifacts launchable when cleanup is incomplete", async () => {
  const log: string[] = [];
  let rolledBack = false;
  const result = await runControlledRuntimeUpdate({
    supervisor: fakeSupervisor(log),
    profiles: [profile()],
    currentGeneration: "gen-1",
    replaceStablePackage: async () => { log.push("replace"); return { generation: "gen-2" }; },
    verifyStablePackage: async () => { log.push("verify"); },
    startGeneration: async (generation) => { log.push(`start:${generation}`); },
    cleanupRetiredArtifacts: async () => { log.push("cleanup"); return { remaining: ["m9r-engine.m9r-retired-locked"] }; },
    rollbackStablePackage: async () => { rolledBack = true; log.push("rollback"); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, "failed");
  assert.equal(result.cleanupPending?.length, 1);
  assert.equal(rolledBack, true);
  assert.match(result.error ?? "", /retired artifacts remain/);
  assert.deepEqual(log, ["drain", "stop", "replace", "verify", "start:gen-2", "restore", "cleanup", "rollback", "start:gen-1", "restore"]);
});

test("fails closed on a stuck drain unless the owner explicitly bounds active work", async () => {
  let releaseDrain!: () => void;
  const neverDone = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const log: string[] = [];
  let replaced = false;
  const result = await runControlledRuntimeUpdate({
    supervisor: fakeSupervisor(log, { drain: () => neverDone }),
    profiles: [profile()],
    currentGeneration: "gen-1",
    drainTimeoutMs: 5,
    replaceStablePackage: async () => { replaced = true; return { generation: "gen-2" }; },
    verifyStablePackage: async () => undefined,
    startGeneration: async () => undefined,
    cleanupRetiredArtifacts: async () => ({ remaining: [] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, "failed");
  assert.equal(replaced, false);
  assert.match(result.error ?? "", /drain timed out/);
  releaseDrain();
});

test("bounds active work before replacing when the caller supplies an explicit owner policy", async () => {
  const log: string[] = [];
  const result = await runControlledRuntimeUpdate({
    supervisor: fakeSupervisor(log, { drain: () => new Promise<void>(() => undefined) }),
    profiles: [profile()],
    currentGeneration: "gen-1",
    drainTimeoutMs: 5,
    boundActiveWork: async () => { log.push("bound"); },
    replaceStablePackage: async () => { log.push("replace"); return { generation: "gen-2" }; },
    verifyStablePackage: async () => { log.push("verify"); },
    startGeneration: async () => { log.push("start"); },
    cleanupRetiredArtifacts: async () => { log.push("cleanup"); return { remaining: [] }; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.activeWorkBound, true);
  assert.deepEqual(log, ["drain", "bound", "stop", "replace", "verify", "start", "restore", "cleanup"]);
});

test("rolls back a replaced package when the new generation cannot start", async () => {
  const log: string[] = [];
  let rollbackCount = 0;
  const result = await runControlledRuntimeUpdate({
    supervisor: fakeSupervisor(log),
    profiles: [profile()],
    currentGeneration: "gen-1",
    replaceStablePackage: async () => { log.push("replace"); return { generation: "gen-2" }; },
    verifyStablePackage: async () => { log.push("verify"); },
    startGeneration: async (generation) => {
      log.push(`start:${generation}`);
      if (generation === "gen-2") throw new Error("new owner generation did not start");
    },
    cleanupRetiredArtifacts: async () => ({ remaining: [] }),
    rollbackStablePackage: async () => { rollbackCount += 1; log.push("rollback"); },
  });

  assert.equal(result.ok, false);
  assert.equal(rollbackCount, 1);
  assert.match(result.error ?? "", /new owner generation did not start/);
  assert.deepEqual(log, ["drain", "stop", "replace", "verify", "start:gen-2", "rollback", "start:gen-1", "restore"]);
});
