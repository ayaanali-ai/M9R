"use client";

import { useEffect, useState } from "react";
import { AGENT_BRAND_COLOR } from "@/lib/agent-brand-color";

/**
 * Resolved cursor/mark color for one agent connection: per-person in a multi-human workspace,
 * per-agent (the static brand map) solo -- owner decision, 2026-10-18. Falls back to the static
 * per-agent color immediately (no loading flash to a neutral color) and swaps in the resolved
 * color once the request returns; a failed or missing request just keeps the static fallback.
 *
 * In-memory, per-tab cache keyed by connectionId so every component showing the same agent in
 * the same session reuses one request instead of refetching per mount.
 */
const colorCache = new Map<string, Promise<string | null>>();

async function fetchAgentColor(connectionId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/agent/color?connectionId=${encodeURIComponent(connectionId)}`);
    if (!res.ok) return null;
    const body = await res.json() as { color?: string | null };
    return typeof body.color === "string" ? body.color : null;
  } catch {
    return null;
  }
}

export function useAgentColor(connectionId: string | null | undefined, agentKey: string): string {
  const fallback = AGENT_BRAND_COLOR[agentKey] ?? "var(--ol-text-secondary)";
  const [resolved, setResolved] = useState<{ connectionId: string; color: string } | null>(null);

  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    let request = colorCache.get(connectionId);
    if (!request) {
      request = fetchAgentColor(connectionId);
      colorCache.set(connectionId, request);
    }
    request.then((resolved) => {
      if (!cancelled && resolved) setResolved({ connectionId, color: resolved });
    });
    return () => { cancelled = true; };
  }, [connectionId]);

  // A connection change immediately falls back to the stable provider color;
  // a result from a previous connection must never flash on the new one.
  return connectionId && resolved?.connectionId === connectionId ? resolved.color : fallback;
}
