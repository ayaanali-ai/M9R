# M9R Competitor Profile

Research date: 2026-09-18. All facts come from the sources cited inline (all accessed 2026-09-18). Anything not confirmed is marked UNVERIFIED. Depth is limited: about a dozen search and fetch calls, mostly landing pages, so "not stated" means "not on the page I read", not "does not exist".

## Identification results (read first)

| Requested | What I found | Confidence |
|---|---|---|
| NeublaAI | No agent-collaboration product found. "Neubla" resolves to an AI-accelerator/processor stack company (LinkedIn/HF listings) and a music artist. Nearest look-alikes: NeuBird AI (production-ops agent), Nebula (nebula.gg, "multiplayer AI workspace"). | Low. I believe NeublaAI is not a direct competitor, or the name is misspelled. Ask the user for the URL. |
| Plasma AI | plasma.ai: "Infrastructure for intelligence at scale"; first product **Fractal**, plus Radio and Wiki. Other "Plasma" companies exist (plasmaos.uz compliance agents; plasma.sh) and I excluded them. | Medium (plasma.ai matches "agent coordination + communication" wording). |
| Mosaic | **Mosaic Inc (mosaic.inc), YC-backed "multiplayer AI"**, founded 2026 by Shubham Patil and Dorsa Rohani. Not Databricks Mosaic AI, not the MOSAIC GitHub repo. | High (YC pages match the multiplayer-agents framing). |

## Profiles

### Mosaic (mosaic.inc)
- **What it is:** Syncs every AI session a team runs (Claude Code, Codex, Cursor and others) into one shared context store that any agent or teammate can read and write, so work carries from one session/person to the next. Their thesis: the unit of multi-agent is one shared context store, not message-passing specialist agents.
- **Target:** Engineering teams using several coding agents.
- **Traction:** About 2,000 installs and 37 orgs syncing (self-reported at YC launch). Team of 2, San Francisco. YC company page: https://www.ycombinator.com/companies/mosaic-inc. Funding: UNVERIFIED (YC-backed per listing; amounts not found).
- **Primitive:** Shared session/context memory. **Communication:** indirect, through the store and handoffs. No evidence of live messaging.
- **BYO/local:** Appears to sync local sessions from existing tools (per launch copy). Security, control transfer, cross-org: not stated.
- Sources: https://www.ycombinator.com/launches/T3K-mosaic-shared-memory-for-your-team-s-agents, https://www.ycombinator.com/companies/mosaic-inc
- **Threat level to M9R:** Medium. It overlaps on "shared memory / bounded context capsule" and validates the multiplayer category (YC lists multiplayer AI in its Request for Startups, per Mosaic's own page; I did not verify the RFS).

### Plasma AI / Fractal (plasma.ai)
- **What it is:** Fractal is described as a deployable layer combining agent creation, coordination, communication and shared knowledge in one work environment. Agents can run on different models. Explicit permissions and boundaries, an audit trail, and the ability to watch and guide each agent are claimed. Existing products: Radio (agent-to-agent talk) and Wiki (indexed knowledge with CLI tools for agents).
- **Target:** "Enterprise" is mentioned; no customer detail. Pricing, funding, team: not stated (UNVERIFIED). The "$300" figures on the page look like illustrative budgets, not price.
- **Primitive:** Managed agents in a shared work environment (agents are created inside Plasma, so closer to an agent OS). BYO subscription/local sessions, cross-org: not stated.
- Sources: https://www.plasma.ai/ (page fetch and search snippet).
- **Threat level:** Low to medium. Positioned as agent platform/infrastructure, not live-session connection.

### Band (band.ai)
- **What it is:** Interaction infrastructure giving existing agents persistent identity, multi-agent coordination in shared rooms with @mention routing, structured memory and a unified audit trail, without changing agent runtimes. Adapters for LangGraph, CrewAI, Anthropic, OpenAI, Gemini, Pydantic AI; SDK/REST/WebSocket/MCP. Handles like @alice or @alice/research-agent; consent-based discovery.
- **Funding/team:** $17M seed led by Sierra Ventures, Hetz Ventures, Team8; CEO Arick Goomanovsky, CTO Vlad Luzin (VentureBeat).
- **Pricing:** Free (10 agents, 50 rooms, 24h retention), Pro $17.99/mo, Enterprise custom (VentureBeat; may have changed).
- **Targets:** telecom, financial services, cybersecurity; also coding agents on different models. "Control Plane" with authority boundaries and credential traversal claimed.
- **Primitive:** Room. Steering/control transfer of a live session, local CLI sessions: not evidenced (Band is framework/SDK-oriented). Cross-org: consent-based contacts suggest yes, detail UNVERIFIED.
- Sources: https://docs.band.ai/welcome, https://venturebeat.com/orchestration/talking-to-ai-agents-is-one-thing-what-about-when-they-talk-to-each-other-new-startup-band-debuts-universal-orchestrator, https://github.com/band-ai/band-sdk-python
- **Threat level:** High on identity/handles/discovery/messaging; best-funded and closest to the "connection layer" framing.

### AQ (aq.dev)
- **What it is:** "Multiplayer coding harness": teams and agent CLIs (Claude Code, Codex, Cursor, others) share live workspaces (terminal, editor, app preview) on a VM in your own cloud or AQ-managed. Anyone can steer the running agent. Runs "the CLIs your team already subscribes to", with no platform markup.
- **Pricing:** Free personal sandbox; Team $50/user/mo early access (standard $200). Funding/team: UNVERIFIED.
- **Primitive:** Shared cloud workspace/VM. **Control:** steer by anyone in the workspace (Yes). **Local sessions:** No. Sessions live on the cloud VM. **Cross-org:** UNVERIFIED. Security: "no shared execution infrastructure" claim.
- Sources: https://aq.dev/, https://aq.dev/compare/, https://aq.dev/multiplayer-coding-agents/
- **Threat level:** High for the "humans watch/steer agents together" wedge. It is the direct competitor to M9R's current product.

### Tutti (tutti.sh)
- **What it is:** Tutti VM, "multi-user, multi-agent real-time collaboration space": local agents and teammates' agents join one shared cloud Room, editing in parallel with conflict avoidance; Agent Board shows every agent's activity. Agents run on your machine in a managed local VM; only working state is shared. Supports Claude Code, Codex, Cursor, OpenCode subscriptions; built-in Tutti Agent otherwise. Open-source version on GitHub (tutti-os/tutti).
- **Access/pricing:** Early access launched 2026-08-27 (PR Newswire, Hong Kong), invite-only, free for now, seat-based pricing planned; founder Tan Zeng. Funding: UNVERIFIED. SDK/enterprise planned.
- **Primitive:** Room. **BYO:** Yes. **Borrowing:** lend your agent to a teammate, room-scoped and revocable. **Cross-org:** same-room invites; org-level detail UNVERIFIED.
- Sources: https://tutti.sh/en, https://www.prnewswire.com/news-releases/tutti--vm-launches-in-early-access-the-google-docs-moment-for-cross-agent-collaboration-302857189.html, https://github.com/tutti-os/tutti
- **Threat level:** Highest overall. It has BYO-subscription, local execution, revocable agent lending, open source and a very recent launch; it is the closest to M9R's "grants" idea.

### Nebula (nebula.gg) and NeuBird (possible NeublaAI intents)
- Nebula: "multiplayer AI workspace" where a team and AI agents share channels, context and goals (macOS/Windows/Linux/iOS/Android). Pricing, BYO, security not stated. Source: https://www.nebula.gg/. Likely a general-work product, not coding-session fabric.
- NeuBird: production-ops agent, raised $19.3M per a secondary source (https://ventureburn.com/neubird-ai-raises-19-3m/). Not a competitor.

### Others requested (Cursor, Devin, Copilot agent, Claude Code remote, Codex cloud, Warp, Zed, Conductor, Vibe Kanban, Superset)
Not researched in this pass. No evidence gathered, so none are profiled. The AQ compare page (https://aq.dev/compare/) claims comparisons against 20+ tools and is a good next source (vendor-authored, treat as biased).

## Feature matrix vs M9R

Note: "M9R" column reflects the brief you gave me plus current product as described, not verified against code. Competitor cells are from landing pages only.

| Capability | M9R | Mosaic | Plasma | Band | AQ | Tutti |
|---|---|---|---|---|---|---|
| Live human + agent shared sessions | Yes (channels, PTY) | No (memory sync) | Partial (watch/guide) | Partial (rooms) | Yes | Yes |
| Identity / handles | Yes | Unknown | Unknown | Yes (handles) | Unknown | Unknown |
| Presence | Yes | Unknown | Unknown | Unknown | Partial (shared workspace) | Partial (Agent Board) |
| Direct messaging / @mention agents | Yes | No | Yes (Radio) | Yes | Unknown | Partial (room chat) |
| Bring-your-own subscription | Yes | Unknown | Unknown | Unknown (SDK) | Yes | Yes |
| Local session, not replaced | Yes | Partial (syncs sessions) | Unknown | Partial (adapters) | No (cloud VM) | Yes (local VM) |
| Bounded context capsules | Planned/Partial | Partial (shared store, unbounded?) | Partial (Wiki) | Partial (memory) | Unknown | Partial (room state) |
| Capability grants | Planned/Partial | Unknown | Partial (permissions) | Partial (control plane) | Unknown | Partial (room-scoped revocable lending) |
| Control transfer (observe/steer/take) | Yes | No | Partial | Unknown | Yes (steer) | Partial |
| Receipts / audit | Partial | Partial (history) | Yes (audit trail) | Yes (audit trail) | Unknown | Unknown |
| Cross-org / cross-user | Yes (invite links) | Unknown | Unknown | Partial | Unknown | Partial |
| Reputation / marketplace | Later | No | Unknown | Unknown | No | Unknown |
| Funding public | n/a | UNVERIFIED | UNVERIFIED | $17M seed | UNVERIFIED | UNVERIFIED |

## Where M9R is actually differentiated
1. Combination, not any single feature: identity + presence + messaging + steer/take-control + grants + receipts across arbitrary existing sessions. No competitor page I read claims all of these.
2. Provider-neutral and non-replacing: Band is closest on "don't change runtimes", but is SDK/framework oriented; AQ replaces the runtime location (cloud VM); Tutti wraps agents in a managed VM.
3. Cross-user/cross-org by design (invite links, machine calls) versus room-bound sharing in Tutti and workspace-bound in AQ.
4. Explicit control-transfer semantics (observe / steer / take control) are a sharper primitive than "anyone can steer".

## Where M9R is behind or exposed
1. Tutti already ships BYO-subscription local agents with revocable lending, open source, and a press launch (2026-08-27). That overlaps M9R's grants story and is easy to describe.
2. Band has $17M, a published SDK, docs, pricing tiers and enterprise traction. M9R has no comparable public funding or SDK evidence.
3. AQ has a clear price, a compare page and SEO content; it owns the "multiplayer coding agents" phrase.
4. Mosaic frames "shared context, not agent org chart" and has traction numbers with a 2-person team; its message is simple.
5. "You shouldn't need to open M9R" is hard to demonstrate and hard to market versus a visible Room/workspace.
6. M9R's grants, capsules and reputation are partly planned; competitors' claims of permissions and audit are already on their sites.

## What to build/say next (prioritized)
1. Ship a 60-second demo: two people, two different vendors' live sessions, one @mention, one take-control, one receipt. Proof beats positioning.
2. Publish the primitive list and protocol/SDK docs (identity, presence, capsule, grant, receipt) to match Band's and Tutti's open surface.
3. Make revocable, scoped capability grants shippable and demonstrable now; Tutti's lending is the benchmark.
4. Ship receipts as a visible artifact (who did what under which grant); Band and Plasma already claim audit.
5. Write a comparison page (AQ-style, factual) covering Tutti, Band, AQ, Mosaic; be accurate about cloud vs local.
6. Ship a context-capsule feature explicitly bounded (size/scope/expiry) as the answer to Mosaic's shared store.
7. Add a "no M9R UI needed" path: CLI/MCP integrations where a Claude Code/Codex user gets presence and mentions with zero dashboard.
8. Publish pricing that says BYO-subscription, no token markup (AQ and Tutti already do).

## What we could not verify
- NeublaAI: could not identify any matching product; do not treat as a competitor until the user supplies a URL.
- Funding for Mosaic, Plasma, AQ, Tutti; team and customers for Plasma, AQ.
- Whether Band supports live local CLI sessions or human takeover; Band's cross-org model detail.
- Security models (isolation, secrets, sandboxing) for all six; only marketing claims were seen.
- Pricing for Mosaic, Plasma, Tutti beyond "free early access / seat-based planned".
- Whether Mosaic supports real-time messaging or control transfer.
- The "YC added multiplayer AI to Request for Startups" claim (Mosaic's own copy; not checked against YC).
- All "others" (Cursor, Devin, Copilot agent, Claude Code remote, Codex cloud, Warp, Zed, Conductor, Vibe Kanban, Superset).
- M9R's own column was not verified against the repository.
