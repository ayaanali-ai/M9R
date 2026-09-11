/**
 * NodeProcessExecutionHost — Phase 3B tests
 *
 * Worktree operations (prepare/quarantine/cleanup) are verified against an
 * injected fake git executor — the same pattern
 * resident-write-isolation.test.ts uses for `createGrantWorktree` itself, so
 * these tests stay deterministic and don't depend on a real git binary.
 * Process lifecycle (launch/inspect/collect/terminate) spawns REAL child
 * processes via `node -e`, the same pattern
 * resident-provider-adapters.test.ts uses to test `runProviderProcess`
 * without touching a real Codex/Claude Code binary.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { NodeProcessExecutionHost } from "../src/lib/mission/mission-process-host-node.ts";
import type { DispatchInstruction } from "../src/lib/mission/mission-scheduler-store.ts";
import type { ProviderProcessSpec } from "../src/lib/resident-provider-adapters.ts";

function instruction(overrides: Partial<DispatchInstruction> = {}): DispatchInstruction {
  return {
    instructionId: "intent-00000001",
    missionId: "m-1",
    workspaceId: "ws-1",
    repositoryId: null,
    dispatchKey: "primary",
    adapterRequirement: "codex",
    leaseId: "lease-1",
    fencingToken: 1,
    attempt: 1,
    executionConstraints: {},
    createdAt: "2026-07-29T00:00:00.000Z",
    deliveredAt: null,
    supersededAt: null,
    processHandle: null,
    ...overrides,
  };
}

function fakeGit() {
  const calls: { args: string[]; cwd: string }[] = [];
  const executor = async (file: string, args: string[], cwd: string) => {
    assert.equal(file, "git");
    calls.push({ args, cwd });
    return { stdout: "", stderr: "" };
  };
  return { executor, calls };
}

test("prepare creates a worktree via git (reused createGrantWorktree, not reimplemented) and returns a disposable environment", async () => {
  const { executor, calls } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });

  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });
  assert.equal(env.kind, "disposable");
  assert.equal(calls[0]?.args[0], "worktree");
  assert.equal(calls[0]?.args[1], "add");
});

test("quarantine uses `git worktree move`, not a plain filesystem rename", async () => {
  const { executor, calls } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });

  await host.quarantine(env.environmentId);
  const moveCall = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "move");
  assert.ok(moveCall, "expected a `git worktree move` call");
  assert.equal(host.isQuarantined(env.environmentId), true);
});

test("cleanup uses `git worktree remove --force`", async () => {
  const { executor, calls } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });

  await host.cleanup(env.environmentId);
  const removeCall = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove");
  assert.ok(removeCall);
  assert.ok(removeCall?.args.includes("--force"));
});

function echoSpec(text: string): ProviderProcessSpec {
  return {
    executable: process.execPath,
    args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(s);process.exit(0)})"],
    cwd: process.cwd(),
    env: { NODE_ENV: "test", PATH: process.env.PATH },
    stdin: text,
    shell: false,
  };
}

function sleepSpec(ms: number): ProviderProcessSpec {
  return {
    executable: process.execPath,
    args: ["-e", `setTimeout(()=>process.exit(0), ${ms})`],
    cwd: process.cwd(),
    env: { NODE_ENV: "test", PATH: process.env.PATH },
    stdin: "",
    shell: false,
  };
}

function burstSpec(bytes: number): ProviderProcessSpec {
  return {
    executable: process.execPath,
    args: ["-e", `process.stdout.write("x".repeat(${bytes}))`],
    cwd: process.cwd(),
    env: { NODE_ENV: "test", PATH: process.env.PATH },
    stdin: "",
    shell: false,
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitUntil timed out");
}

test("launch spawns a real process, inspect reports it running then confirmed dead, and collect returns its captured output", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });

  const handle = await host.launch({
    instruction: instruction(),
    environment: env,
    invocation: { adapterId: "codex", payload: echoSpec("hello from a real child process") },
  });

  assert.notEqual(handle.processId, "pending", "launch persists the child PID before returning its durable handle");

  await waitUntil(async () => (await host.inspect(handle)).kind === "process_confirmed_dead");

  const status = await host.inspect(handle);
  assert.equal(status.kind, "process_confirmed_dead");
  assert.equal(status.exitCode, 0);

  const output = await host.collect(handle);
  const text = output.events.map((e) => (e.raw as { text?: string }).text ?? "").join("");
  assert.match(text, /hello from a real child process/);
});

test("provider output events stay inside the host byte budget and report truncation", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({
    hostIdentity: "host-1",
    gitExecutor: executor,
    maxOutputEventBytes: 1_024,
    maxOutputEventCount: 8,
  });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });
  const handle = await host.launch({
    instruction: instruction(),
    environment: env,
    invocation: { adapterId: "codex", payload: burstSpec(64 * 1_024) },
  });

  await waitUntil(async () => (await host.inspect(handle)).kind === "process_confirmed_dead");
  const output = await host.collect(handle);
  const retainedBytes = output.events.reduce((total, event) => {
    const text = (event.raw as { text?: unknown }).text;
    return total + (typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0);
  }, 0);
  assert.ok(retainedBytes <= 1_024, `retained ${retainedBytes} bytes`);
  assert.ok(output.events.length <= 8);
  assert.equal(output.truncated, true);
});

test("terminate actually kills a still-running real process", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });

  const handle = await host.launch({
    instruction: instruction(),
    environment: env,
    invocation: { adapterId: "codex", payload: sleepSpec(60_000) },
  });

  // Give the child a moment to actually spawn and consume its stdin before
  // terminating — killing in the same tick as spawn can race the stdin
  // pipe teardown (an EPIPE on a socket write in flight), a known sharp
  // edge of the underlying `runProviderProcess` unrelated to what this test
  // is checking.
  await new Promise((r) => setTimeout(r, 100));

  const beforeKill = await host.inspect(handle);
  assert.equal(beforeKill.kind, "process_alive_not_reattachable");

  const termination = await host.terminate(handle);
  assert.equal(termination.terminated, true);

  await waitUntil(async () => (await host.inspect(handle)).kind === "process_confirmed_dead");
});

test("inspect reports process_status_unknown for a handle this host instance never tracked — the honest restart case", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });

  const status = await host.inspect({
    executionId: "ghost",
    environmentId: "env-x",
    environmentKind: "disposable",
    hostIdentity: "host-1",
    processId: "1234",
    processStartIdentity: "1234-0",
    createdAt: "2026-07-29T00:00:00.000Z",
    adapterId: "codex",
    providerSessionRef: null,
  });
  assert.equal(status.kind, "process_status_unknown");
});

test("reattach always refuses — a Node child_process cannot be resumed by a different instance", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  await assert.rejects(() =>
    host.reattach({
      executionId: "x",
      environmentId: "env-x",
      environmentKind: "disposable",
      hostIdentity: "host-1",
      processId: "1",
      processStartIdentity: "1-0",
      createdAt: "2026-07-29T00:00:00.000Z",
      adapterId: "codex",
      providerSessionRef: null,
    }),
  );
});

// ---------------------------------------------------------------------------
// The same host Claude Code uses too — timeout and idempotent cleanup,
// exercised with adapterRequirement: "claude-code" to make explicit these
// apply to Claude's exact execution path, not a Codex-only one.
// ---------------------------------------------------------------------------

test("a process that runs past its instruction's maxDurationMs times out and is reported confirmed dead", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const claudeInstruction = instruction({ adapterRequirement: "claude-code", executionConstraints: { maxDurationMs: 200 } });
  const env = await host.prepare({ instruction: claudeInstruction, repositoryRef: "C:/repos/app" });

  const handle = await host.launch({
    instruction: claudeInstruction,
    environment: env,
    invocation: { adapterId: "claude-code", payload: sleepSpec(60_000) },
  });

  await waitUntil(async () => (await host.inspect(handle)).kind === "process_confirmed_dead", 3_000);
  const status = await host.inspect(handle);
  assert.equal(status.kind, "process_confirmed_dead");
});

test("cleanup is idempotent — calling it twice on the same environment never throws", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const claudeInstruction = instruction({ adapterRequirement: "claude-code" });
  const env = await host.prepare({ instruction: claudeInstruction, repositoryRef: "C:/repos/app" });

  await host.cleanup(env.environmentId);
  await host.cleanup(env.environmentId); // must not throw the second time
});

// ---------------------------------------------------------------------------
// Phase 4D Part 4 §2/§4 — process-launch rejection handling
// ---------------------------------------------------------------------------

test("a spawn failure (nonexistent executable) is captured, never an unhandled promise rejection, and reaches a terminal confirmed-dead state", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { executor } = fakeGit();
    const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
    const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });

    const handle = await host.launch({
      instruction: instruction(),
      environment: env,
      invocation: { adapterId: "codex", payload: { executable: "this-binary-does-not-exist-anywhere", args: [], cwd: process.cwd(), env: {}, stdin: "", shell: false } },
    });

    await waitUntil(async () => (await host.inspect(handle)).kind === "process_confirmed_dead");
    const status = await host.inspect(handle);
    assert.equal(status.kind, "process_confirmed_dead");
    assert.match(status.detail, /launch never produced a normal exit/);

    // Give any microtask-queued unhandled-rejection reporting a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled.length, 0, "a spawn failure must never surface as an unhandled promise rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("collect reports a sentinel non-null exitCode for a launch that never produced a real exit, so a poller unblocks rather than waiting forever", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });

  const handle = await host.launch({
    instruction: instruction(),
    environment: env,
    invocation: { adapterId: "codex", payload: { executable: "this-binary-does-not-exist-anywhere", args: [], cwd: process.cwd(), env: {}, stdin: "", shell: false } },
  });

  await waitUntil(async () => (await host.collect(handle)).exitCode !== null);
  const output = await host.collect(handle);
  assert.equal(output.exitCode, -1);
});

// ---------------------------------------------------------------------------
// Phase 4D Part 4 §3 — confirmed termination semantics
// ---------------------------------------------------------------------------

test("terminate reports process_not_found for a handle this host never tracked", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const result = await host.terminate({
    executionId: "ghost",
    environmentId: "env-x",
    environmentKind: "disposable",
    hostIdentity: "host-1",
    processId: "1234",
    processStartIdentity: "1234-0",
    createdAt: "2026-07-29T00:00:00.000Z",
    adapterId: "codex",
    providerSessionRef: null,
  });
  assert.equal(result.kind, "process_not_found");
  assert.equal(result.terminated, false);
});

test("terminate reports process_identity_mismatch for a handle whose processStartIdentity doesn't match", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });
  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: { adapterId: "codex", payload: sleepSpec(60_000) } });
  await new Promise((r) => setTimeout(r, 100));

  const result = await host.terminate({ ...handle, processStartIdentity: "definitely-not-it" });
  assert.equal(result.kind, "process_identity_mismatch");
  assert.equal(result.terminated, false);

  // The mismatch check must refuse to terminate on a bad identity — but
  // that means the REAL underlying process was never signalled. Clean it
  // up with the correct handle so it doesn't linger for the rest of the
  // test run.
  await host.terminate(handle);
});

test("terminate reports already_exited (not a fabricated new termination) for a process that already finished on its own", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });
  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: { adapterId: "codex", payload: echoSpec("done quickly") } });

  await waitUntil(async () => (await host.inspect(handle)).kind === "process_confirmed_dead");
  const result = await host.terminate(handle);
  assert.equal(result.kind, "already_exited");
  assert.equal(result.terminated, false);
  assert.equal(result.alreadyGone, true);
});

test("terminate reports graceful_exit_confirmed for a real process that exits during the grace window", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor, terminationGraceMs: 2000, terminationConfirmMs: 500, terminationPollIntervalMs: 10 });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });
  // No SIGTERM handler installed — Node's default behavior is to exit on SIGTERM.
  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: { adapterId: "codex", payload: sleepSpec(60_000) } });
  await new Promise((r) => setTimeout(r, 100));

  const result = await host.terminate(handle);
  assert.equal(result.kind, "graceful_exit_confirmed");
  assert.equal(result.terminated, true);
});

// NOTE: a test that spawns a real child process which ignores termination
// signals entirely (to exercise `termination_timed_out`) was deliberately
// NOT added here. On Windows (this environment), `child.kill()` maps to
// `TerminateProcess` — a forceful, unconditional kill with no POSIX-signal
// semantics to "ignore" — so such a test would be both unreliable here and
// risk leaving a genuinely unkillable child process lingering for the
// remainder of the test run. The bounded-wait/timeout code path
// (`waitForFinish`, `terminationGraceMs`/`terminationConfirmMs`) is
// exercised indirectly by every test above that DOES confirm termination
// within a bounded window; the never-confirms branch is covered by
// reasoning and code review, not an added integration test, given the
// platform constraint. See IMPLEMENTATION_NOTES.md.

test("duplicate terminate calls are idempotent — a second call after confirmed exit reports already_exited", async () => {
  const { executor } = fakeGit();
  const host = new NodeProcessExecutionHost({ hostIdentity: "host-1", gitExecutor: executor, terminationGraceMs: 2000, terminationConfirmMs: 500, terminationPollIntervalMs: 10 });
  const env = await host.prepare({ instruction: instruction(), repositoryRef: "C:/repos/app" });
  const handle = await host.launch({ instruction: instruction(), environment: env, invocation: { adapterId: "codex", payload: sleepSpec(60_000) } });
  await new Promise((r) => setTimeout(r, 100));

  const first = await host.terminate(handle);
  assert.equal(first.kind, "graceful_exit_confirmed");

  const second = await host.terminate(handle);
  assert.equal(second.kind, "already_exited");
});
