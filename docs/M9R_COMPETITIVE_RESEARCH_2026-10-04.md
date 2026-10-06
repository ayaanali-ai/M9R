# M9R competitor and ecosystem research

**Research date:** 2026-10-04<br>
**Scope:** Agent-Native, Cua, Browser Use, adjacent team-agent coordination, personal-agent surfaces, and CopilotKit's open-source agent templates.<br>
**Mode:** Research only. No implementation, dependency changes, deployments, or external actions were made.

**Purpose:** Compare nearby products to learn from their product choices, architecture, distribution, and limits, then decide what M9R should build or adapt. This is not a response to a claim by the user that no multiplayer agents exist. No product is labeled “first” or “only” here without direct evidence.

## Executive readout

### The market picture

The comparison shows several different kinds of agent collaboration and computer sharing. They are useful references, but their advertised features are not interchangeable:

- Cua offers Cua Spaces, persistent agents, shared/remote computers, streamed desktops, human takeover, and CuaBot's multi-player computer-use experience.
- Grok Bot documents Bots that run in parallel, message one another, participate in group chats, and transfer task ownership. Team Bots are shared with a team while each member keeps a separate conversation.
- Agent-Native documents app-to-app A2A, cross-app delegation, agent teams, organization membership, and sharing permissions.
- Ando launched from stealth on September 24, 2026 with agent-agnostic channels, DMs, group conversations, live Jams, persistent agent identity, permissions, and shared context. Its launch announcement names Codex, Claude, and Grok Bot as supported agent examples.
- Browser Use has a team-of-browser-agents desktop app and an existing-agent CLI that works with local Chrome, a cloud browser, or a CDP endpoint.

These products do not all solve the same problem. The M9R target to evaluate is separately owned personal-agent instances under different human/provider accounts coordinating a shared goal, with owner consent, per-agent authority, revocation, and an audit trail. Public product pages help identify what to study; they do not prove that another product either does or does not satisfy the full scenario. Test the actual product flows before describing a gap or advantage.

### What each company actually is

| Name | What it is | Closest overlap with M9R |
|---|---|---|
| Agent-Native | Builder.io's open-source TypeScript application framework. “Agent Native” is an ambiguous name shared by unrelated businesses. | Shared action surface, app state, org/member permissions, and A2A between agent-native apps. |
| Cua | Open-source computer-use infrastructure company with driver, sandbox, fleet, benchmark, and Spaces products. | Windows/desktop control, streamed computers, persistent agents, human takeover, multiplayer computer use. |
| Browser Use | Open-source browser-agent project plus commercial browser infrastructure and hosted agent services. | Browser interaction, existing Chrome/CDP connection, cloud browsers, agent CLI, and desktop browser-agent team. |
| Ando | Agent-native team messaging product, launched publicly from stealth in September 2026. | The strongest direct overlap in agent identity, cross-harness participation, shared conversations, context, and team coordination. |

### The code decision

The current repository's Cua wave plan says C5 is a **compatibility report**, not a Cua Driver integration, and says M9R's browser control is still its own CDP broker. The C5 report records a Windows test of npm package 0.33.2; it does not show that Cua Driver is installed as an M9R runtime dependency, that all actions work, or that current upstream Windows behavior matches that tested package. The current wave-plan source of truth records C1 as signed off, C2 as signed off, and C3 as partial pending the Cloudflare build/deployment and two-machine frame proof.

The safe starting point is the narrow MIT-licensed Cua Driver and its supported SDK/CLI boundary, pinned and isolated behind the M9R local Windows runtime. That is a recommendation for the next implementation task, not something done here. Do not copy the Cua Spaces app, cua-spacesd, Keyvault, teleport, Volume, or streaming implementation under the current project rule; those are source-available under FSL-1.1-MIT. Do not install, redistribute, or host the AGPL perception extension or cua-som.

### The M9R product hypothesis to test

The product hypothesis to test is:

> M9R lets people keep their existing personal agents and coordinate a specific task across owners and providers, with explicit membership, scoped authority, shared web state, human handoffs, and revocation.

This is a statement of the target product, not a novelty claim. Test it with an actual cross-owner task—for example, separate personal agents jointly coordinating a consented browser task while preserving each owner's account boundary and attributing every action. Ando, Cua, and the personal-agent vendors should be studied through their real onboarding and permissions flows, not treated as straw competitors.

## 1. Identity ambiguity: “Agent Native”

There are several unrelated products using this name. This report treats **Agent-Native at agent-native.com and github.com/BuilderIO/agent-native** as the relevant competitor because it is a public agent framework with A2A and connected agent teams. If a different Agent Native was intended, the exact URL is needed to avoid mixing companies.

The separate **agentnative.dev** is a training, books, and AI engineering jobs platform. Other similarly named sites describe consulting services. They are not the same product as Builder.io's framework.

### Product and purpose

Agent-Native presents itself as a framework for applications where the UI and agent use the same application actions and data. Its stated aim is to keep the agent inside the app contract rather than bolt a separate chatbot onto an application.

The framework's main primitive is a shared action definition. The same application action can be surfaced to the agent, React UI, HTTP clients, MCP, A2A, and CLI. It describes SQL-backed shared application state, embedded agent chat, skills and memory, scheduled work, user accounts, organization membership, resource sharing, permissions, and customizable web/mobile/desktop app templates.

Its A2A documentation describes remote agent discovery using an agent card and JSON-RPC tasks. The docs distinguish A2A—asking another agent to reason and do work—from MCP—letting an outside agent call an application's tool. The framework also describes Dispatch for routing an inbound task to the appropriate app's agent.

### Business, public status, traction, and unknowns

- The framework repository is in Builder.io's public GitHub organization and has substantial visible development activity. The product is presented as an open-source framework rather than a standalone consumer-agent company.
- I found no reliable Agent-Native-specific user count, revenue, funding, or enterprise-customer figure. Builder.io's company metrics cannot be assigned to this framework.
- The framework is publicly developed, with public docs, templates, a CLI, and commits; it is not presented as a stealth product.
- License correction: an earlier reading of `AGENTS.md` attributed its “currently declares no license” sentence to the Agent-Native framework; that sentence is about the optional Clay CLI/MCP plugin, not this framework. Builder.io's own post calls Agent-Native Design MIT-licensed and points readers to this repository, while GitHub does not currently show a recognized repository license badge. Treat the official MIT statement as a positive signal, but verify the exact source revision and license file before vendoring code; the earlier report's categorical “no license” conclusion was unsupported.

### Limitations and M9R implications

- The A2A standard/interface is not a complete human-consent, cross-owner policy system. A2A exposes capabilities and transports tasks; an application still has to decide who may contact which agent, what data is shared, which actions require approval, and how access is revoked.
- Agent-Native's documented sharing and organization model is about apps/workspaces. Its public docs do not establish that its framework is a consumer network for two unrelated people's private Muse/Dots-style agents.
- Conversely, because it already documents A2A and agent teams, M9R cannot claim that its mere use of MCP or A2A is a unique interoperability layer.
- Its framework can be a useful reference for adapter shape and shared action semantics. The product's MIT statement should be reconciled with the repository's current license metadata before code is reused.

**Primary sources:** [Agent-Native framework](https://www.agent-native.com/), [Builder.io's Agent-Native Design licensing statement](https://www.builder.io/blog/agent-native-design-figma-alternative), [actions overview](https://www.agent-native.com/docs/actions-overview/), [A2A protocol](https://www.agent-native.com/docs/a2a-protocol/), [product definition](https://github.com/BuilderIO/agent-native/blob/main/PRODUCT.md), [repository instructions](https://github.com/BuilderIO/agent-native/blob/main/AGENTS.md), and [the distinct agentnative.dev service](https://www.agentnative.dev/).

## 2. Cua

### Company and thesis

Cua's stated premise is “computer is a primitive for agents”: agents need a real desktop, browser, files, and application state to do useful work. The founders describe prior work on Microsoft's Windows Agent Arena and started the company in San Francisco in March 2025; it joined Y Combinator's X25 batch. Cua says it is building open-source, self-hostable computer-use infrastructure.

Its public product progression includes Lume, Cua Cloud, Windows general availability, Cua-Bench, Cua Spaces, persistent agents, and CuaBot. The company lists an approximately eight-person team on its About page. It reports 700+ ClawCon attendees and a 20,000-viewer livestream; those are event-reach numbers, not product-user numbers.

### Product line

| Product | What it does | M9R relevance |
|---|---|---|
| Cua Driver | Local native computer-use driver, exposed through MCP/CLI and application SDKs. Reads app/window state, accessibility trees, pixels, and performs targeted actions. | Best candidate for Windows native-app control. |
| Cua Sandbox / SDK | Creates disposable desktop environments locally or in cloud providers, exposes computer operations and lifecycle APIs. | Isolated execution option; not the same as M9R room/network coordination. |
| Cua Fleets / Cua Cloud | Managed or provider-backed pools for starting desktops, with metered compute. | Competes in hosted browser/computer runtime. Cloud use incurs separate charges. |
| Lume | Native macOS virtual machines on Apple Silicon. | Not Windows code; not the first M9R integration target. |
| Cua-Bench | Computer-use task definitions and evaluation across desktop/mobile environments. | Useful benchmark reference; separate product from runtime. |
| Cua Spaces | App and SDK to register machines/desktops, stream screens, send input, transfer apps/files, and run agents. | Strong overlap in shared computer sessions and watching/takeover. Source-available under FSL-1.1-MIT. |
| Persistent agents | Named harnesses with saved memory, routines, notifications, pause/resume, and explicitly granted access to named computers. | Strong overlap in persistent agents and per-agent computer permissions. |
| CuaBot | CLI that gives coding agents sandboxed Linux desktops. It streams application windows to the host and gives agent and person separate cursors and focus. | Explicit multiplayer computer-use parity; different from a cross-owner agent network. |

### How Cua Driver works, particularly on Windows

Cua Driver is a local runtime, not a Cloudflare Worker feature. Its Windows documentation identifies Win32, UI Automation, native input, and targeted window messages. The driver can be used as an agent MCP/CLI tool or embedded as an application SDK. The current upstream README describes a Rust implementation with Python and TypeScript bindings generated from the same native release artifacts.

The driver's Windows support is deliberately qualified:

- Windows is marked supported for named harnesses including Electron, Tauri, WPF, WinUI 3, and WebView2.
- Some background Chromium gestures and elevated-integrity targets refuse or remain unproven.
- A lower-integrity process cannot inject input into a higher-integrity elevated app.
- A driver running in Session 0 has no normal interactive desktop; the official Windows guide says a GUI user session is required.
- Unsupported paths can return structured refusals, and the driver considers a refusal a passing test only when the harness explicitly expects that exact refusal and the side-effect oracle passes. A refusal is not a successful click/type/scroll/drag.
- The docs list remaining evidence gaps, including broader WPF/WinUI gestures, WebView2 native input, a controlled UIPI refusal fixture, and other platform/harness cases.

This is a substantially richer and newer public description than “a click library.” It is still not a promise that every application supports every background action. Integration needs target-side verification—e.g. a file or DOM value changed—not just a driver response indicating that an event was posted.

### Cua's multiplayer and agent coordination

Cua Spaces already streams a desktop, lets the human watch and use it, allows files/apps to move into a Space, and supports agent runs. The app can register a local, direct, or relay machine. Persistent agents have named homes, routines, pause/resume, notifications, and computer access grants/revokes.

CuaBot is explicitly described as “multi-player computer-use”: each agent gets a sandbox/container, an Xpra display, and a colored cursor/window set; the user can interact with an agent's windows without taking over the agent's cursor. The documented bridge uses X11 inside Docker, Xpra window streaming, and a host daemon that sends actions through a Playwright-controlled Xpra client. Cua's stated next directions include macOS VM support, multi-agent orchestration across sandboxes, and RL training environments.

Therefore Cua is already far beyond a single-computer-use SDK. It is a direct competitor for parts of M9R's C1/C3/C4/C6/C7/C14/C15 ambition. Its public docs do not, by themselves, prove a shared cross-owner family network between separate provider accounts. That is the remaining distinction to test, not an assumed absence of multiplayer.

### Business, adoption, pricing, and unknowns

- Cua is a YC X25 company with an open-source adoption funnel and managed cloud/fleet offerings.
- The public Cua GitHub repository showed about 28K stars when rechecked on October 4, 2026. Stars, event attendance, and livestream views are community signals, not monthly active users or paying accounts.
- I found no first-party public revenue or total registered-user number for Cua.
- The Cua site currently lists fleet rates around $0.044625 per reserved vCPU-hour and $0.0223125 per reserved GiB-hour. Actual billing depends on selected service, resources, idle lifecycle, and account-specific pricing. This is not Cloudflare Workers usage and does not use M9R's Cloudflare startup credits.
- The documentation distinguishes Cua Cloud/Fleets from using one's own AWS/GCP/Modal account. A generic cloud-resources guide says Windows is not offered in that provider-backed sandbox path; the current Cua homepage advertises Windows in its Cua Cloud/Fleet OS catalog. Verify the specific account/product and image before relying on Windows cloud availability.
- Cua Spaces documentation describes the team-machine feature as a waitlist / upcoming capability in some places. Do not assume every team/fleet capability is available on the user's account without checking the live product.

### Licensing: what can and cannot go into M9R

Under the current M9R rule, Cua Driver, SDK, Bench, and Lume are MIT and can be used directly with notices preserved. The official Cua licensing material says most content outside Cua Spaces is MIT unless a subdirectory says otherwise.

The following Cua Spaces components are source-available under FSL-1.1-MIT, with a no-competing-hosted-service restriction until the license converts to MIT after two years: Spaces apps, cua-spacesd, Keyvault, teleport, Cua Volume, and streaming client/codecs/viewers. Our current rule is to learn from behavior but not copy their code.

AGPL components, including cua-som and the optional OmniParser-based perception extension, are excluded. The perception extension's assets can have additional model/runtime notices too. The Driver's default MIT distribution does not include that extension and works without it.

### Recommended Cua integration boundary

1. Pin and integrate only the MIT Cua Driver package/runtime needed for Windows, after inspecting the current release and all transitive/native notices.
2. Keep it in a local Windows agent runtime/companion that runs inside the signed-in interactive desktop session. Do not attempt to run native window control inside a Cloudflare Worker.
3. Keep M9R as the authority: room membership, owner identity, scopes, approvals, one-writer lease, audit, revocation, and remote relay remain M9R decisions. The Driver performs only the local action M9R authorizes.
4. Keep the existing M9R CDP browser path until a target-by-target comparison shows whether Cua Driver improves it. Do not run two independent controllers against the same tab; route each target through exactly one driver under the existing scheduler.
5. Test in a real controlled fixture with a fresh observation, one action, and an independent app-side oracle for click, type, scroll, drag, and screenshot. Record background and foreground behavior separately, plus focus restoration, target identity, minimized/elevated windows, and refusal codes.
6. If a desired action is unsupported upstream, first isolate a minimal reproduction and check whether the limitation is an OS boundary. Do not silently claim it works, weaken M9R authorization, or patch a large Cua source tree without a narrow license and maintenance plan.

**Primary sources:** [Cua company and history](https://cua.ai/about), [Cua Driver platform support](https://cua.ai/docs/cua-driver/concepts/platform-support), [Cua Driver README and integration surfaces](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md), [Cua Driver test matrix](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/test-matrix.md), [Cua Windows explanation and failure boundaries](https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md), [Cua Spaces](https://cua.ai/docs/spaces), [persistent agents](https://cua.ai/docs/spaces/guides/persistent-agents), [CuaBot multiplayer implementation and stated roadmap](https://github.com/trycua/cua/blob/main/blog/clawcon-multiplayer.md), [Cua licensing](https://github.com/trycua/cua/blob/main/LICENSING.md), [Cua current fleet price page](https://cua.ai/), and [provider-backed cloud limits](https://cua.ai/docs/cua-sdk/guides/your-cloud-resources).

## 3. Browser Use

### Company and product thesis

Browser Use started as an open-source browser-agent library. The company now presents two distinct commercial offerings—hosted web agents and managed browser infrastructure—alongside its MIT library and local CLI. The team explicitly frames its approach around making website structure and actions more legible to models, while its newer CLI lets a coding agent write browser-control code directly rather than choose only from a fixed list of low-level actions.

This matters for M9R because Browser Use is not just an agent framework. It provides a ready-to-use route to a user's local Chrome, any CDP endpoint, and its own hosted browsers; it has a Windows desktop app and team-browser-agent pitch.

### Product surfaces

- **Open-source Python/TypeScript library:** Build an agent with a chosen model and local or cloud browser. The library is MIT; inference and hosted browsers are separately billed.
- **Browser Use CLI / Browser Harness:** Installs an agent skill and connects Claude Code, Codex, Cursor, Gemini CLI, Pi, OpenClaw, Hermes, and other shell-capable agents to local Chrome, a Browser Use cloud browser, or arbitrary CDP. CLI 3.0 lets the agent generate and run Python against the browser.
- **Local browser MCP:** Exposes browser helpers over stdio for the logged-in local Chrome.
- **Cloud browser infrastructure:** Hosted Chromium with CDP access, live-view URL, browser profiles, proxy/anti-bot options, CAPTCHA handling, and recording controls.
- **Hosted agent API / Browser Harness:** Send a task and receive an agent result, status, spend information, and follow-up/interrupt behavior. It can run the agent as well as host the browser.
- **Browser Use Desktop:** MIT Windows x64/macOS/Linux desktop app. It preserves normal Chrome, copies cookies into a separate Chromium, starts tasks via keyboard shortcut, advertises Claude Code and Codex providers, and supports WhatsApp messages that trigger agent sessions.
- **Browser Use Box (BUX):** Publicly described as a 24/7 remote VM with Claude Code and Browser Harness, accessible through Telegram, web, or SSH.

The main separation is important: local Chrome is a user-owned browser-control surface; Cloud is an externally hosted paid execution environment; Browser Use Agents can also run the model/agent loop. M9R would be integrating against a third-party service if it used the latter two.

### Business, adoption, pricing, and claims

- Browser Use publicly announced a $17M seed round in March 2025, led by Felicis with a group of other investors.
- Its current careers page says the company has six people, $17M raised, 110K+ GitHub stars, and an eight-figure annualized run rate. These are first-party company claims, not independently audited financial statements.
- The product homepage currently reports 117K GitHub stars and 7.4M monthly downloads. These are strong developer-distribution signals; stars and downloads are not unique active users or customer accounts.
- The site advertises cloud browsers at $0.02/browser-hour plus traffic, a $5 minimum top-up, non-expiring credits, high-quality residential proxy traffic at $5/GB, or direct/own-proxy traffic at $0.20/GB. Hosted agent execution adds model cost plus a 20% service fee. Pricing can change and should be checked before integration.
- Browser Use also publishes its own benchmarks, including an internal 106-task agent benchmark and a 71-site protected-site benchmark. These are vendor-run comparisons; treat them as marketing evidence until the methodology and independent replication are reviewed.
- The project is developed publicly. It is clearly past the stealth stage; the company publishes product, engineering, benchmark, pricing, and recruiting materials.

### Roadmap and known limitations

There is no single public dated roadmap found. The active product direction is visible from its changelog: Browser Harness API v4, CLI 3.0, local/cloud browser switching, managed browser sessions, recording controls, profile access, coding-agent support, and cloud reliability/pricing updates.

Known product boundaries and issues to evaluate:

- Cloud browsing and model use incur charges; browser-hour pricing alone does not include traffic/proxy or model expense.
- A synced browser profile is not the same as a complete portable Chrome user profile. Confirm exactly which cookies, local storage, extensions, device-bound credentials, and site reauthentication requirements are supported before relying on it.
- The desktop application uses a fresh Chromium profile populated from Chrome cookies. That is a separate browser instance and a separate trust/security boundary from the user's ordinary Chrome.
- Public issue trackers include user reports about Windows installation/update behavior and input/IME edge cases. They are reports, not confirmed generally reproducible defects; check exact issue status and reproduce against the pinned version before treating any as a product-wide bug.
- Cloud anti-bot and CAPTCHA features may be incompatible with a site's terms or security expectations. A relay product should not make stealth a default or disguise automation.
- The company emphasizes an agent-writing-code browser harness. That is flexible, but it expands the consequences of mistakes and makes a separate authority/approval layer more important.

### Overlap with M9R

Direct overlap: C1's agent-owned Chrome, a CLI connection to coding agents, local browser access, persistent profiles, and browser infrastructure. It also overlaps C10's hosted browser feasibility question. Its product can help make a user's browser useful to an existing coding agent today.

The potential M9R distinction is not “we have a browser agent too.” It would have to be shared execution across separately owned agents/people, with M9R's shared room state, explicit viewer/action separation, one-writer lease, owner approvals, and revocation. That distinction is a product test, not an assumption based on the Browser Use website.

**Primary sources:** [Browser Use overview and public metrics](https://browser-use.com/), [funding announcement](https://browser-use.com/posts/seed-round), [company team/ARR claims](https://browser-use.com/careers), [pricing](https://browser-use.com/pricing), [coding-agent CLI](https://browser-use.com/coding-agents), [developer platform](https://browser-use.com/developers), [desktop app README](https://github.com/browser-use/desktop/blob/main/README.md), [current changelog](https://browser-use.com/changelog), and [MIT library repository](https://github.com/browser-use/browser-use).

## 4. The closest additional competitor: Ando

Ando was not in the three names requested, but excluding it would make this report materially incomplete. It is the closest direct comparison to M9R's proposed coordination layer.

### What Ando is building

Ando describes itself as a new team messaging platform designed for humans and agents to work together. It has channels, DMs, group conversations, threads, and live conversations called Jams. Agents can have persistent identity, permissions, and shared workspace context, participate proactively, join conversations, and work from multiple harnesses. Its public examples use Codex, Claude, and Grok Bot in one team workflow.

Ando's founder says the company began after seeing teams bring agents into Slack but run into the limitations of treating agents as apps rather than team members. The stated thesis is a new coordination layer for work, not a chat wrapper. Ando says Slack is a bridge and its APIs/developer tools should keep context portable.

### Public stage, users, and business

- Ando announced a $20M seed led by Accel, Index Ventures, and Emergence Capital on September 24, 2026; its announcement also names Contrary Capital.
- It said it had emerged from almost a year of stealth and that early teams across 12 countries were using it. It also says its own team has worked in Ando since January.
- The 12-country statement is reach, not a team/customer/user count. No verified MAU, paid seat count, ARR, or retention number was disclosed in the launch material.
- Its site says access is through a waitlist, works best for teams of up to 30 humans, and is onboarding early users. Its founder's introduction said pricing was per human seat at that stage, with no agent message/action metering.
- The current site describes APIs and developer tools as a way to use the team's context elsewhere. An official TypeScript SDK is published for platform APIs, including connected user accounts. That is a meaningful integration surface, not proof of an open protocol for any personal agent.
- Ando's security page says SOC 2 Type I was completed in July 2026 and SOC 2 Type II observation was in progress. The underlying report is only available to qualified customers/prospects on request.

### Why it matters and where M9R must distinguish

Ando invalidates the generic “agent-agnostic team messaging does not exist” narrative. It is designed around agents as workspace members, shared channel context, and agent collaboration.

Potential boundary to investigate, not to assert as fact:

- Ando is centered on teams and organizations; M9R's scope is explicitly personal agents across distinct humans, including family/friends and separately controlled accounts.
- M9R also proposes coordinating a shared computer/web session, not only conversations and task messages.
- M9R's identity/network model may need to work without every human adopting the same messaging app or workspace.

These are hypotheses. Ando says it supports cloud and local agents from anywhere and wants an open agent ecosystem; it could close some or all of these gaps. M9R needs a hands-on comparison and a real two-owner interoperability demo before making an “advantage” claim.

**Primary sources:** [Ando launch and $20M seed announcement](https://www.globenewswire.com/news-release/2026/9/24/3368344/0/en/ando-launches-agent-native-messaging-platform-announces-20-million-seed.html), [Ando product and audience](https://www.ando.so/), [founder's product explanation and agent examples](https://www.ando.so/blog/introducing-ando), [security posture](https://www.ando.so/security), and [Ando platform SDK](https://www.npmjs.com/package/@ando-ai/sdk).

## 5. Personal-agent products: what users can already do

The key user-facing agents are not blank shells. Each has its own computer, messaging surfaces, connectors, permissions, or internal collaboration features. Integration access is the hard part.

### Meta Muse

Meta describes Muse as a persistent personal agent that can work on goals and tasks, use a dedicated Muse Secure VM with its own browser, and communicate in the Muse app or WhatsApp. It can perform tasks through apps and websites, learn from context, and run proactively, subject to user controls.

Meta's Connector Platform is a real distribution door, but it is a reviewed one. Submission asks for a working connector with value beyond plain browsing, user data minimization, clear read/write/sensitive classifications, test credentials, documented scopes/errors/side effects, and full end-to-end QA. Sensitive writes require fresh approval each time; a connector submission is not guaranteed approval or featuring.

**M9R consequence:** A connector submission may be worthwhile when M9R's network/event tools are stable, but it will not replace the neutral self-onboarding path and cannot be treated as automatic access to Muse.

Sources: [Muse launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) and [Muse connector guidelines](https://muse.ai/platform/docs).

### OpenAI Dots

OpenAI's current docs describe Dots as always-on agents with cloud computers and browsers, connected apps, background work, and a review loop when judgment is needed. A user may connect one personal computer at a time; local computer use requires the computer online and the ChatGPT app open. Dots can work through their cloud computer while the user's devices are off. ChatGPT Spaces adds collaboration around files/pages, but that is not the same thing as letting a separate human's personal Dot join a neutral network.

Availability is rolling out to eligible accounts; don't rely on old assumptions that a particular plan or integration is universally available. The docs describe account, computer, and task controls but do not document a general-purpose federation API for arbitrary third-party agents.

Sources: [Dots and connected computers/apps](https://learn.chatgpt.com/docs/dots/computers-and-apps), [DevDay 2026 product notes](https://learn.chatgpt.com/docs/whats-new/devday-2026), and [local computer access](https://learn.chatgpt.com/docs/enterprise/cloud-local-access).

### xAI/Cursor Grok Bot

The current official docs are much more collaborative than the older “one personal bot in one account” framing:

- Each Bot is a persistent teammate with a role, memory, browser, filesystem, terminal, connectors, and routines.
- Bots can run in parallel, message one another, share context in group chats, and transfer task ownership.
- Users can create group chats with multiple Bots and see their handoffs.
- Team Bots let an owner publish a shared bot to teammates. Teammates have separate conversations and personal notes, while the team bot has shared team memory and setup.
- Team Bots can be reached from the app and Slack. In different conversation types, the Bot uses a user's own computer or a shared computer; connector approvals and account identity vary by context.
- Current documentation says Grok Bot is included with paid Cursor individual and team plans, and can also be linked to certain SuperGrok subscriptions. Availability is plan/account-dependent.

This is intra-Grok/Cursor collaboration and shared team-bot capability. It is not evidence of a neutral protocol connecting a personal Grok Bot to an unrelated person's Muse or Dot. It does mean M9R cannot claim agents working together is novel.

Sources: [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [message and handoff behavior](https://docs.x.ai/grok-bot/chat-and-collaboration), [Team Bots](https://docs.x.ai/grok-bot/team-bots), and [plans/admin access](https://docs.x.ai/grok-bot/teams-and-enterprises).

### Instinct

Instinct's official public page describes a personal assistant reachable by text or phone, connecting to email, messaging, screen, audio, location, and other applications/devices. It presents the experience as “no new interface”: a dedicated agent computer uses tools in ways similar to a person.

Public information is much thinner than for Muse/Dots/Grok Bot. I found no public MCP/API, connector SDK, open protocol, or third-party agent joining flow in the sources reviewed. That is a limit of available public evidence, not proof that no private integration exists. Treat Instinct integration as unverified until an authorized connection surface is documented or confirmed; do not infer one from its use of SMS or email.

Sources: [Instinct official site](https://instinct.com/). Third-party teardown/review claims about legal terms, access, performance, and funding were not treated as verified because the company has not published matching technical/API specifications in its public docs.

### Practical integration order

For an M9R proof that does not depend on approval from a closed vendor:

1. Run two separate open agent instances for two distinct owners. Give them separate auth, memory, runtime, and computer profiles.
2. Connect each to M9R using the same documented neutral surface; pair one agent to one network identity per owner.
3. Make them send, receive, assign, and acknowledge a real shared task; then have the humans watch or approve a shared browser step.
4. Demonstrate that one owner's credentials and private memory are never silently copied to the other owner.
5. Revoke one member and show that its next network action is denied, while the other owner can still read the permitted history.
6. Label the demo accurately: “Open-source agent harnesses connected through M9R,” not “the official Muse/Dots/Grok Bot integration,” unless official vendor paths were approved and used.

## 6. CopilotKit templates: OpenMuse, OpenDots, and OpenBot

These are useful open-source implementation references, but they are not official open-source clones of Meta Muse, OpenAI Dots, or Grok Bot. They are CopilotKit/AG-UI-based templates that provide a similar product shape and can be adapted. The current repositories publish MIT licenses; retain their notices and identify the products accurately. An MIT source license does not establish vendor endorsement or automatically grant trademark/logo rights.

### OpenMuse

The current public roadmap labels it a personal-agent alpha. Shipped local capabilities include mobile/web chat, durable jobs and plans, checkpoints/leases/retries/cancellation, action receipts, goals, persistent Chromium, screenshots and interaction, a private Docker Linux computer, file/PDF flows, memory, and reviewed Gmail/Calendar adapters.

The current repository includes an optional OpenBot HTTP adapter that is disabled and contract-tested against upstream interfaces. A live user/session bridge, routine mapping, and computer-backend wiring remain future work. The roadmap also lists live OAuth/mail/calendar acceptance, cross-device rich-thread persistence, live model acceptance, and device tests. The current Linux computer is a single-owner deployment; multi-user authentication and deployment hardening remain future work.

**Use:** A good candidate for a controlled two-owner M9R demo after each deployment is separately secured and the integration is real. It is not evidence that a production-ready multi-tenant personal-agent network already exists.

Source: [OpenMuse roadmap](https://github.com/CopilotKit/openmuse/blob/main/ROADMAP.md), [README architecture](https://github.com/CopilotKit/openmuse), [security policy](https://github.com/CopilotKit/openmuse/security).

### OpenDots

OpenDots is an application template under development, not a hosted agent service. Its docs describe text, voice, Slack, persistent per-Dot computers, and CopilotKit Conversations/Intelligence. Its own SECURITY.md explicitly says the local prototype is single-owner; Space membership, Slack identity mapping, and voice delegation need more server-side enforcement before connected multi-user use; it is not a security-audited autonomous agent.

**Use:** Suitable for isolated local experiments. Do not put two real people into one deployed OpenDots instance as a cross-owner demo until the identity and authorization boundaries have actually been added and reviewed.

Sources: [OpenDots repository](https://github.com/CopilotKit/OpenDots), [security warning](https://github.com/CopilotKit/OpenDots/blob/main/SECURITY.md), and [computer setup](https://github.com/CopilotKit/OpenDots/blob/main/docs/COMPUTERS.md).

### OpenBot

OpenBot is a self-hostable AI-coworker template built around an AG-UI agent endpoint, a React client, a Hono API, PostgreSQL, CopilotKit Intelligence, policy-controlled tools, and one isolated Chromium/computer workspace per Bot. The server gateway decides tool calls against policy, audits decisions, and can refuse them; human takeover blocks Bot actions. It can connect different agent frameworks if they speak AG-UI.

OpenBot is not Grok Bot. It is a customizable template, not a hosted vendor service, and requires its own infrastructure/model/runtime setup. Its design provides useful code for a local controlled demo, but one must inspect each deployment boundary, credentials, shared browser/computer behavior, and multi-user authorization.

Sources: [OpenBot README](https://github.com/CopilotKit/OpenBot), [architecture](https://github.com/CopilotKit/OpenBot/blob/main/docs/architecture.md), [configuration](https://github.com/CopilotKit/OpenBot/blob/main/docs/configuration.md).

### What AG-UI does and does not give M9R

AG-UI is a way for a client/runtime to exchange agent events and UI state. It does not automatically supply M9R's network identity, pairing, per-owner consent, cross-human permissions, room event delivery, revoke semantics, or shared computer lease. CopilotKit templates can be adapter targets; the M9R network/policy remains its own layer.

### How to compose OpenMuse, OpenDots, and OpenBot without replacing them

Keep the three upstream projects and their product identities. Add a thin M9R network connection to each agent runtime: pair each running agent as its own network identity, then let that agent call `send`, `inbox`, `roster`, and the appropriate task/approval tools. Prefer the existing M9R MCP door when that template's agent runtime can consume it; otherwise use a small native adapter that calls the same M9R Cloudflare API. Do not treat AG-UI events alone as cross-agent transport.

For the first two-owner demo, give each human a separately authenticated deployment/profile and keep memory, provider credentials, browser profiles, and computer workspaces isolated. Until each template's multi-user boundary has been independently reviewed, use separate owner deployments rather than sharing a single-owner instance. A phone-friendly M9R group/thread view can display the three named agents and their actual network events; it is a window onto the network, not a new personal agent. The demo must show at least one message/task flowing through M9R without a human copying it between apps, then show owner approval and revocation. Identify these as the independent Open* templates, never as official Meta/OpenAI/xAI integrations.

The open-source templates remove the need for those vendors' closed connector approvals, but not the need to configure and pay for whichever model, database, container, and hosting services each template uses. Cloudflare startup credits can cover eligible M9R Cloudflare resources; they do not automatically cover model-provider or template-infrastructure bills.

## 7. Comparative view

| Capability | Agent-Native | Cua | Browser Use | Ando | M9R target |
|---|---|---|---|---|---|
| Existing agent harnesses supported | App-framework centered; MCP/A2A/client surfaces | Many coding-agent harnesses via MCP/CLI and Cua agent APIs | Many coding agents via CLI/MCP | Says bring agents built anywhere, plus its own harness | Provider-neutral doors and adapters |
| Cross-agent conversation/task handoff | A2A/app teams and dispatch | Agent messaging/parallel runs, CuaBot orchestration direction | Mostly agent-to-browser; team desktop app triggers sessions | First-class messaging, channels, Jams, agent identity/context | Network events among separately owned personal agents |
| Shared computer/desktop | App computer layer, configured runtimes | Core product; Spaces and CuaBot | Browser-only/local or hosted browser | Messaging/context is the center; computer execution varies by connected harness | Shared controlled web/room state |
| Windows desktop control | Not core product | Cua Driver native Windows support with limits | Browser on local Chrome or cloud Chromium; not general native control | Depends on the agent/harness | Local Windows companion/driver if scoped |
| Human watch/takeover | App UI and action approvals | Explicit stream and takeover, per-agent cursor | Live browser view and separate app-owned browser | Live conversation and Jams | Read-only viewer plus scoped approvals/control handoff |
| Identity/permissions | App/org/user membership and action guards | Agent grants and computer access; per-account scope | Browser profiles, cloud API keys, service policies | Agent/workspace identity and channel permissions | Personal-owner membership and immediate network revoke |
| License posture | Builder.io calls Agent-Native Design MIT; repository license metadata needs exact-revision verification | MIT Driver/SDK/Bench/Lume; Spaces FSL; optional AGPL areas | MIT library/desktop; paid hosted services | Hosted product; public API/SDK, not open-source platform | M9R-owned code, with adapters to compatible public surfaces |

## 8. What M9R needs to prove next

Do not position M9R against these products on a checklist of generic features. Prove the interaction only M9R is trying to deliver:

1. **Different humans, different agent instances.** The first and second users authenticate separately. Each person's agent remains under that person's account, provider, memory, and computer.
2. **A real task crosses that boundary.** Owner A's agent sends an explicit network event or task to Owner B's agent; the second agent receives it and produces a meaningful result. A human or test harness relaying copied text manually does not count.
3. **Shared web work is visible and bounded.** The two owners can inspect one shared tab/task state, but a spectator cannot click/type unless granted control. A live frame changing on a second machine proves streaming only; it does not prove message exchange or safe control.
4. **Every action has an owner and permission.** The event/action log identifies the sender, recipient, room, approval, target, and outcome. Secrets are not copied into messages or viewer payloads.
5. **Revocation has an observable effect.** Revoke one participant and prove its following send/action is denied while authorized members remain functional.
6. **The integration is named honestly.** An OpenBot/OpenMuse demo proves M9R with those templates and their configured model providers. It does not prove official connector access to Muse, Dots, Grok Bot, or Instinct.
7. **Direct product comparison.** Compare a two-owner personal-agent task in M9R against Ando's actual supported onboarding and agent APIs. Record what each product supports and where their workflows differ. Avoid claims based only on public feature pages.

## 9. Current repository evidence and work boundary

At the start of this research, the repository's active Cua wave plan stated:

- C1: signed off; the dedicated agent-owned Chrome path and profile persistence evidence are recorded in the C1 acceptance report.
- C2: done and signed off.
- C3: partial, not signed off; the reviewed Cloudflare Linux build/deployment and two-machine changing-frame proof remain open.
- C5: done as a Windows compatibility report only.
- No Cua Driver package is an M9R runtime dependency; M9R browser input remains the CDP broker.
- Network Core Phase 0 is documented as live and accepted. Phase 1's MCP/self-onboarding implementation is local and tested, but is not deployed or proven with Muse, Dots, Grok Bot, or any Open* template.
- AWARE exists as an early M9R web-coordination specification/reference implementation; its enforcement applies only on paths that call the ledger.

The C5 retest records concrete limitations on the tested package and machine: some Chromium/native actions were refused or unverified in background mode, while screenshots and some click deliveries worked. That report carefully does not call those actions successful. Its sign-off means the compatibility matrix was recorded—not that click, typing, scrolling, and dragging all work on every app or that M9R integrated the driver.

The research request explicitly paused implementation. This report therefore does not install, vendor, wrap, or configure Cua Driver. When implementation resumes, use the current upstream release docs and the integration boundary above; do not assume package 0.33.2 is still the right release just because it was the release tested in the earlier report.

Repository evidence: [current Cua wave plan](M9R_CUA_WAVE_PLAN.md) and [C5 Windows retest](M9R_C5_CUA_DRIVER_WINDOWS_RETEST.md).

## 10. Protocol fit: AWARE and MPAC

“Mpack” is interpreted here as **MPAC**, the Multi-Principal Agent Coordination Protocol in `KaiyangQ/mpac-protocol`. There are similarly named projects, including MACP, so confirm the intended repository before making a protocol decision.

### What AWARE currently covers

The local `aware-spec` describes an M9R web-coordination envelope for attributed, sequenced, causal events such as posts, replies, subscriptions, context sharing, presence, cursor/claim/release, approvals, disclosures, and audit entries. The checked-in wire identifier remains `m9r-web/0`; the spec says a future AWARE identifier must be explicitly versioned. Its schema calls for a separately selected trust profile for signature verification. The reference ledger enforces schema, membership, attribution, disclosure, and spend rules only on execution paths that invoke it; it is not a universal M9R policy engine today.

### What MPAC contributes

The MPAC repository describes a more explicit multi-principal work-coordination model: sessions, intents, operations, conflicts, and governance, with reference implementations and examples for shared-state coordination. Its use is not required to make the existing M9R Network API work. Its public project is early-stage and its demonstrations/coverage claims are maintainer-reported rather than independent adoption evidence. The repository's `LICENSE` is Apache-2.0, while its README still says license terms will be formalized; resolve that inconsistency with the maintainer before vendoring its implementation.

### Recommendation

Do not announce a new protocol or replace AWARE with MPAC yet. Keep the existing M9R Network event API and MCP door as the first interoperability surface. Run a bounded mapping exercise: map an M9R cross-owner task, intent/claim, conflict, approval, action receipt, and revocation into MPAC concepts; separately map shared-browser disclosure, cursor/viewer roles, and action authority to AWARE. If MPAC cleanly covers multi-principal task coordination, prefer an explicit M9R profile or adapter over duplicating intent/conflict semantics. Keep AWARE focused on shared web/desktop execution and disclosure. Before public protocol claims, settle names/versioning, trust/signature verification, conformance tests, and the MPAC license-text mismatch.

**Primary sources:** [M9R AWARE spec and status](../aware-spec/README.md), [AWARE v0 JSON Schema](../aware-spec/schema/aware-web-protocol-v0.schema.json), [MPAC protocol repository](https://github.com/KaiyangQ/mpac-protocol), [MPAC specification](https://github.com/KaiyangQ/mpac-protocol/blob/main/SPEC.md), and [MPAC Apache-2.0 license file](https://github.com/KaiyangQ/mpac-protocol/blob/main/LICENSE).

## 11. Source and confidence notes

- First-party product docs and company posts are used for stated capabilities, company timelines, and advertised prices. They are not independent verification that every capability works in every account or region.
- Company-reported funding, ARR, GitHub stars, download counts, event attendance, and countries reached are labeled as such. None of those is treated as a reliable count of active human users.
- GitHub issues are reports, not verified general product failures. Reproduce them against a pinned release before relying on them.
- Private roadmaps, customer names, actual active-user counts, reliability distributions, unit economics, and account-specific availability are generally not public. This report does not invent them.
- Cua, Browser Use, Ando, and agent products change quickly. Recheck official docs and licenses before implementation, purchasing, or making a competitive claim.
- OpenMuse, OpenDots, and OpenBot are independent CopilotKit templates, not official Meta Muse, OpenAI Dots, or xAI Grok Bot releases. Their MIT source licenses do not imply vendor partnership, production readiness, or permission to use third-party marks beyond truthful identification.

## 12. Reconciliation with the supplied master tracking doc

The master doc is useful for product intent and sequencing, but several competitive lines should not be used as factual or marketing copy without direct testing. In particular, “Cua is single machine/no room sharing,” “we are first/only,” and “nobody stacks all four” are not substantiated by the reviewed sources. The user's objective is to learn from the field and deliver the desired product, not to claim competitors lack multiplayer.

The master doc's “every agent connects via MCP today” is not accurate for the personal-agent goal. M9R Network Phase 1 has a local MCP/web-door implementation, but its own acceptance document says it is not deployed or proven with any consumer personal-agent product. MCP is one connection door; it is not the coordination product and is not currently available in every personal agent.

There are two different “Phase 1” work packages that must stay distinct:

1. **Local room-agent surface — DONE (2026-10-04):** the audit found the intended thin adapter already present. The room HTTP/RPC routes remain the authenticated source for join, membership, events, leases, handoffs, and memory; the local MCP/bridge exposes the equivalent agent surface (`m9r_agents`, `m9r_send`, `m9r_inbox`, `m9r_result`, `m9r_note`, and `m9r_web_*`) with verified room namespacing and broker authorization hooks. No duplicate room store or replacement protocol was added. See [room-agent adapter acceptance](M9R_ROOM_AGENT_ADAPTER_ACCEPTANCE.md). Lease/handoff actions stay in the room API/UI until Track A C4; that is deliberate sequencing, not a missing adapter for step 2.
2. **Personal-agent Network Phase 1:** deploy the existing Cloudflare MCP and `/connect` doors and prove real personal-agent peers can exchange messages under separate owners. This is still local and untested.

The three streams should be tracked separately: (a) coding agents acting together in local M9R rooms; (b) separately owned personal agents using the Cloudflare network; and (c) a local browser/desktop driver plus remote read-only room viewing. C1, C2, and C5 are signed off. C3 remains open and is deliberately deferred until the OS-level stage sequence below; the C5 report is complete but is not an integration or an all-actions-pass result.

**Update, 2026-10-04 (same day, later):** the master roadmap's P0 install-reliability line is now resolved, and the finding changed along the way. Multiple simultaneous `m9r-engine.exe mcp` processes are not a bug to fix with a single-instance lock — MCP over stdio needs one OS process per connected host (Claude Code, Codex, OpenCode each spawn their own), and forcing a single instance would have broken running more than one agent at once, which is the product's entire premise. The real defect: the MCP SDK's `StdioServerTransport` never listens for `stdin` closing, and a Node process commonly does not exit on its own when its pipe EOFs on Windows — so every closed host session left its engine process behind as a permanent orphan with nothing to ever reap it. Fixed by having the process exit immediately on `stdin` `end`/`close` (`scripts/m9r-mcp.ts`). The pill's desktop/extension unification is also done as of today: both surfaces already shared the `pill-next` codebase (gated behind `M9R_PILL_NEXT`, on by default) — the remaining task-duplication bug was a shared `Ticker` component failing to reset its displayed text on an agent-focus switch when the new agent's step index matched the old one, now fixed and verified live.

## 13. Ordered implementation plan

This supersedes the implementation order from the earlier chat reply (not previously written into this file). It keeps that plan's real content but reorders it: the personal-agent-network track (OpenMuse/OpenDots/OpenBot, Ando comparison, MPAC/AWARE mapping) is genuinely useful and stays in the plan, but it runs **parallel to, not ahead of**, M9R's own core product work. Nothing below should stall on it, and it should not stall waiting on the core work either — they are separate owners' tracks that merge at the three-agent demo step.

**Done, as of 2026-10-04 (verified live, not just committed):**

- Install reliability (master P0): the engine orphan-process leak is fixed and verified (see §9 update above), and the stale checkout was merged forward onto current `main` with Codex's in-progress C1–C5 work checkpointed first, nothing lost.
- Pill unification (master P2): desktop and extension already shared one codebase; the task-duplication bug (shared `Ticker` not resetting on focus switch) is fixed and verified live across claude/codex/opencode.

**Track A — core product, in order:**

1. **C1 is signed off:** dedicated agent-owned Chrome profile, sign-in persists across a profile restart, no automation banner, owner's normal Chrome untouched.
2. **Audit/expose the room-agent adapter (master P1):** keep the existing room HTTP/RPC and bridge behavior, and add only the missing agent-facing CLI/MCP names or acceptance proof. This does not block the OS stage.
3. **OS-level stage groundwork (master P3, refined this session):** port the Cua Driver cursor primitive (MIT, build our own implementation); stand up the dedicated Windows virtual-desktop "stage" apps open onto, reusing the OS's native virtual-desktop switching. This is a candidate differentiator to test, not an established market distinction: Cua already documents local and hosted desktop sharing, so the M9R ownership, consent, and transition behavior must be demonstrated before making a uniqueness claim. Extend the room's existing joint-tab ownership model upward through app windows to full desktops — joinable, not exclusively locked — and let an agent move between desktops mid-task (finish on the stage, return to the user's desktop, or move to help another agent), visible as a transition in the live feed. Decide Jev-vs-CUA-S1 (MIT, same "System 1" framing) before this phase's routing/decision-model work starts — porting may be faster and legally clean. C14's desktop-app Driver validation belongs here; C5 is already complete.
4. **C4 — takeover/hand-back:** broker lease, clean agent pause/resume. Build for parity with Cua Spaces; do not present it as a gap Cua has.
5. **C15 — window-pool/tiled stage polish:** once the stage groundwork is real, not before.
6. **C3 remains deferred until after the stage sequence:** then run the reviewed Cloudflare Linux build/deployment; prove two separately authenticated machines in one room, one sharing a tab while the other sees changing frames with no viewer controls. C3 is read-only viewing; takeover is C4.
7. **Everything else in the C6–C13 table below**, roughly in the order listed, after the above — these are real but lower-leverage than the stage work.

**Track B — personal-agent network, parallel, non-blocking:**

1. Connect Open* templates (OpenMuse, OpenDots, OpenBot) as thin M9R network adapters, keeping their own identities — one template at a time, report on each.
2. Real three-agent demo: separate owners, separate credentials/memory/browser/computer per agent, a real cross-owner task exchanged through M9R (not a human copying text between apps), then approval and revocation shown live.
3. Check hosting/cost for each template against the Cloudflare/Supabase-only rule before deploying any of them; Cloudflare credits do not cover model-provider or template-infrastructure bills.
4. Settle AWARE-vs-MPAC protocol boundaries before any public protocol claim — map M9R's intent/claim/conflict/approval/revocation concepts into MPAC, keep AWARE scoped to shared web/desktop execution and disclosure, resolve MPAC's license-text/LICENSE-file inconsistency before vendoring anything from it.

**C4–C15 reference table** (status as recorded by the C1–C5 research and wave-plan scan; update as each lands):

| Item | Current status | Remaining gate |
|---|---|---|
| C4 — takeover/hand-back | Remaining | Broker lease and clean agent pause/resume proof |
| C6 — M9R Space | Partial design | Build the workspace/site/agent/room consent flow |
| C7 — machine enrollment | Partial design | Owner computer registry and location selection |
| C8 — flight recorder | Partial design | Signed, replayable room record and export |
| C9 — scheduled runs | Decision needed | Read `cua-sandbox`/`cua-spaces` before freezing scope |
| C10 — hosted browser | Partial feasibility | Cloudflare Browser Run limits, cost, and sign-in persistence |
| C11 — approved logins | Partial design | Windows DPAPI store and per-domain review |
| C12 — Jev/CUA-S1 | Decision needed | Evaluate CUA-S1 before building a separate decision model |
| C13 — multiplayer benchmark | Partial design | Run and score a two-agent-plus-person task |
| C14 — desktop app control | Remaining | Integrate and validate the Windows Driver path; feeds directly into Track A step 4 |
| C15 — tiled window pool | Partial design | Multi-window stage and lease handoff; feeds directly into Track A step 6 |

### Additional primary references

- [Ando Android product listing](https://play.google.com/store/apps/details?id=so.ando.mobile)
- [Cua provider-backed cloud resources and limitations](https://cua.ai/docs/cua-sdk/guides/your-cloud-resources)
- [Browser Use browser infrastructure/developer API](https://browser-use.com/developers)
- [Browser Use desktop app](https://github.com/browser-use/desktop)
- [Muse review process and sensitive-write requirements](https://muse.ai/platform/docs)
- [Dots local computer requirements](https://learn.chatgpt.com/docs/dots/computers-and-apps)
- [Grok Bot Team Bot memory and connector boundaries](https://docs.x.ai/grok-bot/team-bots)
