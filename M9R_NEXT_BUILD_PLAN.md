# M9R next build plan (v0.1, 2026-09-20, for owner approval)

Status: **plan only. Nothing below is built until approved.** Direction from the owner today: the local viewer page is dropped (removed from the code); the **web app is the viewer** until the overlay exists; the **overlay/notch comes first, before the Tauri installer**; give access now (waitlist waves) with the web app showing the new features. Baseline designs: `M9R_NATIVE_FRONT_DOOR_DESIGN.md` (signed off), `docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md` v2, `M9R_HOMEPAGE_REFERENCES.md`.

## 0. Where we actually are (checked 2026-09-20)
- **Built and tested:** N1 Claude side (hooks, local store, `m9r setup/uninstall/send`, doctor block, step list). 167 related tests pass; real-Claude acceptance 7 of 7. Local-only, no account.
- **Built earlier (Stage 1):** durable endpoints, `resolve/endpoints/ask/delivery` (agent-token API), derived delivery states, bridge ledger, restart recovery, Relay lease, Codex app-server adapter (live-proven), acceptance 12/12 through `app.m9r.workers.dev`.
- **Web app today:** shows channels and messages, agent strips with "Resume natively", live sessions, an Activity feed (file edits, permission requests, interrupts), approvals. It shows **nothing** about endpoints, fidelity labels, presence per endpoint, per-message delivery timelines, or native tasks: the endpoint and delivery APIs are agent-token only and no dashboard UI or session-authed route reads them.
- **Native tasks never reach the cloud.** They live in `~/.m9r/state.json` only.

## 1. W1: web wiring (what "the web does what it should" means)
Goal: a signed-in user sees, in the hosted dashboard, their agents and what they are doing with the new features, with honest labels.

**W1a. Session-authed API.** `GET /api/dashboard/endpoints` (handle, provider, presence, fidelity label, session generation, machine, last seen) and `GET /api/dashboard/messages/{id}/delivery` (derived timeline with evidence). Reuse `endpoint-service` and `delivery-service`, scoped to the user's workspace by session. Small, reversible, no schema change.

**W1b. Dashboard UI.** (1) An **Agents panel**: one row per endpoint with presence dot, the fidelity chip (`LIVE_NATIVE`, `QUEUED_NATIVE`, `NEXT_PROMPT`, `RESUMABLE_NATIVE`, `CONSULTATION`) and a one-line meaning on hover, generation, last seen, and the existing "Resume natively". (2) A **delivery timeline** on agent-directed messages: accepted, delivered to node, delivered to session, processing, completed or failed, with evidence and retry state. (3) **First-login onboarding card** driven by the shared step list, with live status (Claude connected, Codex hooks trusted, Desktop restarted). Visual design waits for Astra's site; build with the current components and keep it restyle-able.

**W1c. Native task mirror (needs a schema decision).** The Node pushes redacted events (agent connected, task created, delivered, approved, result) to `POST /api/agent/native/events`, batched, idempotent by `(device, event id)`, authenticated with the existing agent token. Stored in a new table `native_events` (workspace, device, seq, kind, task id, handle, short redacted text, time), service-role only, read through a dashboard route that also merges into the existing Activity feed. **Why a new table and not chat messages:** messages trigger mention dispatch, which could create loops. Sync runs from the always-on runtime (the existing login service), never from a hook (hooks must stay fast and silent); if the runtime is off, events queue locally and flush later.

**W1d. Machine token.** Hooks run in any folder, but today's connection token lives per repo (`.oathlock/agents/<kind>/local.json`). Native sync needs a per-machine token: `m9r connect` (existing, human-approved) also stores a machine credential in `~/.m9r/`. Nothing is uploaded until the user has connected.

**Personal scope (N4) is not needed for W1.** Every user already has a default workspace; W1 keeps it invisible. N4 is reserved for cross-user.

**Acceptance (PASS/FAIL):** connect a machine, use Claude and Codex normally, and the dashboard shows both agents with correct presence and fidelity, a delivery timeline for a `@codex` task, and the task, delivery and result in Activity; nothing appears for a machine that is not connected; no secret text appears in any synced event.

## 2. N2: Codex delivery (native queue)
`@codex` tasks are delivered with `codex queue --thread <id> --message ...` (proven on a terminal and the Desktop app). Needs: Codex hooks installed and trusted so each Codex session registers its thread id; a delivery step in the Node that queues only tasks that are `human_typed` or `approved` (**this approval check is the only gate, because a queued message is a real user prompt to Codex and bypasses the model's own distrust**); result capture from the rollout file (`task_complete` plus final message) into the caller's inbox; the delivery ledger and the states the web timeline shows; Windows quoting (already a known failure). Edge cases: Desktop thread paused, thread gone, several Codex sessions (ambiguity), duplicate queueing.
**Status (2026-09-20): built and proven against real Codex 0.153.4 by `npm run n2:acceptance`.** How it works: a typed `@codex` in Claude (or `m9r-cli send @codex`) creates a task; if `canQueue` (human typed, or approved) a detached runner calls `codex queue --thread <id>` with a `[M9R T#]` marker (Windows: runs `codex.js` with node, no shell, so no quoting problem); the thread id is the hook's `session_id` (same UUID as the rollout file name). A pushed task is not injected a second time from the inbox; a failed push falls back to the inbox. The answer is read from the tail of the thread's rollout file and shown once at the sender's next prompt. **Finding:** Codex can fold a queued prompt and the next prompt into one turn, so `task_complete` carries only the last answer; the reader takes the assistant message that follows the marker instead. `setup` now also installs the Codex hooks and standing block when `~/.codex` exists (user trusts them once with `/hooks`). **Not yet checked by script:** a live `codex resume` terminal and the Codex Desktop app (proven by hand on 2026-09-19); a busy thread mid-turn; several Codex sessions at once (N4).
**Acceptance:** with the web app closed, typing `@codex ...` in Claude runs in a plain `codex resume` terminal and in the Codex Desktop app (after Resume if paused), and the result reaches Claude's inbox; an unapproved agent-initiated task is never queued.

## 3. Overlay and notch (next after W1, before Tauri)
A small always-on-top window (a top-centre pill on Windows first; a Mac notch later) that pings when an agent is mentioned or a task needs approval, shows a live feed of what each agent is doing, and expands on click. **Passive by design: it never delivers anything or types into another app.** Data comes from the local store (file watcher, no network) and, when connected, approvals from the web. **Decisions needed:** shell (Electron is fastest for our Node stack; Tauri is smaller but adds Rust), how it starts (with the login service), and click behaviour (reveal detail, focus the agent's window). Distribution is unsigned for now (a Windows SmartScreen warning for others); the code-signing certificate is the one paid item and waits.
**Acceptance:** with the overlay running, a `@codex` mention in Claude shows a ping within about a second; expanding shows the task and its state; closing the overlay changes nothing about delivery.

## 4. The rest, in order (each with its dependency)
| # | Item | Size | Depends on |
|---|---|---|---|
| N3 | Collision guard: activity log, file locks, pre-tool deny (proven at about 20 ms on both providers); lock file the hook reads without the Node | M | N1 |
| N5 | Approvals: agent-initiated tasks wait for the user (overlay ping, `m9r approve`, web button), standing rules with expiry, protected actions always ask | M | N1, W1 for the web button |
| N5 status | **CLI side built and tested (2026-09-20):** `m9r-cli tasks`, `approve`, `deny`, `allow @from @to --for 2h` (at most one day), `standing`, `revoke`. Approving needs a person at a terminal with no agent markers (an agent shell has no terminal and carries `CLAUDECODE` or `CODEX_*`), so an agent cannot approve its own task. `m9r-cli send` run by an agent is agent-initiated and pending. Protected actions (delete, force-push, deploy or publish, secrets, payments, messages to other people) ignore standing rules. Pending approvals lapse after a day. Session card tells the agent how many wait. **Still open:** overlay ping and the web approve button (Codex's web work). | | |
| N4 | Personal-scope endpoints, several sessions per provider, ambiguity handling (cross-user prep) | M | W1 |
| N7a | OpenCode adapter (server attach, spike not yet run) | M | N2 pattern |
| N7b | Claude resumable turn (`claude --resume -p`, untested against an open session) | S | none |
| N8 | Multi-machine sync through the Relay | L | W1c |
| Web | `/docs/get-started` page and README from the shared step list | S | W1b |
| Web | Homepage (Astra) with waitlist, double opt-in emails | M | domain purchase |
| Ops | Publish CLI (0.6.15) with `setup`, `send`, `uninstall`; changelog | S | N1, owner runs `npm publish` |
| Ops | Supabase redirect URL for `app.m9r.workers.dev` (owner), custom domain, email sending (Cloudflare Email Sending or Resend fallback) | S | owner buys domain |
| Ops | Optional key rotation (Supabase service role, Resend, lead webhook) | S | owner |
| Legal | Counsel: Apache-2.0 split for the local layer, provider-terms read, trademark check | n/a | owner |
| Stage 0 | Remaining reliability items (mention gating decision, loop counter, atomic revoke, replayed old mentions, Stop button proof, banner and menu bugs) | L | ongoing |
| Hygiene | 16 pre-existing TypeScript errors now visible (see section 6); two pre-existing test failures (`cli-package` Windows temp cleanup, homepage structure test tied to uncommitted homepage edits) | S | none |

## 5. Suggested order
1. **W1a, W1b** (read-only web views; no schema change) so people invited now see something real.
2. **W1c and W1d** (sync and machine token) with its schema decision.
3. **N2** (Codex delivery) so the demo's first half works with the web app closed.
4. **Overlay** (passive first), then **N3** and **N5**.
5. Then N7a and N7b, docs and homepage integration, N4, N8.
Reason: the web views cost the least and are needed for any invitation to make sense; N2 is the demo; the overlay makes the invisible layer visible without becoming a workspace.

## 6. Notes on quality
- **TypeScript check was masked until today.** `tsc` stopped at a syntax error in a generated `.next` file (the known Next 16 validator bug), so earlier "clean" reports were not valid. The clean Cloudflare build patched that file and the checker now runs: 27 errors, 11 in code from Stage 1 and N1 (fixed today), 16 remaining and not from this work: `scripts/ui-button.test.ts` (3), `scripts/jev.test.ts` (2), `src/lib/conversation-service.ts` (1), `open-next.config.ts` (1), and the obsolete container wrappers `services/mission-{bridge,relay,worker}/src/worker-wrapper.ts` (about 9). Production builds skip type checking, so nothing shipped is affected; it should be cleaned before a release gate.
- **Deployed builds** use `scripts/build-cloudflare-clean.sh` (no secrets baked into the bundle).

## 7. Decisions needed from the owner
1. Approve W1a and W1b as the first build (read-only, no schema change)?
2. W1c: a new `native_events` table (recommended) versus mirroring into chat messages (not recommended: loop risk)?
3. Machine token: OK that `m9r connect` also stores a per-machine credential in `~/.m9r/`?
4. Overlay shell: Electron first (fast) or Tauri from the start?
5. Sync from the runtime service (recommended) or also from hooks?
6. Should the CLI be published (0.6.15) before or after W1?

## 8. Addition (2026-09-20, after comparing our shared context with Mosaic): C1, shared context that agents actually use
**Finding.** Storage matches the approach Mosaic's demo used (our own build notes: "a plain per-person, per-project transcripts directory plus a skill that greps it"): capture hooks save every finished session, redacted, and export it as markdown into `.oathlock/memory/` (109 sessions, 4.5 MB on the owner's machine, newest from tonight). The **read side is weak**: files are raw full transcripts (largest 503 KB, about 125,000 tokens if read whole); nothing tells an agent to look (the workflow block in `CLAUDE.md`/`AGENTS.md` does not mention memory; `search_memory` exists only inside sessions with a channel connection); there is no index. Sharing across people goes through the cloud export and has not been verified end to end. The N1 session card had pointed at a non-existent `index.md`; fixed today (the card now mentions memory only when the folder exists).

**C1 scope (small to medium, mostly deterministic, no model calls, so no token cost):**
1. **Distilled session file** at capture time: goal (first prompt), files changed, commands and tests run, final message, and the outcome, written beside the raw transcript. Agents read these, not the transcripts.
2. **`index.md` generator** (regenerated on each drain): one line per recent session with the files it touched and a pointer to the distilled file. Small enough to read whole.
3. **Tell the agents when to look**: extend the standing-instruction block (versioned, re-consent on update) with "before working on a file or area, check `.oathlock/memory/index.md` for earlier sessions that touched it".
4. **Relevant-memory hint** in the `UserPromptSubmit` hook: match prompt words and file paths against the index locally and inject at most two one-line pointers, only on a match (zero tokens otherwise).
5. **Team sharing** rides on W1c/N8; not in C1.

**Acceptance (the Mosaic-style moment):** a Claude session changes `relay/lease.ts` and finishes; later a Codex session is asked about `lease.ts` and is pointed to the earlier session's one-line summary and reads its distilled file, then continues from it without re-deriving the work.

**Order.** C1 goes **before W1c/N2**: it is the part users will compare directly with Mosaic, it is deterministic, and it fixes something that is currently true only on paper (agents are not directed to the memory).
