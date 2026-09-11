"use client";

/**
 * M9R_MASTER_BUILD_PLAN.md item #30's session browser -- the Mosaic-style
 * catalog re-verified frame by frame against their real demo (QVzn-1vzpsY):
 * a flat, timestamp-sorted list on one side, a two-column detail view (full
 * transcript + a fixed metadata sidebar) on click. Backed by data that
 * already existed (conversation_sessions, via session-service.ts's
 * getArchivedSessionForDashboard) -- this is a real UI on real data, not a
 * new store.
 *
 * Deliberately scoped to sessions already archived in THIS workspace, same
 * as the Live Sessions Archived tab it sits next to -- cross-channel/
 * cross-project browsing beyond that is the same "not yet scoped" gap noted
 * in the build plan for Mosaic's own multi-project session index.
 */

import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "@/lib/mission/mission-ui-presenter";

interface ArchivedSessionRow {
  id: string;
  conversationTopic: string;
  ownerLabel: string;
  title: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  archivedAtMs: number | null;
}

interface ArchivedSessionDetail extends ArchivedSessionRow {
  agentLabel: string;
  messageCount: number;
  transcript: Array<{ id: string; sender: string; body: string; createdAtMs: number }>;
}

type ListState = { kind: "loading" } | { kind: "ready"; rows: ArchivedSessionRow[] } | { kind: "error"; message: string };
type DetailState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; detail: ArchivedSessionDetail } | { kind: "error"; message: string };

export function SessionCatalog() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: "idle" });

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/live-sessions/archived", { cache: "no-store" });
      if (!res.ok) { setList({ kind: "error", message: "Could not load past sessions." }); return; }
      const json = (await res.json()) as { sessions?: ArchivedSessionRow[] };
      setList({ kind: "ready", rows: json.sessions ?? [] });
    } catch {
      setList({ kind: "error", message: "Could not load past sessions." });
    }
  }, []);

  useEffect(() => { queueMicrotask(() => void loadList()); }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      // The detail view is scoped to the selected archived session.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetail({ kind: "idle" });
      return;
    }
    let cancelled = false;
    // Show the loading state immediately when the selected session changes.
    setDetail({ kind: "loading" });
    fetch(`/api/dashboard/live-sessions/archived/${encodeURIComponent(selectedId)}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setDetail({ kind: "error", message: "Could not load this session." }); return; }
        const json = (await res.json()) as { session?: ArchivedSessionDetail };
        if (json.session) setDetail({ kind: "ready", detail: json.session });
        else setDetail({ kind: "error", message: "This session is no longer available." });
      })
      .catch(() => { if (!cancelled) setDetail({ kind: "error", message: "Could not load this session." }); });
    return () => { cancelled = true; };
  }, [selectedId]);

  if (list.kind === "loading") return <div className="ol-panel wf-glass-panel h-40 animate-pulse" />;
  if (list.kind === "error") return <div className="ol-panel wf-glass-panel p-5"><p className="text-[13px] text-[color:var(--ol-text-muted)]">{list.message}</p></div>;

  const filtered = query.trim()
    ? list.rows.filter((row) => row.title.toLowerCase().includes(query.trim().toLowerCase()) || row.ownerLabel.toLowerCase().includes(query.trim().toLowerCase()))
    : list.rows;

  return (
    <div className="wf-session-catalog">
      <section className="ol-panel wf-glass-panel wf-session-catalog__list">
        <div className="wf-session-catalog__search">
          <input
            type="search"
            placeholder="Search past sessions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="wf-session-catalog__search-input"
          />
        </div>
        {filtered.length === 0 ? (
          <p className="p-4 text-[12px] text-[color:var(--ol-text-muted)]">
            {list.rows.length === 0 ? "Nothing archived yet. Sessions show up here once they're closed out." : "No sessions match that search."}
          </p>
        ) : (
          <ul className="wf-session-catalog__rows">
            {filtered.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className="wf-session-catalog__row"
                  data-active={selectedId === row.id || undefined}
                >
                  <span className="wf-session-catalog__row-time">{relativeTime(new Date(row.lastActivityAtMs).toISOString())}</span>
                  <span className="wf-session-catalog__row-title">{row.title}</span>
                  <span className="wf-session-catalog__row-owner">@{row.ownerLabel}</span>
                  <span className="wf-session-catalog__row-channel">#{row.conversationTopic}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedId && (
        <section className="ol-panel wf-glass-panel wf-session-catalog__detail">
          {detail.kind === "loading" && <div className="p-6 text-[12px] text-[color:var(--ol-text-muted)]">Loading transcript…</div>}
          {detail.kind === "error" && <div className="p-6 text-[12px] text-[color:var(--ol-text-muted)]">{detail.message}</div>}
          {detail.kind === "ready" && (
            <div className="wf-session-catalog__detail-body">
              <div className="wf-session-catalog__transcript">
                <h4 className="wf-session-catalog__transcript-title">{detail.detail.title}</h4>
                {detail.detail.transcript.length === 0 ? (
                  <p className="text-[12px] text-[color:var(--ol-text-muted)]">No messages recorded for this session.</p>
                ) : (
                  detail.detail.transcript.map((message) => (
                    <div key={message.id} className="wf-session-catalog__message">
                      <span className="wf-session-catalog__message-sender">{message.sender}</span>
                      <p className="wf-session-catalog__message-body">{message.body}</p>
                    </div>
                  ))
                )}
              </div>
              <aside className="wf-session-catalog__meta">
                <MetaRow label="Agent">{detail.detail.agentLabel}</MetaRow>
                <MetaRow label="Owner">{detail.detail.ownerLabel}</MetaRow>
                <MetaRow label="Channel">#{detail.detail.conversationTopic}</MetaRow>
                <MetaRow label="Started">{new Date(detail.detail.startedAtMs).toLocaleString()}</MetaRow>
                {detail.detail.archivedAtMs && <MetaRow label="Archived">{new Date(detail.detail.archivedAtMs).toLocaleString()}</MetaRow>}
                <MetaRow label="Messages">{detail.detail.messageCount}</MetaRow>
              </aside>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wf-session-catalog__meta-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
