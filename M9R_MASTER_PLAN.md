# M9R — Master Plan

**Status:** Living doc. Update this file whenever a thread starts, ships, or changes direction — this is what Codex/any agent should read to know what's actually left, not what was done but never marked here.
**Last updated:** 2026-09-14

---

## How to use this doc

- A line marked `[x]` is shipped and verified live (not just typechecked).
- A line marked `[~]` is partially done — the note says exactly what's missing.
- A line marked `[ ]` is not started.
- If you (human or agent) finish something, mark it here in the same session. If you're not sure whether something marked done still holds, say so — don't silently trust a stale checkmark either.

---

## 1. Product surface — active design/build threads

This is the part of the product currently being rebuilt from scratch, design-first, element by element, the same way the homepage was: real references first, explicit locked decisions per element, then build, then verify live, then move on. Never skip straight to code without locked references + decisions.

### 1.1 Homepage (`UseM9RHome.tsx`, worktree `.oathlock/worktrees/immersive-homepage`, branch `codex/immersive-homepage`)

- [x] Design locked and built: gray canvas (`#cdcdca`), `"@useM9R"` mark in blue (`#1d4ed8`, the only color on the page), BD85BD85-style expand-in-place nav, 3D-rotating OS install-command selector, hand-sketched underline, Caveat font for the mark only, Inter elsewhere, plain-text "Get Started," hand-written GitHub/X icons, minimal footer, blurred-glass signup/login sheet.
- [x] Committed on `codex/immersive-homepage` (`3336a9c`, `7fcc3dc`) — not lost anymore, but **not pushed and not merged into `main`**.
- [x] Install command fixed: was `npx m9r-cli init` (only connects one agent kind, never scans the machine), now `npx m9r-cli connect` (real command — detects every installed agent CLI on PATH via `detectInstalledAgents`, batch-registers them, one approval page binds them all to the approving human's workspace). Verified by reading `cmdInit`/`cmdConnect` in `src/lib/oathlock-cli-core.ts` directly, not assumed.
- [ ] **Real gap, not yet built**: the batch approval page (`src/app/claim/batch/[batchId]/page.tsx` + `ClaimBatchActions.tsx`) is approve-all-or-reject-all — there is no per-agent picker today. "Detects agents then lets you choose which to connect" is only half true right now (detection: yes; choosing a subset: no). Explicitly deferred, not silently oversold on the homepage.
- [ ] Per-OS drum commands: kept as label-only (same real `npx m9r-cli connect` command, only the OS name text changes) since the command is genuinely cross-platform via npx — there's nothing real to differentiate today. Would become legitimate to differ per-OS only if we build actual native installers (curl-based for macOS/Linux, a PowerShell one-liner for Windows) — that's new engineering, not a copy change, and hasn't been started.
- [ ] Not yet merged into `main` — still lives only on the `immersive-homepage` worktree/branch. Needs an explicit decision on when/how it lands on the real homepage route.
- [x] Dev server confirmed running on port 3107 (not 3125 as an earlier summary guessed) via `.claude/launch.json` in the worktree — `npm run dev -- -p 3107`.

**Architecture note (verified, not speculative):** a future Tauri desktop shell would not affect teammates using each other's connected agents. Workspace binding happens server-side at approval (`ClaimBatchActions.tsx`: "Approval binds them to a workspace you own") and everything downstream (rules, inbox, shared conversation memory) is scoped by Supabase workspace membership, not by which client issued the connection. Tauri would just be a nicer packaging for the same `connect` flow — the shared-workspace model doesn't care about the calling client's runtime.

### 1.2 Dashboard redesign (`ProductShell.tsx`, `ConversationPanel.tsx`, `globals.css`)

**Status: reset back to the pre-redesign baseline. Currently in the reference-gathering phase — no new dashboard chrome should be built until real references are found and locked, the same way the homepage was.**

History (for context, not to be repeated):
- A first attempt (gray-canvas token overrides, right-edge icon dock, composer restyle) was built directly without reference-grounding and explicitly rejected as "ass work" — reverted.
- A second attempt (full page-shell rebuild: hover/pin sidebar, big/bold Chrome-Hearts-style nav, in-place accordion for channels/agents, forced gray canvas site-wide) was also reverted — built after only a partial reference pass (3 sites, homepage only of each), still too rushed, still landed generic in the user's judgement.
- **What's staying from both attempts, already committed/kept:**
  - `EtheralShadow` (the wavy animated background effect) removed from `ConversationPanel.tsx` — kept.
  - `MetalSendButton` removed, replaced with a plain send button — kept.
  - Channel header no longer shows a `#` before the channel name — kept.
  - The right-edge text panel dock (Review / Whispers / Drafts / People / Live / Handoffs as plain text, not icon buttons) in `ConversationPanel.tsx` — kept, explicitly told to keep this one.
  - The workspace-invite active-project cookie fix, the People-panel inline invite form, the task-card change-request UI, Persona Part B tool guidance — all shipped in commit `cfb6ed6a`, unrelated to the visual reset, not touched by any revert.

**Reference set — locked 2026-09-14:**
- **Chrome Hearts** (chromehearts.com) — extreme restraint. Single cross-mark trigger expands a menu in place (pushes content down, doesn't overlay). Primary destinations render huge/bold; secondary items (login) tiny and muted underneath — real size hierarchy, not uniform rows. Clicking a parent item doesn't navigate, it dims to gray and reveals children indented below (true in-place accordion). Product pages: no cards, items float on one continuous photo/gradient scene; name bold caps, price/meta small muted gray beneath.
- **Jakub Jakubik** (jakubjakubik.com) — one hairline-bordered capsule holds the mark + flat text nav; active item gets a solid black-fill pill (the only "box" anywhere). Work grid uses plain gray numbers, no titles. Opening a work item scales it into a lightbox over a dimmed (still-visible) grid; "CLOSE" is plain text, no icon.
- **BD85BD85** (bd85bd85.com) — nav trigger is a solid-color pill; menu grows straight down from it, full-bleed rows with hairline dividers, zero icons, contact/social stacked at the bottom with a live local clock.
- **this.design** — cinematic full-bleed photography with pill-shaped tag chips floating over it; headlines mix bold sans with italic serif for emphasis words; horizontal-scroll case-study cards; plain back-arrow circle for sub-pages instead of breadcrumbs.
- **Linear** (linear.app) — real in-app screenshots, not mockups. Near-black layered surfaces; sidebar grouped under small muted uppercase section labels ("Workspace", "Favorites"); a live agent-collaboration thread in-product (human + "Linear" itself commenting, colored status dots, otherwise monochrome) — directly relevant since M9R is also multi-agent.
- **Warp** (warp.dev) — real terminal screenshots. Search bar built into the title bar; session-list sidebar with colored status dots; dense-but-clean bottom status bar as small monospace chips (branch, uncommitted-changes count, token count, elapsed time, shortcut hints); consistent chrome across provider tabs (Warp Agent/Claude Code/Codex/OpenCode) with only the content pane changing. Marketing pages use a "blueprint schematic" language (dotted grid bg, `[ fig. 1 ]` captions, `# comment`-style eyebrows, numbered `01–06` feature lists) — fits a dev tool better than fashion-portfolio softness.
- (thms.works and 099supply.com were also reviewed — dark-canvas and bento-grid variants respectively — but not added to the locked set: canvas stays light gray per the "one consistent tone everywhere" decision below, and 099supply.com was unreachable to verify live.)

**Locked decisions so far:**
- Canvas stays the same light gray (`#cdcdca`) everywhere — dashboard and terminal do **not** go dark just because they're "for coding at night." One consistent tone across the whole product, homepage included.
- Warp's dense monospace status-chip treatment (branch/tokens/elapsed-time chips, colored session dots) is **terminal-pane only**. The chat/dashboard area stays airy and restrained (Chrome Hearts/Jakub level), not that dense — two different information densities for two different jobs, not one density everywhere.

**Element 1 (page shell/nav) — decisions locked 2026-09-14, building now:**
- Trigger: bare M9R mark, no border/box (Chrome Hearts style), top-left. Click expands the sidebar in place, pushing content over (not overlay). Hover-peek + click-to-pin mechanics and the 240px/fully-hidden/click-outside-closes-peek sizing from the earlier (reverted) build are still valid technical decisions, not re-litigated — only the visual language was wrong before, not the interaction mechanics.
- Nav item sizing: uniform (Linear style) — not Chrome Hearts' huge/bold-vs-tiny contrast. Grouped under small muted uppercase section labels.
- Icons: icon + label per nav item (Linear style) — not icon-free.
- Channels/agents list under Chat: always visible, no accordion (Linear style).
- Workspace switcher: flattened to a plain text row (name + chevron-on-hover), no card/border/shading — consistent with the rest of the flat nav.

Next steps (in order — do not skip ahead):
- [x] References picked and locked (see reference set above).
- [x] Element 1 (page shell/nav) built per the locks above and verified live in the browser (2026-09-14): bare-mark push trigger, flattened workspace switcher confirmed borderless at rest via computed styles, uniform Linear-style nav sizing, always-visible channel/agent lists. Not yet explicitly confirmed by the user as final — surface it before treating as fully locked.
- [ ] Element 2: channel header — was partly touched already (no more `#`, right-edge text dock kept) but not run through the full reference-locked ask-first process yet. Do that properly before considering it done.
- [ ] Then message list, composer, panels, empty states, settings — same process, one at a time.
- [ ] Build in a fresh, dedicated CSS namespace per element (not `wf-*` / `dashboard-renovation.css` overrides) — the legacy stylesheet has selectors like `.wf-root[data-bs-mode="day"] .m9r-workspace` that silently beat same-or-lower-specificity overrides added later in file order. Confirmed twice this cost real time; don't re-fight it.
- [ ] **Color consistency is a hard requirement, not a nice-to-have** — audit every hardcoded hex/color the design touches against one locked palette before shipping any pass. The last two passes both shipped visible token/color mismatches (light "day" theme tokens fighting a dark "night" theme reality, a recolored sidebar next to an unrecolored message pane) that the user had to catch by screenshot. Before calling any element "done," diff its rendered colors against the locked palette, not just eyeball it once.

### 1.3 Terminal area (`TerminalPane.tsx`, `TerminalWorkspace.tsx`)

**Goal: as close to a literal, unmodified rendering of Herdr (herdr.dev / github.com/herdrdev/herdr) as this stack allows, recolored to the gray canvas palette.**

Verified facts (checked directly against Herdr's `Cargo.toml` via the GitHub API, not assumed):
- Herdr is a native Rust **TUI** — built on `ratatui` + `crossterm` + `portable-pty`, drawing directly to a real terminal via ANSI. It has **no GUI/webview code and no Tauri dependency anywhere** — "use Tauri to embed Herdr" was the wrong framing; Tauri wraps a webview, and Herdr has none to wrap.
- What's actually achievable: Herdr is a real, installable open-source binary. It can be run as a **real child process attached to a real PTY**, with its live terminal output streamed into our own xterm.js-based pane — that renders Herdr's actual, unmodified output (not a copy of its code) inside our chrome. ANSI palette remapping in xterm.js can shift its colors toward the gray canvas without touching Herdr's own source.
- If/when M9R ships a Tauri desktop shell, the same approach carries over natively (a Rust-side PTY driving the same xterm.js view, or a native terminal widget) — Tauri's Rust backend is what makes spawning/managing that PTY process straightforward cross-platform, not a way to "embed" Herdr's UI code.

Known real bug (found, not yet fixed):
- [ ] `TerminalPane.tsx:197-200` sets the xterm.js theme (`background`/`foreground` only, not the full ANSI 16-color palette) **once, at mount**, reading `--ol-surface-0`/`--ol-text-primary` at that instant. It never updates if the dashboard mode changes later, and CLI output using explicit ANSI colors can land invisible depending on timing/mode. Needs: (1) live theme updates on mode change, (2) a full ANSI palette definition, not just bg/fg, (3) live verification that text is actually legible in the running app, not just typecheck-clean.

Next steps:
- [ ] Decide and prototype the "run real Herdr as a child process, stream into xterm.js" path — confirm it's feasible in this repo's actual runtime (Node backend today; Rust/Tauri later) before committing to it as the plan.
- [ ] Fix the theme/visibility bug above regardless of which path is chosen — it's broken today independent of the Herdr-parity goal.
- [ ] Once the terminal pane is visually correct, do the same reference-locked, ask-first process as the dashboard before styling around it.

---

## 2. Backend / protocol gates (carried forward from `OATHLOCK_V2_MASTER_PLAN.md`, historical)

**⚠️ This section is ported forward from a doc last updated 2026-07-13 under the old "OathLock" name, from a commit (`98c09cff`, branch `codex/oathlock-v2-9plus-20260714`) that never made it into current `main`. None of the `[x]`/`[~]` marks below have been re-verified against the current codebase this pass — treat them as "reportedly true as of July," not "confirmed true now." Re-audit before relying on any specific line.**

### Gate 0 — Claim and capability inventory — reportedly complete (Jul 2026)
### Gate 1 — Identity, tenancy, and authoritative presence — reportedly complete (Jul 2026)
### Gate 2 — Versioned Work Signal protocol — reportedly complete; live push fan-out (Supabase Broadcast) and outbox retention/pruning explicitly deferred, not built
### Gate 3 — Linked-provider adapters — generic CLI/HTTP adapter contract reportedly done; Codex/Claude Code adapters exist but were **not proven** with a live, human-observed end-to-end session as of Jul 2026; Cursor/Devin/CI unverified, Devin unresearched
### Gate 4 — Live Agent Floor — live run list wired to real presence state reportedly done; reconnecting/quota visuals not backed by any real signal yet (correctly not faked); pixel floor + cross-navigation selection not built
### Gate 5 — Assignment and communication proof — dispatch/response/collision/assignment machinery reportedly built and unit-tested; **cross-vendor live proof still outstanding** as of Jul 2026
### Gate 6 — First resident execution path — **not started**. No isolated ephemeral execution, no secrets broker. All execution is linked (runs in the provider's own environment); OathLock/M9R has never run code itself.
### Gate 7 — Evidence and result integrity — reportedly complete for the structured Evidence Contract path; Finding/Passport attribution completeness flagged as needing a closer look
### Gate 8 — Cost and usage controls — reportedly met for OathLock-controlled coordination; explicitly no dollar-spend cap (provider billing telemetry not reliable enough to enforce one honestly)
### Gate 9 — Reliability, security, and scale — cross-tenant isolation real at schema/service level but no adversarial test suite proving it; one 100-request load sample exists, not enough for a durable SLO; reconnect-storm/adversarial testing unbuilt
### Gate 10 — Controlled pilot and demand proof — **not started**, correctly blocked on Gates 3/6/9

**Explicitly deferred (from the original doc, still presumably true):** public social features, hosting/replacing other providers, unbounded free-form agent chat, pixel animation not backed by real state, unmeasured savings/reliability claims.

---

## 3. Known real bugs / cleanup (not part of the design threads above)

- [ ] `TerminalPane.tsx` xterm theme bug — see 1.3 above.
- [ ] `team_tester1` test account (`tysonali989+team1@gmail.com`, user_id `6e53d2e8-ba8d-4117-8b4e-06f1f4697e71`) and its membership row in the real "M9R Workspace" (`d849f970-ad4c-4b47-ad34-7f6747e8b98a`) still exist in the live Supabase database — asked once whether to clean up, never explicitly answered. Still there.
- [x] **Fixed 2026-09-15 — multi-agent task-contract split was structurally impossible.** Real failure, caught live: `@codex and @opencode <request>` auto-created a `task_contracts` row (`status: "decomposing"`, Codex assigned as decomposer, confirmed directly in the DB) and told Codex to split the work — but no MCP tool existed to submit that split. `POST /api/bridge/task-contracts` (create the split) and `PATCH /api/bridge/task-contracts/[itemId]` (report an item done/failed) were both fully built, authenticated, and correctly scoped — just never wired to a tool. Codex correctly refused to fabricate work and reported itself blocked; opencode correctly stayed idle. The contract sat at 0 items forever (the one live instance of this, id `532322af-4a8a-4ec0-9098-d232c5579d06`, has been marked `failed` in the DB so it stops showing "Splitting up the work" forever in the channel).
  - Added 3 MCP tools to `dev-mcp-server.ts`: `submit_task_split`, `update_task_item_status`, `list_my_task_items`.
  - Updated the dispatch notice (`task-contract-service.ts`) to actually include the item's id and tell the assigned agent which tool to call — it previously told an agent what to do but never how to report back.
  - Updated `scripts/dev-mcp-server.test.ts`'s tool-inventory test (it lists every tool name and would have caught this immediately if it had existed for task-contracts) and added 4 new integration tests for the 3 new tools. 24/24 passing.
  - **The systemic lesson, not just this one bug**: this was a fully-built backend capability with zero agent-facing tool wired to it — a half-shipped-feature pattern, not CLI/connection flakiness. Nothing currently checks that a capability an agent's own dispatch/system messages promise actually has a matching registered MCP tool. The tool-inventory test in `dev-mcp-server.test.ts` is the closest thing to a guardrail today (it force-fails on any unreviewed tool-list change) — worth treating "does every backend agent-capability route have a calling tool" as a standing question on every future feature in this area, not just this one.
