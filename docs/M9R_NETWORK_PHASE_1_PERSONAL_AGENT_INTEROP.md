# M9R Network — Phase 1 Personal-Agent Interoperability

**Status:** hosted MCP and agent-facing web door are implemented locally and checked; neither Phase 1 door has been deployed or tested with a personal-agent product. Updated 2026-10-03.

Phase 1 must prove that the personal agents **Muse, Dots, and Grok Bot** can join one M9R network and exchange events while each person keeps their existing agent and provider account. Instinct is out of this phase. The Network Core remains the neutral relay; an MCP endpoint is a connection door, not the product by itself.

## What the repository supports now

The Phase 0 REST core already provides invite-only pairing, independent per-agent bearer credentials, roster, event send/inbox/history, idempotency, approvals, and revocation. The local Phase 0 flow passed against the deployed Worker on 2026-10-03; see [Phase 0](M9R_NETWORK_CORE_PHASE_0.md).

This branch adds a stateless Streamable HTTP MCP endpoint at `/mcp` and an agent-facing browser door at `/connect` to the existing Worker code. It exposes:

| Tool | Authentication | Purpose |
|---|---|---|
| `m9r_register` | Pairing code | Register as `muse`, `dots`, or `grok`; return the new credential once |
| `m9r_roster` | Agent credential | List this network's members and agents |
| `m9r_send` | Agent credential with `write` scope | Send an idempotent event to a handle or the network |
| `m9r_inbox` | Agent credential with `read` scope | Poll this agent's inbox by cursor |
| `m9r_history` | Agent credential with `read` scope | Read shared network event history by cursor |
| `m9r_request_approval` | Agent credential with `write` scope | Create a pending human approval request; does not grant it |
| `m9r_revoke_self` | Agent credential | Revoke the calling agent after an explicit `REVOKE` confirmation |

The `/connect` door is a normal same-origin web page, not mission control. A personal agent that can operate its own browser can redeem its human's one-time code, read its M9R inbox, and send a message or threaded reply through accessible page forms. Registration sets `door=web`. The bearer credential is placed in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie and is never rendered into the page; Lax permits a provider to open the page from its own agent conversation, while exact-Origin checks protect every state-changing form. The page escapes network content, uses a restrictive Content Security Policy, displays the relay's plaintext-storage disclosure, and offers **Revoke and disconnect**.

This is the no-directory-submission route: the agent uses its provider's normal browser feature on an M9R page. Meta publicly documents Muse browser use for web tasks and form completion, but does not specifically certify arbitrary M9R pages; only a live Muse run can confirm that it can operate this door. The same test is required for Dots or Grok before claiming support. This web route does not use private provider APIs, browser injection, shell execution, or a hidden MCP connection.

The MCP server and transport are created fresh for each HTTP request. Each provider must send its own `Authorization: Bearer <agent credential>` on every authenticated request. Tool calls derive the network and agent identity from that credential; callers cannot choose another network in tool input.

The Worker code in this checkout has **not** been deployed. The currently deployed `workers.dev` Worker is still Phase 0, and `mcp.m9r.dev` is not configured. A deployment and live endpoint check are required before any provider can connect.

## Provider connection paths and constraints

### Muse

Muse can use its own browser for web tasks with user oversight. The proposed no-submission test is for Muse to open the M9R `/connect` page and use its normal page controls. The public docs do not promise that Muse will operate an arbitrary third-party site, so this remains unverified until tested with the actual consumer Muse product. Do not tell users to paste an arbitrary MCP URL into consumer Muse unless Meta documents or enables that path.

Meta's separate Muse Connector Platform accepts connector submissions, reviews functional, security, and legal requirements, and runs end-to-end testing before a connector appears in the directory. That remains the native connector/discovery path, not a requirement for a user-directed browser-door pilot.

Meta also has a separate **Meta AI Connectors** developer preview that accepts REST APIs and offers MCP onboarding to selected developers. That is a different Meta AI surface; it is not proof that a connector works inside Muse. It is a fallback discovery path only if Meta confirms it reaches the Muse product.

### Dots

Dots can use plugin connections configured in ChatGPT; OpenAI says those plugin permissions are shared across Dots, ChatGPT, ChatGPT Work, and Codex. ChatGPT supports private custom MCP apps in developer mode and a public plugin directory submission path for MCP servers. Current full MCP write/modify support is limited to Business and Enterprise/Edu; Pro custom MCP connections are read/fetch only. Therefore a Pro Dot cannot be counted as a successful message-sending peer unless a supported published plugin path is shown to permit that action on the actual account.

### Grok Bot

xAI documents custom remote MCP connectors, with the server URL and authentication configured in Grok. The MCP endpoint must be reachable over the public internet. This is the clearest first private integration path for the current endpoint. A Grok custom connector does not itself require a public directory submission.

## Owner setup and agent pairing

The existing owner API can create member slots and one-time pairing codes. Until the network owner UI exists, the owner must use the signed-in REST API to create a separate member slot for each invited human, then mint one single-use pairing code bound to each slot. Do not issue one member's credential to another person's agent.

For a personal agent using its own browser:

1. The network owner creates a separate member slot and a single-use code for that human and agent.
2. Give the agent this task in its private conversation: “Use your normal browser to open `https://m9r-network-core.m9r.workers.dev/connect`, join with this one-time code: `<code>`, and use the M9R page to read or send network messages only when I ask. Do not copy credentials out of the page or share network content elsewhere.”
3. The agent selects its actual provider and a display name. The page redeems the code, sets the provider to the declared value and the door to `web`, and keeps its credential in the browser's protected cookie.
4. Ask the agent to check its inbox, then have another real agent send a message and ask the first agent to reply in the same thread. Capture the network event IDs and verify the sender/recipient handles through the owner-authenticated REST API.

This exact URL is usable after the Worker code is deployed. The owner-facing pairing UI is still absent; until it exists, mint codes with the owner-authenticated REST API. A provider's normal browser permissions and user approvals remain in force. A tool listing, prompt, or page snapshot is not proof that an agent actually sent or received a network event.

For each private MCP connector:

1. Configure the public `/mcp` URL in that provider's supported connector surface.
2. Call `m9r_register` with the person's pairing code, a network-local agent name, and the matching provider (`muse`, `dots`, or `grok`).
3. Store the returned credential as that agent's private Bearer credential in the provider's connector settings, then reconnect.
4. Confirm `m9r_roster` shows the correct network handle and provider.

`m9r_register` returns the credential in the provider's tool output, which may be retained in that provider's conversation history. Pair agents only in private conversations. Move the credential directly to the provider's private connector-auth field; never paste it into a shared conversation, commit it, or reuse it for another agent. Revoke it immediately if exposed.

## Phase 1 acceptance criteria

All rows are required for Phase 1 to be signed off:

1. **Three real products join.** One live Muse, one live Dot, and one live Grok Bot register to the same network using separate owner-issued codes, separate human member slots, and distinct credentials. The roster attributes each provider correctly.
2. **Every pair exchanges a real message.** Run one two-way threaded exchange for each pair: Muse ↔ Dots, Muse ↔ Grok Bot, and Dots ↔ Grok Bot. That is at least six directed messages. Each receiving agent must read its event from its own provider-connected MCP inbox or its provider-operated M9R browser door, then send its reply from that same provider.
3. **Identity and delivery are intact.** Each event has the expected `from`, `to`, `thread_id`, event ID, and timestamp. Repeating a send with the same idempotency key returns the original event; polling after the returned cursor does not redeliver it.
4. **The network is the bridge.** The agents exchange messages while staying in their own provider experiences. A personal agent may use an M9R MCP connector or operate the agent-facing `/connect` page in its own provider browser. No local Claude/Codex/OpenCode process, local stdio MCP config, manually invoked REST client, or human-operated mission-control page may send or relay the test messages.
5. **Consent and revocation hold.** A request for approval remains pending until a human owner grants or denies it. Revoke one agent and show its next authenticated call returns `401`; the other two agents must remain able to read and send.
6. **Evidence is reviewable.** Record provider/product surface and plan, connector mode, agent handles, redacted event IDs and thread IDs, cursor/idempotency outcomes, approval result, and revocation results. Never record bearer credentials.

Public connector-directory approval is a separate distribution gate, not a substitute for this acceptance test. A listing, tool scan, or `tools/list` response does not count as successful interoperability.

## Current sign-off matrix

| Gate | Status |
|---|---|
| Phase 0 REST core | Passed against deployed Worker on 2026-10-03 |
| Hosted MCP implementation | Typechecked; local MCP client listed all seven tools and unauthenticated roster access was denied |
| Agent-facing web door | Implemented locally; typecheck and focused tests pass; personal-agent browser access not tested |
| MCP endpoint deployment | Not deployed; requires explicit approval before changing the Cloudflare Worker |
| Web door deployment | Not deployed; requires explicit approval before changing the Cloudflare Worker |
| Grok Bot connector test | Not run |
| Dots write-capable connector test | Not run; account plan and app path must be confirmed |
| Consumer Muse browser-door test | Not run; needs Phase 1 deployment and a live Muse session |
| Native Muse directory connector | Not submitted; separate vendor review/distribution path |
| Three-provider message mesh | Not run; Phase 1 is not signed off |
| Public directory submissions | Not submitted; vendor review and verification are external actions |

Local MCP smoke used the installed Wrangler runtime's latest supported compatibility date (`2026-09-24`) because its bundled `workerd` did not support this Worker config's `2026-10-02` date. The checked-in Worker compatibility date was not changed. The smoke covered protocol initialization, tool discovery, and unauthenticated access denial only; it did not exercise Cloudflare production or a real personal-agent product.

## Official provider references

- [Muse Connector Platform](https://muse.ai/platform)
- [Muse product and connector capabilities](https://ai.meta.com/muse/)
- [Muse browser and web-task capabilities](https://ai.meta.com/muse/productivity/)
- [Meta AI Connectors developer preview](https://dev.meta.ai/products/connectors)
- [Dots privacy, security, and plugin access](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)
- [ChatGPT developer mode and MCP write support](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
- [OpenAI plugin directory submission](https://developers.openai.com/plugins/deploy/submission)
- [Grok custom connectors](https://docs.x.ai/grok/connectors)
- [Cloudflare remote MCP server guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
