# M9R build & marketing priority list — 2026-11-20

Source material: PROGRESS_NOTES.md current improvement order (items 1-7),
M9R_SOURCE_OF_TRUTH_6.0_IMPLEMENTATION_ORDER.md (Track A/B, §II-III perceived
latency, §XIII HeyClicky full changelog audit, §XIV pill redesign spec), and
fresh research below (First Person Labs, Underdog AI). HeyClicky was already
fully audited in Source of Truth 6.0 §XIII end-to-end (v1.0-v1.1.2) — not
re-researched here, just carried forward.

## Part 1 — Build priority

### Tier 0 — cheap, high-impact, do first

1. **Perceived-latency fixes.** Task card flips to "working" the instant a
   task is accepted (not after first observation). Templated, token-free
   status narration fills silent gaps ("Codex is checking Notepad..."). The
   cursor-outline "working" color state gives a persistent visual signal.
   All already designed in Source of Truth 6.0 §II/§III — none built yet.
2. **Route simple verify-then-act tasks through `m9r_computer_program`**
   instead of multiple separate tool calls. T601 (live trace, 2026-11-20)
   took 84.6s total: only ~4.3s was real M9R work; ~80s was two separate
   Codex round trips, each paying full provider think-time. One composed
   program call instead of two round trips is a real latency cut, not
   cosmetic. `m9r_computer_program` already ships (confirmed in the §XV
   ledger) — this is a routing decision, not new engineering.
3. **Land the already-staged pill fix**: remove the Accepted/Sending status
   banner (keep only "Send unconfirmed" — a real failure signal), revert
   outgoing bubble text to white on blue. Committed-but-held per owner
   instruction; install whenever the owner says go.

### Tier 1 — reliability (Progress Notes item 1, 2, 6; matches the owner's
Omarchy/windows-layer summary almost exactly)

4. `state.json` `EPERM` hardening — task-state persistence failed separately
   from whether the background app route itself worked (T599).
5. Repeat the Calculator→Notepad newline fix live and get a second clean,
   repeatable run (item 1's own stated bar — not yet met twice).
6. Chrome background search-submit — currently refused by design (Enter in
   the address bar won't fire in strict background mode). Decide if/when to
   support it, don't silently fall back to foreground.
7. Exact inactive-Chromium-tab targeting — open, extension-free by design
   constraint.
8. Hidden/cooperating Electron-document routing — open, needs app
   cooperation, not proven by the Notepad work.
9. Multi-agent parallel/background rehearsals — not yet attempted; solo work
   only so far.
10. Harder single-agent tasks (Paint, etc.) — still require foreground
    input; no reliability claim yet.

### Tier 2 — pill/cursor/chatter design (Progress Notes item 3, 4, 5;
Source of Truth 6.0 §XIV pill spec + "New idea" Track A/B)

**Track A — unblocked, can build now:** dictation hotkey polish, composer
rebuild on 21st.dev's AI Input (MIT, locked reference), human-sounding A2A
messaging. Build order already locked in §XIV: unified agent tile → composer
→ drag-and-drop → compact task card → ambient glow → shape-language motion.

**Track B — design-locked, explicitly gated on the owner's written approval
before any code, per Source of Truth 6.0's own non-negotiable rule:**
ambient glowing cursor outline, wheel/pie selector (hold-hotkey radial menu,
multi-select dispatch, Pie Menu reference locked), per-provider cursor
reskinning (flagged risk: every cursor currently renders Cua's own default
skin — "people will recognize that's Cua's cursor" is real right now, not
hypothetical).

### Tier 3 — memory/teaching (Progress Notes item 7)

- Audit the current workflow-preference implementation against Supermemory's
  actual open-source architecture (not done yet — still a gap).
- Prove one opt-in cursor-taught workflow: scoped preference, observable
  success, recall after restart, reuse by a different provider.
- **First Person Labs** (researched 2026-11-20, press coverage only, no
  primary technical source found): product is **Second**, a Mac app giving
  AI agents a portable, on-device, user-owned model of the person — built by
  analyzing computer-activity patterns and routines, not primarily chat
  history. Founded by ex-Stanford researchers Ken Liu and Erik Chi, ~$10M
  seed led by a16z, subscription business model. Core pitch: memory only
  matters if the user can inspect, move, or turn it off. **No real
  architecture writeup was found publicly** — this gives M9R the *goals* to
  match (inspectable, portable, off-switchable, behavior-derived) but not a
  concrete mechanism to copy. Sources: [StartupHub.ai](https://www.startuphub.ai/ai-news/investors-news/2026/a16z-bets-your-agent-needs-memory-you-own), [VARIndia](https://www.varindia.com/news/first-person-labs-pushes-ai-personalization-further).
- **Underdog AI** (by Conway Research, founder Sigil Wen; researched
  2026-11-20, confidence levels noted — canonical underdog.ai blocked
  automated fetch with 403, so some detail is secondary-sourced):
  - Confirmed real and distinct (TechCrunch + conway.tech + Product Hunt
    agree). Runs fully **on-device**, Mac and **Windows** both (Windows was
    in beta at launch; Linux/iPhone/Android "coming soon").
  - Two local model tiers: "Woof" (4B params, <2.5GB, ~115 tok/s on a
    MacBook Air) and "Underdog 27B" for harder tasks, on a custom "Husky"
    inference engine the maker claims beats Apple's MLX (self-reported, not
    independently verified).
  - Core tasks: email, calendar, meeting notes, dictation, errands.
  - **Memory system**: "saved memories," stored locally, user can
    view/edit/delete directly — simpler and more literal than First Person
    Labs' behavioral-pattern model, but concretely shipped and user-facing.
  - **Browser errands use describe → review/approve → execute**, with owner
    takeover at any time — directly comparable to M9R's own consent/lease
    model; worth citing as validation of that approach, not a gap to close.
  - Privacy features: email hardening (strips remote images/scripts/tracking
    pixels), per-account encrypted vault (key stays on-device), a single
    "Naval mode" toggle that fully cuts it off from external servers,
    third-party security assessment passed, Google-approved for
    Gmail/Calendar API access.
  - Business model: **free at launch, no ads**, monetized via a small cut of
    Stripe-routed payment transactions it initiates — not subscriptions.
  - **Explicitly NOT found in any source**: any cursor/visual feedback layer
    for agent actions, background execution while the user keeps working on
    something else, multi-agent/agent-to-agent coordination, or any
    pill/notch/widget UI shape. This is a real research gap (site blocked),
    not confirmed absence — but across TechCrunch, Product Hunt, and
    Dealroom, nothing resembling M9R's actual differentiators (background
    cursor ownership, multi-agent chatter) showed up at all.
  - Sources: [TechCrunch](https://techcrunch.com/2026/10/06/silicon-valleys-ai-wunderkind-launches-underdog-the-most-private-instinct-muse-competitor-yet/), [Product Hunt](https://www.producthunt.com/posts/1268683), [conway.tech](https://conway.tech), [Dealroom](https://dealroom.co/news/158789-a16z-backs-conways-underdog-an-ai-that-runs-entirely-on-your-device/).
- **HeyClicky** — already fully audited in Source of Truth 6.0 §XIII.
  Biggest concrete gaps vs. M9R today: **Routines** (recurring tasks set by
  talking — M9R has nothing equivalent) and **spatial/on-screen drawing**
  (HeyClicky draws back at the owner; flagged as a real capability gap, not
  a UI detail).

## Part 2 — Organization / maintenance (the "how do we stop messing this up"
problem from today's install confusion)

- There are currently **160+ timestamped folders** under `engine/candidates/`
  with no index of which one is the last owner-confirmed-good build. Today's
  wrong-install confusion came directly from this — reconstructing "which
  commit, which timestamp, which one did the owner actually approve" from
  raw `git log` and folder names, live, under pressure. Recommend: a single
  running `CANDIDATES.md` (or a tagging convention beyond `release-*`) that
  names the last owner-confirmed-good candidate explicitly, updated every
  time one is confirmed live.
- One frontend source per surface — Source of Truth 6.0 §XIV.12, already
  specced, not yet executed. This is the actual fix for "how many front ends
  do we have" — not a new problem, an existing tracked one that needs
  execution.
- Repo inventory pass (Progress Notes item 5) — entry points, sources of
  truth, build responsibilities, test coverage per surface — still open.

## Part 3 — Marketing: one X post per shipped, verified improvement

Rule: don't post until the specific thing shown actually works live and
repeatably — no claim ahead of proof. Pair each *shipped* milestone (not
planned work) with one of the four post types from the owner's pasted
guidance:

1. **Deny-a-truth post** — pair with the cursor/latency milestone once
   Tier 0 items 1-2 land and the 80s task visibly feels different.
2. **Identity-validation post** — pair with a reliability milestone: a
   second clean, repeatable Calculator→Notepad run, shown back to back.
3. **One-level-deeper post** — opportunistic, posted whenever the agent
   debate is hot online, not tied to a specific ship date.
4. **Demo-only video post** — every other milestone as it ships; one line,
   no thread, native video upload.

Next milestone worth a post, in order: (1) latency fix shipped + felt
different on camera, (2) a second clean repeatable background-Notepad run,
(3) one taught-workflow proof (Tier 3) recalled after a restart.
