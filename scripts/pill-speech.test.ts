import assert from "node:assert/strict";
import test from "node:test";
import { createDictation, MAX_TALK_MS, type RecognitionLike, type SpeechEnv } from "../pill/src/core/speech";

class FakeRecognition implements RecognitionLike {
  static last: FakeRecognition | null = null;
  lang = ""; interimResults = false; continuous = false; maxAlternatives = 0;
  onresult: RecognitionLike["onresult"] = null; onerror: RecognitionLike["onerror"] = null; onend: RecognitionLike["onend"] = null;
  started = 0; stopped = 0;
  constructor() { FakeRecognition.last = this; }
  start() { this.started += 1; }
  stop() { this.stopped += 1; this.onend?.(); }
}

function setup(over: Partial<SpeechEnv> = {}) {
  const log: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let seq = 0;
  const env: SpeechEnv = { Recognition: FakeRecognition, micIsOn: async () => true, openMicSetup: () => log.push("setup"), lang: "en-US", ...over };
  const dictation = createDictation(env, {
    onListening: (on) => log.push(`listening:${on}`),
    onLive: (t) => log.push(`live:${t}`),
    onText: (t) => log.push(`text:${t}`),
    onNotice: (t, bad) => log.push(`notice:${bad}:${t}`),
  }, {
    setTimeout: ((fn: () => void, ms: number) => { const id = ++seq; timers.push({ fn, ms, id }); return id; }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }) as unknown as typeof clearTimeout,
  });
  return { dictation, log, timers };
}

const result = (isFinal: boolean, transcript: string) => Object.assign([{ transcript }], { isFinal }) as never;

test("hold to talk: interim words show live, the final words arrive as text once on release, nothing is sent", async () => {
  const { dictation, log } = setup();
  await dictation.start();
  const r = FakeRecognition.last!;
  assert.deepEqual([r.lang, r.interimResults, r.continuous, r.started], ["en-US", true, true, 1]);
  r.onresult!({ results: [result(true, "check the "), result(false, "pricing")] });
  dictation.stop();
  dictation.stop();
  assert.equal(r.stopped, 1, "a second release does not stop it again");
  assert.deepEqual(log, ["listening:true", "live:Listening…", "live:check the pricing", "listening:false", "text:check the"]);
});

test("a release before anything was heard produces no text, and the listening cap ends a forgotten press", async () => {
  const a = setup();
  await a.dictation.start();
  a.dictation.stop();
  assert.ok(!a.log.some((l) => l.startsWith("text:")));

  const b = setup();
  await b.dictation.start();
  assert.equal(b.timers.at(-1)?.ms, MAX_TALK_MS);
  FakeRecognition.last!.onresult!({ results: [result(true, "hello")] });
  b.timers.at(-1)!.fn();
  assert.ok(b.log.includes("text:hello"), "the cap stops listening and keeps what was heard");
});

test("without the microphone permission it opens setup and does not listen; with no recognizer it says so", async () => {
  const off = setup({ micIsOn: async () => false });
  await off.dictation.start();
  assert.deepEqual(off.log, ["notice:true:Turn on the microphone for M9R first (opening setup)", "setup"]);
  assert.equal(off.dictation.listening, false);

  const none = setup({ Recognition: null });
  await none.dictation.start();
  assert.deepEqual(none.log, ["notice:true:Speech isn't available in this browser"]);
});

test("letting go while the permission check runs never starts listening", async () => {
  let release: (v: boolean) => void = () => {};
  const { dictation, log } = setup({ micIsOn: () => new Promise<boolean>((r) => { release = r; }) });
  FakeRecognition.last = null;
  const started = dictation.start();
  dictation.stop();
  release(true);
  await started;
  assert.equal(FakeRecognition.last, null);
  assert.deepEqual(log, []);
});

test("recognizer errors end listening with a readable notice; 'no speech' is not an error", async () => {
  const a = setup();
  await a.dictation.start();
  FakeRecognition.last!.onerror!({ error: "audio-capture" });
  assert.deepEqual(a.log.slice(-2), ["listening:false", "notice:true:No microphone found"]);
  const b = setup();
  await b.dictation.start();
  FakeRecognition.last!.onerror!({ error: "no-speech" });
  assert.equal(b.log.at(-1), "notice:false:Didn't catch anything");
  const c = setup();
  await c.dictation.start();
  FakeRecognition.last!.onerror!({ error: "not-allowed" });
  assert.ok(c.log.includes("setup"));
});
