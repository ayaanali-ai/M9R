// Unit tests for the chain-of-custody data model. Run with:
//   npm run test
// (node's built-in runner + the @/ alias loader; no extra deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAMPLE_CHAIN,
  PROOF_LEVELS,
  SAMPLE_EVIDENCE_LEVEL,
  MISSING_EVIDENCE,
  summarizeChain,
  getBlackboxFindings,
} from "@/lib/chain-of-custody";
import { SAMPLE_REPORT } from "@/lib/sample-report";
import {
  FULL_CHAIN_DEMO,
  FULL_CHAIN_DEMO_CHAIN,
  FULL_CHAIN_DEMO_EVENTS,
  FULL_CHAIN_DEMO_FINDINGS,
  FULL_CHAIN_DEMO_PROOF_LEVELS,
  FULL_CHAIN_DEMO_HONESTY_NOTICE,
  FULL_CHAIN_DEMO_EVIDENCE_LEVEL,
} from "@/lib/full-chain-demo";

test("chain has all eleven custody links in order", () => {
  const ids = SAMPLE_CHAIN.map((n) => n.id);
  assert.deepEqual(ids, [
    "human", "agent", "identity", "credential", "model",
    "tool", "data", "action", "cost", "policy", "proof",
  ]);
});

test("summary reports a partial (not full) reconstruction", () => {
  const s = summarizeChain(SAMPLE_CHAIN);
  assert.equal(s.total, 11);
  assert.ok(s.reconstructed > 0, "some links reconstructed");
  assert.ok(s.reconstructed < s.total, "not a full chain — stays honest");
  assert.equal(s.confirmed + s.inferred + s.missing + s.planned + s.notPresent, s.total);
});

test("cost is the only confirmed link; model is not present", () => {
  const byId = Object.fromEntries(SAMPLE_CHAIN.map((n) => [n.id, n.status]));
  assert.equal(byId.cost, "confirmed");
  assert.equal(byId.model, "not_present");
  assert.equal(byId.human, "missing");
  assert.equal(byId.policy, "planned");
});

test("evidence tops out at correlated logs — no signed/attested claims", () => {
  const reached = PROOF_LEVELS.filter((l) => l.reached).map((l) => l.level);
  assert.deepEqual(reached, [0, 1, 2]);
  assert.equal(Math.max(...reached), SAMPLE_EVIDENCE_LEVEL);
  assert.equal(PROOF_LEVELS.find((l) => l.level === 4)?.reached, false); // signed receipt
  assert.equal(PROOF_LEVELS.find((l) => l.level === 5)?.reached, false); // attestation
});

test("findings: live detector keeps real cost; planned detectors claim no cost", () => {
  const findings = getBlackboxFindings();
  const live = findings.filter((f) => f.status === "live");
  const planned = findings.filter((f) => f.status === "planned");
  assert.ok(live.length >= 1);
  assert.equal(live[0].costImpactUsd, SAMPLE_REPORT.wastedCostUsd);
  for (const p of planned) {
    assert.equal(p.costImpactUsd, null, `${p.detector} must not claim cost`);
    assert.equal(p.confidence, "n/a");
  }
});

test("missing-evidence panel enumerates the credibility gaps", () => {
  assert.ok(MISSING_EVIDENCE.length >= 5);
  const labels = MISSING_EVIDENCE.map((m) => m.label.toLowerCase()).join(" ");
  assert.ok(labels.includes("operator"));
  assert.ok(labels.includes("credential"));
  assert.ok(labels.includes("attestation"));
});

test("full-chain demo is explicitly synthetic and points to the canonical evidence sample", () => {
  assert.equal(FULL_CHAIN_DEMO.title, "M9R Full Chain Demo");
  assert.equal(
    FULL_CHAIN_DEMO.subtitle,
    "Synthetic demonstration of a complete autonomous AI action chain.",
  );
  assert.equal(
    FULL_CHAIN_DEMO_HONESTY_NOTICE,
    "This is a synthetic demo showing the full M9R data model. The canonical sample report uses current detector evidence and remains at /analyze.",
  );
  assert.equal(FULL_CHAIN_DEMO.synthetic, true);
  assert.equal(FULL_CHAIN_DEMO.canonicalEvidenceRoute, "/analyze");
});

test("full-chain demo has all eleven custody links and remains L2 only", () => {
  assert.deepEqual(
    FULL_CHAIN_DEMO_CHAIN.map((n) => n.id),
    [
      "human", "agent", "identity", "credential", "model",
      "tool", "data", "action", "cost", "policy", "proof",
    ],
  );
  assert.ok(FULL_CHAIN_DEMO_CHAIN.every((n) => n.status === "confirmed" || n.status === "violation"));
  const reached = FULL_CHAIN_DEMO_PROOF_LEVELS.filter((l) => l.reached).map((l) => l.level);
  assert.deepEqual(reached, [0, 1, 2]);
  assert.equal(Math.max(...reached), FULL_CHAIN_DEMO_EVIDENCE_LEVEL);
  assert.equal(FULL_CHAIN_DEMO_PROOF_LEVELS.find((l) => l.level === 4)?.reached, false);
  assert.equal(FULL_CHAIN_DEMO_PROOF_LEVELS.find((l) => l.level === 5)?.reached, false);
});

test("full-chain demo ledger and findings cover the requested synthetic scenario", () => {
  assert.deepEqual(
    FULL_CHAIN_DEMO_EVENTS.map((event) => event.type),
    [
      "task.created",
      "agent.started",
      "credential.used",
      "tool.google_drive.read",
      "model.request",
      "model.response",
      "data.touched",
      "tool.crm.update",
      "policy.evaluate",
      "report.generated",
    ],
  );
  assert.ok(FULL_CHAIN_DEMO_EVENTS.every((event) => event.hash.startsWith("demo_evt_")));
  const titles = FULL_CHAIN_DEMO_FINDINGS.map((finding) => finding.title).join(" | ");
  assert.match(titles, /Shared credential used by AI agent/);
  assert.match(titles, /Sensitive customer data touched/);
  assert.match(titles, /CRM write action without approval record/);
  assert.match(titles, /Model receipt weak \/ unsigned/);
  assert.match(titles, /Cost attributed to task and agent/);
});
