// Push-to-talk: speech becomes text in the message field and is never sent on its own. Browser-only (the desktop window
// has no speech service), so the pill offers it only when the host says it can.

export interface RecognitionResultLike {
  isFinal: boolean;
  0?: { transcript?: string };
}
export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<RecognitionResultLike> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface SpeechEnv {
  /** The browser's recognizer, or null when it has none. */
  Recognition: (new () => RecognitionLike) | null;
  micIsOn(): Promise<boolean>;
  /** Opens the one-time microphone setup tab; asking inside a page's frame would steal focus mid-press. */
  openMicSetup(): void;
  lang: string;
  /** Optional real audio level (0..1) while listening; returns a stop function. */
  startMeter?(onLevel: (level: number) => void): Promise<() => void>;
}

export interface DictationEvents {
  onListening(on: boolean): void;
  /** What has been heard so far, interim words included. */
  onLive(text: string): void;
  onLevel?(level: number): void;
  /** Final text, after the owner let go. */
  onText(text: string): void;
  onNotice(text: string, bad: boolean): void;
}

export const SPEECH_ERRORS: Record<string, string> = {
  "not-allowed": "Allow the microphone for M9R, then hold the mic again",
  "service-not-allowed": "Allow the microphone for M9R, then hold the mic again",
  "audio-capture": "No microphone found",
  network: "Speech needs an internet connection",
  "no-speech": "Didn't catch anything",
};

/** If the release is ever missed (the window lost focus mid-press), listening still ends on its own. */
export const MAX_TALK_MS = 45_000;

export interface Dictation {
  start(): Promise<void>;
  stop(): void;
  readonly listening: boolean;
}

export function createDictation(env: SpeechEnv, events: DictationEvents, timers = { setTimeout, clearTimeout }): Dictation {
  let want = false;
  let listening = false;
  let stopping = false;
  let recognizer: RecognitionLike | null = null;
  let heard = "";
  let cap: ReturnType<typeof setTimeout> | null = null;
  let stopMeter: (() => void) | null = null;

  const endMeter = () => { if (stopMeter) { stopMeter(); stopMeter = null; } };
  const clearCap = () => { if (cap !== null) { timers.clearTimeout(cap); cap = null; } };

  async function start() {
    if (listening || want) return;
    want = true;
    if (!env.Recognition) { want = false; events.onNotice("Speech isn't available in this browser", true); return; }
    if (!(await env.micIsOn())) { want = false; events.onNotice("Turn on the microphone for M9R first (opening setup)", true); env.openMicSetup(); return; }
    if (!want) return; // released while the permission check ran
    heard = "";
    stopping = false;
    const r = new env.Recognition();
    recognizer = r;
    r.lang = env.lang;
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    r.onresult = (event) => {
      let interim = "";
      let done = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const piece = event.results[i]?.[0]?.transcript ?? "";
        if (event.results[i].isFinal) done += piece; else interim += piece;
      }
      heard = done;
      events.onLive(`${done}${interim}`.trim() || "Listening…");
    };
    r.onerror = (event) => {
      listening = false;
      want = false;
      endMeter();
      events.onListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        events.onNotice("Turn on the microphone for M9R first (opening setup)", true);
        env.openMicSetup();
        return;
      }
      events.onNotice(SPEECH_ERRORS[event.error] || `Speech stopped: ${event.error}`, event.error !== "no-speech");
    };
    r.onend = () => {
      const wasListening = listening;
      want = false;
      listening = false;
      stopping = false;
      clearCap();
      endMeter();
      recognizer = null;
      events.onListening(false);
      const words = heard.trim();
      heard = "";
      if (wasListening && words) events.onText(words);
    };
    listening = true;
    clearCap();
    cap = timers.setTimeout(stop, MAX_TALK_MS);
    events.onListening(true);
    events.onLive("Listening…");
    try {
      r.start();
      if (env.startMeter && events.onLevel) void env.startMeter(events.onLevel).then((stopFn) => { if (listening) stopMeter = stopFn; else stopFn(); }).catch(() => { /* the meter is a nicety */ });
    } catch {
      listening = false;
      want = false;
      events.onListening(false);
    }
  }

  function stop() {
    want = false;
    // Both a key and a button can end it; the recognizer should only be told once.
    if (!recognizer || !listening || stopping) return;
    stopping = true;
    try { recognizer.stop(); } catch { /* already stopped */ }
  }

  return { start, stop, get listening() { return listening; } };
}

/** The real browser environment. `openMicSetup` is supplied by the shell. */
export function browserSpeechEnv(openMicSetup: () => void): SpeechEnv {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return {
    Recognition: w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null,
    lang: navigator.language || "en-US",
    openMicSetup,
    async micIsOn() {
      try { return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted"; } catch { return false; }
    },
    async startMeter(onLevel) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let level = 0;
      let frame = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) { const v = (samples[i] - 128) / 128; sum += v * v; }
        level = level * 0.7 + Math.sqrt(sum / samples.length) * 0.3;
        onLevel(level);
        frame = requestAnimationFrame(tick);
      };
      tick();
      return () => { cancelAnimationFrame(frame); stream.getTracks().forEach((t) => t.stop()); void ctx.close().catch(() => {}); };
    },
  };
}
