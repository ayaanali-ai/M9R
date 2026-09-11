"use client";

/**
 * MemoryView — what this workspace remembers.
 * ----------------------------------------------------------------------------
 * The merged home for what used to be two separate screens: Findings (things an
 * agent flagged from a run) and Workspace Rules (instructions every agent loads
 * before working). They were always one loop -- an agent flags something, a
 * human confirms it, and from then on the whole team carries it -- so they are
 * one concept here: Memory.
 *
 * The plumbing underneath is unchanged: flags still POST to the findings review
 * endpoints, remembered items are still workspace rules, and promotion is still
 * an explicit human action. Only the grouping and the vocabulary moved.
 *
 * Rendered both at /dashboard/memory and inside the Agent Workspace drawer, so
 * it fetches its own data (both sources are cookie/RLS-scoped GETs) rather than
 * requiring each host to plumb it in.
 */

import { useCallback, useEffect, useState } from "react";
import ProductConfirmDialog from "@/components/product/ProductConfirmDialog";
import RuleDraftTools from "@/components/product/RuleDraftTools";
import { SessionCatalog } from "@/components/product/memory/SessionCatalog";
import { Meta, Surface } from "@/components/product/WorkspaceUI";
import type { WorkspaceRule } from "@/lib/workspace-rule-matching";
import {
  RULE_TYPE_LABELS,
  CONFIDENCE_LABELS,
  type RuleStatus,
  type RuleConfidence,
} from "@/lib/generated-rules";
import type { FindingEvidenceLevel } from "@/lib/finding";
import type { RulesFileFormat } from "@/lib/rules-file-generator";

// Badge tones come from the shared lozenge system so a status reads the same
// tone here, in the Agent Workspace, and on the Evidence page.
const statusChip: Record<RuleStatus, string> = {
  active: "ol-lozenge--ok",
  needs_review: "ol-lozenge--warn",
  low_confidence: "ol-lozenge--muted",
  retired: "ol-lozenge--muted",
};
const confidenceChip: Record<RuleConfidence, string> = {
  high: "ol-lozenge--ok",
  medium: "ol-lozenge--info",
  low: "ol-lozenge--muted",
};
// Evidence level is a classification, not a state — quiet mono tag, never a lozenge.
const EVIDENCE_LABEL: Record<FindingEvidenceLevel, string> = {
  inferred: "inferred",
  correlated: "correlated",
  command_tied: "command-tied",
};

const DELETE_DRAFT_CONFIRM = "Discard this item? It will not become part of what the team remembers.";
const DELETE_ARCHIVED_CONFIRM = "Delete this archived memory? It will be removed from product views. Its audit history remains stored.";
const ARCHIVE_RULE_CONFIRM = "Stop remembering this? Agents will no longer load it before a run.";
const RESTORE_RULE_CONFIRM = "Restore this archived memory? It returns to review and must be confirmed again before agents load it.";

/** A finding, as the dashboard read (GET /api/agent/findings) returns it. */
interface MemoryFlag {
  id: string;
  workspaceId?: string;
  originatingRunId: string;
  originatingSender: string;
  title: string;
  applicableEnvironment: string;
  evidenceLevel: FindingEvidenceLevel;
  suggestedResponse: string;
  knownLimitations: string[];
  reviewState: "observed" | "available" | "retired";
  createdAt: string;
}

type State =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; rules: WorkspaceRule[]; flags: MemoryFlag[] };

type PendingLifecycleAction = {
  kind: "delete" | "delete_archived" | "archive" | "restore";
  id: string;
  title: string;
} | null;

const short = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);
const truncate = (s: string, max = 140) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}
function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.split("/").pop() || filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function MemoryView() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [includeReview, setIncludeReview] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingLifecycleAction>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [showDraftTools, setShowDraftTools] = useState(false);
  const [viewTab, setViewTab] = useState<"rules" | "sessions">("rules");

  const load = useCallback(async () => {
    try {
      const [rulesRes, flagsRes] = await Promise.all([
        fetch("/api/workspace-rules"),
        fetch("/api/agent/findings"),
      ]);
      if (rulesRes.status === 401) {
        setState({ kind: "unavailable", message: "Sign in to view what this workspace remembers." });
        return;
      }
      if (!rulesRes.ok) {
        setState({ kind: "unavailable", message: "Memory is unavailable. Run the v5.1 migration to enable it." });
        return;
      }
      const rulesJson = (await rulesRes.json()) as { rules?: WorkspaceRule[] };
      // Flags are additive: a workspace whose findings table isn't reachable
      // still gets its remembered items rather than an error screen.
      const flagsJson = flagsRes.ok
        ? ((await flagsRes.json()) as { findings?: MemoryFlag[] })
        : { findings: [] };
      setState({ kind: "ready", rules: rulesJson.rules ?? [], flags: flagsJson.findings ?? [] });
    } catch {
      setState({ kind: "unavailable", message: "Couldn't load workspace memory." });
    }
  }, []);

  useEffect(() => {
    // Defer off the synchronous effect body; load() resolves its own state after
    // the initial fetch, so this avoids the cascading-render lint without any
    // behavior change (still a single load on mount).
    queueMicrotask(() => void load());
  }, [load]);

  async function mutate(path: string, init: RequestInit): Promise<boolean> {
    const res = await fetch(path, init);
    if (res.ok) {
      await load();
      return true;
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setNote(json.error || "That action didn't go through.");
    return false;
  }

  async function patch(id: string, body: Record<string, unknown>) {
    return mutate(`/api/workspace-rules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function promote(id: string) {
    return mutate("/api/agent/rules/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule_id: id }),
    });
  }

  async function deleteDraft(id: string) {
    return mutate(`/api/workspace-rules/${id}`, { method: "DELETE" });
  }

  async function archive(id: string) {
    return mutate(`/api/workspace-rules/${id}/archive`, { method: "POST" });
  }

  async function restore(id: string) {
    return mutate(`/api/workspace-rules/${id}/restore`, { method: "POST" });
  }

  /**
   * Confirming a flag is one human action with two effects, exactly as the
   * promote-to-rule endpoint already implements it: the flag itself is marked
   * reviewed, and a draft memory is written from its suggested response — which
   * still needs its own confirmation before agents load it.
   */
  async function confirmFlag(flag: MemoryFlag) {
    if (!flag.workspaceId) {
      setNote("Couldn't confirm this flag: its workspace could not be verified.");
      return false;
    }
    return mutate(`/api/agent/findings/${flag.id}/promote-to-rule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: flag.workspaceId }),
    });
  }

  async function reviewFlag(flag: MemoryFlag, decision: "available" | "retired") {
    if (!flag.workspaceId) {
      setNote("Couldn't record this decision: the flag's workspace could not be verified.");
      return false;
    }
    return mutate(`/api/agent/findings/${flag.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, workspace_id: flag.workspaceId }),
    });
  }

  async function confirmLifecycleAction() {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    const completed = pendingAction.kind === "delete" || pendingAction.kind === "delete_archived"
      ? await deleteDraft(pendingAction.id)
      : pendingAction.kind === "archive"
        ? await archive(pendingAction.id)
        : await restore(pendingAction.id);
    setActionBusy(false);
    if (completed) setPendingAction(null);
  }

  async function exportMemory(format: RulesFileFormat, copy = false) {
    setExporting(true);
    setNote(null);
    try {
      const res = await fetch("/api/workspace-rules/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, includeNeedsReview: includeReview }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; filename?: string; content?: string; error?: string };
      if (!res.ok || !json.ok || !json.content) {
        setNote(json.error || "Export failed.");
        return;
      }
      if (copy) {
        await copyText(json.content);
        setNote("Copied what the team remembers to the clipboard.");
      } else {
        downloadText(json.filename || "oathlock-memory.txt", json.content);
        setNote(`Exported ${json.filename}.`);
      }
    } finally {
      setExporting(false);
    }
  }

  const tabBar = (
    <div className="wf-memory-tabs">
      <button type="button" className="wf-memory-tab" data-active={viewTab === "rules" || undefined} onClick={() => setViewTab("rules")}>
        Rules
      </button>
      <button type="button" className="wf-memory-tab" data-active={viewTab === "sessions" || undefined} onClick={() => setViewTab("sessions")}>
        Sessions
      </button>
    </div>
  );

  if (viewTab === "sessions") {
    return (
      <div className="space-y-4">
        {tabBar}
        <SessionCatalog />
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="space-y-4">
        {tabBar}
        <div className="ol-panel h-40 animate-pulse" />
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <div className="space-y-4">
        {tabBar}
        <div className="ol-panel p-6">
          <h2 className="text-base font-semibold text-[color:var(--ol-text-primary)]">Memory</h2>
          <p className="mt-1.5 text-[13px] text-[color:var(--ol-text-muted)]">{state.message}</p>
        </div>
      </div>
    );
  }

  const { rules, flags } = state;
  const remembered = rules.filter((r) => r.status === "active");
  const draftRules = rules.filter((r) => r.status === "needs_review");
  const lowConfidence = rules.filter((r) => r.status === "low_confidence");
  const archivedRules = rules.filter((r) => r.status === "retired");
  const openFlags = flags.filter((f) => f.reviewState === "observed");
  const reviewedFlags = flags.filter((f) => f.reviewState !== "observed");
  const reviewCount = openFlags.length + draftRules.length;
  const nothingYet = rules.length === 0 && flags.length === 0;

  return (
    <div className="space-y-4">
      {tabBar}
      {/* Header + export bar: only confirmed memory travels into a run by
          default, the same rule the ruleset export always applied. */}
      <section className="ol-panel wf-glass-panel p-5">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-[color:var(--ol-text-primary)]">Memory</h2>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
          An agent flags something, you confirm it, and every agent carries it into the next run.
          Archived memory is kept for history but never loaded or exported.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] text-[color:var(--ol-text-muted)]">
            Export {remembered.length} remembered item{remembered.length === 1 ? "" : "s"}:
          </span>
          <ExportBtn label="AGENTS.md" onClick={() => exportMemory("agents")} disabled={exporting} />
          <ExportBtn label="CLAUDE.md" onClick={() => exportMemory("claude")} disabled={exporting} />
          <ExportBtn label="Cursor rule" onClick={() => exportMemory("cursor")} disabled={exporting} />
          <ExportBtn label="Copy block" onClick={() => exportMemory("plain", true)} disabled={exporting} />
          <label className="ml-1 inline-flex items-center gap-1.5 text-[11px] text-[color:var(--ol-text-secondary)]">
            <input
              type="checkbox"
              checked={includeReview}
              onChange={(e) => setIncludeReview(e.target.checked)}
              className="h-3.5 w-3.5 accent-[color:var(--accent)]"
            />
            Include items still awaiting review
          </label>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-[color:var(--ol-text-faint)]">
          AGENTS.md: agent-compatible project instructions. CLAUDE.md: Claude project memory.
          Cursor rule: Cursor project rules. Copy block: paste directly into the next session.
        </p>
        {note && <p className="mt-2 text-[11px] text-[color:var(--ol-text-secondary)]">{note}</p>}

        <div className="mt-4 border-t border-[color:var(--ol-border-subtle)] pt-3">
          <button
            type="button"
            onClick={() => setShowDraftTools((v) => !v)}
            aria-expanded={showDraftTools}
            className="text-[12px] font-medium text-[color:var(--ol-accent-text)] hover:underline"
          >
            {showDraftTools ? "Close authoring" : "Write / import memory"}
          </button>
          {showDraftTools && (
            <div className="mt-3">
              <RuleDraftTools onChanged={() => void load()} />
            </div>
          )}
        </div>
      </section>

      {nothingYet && (
        <div className="ol-empty">
          <p className="text-[13px] text-[color:var(--ol-text-secondary)]">Nothing remembered yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
            Memory is earned from evidence. Connect an agent and its sealed runs will surface things
            worth remembering, which you confirm here.
          </p>
          <code className="ol-mono mx-auto mt-3 block w-fit rounded border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] px-3 py-1.5 text-[12px] text-[color:var(--ol-text-secondary)]">
            npx m9r-cli init
          </code>
        </div>
      )}

      {reviewCount > 0 && (
        <MemorySection
          id="memory-review"
          title="Needs your review"
          count={reviewCount}
          blurb="Flagged by an agent. Nothing here is loaded into a run until you confirm it."
          tone="warn"
        >
          <div className="space-y-2.5">
            {openFlags.map((flag) => (
              <FlagCard
                key={flag.id}
                flag={flag}
                onConfirm={() => confirmFlag(flag)}
                onKeepAsReference={() => reviewFlag(flag, "available")}
                onSetAside={() => reviewFlag(flag, "retired")}
              />
            ))}
            {draftRules.map((rule) => (
              <MemoryCard
                key={rule.id}
                rule={rule}
                onPatch={patch}
                onPromote={promote}
                onDeleteDraft={(id, title) => setPendingAction({ kind: "delete", id, title })}
                onDeleteArchived={(id, title) => setPendingAction({ kind: "delete_archived", id, title })}
                onArchive={(id, title) => setPendingAction({ kind: "archive", id, title })}
                onRestore={(id, title) => setPendingAction({ kind: "restore", id, title })}
              />
            ))}
          </div>
        </MemorySection>
      )}

      {remembered.length > 0 && (
        <MemorySection
          id="memory-remembered"
          title="What the team remembers"
          count={remembered.length}
          blurb="Loaded by every agent before it works, and included in exports."
        >
          <div className="space-y-2.5">
            {remembered.map((rule) => (
              <MemoryCard
                key={rule.id}
                rule={rule}
                onPatch={patch}
                onPromote={promote}
                onDeleteDraft={(id, title) => setPendingAction({ kind: "delete", id, title })}
                onDeleteArchived={(id, title) => setPendingAction({ kind: "delete_archived", id, title })}
                onArchive={(id, title) => setPendingAction({ kind: "archive", id, title })}
                onRestore={(id, title) => setPendingAction({ kind: "restore", id, title })}
              />
            ))}
          </div>
        </MemorySection>
      )}

      {lowConfidence.length > 0 && (
        <MemorySection
          id="memory-lower-confidence"
          title="Lower confidence"
          count={lowConfidence.length}
          blurb="Drawn from weaker evidence. Real, but not exported until you move it into review."
        >
          <div className="space-y-2.5">
            {lowConfidence.map((rule) => (
              <MemoryCard
                key={rule.id}
                rule={rule}
                onPatch={patch}
                onPromote={promote}
                onDeleteDraft={(id, title) => setPendingAction({ kind: "delete", id, title })}
                onDeleteArchived={(id, title) => setPendingAction({ kind: "delete_archived", id, title })}
                onArchive={(id, title) => setPendingAction({ kind: "archive", id, title })}
                onRestore={(id, title) => setPendingAction({ kind: "restore", id, title })}
              />
            ))}
          </div>
        </MemorySection>
      )}

      {/* History stays collapsed and de-emphasized: reviewed and set aside,
          preserved for audit, never loaded into a run. */}
      {(archivedRules.length > 0 || reviewedFlags.length > 0) && (
        <details className="group" id="memory-history">
          <summary className="flex cursor-pointer select-none items-center gap-2 text-sm text-[color:var(--ol-text-muted)] hover:text-[color:var(--ol-text-secondary)]">
            <span className="ol-mono" style={{ fontSize: "var(--ol-text-2xs)" }}>
              HISTORY · {archivedRules.length + reviewedFlags.length}
            </span>
            <span className="text-[11px]">already decided, preserved for audit</span>
          </summary>
          <div className="mt-3 space-y-3">
            {archivedRules.length > 0 && (
              <div className="space-y-2.5">
                {archivedRules.map((rule) => (
                  <MemoryCard
                    key={rule.id}
                    rule={rule}
                    onPatch={patch}
                    onPromote={promote}
                    onDeleteDraft={(id, title) => setPendingAction({ kind: "delete", id, title })}
                    onDeleteArchived={(id, title) => setPendingAction({ kind: "delete_archived", id, title })}
                    onArchive={(id, title) => setPendingAction({ kind: "archive", id, title })}
                    onRestore={(id, title) => setPendingAction({ kind: "restore", id, title })}
                  />
                ))}
              </div>
            )}
            {reviewedFlags.length > 0 && (
              <Surface className="divide-y divide-[color:var(--ol-border-subtle)] overflow-hidden p-0">
                {reviewedFlags.map((flag) => (
                  <FlagLedgerRow key={flag.id} flag={flag} />
                ))}
              </Surface>
            )}
          </div>
        </details>
      )}

      <ProductConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.title ?? "Confirm"}
        description={
          pendingAction?.kind === "delete"
            ? DELETE_DRAFT_CONFIRM
            : pendingAction?.kind === "delete_archived"
              ? DELETE_ARCHIVED_CONFIRM
            : pendingAction?.kind === "archive"
              ? ARCHIVE_RULE_CONFIRM
              : RESTORE_RULE_CONFIRM
        }
        confirmLabel={
          pendingAction?.kind === "delete"
            ? "Discard"
            : pendingAction?.kind === "delete_archived"
              ? "Delete archived memory"
            : pendingAction?.kind === "archive"
              ? "Stop remembering"
              : "Restore to review"
        }
        tone={pendingAction?.kind === "delete" || pendingAction?.kind === "delete_archived" ? "danger" : "secondary"}
        busy={actionBusy}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => void confirmLifecycleAction()}
      />
    </div>
  );
}

function MemorySection({
  id,
  title,
  count,
  blurb,
  tone,
  children,
}: {
  id: string;
  title: string;
  count: number;
  blurb: string;
  tone?: "warn";
  children: React.ReactNode;
}) {
  return (
    // The id is the sidebar's link target — Memory's sidebar region deep-links
    // to a section rather than duplicating its contents.
    <section id={id} className="ol-panel wf-glass-panel p-5">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-[color:var(--ol-text-primary)]">{title}</h3>
        {tone === "warn" ? (
          <span className="ol-lozenge ol-lozenge--warn">{count} awaiting you</span>
        ) : (
          <span className="ol-mono rounded bg-[color:var(--ol-surface-2)] px-1.5 py-0.5 text-[10px] text-[color:var(--ol-text-muted)]">{count}</span>
        )}
        <span className="text-[11px] text-[color:var(--ol-text-muted)]">{blurb}</span>
      </header>
      {children}
    </section>
  );
}

function ExportBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="wf-glass-btn">
      {label}
    </button>
  );
}

/**
 * A thing an agent flagged, still awaiting a human. Inline decisions, no
 * native browser confirmation dialog (DESIGN.md forbids it): busy state on the pressed control, and the
 * list re-loads itself once the decision lands.
 */
function FlagCard({
  flag,
  onConfirm,
  onKeepAsReference,
  onSetAside,
}: {
  flag: MemoryFlag;
  onConfirm: () => Promise<boolean>;
  onKeepAsReference: () => Promise<boolean>;
  onSetAside: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<"confirm" | "reference" | "aside" | null>(null);

  async function run(kind: "confirm" | "reference" | "aside", action: () => Promise<boolean>) {
    if (busy) return;
    setBusy(kind);
    await action();
    setBusy(null);
  }

  return (
    <article className="rounded-lg border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-1)] p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ol-lozenge ol-lozenge--warn">flagged by an agent</span>
        <span className="ol-mono text-[color:var(--ol-text-muted)]" style={{ fontSize: "var(--ol-text-2xs)" }}>
          {EVIDENCE_LABEL[flag.evidenceLevel]}
        </span>
        <span className="text-[11px] text-[color:var(--ol-text-muted)]">{flag.applicableEnvironment}</span>
      </div>

      <h4 className="mt-2 text-sm font-semibold text-[color:var(--ol-text-primary)]">{flag.title}</h4>
      <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--ol-text-secondary)]">
        {truncate(flag.suggestedResponse)}
      </p>
      {flag.knownLimitations.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[11px] text-[color:var(--ol-text-muted)]">
          {flag.knownLimitations.map((l) => (
            <li key={l}>· {l}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Action onClick={() => void run("confirm", onConfirm)}>{busy === "confirm" ? "Recording…" : "Remember this"}</Action>
        <Action onClick={() => void run("reference", onKeepAsReference)}>
          {busy === "reference" ? "Recording…" : "Keep as reference"}
        </Action>
        <Action onClick={() => void run("aside", onSetAside)} danger>
          {busy === "aside" ? "Recording…" : "Set aside"}
        </Action>
        <Meta className="ml-auto">
          <span>{flag.originatingSender}</span>
          <span>run {short(flag.originatingRunId)}</span>
        </Meta>
      </div>
    </article>
  );
}

function FlagLedgerRow({ flag }: { flag: MemoryFlag }) {
  return (
    <div className="flex items-start gap-3 p-3">
      <span
        className="ol-mono mt-0.5 w-14 flex-none text-right uppercase tracking-wide text-[color:var(--ol-text-faint)]"
        style={{ fontSize: "var(--ol-text-2xs)" }}
      >
        {EVIDENCE_LABEL[flag.evidenceLevel]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[color:var(--ol-text-muted)]">{flag.title}</div>
        <Meta className="mt-1.5">
          <span>{flag.originatingSender}</span>
          <span>run {short(flag.originatingRunId)}</span>
          <span>{flag.reviewState === "available" ? "kept as reference" : "set aside"}</span>
        </Meta>
      </div>
    </div>
  );
}

function MemoryCard({
  rule,
  onPatch,
  onPromote,
  onDeleteDraft,
  onDeleteArchived,
  onArchive,
  onRestore,
}: {
  rule: WorkspaceRule;
  onPatch: (id: string, body: Record<string, unknown>) => Promise<boolean>;
  onPromote: (id: string) => Promise<boolean>;
  onDeleteDraft: (id: string, title: string) => void;
  onDeleteArchived: (id: string, title: string) => void;
  onArchive: (id: string, title: string) => void;
  onRestore: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(rule.title);
  const [draft, setDraft] = useState(rule.body);
  const [copied, setCopied] = useState(false);

  const reappeared = rule.status === "needs_review" && (rule.notes ?? "").includes("reappeared");

  async function copy() {
    await copyText(`* ${rule.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <article className="rounded-lg border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-1)] p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[color:var(--ol-text-secondary)]">
          {RULE_TYPE_LABELS[rule.ruleType]}
        </span>
        <span className={`ol-lozenge ${confidenceChip[rule.confidence]}`}>
          {CONFIDENCE_LABELS[rule.confidence]}
        </span>
        <span className={`ol-lozenge ${statusChip[rule.status]}`}>
          {MEMORY_STATUS_LABEL[rule.status]}
        </span>
        {rule.timesSeen > 1 && (
          <span className="text-[9px] text-[color:var(--ol-text-faint)]">seen {rule.timesSeen}×</span>
        )}
      </div>

      {reappeared && (
        <p className="mt-2 rounded-md border border-[color:var(--ol-warn-border)] bg-[color:var(--ol-warn-soft)] px-2 py-1 text-[10px] text-[color:var(--ol-warn)]">
          Something the team stopped remembering has come up again. Decide whether it stays archived.
        </p>
      )}

      {editing ? (
        <div className="mt-2 space-y-2">
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="w-full rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2.5 py-2 text-xs font-medium text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-border-strong)]"
          />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-20 w-full resize-y rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2.5 py-2 text-xs text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-border-strong)]"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={async () => {
                const ok = await onPatch(rule.id, { title: draftTitle, body: draft });
                if (ok) setEditing(false);
              }}
              className="rounded-md bg-[color:var(--ol-accent)] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[color:var(--ol-accent-hover)]"
            >
              Save
            </button>
            <button type="button" onClick={() => { setDraftTitle(rule.title); setDraft(rule.body); setEditing(false); }} className="px-1.5 py-1 text-[11px] text-[color:var(--ol-text-muted)] hover:text-[color:var(--ol-text-secondary)]">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <h4 className="mt-2 text-sm font-semibold text-[color:var(--ol-text-primary)]">{rule.title}</h4>
          <p className="mt-1 text-sm leading-relaxed text-[color:var(--ol-text-primary)]">{rule.body}</p>
        </>
      )}

      <dl className="mt-2.5 space-y-1.5 border-t border-[color:var(--ol-border-subtle)] pt-2.5 text-[11px] leading-relaxed">
        {rule.evidenceSummary && (
          <Row label="Evidence">{rule.evidenceSummary}</Row>
        )}
        {rule.expectedPrevention && <Row label="Expected">{rule.expectedPrevention}</Row>}
        {rule.scopeCondition && <Row label="Applies when">{rule.scopeCondition}</Row>}
        {rule.sourceSessionName && <Row label="Source">{rule.sourceSessionName}</Row>}
        {rule.lastSeenAt && <Row label="Last seen">{new Date(rule.lastSeenAt).toLocaleDateString()}</Row>}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {rule.status === "needs_review" && (
          <>
            <Action onClick={() => void onPromote(rule.id)}>Remember this</Action>
            <Action onClick={() => onDeleteDraft(rule.id, `Discard ${rule.title}?`)} danger>Discard</Action>
          </>
        )}
        {rule.status === "active" && (
          <Action onClick={() => onArchive(rule.id, `Stop remembering ${rule.title}?`)}>Stop remembering</Action>
        )}
        {rule.status === "retired" && (
          <>
            <Action onClick={() => onRestore(rule.id, `Restore ${rule.title}?`)}>Restore</Action>
            <Action onClick={() => onDeleteArchived(rule.id, `Delete archived ${rule.title}?`)} danger>Delete</Action>
          </>
        )}
        {rule.status === "low_confidence" && (
          <Action onClick={() => void onPatch(rule.id, { status: "needs_review" })}>Move to review</Action>
        )}
        <button type="button" onClick={() => setEditing((v) => !v)} className="rounded-md px-2 py-1 text-[11px] font-medium text-[color:var(--ol-text-muted)] hover:bg-[color:var(--ol-surface-2)] hover:text-[color:var(--ol-text-secondary)]">
          Edit
        </button>
        <button
          type="button"
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--ol-text-secondary)] transition-colors hover:border-[color:var(--ol-border-strong)] hover:text-[color:var(--ol-text-primary)]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </article>
  );
}

/** Status reads as what the team does with the item, not as a table's state column. */
const MEMORY_STATUS_LABEL: Record<RuleStatus, string> = {
  active: "remembered",
  needs_review: "needs review",
  low_confidence: "lower confidence",
  retired: "archived",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-[color:var(--ol-text-faint)]">{label}</dt>
      <dd className="text-[color:var(--ol-text-secondary)]">{children}</dd>
    </div>
  );
}

function Action({ onClick, active = false, danger = false, children }: { onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-danger={danger || undefined}
      className="wf-glass-btn"
      style={active ? { color: "var(--ol-text-primary)", background: "var(--ol-surface-3)" } : undefined}
    >
      {children}
    </button>
  );
}
