# Pine Computer concept — scope for M9R

Status: draft scope for implementation planning. For Codex. Read-only research behind this — no code written yet.

## 1. What Pine Computer actually is (verified, not assumed)

Pine Computer (`pinecomputer.io`) is a **closed, private-beta, cloud-only** product — an API-provisioned virtual computer built for AI agents to operate. It is **not open source**: no public repository exists anywhere; their own blog states publishing design/implementation is a future plan, not something shipped. There is nothing to copy or fork. Everything below is an independent re-implementation of their *idea*, grounded in our own codebase, not their code.

Founder: Dylan Wang, who claims prior work at Agora (real-time audio/video infra). This claim is **unverified** — a direct search turned up no public record connecting a Dylan Wang to Agora. Don't cite his credentials as fact in any external messaging.

### The core idea
Instead of an agent perceiving a computer the way a human does (screenshot → visually parse → guess a click coordinate), Pine's computer exposes:
- **Read** — structured data about what's on screen (what's a button, what's a text field, what's clickable) instead of pixels.
- **Sense** — push-based change notifications ("epoll for AI perception") instead of the agent re-polling/re-screenshotting to see what changed.
- **See** — many virtual screens held in memory, rendered only when actually needed, instead of one screen an agent must constantly re-check.
- **Access** — each computer sealed off, scoped, API-key-gated, encrypted state.
It still falls back to visual/pixel input when needed — it's a hybrid, not 100% pixel-free. Their SDK (`pine.create_computer(...)`) is cloud-only; there is no "run it locally" option — confirmed directly from their own FAQ: *"No. It runs in our cloud, not on your machine."*

### The benchmark claim — verified against the independent source, not just their own blog
SaaS-Bench v1.1 is a real, independent benchmark (built by UniPat AI, published at `unipat.ai/benchmarks/SaaS-Bench`, with an arXiv paper). Pine's own reported numbers match UniPat's independently-published leaderboard exactly — this is not cherry-picked or misrepresented:

| Model / Harness | Checkpoint Score | Resolved Score | Cost/task |
|---|---|---|---|
| Pine Computer / PCR | 78.3% | 27.4% | ~$3.60 (public table) |
| Opus 5 / Claude Code | 74.3% | **31.1%** | ~$26.50 |
| GPT-5.6 Sol / Codex | 71.1% | 29.2% | ~$20.50 |

Read this correctly: Pine wins on **checkpoint score** (makes more incremental progress per dollar) and on **cost**, but **loses on resolved score** — Claude Code actually finishes more tasks end-to-end than Pine does. "2-5x faster, 1/25th the cost" is true and verified. "Better than the competition" is not fully true — it's cheaper and makes more partial progress, but is currently *worse* at actually finishing the whole job than the two harnesses it's compared against. Do not claim Pine (or a derivative of its idea) is unconditionally superior; claim the specific, verified thing: more progress per dollar on the perception layer.

The original SaaS-Bench paper's headline number (<4% completion) is from an older benchmark version against older/weaker models — not a contradiction with the table above, just a different model generation. Don't cite the <4% figure as current.

## 2. Why the resolved-score weakness likely doesn't transfer to M9R

Pine's weak completion rate is most likely a property of **their own agent harness/reasoning loop**, not the perception idea itself — they built a whole new runtime around their structured-perception computer. M9R would not be doing that. Claude Code's and Codex's own reasoning/task-completion logic — already mature, already what drives whether a task actually finishes — stays untouched. This implementation only swaps **one input** under that existing harness: at the moment an agent needs to click or type locally, it gets structured data instead of (or alongside) a screenshot. This is a reasoned hypothesis, not a guarantee — treat it as something to validate once built, not something to promise before it's built.

## 3. The actual integration points in this codebase, verified by reading the code

Every stage action the pill can currently take is defined in **`src/lib/native/task-stage-actions.ts`**. The current action set — `capture`, `click`, `cursor`, `double_click`, `right_click`, `type`, `scroll`, `drag`, `press_key`, `hotkey` — is **100% coordinate/pixel-based**. There is no structured-element read anywhere in this layer today. This confirms the idea is genuinely new work, not something half-built already.

This splits into two genuinely different pieces of work — do not treat them as one unit or promise them on the same timeline.

### 3a. Browser surface (Chrome) — the cheap piece
M9R already has a live CDP connection to the browser for the existing click/type path (`src/lib/native/agent-chrome.ts`, the web broker in `src/lib/native/web-broker-core.ts`). Chrome's own DevTools Protocol already exposes a full accessibility tree (`Accessibility.getFullAXTree` and related DOM/AX APIs) for free — no new transport, no new auth, reuses the existing connection. Confirmed: no accessibility/structured-read command exists yet in `web-broker-core.ts` (checked directly), so this is additive, not a rework.

**Scope:** add a new broker command (e.g. `read_structure`) that calls the already-open CDP connection's accessibility-tree API and returns a structured element list (role, label, bounds, clickable/editable state) instead of a screenshot. Surface it as a new `m9r_web_*` MCP tool alongside the existing `m9r_web_snapshot`/`m9r_web_click` etc.

### 3b. Native desktop apps (Notepad, File Explorer, any installed app) — the real engineering
No equivalent shortcut exists here. Windows exposes this kind of structured data through its own UI Automation (UIA) API, but M9R's native helper (`native-input-host/`, Rust) does not currently call it — the current desktop-stage path (`src/lib/native/windows-desktop-stage.ts`, `src/lib/native/cua-stage-driver.ts`) is Cua Driver–based screenshot/coordinate control.

**Scope:** add new UIA bindings to the Rust native-input-host (likely via the `windows` crate's UIA interfaces), expose a new native command that returns a structured element tree for the currently-targeted window, and thread it through `windows-desktop-stage.ts` → `task-stage-actions.ts` as a new `read_structure` action kind (same name as 3a, same shape, different backend — desktop vs. browser). This is new native code, cross-process plumbing, and real testing surface — size this as its own work item, not a side effect of 3a.

### 3c. The actual action-schema change (ties 3a + 3b together)
In `task-stage-actions.ts`:
```
type TaskStageActionBody =
  | { kind: "capture" }
  | { kind: "read_structure" }   // NEW — returns structured elements instead of pixels
  | { kind: "click" | "cursor"; x: number; y: number }
  | ...
```
`runTaskStageAction` gets one new case, branching the same way `capture`/`click` already branch on `mode === "owner-preview"` vs background, and (new) on whether the target is a browser window (routes to 3a) or a native app window (routes to 3b).

## 4. What NOT to do

- Do not attempt to replace `capture`/pixel input entirely. Pine itself keeps visual fallback — this should be additive, agents choosing `read_structure` when useful, `capture` when not, not a hard cutover.
- Do not promise 3a and 3b on the same timeline. 3a is a broker command reusing existing infrastructure. 3b is new native Rust code against a Windows system API — larger, slower, genuinely different risk profile.
- Do not cite Pine's "destroys the competition" framing externally — their own independent benchmark shows they lose on task completion. Cite the specific, true claim: more progress per dollar, verified independently.
- Do not reference Dylan Wang's Agora background as fact — unverified.
- Do not treat this as blocking current pill work. This is reliability/quality infrastructure for the OS-level stage that's already mid-build (per `M9R_CUA_WAVE_PLAN.md`'s Track A step 3) — sequence it after the current defect list, not instead of it.

## 5. Open questions for Codex to weigh in on before implementation starts

1. Does the installed Cua Driver 0.34.0 (already in use for cursor/window control) expose any accessibility-tree read of its own that could shortcut 3b, or is a fresh UIA integration required from scratch?
2. What's the actual marginal latency/cost of a CDP accessibility-tree read per action, for 3a — worth a quick spike before committing to it as "the cheap piece."
3. Should `read_structure` results be cached/diffed per window (closer to Pine's "Sense" change-notification model) or fetched fresh per call to start — the former is more faithful to the idea but more work; the latter is a faster first cut.
