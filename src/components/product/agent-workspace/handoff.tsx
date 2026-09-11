"use client";

import { StatusLozenge } from "@/components/product/WorkspaceUI";
import type { RunHandoff } from "@/lib/run-handoff-service";
import { CopyButton } from "./shared";

// ---------------------------------------------------------------------------
// Controlled handoff + evidence intake (kept mechanics, folded presentation).
// ---------------------------------------------------------------------------

export function ControlledRunHandoffPanel({
  handoff,
}: {
  handoff: RunHandoff;
}) {
  const identityRows: Array<[string, string | null]> = [
    ["Run ID", handoff.identity.runId],
    ["Agent", handoff.identity.agent],
    ["Task", handoff.identity.task],
    ["Started", handoff.identity.startedAt],
    ["Preflight", handoff.identity.preflight],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <div className="mt-3 border-t border-[color:var(--ol-border-subtle)] pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[length:var(--ol-text-sm)] font-semibold text-[color:var(--ol-text-primary)]">Run Handoff</div>
          <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-muted)]">
            Use this packet to run the agent session and have the agent prepare evidence for approval.
          </p>
        </div>
        <StatusLozenge tone={handoff.evidenceState === "submitted" ? "ok" : "warn"}>
          {handoff.evidenceStatusLabel}
        </StatusLozenge>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {identityRows.map(([label, value]) => (
          <div key={label} className="rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-2">
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">{label}</div>
            <div className="mt-1 break-words text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-secondary)]">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Run Contract</div>
            <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-secondary)]">{handoff.runContract.summary}</p>
          </div>
          <StatusLozenge tone={handoff.runContract.permissionMode === "Blocked" ? "danger" : handoff.runContract.permissionMode === "Elevated run" ? "warn" : "info"}>
            {handoff.runContract.permissionMode}
          </StatusLozenge>
        </div>
        <p className="mt-2 text-[length:var(--ol-text-2xs)] leading-relaxed text-[color:var(--ol-text-muted)]">
          {handoff.runContract.verificationExpectation}
        </p>
        <HandoffCopyBlock title="Run Contract prompt" text={handoff.runContract.prompt} copyLabel="Copy Run Contract prompt" />
      </div>

      <div className="mt-3 rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Agent setup command</div>
            <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-muted)]">{handoff.rulesCommandHelp}</p>
          </div>
          <CopyButton text={handoff.rulesCommand} label="Copy rules command" />
        </div>
        <code className="mt-2 block overflow-x-auto rounded bg-[color:color-mix(in_srgb,var(--ol-text-primary)_6%,transparent)] px-2 py-1.5 font-mono text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-secondary)]">
          {handoff.rulesCommand}
        </code>
      </div>

      <div className="mt-3 rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Pull instructions with the CLI</div>
            <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-muted)]">{handoff.inboxCommandHelp}</p>
          </div>
          <CopyButton text={handoff.inboxCommand} label="Copy Agent inbox command" />
        </div>
        <code className="mt-2 block overflow-x-auto rounded bg-[color:color-mix(in_srgb,var(--ol-text-primary)_6%,transparent)] px-2 py-1.5 font-mono text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-secondary)]">
          {handoff.inboxCommand}
        </code>
      </div>

      <HandoffCopyBlock title="Agent instruction prompt" text={handoff.agentPrompt} copyLabel="Copy agent instruction prompt" />
      <HandoffCopyBlock title="Evidence template" text={handoff.evidenceTemplate} copyLabel="Copy evidence template" />

      <div className="mt-3 rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-2">
        <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">Handoff state</div>
        <p className="mt-1 text-[length:var(--ol-text-sm)] font-medium text-[color:var(--ol-text-primary)]">{handoff.evidenceStatusLabel}</p>
        {/* The non-waiting branch used to offer a button into the Run
            Passport; that surface was cut, and the state label above already
            says where the handoff stands. */}
        {handoff.evidenceState === "waiting" && (
          <p className="mt-1 text-[length:var(--ol-text-xs)] leading-relaxed text-[color:var(--ol-text-muted)]">
            Ask the agent to prepare a redacted evidence summary, then approve what M9R records.
          </p>
        )}
      </div>
    </div>
  );
}

export function HandoffCopyBlock({ title, text, copyLabel }: { title: string; text: string; copyLabel: string }) {
  return (
    <div className="mt-3 rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">{title}</div>
        <CopyButton text={text} label={copyLabel} />
      </div>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-[color:color-mix(in_srgb,var(--ol-text-primary)_6%,transparent)] px-2 py-1.5 font-mono text-[length:var(--ol-text-2xs)] leading-relaxed text-[color:var(--ol-text-secondary)]">
        {text}
      </pre>
    </div>
  );
}
