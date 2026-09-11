"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Meta, StatusLozenge, type LozengeTone } from "@/components/product/WorkspaceUI";
import type { AgentView } from "@/lib/agent-workspace-data";
import type { PreflightDecision, PreflightStatus } from "@/lib/agent-preflight-service";
import { buildRunHandoff, M9R_INBOX_COMMAND, type RunHandoff } from "@/lib/run-handoff-service";
import type { RunMode } from "@/lib/run-mode";
import { short, Cmd, CopyButton } from "./shared";
import { ControlledRunHandoffPanel } from "./handoff";

const PREFLIGHT_STATUS_LABEL: Record<PreflightStatus, string> = {
  allowed: "Allowed to start",
  warned: "Start with caution",
  needs_approval: "Human approval required",
  blocked: "Blocked by policy",
};
const PREFLIGHT_STATUS_TONE: Record<PreflightStatus, LozengeTone> = {
  allowed: "ok",
  warned: "warn",
  needs_approval: "warn",
  blocked: "danger",
};

const COLLABORATION_OPTIONS: Array<{ mode: RunMode; label: string; detail: string }> = [
  { mode: "solo", label: "Solo", detail: "No secondary agent calls." },
  { mode: "coordinated", label: "Ask once", detail: "One bounded specialist request when useful." },
  { mode: "assurance", label: "Assurance", detail: "One independent check and an explicit adopt, reject, or challenge decision." },
  { mode: "collaborative", label: "Collaborative", detail: "Up to six bounded requests across two supporting agents; every result needs a decision." },
];

type StartRunResponse = {
  run_id?: string;
  status?: string;
  started_at?: string | null;
  error?: string;
  preflight?: {
    status?: string | null;
    risk_level?: string | null;
  };
};

type CreateInstructionResponse = {
  ok?: true;
  message?: string;
  error?: string;
  instruction?: {
    id: string;
    instruction: string;
    status: "queued" | "pulled";
    created_at: string;
    pulled_at: string | null;
  };
};

export function AssignmentPanel({ agent }: { agent: AgentView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState("");
  const [scope, setScope] = useState("");
  const [prohibitedScope, setProhibitedScope] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [tokenBudget, setTokenBudget] = useState("50000");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent.connectionId || !agent.repoHint || !task.trim() || !scope.trim() || busy) return;
    const minutes = Number(durationMinutes);
    const tokens = Number(tokenBudget);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440 || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > 1_000_000) {
      setError("Duration must be 1–1440 minutes and estimated tokens 1–1,000,000.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const expiresAt = new Date(Date.now() + Math.min(minutes * 2, 1440) * 60_000).toISOString();
      const res = await fetch("/api/assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_connection_id: agent.connectionId,
          repository: agent.repoHint,
          task: task.trim(),
          scope: scope.split(",").map((item) => item.trim()).filter(Boolean),
          prohibitedScope: prohibitedScope.split(",").map((item) => item.trim()).filter(Boolean),
          maxDurationMs: minutes * 60_000,
          maxEstimatedTokens: tokens,
          approvalPolicy: "human_before_start",
          evidenceRequired: true,
          expiresAt,
        }),
      });
      const json = await res.json().catch(() => ({})) as { assignment?: { id?: string }; error?: string };
      if (!res.ok) throw new Error(json.error || "Assignment could not be created.");
      setMessage(`Assignment ${json.assignment?.id ? short(json.assignment.id) : "created"} is waiting for ${agent.label} to accept.`);
      setTask("");
      setScope("");
      setProhibitedScope("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assignment could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wf-fold mt-3" aria-label="Bounded assignment">
      <button type="button" className="wf-fold-summary w-full text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        Assign bounded work to {agent.label}
      </button>
      {open && (
        <form onSubmit={createAssignment} className="mt-3 grid gap-2 px-3 pb-3">
          <p className="text-xs text-[color:var(--ol-text-muted)]">The agent must explicitly accept. Completion requires a run and reviewed evidence record.</p>
          <label className="grid gap-1 text-xs">Task<textarea value={task} onChange={(event) => setTask(event.target.value)} maxLength={500} required className="wf-textarea" /></label>
          <label className="grid gap-1 text-xs">Allowed paths or areas, comma separated<input value={scope} onChange={(event) => setScope(event.target.value)} required className="wf-input" /></label>
          <label className="grid gap-1 text-xs">Prohibited paths or areas, comma separated<input value={prohibitedScope} onChange={(event) => setProhibitedScope(event.target.value)} className="wf-input" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs">Maximum minutes<input type="number" min="1" max="1440" value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} className="wf-input" /></label>
            <label className="grid gap-1 text-xs">Agent-reported estimated-token budget<input type="number" min="1" max="1000000" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} className="wf-input" /></label>
          </div>
          <div className="flex items-center gap-2"><Button type="submit" size="sm" disabled={busy || !task.trim() || !scope.trim()}>{busy ? "Assigning…" : "Create assignment"}</Button><Meta>Human approval before start · evidence required · provider token enforcement unknown</Meta></div>
          {message && <p role="status" className="text-xs text-[color:var(--ol-success)]">{message}</p>}
          {error && <p role="alert" className="text-xs text-[color:var(--ol-danger)]">{error}</p>}
        </form>
      )}
    </section>
  );
}

export function PreflightPanel({ agent }: { agent: AgentView }) {
  const router = useRouter();
  const [taskDescription, setTaskDescription] = useState("");
  const [pathHints, setPathHints] = useState("");
  const [preflightDecision, setPreflightDecision] = useState<PreflightDecision | null>(null);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [approvalNote, setApprovalNote] = useState("");
  const [runMode, setRunMode] = useState<RunMode>("solo");
  const [startedRunHandoff, setStartedRunHandoff] = useState<RunHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDisabled =
    !preflightDecision ||
    preflightDecision.status === "blocked" ||
    (preflightDecision.status === "needs_approval" && !approvalConfirmed) ||
    !agent.connectionId ||
    !taskDescription.trim() ||
    startBusy;
  const canRunPreflight = Boolean(agent.connectionId && taskDescription.trim() && !busy && !startBusy);

  async function runPreflight(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent.connectionId) return;
    setBusy(true);
    setError(null);
    setPreflightDecision(null);
    setApprovalConfirmed(false);
    setApprovalNote("");
    setStartedRunHandoff(null);

    try {
      const res = await fetch("/api/agent/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connection_id: agent.connectionId,
          task: taskDescription,
          path_hints: parsePathHints(pathHints),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as PreflightDecision | { error?: string };
      if (!res.ok || !("ok" in json)) {
        throw new Error("error" in json && json.error ? json.error : "Preflight check failed.");
      }
      setPreflightDecision(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight check failed.");
    } finally {
      setBusy(false);
    }
  }

  async function startControlledRun() {
    if (startDisabled || !preflightDecision || !agent.connectionId) return;
    setStartBusy(true);
    setError(null);
    setStartedRunHandoff(null);

    try {
      const res = await fetch("/api/agent/run/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connection_id: agent.connectionId,
          task: taskDescription,
          task_title: taskDescription,
          path_hints: parsePathHints(pathHints),
          approved_by_human: approvalConfirmed,
          approval_note: approvalNote,
          run_mode: runMode,
          preflight: {
            status: preflightDecision.status,
            risk_level: preflightDecision.risk_level,
            sensitive_areas: preflightDecision.sensitive_areas,
            matched_rule_count: preflightDecision.matched_rules.length,
            approval_required: preflightDecision.approval_required,
          },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as StartRunResponse;
      if (!res.ok || !json.run_id) throw new Error(json.error || "Could not start controlled run.");
      setStartedRunHandoff(buildRunHandoff({
        runId: json.run_id,
        agentName: agent.label,
        agentKind: agent.key,
        task: taskDescription,
        startedAt: json.started_at ?? null,
        preflightStatus: json.preflight?.status ?? preflightDecision.status,
        preflightRisk: json.preflight?.risk_level ?? preflightDecision.risk_level,
        activeRuleCount: preflightDecision.active_rule_count,
        hasEvidence: false,
      }));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start controlled run.");
    } finally {
      setStartBusy(false);
    }
  }

  return (
    <div className="wf-fold-body mt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[length:var(--ol-text-sm)] font-semibold text-[color:var(--ol-text-primary)]">Preflight</div>
          <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-muted)]">
            Check a proposed agent task against active repo rules before a run starts.
          </p>
        </div>
        {preflightDecision && (
          <StatusLozenge tone={PREFLIGHT_STATUS_TONE[preflightDecision.status]}>{PREFLIGHT_STATUS_LABEL[preflightDecision.status]}</StatusLozenge>
        )}
      </div>

      <form onSubmit={runPreflight} className="mt-3 grid gap-2">
        <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
          Task description
          <textarea
            value={taskDescription}
            onChange={(event) => setTaskDescription(event.target.value)}
            className="mt-1 min-h-20 w-full resize-y rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[length:var(--ol-text-sm)] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            placeholder="Describe the agent task before it starts"
            required
          />
        </label>
        <fieldset className="rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-0)] p-2">
          <legend className="px-1 text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Secondary-agent use</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {COLLABORATION_OPTIONS.map((option) => (
              <label key={option.mode} className="flex cursor-pointer items-start gap-2 rounded-md border border-[color:var(--ol-border-subtle)] p-2 has-[:checked]:border-[color:var(--ol-accent-border)] has-[:checked]:bg-[color:var(--ol-surface-2)]">
                <input
                  type="radio"
                  name="run-mode"
                  value={option.mode}
                  checked={runMode === option.mode}
                  onChange={() => setRunMode(option.mode)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-[length:var(--ol-text-2xs)] font-semibold normal-case tracking-normal text-[color:var(--ol-text-primary)]">{option.label}</span>
                  <span className="mt-0.5 block text-[10px] normal-case leading-relaxed tracking-normal text-[color:var(--ol-text-muted)]">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
          Path hints
          <textarea
            value={pathHints}
            onChange={(event) => setPathHints(event.target.value)}
            className="mt-1 min-h-16 w-full resize-y rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[length:var(--ol-text-sm)] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            placeholder="src/app/api/auth/route.ts, supabase/migrations"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="secondary" size="sm" disabled={!canRunPreflight}>
            {busy ? "Checking..." : "Run preflight"}
          </Button>
          {!agent.connectionId && (
            <span className="text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">Connect this agent before running preflight for its workspace.</span>
          )}
        </div>
      </form>

      {error && <p role="alert" className="mt-2 text-[length:var(--ol-text-xs)] text-[color:var(--ol-danger)]">{error}</p>}

      {preflightDecision && (
        <div className="mt-3 space-y-3 rounded-lg border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusLozenge tone={PREFLIGHT_STATUS_TONE[preflightDecision.status]}>{PREFLIGHT_STATUS_LABEL[preflightDecision.status]}</StatusLozenge>
            <StatusLozenge tone={preflightDecision.risk_level === "high" ? "danger" : preflightDecision.risk_level === "medium" ? "warn" : "ok"}>
              risk: {preflightDecision.risk_level}
            </StatusLozenge>
            <StatusLozenge>{preflightDecision.active_rule_count} active rules checked</StatusLozenge>
          </div>
          <p className="text-[length:var(--ol-text-sm)] leading-relaxed text-[color:var(--ol-text-secondary)]">{preflightDecision.summary}</p>

          <PreflightList
            title="Sensitive areas"
            items={preflightDecision.sensitive_areas}
            empty="None detected."
          />
          <PreflightMatchedRules rules={preflightDecision.matched_rules} />
          <PreflightList
            title="Missing requirements"
            items={preflightDecision.missing_requirements}
            empty="None."
          />
          <PreflightList
            title="Recommended requirements"
            items={preflightDecision.recommended_requirements}
            empty="None."
          />

          <div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Next step</div>
            <p className="mt-1 text-[length:var(--ol-text-sm)] leading-relaxed text-[color:var(--ol-text-secondary)]">{preflightDecision.next_step}</p>
          </div>

          <div className="rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-0)] p-2">
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Dashboard run start</div>
            {preflightDecision.status === "blocked" ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-danger)]">Blocked by policy. This task cannot start from the dashboard.</p>
                <Button type="button" variant="secondary" size="sm" disabled>
                  Blocked by policy
                </Button>
              </div>
            ) : (
              <>
                {preflightDecision.status === "warned" && (
                  <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-warn)]">Start with caution. Review the listed requirements before starting the controlled run.</p>
                )}
                {preflightDecision.status === "needs_approval" && (
                  <div className="mt-2 space-y-2">
                    <label className="flex items-start gap-2 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-secondary)]">
                      <input
                        type="checkbox"
                        checked={approvalConfirmed}
                        onChange={(event) => setApprovalConfirmed(event.target.checked)}
                        className="mt-0.5"
                      />
                      <span>I approve starting this high-risk agent run.</span>
                    </label>
                    <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
                      Approval note (optional)
                      <input
                        value={approvalNote}
                        onChange={(event) => setApprovalNote(event.target.value)}
                        className="mt-1 w-full rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-1)] px-2 py-1.5 text-[length:var(--ol-text-sm)] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none"
                        placeholder="Short approval reference"
                      />
                    </label>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => void startControlledRun()} disabled={startDisabled}>
                    {startBusy ? "Starting" : startButtonLabel(preflightDecision.status, approvalConfirmed)}
                  </Button>
                </div>
                {startedRunHandoff && <ControlledRunHandoffPanel handoff={startedRunHandoff} />}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function InstructionChannelPanel({ agent }: { agent: AgentView }) {
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const disabled = !agent.connectionId || !instruction.trim() || busy;

  async function sendInstruction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !agent.connectionId) return;

    setBusy(true);
    setError(null);
    setNote(null);

    try {
      const res = await fetch("/api/agent/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connection_id: agent.connectionId,
          instruction,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as CreateInstructionResponse;
      if (!res.ok || !json.instruction) {
        throw new Error(json.error || "Could not send instruction.");
      }

      setInstruction("");
      setNote("Instruction queued. Waiting for agent pull.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send instruction.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wf-fold mt-3" aria-label="Agent Inbox">
      <div className="wf-fold-body">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[length:var(--ol-text-sm)] font-semibold text-[color:var(--ol-text-primary)]">Instruction channel</div>
            <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-muted)]">
              Send an instruction for the agent to pull. Instruction history is preserved.
            </p>
          </div>
          <StatusLozenge tone={agent.connectionId ? "info" : "neutral"}>Agent inbox</StatusLozenge>
        </div>

        <form onSubmit={sendInstruction} className="mt-3 grid gap-2">
          <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
            Instruction
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              maxLength={1000}
              className="mt-1 min-h-16 w-full resize-y rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[length:var(--ol-text-sm)] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
              placeholder="Short instruction for the connected coding agent"
              disabled={!agent.connectionId || busy}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" size="sm" disabled={disabled}>
              {busy ? "Sending" : "Send instruction to agent"}
            </Button>
            <CopyButton text={M9R_INBOX_COMMAND} label="Copy Agent inbox command">Copy inbox command</CopyButton>
            {!agent.connectionId && (
              <span className="text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">Connect this agent before using the instruction channel.</span>
            )}
          </div>
        </form>
        <p className="mt-2 text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-faint)]">
          Pull instructions with the CLI: <Cmd>{M9R_INBOX_COMMAND}</Cmd>
        </p>

        {note && <p className="mt-2 text-[length:var(--ol-text-xs)] text-[color:var(--ol-ok)]">{note}</p>}
        {error && <p role="alert" className="mt-2 text-[length:var(--ol-text-xs)] text-[color:var(--ol-danger)]">{error}</p>}
      </div>
    </section>
  );
}

export function parsePathHints(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function startButtonLabel(status: PreflightStatus, approved: boolean): string {
  if (status === "allowed") return "Start controlled run";
  if (status === "warned") return "Start controlled run with caution";
  if (status === "needs_approval") return approved ? "Start approved run" : "Start approved run";
  return "Blocked by policy";
}

export function PreflightList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">{title}</div>
      {items.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li key={item} className="text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-secondary)]">{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">{empty}</p>
      )}
    </div>
  );
}

export function PreflightMatchedRules({ rules }: { rules: PreflightDecision["matched_rules"] }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Matched rules</div>
      {rules.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {rules.map((rule) => (
            <li key={rule.id} className="text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-secondary)]">
              <span className="font-medium text-[color:var(--ol-text-primary)]">{rule.title}</span>
              <span className="text-[color:var(--ol-text-muted)]">: {rule.reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-muted)]">No active repo rules matched.</p>
      )}
    </div>
  );
}
