"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle, AlertTriangle } from "lucide-react";
import PromoteRuleButton from "@/components/product/PromoteRuleButton";
import ProductConfirmDialog from "@/components/product/ProductConfirmDialog";
import { AgentMark, Button, StatusLozenge, type LozengeTone } from "@/components/product/WorkspaceUI";
import { workspaceRunState, type AgentKindKey, type AgentView, type WsRule, type WsRun } from "@/lib/agent-workspace-data";
import { humanizeEnumLabel } from "@/lib/format-enum-label";
import type { RunPassport } from "@/lib/run-passport-service";
import {
  DEFAULT_APPROVAL_LIMIT,
  type AgentApprovalCenter,
  type ApprovalItem,
} from "@/lib/agent-approval-center";
import { relAt, short, agentForRun, ApprovalRecordLine, type Selected, type RunZone } from "./shared";

const DELETE_DRAFT_CONFIRM = "Delete this draft? The draft will be removed.";

// ---------------------------------------------------------------------------
// Approval Center — the Human Decision inbox. Drawer-only, opaque, grouped.
// ---------------------------------------------------------------------------

export function approvalTone(approval: ApprovalItem): LozengeTone {
  if (approval.priority === "critical") return "danger";
  return "warn";
}

// Left-edge accent color for the card shell, keyed off the same tone as its
// StatusLozenge so the two never disagree about what state a card is in.
const APPROVAL_CARD_EDGE: Record<LozengeTone, string> = {
  neutral: "var(--ol-border-strong)",
  active: "var(--ol-accent)",
  draft: "var(--ol-border-strong)",
  review: "var(--ol-warn)",
  archived: "var(--ol-text-faint)",
  ok: "var(--ol-ok)",
  warn: "var(--ol-warn)",
  danger: "var(--ol-danger)",
  info: "var(--ol-info)",
  stale: "var(--ol-text-faint)",
};

/** A single leading glyph per row, Cursor's own "Ready for Review" list
 * idiom -- a flat checklist read, not a stack of bordered cards. */
const APPROVAL_ROW_ICON: Record<LozengeTone, typeof Check> = {
  neutral: Circle,
  active: Circle,
  draft: Circle,
  review: Circle,
  archived: Check,
  ok: Check,
  warn: Circle,
  danger: AlertTriangle,
  info: Circle,
  stale: Circle,
};

/**
 * WorkspaceDrawer — the single right drawer for everything that isn't
 * messaging (Approval Center, Agent Activity). D0: Watchfloor no longer has
 * separate tabs for these; one drawer, switched by the mode the caller
 * chose, keeps the shell/backdrop/focus-trap/animation identical across
 * both instead of duplicating it per surface.
 */
export function WorkspaceDrawer({
  kicker,
  title,
  description,
  onClose,
  children,
}: {
  kicker: string;
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="wf-approval-overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-drawer-heading" aria-describedby="workspace-drawer-description">
      <button
        type="button"
        className="wf-approval-backdrop bg-black/75"
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <aside ref={drawerRef} className="wf-approval-drawer overflow-y-auto" aria-label={title}>
        <div className="wf-approval-drawer-header">
          <div>
            <div className="wf-zone-label">{kicker}</div>
            <h2 id="workspace-drawer-heading" className="mt-0.5 text-[15px] font-semibold text-[color:var(--ol-text-primary)]">
              {title}
            </h2>
            <p id="workspace-drawer-description" className="mt-1 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">{description}</p>
          </div>
          <button ref={closeRef} type="button" className="wf-approval-close" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

type ApprovalTypeFilter = ApprovalItem["type"] | "all";

export function ApprovalCenter({
  center,
  approvals: incomingApprovals,
  selected,
  agents,
  approvalRules,
  passports: incomingPassports,
  runs,
  onOpenRun,
}: {
  center: AgentApprovalCenter;
  approvals: ApprovalItem[];
  selected: Selected;
  agents: AgentView[];
  approvalRules: WsRule[];
  passports: RunPassport[];
  runs: WsRun[];
  onOpenRun: (runId: string, zone: RunZone) => void;
}) {
  const router = useRouter();
  const approvals = incomingApprovals;
  const passports = incomingPassports;
  // Was two separate one-shot setTimeout(0) state pairs that both fired once
  // at mount and never again -- every "3 minutes ago" in this drawer froze
  // at whatever it read when the drawer opened.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const clock = now;
  const [showAllApprovals, setShowAllApprovals] = useState(false);
  const [expandedApprovalId, setExpandedApprovalId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApprovalItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ApprovalTypeFilter>("all");
  const typedApprovals = typeFilter === "all" ? approvals : approvals.filter((approval) => approval.type === typeFilter);
  // The badge and drawer must describe the same pending set. Older unresolved
  // decisions are still actionable, so they remain visible instead of being
  // silently removed by a time window that made a non-zero badge look empty.
  const filteredApprovals = typedApprovals;
  const shownApprovals = showAllApprovals ? filteredApprovals : filteredApprovals.slice(0, DEFAULT_APPROVAL_LIMIT);
  const isEvidenceType = (approval: ApprovalItem) => approval.type === "evidence";
  const evidenceGrouped = new Map<AgentKindKey, ApprovalItem[]>();
  const otherGrouped = new Map<AgentKindKey, ApprovalItem[]>();
  for (const approval of shownApprovals) {
    if (!isEvidenceType(approval)) continue;
    const group = evidenceGrouped.get(approval.agent_id) ?? [];
    group.push(approval);
    evidenceGrouped.set(approval.agent_id, group);
  }
  for (const approval of shownApprovals) {
    if (isEvidenceType(approval)) continue;
    const group = otherGrouped.get(approval.agent_id) ?? [];
    group.push(approval);
    otherGrouped.set(approval.agent_id, group);
  }

  const rulesById = new Map(approvalRules.map((rule) => [rule.id, rule]));
  const passportsByRunId = new Map(passports.map((passport) => [passport.run_id, passport]));
  const runsById = new Map(runs.map((run) => [run.id, run]));

  function toggleDetails(approvalId: string) {
    setExpandedApprovalId((current) => current === approvalId ? null : approvalId);
  }

  function runAction(approval: ApprovalItem) {
    if (!approval.run_id) {
      toggleDetails(approval.approval_id);
      return;
    }
    // Every remaining run-linked approval opens the same place: the run
    // drawer's evidence zone. The passport/review zones opened the retired
    // Run Passport surface.
    onOpenRun(approval.run_id, "evidence");
  }

  async function deleteRuleDraft() {
    const ruleId = deleteTarget?.metadata.rule_id;
    if (!ruleId || deleteBusy) return;
    setDeleteBusy(true);
    setActionError(null);
    const message = await ruleAction(`/api/workspace-rules/${ruleId}`, { method: "DELETE" });
    if (message) {
      setActionError(message);
      setDeleteBusy(false);
      return;
    }
    setDeleteTarget(null);
    setDeleteBusy(false);
    router.refresh();
  }

  // NOTE: this queue deliberately has no review-decision handler. It never
  // had one; the decision used to post from the Run Passport, which was cut.

  function renderAgentGroup(agentKey: AgentKindKey, items: ApprovalItem[]) {
    const agent = agents.find((candidate) => candidate.key === agentKey);
    return (
      <div key={agentKey} className="border-b border-[color:var(--ol-border-subtle)] last:border-b-0">
        <div className="flex items-center gap-2 bg-[color:var(--ol-surface-2)] px-3.5 py-1.5">
          <AgentMark agentKey={agentKey} size={20} />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--ol-text-secondary)]">
            {agent?.label ?? items[0]?.agent_label}
          </span>
          <span className="ol-num text-[10px] text-[color:var(--ol-text-faint)]">
            {center.by_agent[agentKey]} pending
          </span>
          {agent && <ApprovalRecordLine agent={agent} passports={passports} />}
        </div>
        <div className="flex flex-col gap-2 bg-[color:var(--ol-surface-1)] p-2.5">
          {items.map((approval) => {
            const expanded = expandedApprovalId === approval.approval_id;
            const rule = approval.metadata.rule_id
              ? rulesById.get(approval.metadata.rule_id)
              : undefined;
            const passport = approval.run_id
              ? passportsByRunId.get(approval.run_id)
              : undefined;
            const linkedRun = approval.run_id ? runsById.get(approval.run_id) : undefined;
            const runState = linkedRun
              ? workspaceRunState(linkedRun, agentForRun(agents, linkedRun), passport ?? null, false)
              : null;
            const cardTone = runState?.tone ?? approvalTone(approval);
            const RowIcon = APPROVAL_ROW_ICON[cardTone];
            return (
              <div
                key={approval.approval_id}
                className="flex gap-2.5 border-b border-[color:var(--ol-border-subtle)] px-1 py-2.5 last:border-b-0"
              >
                <RowIcon
                  size={15}
                  className="mt-0.5 shrink-0"
                  style={{ color: APPROVAL_CARD_EDGE[cardTone] }}
                  aria-hidden
                />
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="truncate text-[length:var(--ol-text-sm)] font-medium text-[color:var(--ol-text-primary)]">
                        {approval.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-[color:var(--ol-text-faint)]">{relAt(approval.created_at, clock)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <StatusLozenge tone={runState?.tone ?? approvalTone(approval)}>
                        {runState?.label ?? humanizeEnumLabel(approval.status)}
                      </StatusLozenge>
                      {approval.run_id && <span className="ol-mono text-[10px] text-[color:var(--ol-text-faint)]">run {short(approval.run_id)}</span>}
                    </div>
                    {/* line-clamp-1 keeps the collapsed row compact, but a
                        description this codebase truncates is one nobody can
                        ever read in full unless it happens to also be backed
                        by a rule/instruction/passport with its own expanded-
                        panel text below -- a plain description-only approval
                        had no path to its own full text at all. Show it in
                        full once the card is expanded. */}
                    <p className={`mt-0.5 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-muted)] ${expanded ? "whitespace-pre-wrap" : "line-clamp-1"}`}>
                      {approval.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {approval.type === "rule" && rule ? (
                      agent?.connectionId ? (
                        <PromoteRuleButton
                          ruleId={rule.id}
                          targetConnectionId={agent.connectionId}
                          agentLabel={agent.label}
                        />
                      ) : (
                        <span className="max-w-28 text-right text-[10px] text-[color:var(--ol-text-faint)]">
                          Connect this agent to promote
                        </span>
                      )
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => runAction(approval)}
                      >
                        {approval.primary_action.label}
                      </Button>
                    )}
                    {approval.secondary_actions.map((action) => {
                      if (action.kind === "delete_rule_draft") {
                        return (
                          <Button key={action.kind} type="button" size="sm" variant="ghost" onClick={() => setDeleteTarget(approval)}>
                            Delete draft
                          </Button>
                        );
                      }
                      return (
                        <Button
                          key={action.kind}
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => action.kind === "view_details"
                            ? toggleDetails(approval.approval_id)
                            : runAction(approval)}
                        >
                          {action.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                {/* The "Review in Run Passport →" link lived here. The Run
                    Passport surface was cut, and this queue deliberately does
                    not grow a decision control of its own to replace it --
                    deciding from a queue row means approving evidence you
                    cannot see. */}

                {expanded && (
                  <div className="mt-2 rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-2.5">
                    {rule && (
                      <>
                        <p className="text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-secondary)]">{rule.body || rule.title}</p>
                        {rule.evidenceSummary && <p className="mt-1.5 text-[length:var(--ol-text-2xs)] leading-relaxed text-[color:var(--ol-text-muted)]">{rule.evidenceSummary}</p>}
                      </>
                    )}
                    {passport && approval.run_id && (
                      <p className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-muted)]">{passport.review.next_step}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="approval-center-heading">
        <div className="border-b border-[color:var(--ol-border-subtle)] px-4 py-3">
          <p className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-muted)]">
            {selected === "all" ? "All agents" : agents.find((agent) => agent.id === selected)?.label ?? "Selected agent"}
            {" · "}{filteredApprovals.length} in this view · {center.counts.total} pending decisions total
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Approval type filters">
            {(["all", "rule", "evidence"] as ApprovalTypeFilter[]).map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={typeFilter === type}
                onClick={() => {
                  setTypeFilter(type);
                  setShowAllApprovals(false);
                }}
                className="rounded border border-[color:var(--ol-border-subtle)] px-2 py-1 text-[length:var(--ol-text-2xs)] font-medium text-[color:var(--ol-text-muted)] transition-colors aria-pressed:border-[color:var(--ol-border-default)] aria-pressed:bg-[color:var(--ol-surface-2)] aria-pressed:text-[color:var(--ol-text-primary)]"
              >
                {type === "all" ? "All" : type === "evidence" ? "Agent evidence" : type[0].toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {filteredApprovals.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-muted)]">
              {typeFilter === "all" || center.counts.total === 0
                ? "No human decisions pending. Current run records and audit history are preserved."
                : `Nothing pending in "${typeFilter}" right now. ${center.counts.total} pending across all types.`}
            </p>
          </div>
        ) : (
          <div className="wf-no-scrollbar min-h-0 flex-1 overflow-y-auto" aria-live="polite" aria-relevant="additions removals" role="log">
            {evidenceGrouped.size > 0 && (
              <div>
                <div className="wf-zone-label px-3.5 pt-2.5">Evidence &amp; Passport Review</div>
                {[...evidenceGrouped.entries()].map(([agentKey, items]) => renderAgentGroup(agentKey, items))}
              </div>
            )}
            {otherGrouped.size > 0 && (
              <div>
                <div className="wf-zone-label px-3.5 pt-2.5">Rules &amp; Instructions</div>
                {[...otherGrouped.entries()].map(([agentKey, items]) => renderAgentGroup(agentKey, items))}
              </div>
            )}
          </div>
        )}

        {filteredApprovals.length > DEFAULT_APPROVAL_LIMIT && (
          <div className="flex items-center gap-2 border-t border-[color:var(--ol-border-subtle)] px-3.5 py-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowAllApprovals((value) => !value)}>
              {showAllApprovals ? "Show fewer" : `Show all (${filteredApprovals.length})`}
            </Button>
          </div>
        )}
        {actionError && <p role="alert" className="border-t border-[color:var(--ol-border-subtle)] px-3.5 py-2 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-danger)]">{actionError}</p>}
      </section>

      <ProductConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete this rule draft?"
        description={DELETE_DRAFT_CONFIRM}
        confirmLabel="Delete draft"
        busy={deleteBusy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void deleteRuleDraft()}
      />
    </div>
  );
}

async function ruleAction(path: string, init: RequestInit): Promise<string | null> {
  const res = await fetch(path, init);
  if (res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error || "Rule action failed.";
}

