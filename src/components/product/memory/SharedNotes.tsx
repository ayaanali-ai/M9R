"use client";
import { useCallback, useEffect, useState } from "react";
import ProductConfirmDialog from "../ProductConfirmDialog";

interface Note { authorLabel?: string; id: string; title: string; body: string; source: string; reviewed: boolean; created_at: string; author_user_id: string | null; author_connection_id: string | null }
interface Usage { usedBytes: number; limitBytes: number; remainingBytes: number; limitReached: boolean }
const mib = (bytes: number) => (bytes / 1048576).toFixed(2);

/** One box: the first line becomes the title. Saving is one step; nobody fills in a form. */
function splitNote(text: string) {
  const [first, ...rest] = text.trim().split("\n");
  const title = first.trim().slice(0, 160);
  return { title, body: rest.join("\n").trim() || title };
}

export function SharedNotes({ conversationId, search = "" }: { conversationId?: string; search?: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [text, setText] = useState("");
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
      if (method === "POST") setText("");
      setPendingDelete(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Memory action failed."); }
    finally { setBusy(false); }
  }
  function save() {
    if (!text.trim()) return;
    void mutate({ ...splitNote(text), ...(conversationId ? { conversationId } : {}) }, "POST");
  }
  const needle = search.trim().toLowerCase();
  const shown = needle ? notes.filter((note) => `${note.title} ${note.body}`.toLowerCase().includes(needle)) : notes;

  return (
    <div className="space-y-4">
      <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <textarea
          className="product-input"
          value={text}
          maxLength={65536}
          rows={2}
          aria-label="Save a fact or decision"
          placeholder="Save a fact or decision for the team. The first line is the title."
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); } }}
        />
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy || !text.trim() || !usage || usage.limitReached}>Save</button>
          <span className="text-xs">Agents save here too, with the m9r_note tool.</span>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {shown.length === 0 && !error && <p className="text-sm">{needle ? "Nothing matches that search." : "Nothing saved yet."}</p>}
      {shown.map((note) => (
        <article key={note.id} className="border-t pt-3">
          <h3 className="font-medium">{note.title}</h3>
          {note.body !== note.title && <p className="whitespace-pre-wrap text-sm">{note.body}</p>}
          <p className="text-xs">{note.authorLabel ?? note.source} · {note.reviewed ? "Shared with agents" : "Waiting for a teammate to keep it"} · {new Date(note.created_at).toLocaleString()}</p>
          {canManage && (
            <div className="flex gap-3 mt-2">
              {!note.reviewed && <button disabled={busy} type="button" onClick={() => void mutate({ id: note.id, action: "approve" }, "PATCH")}>Keep</button>}
              <button disabled={busy} type="button" onClick={() => setPendingDelete(note)}>Delete</button>
            </div>
          )}
        </article>
      ))}
      {usage && <p className="text-xs">{mib(usage.usedBytes)} / {mib(usage.limitBytes)} MiB used across this workspace. Delete notes to free space.</p>}
      <ProductConfirmDialog open={Boolean(pendingDelete)} title="Delete saved memory?" description="This removes the note from shared memory and frees its storage. Existing session transcripts are unaffected." confirmLabel="Delete" busy={busy} onConfirm={() => { if (pendingDelete) void mutate({ id: pendingDelete.id, action: "delete" }, "PATCH"); }} onCancel={() => setPendingDelete(null)} />
    </div>
  );
}
