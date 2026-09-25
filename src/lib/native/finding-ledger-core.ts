/**
 * Verified findings for agents that share a task (spike, docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md, search benchmark).
 * In the real-agent search runs a submitter accepted a teammate's FOUND message without checking it. A finding is
 * therefore "unverified" until an agent other than the reporter confirms it, a rejection blocks it, and nothing may
 * be relied on or submitted until `canRely` says so. The ledger records who reported and who verified what, so the
 * decision can be audited; it never stores page content beyond the claim text the reporter chose to send.
 */
import { randomUUID } from "node:crypto";

export type FindingStatus = "unverified" | "confirmed" | "rejected";

export interface Verification {
  by: string;
  outcome: "confirmed" | "rejected";
  note: string;
  at: number;
}

export interface Finding {
  id: string;
  task: string;
  reporter: string;
  claim: string;
  evidence: string;
  reportedAt: number;
  verifications: Verification[];
}

export interface LedgerDeps {
  now?: () => number;
  newId?: () => string;
  /** Independent confirmations needed before a finding can be relied on. Defaults to 1. */
  requiredConfirmations?: number;
}

export type LedgerResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_CLAIM = 500;
const MAX_NOTE = 200;

export function statusOf(finding: Finding): FindingStatus {
  if (finding.verifications.some((v) => v.outcome === "rejected")) return "rejected";
  return finding.verifications.some((v) => v.outcome === "confirmed") ? "confirmed" : "unverified";
}

export function createFindingLedger(deps: LedgerDeps = {}) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomUUID());
  const required = Math.max(1, deps.requiredConfirmations ?? 1);
  const findings = new Map<string, Finding>();

  function report(input: { task: string; reporter: string; claim: string; evidence?: string }): LedgerResult<Finding> {
    const claim = input.claim.trim().slice(0, MAX_CLAIM);
    if (!input.task || !input.reporter) return { ok: false, error: "a finding needs a task and a reporter" };
    if (!claim) return { ok: false, error: "a finding needs a claim" };
    const finding: Finding = {
      id: newId(),
      task: input.task,
      reporter: input.reporter,
      claim,
      evidence: (input.evidence ?? "").trim().slice(0, MAX_CLAIM),
      reportedAt: now(),
      verifications: [],
    };
    findings.set(finding.id, finding);
    return { ok: true, value: finding };
  }

  function verify(id: string, by: string, outcome: "confirmed" | "rejected", note = ""): LedgerResult<Finding> {
    const finding = findings.get(id);
    if (!finding) return { ok: false, error: `unknown finding ${id}` };
    if (by === finding.reporter) return { ok: false, error: "a finding cannot be verified by the agent that reported it" };
    if (finding.verifications.some((v) => v.by === by)) return { ok: false, error: `${by} has already verified this finding` };
    finding.verifications.push({ by, outcome, note: note.trim().slice(0, MAX_NOTE), at: now() });
    return { ok: true, value: finding };
  }

  /** True only when enough agents other than the reporter confirmed it and nobody rejected it. */
  function canRely(id: string): { rely: boolean; reason: string } {
    const finding = findings.get(id);
    if (!finding) return { rely: false, reason: `unknown finding ${id}` };
    const status = statusOf(finding);
    if (status === "rejected") {
      const by = finding.verifications.find((v) => v.outcome === "rejected")?.by;
      return { rely: false, reason: `${by} rejected this finding` };
    }
    const confirmations = finding.verifications.filter((v) => v.outcome === "confirmed").length;
    if (confirmations < required) return { rely: false, reason: `needs ${required - confirmations} more independent confirmation(s) from an agent other than ${finding.reporter}` };
    return { rely: true, reason: `confirmed by ${finding.verifications.filter((v) => v.outcome === "confirmed").map((v) => v.by).join(", ")}` };
  }

  return {
    report,
    verify,
    canRely,
    get: (id: string): Finding | undefined => findings.get(id),
    forTask: (task: string): Finding[] => [...findings.values()].filter((f) => f.task === task),
    /** Findings the given agent could usefully check: not its own, not already verified by it, not rejected, and not yet reliable. */
    toVerify: (agent: string, task: string): Finding[] =>
      [...findings.values()].filter(
        (f) => f.task === task && f.reporter !== agent && statusOf(f) !== "rejected" && !canRely(f.id).rely && !f.verifications.some((v) => v.by === agent),
      ),
  };
}

export type FindingLedger = ReturnType<typeof createFindingLedger>;
