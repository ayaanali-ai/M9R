import type { ChainNode, CustodyControl, ProofLevel } from "@/lib/chain-of-custody";

export const FULL_CHAIN_DEMO_HONESTY_NOTICE =
  "This is a synthetic demo showing the full M9R data model. The canonical sample report uses current detector evidence and remains at /analyze.";

export const FULL_CHAIN_DEMO_EVIDENCE_LEVEL = 2 as const;

export type DemoEventType =
  | "task.created"
  | "agent.started"
  | "credential.used"
  | "tool.google_drive.read"
  | "model.request"
  | "model.response"
  | "data.touched"
  | "tool.crm.update"
  | "policy.evaluate"
  | "report.generated";

export type DemoEvent = {
  type: DemoEventType;
  timestamp: string;
  actor: string;
  evidenceSource: string;
  hash: string;
};

export type DemoFinding = {
  title: string;
  severity: "high" | "medium" | "low";
  status: "violation" | "risk" | "attributed";
  summary: string;
  evidence: string[];
};

export const FULL_CHAIN_DEMO = {
  title: "M9R Full Chain Demo",
  subtitle: "Synthetic demonstration of a complete autonomous AI action chain.",
  synthetic: true,
  canonicalEvidenceRoute: "/analyze",
  scenario:
    "A sales research agent is asked by a human owner to summarize customer contract history and update a CRM note.",
  human:
    'revops@company.com initiated task: "Summarize ACME contract history and draft CRM note."',
  agent: "sales_research_agent_01",
  identity: "agent identity declared in manifest; owner = RevOps",
  credential: "revops_service_account used; risk = shared credential",
  model: {
    provider: "OpenAI/Anthropic placeholder",
    claimedModel: "premium model",
    returnedMetadata: "model ID present",
    evidenceLevel: "observed metadata, not signed receipt",
  },
  tools: ["google_drive.read", "crm.update_record"],
  data: {
    resource: "customer_contracts_folder",
    class: "customer_pii / contract_data",
  },
  action: "CRM record updated with generated summary",
  cost: {
    totalUsd: 0.84,
    inputTokens: 128_400,
    outputTokens: 9_600,
  },
  policyViolations: [
    "shared credential used",
    "customer PII touched",
    "external model used without signed receipt",
    "CRM write action performed without approval record",
  ],
  proof: "Correlated synthetic logs",
} as const;

export const FULL_CHAIN_DEMO_CHAIN: ChainNode[] = [
  {
    id: "human",
    label: "Human",
    status: "confirmed",
    detail: FULL_CHAIN_DEMO.human,
    sample: true,
  },
  {
    id: "agent",
    label: "Agent",
    status: "confirmed",
    detail: FULL_CHAIN_DEMO.agent,
    sample: true,
  },
  {
    id: "identity",
    label: "Identity",
    status: "confirmed",
    detail: FULL_CHAIN_DEMO.identity,
    sample: true,
  },
  {
    id: "credential",
    label: "Credential",
    status: "violation",
    detail: FULL_CHAIN_DEMO.credential,
    sample: true,
  },
  {
    id: "model",
    label: "Model",
    status: "violation",
    detail: "Model ID observed, but no signed model receipt.",
    sample: true,
  },
  {
    id: "tool",
    label: "Tool",
    status: "confirmed",
    detail: "google_drive.read and crm.update_record observed.",
    sample: true,
  },
  {
    id: "data",
    label: "Data",
    status: "violation",
    detail: "customer_contracts_folder; customer_pii / contract_data.",
    sample: true,
  },
  {
    id: "action",
    label: "Action",
    status: "violation",
    detail: "CRM record updated without approval record.",
    sample: true,
  },
  {
    id: "cost",
    label: "Cost",
    status: "confirmed",
    detail: "$0.84 total; 128,400 input tokens; 9,600 output tokens.",
    sample: true,
  },
  {
    id: "policy",
    label: "Policy",
    status: "violation",
    detail: "Shared credential, PII, unsigned model receipt, and CRM write approval violations.",
    sample: true,
  },
  {
    id: "proof",
    label: "Proof",
    status: "confirmed",
    detail: "Correlated synthetic logs; L2 only.",
    sample: true,
  },
];

export const FULL_CHAIN_DEMO_EVENTS: DemoEvent[] = [
  {
    type: "task.created",
    timestamp: "2026-06-23T14:00:00.000Z",
    actor: "revops@company.com",
    evidenceSource: "synthetic task request",
    hash: "demo_evt_001_a70f2c9b",
  },
  {
    type: "agent.started",
    timestamp: "2026-06-23T14:00:04.000Z",
    actor: "sales_research_agent_01",
    evidenceSource: "synthetic agent runtime log",
    hash: "demo_evt_002_4c3d9a11",
  },
  {
    type: "credential.used",
    timestamp: "2026-06-23T14:00:08.000Z",
    actor: "sales_research_agent_01",
    evidenceSource: "synthetic SaaS auth log",
    hash: "demo_evt_003_b7f01d20",
  },
  {
    type: "tool.google_drive.read",
    timestamp: "2026-06-23T14:00:12.000Z",
    actor: "revops_service_account",
    evidenceSource: "synthetic Google Drive audit log",
    hash: "demo_evt_004_99cb18d3",
  },
  {
    type: "model.request",
    timestamp: "2026-06-23T14:00:19.000Z",
    actor: "sales_research_agent_01",
    evidenceSource: "synthetic model gateway log",
    hash: "demo_evt_005_5d22c8af",
  },
  {
    type: "model.response",
    timestamp: "2026-06-23T14:00:27.000Z",
    actor: "OpenAI/Anthropic placeholder",
    evidenceSource: "synthetic provider metadata",
    hash: "demo_evt_006_0efab842",
  },
  {
    type: "data.touched",
    timestamp: "2026-06-23T14:00:30.000Z",
    actor: "sales_research_agent_01",
    evidenceSource: "synthetic data classification log",
    hash: "demo_evt_007_f7310cde",
  },
  {
    type: "tool.crm.update",
    timestamp: "2026-06-23T14:00:42.000Z",
    actor: "revops_service_account",
    evidenceSource: "synthetic CRM audit log",
    hash: "demo_evt_008_c41a7f65",
  },
  {
    type: "policy.evaluate",
    timestamp: "2026-06-23T14:00:45.000Z",
    actor: "oathlock_policy_demo",
    evidenceSource: "synthetic policy evaluation",
    hash: "demo_evt_009_a68d33be",
  },
  {
    type: "report.generated",
    timestamp: "2026-06-23T14:00:52.000Z",
    actor: "oathlock_reporter_demo",
    evidenceSource: "synthetic report generator",
    hash: "demo_evt_010_b10c90a1",
  },
];

export const FULL_CHAIN_DEMO_FINDINGS: DemoFinding[] = [
  {
    title: "Shared credential used by AI agent",
    severity: "high",
    status: "violation",
    summary: "sales_research_agent_01 acted through revops_service_account instead of an agent-specific credential.",
    evidence: ["credential.used", "tool.google_drive.read", "tool.crm.update"],
  },
  {
    title: "Sensitive customer data touched",
    severity: "high",
    status: "violation",
    summary: "customer_contracts_folder is classified as customer_pii / contract_data.",
    evidence: ["tool.google_drive.read", "data.touched"],
  },
  {
    title: "CRM write action without approval record",
    severity: "high",
    status: "violation",
    summary: "CRM record updated with generated summary; no approval event is present in the synthetic ledger.",
    evidence: ["tool.crm.update", "policy.evaluate"],
  },
  {
    title: "Model receipt weak / unsigned",
    severity: "medium",
    status: "risk",
    summary: "The model ID is observed in metadata, but no signed receipt or runtime attestation is present.",
    evidence: ["model.request", "model.response"],
  },
  {
    title: "Cost attributed to task and agent",
    severity: "low",
    status: "attributed",
    summary: "$0.84 is attributed to the task, agent, model request, and final CRM action.",
    evidence: ["model.request", "model.response", "report.generated"],
  },
];

export const FULL_CHAIN_DEMO_PROOF_LEVELS: ProofLevel[] = [
  { level: 0, name: "Claimed", description: "Synthetic request and manifest claims are preserved.", reached: true },
  { level: 1, name: "Observed metadata", description: "Synthetic metadata includes IDs, timestamps, tools, token counts, and model ID.", reached: true },
  { level: 2, name: "Correlated logs", description: "Synthetic task, agent, auth, tool, data, policy, and report logs correlate.", reached: true },
  { level: 3, name: "Tamper-evident chain", description: "Event hashes are illustrative, not a real hash-linked capture system.", reached: false },
  { level: 4, name: "Signed receipt", description: "No provider, tool, or runtime signed receipt is claimed.", reached: false },
  { level: 5, name: "Runtime attestation", description: "No trusted runtime attestation is claimed.", reached: false },
];

export const FULL_CHAIN_DEMO_CONTROLS: CustodyControl[] = [
  { text: "Require agent-specific identity.", kind: "planned" },
  { text: "Require short-lived credential.", kind: "planned" },
  { text: "Require approval for CRM write.", kind: "planned" },
  { text: "Require model metadata and signed receipts when available.", kind: "planned" },
  { text: "Block PII to unapproved models.", kind: "planned" },
  { text: "Hash-link each event.", kind: "planned" },
];
