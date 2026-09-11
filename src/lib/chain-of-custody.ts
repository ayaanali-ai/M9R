// Chain-of-custody data model for the OathLock Blackbox Report.
//
// This wraps the existing RunLeak detector/cost output (see sample-report.ts and
// resource-ledger.ts) in OathLock's broader chain-of-custody framing:
//   human → agent → identity → credential → model → tool → data → action → cost → policy → proof
//
// HONESTY DISCIPLINE: every node carries an explicit status. We never mark a link
// "confirmed" unless the source trace actually contains that evidence. Fields the
// synthetic sample trace does not contain are labelled "missing" or
// "not_present" — not silently upgraded. Any sample/mock metadata is flagged.
import type { WasteFinding } from "@/lib/resource-ledger";
import { SAMPLE_REPORT, SAMPLE_FINDINGS } from "@/lib/sample-report";

export type ChainStatus =
  | "confirmed" // evidence is directly present in the source trace
  | "violation" // synthetic/demo or policy evaluation marks this link as risky
  | "inferred" // not stated, but strongly implied by correlated trace metadata
  | "missing" // the trace does not carry this evidence at all
  | "planned" // OathLock capability not yet wired up
  | "not_present"; // field is simply absent from this source trace

export type ChainNodeId =
  | "human"
  | "agent"
  | "identity"
  | "credential"
  | "model"
  | "tool"
  | "data"
  | "action"
  | "cost"
  | "policy"
  | "proof";

export type ChainNode = {
  id: ChainNodeId;
  label: string;
  status: ChainStatus;
  /** One-line forensic note on what the trace does (or does not) establish. */
  detail: string;
  /** True when `detail` is illustrative sample metadata rather than trace-derived. */
  sample?: boolean;
};

export const CHAIN_STATUS_META: Record<
  ChainStatus,
  { label: string; tone: "confirmed" | "violation" | "inferred" | "neutral" }
> = {
  confirmed: { label: "Confirmed", tone: "confirmed" },
  violation: { label: "Violation / Risk", tone: "violation" },
  inferred: { label: "Inferred from trace", tone: "inferred" },
  missing: { label: "Missing", tone: "neutral" },
  planned: { label: "Planned", tone: "neutral" },
  not_present: { label: "Not present in source trace", tone: "neutral" },
};

// Statuses for the current synthetic sample trace. The only links the trace can
// actually support are cost (token/cost numbers exist) plus inferred agent/tool/
// action behaviour from the step structure. Everything else is honestly missing.
export const SAMPLE_CHAIN: ChainNode[] = [
  { id: "human", label: "Human", status: "missing", detail: "No verified Operator attached to this run." },
  { id: "agent", label: "Agent", status: "inferred", detail: "A single coding-style agent is inferred from the step sequence.", sample: true },
  { id: "identity", label: "Identity", status: "missing", detail: "No identity record or principal is present in the trace." },
  { id: "credential", label: "Credential", status: "missing", detail: "No credential or token reference was recorded." },
  { id: "model", label: "Model", status: "not_present", detail: "Source trace carries no model name, version, or model receipt." },
  { id: "tool", label: "Tool", status: "inferred", detail: "Repeated tool/model calls are observed across steps 3–7." },
  { id: "data", label: "Data", status: "missing", detail: "No data-access or resource records are present." },
  { id: "action", label: "Action", status: "inferred", detail: "Per-step actions are inferred from the run's call sequence." },
  { id: "cost", label: "Cost", status: "confirmed", detail: "Per-run token and cost totals are present and correlated." },
  { id: "policy", label: "Policy", status: "planned", detail: "Policy checks are advisory only; no enforcement record exists." },
  { id: "proof", label: "Proof", status: "inferred", detail: "Correlated trace metadata (Level 2). No signed receipt or attestation." },
];

export type ChainSummary = {
  total: number;
  confirmed: number;
  inferred: number;
  missing: number;
  planned: number;
  notPresent: number;
  /** Links with usable evidence (confirmed or inferred) over total. */
  reconstructed: number;
};

export function summarizeChain(nodes: ChainNode[] = SAMPLE_CHAIN): ChainSummary {
  const count = (s: ChainStatus) => nodes.filter((n) => n.status === s).length;
  const confirmed = count("confirmed");
  const inferred = count("inferred");
  return {
    total: nodes.length,
    confirmed,
    inferred,
    missing: count("missing"),
    planned: count("planned"),
    notPresent: count("not_present"),
    reconstructed: confirmed + inferred,
  };
}

// ---------------------------------------------------------------------------
// Evidence / proof levels. The sample report tops out at Level 2 (correlated
// logs). Levels 3–5 require capabilities OathLock has not implemented; they are
// shown as not-yet-reached so the report never overclaims.
// ---------------------------------------------------------------------------
export type ProofLevel = {
  level: 0 | 1 | 2 | 3 | 4 | 5;
  name: string;
  description: string;
  reached: boolean;
};

export const SAMPLE_EVIDENCE_LEVEL = 2 as const;

export const PROOF_LEVELS: ProofLevel[] = [
  { level: 0, name: "Claimed", description: "Asserted with no supporting record.", reached: true },
  { level: 1, name: "Observed metadata", description: "Per-call token and cost metadata is present.", reached: true },
  { level: 2, name: "Correlated logs", description: "Repeated blocks hashed and correlated across steps.", reached: true },
  { level: 3, name: "Tamper-evident chain", description: "Event hashes chained so edits are detectable.", reached: false },
  { level: 4, name: "Signed receipt", description: "Model/tool receipts cryptographically signed.", reached: false },
  { level: 5, name: "Runtime attestation", description: "Execution attested by a trusted runtime.", reached: false },
];

// ---------------------------------------------------------------------------
// What this trace cannot prove yet. Stating the gaps explicitly is what makes
// the report credible.
// ---------------------------------------------------------------------------
export type MissingEvidenceItem = { label: string; why: string };

export const MISSING_EVIDENCE: MissingEvidenceItem[] = [
  { label: "No verified Operator", why: "Nothing in the trace ties this run to an accountable person." },
  { label: "No credential chain", why: "The credential or token used to act was not recorded." },
  { label: "No signed model receipt", why: "Model identity and version are not attested or signed." },
  { label: "No SaaS final-action audit log", why: "External writes/actions have no independent system-of-record entry." },
  { label: "No policy engine enforcement record", why: "Policy checks are advisory; nothing was blocked or approved at runtime." },
  { label: "No runtime attestation", why: "Execution environment is not attested by a trusted runtime." },
];

// ---------------------------------------------------------------------------
// Findings view-model. The live finding is derived from the existing RunLeak
// detector output (SAMPLE_FINDINGS); the rest are clearly-labelled planned
// detectors so the surface communicates the roadmap without faking results.
// ---------------------------------------------------------------------------
export type FindingStatus = "live" | "planned";
export type FindingSeverity = "high" | "medium" | "low";

export type BlackboxFinding = {
  id: string;
  detector: string;
  status: FindingStatus;
  severity: FindingSeverity;
  summary: string;
  evidence: string[];
  affected: string;
  costImpactUsd: number | null;
  confidence: WasteFinding["confidence"] | "n/a";
  prevention: string;
  proofStatus: string;
};

function liveFindingFrom(f: WasteFinding): BlackboxFinding {
  return {
    id: f.id,
    detector: "Repeated Context",
    status: "live",
    severity: f.confidence === "high" ? "high" : "medium",
    summary: f.summary,
    evidence: f.evidence,
    affected: f.affectedSteps.map((s) => `step-${s}`).join(", "),
    costImpactUsd: f.estimatedCostWasteUsd ?? null,
    confidence: f.confidence,
    prevention: f.recommendation,
    proofStatus: "Correlated logs (Level 2)",
  };
}

const PLANNED_FINDINGS: BlackboxFinding[] = [
  {
    id: "bto-planned",
    detector: "Bloated Tool Output",
    status: "planned",
    severity: "medium",
    summary: "Detects oversized tool returns carried forward as input tokens.",
    evidence: ["Planned detector — requires per-tool output sizes in the trace."],
    affected: "—",
    costImpactUsd: null,
    confidence: "n/a",
    prevention: "Cap tool output size and summarize before feeding back to the model.",
    proofStatus: "Not present in source trace",
  },
  {
    id: "retry-planned",
    detector: "Retry Spiral",
    status: "planned",
    severity: "medium",
    summary: "Detects failing steps retried without new information.",
    evidence: ["Planned detector — requires per-step status/outcome fields."],
    affected: "—",
    costImpactUsd: null,
    confidence: "n/a",
    prevention: "Cap retries after N attempts unless new information appears.",
    proofStatus: "Not present in source trace",
  },
  {
    id: "overkill-planned",
    detector: "Model Overkill",
    status: "planned",
    severity: "low",
    summary: "Flags a large model used for low-risk planning or formatting.",
    evidence: ["Planned detector — requires model metadata, which this trace lacks."],
    affected: "—",
    costImpactUsd: null,
    confidence: "n/a",
    prevention: "Route low-risk work to a smaller model; escalate only when needed.",
    proofStatus: "Not present in source trace",
  },
  {
    id: "usage-planned",
    detector: "Missing Usage Metadata",
    status: "planned",
    severity: "low",
    summary: "Flags calls missing token/usage metadata required for attribution.",
    evidence: ["Planned detector — model/identity fields are absent from this trace."],
    affected: "—",
    costImpactUsd: null,
    confidence: "n/a",
    prevention: "Require model + usage metadata on every recorded call.",
    proofStatus: "Not present in source trace",
  },
];

export function getBlackboxFindings(
  findings: WasteFinding[] = SAMPLE_FINDINGS,
): BlackboxFinding[] {
  return [...findings.map(liveFindingFrom), ...PLANNED_FINDINGS];
}

// Broader OathLock chain-of-custody controls. Distinguishes cost/context fixes
// (advisory, motivated by live detectors) from chain controls that are planned.
export type CustodyControl = { text: string; kind: "advisory" | "planned" };

export const OATHLOCK_CONTROLS: CustodyControl[] = [
  { text: "Summarize repeated context before the next model call.", kind: "advisory" },
  { text: "Cap tool output size before feeding it back to the model.", kind: "advisory" },
  { text: "Route cheaper models where the task allows it.", kind: "advisory" },
  { text: "Require model metadata (name, version) on every call.", kind: "planned" },
  { text: "Require an agent manifest identifying the acting agent.", kind: "planned" },
  { text: "Attach a verified Operator to each run.", kind: "planned" },
  { text: "Log the credential used for each privileged action.", kind: "planned" },
  { text: "Require approval for external or write actions.", kind: "planned" },
  { text: "Generate tamper-evident event hashes for the chain.", kind: "planned" },
];

// Cost figures re-exported for the report so it reads from one source of truth.
export const COST = {
  runCostUsd: SAMPLE_REPORT.totalCostUsd,
  fixedCostUsd: SAMPLE_REPORT.fixedCostUsd,
  detectedWasteUsd: SAMPLE_REPORT.wastedCostUsd,
  unattributedDeltaUsd: SAMPLE_REPORT.unattributedDeltaUsd,
  totalTokens: SAMPLE_REPORT.totalTokens,
  wastedTokens: SAMPLE_REPORT.wastedTokens,
} as const;
