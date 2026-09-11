import assert from "node:assert/strict";
import test from "node:test";

import { createResidentSupervisor, residentProfileNames, RESIDENT_STALE_BUILD_EXIT_CODE, type ResidentProcessHandle } from "@/lib/resident-supervisor";

function fakeHandle(onExit: (code: number | null) => void, log: string[], profile: string): ResidentProcessHandle {
  return {
    kill() { log.push(`kill:${profile}`); onExit(0); },
  };
}

test("profile discovery is bounded, unique, and ignores invalid config rows", () => {
  assert.deepEqual(residentProfileNames({ profiles: [
    { name: "claude" }, { name: "codex" }, { name: "claude" }, { name: "bad name" }, null,
  ] }), ["claude", "codex"]);
  assert.deepEqual(residentProfileNames({}), []);
});

test("supervisor keeps exactly one resident per profile and restarts only the failed resident", () => {
  const log: string[] = [];
  const exits = new Map<string, (code: number | null) => void>();
  const scheduled: Array<() => void> = [];
  const supervisor = createResidentSupervisor({
    profiles: ["claude", "codex", "claude"],
    launch(profile, onExit) {
      log.push(`launch:${profile}`);
      exits.set(profile, onExit);
      return fakeHandle(onExit, log, profile);
    },
    schedule(callback, delayMs) {
      assert.equal(delayMs, 5_000);
      scheduled.push(callback);
      return { cancel() {} };
    },
  });

  supervisor.start();
  supervisor.start();
  assert.deepEqual(log, ["launch:claude", "launch:codex"]);

  exits.get("claude")?.(1);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(supervisor.snapshot(), [
    { profile: "claude", state: "backoff", restarts: 1 },
    { profile: "codex", state: "running", restarts: 0 },
  ]);

  scheduled.shift()?.();
  assert.deepEqual(log, ["launch:claude", "launch:codex", "launch:claude"]);
});

test("supervisor shutdown kills residents once and suppresses restart", () => {
  const log: string[] = [];
  const scheduled: Array<() => void> = [];
  const supervisor = createResidentSupervisor({
    profiles: ["claude"],
    launch: (profile, onExit) => fakeHandle(onExit, log, profile),
    schedule(callback) { scheduled.push(callback); return { cancel() { log.push("cancel"); } }; },
  });

  supervisor.start();
  supervisor.stop();
  supervisor.stop();
  assert.deepEqual(log, ["kill:claude"]);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(supervisor.snapshot(), [{ profile: "claude", state: "stopped", restarts: 0 }]);
});

test("supervisor launches a provider added after the runtime started and removes it cleanly", () => {
  const log: string[] = [];
  const supervisor = createResidentSupervisor({
    profiles: ["codex"],
    launch(profile, onExit) {
      log.push(`launch:${profile}`);
      return { kill() { log.push(`kill:${profile}`); onExit(0); } };
    },
    schedule() { return { cancel() { log.push("cancel"); } }; },
  });

  supervisor.start();
  supervisor.syncProfiles(["codex", "claude-code"]);
  assert.deepEqual(log, ["launch:codex", "launch:claude-code"]);
  supervisor.syncProfiles(["claude-code"]);
  assert.deepEqual(log, ["launch:codex", "launch:claude-code", "kill:codex"]);
  assert.deepEqual(supervisor.snapshot().map((row) => row.profile), ["claude-code"]);
});

test("restart budget decays over a rolling window instead of failing permanently after a lifetime total", () => {
  const scheduled: Array<() => void> = [];
  let exit: ((code: number | null) => void) | undefined;
  let launches = 0;
  let clock = 0;
  const supervisor = createResidentSupervisor({
    profiles: ["claude"],
    maxRestarts: 2,
    restartWindowMs: 60_000,
    now: () => clock,
    launch(_profile, onExit) { launches += 1; exit = onExit; return { kill() {} }; },
    schedule(callback) { scheduled.push(callback); return { cancel() {} }; },
  });
  supervisor.start();
  // Two crashes back to back exhaust the window-scoped budget...
  exit?.(1); scheduled.shift()?.();
  exit?.(1); scheduled.shift()?.();
  // ...but time passes well beyond the window before the third crash, so the
  // earlier two restarts have aged out and this one still gets a real retry
  // instead of failing permanently.
  clock += 61_000;
  exit?.(1);
  assert.equal(launches, 3);
  assert.deepEqual(supervisor.snapshot(), [{ profile: "claude", state: "backoff", restarts: 1 }]);
});

test("a resident exiting with RESIDENT_STALE_BUILD_EXIT_CODE (checkBuildFreshness's self-restart) relaunches immediately and never counts against the crash restart budget", () => {
  const scheduled: Array<() => void> = [];
  let exit: ((code: number | null) => void) | undefined;
  let launches = 0;
  const supervisor = createResidentSupervisor({
    profiles: ["claude"],
    maxRestarts: 2,
    restartWindowMs: 60_000,
    launch(_profile, onExit) { launches += 1; exit = onExit; return { kill() {} }; },
    schedule(callback) { scheduled.push(callback); return { cancel() {} }; },
  });
  supervisor.start();
  // A rebuild-heavy dev session restarting for fresh code many times in a
  // row must never trip the same breaker a real crash loop trips -- run it
  // well past the maxRestarts budget and confirm it keeps relaunching.
  for (let i = 0; i < 5; i += 1) {
    exit?.(RESIDENT_STALE_BUILD_EXIT_CODE);
    scheduled.shift()?.();
  }
  assert.equal(launches, 6);
  assert.deepEqual(supervisor.snapshot(), [{ profile: "claude", state: "running", restarts: 0 }]);
});

test("onStateChange fires for every transition, in particular the one nothing previously observed: entering failed", () => {
  const scheduled: Array<() => void> = [];
  let exit: ((code: number | null) => void) | undefined;
  const transitions: Array<{ profile: string; state: string }> = [];
  const supervisor = createResidentSupervisor({
    profiles: ["claude"],
    maxRestarts: 1,
    launch(_profile, onExit) { exit = onExit; return { kill() {} }; },
    schedule(callback) { scheduled.push(callback); return { cancel() {} }; },
    onStateChange(profile, state) { transitions.push({ profile, state }); },
  });
  supervisor.start();
  exit?.(1); scheduled.shift()?.();
  exit?.(1);
  assert.deepEqual(transitions, [
    { profile: "claude", state: "running" },
    { profile: "claude", state: "backoff" },
    { profile: "claude", state: "running" },
    { profile: "claude", state: "failed" },
  ]);
});

test("supervisor stops automatic restart after the bounded failure budget", () => {
  const scheduled: Array<() => void> = [];
  let exit: ((code: number | null) => void) | undefined;
  let launches = 0;
  const supervisor = createResidentSupervisor({
    profiles: ["claude"],
    maxRestarts: 2,
    launch(_profile, onExit) { launches += 1; exit = onExit; return { kill() {} }; },
    schedule(callback) { scheduled.push(callback); return { cancel() {} }; },
  });
  supervisor.start();
  exit?.(1); scheduled.shift()?.();
  exit?.(1); scheduled.shift()?.();
  exit?.(1);

  assert.equal(launches, 3);
  assert.deepEqual(supervisor.snapshot(), [{ profile: "claude", state: "failed", restarts: 2 }]);
  assert.deepEqual(scheduled, []);
});

test("retryFailed reports which profiles it actually retried, so a remote reconnect request can say something real", () => {
  // Item 27a: the dashboard's "Reconnect agents" button had no way to know
  // whether anything happened. This return value is what makes that possible
  // -- an empty array must mean "nothing was stuck," not just "nothing threw."
  const scheduled: Array<() => void> = [];
  let claudeExit: ((code: number | null) => void) | undefined;
  let launches = 0;
  const supervisor = createResidentSupervisor({
    profiles: ["claude", "codex"],
    maxRestarts: 1,
    launch(profile, onExit) {
      launches += 1;
      if (profile === "claude") claudeExit = onExit;
      return { kill() {} };
    },
    schedule(callback) { scheduled.push(callback); return { cancel() {} }; },
  });
  supervisor.start();

  // Nothing has failed yet -- retrying must report nothing, not silently
  // "succeed" at retrying zero real problems.
  assert.deepEqual(supervisor.retryFailed(), []);

  claudeExit?.(1); scheduled.shift()?.();
  claudeExit?.(1);
  assert.deepEqual(supervisor.snapshot().find((s) => s.profile === "claude"), { profile: "claude", state: "failed", restarts: 1 });

  const launchesBeforeRetry = launches;
  const retried = supervisor.retryFailed();
  assert.deepEqual(retried, ["claude"]);
  assert.equal(launches, launchesBeforeRetry + 1, "retryFailed must actually relaunch the failed profile, not just report it");
  assert.equal(supervisor.snapshot().find((s) => s.profile === "claude")?.state, "running");

  // Codex was never touched -- it must not show up as "retried."
  assert.deepEqual(supervisor.retryFailed(), []);
});
