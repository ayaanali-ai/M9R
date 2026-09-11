"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

const startedChannels = new Set<string>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  const frame = requestAnimationFrame(listener);
  return () => { cancelAnimationFrame(frame); listeners.delete(listener); window.removeEventListener("storage", listener); };
}

/** Stores only a flag, never message content. Persists across reloads in this
 * browser; existing server messages establish the flag on other devices. */
export function ChannelWelcome({ channelKey, hasMessages, hasConfirmedMessages = hasMessages, showConstellation = false }: {
  channelKey: string; hasMessages: boolean; hasConfirmedMessages?: boolean; showConstellation?: boolean;
}) {
  const key = `m9r:channel-started:${channelKey}`;
  const snapshot = useCallback(() => {
    if (startedChannels.has(key)) return true;
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  }, [key]);
  const started = useSyncExternalStore(subscribe, snapshot, () => true);
  useEffect(() => {
    if (!hasConfirmedMessages) return;
    startedChannels.add(key);
    try { localStorage.setItem(key, "1"); } catch { /* In-memory fallback for restricted storage. */ }
    listeners.forEach(listener => listener());
  }, [hasConfirmedMessages, key]);
  if (hasMessages || started) return null;
  return <li className="wf-chat-empty"><div className="m9r-workspace-welcome">
    {showConstellation && <div className="m9r-agent-constellation" aria-hidden="true"><span data-agent="human">M</span><span data-agent="codex">C</span><span data-agent="claude">✳</span><i /><i /><i /></div>}
    <h3>One room.<br /><span>Every agent in context.</span></h3>
  </div></li>;
}
