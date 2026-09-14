/**
 * agent.md / skill.md content (M9R Agent Join v0)
 * ----------------------------------------------------------------------------
 * The machine-readable onboarding document an AI coding agent reads when a human
 * says: "Read <the live deployment>/agent.md and follow the instructions
 * to connect this repo to M9R."
 *
 * This is instructions, not marketing copy. It is exported as a string so the
 * /agent.md route can serve it as text/markdown and tests can assert its
 * content (human-approval requirement, baseline first-run explanation, no
 * "rules exist before evidence" claims, no "upload secrets/source" guidance).
 *
 * `baseUrl` is injected so the curl examples point at the live deployment.
 */

export function buildAgentMarkdown(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `# M9R — Agent Join (machine-readable)

You are an AI coding agent connecting a repository/workspace to M9R.

M9R is **human-owned, agent-operated**. Follow these instructions exactly.

First run creates evidence. Future runs get rules.

## Rules (do not violate)

- Do not upload secrets, credentials, API keys, or tokens.
- Do not upload full source code by default.
- Do not submit any session content without explicit human approval.
- Do not create persistent workspace rules without M9R evidence.
- The first connected run is usually **baseline mode** (no rules yet).
- A claim URL only proves human ownership/approval. It does not create rules.
- Workspace behavior rules appear only after prior session evidence exists.

## Quick start (CLI)

The published \`m9r-cli\` CLI is the primary, supported way to connect. Run it
with \`npx\` from the repo you want to connect — no install required.

\`init\` is a **one-time setup step**. Do not reconnect every session — if this
workspace is already connected, reuse the existing connection.

**First, check whether the workspace is already connected:**

1. Check whether \`.oathlock/local.json\` exists in the repo.
2. **If it exists**, run \`npx m9r-cli doctor\`.
   - If doctor passes, the workspace is already connected — **do not run init**.
     Pull dashboard instructions with \`npx --yes m9r-cli@latest inbox\`, then
     run \`npx m9r-cli rules\`.
   - If doctor fails (no token / unauthorized), run \`npx m9r-cli init\` to
     reconnect.
3. **If \`.oathlock/local.json\` does not exist**, this is first-time setup — run
   \`npx m9r-cli init\`.

\`\`\`bash
# First-time setup (no .oathlock/local.json yet):
npx m9r-cli init                                  # connect this workspace (one-time)

# Connect multiple installed provider CLIs from one shell:
npx m9r-cli connect --agents claude-code,codex,opencode  # one approval page, one claim per provider

# Every agent run (returning workspace — already connected):
npx m9r-cli doctor                                # verify setup + API reachability
npx m9r-cli run start --task "Fix the build"      # makes this run visible in the dashboard
npx --yes m9r-cli@latest inbox                    # pull instructions with the CLI
npx m9r-cli rules                                 # fetch active workspace rules
# Plan your work USING the loaded rules, then do the work, reporting phases:
npx m9r-cli run status --phase "editing files"
npx m9r-cli run status --phase "waiting for human approval"
# After the work, only with human review + redaction:
npx m9r-cli submit-session <file> --approved

# After a later run (Run B) that loaded a promoted rule:
npx m9r-cli compare --baseline-run <run-a-id> --later-run <run-b-id>
\`\`\`

\`compare\` prints a conservative two-run report. It evaluates **evidence, not
vibes**: token/cost is compared only when both runs recorded usage metadata,
output quality is reported only from objective signals (tests, build, lint,
acceptance criteria, or human review), and Rule Health says whether a specific
loaded rule **held**, was **violated**, or **could not be judged** — never that a
rule "worked".

\`run start\` / \`run status\` send **status telemetry only** (phase, rules-loaded
count) so the human can watch the run in the M9R dashboard. They never
upload source code, tokens, or secrets. The dashboard shows: connected → started
task → current phase → waiting for human approval → session submitted → analysis
completed.

What the commands do:

- \`npx m9r-cli init\` opens a **human approval claim**: it prints (and tries to
  open) a claim URL the repo owner must approve in their browser, then waits for
  approval before saving a scoped token. If the workspace is already connected,
  \`init\` does nothing and points you to \`doctor\`/\`rules\` — pass \`--force\` only
  to deliberately start a brand-new claim.
- \`npx m9r-cli connect --agents <kind,kind,...>\` groups new provider claims
  into one approval page. The page is one human decision, while each provider
  still receives a separate scoped token and polls its own setup code.
- On approval the token is written **once** to \`.oathlock/local.json\` in the
  workspace. This file holds your local token — **do not commit it**. Add
  \`.oathlock/\` to \`.gitignore\` (the CLI never prints the full token, only a
  masked preview).
- \`npx m9r-cli doctor\` confirms the token is present and the API is reachable.
- \`npx m9r-cli rules\` fetches the active rules. On the **first run there are
  usually no rules yet (baseline mode)** — that is expected. Tell the human:
  "No evidence-backed rules exist yet. This run will create the first baseline."
- \`npx m9r-cli submit-session <file> --approved\` submits an approved, redacted
  session. It **refuses to send anything without \`--approved\`**, so only run it
  after a human has reviewed and redacted the session file.

### Rule Health

Rule Health (followed / violated / needs-review per rule) is only evaluated once
rules were **loaded into a later run** — i.e. after a baseline session has created
rules, a future run fetches them with \`npx m9r-cli rules\` and submits a session
while they are loaded. The baseline run itself has no rules to score yet.

## Flow

1. Identify the repo/workspace name.
2. Detect your agent kind if possible. If uncertain, connect explicitly: \`npx m9r-cli init --agent-kind codex\` or \`npx m9r-cli init --agent-kind claude-code\`. The provider name is any lowercase slug for the connected agent (for example \`codex\`, \`claude-code\`, \`cursor\`, \`opencode\`, or \`gemini-cli\`).
3. Check for existing rule targets in the repo:
   - \`CLAUDE.md\`
   - \`AGENTS.md\`
   - \`.cursor/rules\`
4. Check whether \`.oathlock/local.json\` already exists.
   - If it exists, run \`npx m9r-cli doctor\`. If it passes, the workspace is
     already connected — **skip init** and continue at step 8.
   - If it does not exist (or doctor fails), continue to step 5 to connect.
5. Run \`npx m9r-cli init\` to request a claim and connect (one-time setup).
6. Give the claim URL to the human and ask them to open and approve it.
7. Wait for human approval — \`init\` polls until the human approves. The scoped
   token is saved once to \`.oathlock/local.json\` (do not commit it).
8. Run \`npx m9r-cli run start --task "<short task title>"\` so the human can see
   this run in their dashboard. (Telemetry only — never source or secrets.)
9. Run \`npx m9r-cli rules\` to fetch active rules.
10. If no rules exist, tell the human:
    "No evidence-backed rules exist yet. This run will create the first baseline."
11. Do the work the human asked for, reporting phases with
    \`npx m9r-cli run status --phase "..."\` (e.g. reading files, editing files,
    waiting for human approval).
12. Ask the human before submitting the session, and have them redact it.
13. Run \`npx m9r-cli submit-session <file> --approved\` to submit the evidence.
    This links the session to the run and marks it completed.
14. Report the M9R result back to the human.

## What happens to recommendations

- Rules generated from your session are stored as **recommended** — they are
  NOT active until a human promotes them in the dashboard. M9R never
  auto-promotes a rule.
- Once promoted, an active rule is returned by \`npx m9r-cli rules\` on the next
  run, and its \`rules_loaded_count\` is reported to the dashboard.
- **Rule Health** (followed / violated / not_applicable / …) is only evaluated
  when a LATER run loads that active rule and submits evidence. The baseline run
  has nothing to score yet.
- M9R evaluates evidence; it does not guarantee improvement and never claims
  a rule "worked".

## API (raw HTTP fallback)

The CLI above is the supported path. If you cannot run \`npx\`, the same flow is
available as raw HTTP with curl. (\`<TOKEN>\` and \`<SETUP_CODE>\` are placeholders —
never paste a real token.)

### 1. Register (request a claim)

\`\`\`bash
curl -sS -X POST ${base}/api/agent/register \\
  -H 'content-type: application/json' \\
  -d '{
    "agent_kind": "claude-code",
    "repo_hint": "my-org/my-repo",
    "rule_targets": ["CLAUDE.md", "AGENTS.md", ".cursor/rules"],
    "capabilities": ["rules:read", "session:submit", "instructions:read"],
    "consent_mode": "human_required"
  }'
\`\`\`

Response contains \`claim_url\`, \`claim_id\`, \`setup_code\`, and \`expires_at\`.
The \`setup_code\` is **secret** — keep it; you need it to poll status and
retrieve your token. Give only the \`claim_url\` to the human.

### 2. Poll claim status (after the human approves)

\`\`\`bash
curl -sS '${base}/api/agent/claim-status?claim_id=CLAIM_ID&setup_code=<SETUP_CODE>'
\`\`\`

- \`{"status":"pending"}\` — keep waiting.
- \`{"status":"approved", ...}\` — the response carries the scoped token and
  scopes. The raw token is returned **once**; subsequent polls will not return it
  again. Store it like the CLI does — in \`.oathlock/local.json\`, never committed.
- \`{"status":"rejected"}\` or \`{"status":"expired"}\` — request a new claim.

### 3. Fetch active rules

\`\`\`bash
curl -sS ${base}/api/agent/rules -H 'authorization: Bearer <TOKEN>'
\`\`\`

If the workspace has no evidence-backed rules yet, you get:

\`\`\`json
{ "mode": "baseline", "message": "No evidence-backed workspace rules exist yet. ...", "rules": [] }
\`\`\`

The response may also include M9R **operating instructions** (e.g. "do not
upload secrets"). These are operating guidance, not workspace behavior rules.

### 4. Submit an approved, redacted session (after the work)

\`\`\`bash
curl -sS -X POST ${base}/api/agent/session \\
  -H 'authorization: Bearer <TOKEN>' \\
  -H 'content-type: application/json' \\
  -d '{
    "agent_kind": "claude-code",
    "session_format": "markdown",
    "redaction_status": "redacted",
    "human_approved_submission": true,
    "session_text": "<approved, redacted session text>",
    "rules_loaded": []
  }'
\`\`\`

\`human_approved_submission\` must be \`true\`, or the request is rejected.
The response reports source quality, parser confidence, findings, and any rules
generated from the evidence (or why none were).
`;
}

/** skill.md mirrors agent.md so skill.md-style onboarding resolves to the same contract. */
export function buildSkillMarkdown(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `# M9R — Skill onboarding

This skill mirrors M9R's agent onboarding contract.

The full, canonical machine-readable instructions live at:

  ${base}/agent.md

Read ${base}/agent.md and follow it to connect this repo to M9R. The flow
is human-owned and agent-operated: request a claim, have the human approve it,
store a scoped token, fetch rules (baseline on the first run), then submit an
approved, redacted session as evidence after the work.

${buildAgentMarkdown(baseUrl)}
`;
}
