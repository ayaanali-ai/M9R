"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AgentMark, Button, Meta, StatusLozenge, Textarea, type LozengeTone } from "@/components/product/WorkspaceUI";
import { workspaceRunState, type AgentView, type WsRun, type WsSession } from "@/lib/agent-workspace-data";
import type { RunPassport } from "@/lib/run-passport-service";
import { buildRunHandoff, type RunHandoff } from "@/lib/run-handoff-service";
import { short, relAt, type RunZone } from "./shared";
import { PreflightPanel, InstructionChannelPanel } from "./preflight";
import { ControlledRunHandoffPanel } from "./handoff";

// ---------------------------------------------------------------------------
// Hero run — the active agent process: pipeline, state, one primary action.
// ---------------------------------------------------------------------------

/** Live clock for the active run — seconds resolution, self-contained tick. */
export function ElapsedTimer({ since }: { since: string | null }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const startedMs = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(startedMs)) return null;
  const secs = Math.max(0, Math.floor((now - startedMs) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return (
    <span className="ol-mono ol-num wf-elapsed" title="Elapsed since run start">
      {h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`}
    </span>
  );
}

const PIPELINE_STAGES = [
  { id: "working", label: "Working" },
  { id: "evidence", label: "Evidence" },
  { id: "approval", label: "Approval" },
  { id: "record", label: "Record" },
];

export function Pipeline({ stage, tone }: { stage: (typeof PIPELINE_STAGES)[number]["id"]; tone: LozengeTone }) {
  const activeIndex = PIPELINE_STAGES.findIndex((s) => s.id === stage);
  return (
    <ol className="wf-pipeline" aria-label="Run pipeline">
      {PIPELINE_STAGES.map((s, index) => {
        const phase = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
        return (
          <li key={s.id} className={`wf-stage wf-stage--${phase}`} data-tone={phase === "active" ? tone : undefined}>
            <span className="wf-stage-marker" aria-hidden />
            <span className="wf-stage-label">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function HeroRun({
  run,
  agent,
  fallbackAgent,
  passport,
  isCurrentRun,
  initialZone,
}: {
  run: WsRun | null;
  agent: AgentView | null;
  fallbackAgent: AgentView | null;
  passport: RunPassport | null;
  isCurrentRun: boolean;
  initialZone: RunZone | null;
}) {
  const [clockNow, setClockNow] = useState(0);
  useEffect(() => {
    const initial = window.setTimeout(() => setClockNow(Date.now()), 0);
    const id = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(id);
    };
  }, []);
  const [evidenceOpen, setEvidenceOpen] = useState(initialZone === "evidence");
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const router = useRouter();
  const startAgent = agent ?? fallbackAgent;

  async function cancelRun(runId: string) {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/agent/runs/${runId}/cancel`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not cancel this run.");
      router.refresh();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Could not cancel this run.");
    } finally {
      setCancelling(false);
    }
  }

  if (!run) {
    return (
      <div className="wf-hero" data-state="empty">
        <div className="wf-hero-state">
          <span className="wf-hero-state-label text-[color:var(--ol-text-muted)]">No current run</span>
        </div>
        <p className="mt-2 text-[length:var(--ol-text-sm)] leading-relaxed text-[color:var(--ol-text-secondary)]">
          Start a controlled run and the agent works in here: rules loaded, inbox open, record forming.
        </p>
        {startAgent ? (
          <StartRunSlot agent={startAgent} />
        ) : (
          <p className="mt-3 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">Select an agent in the dock to start a controlled run.</p>
        )}
      </div>
    );
  }

  const state = workspaceRunState(run, agent, passport, isCurrentRun);
  const live = state.state === "working";
  const evidenceDone = Boolean(run.latest_session_id || passport?.latest_session_id);
  const decisionDone = Boolean(passport?.human_review.decision);
  const activity = decisionDone
    ? "Review decision recorded. Audit history preserved."
    : evidenceDone
      ? "Agent evidence is ready for approval. Review what the agent prepared."
      : live
        ? "Agent is working inside a controlled run. Work continues under loaded rules."
        : "This run has not recorded approved agent evidence. Ask the agent to prepare a redacted evidence summary.";

  const handoff = buildRunHandoff({
    runId: run.id,
    agentName: agent?.label,
    agentKind: run.agent_kind,
    task: run.task_title,
    startedAt: run.started_at,
    activeRuleCount: agent?.activeRulesCount,
    hasEvidence: evidenceDone,
  });

  return (
    <div className="wf-hero" data-state={state.tone}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentMark agentKey={agent?.key ?? run.agent_kind ?? "other"} size={38} />
          <div className="min-w-0">
            <div className="truncate text-[length:var(--ol-text-md)] font-semibold text-[color:var(--ol-text-primary)]">
              {run.task_title || "Run"}
            </div>
            <Meta className="mt-1">
              <span>{agent?.label ?? run.agent_kind ?? "agent"}</span>
              <span>run {short(run.id)}</span>
              <span>{relAt(run.last_seen_at, clockNow)}</span>
              <span>{run.rules_loaded_count} rules loaded</span>
            </Meta>
          </div>
        </div>
        <div className="wf-hero-state text-right">
          <span className={`wf-hero-state-label wf-hero-state-label--${state.tone} ${state.tone === "ok" && live ? "wf-live" : ""}`.trim()}>
            {state.label}
          </span>
          {live && <ElapsedTimer since={run.started_at ?? run.last_seen_at} />}
        </div>
      </div>

      <Pipeline stage={state.stage} tone={state.tone} />

      {live && (
        <div className="bs-term mt-3" aria-label="Live agent phase">
          <span className="bs-term-spin" aria-hidden />
          <span className="min-w-0 truncate">
            phase: {run.current_phase || "working"}
            <span className="bs-term-cursor" aria-hidden />
          </span>
          <span className="ml-auto shrink-0" style={{ color: "var(--bs-t3)" }}>
            seen {relAt(run.last_seen_at, clockNow)}
          </span>
        </div>
      )}

      <p className="mt-3 max-w-xl text-[length:var(--ol-text-sm)] leading-relaxed text-[color:var(--ol-text-secondary)]">{activity}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <HeroPrimaryAction
          state={state.label}
          evidenceDone={evidenceDone}
          decisionDone={decisionDone}
          onApproveEvidence={() => setEvidenceOpen(true)}
        />
        {live && (
          <Button type="button" size="sm" variant="ghost" disabled={cancelling} onClick={() => void cancelRun(run.id)}>
            {cancelling ? "Cancelling…" : "Cancel run"}
          </Button>
        )}
      </div>
      {cancelError && <p role="alert" className="mt-2 text-[length:var(--ol-text-xs)] text-[color:var(--ol-danger)]">{cancelError}</p>}

      {(evidenceOpen || !evidenceDone) && (
        <EvidenceZone
          run={run}
          agent={agent}
          open={evidenceOpen}
          onToggle={() => setEvidenceOpen((v) => !v)}
        />
      )}

      {live && agent && (
        <InstructionChannelPanel key={`instruction-${agent.connectionId ?? agent.key}`} agent={agent} />
      )}

      <div className="wf-fold mt-3">
        <button type="button" className="wf-fold-summary w-full text-left" onClick={() => setHandoffOpen(true)}>
          Controlled handoff packet
        </button>
      </div>

      {handoffOpen && (
        <HandoffDialog handoff={handoff} onClose={() => setHandoffOpen(false)} />
      )}
    </div>
  );
}

export function HandoffDialog({
  handoff,
  onClose,
}: {
  handoff: RunHandoff;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="wf-handoff-overlay" role="dialog" aria-modal="true" aria-label="Controlled handoff packet">
      <button type="button" className="wf-handoff-scrim" aria-label="Close controlled handoff packet" onClick={onClose} />
      <div className="wf-handoff-dialog">
        <button type="button" className="wf-handoff-close" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <ControlledRunHandoffPanel handoff={handoff} />
      </div>
    </div>
  );
}

export function HeroPrimaryAction({
  state,
  evidenceDone,
  decisionDone,
  onApproveEvidence,
}: {
  state: string;
  evidenceDone: boolean;
  decisionDone: boolean;
  onApproveEvidence: () => void;
}) {
  // A decided or revoked run has nothing left to act on here -- the "Open Run
  // Passport" link that used to fill this slot pointed at a surface that no
  // longer exists, and the state line above already says what happened.
  if (decisionDone || state === "Revoked") return null;
  if (evidenceDone) {
    return (
      <button type="button" className="wf-cta" onClick={onApproveEvidence}>
        Open evidence review
      </button>
    );
  }
  return (
    <button type="button" className="wf-cta" onClick={onApproveEvidence}>
      Open evidence review
    </button>
  );
}

// ---------------------------------------------------------------------------
// Agent Evidence zone — the agent prepares evidence; the human approves it.
// ---------------------------------------------------------------------------

export function EvidenceZone({
  run,
  agent,
  open,
  onToggle,
}: {
  run: WsRun;
  agent: AgentView | null;
  open: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  const [evidenceText, setEvidenceText] = useState("");
  const [evidenceApproved, setEvidenceApproved] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState<string | null>(null);
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [authorizationNote, setAuthorizationNote] = useState<string | null>(null);
  const connectionId = agent?.connectionId ?? null;
  const sessions = (agent?.sessions ?? []).filter((session) => session.runId === run.id);

  async function submitEvidence() {
    if (!connectionId) {
      setSubmitError("Connect this agent before recording approved evidence.");
      return;
    }
    if (!evidenceText.trim()) {
      setSubmitError("Agent evidence is required.");
      return;
    }
    if (!evidenceApproved) {
      setSubmitError("Approve the agent evidence before recording it.");
      return;
    }

    setSubmitBusy(true);
    setSubmitError(null);
    setSubmitNote(null);

    try {
      const res = await fetch("/api/agent/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: run.id,
          connection_id: connectionId,
          human_approved_submission: true,
          session_text: evidenceText,
          agent_kind: run.agent_kind,
          redaction_status: "human_reviewed",
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not record approved evidence.");

      setEvidenceText("");
      setEvidenceApproved(false);
      setSubmitNote("Approved agent evidence recorded. Run Passport is ready for review.");
      router.refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not record approved evidence.");
    } finally {
      setSubmitBusy(false);
    }
  }

  async function authorizeEvidenceSubmission() {
    setAuthorizationBusy(true);
    setSubmitError(null);
    setAuthorizationNote(null);
    try {
      const res = await fetch(`/api/dashboard/runs/${encodeURIComponent(run.id)}/evidence-authorization`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; authorization?: { expiresAt?: string } };
      if (!res.ok) throw new Error(json.error || "Could not authorize evidence submission.");
      setAuthorizationOpen(false);
      setAuthorizationNote(`Authorized for the connected agent${json.authorization?.expiresAt ? ` until ${new Date(json.authorization.expiresAt).toLocaleString()}` : ""}. The agent will receive the request in its inbox; submitted evidence still requires your final review.`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not authorize evidence submission.");
    } finally {
      setAuthorizationBusy(false);
    }
  }

  return (
    <section id="wf-evidence" tabIndex={-1} className="wf-fold mt-3 scroll-mt-4 outline-none" aria-label="Agent Evidence">
      <button type="button" className="wf-fold-summary w-full text-left" aria-expanded={open} onClick={onToggle}>
        Agent Evidence: agent prepares evidence. You approve it.
      </button>
      {open && (
        <div className="wf-fold-body">
          {/* Monochrome: this was a decorative sky-blue panel (border-[color:var(--ol-info-border)]
              bg-[color:var(--ol-info-soft)], text-[color:var(--ol-info)]). Surface tier + hairline carry
              the grouping instead; the only color left here is the genuine
              warn status below, and that now reads from --ol-warn rather than
              a hardcoded Tailwind amber. */}
          <div className="mb-3 rounded border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] p-3">
            <p className="text-[length:var(--ol-text-xs)] font-medium text-[color:var(--ol-text-primary)]">Authorize the agent to submit structured evidence</p>
            <p className="mt-1 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-muted)]">This sends a durable, run-scoped authorization to the connected agent. It does not record evidence; you will still review the submitted facts, files, verification, and limitations.</p>
            {authorizationNote && <p className="mt-2 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-secondary)]">{authorizationNote}</p>}
            {!authorizationNote && connectionId && <button type="button" className="ol-btn ol-btn--secondary ol-btn--sm mt-2" onClick={() => setAuthorizationOpen(true)} disabled={authorizationBusy}>Authorize evidence submission</button>}
            {!connectionId && <p className="mt-2 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-warn)]">Reconnect this agent before authorizing evidence submission.</p>}
            {authorizationOpen && (
              <div className="mt-3 rounded border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-1)] p-3" role="dialog" aria-label="Confirm evidence authorization">
                <p className="text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-primary)]">Authorize {agent?.label ?? "this agent"} for this run?</p>
                <p className="mt-1 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-muted)]">The agent may prepare and submit redacted evidence for human review. Nothing is recorded until you approve the submitted evidence.</p>
                <div className="mt-2 flex gap-2"><button type="button" className="ol-btn ol-btn--secondary ol-btn--sm" onClick={() => void authorizeEvidenceSubmission()} disabled={authorizationBusy}>{authorizationBusy ? "Authorizing…" : "Confirm authorization"}</button><button type="button" className="ol-btn ol-btn--ghost ol-btn--sm" onClick={() => setAuthorizationOpen(false)} disabled={authorizationBusy}>Cancel</button></div>
              </div>
            )}
          </div>
          {sessions.length > 0 ? (
            <EvidenceList sessions={sessions} />
          ) : run.latest_session_id ? (
            <p className="text-[length:var(--ol-text-sm)] text-[color:var(--ol-text-secondary)]">Approved agent evidence recorded. Run Passport is ready for review.</p>
          ) : (
            <p className="text-[length:var(--ol-text-sm)] leading-relaxed text-[color:var(--ol-text-muted)]">
              No approved agent evidence recorded yet. Ask the agent to prepare a redacted evidence summary, then approve what M9R records.
            </p>
          )}
          {connectionId && !run.latest_session_id && (
            <SubmitEvidenceCard
              evidenceText={evidenceText}
              evidenceApproved={evidenceApproved}
              submitBusy={submitBusy}
              submitError={submitError}
              submitNote={submitNote}
              onEvidenceText={setEvidenceText}
              onEvidenceApproved={setEvidenceApproved}
              onSubmit={() => void submitEvidence()}
            />
          )}
          {!connectionId && !run.latest_session_id && (
            <p className="mt-2 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">Reconnect this agent before recording approved evidence here.</p>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Start a controlled run — preflight gate in the empty process slot.
// ---------------------------------------------------------------------------

export function StartRunSlot({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);
  if (!agent.connected) {
    return (
      <p className="mt-3 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">
        Connect this agent first. The setup command is above.
      </p>
    );
  }
  return (
    <div className="mt-4">
      {!open ? (
        <button type="button" className="wf-cta" onClick={() => setOpen(true)}>
          Start controlled run
        </button>
      ) : (
        <PreflightPanel key={agent.connectionId ?? agent.key} agent={agent} />
      )}
    </div>
  );
}

export function SubmitEvidenceCard({
  evidenceText,
  evidenceApproved,
  submitBusy,
  submitError,
  submitNote,
  onEvidenceText,
  onEvidenceApproved,
  onSubmit,
}: {
  evidenceText: string;
  evidenceApproved: boolean;
  submitBusy: boolean;
  submitError: string | null;
  submitNote: string | null;
  onEvidenceText: (value: string) => void;
  onEvidenceApproved: (value: boolean) => void;
  onSubmit: () => void;
}) {
  const submitDisabled = !evidenceText.trim() || !evidenceApproved || submitBusy;

  return (
    <div className="mt-3 border-t border-[color:var(--ol-border-subtle)] pt-3">
      <p className="text-[length:var(--ol-text-xs)] font-semibold text-[color:var(--ol-text-primary)]">
        Manual evidence fallback (human supplied)
      </p>
      <p className="text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-muted)]">
        Paste the redacted summary you received from the agent when its direct submission was unavailable. Evidence is a review aid; do not paste secrets, private keys, customer data, or raw .env values. This text is not provider-authenticated; your approval records it as human-supplied evidence.
      </p>
      <Textarea
        value={evidenceText}
        onChange={(e) => onEvidenceText(e.target.value)}
        placeholder="Agent-prepared redacted evidence summary."
        maxLength={500000}
        className="mt-2 h-32"
      />
      <label className="mt-2 flex items-start gap-2 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-secondary)]">
        <input
          type="checkbox"
          checked={evidenceApproved}
          onChange={(e) => onEvidenceApproved(e.target.checked)}
          className="mt-0.5 shrink-0"
        />
        <span>I approve this agent evidence for M9R to record.</span>
      </label>
      {submitError && <p role="alert" className="mt-2 text-[length:var(--ol-text-xs)] text-[color:var(--ol-danger)]">{submitError}</p>}
      {submitNote && <p className="mt-2 text-[length:var(--ol-text-xs)] text-[color:var(--ol-accent-text)]">{submitNote}</p>}
      <button
        type="button"
        onClick={onSubmit}
        disabled={submitDisabled}
        className="ol-btn ol-btn--secondary ol-btn--sm mt-3"
      >
        {submitBusy ? "Recording approved evidence (human-reviewed)" : "Record approved evidence (human-reviewed)"}
      </button>
    </div>
  );
}

export function EvidenceList({ sessions }: { sessions: WsSession[] }) {
  if (sessions.length === 0)
    return (
      <p className="text-[length:var(--ol-text-sm)] leading-relaxed text-[color:var(--ol-text-muted)]">
        No approved agent evidence recorded yet. Approved agent evidence appears here after it is recorded for a visible run.
      </p>
    );
  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <div key={s.id} className="ol-row p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="truncate text-sm text-[color:var(--ol-text-primary)]">{s.summary || "Session analyzed"}</div>
            {s.runId && <StatusLozenge tone="info">run {short(s.runId)}</StatusLozenge>}
          </div>
          <Meta className="mt-1.5">
            <span>source: {s.source_quality || "unknown"}</span>
            <span>{s.findings_count ?? 0} findings</span>
            <span>{(s.rules_generated ?? 0) > 0 ? `${s.rules_generated} rule rec.` : "no rule recommended"}</span>
          </Meta>
        </div>
      ))}
    </div>
  );
}
