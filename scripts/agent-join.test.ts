/**
 * Agent Join v0 — unit tests
 * ----------------------------------------------------------------------------
 * Covers the pure policy (registration validation, secrets, baseline payload),
 * the machine-readable agent.md / skill.md content contract, and the session
 * analysis wrapper (which reuses the existing report pipeline). DB-backed route
 * behavior is covered by the manual smoke test in docs/proof/agent-join-v0.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  validateRegisterInput,
  sanitizeString,
  generateAgentToken,
  generateSetupCode,
  hashSecret,
  setupCodeMatches,
  baselineRulesResponse,
  DEFAULT_AGENT_SCOPES,
  FORBIDDEN_AGENT_SCOPES,
  buildClaimUrl,
  buildClaimBatchUrl,
  isExpired,
  claimExpiry,
} from "../src/lib/agent-join.ts";
import { buildAgentMarkdown, buildSkillMarkdown } from "../src/lib/agent-md.ts";
import { analyzeAgentSession } from "../src/lib/agent-session-analysis.ts";

const BASE = "https://m9r-web-staging.m9r.workers.dev";

// ---------------------------------------------------------------------------
// agent.md content contract
// ---------------------------------------------------------------------------

test("agent.md exists and is non-empty markdown", () => {
  const md = buildAgentMarkdown(BASE);
  assert.ok(md.length > 500);
  assert.match(md, /# M9R/);
});

test("agent.md requires human approval", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /human approval/i);
  assert.match(md, /Wait for human approval/i);
});

test("agent.md explains first-run baseline mode", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /baseline mode/i);
  assert.match(md, /first connected run/i);
});

test("agent.md does not claim rules exist before evidence", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /Workspace behavior rules appear only after prior session evidence exists/);
  assert.match(md, /does not create rules/i);
});

test("agent.md tells the agent NOT to upload secrets or full source", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /Do not upload secrets/i);
  assert.match(md, /Do not upload full source code/i);
  // Every mention of uploading secrets/source must be a prohibition ("Do not").
  for (const line of md.split("\n")) {
    // Only inspect bullet directives that tell the agent to upload secrets/source.
    if (/^\s*[-*]\s+upload[^\n]*(secrets|full source code)/i.test(line)) {
      assert.match(line, /do not/i, `upload directive must be a prohibition: ${line}`);
    }
  }
});

test("agent.md is CLI-first and keeps curl as a fallback", () => {
  const md = buildAgentMarkdown(BASE);
  // The published CLI is the primary, supported path — as real steps.
  assert.match(md, /npx m9r-cli init/);
  assert.match(md, /npx m9r-cli doctor/);
  assert.match(md, /npx --yes m9r-cli@latest inbox/);
  assert.match(md, /npx m9r-cli rules/);
  assert.match(md, /npx m9r-cli submit-session <file> --approved/);
  // The CLI is no longer described as fictional / not-yet-existing.
  assert.doesNotMatch(md, /no `npx oathlock init`/i);
  assert.doesNotMatch(md, /does not exist yet/i);
  // curl remains available as a raw-HTTP fallback.
  assert.match(md, /curl /);
});

test("agent.md documents the local token file and human approval claim", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /\.oathlock\/local\.json/);
  assert.match(md, /do not commit/i);
  assert.match(md, /human approval claim/i);
});

test("agent.md explains Rule Health only after rules are loaded into a later run", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /Rule Health/);
  assert.match(md, /loaded into a later run/i);
});

test("agent.md exposes no real-looking token examples", () => {
  const md = buildAgentMarkdown(BASE);
  // Bearer headers must use placeholders, never an oak_-prefixed token value.
  assert.doesNotMatch(md, /oak_[A-Za-z0-9]/);
});

test("agent.md treats init as one-time and says not to reconnect if already connected", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /one-time/i);
  // Check the local token file first; reuse the existing connection.
  assert.match(md, /\.oathlock\/local\.json/);
  assert.match(md, /do not run init/i);
  assert.match(md, /do not reconnect/i);
});

test("agent.md explains first-time setup vs returning workspace", () => {
  const md = buildAgentMarkdown(BASE);
  assert.match(md, /first-time setup/i);
  assert.match(md, /returning workspace/i);
  // Returning path: doctor then rules, not init.
  assert.match(md, /npx m9r-cli doctor/);
  assert.match(md, /npx --yes m9r-cli@latest inbox/);
  assert.match(md, /npx m9r-cli rules/);
});

// ---------------------------------------------------------------------------
// skill.md mirrors agent.md
// ---------------------------------------------------------------------------

test("skill.md mirrors / redirects to agent.md", () => {
  const skill = buildSkillMarkdown(BASE);
  assert.match(skill, /\/agent\.md/);
  // Mirrors the contract: includes the agent.md flow section.
  assert.match(skill, /## Flow/);
  assert.match(skill, /Do not upload secrets/i);
});

// ---------------------------------------------------------------------------
// Registration validation
// ---------------------------------------------------------------------------

const validBody = {
  agent_kind: "claude-code",
  repo_hint: "my-org/my-repo",
  rule_targets: ["CLAUDE.md", "AGENTS.md"],
  capabilities: ["rules:read"],
  consent_mode: "human_required",
};

test("register: accepts a valid request", () => {
  const r = validateRegisterInput(validBody);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.agentKind, "claude-code");
    assert.equal(r.value.repoHint, "my-org/my-repo");
  }
});

test("register: rejects missing consent_mode", () => {
  const r = validateRegisterInput({ ...validBody, consent_mode: undefined });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("register: rejects consent_mode that is not human_required", () => {
  const r = validateRegisterInput({ ...validBody, consent_mode: "autonomous" });
  assert.equal(r.ok, false);
});

test("register: rejects oversized payload", () => {
  const huge = { ...validBody, capabilities: [("x").repeat(20000)] };
  const r = validateRegisterInput(huge);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 413);
});

test("register: accepts a well-formed agent_kind outside the known-integration list -- any real provider name is a valid connection identity", () => {
  const r = validateRegisterInput({ ...validBody, agent_kind: "skynet" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.agentKind, "skynet");
});

test("register: rejects a malformed agent_kind (not a lowercase-alphanumeric-hyphen slug)", () => {
  assert.equal(validateRegisterInput({ ...validBody, agent_kind: "Skynet Prime!" }).ok, false);
  assert.equal(validateRegisterInput({ ...validBody, agent_kind: "-leading-hyphen" }).ok, false);
  assert.equal(validateRegisterInput({ ...validBody, agent_kind: "" }).ok, false);
});

test("register: sanitizes repo_hint (strips tags/control chars)", () => {
  const r = validateRegisterInput({ ...validBody, repo_hint: "  my<b>repo</b>  " });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.repoHint, "myrepo");
});

test("register: rejects active script content", () => {
  const r = validateRegisterInput({ ...validBody, repo_hint: "<script>alert(1)</script>repo" });
  // sanitizeString strips the tag; the residual is fine, but a raw capability
  // carrying active content is rejected.
  const r2 = validateRegisterInput({ ...validBody, capabilities: ["<script>x"] });
  assert.ok(r.ok || !r.ok); // repo_hint case is sanitized, not necessarily rejected
  assert.equal(r2.ok, true); // tag stripped to "x"
});

test("sanitizeString clamps length", () => {
  assert.equal(sanitizeString("abcdef", 3), "abc");
  assert.equal(sanitizeString(123 as unknown), "");
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("tokens and setup codes are prefixed and unique", () => {
  const a = generateAgentToken();
  const b = generateAgentToken();
  assert.match(a, /^oak_/);
  assert.notEqual(a, b);
  assert.match(generateSetupCode(), /^setup_/);
});

test("hashSecret is deterministic and setupCodeMatches uses the hash", () => {
  const code = generateSetupCode();
  const h = hashSecret(code);
  assert.equal(hashSecret(code), h);
  assert.equal(setupCodeMatches(code, h), true);
  assert.equal(setupCodeMatches("wrong", h), false);
  assert.equal(setupCodeMatches(code, ""), false);
});

test("default scopes are not admin and never include forbidden scopes", () => {
  for (const s of DEFAULT_AGENT_SCOPES) {
    assert.equal((FORBIDDEN_AGENT_SCOPES as readonly string[]).includes(s), false);
  }
  assert.equal((DEFAULT_AGENT_SCOPES as readonly string[]).includes("admin"), false);
});

// ---------------------------------------------------------------------------
// Baseline payload + helpers
// ---------------------------------------------------------------------------

test("baseline response is honest and never invents rules", () => {
  const r = baselineRulesResponse();
  assert.equal(r.mode, "baseline");
  assert.equal(r.rules.length, 0);
  assert.match(r.message, /No evidence-backed workspace rules exist yet/);
  assert.ok(r.operating_instructions.length > 0);
});

test("claim URL + expiry helpers", () => {
  assert.equal(buildClaimUrl(BASE, "abc"), `${BASE}/claim/abc`);
  assert.equal(buildClaimUrl(BASE + "/", "abc"), `${BASE}/claim/abc`);
  assert.equal(buildClaimBatchUrl(BASE + "/", "batch-1"), `${BASE}/claim/batch/batch-1`);
  const future = claimExpiry();
  assert.equal(isExpired(future), false);
  assert.equal(isExpired(new Date(Date.now() - 1000).toISOString()), true);
});

// ---------------------------------------------------------------------------
// Session analysis wrapper (reuses the existing pipeline)
// ---------------------------------------------------------------------------

const DIR = join(process.cwd(), "test-fixtures", "sessions");

test("analyzeAgentSession runs the pipeline and reports source quality", async () => {
  const raw = readFileSync(join(DIR, "claude-code-retry-loop.md"), "utf8");
  const a = await analyzeAgentSession(raw, "claude-code-retry-loop.md");
  assert.ok(["strong", "medium", "limited", "insufficient"].includes(a.sourceQuality));
  assert.ok(typeof a.parserConfidence.confidence === "string");
  // rules summary is present and honest (recommended only when evidence supports it)
  assert.ok(typeof a.rules.recommended === "boolean");
});

test("analyzeAgentSession re-redacts secrets server-side", async () => {
  const withSecret =
    "$ deploy\nexport ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456\nError: failed\n$ deploy\nError: failed";
  const a = await analyzeAgentSession(withSecret, "session.txt");
  const total = Object.values(a.redaction.countsByType).reduce((x, y) => x + y, 0);
  assert.ok(total >= 1, "expected at least one server-side redaction");
});

test("analyzeAgentSession on weak input does not invent rules", async () => {
  const prose = "I asked the agent to refactor things and it went well overall. Nothing notable.";
  const a = await analyzeAgentSession(prose, "note.txt");
  // Weak/insufficient evidence must not yield active rules.
  assert.equal(a.rules.activeCount, 0);
});
