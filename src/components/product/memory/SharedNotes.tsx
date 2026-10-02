"use client";
import { useCallback, useEffect, useState } from "react";
import ProductConfirmDialog from "../ProductConfirmDialog";

interface Note { authorLabel?:string; id: string; title: string; body: string; source: string; reviewed: boolean; created_at: string; author_user_id: string | null; author_connection_id: string | null }
interface Usage { usedBytes: number; limitBytes: number; remainingBytes: number; limitReached: boolean }
const mib = (bytes: number) => (bytes / 1048576).toFixed(2);

export function SharedNotes({ conversationId }: { conversationId?: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [canManage,setCanManage] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/shared-memory${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`, { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load shared memory.");
      setNotes(data.notes); setUsage(data.usage); setCanManage(data.canManage === true); setError(null);
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Memory unavailable."); }
  }, [conversationId]);
  useEffect(() => { const abort = new AbortController(); void Promise.resolve().then(() => { if (!abort.signal.aborted) return load(abort.signal); }); return () => abort.abort(); }, [load]);
  async function mutate(payload: object, method: "POST" | "PATCH") {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/shared-memory", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save memory.");
      if (method === "POST") { setTitle(""); setBody(""); }
      setPendingDelete(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Memory action failed."); }
    finally { setBusy(false); }
  }
  return <section className="ol-panel p-5 space-y-4"><div><h2 className="text-base font-semibold">Shared memory</h2><p className="text-sm">Save facts and decisions for the team. Agents retrieve reviewed notes alongside existing rules and archived sessions.</p></div>
    {usage && <div><p className="text-xs">{mib(usage.usedBytes)} / {mib(usage.limitBytes)} MiB used across this workspace</p><meter aria-label="Workspace shared text memory" min={0} max={usage.limitBytes} value={Math.min(usage.usedBytes, usage.limitBytes)} className="w-full" /><p className="text-xs">Notes, rules, and archived session text share this pool. Saved memory stays readable when full. Delete memory to free space.</p></div>}
    {error && <p role="alert">{error}</p>}
    <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void mutate({ title, body, ...(conversationId ? { conversationId } : {}) }, "POST"); }}>
      <label className="text-sm">Title<input className="product-input" value={title} maxLength={160} required onChange={event => setTitle(event.target.value)} /></label>
      <label className="text-sm">Fact or decision<textarea className="product-input" value={body} maxLength={65536} required onChange={event => setBody(event.target.value)} /></label>
      <button type="submit" disabled={busy || !usage || usage.limitReached}>Save for review</button>
    </form>
    {notes.map(note => <article key={note.id} className="border-t pt-3"><h3 className="font-medium">{note.title}</h3><p className="whitespace-pre-wrap text-sm">{note.body}</p><p className="text-xs">{note.authorLabel ?? note.source} · {note.reviewed ? "Reviewed" : "Awaiting review"} · {new Date(note.created_at).toLocaleString()}</p>{canManage && <div className="flex gap-3 mt-2">{!note.reviewed && <button disabled={busy} type="button" onClick={() => void mutate({ id: note.id, action: "approve" }, "PATCH")}>Confirm memory</button>}<button disabled={busy} type="button" onClick={() => setPendingDelete(note)}>Delete</button></div>}</article>)}
    <ProductConfirmDialog open={Boolean(pendingDelete)} title="Delete saved memory?" description="This removes the note from shared memory and frees its storage. Existing session transcripts are unaffected." confirmLabel="Delete" busy={busy} onConfirm={() => { if (pendingDelete) void mutate({ id: pendingDelete.id, action: "delete" }, "PATCH"); }} onCancel={() => setPendingDelete(null)} />
  </section>;
}
