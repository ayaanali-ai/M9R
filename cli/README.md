# M9R CLI

Connect a workspace to M9R, pull dashboard instructions, fetch
evidence-backed workspace rules, and submit an approved/redacted coding-agent
session so M9R can evaluate **Rule Health**.

The CLI is a thin client over the M9R Agent Join API. It is **human-owned and
agent-operated**: it never connects without human approval and never submits a
session without an explicit `--approved` flag.

## Quick start

No install required — run it straight from npm with `npx`. `init` is a **one-time
setup step**, so there are two paths:

**First-time setup** (no `.oathlock/local.json` yet):

```bash
npx m9r-cli init                                  # connect this workspace (human approves in browser)
```

**Every agent run** (already connected — don't re-run `init`):

```bash
npx m9r-cli doctor                                # check local setup + API reachability
npx m9r-cli run start --task "Fix the build"      # makes the run visible in the dashboard
npx --yes m9r-cli@latest inbox                    # pull instructions with the CLI
npx m9r-cli rules                                 # fetch active workspace rules
# ...do the work, reporting phases as you go...
npx m9r-cli run status --phase "editing files"
npx m9r-cli run status --phase "waiting for human approval"
npx m9r-cli submit-session session.md --approved  # submit an approved, redacted session
npx m9r-cli submit-session session.md --approved --evidence-contract evidence.json
npx m9r-cli help
```

`run start` / `run status` make the agent visible in the user's M9R
dashboard. They send **status telemetry only** (phase, rules-loaded count) — never
source code, tokens, or secrets. The active run id is stored in
`.oathlock/run.json`; `inbox` reads the Agent inbox, `rules` reports
`rules_loaded_count`, and `submit-session` links the session to the run and marks
it completed.

If a workspace is already connected, `npx m9r-cli init` won't create a new claim —
it tells you the workspace is connected and points you to `doctor`/`rules`. Use
`npx m9r-cli init --force` only to deliberately start a brand-new connection.

To revoke this workspace's local agent connection and remove transient local
state:

```bash
npx --yes m9r-cli@latest disconnect
```

Requires Node.js >= 18.

## Commands

`m9r heartbeat` reports one authenticated linked-agent presence lease.

`m9r assignments` lists bounded assignments for the connected agent.

`m9r assignment accept <id>` or `reject <id>` records the agent's explicit decision.

`m9r assignment complete <id> --run <run-id> --evidence-record <evidence-id>` completes only with a run and evidence record owned by that connection.

### `init`

One-time setup. Registers this workspace and prints a claim URL. **A human repo
owner must approve the connection in the browser** — the CLI opens the URL for you
(best-effort) and then waits, polling until approval. On approval it writes a
scoped token to `.oathlock/local.json` and non-secret metadata to
`.oathlock/config.json`.

If `.oathlock/local.json` already has a token, `init` treats the workspace as
**already connected**: it does not create a new claim, never prints the token, and
points you to `doctor`/`rules` instead. A returning workspace should run `doctor`,
then `inbox` if the dashboard sent an instruction, then `rules` — not `init`.

```bash
npx m9r-cli init                                              # first-time setup
npx m9r-cli init --force                                      # force a new claim even if connected
npx m9r-cli init --repo my-service --agent-kind codex         # connect Codex explicitly
npx m9r-cli init --repo my-service --agent-kind claude-code   # connect Claude Code explicitly
```

If the claim is rejected, expires, or times out, `init` exits non-zero — just run
it again.

After approval, `init` automatically installs the **automatic M9R workflow**
into the repo instruction file the connected agent already reads (see
`bootstrap`). Skip that with `--skip-bootstrap`.

```bash
npx --yes m9r-cli@latest init --force --agent-kind codex         # connect Codex
npx --yes m9r-cli@latest init --force --agent-kind claude-code   # connect Claude Code
```

### `bootstrap`

Installs a managed instruction block so the **connected agent uses M9R during
normal repo tasks** — you don't have to repeat setup instructions in every
prompt. The block tells the agent to verify the connection (`doctor`), load
rules, start or attach to a controlled run, check the inbox, prepare a redacted
`M9R Evidence Draft`, and set the run to waiting for human review. The
draft includes the actual verification commands and results, changed files,
limitations, and a sensitive-data check. It never contains tokens or local config.

The approved connection's stored agent kind is authoritative — a conflicting
`--agent-kind` fails instead of changing attribution.

| Agent kind | Integration file | Automatic loading |
| --- | --- | --- |
| `codex` | `AGENTS.md` | yes |
| `claude-code` | `CLAUDE.md` | yes |
| `grok-build` | `AGENTS.md` | yes |
| `other` | `M9R.md` | **not assured** — manual integration |

```bash
npx --yes m9r-cli@latest bootstrap --agent-kind codex   # manual install/update
npx --yes m9r-cli@latest bootstrap status               # installed / missing / outdated
npx --yes m9r-cli@latest bootstrap remove               # remove only the managed block
```

`bootstrap` is idempotent: it updates its own managed block in place, never
duplicates it, and preserves user-authored content around it byte-for-byte.

For every governed task, the agent displays the structured evidence draft in its
final response automatically. A human reviews and approves that exact draft.
Only after approval may the agent create an untracked temporary file and run
`submit-session <file> --approved`; M9R records the materially matching
draft at that point. The agent cannot approve or record its own draft.

**Honest limitation:** M9R does not intercept arbitrary external agent
sessions. Automatic behavior depends on the supported agent reading the
installed repo instructions (or a future runtime/MCP integration). Roadmap,
not implemented today: Phase 2 — M9R MCP tools for rules, run start, inbox,
evidence preparation, and status; Phase 3 — a deterministic agent launch
wrapper/runtime.

### `doctor`

Checks local setup and API reachability: confirms `.oathlock/local.json` and a
token are present, prints the API base, and verifies `/api/agent/rules` is
reachable and authorized. Exits non-zero if any check fails.

The browser multiplayer workspace is the supported public path. `doctor`,
`rules`, `inbox`, and `run start` do not promise a production terminal or
Mosaic-style local session persistence. The local runtime commands remain
available for explicit experiments and have separate release gates.

```bash
npx m9r-cli doctor
```

### `service`

Manages the experimental persistent login-startup registration for the local
M9R Runtime (Windows only today; macOS/Linux are not built yet). This command
is not part of the first public multiplayer capability promise and should not
be presented as a production terminal feature.

```bash
npx m9r-cli service install    # register M9R Runtime to start hidden at login (HKCU\...\Run\M9RRuntime)
npx m9r-cli service status     # check whether it's currently registered
npx m9r-cli service uninstall  # remove it
```

The runtime startup registration is retained for compatibility and explicit
testing. It is not required for browser multiplayer and remains outside the
initial public open-core announcement.

### `disconnect`

Revokes the current Bearer-token connection when the server can authenticate the
saved local token, then removes local volatile files:
`.oathlock/local.json`, `.oathlock/run.json`, and `.oathlock/rules.json`.

If there is no local token, it exits non-zero with:

```text
No local M9R connection found.
```

The command never prints the token. It reports server and local cleanup
separately:

```text
server disconnected: yes
local token removed: yes
run cache removed: yes
rules cache removed: yes
```

If server revocation fails, it prints `server disconnected: no` plus a redacted
error message. It does not claim server disconnection unless the server call
succeeds.

```bash
npx --yes m9r-cli@latest disconnect
```

### `run start` / `run status`

Make the agent visible in the user's M9R dashboard. `run start` begins a run
(optionally `--task "title"`) and stores the active run id in `.oathlock/run.json`.
`run status --phase "..."` reports the current phase. Both require a local token;
`run status` requires an active run. Telemetry only — never source or secrets.

```bash
npx m9r-cli run start --task "Fix the build"
npx m9r-cli run status --phase "reading files"
npx m9r-cli run status --phase "editing files"
npx m9r-cli run status --phase "waiting for human approval"
npx m9r-cli run status --phase "completed"
```

### `inbox`

Pull instructions with the CLI. The dashboard instruction channel queues short
instructions for the connected agent, and the agent retrieves them from its
Agent inbox.

```bash
npx --yes m9r-cli@latest inbox
```

### `rules`

Fetches the active workspace rules using the saved token, prints the mode,
operating instructions, and rule titles, and saves the full response to
`.oathlock/rules.json`. Run this **before** `submit-session` so the loaded rules
can be sent for evaluation. When a run is active, `rules` also reports
`rules_loaded_count` to the dashboard.

Rules generated from a session start as **recommended** and only become active —
and thus returned here — after a human **promotes** them in the dashboard.
M9R never auto-promotes. **Rule Health** is evaluated only when a later run
loads an active rule and submits evidence.

```bash
npx m9r-cli rules
```

### `compare` / `proof`

Prints a conservative two-run report (Run A vs Run B). **Evidence, not vibes:**

- Token/cost is compared **only when both runs recorded usage metadata** —
  otherwise it prints "Usage comparison unavailable…".
- Output quality is reported **only from objective signals** (build result, test
  result, lint result, acceptance criteria, or human approval) — otherwise it
  prints that those signals are required, plus a short "How to make this
  measurable" hint (include build/lint/test results and acceptance criteria in the
  redacted session; note whether the human accepted the final diff; never include
  secrets or full source code).
- **Rule Health** says whether a loaded rule **held**, was **violated**, or
  **could not be judged** — never that a rule "worked". No token/cost/quality gain
  is fabricated.

```bash
npx m9r-cli compare --baseline-run <run-a-id> --later-run <run-b-id>
```

### `submit-session <file> --approved`

Submits an approved, human-redacted session for Rule Health evaluation. The file
format is inferred from its extension: `.md` → markdown export, `.json` → JSON,
`.jsonl` → JSONL, `.txt`/`.log` → text log.

```bash
npx m9r-cli submit-session oathlock-session.md --approved
```

Pass `--evidence-contract <json>` to record a validated
`m9r.evidence.v1` contract with the approved session. When the server
stores it, the CLI prints the evidence contract id required by
`assignment complete --evidence-record`.

`submit-session` **refuses to send anything unless you pass `--approved`** — the
gate trips before the file is even read. The session is submitted as
`human_reviewed` / `human_approved_submission: true`. It also sends the rules
currently loaded in `.oathlock/rules.json` (printed only as a count, never their
contents) so the server can score them.

## Configuration

| Env var               | Default                       | Notes                                       |
| --------------------- | ----------------------------- | ------------------------------------------- |
| `OATHLOCK_API_URL`    | `https://m9r-dashboard.onrender.com` | Use `http://localhost:3000` for local dev   |
| `M9R_LOCAL_ONLY`      | unset | Internal runtime flag; prefer `m9r-cli terminal runtime --local-only` |
| `OATHLOCK_AGENT_KIND` | _none_                        | Fallback when `--agent-kind` is omitted     |

Agent kind is recorded on the approved connection and is used consistently in the Run Passport, Run Ledger, Approval Center, evidence attribution, and disconnect/revoke identity. Use `--agent-kind` for a new or forced claim; existing connections keep their historical identity.
| `OATHLOCK_REPO_HINT`  | current directory name        | Override the repo hint sent on `init`       |

`OATHLOCK_API_URL` controls which M9R instance every command talks to — set it
once in your shell to point the whole CLI at local dev or a staging deployment.

## Local files (created in your current workspace)

The CLI writes to a `.oathlock/` directory in the workspace you run it from:

| File                    | Contents                                | Commit?               |
| ----------------------- | --------------------------------------- | --------------------- |
| `.oathlock/local.json`  | **Secret** scoped token + scopes        | **No — gitignore it** |
| `.oathlock/rules.json`  | Last fetched rules response (transient)  | **No — gitignore it** |
| `.oathlock/run.json`    | Active run id (transient telemetry)      | **No — gitignore it** |
| `.oathlock/config.json` | Non-secret workspace metadata           | Optional              |

The simplest safe choice is to ignore the whole directory. Add to your
`.gitignore`:

```gitignore
.oathlock/
```

## Token safety

- The scoped token is written **once** to `.oathlock/local.json` (gitignore it).
- After saving, the full token is **never printed** — only a masked preview like
  `m9r_…a1b2`.
- Any token value is **redacted** from error output before it is shown.
- Session and rule contents are never printed; `submit-session` reports only a
  count of loaded rules.

## Human approval requirement

M9R is human-owned by design, and the CLI enforces that at two points:

1. **Connecting** — `init` cannot complete until a human repo owner approves the
   claim in the browser. The CLI only polls; it cannot self-approve.
2. **Submitting** — `submit-session` refuses to send a session unless a human
   passes `--approved` after reviewing and redacting it.

## Rule Health

When you submit a session, M9R evaluates your workspace rules against what the
session **actually shows** — observed evidence is the source of truth, not the
agent's self-report (the CLI sends empty `rules_followed`/`rules_violated`). The
result groups each rule into buckets such as `followed`, `violated`,
`needs_review`, `not_applicable`, `too_vague`, and `obsolete`, and
`submit-session` prints the non-empty buckets plus per-rule reasons. This is how
M9R tells you which rules are working, which are being ignored, and which have
gone stale.

## Publishing (maintainers)

`m9r-cli` is a live, published npm package — `npm view m9r-cli version` returns
the current release. This is the process for shipping a new version, not the
first one.

### Dry run

Verify exactly what would be published without sending anything to the registry.
The `prepack` hook rebuilds `dist/` first, so the tarball always reflects current
source:

```bash
cd cli
npm publish --dry-run
```

Confirm the file list contains only `dist/` and `README.md` (no `.oathlock/`,
`src/`, `scripts/`, or secrets).

### Before publishing a new version

- [ ] Bump `version` in `cli/package.json` (semver).
- [ ] `npm run lint`, `npm run build`, and `npm test` all pass from the repo root.
- [ ] `cd cli && npm publish --dry-run` shows only `dist/` and `README.md`.
- [ ] Confirm the `license` field is what you intend to publish under.
- [ ] `npm whoami` is the intended publisher.
- [ ] Publish: `cd cli && npm publish`.
## Resident provider process (experimental)

Run a connected provider as a foreground M9R resident:

```bash
m9r resident configure --provider codex --binding-id <binding-id> --profile codex-reviewer
m9r resident run --config .oathlock/resident.local.json
```

Use `--once` for one registration, heartbeat, and queue poll. The ignored
`resident.local.json` file contains the local M9R bearer token, provider,
opaque repository binding id, and absolute local repository root. The token and
absolute root remain local; never commit or share this file. Codex and Claude
Code authentication stays in their own local credential store or environment.

For a real long-running setup, generate a non-secret supervisor contract and
install it through your operating system's own service manager:

```bash
oathlock resident service-plan --profile codex-reviewer
```

The plan deliberately does not install or start a background process itself.
It specifies an `on-failure` restart policy and treats a resident as stale
after 90 seconds without a heartbeat. M9R only shows a resident as live
after its retained heartbeat; it never infers that a configured process is
awake.
