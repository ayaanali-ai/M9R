# Pine Computer concept — scope for M9R

Status: implementation scope and evidence checkpoint for M9R. The Pine idea is implemented locally; Pine itself is not a software, cloud, SDK, or runtime dependency.

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

Every stage action the pill can currently take is defined in **`src/lib/native/task-stage-actions.ts`**. The input actions remain coordinate/pixel-based, but the observation boundary now has a separate exact-window `read_structure` action. It returns opaque Cua element tokens and semantic metadata without exposing HWNDs or process IDs; pixel capture remains the bounded fallback.

This splits into two genuinely different pieces of work — do not treat them as one unit or promise them on the same timeline.

### 3a. Browser surface (Chrome) — the cheap piece
M9R already has a live CDP connection to the browser for the existing click/type path (`src/lib/native/agent-chrome.ts`, the web broker in `src/lib/native/web-broker-core.ts`). Chrome's own DevTools Protocol already exposes a full accessibility tree (`Accessibility.getFullAXTree` and related DOM/AX APIs) for free — no new transport, no new auth, reuses the existing connection. Confirmed: no accessibility/structured-read command exists yet in `web-broker-core.ts` (checked directly), so this is additive, not a rework.

**Scope:** add a new broker command (e.g. `read_structure`) that calls the already-open CDP connection's accessibility-tree API and returns a structured element list (role, label, bounds, clickable/editable state) instead of a screenshot. Surface it as a new `m9r_web_*` MCP tool alongside the existing `m9r_web_snapshot`/`m9r_web_click` etc.

**Current evidence checkpoint:** the existing browser snapshot path already returns structured DOM controls and snapshot-scoped refs. It remains the browser observation route; no extension cursor is required for this observation. A separate browser accessibility-tree command is optional follow-up work, not a reason to fall back to pixel coordinates when the existing structured snapshot is available.

### 3b. Native desktop apps (Notepad, File Explorer, any installed app) — the real engineering
The installed Cua Driver contract already exposes `getWindowState` with an accessibility tree, element tokens, roles, labels, parent indices, action names, and bounded traversal. M9R now uses that exact-window structure path in `src/lib/native/cua-stage-driver.ts` and exposes it through `task-stage-actions.ts` as `read_structure`; a second Rust UIA stack is not needed for this exact-window capability.

Desktop-wide observation remains visual because there is no one exact window to bind the tree to. Source/fixture proof covers opaque-token remapping, parent/depth preservation, same-call screenshot fallback when the tree is partial/unavailable, app-window-only routing, and rejection of desktop-wide structured observation. Installed-runtime and owner-preview proof remain separate acceptance work.

### 3c. The actual action-schema change (ties 3a + 3b together)
In `task-stage-actions.ts`:
```
type TaskStageActionBody =
  | { kind: "capture" }
  | { kind: "read_structure", view: "app" }   // exact-window structured observation
  | { kind: "click" | "cursor"; x: number; y: number }
  | ...
```
`runTaskStageAction` now has one bounded exact-app-window case. It refuses desktop-wide structured reads instead of pretending a screenshot is an accessibility tree. Browser structure remains on the broker's DOM route; native structure remains on the Cua exact-window route.

## 4. What NOT to do

- Do not attempt to replace `capture`/pixel input entirely. Pine itself keeps visual fallback — this should be additive, agents choosing `read_structure` when useful, `capture` when not, not a hard cutover.
- Do not promise browser and native live acceptance on the same timeline. The browser route reuses its structured DOM snapshot; the native exact-window route reuses Cua's bounded accessibility tree. They still need separate installed-runtime and live evidence because their transports and failure modes differ.
- Do not cite Pine's "destroys the competition" framing externally — their own independent benchmark shows they lose on task completion. Cite the specific, true claim: more progress per dollar, verified independently.
- Do not reference Dylan Wang's Agora background as fact — unverified.
- Do not treat this as blocking current pill work. This is reliability/quality infrastructure for the OS-level stage that's already mid-build (per `M9R_CUA_WAVE_PLAN.md`'s Track A step 3) — sequence it after the current defect list, not instead of it.

## 5. Open questions for Codex to weigh in on before implementation starts

1. **Answered for the current Windows path:** Cua Driver 0.34.0 exposes the exact-window accessibility tree through `getWindowState`; a fresh Rust UIA integration is not required for this scope. Verify the same capability on any future non-Windows backend rather than assuming parity.
2. What's the actual marginal latency/cost of a CDP accessibility-tree read per action, for 3a — worth a quick spike before committing to it as "the cheap piece."
3. `read_structure` currently fetches a fresh bounded snapshot per call and issues a new observation revision. Sense-style push/diff notifications and virtual-screen See remain explicit follow-up work; they are not claimed by this first implementation.

## 6. Remaining evidence gates

- Run the new exact-window structure action through the installed M9R runtime and a real owner-preview session; source/fixture success is not live acceptance.
- Confirm a real browser snapshot and a real native app tree keep one target identity/revision contract while their routes remain distinct.
- Measure structure-read latency, partial-tree frequency, and screenshot fallback frequency before making speed claims.
- Keep the visual fallback for controls the structure route cannot expose, and verify that fallback never silently changes the selected app window or dispatch route.
- Keep Pine's Sense/See ideas scoped until there is a measured need; do not simulate them with unbounded polling or hidden screenshot loops.

## 7. 2026-10-15 recovery-pass evidence

- The structure-first adapter is now on the engine source path used by the MCP server. Root typecheck is green; the desktop-stage suite passed 84/84 and the provider-neutral computer-use/runtime suite passed 120/120. These results verify the shared contract, not owner acceptance.
- The current build records source commit `f888ec29f5ce3db28c24a62ab6a951e5f616e75b`, explicit dirty state, and final engine identity `4c5cf526608304124d7ec9230756ad823e506563f399aa0cdc6c9f787bcb05eb` across 185 packaged artifacts. The Cua Driver 0.34.0 package was included and hash-verified.
- The remaining gates are unchanged in meaning but now have a single owner: a fresh governed owner-preview session must prove the native app tree and browser structured route against current installed artifacts, record latency/partial/fallback measurements, and confirm native OS route exclusivity, cursor attribution, and physical-pointer isolation. No claim is made that screenshots have disappeared: they remain the bounded fallback for incomplete structure, while the default observation path is structure-first.
- Sense-style push/diff notifications, virtual-screen caching, human-paced text visualization, and universal live action-family coverage remain follow-up evidence/implementation gates. They must not be represented as already delivered by the current `read_structure` implementation.

## 8. 2026-10-16 shared action/runtime checkpoint

- The current source and installed package preserve Pine's intended hybrid boundary: exact native app windows use structured UIA data first, browser pages use structured DOM/snapshot data, and a same-capture visual fallback remains available only when structure is incomplete or unavailable. Desktop-wide capture is still intentionally visual because it has no single exact-window accessibility owner.
- The shared CUA action layer now carries foreground delivery through the common text path, uses bounded driver-supported text pacing for legacy text input, repositions the labeled agent cursor from fresh field/element evidence before text/key/hotkey/value actions, and hides that cursor after a refused action. This is the actuation half of the same structure-first capability; it is not app-specific and it does not claim that atomic UIA value replacement can animate characters.
- Verification on the current source/install: typecheck passed; desktop-stage passed 85/85; provider-neutral contract/router/MCP/resident coverage passed 112/112; runtime identity/bridge/owner/lifecycle coverage passed 22/22; browser/extension/package/launch coverage passed 26/26; installed provider reconnect passed 1/1. The installed engine and source artifact hashes match for the current candidate.
- Remaining evidence gates are still live-only: a fresh governed owner-preview task must prove one exact native structure read, one native OS action, browser/native route exclusivity, cursor attribution, physical-pointer isolation, fallback/timing measurements, and provider parity. The current Codex connection is recognized, but the M9R inbox has no fresh approved stage task, so those desktop observations were not fabricated in this pass.

## 9. 2026-10-16 T193 governed live evidence

- T193 is the accepted full Items 2–10 owner-preview task. Its native stage was prepared successfully and every stage action used the same `owner-preview` mode and task binding.
- Calculator provided a real exact-window structure read: `status=partial`, 34 structured elements, and a same-capture visual fallback at `400x665`. Fresh native clicks changed the visible structured display from `Display is 0` to `Display is 1`, then to `Display is 2`; the effects were confirmed by new structure reads.
- The native Chrome stage opened a task-owned `about:blank` window, not the stale extension error tab. Its exact-window read returned 27 controls and a same-capture visual fallback. Native address-bar click, type, and Enter navigated that window to `Example Domain`, then to the W3C PNG specification; the title change was observed through a fresh structure read.
- A native scroll was dispatched on the long W3C page after a fresh capture. The current Chrome UIA surface exposes no page scroll offset or DOM content in the exact-window structure, so the scroll receipt is recorded as dispatched but **not** as a verified visible effect. This is an evidence boundary for the shared browser-native route, not a claim that Chrome itself is unsupported.
- No extension-route tool was called in this OS-only pass. Therefore extension/native exclusivity, cursor attribution, physical-pointer isolation, and cross-provider parity remain unclosed until the runtime exposes observable evidence for those properties. No personal Notepad tabs were edited or discarded after the safety guard detected modified tabs.

- The first task-owned Chrome capture demonstrated an important shared focus boundary: registering/capturing a window did not itself make it the desktop foreground. The existing semantic `focus` action was then used, and the desktop capture visibly showed the page rendered. A fresh foreground-confirmed native scroll moved the W3C document from its opening section to the History/Editors/Authors section in the before/after captures. This confirms the Pine actuation path can operate on a native browser window once foreground ownership is explicit.
- The same pass returned an enabled/visible synthetic cursor with an exact requested point and screen mapping, and no extension-route tool was called. The result does not expose the physical owner's pointer position, so pointer isolation remains an evidence gate rather than an assumption.
- A reversible `Control+L`/`Escape` pair on the same foreground-confirmed native Chrome window produced visible address-bar selection and restoration in before/after captures. This adds live keyboard actuation evidence to the structure-first browser proof. It does not turn the top-level Chrome UIA tree into a DOM tree: native Chrome structure still exposed browser chrome controls, while page content was verified visually.
- The shared actuation layer now makes foreground ownership explicit: a foreground-confirmed action first brings the exact target HWND to the front, then sends the driver action with `delivery_mode=foreground`; a failed activation sends no input. This closes the generic focus/hidden-window gap found during T193 at source level and in the Cua driver fixtures. The rebuilt candidate still needs safe installation and live revalidation before this source fix can be called installed-runtime evidence.

## 10. 2026-10-16 T193 installed-image continuation

- The accepted T193 card covers the full current Items 2–10 sequence. After the managed runtime installation, the current Codex identity was recognized and the same task was prepared again in `owner-preview` mode.
- The installed native structure/action path was live-verified on a task-owned Calculator window: 34 structured elements, a same-capture 400x665 visual fallback, and a foreground-confirmed click whose fresh structure read changed `Display is 0` to `Display is 1`. This confirms the shared Pine-style observation/actuation boundary on the installed image; it does not claim universal live closure.
- The installed credential-free provider reconnect acceptance passed **1/1** outside the restricted sandbox. The sandbox failure was an environment permission failure on temporary Windows pipe/lock paths, not a product result.
- The Pine boundary remains hybrid by design: structure first, bounded visual fallback when structure is partial/unavailable. Native Chrome's top-level UIA tree does not expose page DOM content, so browser page effects still require the browser's structured route or a bounded visual verification. Physical-pointer isolation, native-versus-extension exclusivity, provider parity, and full action-family coverage remain evidence gates.

## 11. 2026-10-16 T194 current installed native proof

- The current installed package was exercised through the native owner-preview stage on a task-owned Calculator window. Exact-window structure returned `status=partial` with 34 structured elements and a same-capture 400x665 visual fallback; this is current installed evidence that structure-first observation is the default and that the fallback is bounded to the same capture.
- A fresh native UIA click changed the structured display from `Display is 0` to `Display is 1`, and a fresh read verified the effect. A fresh key action changed `Display is 1` to `Display is 12`, and a fresh read verified the effect. The key receipt used the driver's background/PostMessage route, so this does not prove foreground keyboard delivery or human-paced text.
- This proof does not close the remaining Pine evidence gates: the stage response exposed no opaque target ID/revision for this path; browser DOM/native Chrome parity, structure-read timing, fallback frequency, cursor attribution, physical-pointer isolation, route exclusivity, and provider parity remain unverified. The hybrid boundary is therefore still the honest implementation description: structure first, one bounded same-capture visual fallback where needed, and no claim that screenshots have disappeared entirely.

## 12. 2026-10-16 installed Cua actuation-surface audit

- The installed Cua Driver 0.34.0 runtime schema was queried directly. Its shared desktop input operations `click`, `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, and `set_value` all expose the same explicit `delivery_mode` field. M9R routes those through one provider-neutral dispatch helper and does not add per-application branches.
- `set_window_frame`, `invoke_menu`, clipboard read/write, overlay cursor movement, and observation operations do not expose `delivery_mode`; they remain separate semantic primitives rather than being mislabeled as foreground keyboard/pointer delivery. Their live effects remain open evidence gates.
- A new shared-driver regression exercised text, key, hotkey, scroll, and drag with foreground confirmation and verified the common `bring_to_front` then `delivery_mode:"foreground"` sequence. The focused Cua stage suite passed 40/40 and repository typecheck passed. This strengthens the actuation contract but is not a live owner-preview result.
