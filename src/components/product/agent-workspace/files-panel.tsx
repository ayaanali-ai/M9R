"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AgentMark } from "@/components/product/WorkspaceUI";
import type { AgentView } from "@/lib/agent-workspace-data";
import type { WorkspaceStep } from "@/components/product/ConversationPanel";
import { langForPath } from "@/lib/highlight/shiki-highlighter";
import { relAt } from "@/components/product/agent-workspace/shared";
import { archivedSessionHref, channelHref } from "@/lib/run-navigation";
import type * as MonacoEditorNS from "monaco-editor";

// Monaco pulls in a large client-only bundle -- loaded lazily and only once
// Live Code is actually opened, same "don't tax every page load" posture as
// the Shiki highlighter above. ssr:false because Monaco touches `window`.
//
// @monaco-editor/react's default loader fetches Monaco from jsdelivr's CDN
// at runtime, which this app's CSP (script-src 'self') correctly blocks --
// confirmed live (a real CSP violation in the console, editor stuck on
// "Loading..." forever). Fixed by pointing its loader at the monaco-editor
// package already installed in node_modules instead, so the whole editor
// ships from this app's own bundle with zero external script fetch.
// Real production-build fix: the bare "monaco-editor" package resolves to
// its prebuilt AMD "min/vs" bundle (meant for a <script> loader, not a
// bundler), which broke a real `next build` here with "Module not found:
// Can't resolve 'vs/nls.messages-loader'" -- webpack can't statically
// analyze that bundle's own internal AMD requires. The package's ESM entry
// (monaco-editor/esm/vs/editor/editor.api) exports the same namespace shape
// and is what webpack can actually bundle; dev-mode Turbopack tolerated the
// bare import, which is why this only surfaced in `npm run build`.
const MonacoEditor = dynamic(() => Promise.all([import("@monaco-editor/react"), import("monaco-editor/editor/editor.api")]).then(([{ default: Editor, loader }, monaco]) => {
  loader.config({ monaco });
  // Monaco's background web worker (tokenization/bracket-matching) needs a
  // bundler-specific worker-loading setup this app doesn't have wired up --
  // confirmed live as a real console error (its ESM build's own internal
  // worker bootstrap fails to resolve under Turbopack, independent of this
  // MonacoEnvironment override, which only covers the getWorker path). Left
  // in place because it's still the correct override to have and does quiet
  // some of the failures, but be aware: some worker-load errors still print
  // to the console. They're non-fatal -- confirmed live, the editor still
  // renders and highlights correctly since basic syntax coloring is plain
  // Monarch tokenization, not worker-backed. Wiring a real Monaco worker
  // under Turbopack is unsolved here and would be its own task, needed only
  // once this view gains features that actually require one (diagnostics,
  // formatting) -- this read-only view doesn't.
  class NullWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }
  (window as unknown as { MonacoEnvironment: { getWorker: () => NullWorker } }).MonacoEnvironment = { getWorker: () => new NullWorker() as unknown as NullWorker };
  return Editor;
}), { ssr: false });
const MonacoDiffEditor = dynamic(() => Promise.all([import("@monaco-editor/react"), import("monaco-editor/editor/editor.api")]).then(([{ DiffEditor, loader }, monaco]) => {
  loader.config({ monaco });
  class NullWorker { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }
  (window as unknown as { MonacoEnvironment: { getWorker: () => NullWorker } }).MonacoEnvironment = { getWorker: () => new NullWorker() as unknown as NullWorker };
  return DiffEditor;
}), { ssr: false });

/**
 * Files panel (Option A step 12, phase 1+2, then B1) -- "the Change Wall".
 *
 * B1 split it in two. The 320px side slot was never enough room for three
 * horizontal columns: a diff wrapped at ~38 characters and file paths
 * truncated to nothing. So the rail (WorkspaceFilesRail) now carries only
 * the agent-grouped file list with +N/-N and the live-write pulse, and
 * clicking a row opens Live Code (LiveFileView) as a third grid column
 * beside chat -- see .wf-chat-file-slot in globals.css -- not a takeover of
 * the message feed (that was the original B1 shape; superseded once "Chat +
 * IDE, both visible at once" became the actual requirement). The old
 * live-event ticker column is gone entirely: every row it listed is already
 * a row in the file list, which sorts by recency and pulses while a write
 * is in flight -- it was the same information twice, and the rail can only
 * afford one.
 *
 * Backed by workspace_file_activity, fed from two real sources: an agent's
 * own ACP tool calls, and (source: "fs_watch") the one per-machine resident
 * process's real filesystem watcher -- see workspace-file-activity-service.ts's
 * WorkspaceFileActivitySource doc comment. The watcher is what makes a
 * deletion honestly show up even when no agent ever reported it (confirmed
 * live as a real gap: a manually-deleted file used to sit in this list
 * forever looking current). This app's own server still never touches your
 * disk -- the watcher runs entirely on your machine, in the resident you
 * already run to connect agents.
 *
 * Live path: `liveSteps` comes from ConversationPanel's existing relay
 * subscription (workspace.step frames with a filePath) via a callback prop
 * threaded through AgentWorkspaceClient -- no second relay connection. It's
 * therefore scoped to whichever channel is currently selected, same as the
 * rest of the live chat surface, not the whole workspace at once.
 *
 * Diff coloring (+/- line-prefix based) and real syntax highlighting (phase
 * 2, via Shiki -- see src/lib/highlight/shiki-highlighter.ts and its custom
 * monochrome theme) are layered: the +/- background is a CSS property on
 * each line's wrapper div, highlighting only changes the token colors
 * inside it, so the two never fight each other. Highlighting degrades to
 * escaped plain text for an unrecognized extension or a load failure -- a
 * diff must always be readable even when highlighting isn't.
 */

interface FileSummaryRow {
  filePath: string;
  connectionId: string | null;
  activityKind: "read" | "changed" | "create" | "delete";
  status: "started" | "succeeded" | "failed";
  additions: number | null;
  deletions: number | null;
  updatedAt: string;
  /** A "started" row the reporting turn's own timeout has already passed
   * without ever resolving -- see workspace-file-activity-service.ts's
   * STARTED_STALE_AFTER_MS. Never trust "started" as still-live without
   * checking this first. */
  stale?: boolean;
  /** "fs_watch" rows come from the real per-machine filesystem watcher, not
   * any agent's own tool call -- connectionId is always null for these.
   * Used to keep the "who's active" presence block honestly agent-only. */
  source?: "agent_tool_call" | "fs_watch";
}

interface DiffHistoryRow {
  id: string;
  connectionId: string | null;
  filePath: string;
  activityKind: FileSummaryRow["activityKind"];
  status: FileSummaryRow["status"];
  oldText: string | null;
  newText: string | null;
  diffPatch: string | null;
  additions: number | null;
  deletions: number | null;
  createdAt: string;
  updatedAt: string;
}

function agentFor(agents: AgentView[], connectionId: string | null): AgentView | null {
  if (!connectionId) return null;
  return agents.find((agent) => agent.connectionId === connectionId) ?? null;
}

const MONACO_LANG: Record<string, string> = {
  typescript: "typescript", tsx: "typescript", javascript: "javascript", jsx: "javascript",
  json: "json", css: "css", markdown: "markdown", python: "python", sql: "sql",
  shellscript: "shell", yaml: "yaml", html: "html",
};
function monacoLangFor(filePath: string): string {
  const lang = langForPath(filePath);
  return lang ? (MONACO_LANG[lang] ?? "plaintext") : "plaintext";
}

/** Stable per-connection color so the same agent gets the same highlight
 * everywhere, without maintaining a hardcoded per-agent color list. */
function colorForConnection(connectionId: string): string {
  let hash = 0;
  for (let i = 0; i < connectionId.length; i += 1) hash = (hash * 31 + connectionId.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 70%, 55%)`;
}

/** The number of live steps seen for this exact path -- bumping it is what
 * makes LiveFileView re-fetch instead of going stale while an agent keeps
 * writing. */
function useRefreshKey(liveSteps: WorkspaceStep[], filePath: string | null): number {
  return useMemo(
    () => liveSteps.filter((step) => step.filePath === filePath).length,
    [liveSteps, filePath],
  );
}

/** The new-file line range each hunk touched, read straight from the real
 * unified diff's own `@@ -a,b +c,d @@` headers -- the agent's actual patch,
 * not a client-side re-diff of old vs new text. */
function changedLineRangesFromPatch(patch: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const length = match[2] ? Number(match[2]) : 1;
    if (length > 0) ranges.push([start, start + length - 1]);
  }
  return ranges;
}

/**
 * Live Code: a read-only Monaco view of a file's real current content,
 * fed by the same ACP diff events the message feed's step ticker already
 * receives -- not a second data source, not reconstructed or guessed.
 * ACP's diff content block carries the WHOLE file's before/after text (see
 * acp-stdio-adapter.ts's own doc comment), so the newest row's newText for
 * this path already IS the file's real current content. Rendered as a third
 * column beside chat (see .wf-chat-file-slot in globals.css) rather than a
 * takeover -- Chat + IDE means both stay usable at once, composer included.
 *
 * Co-editing (multiple humans typing into this same buffer) is explicitly
 * out of scope here -- this view is read-only. That's a real, separate CRDT
 * problem, not something to bolt on as a side effect of a viewer.
 */
export function LiveFileView({ agents, filePath, liveSteps, onBack }: {
  agents: AgentView[];
  filePath: string;
  liveSteps: WorkspaceStep[];
  onBack: () => void;
}) {
  const [rows, setRows] = useState<DiffHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditorNS.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoEditorNS | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const refreshKey = useRefreshKey(liveSteps, filePath);

  // Real filesystem-watcher events (source: "fs_watch") don't ride the
  // per-channel relay the way an agent's own tool-call steps do -- a fs_watch
  // row is workspace-wide, not tied to any one channel, and the relay's own
  // room model requires a real channelId to publish into (see
  // mission-relay-service.ts's "channelId is required" check). Rather than
  // invent a fake channel association just to force it through that path,
  // this view also polls on a short interval -- a few seconds of latency,
  // not instant push, but still genuinely automatic: no manual refresh or
  // re-navigation needed to see a disk-detected change land here.
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setPollTick((value) => value + 1), 4_000);
    return () => window.clearInterval(id);
  }, []);

  // Only the filePath/refreshKey-driven fetch clears rows to show a loading
  // state -- the background poll (pollTick) below refetches silently, so a
  // 4s tick with no real change never flashes "Loading..." over content
  // that's still perfectly valid.
  useEffect(() => {
    let cancelled = false;
    // The fetch effect deliberately resets the visible loading state before
    // requesting the new file snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(null);
    setError(null);
    fetch(`/api/dashboard/workspace-files/diff?filePath=${encodeURIComponent(filePath)}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setRows(data.history ?? []); })
      .catch(() => { if (!cancelled) setError("Could not load this file's live content."); });
    return () => { cancelled = true; };
  }, [filePath, refreshKey]);

  useEffect(() => {
    if (pollTick === 0) return;
    let cancelled = false;
    fetch(`/api/dashboard/workspace-files/diff?filePath=${encodeURIComponent(filePath)}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setRows(data.history ?? []); })
      .catch(() => { /* a dropped background poll just retries next tick */ });
    return () => { cancelled = true; };
  }, [pollTick, filePath]);

  // rows are most-recent-first (diffHistoryForPath's own ordering) -- if the
  // very latest row for this path is a confirmed delete, the file is gone,
  // full stop. Falling through to an older row's content here would show
  // stale text as if it were still current, exactly the honesty gap fixed
  // by the filesystem watcher elsewhere in this module.
  const deleted = (rows ?? [])[0]?.activityKind === "delete" && (rows ?? [])[0]?.status === "succeeded";
  const current = useMemo(() => (deleted ? null : (rows ?? []).find((row) => row.newText != null) ?? null), [rows, deleted]);
  const latestAgent = current ? agentFor(agents, current.connectionId) : null;
  const changedRanges = useMemo(() => (current?.diffPatch ? changedLineRangesFromPatch(current.diffPatch) : []), [current]);
  const [showDiff, setShowDiff] = useState(true);

  // Re-applied whenever a fresh real edit lands for this path -- the
  // decoration always reflects the most recent agent's actual patch ranges,
  // never a stale highlight left over from a previous file.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const cleared = editor.deltaDecorations(decorationIdsRef.current, []);
    if (!current || changedRanges.length === 0) { decorationIdsRef.current = cleared; return; }
    // A fs_watch row (current.connectionId null) means the change was
    // detected on disk with no agent attribution -- honestly labeled as
    // such rather than guessing which agent did it.
    const label = current.connectionId ? (latestAgent?.label ?? "An agent") : "Something on your machine";
    const color = current.connectionId ? colorForConnection(current.connectionId) : "hsl(0, 0%, 60%)";
    decorationIdsRef.current = editor.deltaDecorations(cleared, changedRanges.map(([start, end]) => ({
      range: new monaco.Range(start, 1, end, 1),
      options: {
        isWholeLine: true,
        className: "wf-livefile-changed-line",
        linesDecorationsClassName: "wf-livefile-changed-gutter",
        overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Full },
        hoverMessage: { value: `${label} just edited this line.` },
      },
    })));
  }, [current, changedRanges, latestAgent]);

  return (
    <section className="wf-livefile" aria-label={`Live view of ${filePath}`}>
      <header className="wf-livefile-header">
        <button type="button" className="wf-files-back" onClick={onBack} aria-label="Close live file view">×</button>
        <span className="ol-mono wf-files-focus-path truncate">{filePath}</span>
        {current?.oldText != null && current.newText != null && (
          <button type="button" className="wf-livefile-view-toggle" aria-pressed={showDiff} onClick={() => setShowDiff((value) => !value)}>
            {showDiff ? "Current file" : "Show diff"}
          </button>
        )}
        {latestAgent && (
          <span className="wf-livefile-active-agent">
            <AgentMark agentKey={latestAgent.key} size={16} status="active" />
            {latestAgent.label} touched this last
          </span>
        )}
      </header>
      <div className="wf-livefile-body">
        {error ? (
          <p className="p-3 text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">{error}</p>
        ) : !rows ? (
          <p className="p-3 text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Loading…</p>
        ) : deleted ? (
          <p className="p-3 text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">This file was deleted.</p>
        ) : !current ? (
          <p className="p-3 text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">No recorded content for this file yet. It may only have been read so far.</p>
        ) : (
          showDiff && current.oldText != null && current.newText != null ? (
            <MonacoDiffEditor height="100%" original={current.oldText} modified={current.newText} language={monacoLangFor(filePath)} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, renderSideBySide: true, wordWrap: "on", automaticLayout: true }} />
          ) : (
            <MonacoEditor height="100%" language={monacoLangFor(filePath)} value={current.newText ?? ""} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, renderLineHighlight: "none", wordWrap: "on" }} onMount={(editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; }} />
          )
        )}
      </div>
      <p className="ol-mono text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-faint)] wf-files-provenance">
        Live from real agent edits, read-only for now. Co-editing is a separate step, not yet built.
      </p>
    </section>
  );
}

interface WhisperMessage {
  id: string;
  senderConnectionId: string;
  recipientConnectionId: string;
  body: string;
  createdAt: string;
  channelName: string;
}

const WHISPERS_POLL_INTERVAL_MS = 5_000;

/**
 * Agent Whispers: a curated view of direct agent-to-agent messages (a real
 * recipientConnectionId, not a broadcast to the channel) -- the same
 * messages that already exist and already happen today (confirmed live:
 * Claude Code and OpenCode have held real back-and-forth exchanges in this
 * app). This is a SUPPLEMENTARY view for scanning just that traffic, not a
 * removal -- those same messages still also appear in the main feed exactly
 * as before. Actually pulling them out of the main feed would mean editing
 * ConversationPanel.tsx's own message-rendering logic, which is out of
 * scope for this pass; noted here so the two surfaces aren't assumed to be
 * mutually exclusive.
 *
 * Backed by GET /api/dashboard/whispers -- a direct, workspace-scoped query
 * on conversation_messages, not a client-side filter of the full
 * /api/dashboard/conversations firehose (that used to mean downloading every
 * channel's last 80 messages, including full bodies, to keep this usually-
 * empty panel updated every 5s). A short poll keeps it fresh instead.
 *
 * Workspace-wide (every channel), not scoped to whichever channel is
 * currently open -- AgentWorkspaceClient doesn't actually know which
 * channel is selected (that's owned entirely inside ConversationPanel's own
 * state), and coordination chatter worth scanning often isn't confined to
 * one channel anyway. Each row is tagged with its channel name.
 */
export function WhispersPanel({ agents, onClose }: { agents: AgentView[]; onClose: () => void }) {
  const [messages, setMessages] = useState<WhisperMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Real observability, not a claim: this is a live read of production
  // traffic (the same recipient_connection_id filter WhispersPanel's own
  // list already uses), not a synthetic check -- see
  // whisper-activity-service.ts for why that distinction matters.
  const [activity, setActivity] = useState<{ lastExchangeAt: string | null; distinctPairCount30d: number; totalCount30d: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetch("/api/dashboard/whispers", { cache: "no-store" })
        .then((res) => res.json())
        .then((data: { messages?: WhisperMessage[] }) => {
          if (cancelled) return;
          setMessages(data.messages ?? []);
        })
        .catch(() => { if (!cancelled) setError("Could not load agent whispers."); });
      fetch("/api/dashboard/whisper-activity", { cache: "no-store" })
        .then((res) => res.json())
        .then((data: { lastExchangeAt?: string | null; distinctPairCount30d?: number; totalCount30d?: number }) => {
          if (cancelled) return;
          setActivity({ lastExchangeAt: data.lastExchangeAt ?? null, distinctPairCount30d: data.distinctPairCount30d ?? 0, totalCount30d: data.totalCount30d ?? 0 });
        })
        .catch(() => { /* best-effort -- the message list above is the real content, this is a supplementary stat */ });
    }
    load();
    const pollId = window.setInterval(load, WHISPERS_POLL_INTERVAL_MS);
    const clockId = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { cancelled = true; window.clearInterval(pollId); window.clearInterval(clockId); };
  }, []);

  return (
    <>
      <div className="wf-files-rail-header">
        <span>Agent Whispers</span>
        <button type="button" className="wf-files-rail-collapse" onClick={onClose} aria-label="Collapse whispers panel">×</button>
      </div>
      {activity && (
        <p className="wf-whispers-activity-stat">
          {activity.lastExchangeAt
            ? `Last real exchange ${relativeStarted(Date.parse(activity.lastExchangeAt), now).replace("started ", "")} · ${activity.distinctPairCount30d} agent pair${activity.distinctPairCount30d === 1 ? "" : "s"}, ${activity.totalCount30d} message${activity.totalCount30d === 1 ? "" : "s"} in the last 30 days`
            : "No direct agent-to-agent exchange recorded yet"}
        </p>
      )}
      <div className="wf-activity-feed scrollbar-thin">
        {error ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">{error}</p>
        ) : !messages ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">No direct agent-to-agent messages yet. Broadcast replies stay in the main feed -- only direct DMs between agents show up here.</p>
        ) : (
          <ul className="wf-activity-feed-list">
            {messages.map((message) => {
              const sender = agentFor(agents, message.senderConnectionId);
              const recipient = agentFor(agents, message.recipientConnectionId);
              return (
                <li key={message.id} className="wf-activity-row">
                  {sender ? <AgentMark agentKey={sender.key} size={20} /> : <span className="wf-activity-row-icon" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <strong>{sender?.label ?? "An agent"}</strong> → <strong>{recipient?.label ?? "an agent"}</strong>
                    </div>
                    <div className="wf-activity-row-meta">
                      <span className="wf-activity-row-badge">#{message.channelName}</span>
                      {relAt(message.createdAt, now)}
                    </div>
                    <p className="wf-whisper-body">{message.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

interface DraftSectionView {
  id: string;
  heading: string;
  body: string;
  position: number;
  authorKind: "agent" | "human";
  authorConnectionId: string | null;
  authorUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface DraftView {
  id: string;
  title: string;
  status: "draft" | "ready";
  updatedAt: string;
  sections: DraftSectionView[];
}

const DRAFTS_POLL_INTERVAL_MS = 5_000;

/**
 * #13 shared co-drafting: one shared, structured document per conversation
 * that connected agents (via the draft_section MCP tool) and the human here
 * build together, one named section at a time. Deliberately not live
 * character-by-character typing -- agents submit finished sections, not
 * keystrokes -- and deliberately narrative content, not code or diffs
 * (those live in the Files panel against real git). Scoped so a finished
 * ("ready") draft is exactly the shape a future real-git build can hand off
 * as a PR description or spec: named, attributed sections, one document.
 *
 * Same poll-based freshness as WhispersPanel, same reasoning: a dedicated
 * relay frame type for this is more machinery than a 5s poll justifies
 * right now, and this panel already isn't meant to feel like live typing.
 */
export function DraftsPanel({ conversationId, agents, onClose }: { conversationId: string | null; agents: AgentView[]; onClose: () => void }) {
  const [drafts, setDrafts] = useState<DraftView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [composerOpenFor, setComposerOpenFor] = useState<string | null>(null);
  const [draftTitleInput, setDraftTitleInput] = useState("");
  const [headingInput, setHeadingInput] = useState("");
  const [bodyInput, setBodyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      // Clear conversation-scoped drafts when the panel loses its channel.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDrafts([]);
      return;
    }
    let cancelled = false;
    function load() {
      fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId!)}/drafts`, { cache: "no-store" })
        .then((res) => res.json())
        .then((data: { drafts?: DraftView[] }) => { if (!cancelled) setDrafts(data.drafts ?? []); })
        .catch(() => { if (!cancelled) setError("Could not load shared drafts."); });
    }
    load();
    const pollId = window.setInterval(load, DRAFTS_POLL_INTERVAL_MS);
    const clockId = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { cancelled = true; window.clearInterval(pollId); window.clearInterval(clockId); };
  }, [conversationId]);

  function startNewDraft() {
    setComposerOpenFor("__new__");
    setDraftTitleInput("");
    setHeadingInput("");
    setBodyInput("");
    setSaveError(null);
  }
  function startSectionFor(draft: DraftView) {
    setComposerOpenFor(draft.id);
    setDraftTitleInput(draft.title);
    setHeadingInput("");
    setBodyInput("");
    setSaveError(null);
  }

  async function submitSection() {
    if (!conversationId || !draftTitleInput.trim() || !headingInput.trim() || !bodyInput.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftTitle: draftTitleInput.trim(), heading: headingInput.trim(), body: bodyInput.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save the section.");
      setDrafts((current) => {
        const next = (current ?? []).filter((d) => d.id !== json.draft.id);
        return [json.draft as DraftView, ...next];
      });
      setComposerOpenFor(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the section.");
    } finally {
      setSaving(false);
    }
  }

  async function markReady(draft: DraftView) {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/drafts`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftId: draft.id, status: "ready" }),
      });
      if (!res.ok) throw new Error();
      setDrafts((current) => (current ?? []).map((d) => (d.id === draft.id ? { ...d, status: "ready" as const } : d)));
    } catch {
      setSaveError("Could not mark the draft ready.");
    }
  }

  function authorLabel(section: DraftSectionView): string {
    if (section.authorKind === "human") return "You";
    const agent = agentFor(agents, section.authorConnectionId);
    return agent?.label ?? "An agent";
  }

  return (
    <>
      <div className="wf-files-rail-header">
        <span>Shared Drafts</span>
        <button type="button" className="wf-files-rail-collapse" onClick={onClose} aria-label="Collapse drafts panel">×</button>
      </div>
      <div className="wf-activity-feed scrollbar-thin">
        {!conversationId ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Select a channel to see its shared drafts.</p>
        ) : error ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">{error}</p>
        ) : !drafts ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Loading…</p>
        ) : (
          <>
            <button type="button" className="wf-btn-ghost-sm" onClick={startNewDraft} style={{ margin: "0 0 10px" }}>+ New draft</button>
            {composerOpenFor === "__new__" && (
              <div className="wf-draft-composer">
                <input value={draftTitleInput} onChange={(e) => setDraftTitleInput(e.target.value)} placeholder="Draft title, e.g. PR description" maxLength={200} />
                <input value={headingInput} onChange={(e) => setHeadingInput(e.target.value)} placeholder="Section heading, e.g. Summary" maxLength={120} />
                <textarea value={bodyInput} onChange={(e) => setBodyInput(e.target.value)} placeholder="Section content…" rows={4} maxLength={8000} />
                {saveError && <p className="text-[length:var(--ol-text-xs)] text-[color:var(--ol-danger)]">{saveError}</p>}
                <div className="wf-draft-composer-actions">
                  <button type="button" onClick={() => setComposerOpenFor(null)} disabled={saving}>Cancel</button>
                  <button type="button" onClick={submitSection} disabled={saving || !draftTitleInput.trim() || !headingInput.trim() || !bodyInput.trim()}>{saving ? "Saving…" : "Save section"}</button>
                </div>
              </div>
            )}
            {drafts.length === 0 && composerOpenFor !== "__new__" ? (
              <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">No shared drafts yet in this channel. Agents can start one with the draft_section tool, or start one here.</p>
            ) : (
              <ul className="wf-activity-feed-list">
                {drafts.map((draft) => (
                  <li key={draft.id} className="wf-activity-row wf-draft-card" data-status={draft.status}>
                    <div className="min-w-0 flex-1">
                      <div className="wf-draft-card-header">
                        <strong>{draft.title}</strong>
                        <span className="wf-activity-row-badge" data-status={draft.status}>{draft.status === "ready" ? "Ready" : "Draft"}</span>
                      </div>
                      <div className="wf-activity-row-meta">{relAt(draft.updatedAt, now)} · {draft.sections.length} section{draft.sections.length === 1 ? "" : "s"}</div>
                      {draft.sections.map((section) => (
                        <div key={section.id} className="wf-draft-section">
                          <div className="wf-draft-section-header">
                            <span className="wf-draft-section-heading">{section.heading}</span>
                            <span className="wf-draft-section-author">{authorLabel(section)}</span>
                          </div>
                          <p className="wf-whisper-body">{section.body}</p>
                        </div>
                      ))}
                      {draft.status === "draft" && (
                        <div className="wf-draft-card-actions">
                          <button type="button" className="wf-btn-ghost-sm" onClick={() => startSectionFor(draft)}>+ Add section</button>
                          <button type="button" className="wf-btn-ghost-sm" onClick={() => markReady(draft)}>Mark ready</button>
                        </div>
                      )}
                      {composerOpenFor === draft.id && (
                        <div className="wf-draft-composer">
                          <input value={headingInput} onChange={(e) => setHeadingInput(e.target.value)} placeholder="Section heading" maxLength={120} />
                          <textarea value={bodyInput} onChange={(e) => setBodyInput(e.target.value)} placeholder="Section content…" rows={4} maxLength={8000} />
                          {saveError && <p className="text-[length:var(--ol-text-xs)] text-[color:var(--ol-danger)]">{saveError}</p>}
                          <div className="wf-draft-composer-actions">
                            <button type="button" onClick={() => setComposerOpenFor(null)} disabled={saving}>Cancel</button>
                            <button type="button" onClick={submitSection} disabled={saving || !headingInput.trim() || !bodyInput.trim()}>{saving ? "Saving…" : "Save section"}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

interface ChannelRosterRow {
  userId: string;
  email: string | null;
  name: string | null;
  role: "owner" | "admin" | "member";
  inChannel: boolean;
}

/**
 * #19 session-sharing: "who can see this channel," editable after the fact
 * -- the creation flow's own human picker only ever covered day one. Every
 * workspace member is listed (not just current channel members) so adding
 * someone already in the workspace is a single click, not a separate
 * "invite" step.
 *
 * Bringing in someone who isn't a workspace member yet used to require
 * leaving this panel for Settings > Team -- real, reported friction, fixed
 * here directly: the same inviteToWorkspace call Settings uses, just
 * reachable from where people actually look for it.
 */
export function ChannelPeoplePanel({ conversationId, onClose }: { conversationId: string | null; onClose: () => void }) {
  const [roster, setRoster] = useState<ChannelRosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);

  const load = useCallback(() => {
    if (!conversationId) { setRoster([]); return; }
    fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/members`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { roster?: ChannelRosterRow[] }) => setRoster(data.roster ?? []))
      .catch(() => setError("Could not load this channel's members."));
  }, [conversationId]);
  useEffect(() => {
    // Reset channel-scoped state before loading the new roster.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoster(null);
    setError(null);
    load();
  }, [load]);

  async function toggle(row: ChannelRosterRow) {
    if (!conversationId) return;
    setBusyUserId(row.userId);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/conversations/${encodeURIComponent(conversationId)}/members${row.inChannel ? `?userId=${encodeURIComponent(row.userId)}` : ""}`, {
        method: row.inChannel ? "DELETE" : "POST",
        headers: row.inChannel ? undefined : { "content-type": "application/json" },
        body: row.inChannel ? undefined : JSON.stringify({ userId: row.userId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not update that person's access.");
      setRoster((current) => (current ?? []).map((r) => (r.userId === row.userId ? { ...r, inChannel: !r.inChannel } : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that person's access.");
    } finally {
      setBusyUserId(null);
    }
  }

  async function sendInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = inviteEmail.trim();
    if (!trimmed) return;
    setInviteBusy(true);
    setInviteNotice(null);
    setInviteLink(null);
    setInviteLinkCopied(false);
    try {
      const res = await fetch("/api/workspace/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, role: inviteRole }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not create that invite.");
      // No email is sent -- the link below is the entire delivery mechanism.
      // Whoever holds it can accept regardless of which account/email they
      // sign in with; the field above is just a note for your own roster.
      const token = (json.invite as { token?: string } | undefined)?.token;
      setInviteLink(token ? `${window.location.origin}/invite/${token}` : null);
      setInviteNotice(token ? null : `Invite created for ${trimmed}, but no link came back -- copy it from Settings > Team.`);
      setInviteEmail("");
    } catch (err) {
      setInviteNotice(err instanceof Error ? err.message : "Could not create that invite.");
    } finally {
      setInviteBusy(false);
    }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteLinkCopied(true);
      setTimeout(() => setInviteLinkCopied(false), 1500);
    } catch {
      /* clipboard can be unavailable; the link stays selectable text either way */
    }
  }

  return (
    <>
      <div className="wf-files-rail-header">
        <span>People</span>
        <button type="button" className="wf-files-rail-collapse" onClick={onClose} aria-label="Collapse people panel">×</button>
      </div>
      <form className="wf-people-invite" onSubmit={sendInvite}>
        <input
          type="email"
          placeholder="Invite by email…"
          value={inviteEmail}
          onChange={(event) => setInviteEmail(event.target.value)}
          disabled={inviteBusy}
        />
        <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "member" | "admin")} disabled={inviteBusy}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" disabled={inviteBusy || !inviteEmail.trim()}>Invite</button>
      </form>
      {inviteLink && (
        <div className="wf-people-invite-link">
          <input type="text" readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" onClick={() => void copyInviteLink()}>{inviteLinkCopied ? "Copied" : "Copy link"}</button>
          <p>Send this to them any way you want -- text, Slack, DM. Whoever opens it and signs in joins this workspace.</p>
        </div>
      )}
      {inviteNotice && <p className="wf-people-invite-notice">{inviteNotice}</p>}
      <div className="wf-activity-feed scrollbar-thin">
        {!conversationId ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Select a channel to manage who can see it.</p>
        ) : error ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">{error}</p>
        ) : !roster ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Loading…</p>
        ) : roster.length === 0 ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">No other workspace members yet -- invite someone above.</p>
        ) : (
          <ul className="wf-activity-feed-list">
            {roster.map((row) => (
              <li key={row.userId} className="wf-activity-row">
                <div className="min-w-0 flex-1">
                  {/* Profile pages/popovers are item #26b -- a separate,
                      not-yet-designed feature. This is only the display-name
                      fix: a real name (or email-prefix fallback), never the
                      raw email or a bare user id as the primary label. */}
                  <div className="truncate">{row.name ?? row.email ?? row.userId}</div>
                  <div className="wf-activity-row-meta"><span className="wf-activity-row-badge">{row.role}</span></div>
                </div>
                <button type="button" className="wf-btn-ghost-sm" disabled={busyUserId === row.userId} onClick={() => toggle(row)}>
                  {busyUserId === row.userId ? "…" : row.inChannel ? "Remove" : "Add"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

interface SessionRow {
  id: string;
  conversationId: string;
  conversationTopic: string;
  connectionId: string | null;
  ownerLabel: string;
  title: string;
  status: "active" | "waiting" | "archived";
  anchorMessageId: string | null;
  latestMessageId: string | null;
  startedAtMs: number;
  lastActivityAtMs: number;
  archiveProposed: boolean;
  archivedAtMs: number | null;
}

const LIVE_SESSIONS_POLL_INTERVAL_MS = 4_000;

/** "started 16m ago" / "started 2h ago" -- never a bare mm:ss, which reads like a running clock even for something that finished a while back. */
function relativeStarted(atMs: number, nowMs: number): string {
  const deltaSeconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (deltaSeconds < 60) return "started just now";
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `started ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `started ${hours}h ago`;
  return `started ${Math.floor(hours / 24)}d ago`;
}

/**
 * YC "Multiplayer AI" RFS, taken literally: "anyone on a team should be
 * able to drop into the same live agent session ... and hand it off."
 * This is the discovery half -- every turn in progress anywhere in the
 * workspace, not just whichever channel a human already has open. The
 * "drop in and watch" half needs no new UI: following one of these links
 * lands on ConversationPanel's existing ?conversation=&message= deep link,
 * which scrolls straight to that turn's message, and StepGroupCard already
 * defaults an in-progress turn's step log open on its own -- so this list
 * is the one genuinely missing piece, not a reimplementation of live
 * viewing itself.
 */
export function LiveSessionsPanel({ onClose }: { agents: AgentView[]; onClose: () => void }) {
  const [tab, setTab] = useState<"open" | "archived">("open");
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [archived, setArchived] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadOpen = useCallback(() => {
    return fetch("/api/dashboard/live-sessions", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { sessions?: SessionRow[] }) => setSessions(data.sessions ?? []))
      .catch(() => setError("Could not load live sessions."));
  }, []);
  const loadArchived = useCallback(() => {
    return fetch("/api/dashboard/live-sessions/archived", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { sessions?: SessionRow[] }) => setArchived(data.sessions ?? []))
      .catch(() => setError("Could not load archived sessions."));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadOpen();
    const pollId = window.setInterval(() => { if (!cancelled) void loadOpen(); }, LIVE_SESSIONS_POLL_INTERVAL_MS);
    const clockId = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { cancelled = true; window.clearInterval(pollId); window.clearInterval(clockId); };
  }, [loadOpen]);

  useEffect(() => {
    if (tab === "archived" && archived === null) void loadArchived();
  }, [tab, archived, loadArchived]);

  async function archiveSession(id: string) {
    setBusyId(id);
    try {
      await fetch(`/api/dashboard/live-sessions/${encodeURIComponent(id)}/archive`, { method: "POST" });
      await loadOpen();
      if (archived !== null) await loadArchived();
    } finally {
      setBusyId(null);
    }
  }
  async function dismissProposal(id: string) {
    setBusyId(id);
    try {
      await fetch(`/api/dashboard/live-sessions/${encodeURIComponent(id)}/dismiss-archive`, { method: "POST" });
      await loadOpen();
    } finally {
      setBusyId(null);
    }
  }

  const active = (sessions ?? []).filter((s) => s.status === "active");
  const waiting = (sessions ?? []).filter((s) => s.status === "waiting");

  function SessionCard({ session, showArchiveAction }: { session: SessionRow; showArchiveAction: boolean }) {
    return (
      <li className="wf-activity-row" key={session.id}>
        <span className="wf-activity-row-icon" data-status={session.status} />
        <div className="min-w-0 flex-1">
          {/* BUG FOUND AND FIXED: this row had it backwards -- the owner/
              channel metadata rendered bold and bright while the actual task
              content (the one thing a human needs to read to know what's
              happening) rendered in the faintest gray available. Content
              first, metadata second -- the same rule chat messages already
              follow (sender name is a quiet label, the message body is what
              you came to read). */}
          <div className="wf-activity-row-title truncate">{session.title}</div>
          <div className="wf-activity-row-owner truncate">{session.ownerLabel} · #{session.conversationTopic}</div>
          <div className="wf-activity-row-meta">
            <span className="wf-activity-row-badge" data-status={session.status === "active" ? "pending" : "idle"}>
              {session.status === "active" ? "Active" : "Waiting"}
            </span>
            <span className="ol-mono">{relativeStarted(session.startedAtMs, now)}</span>
          </div>
          {session.archiveProposed && (
            <div className="wf-activity-row-meta">
              <span className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Proposed for archive</span>
              <button type="button" className="wf-btn-ghost-sm" disabled={busyId === session.id} onClick={() => archiveSession(session.id)}>Archive</button>
              <button type="button" className="wf-btn-ghost-sm" disabled={busyId === session.id} onClick={() => dismissProposal(session.id)}>Keep open</button>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          {session.latestMessageId && (
            <Link href={channelHref(session.conversationId, session.latestMessageId)} className="wf-btn-ghost-sm">Join</Link>
          )}
          {showArchiveAction && !session.archiveProposed && (
            <button type="button" className="wf-btn-ghost-sm" disabled={busyId === session.id} onClick={() => archiveSession(session.id)}>Archive</button>
          )}
        </div>
      </li>
    );
  }

  return (
    <>
      <div className="wf-files-rail-header">
        <span>Live Sessions</span>
        <div className="flex items-center gap-1">
          <button type="button" className="wf-btn-ghost-sm" aria-pressed={tab === "open"} onClick={() => setTab("open")}>Live</button>
          <button type="button" className="wf-btn-ghost-sm" aria-pressed={tab === "archived"} onClick={() => setTab("archived")} title="Archived sessions">Archived</button>
          <button type="button" className="wf-files-rail-collapse" onClick={onClose} aria-label="Collapse live sessions panel">×</button>
        </div>
      </div>
      <div className="wf-activity-feed scrollbar-thin">
        {error ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">{error}</p>
        ) : tab === "open" ? (
          !sessions ? (
            <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Loading…</p>
          ) : active.length === 0 && waiting.length === 0 ? (
            <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Nothing open right now. A session appears here the moment a task starts, and moves to Archived once it is confirmed done.</p>
          ) : (
            <>
              {active.length > 0 && (
                <>
                  <p className="wf-files-rail-section-label">Active</p>
                  <ul className="wf-activity-feed-list">{active.map((s) => <SessionCard key={s.id} session={s} showArchiveAction={false} />)}</ul>
                </>
              )}
              {waiting.length > 0 && (
                <>
                  <p className="wf-files-rail-section-label">Waiting</p>
                  <ul className="wf-activity-feed-list">{waiting.map((s) => <SessionCard key={s.id} session={s} showArchiveAction />)}</ul>
                </>
              )}
            </>
          )
        ) : !archived ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">Loading…</p>
        ) : archived.length === 0 ? (
          <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">No archived sessions yet.</p>
        ) : (
          <ul className="wf-activity-feed-list">
            {archived.map((session) => (
              <li className="wf-activity-row" key={session.id}>
                <span className="wf-activity-row-icon" data-status="archived" />
                <div className="min-w-0 flex-1">
                  <div className="truncate"><strong>{session.ownerLabel}</strong> · #{session.conversationTopic}</div>
                  <div className="truncate text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">{session.title}</div>
                  {session.archivedAtMs && (
                    <div className="wf-activity-row-meta">
                      <span className="ol-mono">archived {relativeStarted(session.archivedAtMs, now).replace("started ", "")}</span>
                    </div>
                  )}
                </div>
                {/* BUG FOUND AND FIXED: this linked into the channel with
                    ?message=<latestMessageId>, but archiving a session is
                    exactly what removes its messages from channel scroll-back
                    (conversation-service.ts filters every feed against
                    archivedMessageIdsFor). The target message was therefore
                    guaranteed absent, the deep-link scroll silently no-opped,
                    and "View" dropped you on #general at the newest message --
                    a random page. The transcript's real home is the Session
                    Catalog, which reads the archived rows directly. */}
                <Link href={archivedSessionHref(session.id)} className="wf-btn-ghost-sm">View</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
