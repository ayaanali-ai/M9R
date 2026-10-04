/**
 * Per-browser channel preferences: the mascot colour and which built-in channels are hidden from the sidebar.
 * Kept in localStorage on purpose (no schema change); a shared, per-workspace value can replace it later without
 * touching the callers, which only use the functions below.
 */

import { useMemo, useSyncExternalStore } from "react";

export type ChannelColorKey = "blue" | "green" | "coral" | "violet" | "gold" | "rose" | "teal";

export const CHANNEL_COLORS: Record<ChannelColorKey, { label: string; gradient: [string, string, string] }> = {
  blue: { label: "Blue", gradient: ["#A4DAF5", "#4B9BCE", "#245D98"] },
  green: { label: "Green", gradient: ["#9FE6B5", "#3FAE6E", "#1C7A4C"] },
  coral: { label: "Coral", gradient: ["#F7C9A2", "#D88062", "#A74737"] },
  violet: { label: "Violet", gradient: ["#D2C4FF", "#8B7BE4", "#4B3E98"] },
  gold: { label: "Gold", gradient: ["#F7E7B5", "#E3C158", "#9A7B1E"] },
  rose: { label: "Rose", gradient: ["#FAC3D4", "#E0698F", "#9B2F58"] },
  teal: { label: "Teal", gradient: ["#A5EBE3", "#37B5A8", "#17726A"] },
};

const COLOR_KEY = "m9r_channel_colors_v1";
const HIDDEN_KEY = "m9r_hidden_channels_v1";
export const CHANNEL_PREFS_EVENT = "m9r:channel-prefs";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: the choice lasts until reload */ }
  window.dispatchEvent(new Event(CHANNEL_PREFS_EVENT));
}

export function isChannelColorKey(value: unknown): value is ChannelColorKey {
  return typeof value === "string" && value in CHANNEL_COLORS;
}

export function readChannelColors(): Record<string, ChannelColorKey> {
  const stored = readJson<Record<string, unknown>>(COLOR_KEY, {});
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, ChannelColorKey] => isChannelColorKey(entry[1])));
}

export function setChannelColor(conversationId: string, color: ChannelColorKey | null) {
  const next = readChannelColors();
  if (color) next[conversationId] = color; else delete next[conversationId];
  writeJson(COLOR_KEY, next);
}

export function readHiddenChannels(): string[] {
  const stored = readJson<unknown>(HIDDEN_KEY, []);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}

export function setChannelHidden(conversationId: string, hidden: boolean) {
  const next = new Set(readHiddenChannels());
  if (hidden) next.add(conversationId); else next.delete(conversationId);
  writeJson(HIDDEN_KEY, [...next]);
}

export function showAllHiddenChannels() {
  writeJson(HIDDEN_KEY, []);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANNEL_PREFS_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANNEL_PREFS_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

const rawSnapshot = (key: string) => () => {
  try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; }
};
const colorsRaw = rawSnapshot(COLOR_KEY);
const hiddenRaw = rawSnapshot(HIDDEN_KEY);

/** Live per-browser mascot colours, keyed by conversation id. */
export function useChannelColors(): Record<string, ChannelColorKey> {
  const raw = useSyncExternalStore(subscribe, colorsRaw, () => "");
  return useMemo(() => (raw ? readChannelColors() : {}), [raw]);
}

/** Live list of built-in channels this browser has hidden. */
export function useHiddenChannels(): string[] {
  const raw = useSyncExternalStore(subscribe, hiddenRaw, () => "");
  return useMemo(() => (raw ? readHiddenChannels() : []), [raw]);
}
