# M9R Source of Truth 6.0 — Universal surfaces, fluid tasks, and multiplayer

Status: implementation contract for the provider-neutral desktop runtime.

This is the repository's canonical Source of Truth 6.0. A tracked file named
“Master List 2.1” was not present in this checkout, so this document is the
safe, reviewable equivalent rather than silently creating or overwriting an
unknown file outside the repository. Source of Truth 5.0 remains the release
and installation contract; this document defines the task, surface, action,
and multiplayer behavior built on top of it.

## Non-negotiable invariants

1. The accepted pill/frontend and the canonical runtime are protected. No live
   install, pill rebuild, overlay replacement, or recovery-folder promotion is
   part of this work package.
2. Provider-neutral means no provider-specific workflow is hard-coded into the
   product. Provider adapters may expose capabilities, but intent, surface,
   leases, task state, and verification are shared contracts.
3. A task, a user control message, and an agent-to-agent message are distinct
   records. A new user message may continue, clarify, pause, resume, redirect,
   cancel, or create a new task; it must not accidentally destroy unrelated
   work.
4. Semantic/UIA/CDP routes are preferred. Screenshot and physical input are
   bounded fallbacks. No route may silently retarget a different tab, window,
   or app, and no route bypasses site security or anti-bot controls.
5. Normal teammate conversation is not throttled by a small arbitrary message
   quota. Loop protection is progress- and state-based. Storage, payload, and
   retention bounds remain mandatory safety limits.
6. Windows has one global physical keyboard/focus device. Independent agents
   may work concurrently through semantic/background routes or separate
   regions. Operations that truly require the global device acquire only a
   short exclusive-input lease; they do not block unrelated work.
7. Every mutation has a fresh observation, an exact target identity, a bounded
   lease, a postcondition, and an auditable receipt. Stale observations fail
   closed and request re-observation/rebase.

## Implementation order

### 1. Protect the baseline and the release boundary

- Keep the accepted pill/frontend untouched while the contracts are changed.
- Keep Source of Truth 5.0's single canonical install, atomic candidate
  staging, manifest verification, and source/build/runtime boundary.
- Build inputs are allowlisted source only; worktrees, recovery evidence,
  diagnostics, and excluded directories are never promoted by filename.
- Do not perform a live install until the acceptance gate in section 14 is
  green.

### 2. One unified surface model

Represent browser instances, tabs, frames, web elements, native windows,
documents, and system surfaces through the existing `ComputerUseTarget` plus
the multiplayer surface adapter catalog. A surface binding carries a stable
surface identity, target revision, adapter capability, and owner correlation.
Browser work is pinned to the explicit instance/tab/frame; it never silently
changes the user's current tab. Native work binds the actual foreground window
or an explicitly named background window.

### 3. Agent seats and observable presence

Each participant has a run/branch/agent identity, a stable label/color, a
surface binding, an action stream, and a session-owned cursor/presence record.
The existing presence and target-identity registries remain the source of
truth. A cursor is presentation state, not permission; permission comes from
the route and lease contracts.

### 4. Durable task contexts and explicit controls

Create a task context keyed by `taskId` and `conversationId`, with plan
revision, participants, assignments, artifacts, observations, pending user
decisions, progress witness, and state. The state machine supports active,
paused-owner, waiting-user, waiting-agent, replanning, completed, and canceled.

Classify incoming user controls as continuation, clarification, pause, resume,
redirect, cancel, or new-task. Pause preserves work and observations; resume
continues the same task; redirect creates a new plan revision while retaining
completed work; cancel fences only the requested scope; a new task gets a new
context. Unaffected participants continue unless their surface or lease is
explicitly affected.

### 5. Natural team rooms with structured sidecars

Use the existing A2A router for delivery, deduplication, expiry, and recipient
validation. Add a task-local room and a structured sidecar for assignment,
handoff, blocker, evidence, and verification events. The visible conversation
may remain natural and concise; the sidecar carries machine-readable state so
agents do not need to repeat large dumps. The room closes when the task is
complete or canceled.

### 6. User-directed or dynamic work allocation

If the user assigns roles, preserve those assignments exactly. If the user
does not, agents may propose and claim work based on current capability,
surface access, and observed progress. Claims are revisioned and idempotent;
two agents cannot silently own the same mutation. Provider strengths are
learned per user/team/task and never hard-coded globally (Codex is not always
“backend” and Claude is not always “design”).

### 7. Progress-based loop protection

Every meaningful agent handoff or action records a progress witness: changed
artifact, completed operation, new observation revision, verified postcondition,
or a concrete blocker. Repeating the same state without a new witness enters a
waiting/clarification state instead of sending another identical message. A
bounded history and payload limit still protect memory and transport, but do
not replace progress detection.

### 8. Universal intent and target resolution

Use `resolveUniversalIntent` as a planning hint, not a hard-coded app workflow.
Resolve “this form”, “that tab”, “the open document”, “turn on dictation”, or
“open Spotify” from the live foreground/visible surface and current structure.
For app launch, try a direct route, then Start/Search discovery, then a bounded
taskbar fallback. For a browser, select the exact tab by stable identity before
observing. If the request is genuinely ambiguous, ask one short question.

### 9. Dynamic action ladder and routing

For each action choose the fastest safe route available:

1. Browser/CDP or page-semantic route.
2. Native UI Automation/accessibility route.
3. Window-targeted background route when the adapter guarantees it is safe.
4. Fresh structure observation after every meaningful page/control mutation.
5. Bounded window-local screenshot coordinates when structure is unavailable.
6. Foreground physical input only with an owner-approved exclusive-input lease.

The route returns its effect, escalation, verification, and retry disposition.
It never silently falls back to foreground input after a background refusal.

### 10. Foreground/background coexistence and leases

Choose `background-semantic`, `visible-semantic`, or `exclusive-input` per
action, not once per task. Background agents continue while another agent
needs foreground. Shared reads and disjoint semantic regions may proceed in
parallel. Only the narrow global keyboard/focus/pointer operation is serialized
by an exclusive lease. Lease conflicts produce a wait/reobserve result, not a
blanket “M9R blocked because another agent is using input.”

### 11. Observation, mutation, and verification receipts

Every action binds an exact target revision, dispatches at most once for that
operation ID, and records a receipt. A stale HWND/tab/frame/element, changed
virtual desktop, or changed page revision triggers refresh/rebase. Postconditions
are checked with a fresh observation. Receipts distinguish claimed, committed,
aborted, stale, conflicted, and expired work.

### 12. Browser and desktop inspiration, adapted to M9R

- **Vercel Agent Browser:** persistent daemon/session ownership, named tab
  binding, interactive refs, snapshots/deltas, batching, output limits, and
  screenshot-if-changed. M9R adopts the bounded observation/target ideas but
  keeps the user's browser and does not claim isolated sandbox DOM access.
- **Vercel Agent Desktop:** accessibility-tree-first observation, stable refs,
  observe-act-observe, JSON action envelopes, and ref actions that do not move
  the real pointer unless required. M9R maps this to UIA plus its existing
  screenshot fallback.
- **Cua Driver:** exact target binding, background-first route selection,
  explicit effect/escalation/verified results, session-owned cursors, and
  per-session target state. M9R adopts the contracts without replacing its
  broker or reintroducing an extension architecture.
- **A2A/MCP:** discoverable capabilities, task lifecycle, messages, artifacts,
  cancellation, and structured tool boundaries. M9R keeps provider processes
  directly managed by the broker and uses these ideas at the coordination
  layer.

### 13. Workflow and network learning

After the driver is stable, record only bounded local preference signals:
no-submit/no-advance habits, preferred observation route, successful action
patterns, provider strengths, and team handoff outcomes. Never store prompts,
page text, secrets, credentials, or screenshots in workflow memory. Learning is
asynchronous and must not add a full resolver chain to every action.

### 14. Verification and live-promotion gate

Before any live build or pill/app installation:

- all CUA driver tests pass, including the 15 owner-preview failures;
- multiplayer contract, A2A, coordinator, scheduler, target identity, surface,
  presence, and dispatch-fence tests pass;
- universal intent and workflow-memory tests pass;
- TypeScript typecheck passes;
- browser dropdown/table, exact-tab, stale-target, and screenshot-fallback
  fixtures pass;
- pause/resume/redirect preserves unaffected agents;
- semantic/background work can continue while a separate operation owns
  exclusive input;
- candidate/source/build/runtime manifests and accepted pill identity match;
- no live install or rebuild is performed from a worktree, recovery directory,
  or excluded artifact.

## New idea

Status: design lock, not yet implementation-ready. Nothing in this section may
be built until the owner reviews and approves it in writing. This is Track B
(design-first, planned before any code). Track A is the current pill's
demo-readiness work (dictation hotkey, composer rebuild, human-sounding A2A
messaging) and must not touch any surface described below.

### I. The core pivot

A redesign of how the owner interacts with agents — not a bolted-on feature,
a replacement of the current click-into-composer-first flow.

- **Ambient cursor outline** — a thin glowing outline always hugging the real
  OS cursor. Pure visual/status layer, no interaction. States: idle (subtle),
  listening (pulsing while picking up audio), dispatched/working (color
  shifts), error (solid red, fast pulse, paired with section VII). Color
  scheme undecided and not load-bearing (could be rainbow, provider colors,
  user-set, or one fixed color).
- **Wheel/pie selector** — hold the hotkey (no click required) to pop a
  radial menu at the cursor. Tight radius, hugging close to the cursor,
  provider logos only (no text labels). Clicking a logo toggle-selects it
  (does not fire immediately); confirming in a center slot dispatches —
  supports multi-select (one message to multiple agents). Grows/shrinks
  automatically as providers connect/disconnect. Reference locked:
  [Pie Menu](https://piemenu.jpmarqu.es/)
  ([GitHub](https://github.com/jpmarques/pie-menu)) — a real shadcn
  component; its `PieMenuCenter` slot becomes the confirm button; it exposes
  `--pie-aim-x`/`--pie-aim-y` CSS vars for live cursor-following; it
  auto-spaces up to 16 items and respaces live as items are added/removed.
  No visible `@mentions` appear in the composer for a wheel-driven dispatch —
  the mention is written under the hood only.
- **Dictation hotkey** — Ctrl+Alt, confirmed correct (independently matches
  the real open-source `rickkdev/clicky`). A gesture distinct from the wheel:
  tap-only (no click) triggers dictation; hold + click triggers the wheel.
  Designed so no accidental normal click or keypress during regular work can
  trigger either one by accident.
- **Per-agent cursors stay** — the redesign changes how the owner summons/
  interacts with agents, not the fact that each actively-working agent still
  shows its own colored cursor live on screen.
- **Cursor reskinning** — Cua Driver already supports this: a pluggable
  "dotLottie cursor contract," per-agent animation files with state variants
  (thinking/clicking/blocked), authored through Cua's own SDK, not baked
  into their binary. Everything currently still renders the `cua.default`
  theme (confirmed by an Oct 7 internal audit) — the "people will recognize
  that's Cua's cursor" risk is real right now. The fix is scoped, not built:
  author M9R's own per-provider dotLottie skins.

### II. The "always-on, 10x faster" mechanism

- HeyClicky's speed is not always-processing. It is push-to-talk, made to
  feel instant because their UI overlay is already rendered (full-screen,
  transparent, always present) so there is zero boot lag, and screen/context
  capture only happens at the instant of trigger.
- M9R's answer: **pre-warmed context, not pre-warmed AI.** The pill keeps a
  cheap, continuously-updated lightweight diff of "what's on screen right
  now" — near-zero cost, no LLM call — so the instant the hotkey fires,
  there is zero capture lag; the request starts with context already in
  hand.
- **Unresolved, explicitly flagged by the owner and never answered:** is
  this "snapshot" a lightweight accessibility-tree/UIA structural read
  (cheap, structured) rather than an actual pixel screenshot? The owner
  pushed back on the word "snapshot" specifically and this was never
  confirmed back to them.
- Perceived latency, not actual latency, is the lever for the first ~2
  seconds — the dictation audio-bar, the listening pulse, and the task card
  appearing immediately in a "working" state before any result exists are
  what make the real (unavoidable) transcription/model/tool latency feel
  designed rather than slow.

### III. Cost/token-economics framework

The rule every piece of the redesign is checked against:

| Layer | Cost | Lives here |
| --- | --- | --- |
| Local, always-on | Zero tokens, near-zero latency | Accessibility-tree context tracking, cursor-outline states, wheel reveal/fill animation, composer scroll/grow, task-card UI |
| Trigger-only | Zero until fired | The Ctrl+Alt hotkey itself — nothing talks to a provider until the owner commits |
| Templated/narrator | Near-zero (string formatting) | A2A status lines for the common case — built from event-to-sentence templates, not a model call |
| Real model call | Full provider cost | Only actual task dispatch, and genuinely novel A2A handoffs the template table doesn't cover |

The one invariant: **nothing idle should ever call a provider.** The failure
mode to design against is any of the first three layers leaking into the
fourth.

**Fairness/equity principle:** do not gate real capability behind high
*provider* plans. Everything should be as capable as possible even on a
user's lowest provider tier; higher provider plans (e.g. a Claude or Codex
max tier — not M9R's own pricing tiers) should buy a better experience, not
access to features others lack.

### IV. Floating task-result card

Title, green "Done" badge, one-line summary, two direct action buttons, and
a collapsible history of every prior step underneath. Lives in/near the
pill's black notch area. Directly replaces the overview's "two gray boxes."

### V. Composer redesign

Full replacement, not a patch. One dominant full-width input. A dictation
audio-bar renders inside it while recording. It grows to a capped max
height then scrolls (no runaway pill growth) — properly animated, not a
glitchy snap. The pill's own overall footprint/width when open may also
shrink into a more compact box shape, separate from the composer-height
cap. Three locked references for layout anatomy:
[OpenAI model-selector feedback](https://dribbble.com/shots/26517785-OpenAI-Feedback-Better-Model-Selection-2025),
[multi-model AI selector modal](https://dribbble.com/shots/26950650-Multi-Model-AI-Selector-Modal),
[AI prompt input anatomy](https://dribbble.com/shots/27127909-AI-Prompt-Input-Anatomy).
The separate "Models" tab/page likely goes away entirely once the wheel
exists.

### VI. Agent-to-agent visible chatter

Fading task-card-style exchanges, visible to the owner only. Must render as
provider-logo plus one short human-sounding line — never raw internal agent
text, never a fake back-and-forth. Must be token-cheap (templated/
milestone-based for the common case, per section III). **Not always
pairwise** — can be two-agents-to-one or one-to-two, not just A-talks-to-B;
the narrator/card UI must handle multi-party handoffs, not just a single
sender/receiver pair. Agents must write in genuinely human, well-composed
language — a hard requirement, not a nice-to-have, since agents are "good at
everything but writing."

### VII. Black-notch visual language

Dictation audio pickup visualizes in the black center area when the pill is
minimized. Error state: error text typed out character-by-character,
old-terminal style, paired with the cursor outline going solid red and
fast-pulsing (not the normal pulse).

### VIII. Memory system

Not built. Must research **Supermemory** (reportedly now open-source) as a
concrete architecture reference, not design from abstract categories alone.
Must explicitly avoid HeyClicky's actual mistake: two flat markdown files
(`PROFILE.md`, `VOLATILE.md`) dumped wholesale into every call — doesn't
scale, taxes every request regardless of relevance. Must stay genuinely
efficient for agents to both read and write to consistently, and must not
become unbounded context bloat. A starting shape (categories: preferences/
facts/history/workflow-patterns, retrieval-not-injection, local-only by
default) still stands as a draft, but needs to be pressure-tested against
what Supermemory and similar real systems actually do.

### IX. Network effect

Not usage volume. Three real layers:

1. Agents learn a user's, a team's, or a whole company's workflow and
   architecture, top to bottom.
2. Agents build trust/relationships among themselves over time — learning
   which agent is actually better at what, and proactively pulling each
   other in unprompted ("Claude, come help, this is design-related").
3. Eventually multi-human/remote-control: agents able to operate on a
   different connected person's machine across distance; the network of
   agents comes to understand each connected person's distinct working
   style individually.

The compounding/lock-in effect: once agents deeply know a user's/team's
architecture and have built real inter-agent trust, leaving M9R becomes
genuinely costly — that is the actual moat, not raw usage numbers.

### X. The reliability bar

HeyClicky's own ads claim people use it for things they didn't anticipate.
M9R is held to that same bar — cited as a concrete proof point: the owner's
own homework/quiz test, where Codex originally struggled with quiz dropdown
controls via desktop-stage targeting (reportedly since fixed). This needs to
be verified and shipped as evidence the reliability bar is actually being
hit, not just claimed.

### XI. Are we copying HeyClicky?

Resolved: no. Different core business model (bring-your-own-subscription
across real providers vs. HeyClicky's own owned/capped backend model
router). Shared vendor only at the Cua computer-use-driver layer — both
products buy the same low-level driver, not copying each other's design.
Several things HeyClicky has shipped and repeatedly walked back (skills,
proactive local agents, cursor placement) validate choices already locked
here rather than being gaps to chase.

### XII. Open thread

Mid-conversation: "you know what we have the biggest opportunity at as
well, that just reminded me, but yeah I'll get to that later" — never
followed up. Still open as of this writing.

## References

- [Source of Truth 5.0](./M9R_SOURCE_OF_TRUTH_5.0_MAINTENANCE_CONTRACT.md)
- [Agent Browser](https://github.com/vercel-labs/agent-browser)
- [Agent Browser session management](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/references/session-management.md)
- [Agent Desktop](https://github.com/vercel-labs/agent-desktop)
- [Cua Driver concepts](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/concepts/how-cua-driver-works.mdx)
- [Cua Driver contract](https://github.com/trycua/cua/blob/main/libs/cua-driver/contract/README.md)
- [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [MCP architecture](https://github.com/modelcontextprotocol/docs/blob/main/docs/concepts/architecture.mdx)

