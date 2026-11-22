import assert from "node:assert/strict";
import test from "node:test";
import { agentInputStreamId, createAgentInputStreams } from "../src/lib/native/agent-input-stream";

const identity = { handle: "codex", sessionId: "session-one" };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("one authenticated session retains its stream across tasks, with ordered commands", async () => {
  const streams = createAgentInputStreams();
  const gate = deferred();
  const started: number[] = [];
  const first = streams.run(identity, { taskId: "T1", kind: "background" }, async (context) => {
    started.push(context.sequence); await gate.promise; return context;
  });
  const second = streams.run({ ...identity, handle: "@CODEX" }, { taskId: "T2", kind: "foreground" }, async (context) => {
    started.push(context.sequence); return context;
  });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(started, [1]);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.streamId, b.streamId);
  assert.deepEqual(started, [1, 2]);
  assert.equal(streams.snapshot().length, 1);
  assert.equal(streams.snapshot()[0]?.nextSequence, 3);
  await streams.close();
});

test("different agent sessions execute concurrently without sharing a command queue", async () => {
  const streams = createAgentInputStreams();
  const gate = deferred();
  const started = new Set<string>();
  const work = [identity, { handle: "claude", sessionId: "session-two" }].map((actor) =>
    streams.run(actor, { taskId: "shared-task", kind: "replace_element" }, async (context) => {
      started.add(context.streamId); await gate.promise; return context.streamId;
    }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(started.size, 2);
  gate.resolve();
  assert.equal(new Set(await Promise.all(work)).size, 2);
  await streams.close();
});

test("pausing a task rejects queued input and aborts its active input without racing the next command", async () => {
  const streams = createAgentInputStreams();
  const gate = deferred();
  let activeSignal: AbortSignal | undefined;
  let laterStarted = false;
  const first = streams.run(identity, { taskId: "T1", kind: "type" }, async (context) => {
    activeSignal = context.signal; await gate.promise;
  });
  const queued = streams.run(identity, { taskId: "T1", kind: "hotkey" }, async () => { throw new Error("canceled input dispatched"); });
  const firstRejected = assert.rejects(first, /paused/);
  const queuedRejected = assert.rejects(queued, /paused/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(streams.cancelTask(identity, "T1"), true);
  assert.equal(activeSignal?.aborted, true);
  const later = streams.run(identity, { taskId: "T2", kind: "capture" }, async () => { laterStarted = true; });
  await Promise.resolve();
  assert.equal(laterStarted, false, "an aborted dispatch retains its lane until it really returns");
  gate.resolve();
  await Promise.all([firstRejected, queuedRejected, later]);
  assert.equal(laterStarted, true);
  await streams.close();
});

test("stream IDs are opaque, session-specific, and reject missing identity", () => {
  assert.equal(agentInputStreamId(identity), agentInputStreamId({ ...identity, handle: "@CODEX" }));
  assert.notEqual(agentInputStreamId(identity), agentInputStreamId({ ...identity, sessionId: "other" }));
  assert.doesNotMatch(agentInputStreamId(identity), /codex|session/);
  assert.throws(() => agentInputStreamId({ handle: "", sessionId: "" }), /authenticated/);
});
