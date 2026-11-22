// Spoken updates: short lines said out loud when something worth hearing happens (a task finished, an agent needs you).
// Uses the voices the OS already has, so there is no key and no cost. The engine is one function, so a better voice
// service can replace it without touching any caller.

import { State } from "./state";

/** Prefer the natural-sounding voices when the OS offers them; the classic ones are the fallback. */
const PREFERRED = [/natural/i, /online/i, /aria|jenny|guy|ava|andrew|emma|brian/i, /zira/i];

let chosen: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const lang = (navigator.language || "en-US").slice(0, 2).toLowerCase();
  const local = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const pool = local.length ? local : voices;
  for (const pattern of PREFERRED) {
    const hit = pool.find((v) => pattern.test(v.name));
    if (hit) return hit;
  }
  return pool.find((v) => v.default) ?? pool[0] ?? null;
}

if (typeof speechSynthesis !== "undefined") {
  speechSynthesis.addEventListener?.("voiceschanged", () => { chosen = pickVoice(); });
}

export function voiceName(): string | null {
  chosen ??= pickVoice();
  return chosen?.name ?? null;
}

/** Says one short line. A newer line replaces whatever is still being said; the newest news wins. */
export function speak(text: string, opts: { force?: boolean } = {}): void {
  if (typeof speechSynthesis === "undefined") return;
  if (!opts.force && !State.settings.voiceEnabled) return;
  const line = text.trim();
  if (!line) return;
  chosen ??= pickVoice();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(line);
  if (chosen) u.voice = chosen;
  u.rate = State.settings.voiceRate;
  u.onstart = () => { State.speaking = true; State.notify(); };
  u.onend = u.onerror = () => { State.speaking = false; State.notify(); };
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
  State.speaking = false;
}

/** At most this many words, so a spoken update stays a glance, not a paragraph. */
export function brief(text: string, words = 14): string {
  const parts = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").split(" ");
  return parts.length > words ? `${parts.slice(0, words).join(" ")}…` : parts.join(" ");
}
