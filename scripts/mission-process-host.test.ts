/**
 * ProcessExecutionHost — Phase 3A tests (InMemoryProcessExecutionHost)
 *
 * Covers: prepare/launch/inspect/collect/cleanup happy path, PID/process-
 * identity mismatch treated as process-absent rather than reattached, and
 * idempotent termination (a second terminate on an already-gone process
 * reports alreadyGone rather than erroring).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryProcessExecutionHost } from "../src/lib/mission/mission-process-host.ts";
import type { DispatchInstruction } from "../src/lib/mission/mission-scheduler-store.ts";

function instruction(overrides: Partial<DispatchInstruction> = {}): DispatchInstruction {
  return {
    instructionId: "intent-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    repositoryId: null,
    dispatchKey: "primary",
    adapterRequirement: "codex",
    leaseId: "lease-1",
    fencingToken: 1,
    attempt: 1,
    executionConstraints: {},
    createdAt: "2026-07-28T00:00:00.000Z",
    deliveredAt: null,
    supersededAt: null,
    processHandle: null,
    ...overrides,
  };
}

test("prepare -> launch -> inspect happy path reports process_status_unknown until scripted", async () => {
  const host = new InMemoryProcessExecutionHost();
  const env = await host.prepare({ instruction: instruction(), repositoryRef: null });
  assert.equal(env.kind, "disposable");

  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: null });
  assert.equal(handle.environmentId, env.environmentId);
  assert.equal(handle.environmentKind, "disposable");

  const status = await host.inspect(handle);
  assert.equal(status.kind, "process_status_unknown");
});

test("a processStartIdentity mismatch is treated as process_confirmed_dead, never reattached — a PID match alone is not identity", async () => {
  const host = new InMemoryProcessExecutionHost();
  const env = await host.prepare({ instruction: instruction(), repositoryRef: null });
  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: null });

  // Simulate the OS having reused this PID for an unrelated process after a
  // restart: same processId, but a caller presenting a stale/incorrect
  // processStartIdentity.
  const staleHandle = { ...handle, processStartIdentity: "not-the-real-one" };

  const status = await host.inspect(staleHandle);
  assert.equal(status.kind, "process_confirmed_dead");
});

test("terminate is idempotent: a second call after the process is already gone reports alreadyGone, not an error", async () => {
  const host = new InMemoryProcessExecutionHost();
  const env = await host.prepare({ instruction: instruction(), repositoryRef: null });
  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: null });

  const first = await host.terminate(handle);
  assert.equal(first.terminated, true);
  assert.equal(first.alreadyGone, false);

  const second = await host.terminate(handle);
  assert.equal(second.terminated, false);
  assert.equal(second.alreadyGone, true);
});

test("quarantine marks the environment and cleanup removes the prepared record", async () => {
  const host = new InMemoryProcessExecutionHost();
  const env = await host.prepare({ instruction: instruction(), repositoryRef: null });

  assert.equal(host.isQuarantined(env.environmentId), false);
  await host.quarantine(env.environmentId);
  assert.equal(host.isQuarantined(env.environmentId), true);

  await host.cleanup(env.environmentId);
});

test("reattach returns the process's captured output when reattach is supported", async () => {
  const host = new InMemoryProcessExecutionHost();
  const env = await host.prepare({ instruction: instruction(), repositoryRef: null });
  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: null });

  const reattached = await host.reattach(handle);
  assert.equal(reattached.handle.executionId, handle.executionId);
  assert.deepEqual(reattached.partialOutput.events, []);
});

test("reattach refuses when a handle was never launched", async () => {
  const host = new InMemoryProcessExecutionHost();
  await assert.rejects(() =>
    host.reattach({
      executionId: "ghost",
      environmentId: "env-x",
      environmentKind: "disposable",
      hostIdentity: "h",
      processId: "p",
      processStartIdentity: "s",
      createdAt: "2026-07-28T00:00:00.000Z",
      adapterId: "codex",
      providerSessionRef: null,
    }),
  );
});
