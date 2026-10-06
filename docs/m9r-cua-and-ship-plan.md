# Cua, line by line, and what M9R ships that nobody else has

2026-10-03. Cua facts are from their public repo README, the Cua Spaces launch coverage and release notes. Tavus facts are from their public pages. "Verified" means I read it; "not verified" means I could not.

> **Historical research snapshot, not the active task list.** Its competitive framing and Part 4 order are superseded. Use [M9R_CUA_WAVE_PLAN.md](M9R_CUA_WAVE_PLAN.md) for C1–C15 status/order and [M9R_COMPETITIVE_RESEARCH_2026-10-04.md](M9R_COMPETITIVE_RESEARCH_2026-10-04.md) for Track B.

Owner rules this plan follows: the moat is multiplayer (people and their agents, across providers, in rooms). Cursors, memory and features alone are copyable, so we keep shipping things others do not have. At the time of this snapshot, the listed work had not been merged to `main`.

---

## Part 1. Everything Cua ships, and what each piece does for us

Legend: ADOPT = use their code or idea directly. BUILD = our own version. SKIP = not for us. Effort S (days), M (a week or two), L (a month).

| Cua piece | What it is (verified) | What it would do for us | Call | Effort |
|---|---|---|---|---|
| **Cua Driver** (MIT, macOS / Windows / Linux) | Background computer-use driver: clicks, types, screenshots, window state, app list, over CLI, MCP and an SDK. Delivers input without moving the real pointer or stealing focus. Three permission modes: standard, bounded (manifest-limited), unrestricted. | Lets an agent operate a window while the person keeps working. For the browser it is the route to input with no "debugging" banner. For non-browser apps (Figma desktop, Excel, Slack app) it is the only way. Our own test on Windows proved only a background left click for Chromium/Electron; their README says Windows is "Full", so re-test on the newest release (0.32.x) before trusting either claim. | ADOPT for non-browser apps, behind an opt-in. | M |
| **Synthetic agent cursor** (custom dotLottie cursor contract) | Each agent draws its own cursor; skins are authored as dotLottie. | Per-agent cursor skins (Claude, Codex, OpenCode, a teammate's agent) that animate for thinking, clicking, blocked. We already have per-agent cursors in the extension overlay; this makes them identity, not just a dot. | BUILD our own skins, borrow the contract idea. | S |
| **Cua Spaces** (free Mac app, FSL-1.1-MIT) | A full virtual desktop an agent works in, on your Mac, a machine you own, or your cloud. You stream it, watch the agent's cursor, take over with yours, hand back. | The "watch it work, grab the wheel, hand it back" feel. We already have leases and handoffs; we lack the one-click take-over / hand-back control and a live view for remote people. | BUILD (do not use their code; FSL forbids competing hosted use). | M |
| **App teleport** | Move a signed-in app plus selected session data into the agent's Space, after a consent screen (sensitive items need explicit opt-in and Touch ID). | Their answer to "the agent needs my logins". Ours is different and better for the browser: the agent works in your real logged-in Chrome through the extension, with per-site grants, and M9R never extracts cookies or passwords. For an isolated option, offer an **agent-owned Chrome profile** the person logs into once and approves per site. | BUILD (agent profile), keep the no-credentials rule. | M |
| **Keyvault** | Encrypted credential store, session data stays on the Mac. | We deliberately avoid handling credentials. Skip, except an OS-keychain-backed "approved login" later if enterprise asks. | SKIP | - |
| **cua-spacesd** (streaming daemon, FSL) | In-VM daemon: processes, files, desktop, low-latency video and audio. | The thing a remote teammate needs to *watch* your agent's window. We can build the same with Chrome's own screencast (CDP `Page.startScreencast`) piped over our relay: no daemon, works for any browser tab. | BUILD | M |
| **Shared desktop, human + agent cursors** | One desktop, your cursor and the agent's at once. | This is the Cua feature we must match for the demo narrative, and we already beat it for the browser: N agents plus N people, different owners, one room. | Already have; polish. | S |
| **Pro / Teams plans (announced, not shipped)** | Shared team machines, session handoff, keyvault sync, admin controls. | **Cua is heading into our space.** Their version is shared *machines*; ours is shared *rooms* across providers and owners. We have to ship the cross-owner room test and the demo before they ship Teams. | Race. | - |
| **Cua Bench** (MIT) | Build computer-use tasks, evaluate agents, export trajectories for RL training. Partner program (cuabench.ai). | Credibility. A published **multiplayer benchmark** (two agents + a person finishing a task that needs a handoff) is something no one else can publish. We already have `bench-*` harnesses. | BUILD on ours. | M |
| **Trajectory export / history query** | Records what agents did; read-only action history in Driver nightly. | Our Activity tab is the start. A full recorder (below) is the groundbreaking version. | BUILD (see ship #3) | M |
| **CUA-S1 "System 1" models** (MIT code) | Small specialised models for fast, bounded computer-use decisions, e.g. form filling. | The same idea as Jev (typed probabilities from a small fast model). Use Jev for element choice, form-fill confidence and approval prediction instead of a full agent turn. Cheaper and faster per action. | BUILD with Jev | M |
| **cua-sandbox / Pool / SDK / CLI** | Python, Node, Swift SDKs; sandbox pools. | A pool of agent windows is the engine behind the "stage" idea (tiled windows, cursors crossing). The SDK itself is infrastructure we do not need. | SKIP SDK, copy the pool concept. | - |
| **Lume / Lumier** | Local macOS VMs on Apple Silicon, Docker-style control. | Mac-only; our users are on Windows. For always-on cloud agents we would use a hosted browser instead (the Cloudflare credits doc is the path). | SKIP | - |
| **Omarchy / Hyprland native cursor** | A true compositor-level second cursor on Linux. | Genuinely independent OS pointers exist only there. Not a Windows option. | SKIP | - |
| **OmniParser / cua-som perception** | Screen parsing for non-DOM apps. **AGPL-3.0**. | Licence trap: shipping or hosting it forces source release. Avoid. If we need vision for non-browser apps, use a permissive model. | AVOID | - |

**One conflict to settle.** The saved scope says M9R is "anywhere on the web + terminal, no desktop-app driving". Adopting Cua Driver widens that. Recommendation: browser first (agent-owned Chrome profile, banner-free), Cua Driver only as an opt-in "desktop apps" power, off by default.

---

## Part 2. Cua to-do, in order

1. **Banner-free browser input.** Launch an agent-owned Chrome profile with a debugging port (Cua's own browser route), so no yellow "debugging" banner. Gives: clean demos, agents that never fight your cursor. (M)
2. **Quiet-mode typing and drag** through the same channel, with the existing one-writer-per-tab scheduler. Gives: agents can fill and drag on real sites silently. (M)
3. **Take over / Hand back** button in the pill and the room, using the lease system that already exists. Gives: the Cua Spaces moment, but for any number of people and agents. (S)
4. **Per-agent cursor skins** with thinking / clicking / blocked states. Gives: you can tell agents apart at a glance in a recording. (S)
5. **Live view for remote teammates** via tab screencast over the relay. Gives: a person on another machine watches your agent work, which is the cross-user room demo. (M)
6. **Agent manifest** (Cua's "bounded" mode): a visible list of sites and actions each agent is allowed, editable by the owner. Gives: trust, and it maps to the origin grants we already have. (S)
7. **Cua Driver for desktop apps, opt-in**, after re-testing on Windows. Gives: Figma desktop, Excel, Slack app. (M)
8. **Multiplayer benchmark**, published with the demo. (M)
9. **Stage** (tiled windows, cursors crossing, Jev routing), small first: two windows, one lease handoff. (L)

---

## Part 3. What to ship that nobody has (ranked)

**About the "Human Model" startup.** It is **Tavus**, "the human computing company". Their models: Phoenix (renders a face with expressions), Raven (perception: sees and reasons about the person), Sparrow (turn-taking: knows when to speak), and Griffin, announced October 1, claiming 48% of test subjects mistook the video partner for a real person. The lesson is not video avatars. It is that **presence and judgment about the human** are products. Ours is the agent version of that.

1. **Approval Twin (a Human Model of the owner).** M9R watches what you approve, decline and edit, and Jev predicts "would you approve this?" with a probability. Low-risk and high-confidence: the agent just acts. Uncertain: it asks. Gives: the friction-first goal, far fewer prompts, and a model of *you* that travels across Claude, Codex and OpenCode. Nobody has a provider-neutral one, because each provider only sees its own approvals. Off by default, always shows why it decided, and never auto-approves money, sending or deleting.
2. **Two-Key Actions.** For anything risky (buy, send, post, delete) a *different provider's* agent must independently check the action before the owner is asked, and the prompt shows both opinions. Gives: safety no single-provider tool can offer, and a headline: "Claude's purchase, checked by Codex, approved by you."
3. **Flight Recorder to Replay URL to Skill.** Every room records agent actions, cursors, page states and approvals as a signed, replayable timeline with its own share link. One click turns a recorded run into a reusable procedure any agent can run. Gives: "watch exactly how it was done", audit for teams, and a library of skills built from real work. Cua exports trajectories for training; ours is user-facing.
4. **Live Rooms with spectators.** A room link where people watch (read-only) or join, with a live tab view. Like a Figma multiplayer link, for agent work. Gives: distribution. Every shared link is an ad.
5. **Agent Passport.** A portable, owner-signed identity for an agent: provider, owner, scopes, revocation, and a track record (we already have `AgentTrackRecord`). Lets agents from different owners join rooms with trust. Gives: the missing identity layer between companies' agents.
6. **Legible agents (the Tavus idea, small).** Cursor mascots that show real state: thinking, unsure (low Jev confidence), blocked, waiting on a teammate. Gives: you can read an agent's mind without reading its log.
7. **Standing orders.** Agents that watch a page or inbox and wake on change, with an owner-set budget. Ties to quiet mode.
8. **Cost lens.** One ledger of spend across providers per room and per agent, with caps. Gives: teams can say yes. (Usage counters already exist per provider.)

**My ranking for launch narrative:** #2 and #4 are demoable in 30 seconds and visibly multiplayer. #1 is the deepest and hardest for competitors to copy. #3 is the best long-term product.

---

## Part 4. Order of work

1. Finish memory: join local and cloud notes, per-turn recall, pill save button (approved).
2. Merge the launch branch to `main` (approved after memory).
3. Cross-user room test (second machine) and the short rooms + pill demo.
4. Cua items 1 to 6.
5. Ship #2 (Two-Key Actions) and #4 (Live Rooms), then record the full demo.
6. Ship #1 (Approval Twin) behind a switch; then #3.

Sources: github.com/trycua/cua and its Cua Driver page, runtimewire.com Cua Spaces article, Cua release notes, tavus.io and SiliconANGLE and BigGo coverage of Tavus.
