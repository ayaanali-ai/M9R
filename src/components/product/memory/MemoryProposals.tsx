"use client";
import { useCallback, useEffect, useState } from "react";

interface Proposal { id: string; title: string; body: string; authorLabel?: string; source: string; reviewed: boolean }

/**
 * Agents propose what is worth remembering at the end of their work; the person answers Yes or No right where
 * they are talking. Nothing is shared with other agents until a person says yes.
 */
export function MemoryProposals({ conversationId }: { conversationId: string }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/shared-memory?conversationId=${encodeURIComponent(conversationId)}`, { signal, cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { notes?: Proposal[]; canManage?: boolean };
      setProposals((data.notes ?? []).filter((note) => note.source === "agent" && !note.reviewed));
      setCanManage(data.canManage === true);
    } catch { /* the proposal bar is optional; stay quiet if it cannot load */ }
  }, [conversationId]);

  useEffect(() => {
    const abort = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(abort.signal);
    const timer = window.setInterval(() => void load(abort.signal), 20_000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [load]);

  async function answer(id: string, action: "approve" | "delete") {
    setBusyId(id);
    try {
      await fetch("/api/shared-memory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
      setProposals((current) => current.filter((proposal) => proposal.id !== id));
    } finally { setBusyId(null); }
  }

  if (!canManage || proposals.length === 0) return null;
  return (
    <div className="m9r-memory-proposals" role="region" aria-label="Memory suggestions">
      {proposals.slice(0, 2).map((proposal) => (
        <div key={proposal.id} className="m9r-memory-proposal">
          <span><strong>{proposal.authorLabel ?? "An agent"}</strong> wants to save to memory: <em>{proposal.title}</em></span>
          <span className="m9r-memory-proposal-actions">
            <button type="button" disabled={busyId === proposal.id} onClick={() => void answer(proposal.id, "approve")}>Save</button>
            <button type="button" disabled={busyId === proposal.id} onClick={() => void answer(proposal.id, "delete")} aria-label="Don't save">No</button>
          </span>
        </div>
      ))}
    </div>
  );
}
