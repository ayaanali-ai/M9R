// Bundled demo data for the M9R /demo route.
//
// HONESTY DISCIPLINE: This is a static, anonymized SAMPLE trace shipped with the
// app. The /demo page renders this fixed data client-side. It is NOT live
// production processing of a user-submitted trace. Real trace submissions go
// through /trace-audit. Every value here is illustrative sample data.

export const DEMO_SAMPLE_NOTICE =
  "Demo uses a bundled anonymized sample trace. Real trace submissions go through /trace-audit.";

export const DEMO_SAMPLE_BADGE = "Bundled sample trace";

// ---------------------------------------------------------------------------
// 1. Input trace — a compact, messy coding-agent run as it might arrive.
// ---------------------------------------------------------------------------
export type DemoTraceField = {
  label: string;
  value: string;
  /** When true, this line is rendered as a problem signal (crimson). */
  flagged?: boolean;
};

export type DemoTrace = {
  runId: string;
  agent: string;
  task: string;
  /** Structured, human-readable summary fields for the left panel. */
  fields: DemoTraceField[];
  /** Raw monospace snippet of the messy trace. */
  raw: string;
};

export const DEMO_TRACE: DemoTrace = {
  runId: "demo-trace-7f3a",
  agent: "coding-agent (unnamed)",
  task: "fix failing build in payments module",
  fields: [
    { label: "failed command", value: "npm run build → exit 1 (×4)", flagged: true },
    { label: "repeated file read", value: "src/payments/checkout.ts read 6× unchanged", flagged: true },
    { label: "bloated tool output", value: "grep returned 84 KB pasted back into context", flagged: true },
    { label: "model / token metadata", value: "absent — no model_name, provider, or tokens", flagged: true },
    { label: "retry count", value: "7 retries, no strategy change", flagged: true },
    { label: "duration", value: "00:11:42 wall clock" },
  ],
  raw: [
    "step=01 tool=read file=src/payments/checkout.ts bytes=4210",
    "step=02 tool=shell cmd=\"npm run build\" exit=1 stderr=84KB",
    "step=03 model=? request tokens=? cost=? task=fix_build",
    "step=04 tool=read file=src/payments/checkout.ts bytes=4210 (unchanged)",
    "step=05 tool=shell cmd=\"npm run build\" exit=1 retry=true",
    "step=06 tool=grep pattern=\"export\" output_bytes=86016 piped_to_context=true",
    "step=07 model=? request tokens=? cost=? task=fix_build retry=true",
    "step=08 tool=read file=src/payments/checkout.ts bytes=4210 (unchanged)",
    "step=09 tool=shell cmd=\"npm run build\" exit=1 retry=true",
    "step=10 model=? request tokens=? cost=? task=fix_build retry=true",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// 2. Evidence labels used across findings and gaps.
// ---------------------------------------------------------------------------
export type EvidenceLabel = "Confirmed" | "Inferred" | "Missing" | "Unproven";

// ---------------------------------------------------------------------------
// 3. Blackbox Report — verdict, findings, evidence gaps, prevention plan.
// ---------------------------------------------------------------------------
export type DemoSeverity = "high" | "medium" | "low";

export type DemoFinding = {
  id: string;
  detector: string;
  severity: DemoSeverity;
  /** Short verdict line. */
  verdict: string;
  /** One-line summary of the evidence behind the finding. */
  evidenceSummary: string;
  evidenceLabel: EvidenceLabel;
  /** The prevention control that addresses this finding. */
  preventionControl: string;
};

export const DEMO_FINDINGS: DemoFinding[] = [
  {
    id: "retry-spiral",
    detector: "Retry Spiral",
    severity: "high",
    verdict: "Build retried 4× and the model re-invoked 7× with no strategy change.",
    evidenceSummary: "Steps 02/05/09 repeat the same failing `npm run build`; steps 03/07/10 re-request without new input.",
    evidenceLabel: "Confirmed",
    preventionControl: "Cap retries after N attempts and require a strategy change before retrying.",
  },
  {
    id: "bloated-tool-output",
    detector: "Bloated Tool Output",
    severity: "high",
    verdict: "An 84 KB grep result was piped straight back into model context.",
    evidenceSummary: "Step 06 emits output_bytes=86016 with piped_to_context=true.",
    evidenceLabel: "Confirmed",
    preventionControl: "Summarize or cap tool outputs before feeding them back to the model.",
  },
  {
    id: "repeated-context",
    detector: "Repeated Context / Repeated File Reads",
    severity: "medium",
    verdict: "The same unchanged file was re-read 6× across the run.",
    evidenceSummary: "Steps 01/04/08 read src/payments/checkout.ts at identical bytes=4210, marked unchanged.",
    evidenceLabel: "Confirmed",
    preventionControl: "Stop re-reading unchanged files; cache the first read and reuse it.",
  },
  {
    id: "missing-usage-metadata",
    detector: "Missing Usage / Model Metadata",
    severity: "medium",
    verdict: "No model name, provider, token, or cost data is attached to any call.",
    evidenceSummary: "Steps 03/07/10 record model=? tokens=? cost=?; attribution is impossible.",
    evidenceLabel: "Missing",
    preventionControl: "Require model_name, provider, tokens, and cost metadata on every call.",
  },
  {
    id: "build-fix-loop",
    detector: "Build-Fix Loop",
    severity: "medium",
    verdict: "A read → build → fail cycle repeats without converging on a fix.",
    evidenceSummary: "The 01→02, 04→05, 08→09 pattern repeats identically; convergence is inferred-absent.",
    evidenceLabel: "Inferred",
    preventionControl: "Require a strategy change after repeated failure instead of looping.",
  },
];

export type EvidenceGap = {
  label: string;
  detail: string;
  evidenceLabel: EvidenceLabel;
};

export const DEMO_EVIDENCE_GAPS: EvidenceGap[] = [
  { label: "No model / provider identity", detail: "Calls carry no model_name or provider, so model overkill cannot be proven.", evidenceLabel: "Missing" },
  { label: "No token or cost usage", detail: "tokens and cost are absent; exact waste cost is unproven, not zero.", evidenceLabel: "Unproven" },
  { label: "No verified Operator", detail: "Nothing ties this run to an accountable person.", evidenceLabel: "Missing" },
  { label: "No signed model receipt", detail: "Model identity and version are not attested or signed.", evidenceLabel: "Unproven" },
  { label: "Convergence on a fix", detail: "Whether the build was ever fixed is inferred-absent from the trace tail.", evidenceLabel: "Inferred" },
];

export type DemoVerdict = {
  status: string;
  headline: string;
  summary: string;
  evidenceLevel: string;
  findingsCount: number;
  highSeverityCount: number;
};

export const DEMO_VERDICT: DemoVerdict = {
  status: "Findings confirmed — waste pattern reconstructed",
  headline: "Retry spiral and bloated context drove avoidable waste; usage metadata is missing.",
  summary:
    "M9R reconstructed a retry/build-fix loop with repeated unchanged file reads and an oversized tool " +
    "output fed back into context. The trace carries no model or token metadata, so the exact dollar cost is " +
    "labelled unproven rather than guessed. This report distinguishes what is confirmed, inferred, missing, or unproven.",
  evidenceLevel: "Correlated trace metadata (Level 2)",
  get findingsCount() {
    return DEMO_FINDINGS.length;
  },
  get highSeverityCount() {
    return DEMO_FINDINGS.filter((f) => f.severity === "high").length;
  },
};

// ---------------------------------------------------------------------------
// 4. Prevention plan — the controls M9R recommends for this trace.
// ---------------------------------------------------------------------------
export type PreventionControl = {
  id: string;
  control: string;
  addresses: string;
};

export const DEMO_PREVENTION_PLAN: PreventionControl[] = [
  { id: "cap-retries", control: "Cap retries after N attempts", addresses: "Retry Spiral" },
  { id: "summarize-tool-output", control: "Summarize tool outputs before reuse", addresses: "Bloated Tool Output" },
  { id: "require-metadata", control: "Require model_name / provider / tokens / cost metadata", addresses: "Missing Usage Metadata" },
  { id: "stop-reread", control: "Stop re-reading unchanged files", addresses: "Repeated Context" },
  { id: "require-strategy-change", control: "Require a strategy change after repeated failure", addresses: "Build-Fix Loop" },
];
