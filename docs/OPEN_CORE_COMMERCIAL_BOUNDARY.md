# M9R open-core commercial boundary (v2)

Status: **proposed v2, 2026-09-20. Supersedes the workspace-based boundary of 2026-09-10.** It is written against the native front-door design (`M9R_NATIVE_FRONT_DOOR_DESIGN.md`): one user, all of their own agents, reached inside their own apps. It is a product boundary to review with the owner and counsel. It is not a price sheet, terms of service, privacy notice or provider contract, and billing enforcement is not complete (`NEXT_PUBLIC_M9R_BILLING_ENABLED` is `false`).

## 1. Principle

Charge for what only exists because of the cloud, the network, time and people. **Never charge by hiding the core function.** A solo developer must get the full "all my agents work together" experience for free; if the free product is crippled, developers self-host or leave, and the licence lets them.

The moat is not code. It is the network (who is on it), the trust graph, and the accumulated work history (see the handoff doc, section 15). Open code builds the trust the local layer needs; the hosted service and the network are the business.

## 2. What the licence already decides

The root licence is BUSL-1.1 with this Additional Use Grant: anyone may make production use of the code, provided they do not offer it, or a derivative, to third parties on a hosted or managed basis as a product or service that competes with M9R's own hosted offering. Change Date 2029-09-04, change licence GPL-2.0-or-later. Consequences:

- Anyone can read, run and self-host the dashboard and Relay for their own use. **The code is not gated.** What is gated is M9R's hosted service, accounts, data, network and support.
- Running a competing hosted service is not allowed.
- Public copy must say **"source-available open core"**, never "open source" (`OPEN_CORE.md`).

## 3. Free, for one person (the first release)

- The whole local layer: the M9R Node, hooks, adapters, CLI, memory files, collision guard, inbox and task records, and a **local-only mode that needs no account**.
- **Unlimited local endpoints.** All of a user's agents on their own machine. No two-agent cap: the pitch is "all your agents".
- The hosted dashboard for one user: endpoint list, delivery timeline and activity feed, with a limited retention window. Proposed 7 days; the number must be set from measured storage cost.
- Bring-your-own provider logins. M9R never handles provider credentials and funds no model inference.
- Public documentation, the protocol and adapter contracts, and the Apache-2.0 `@m9r/runtime-core` package.

## 4. Paid, because it needs the cloud or the network

### Pro (individual, per seat)
Current public pricing surface, kept unchanged: $14 per seat monthly, $11 per seat billed annually ($132 a year). Product-pricing values, not a legal promise; review them against this new scope before launch.
- Multi-machine: reach your own agents across your own computers through the Relay.
- Longer retention and search of history and memory.
- Phone approvals and push notifications.
- Higher limits and priority support.

### Team (arrives with the later stages; not in the first release)
- Shared workspaces, roles, permissions, approvals and handoffs.
- Shared memory with provenance and retained history, exports and audit views.
- Team-wide usage budgets and cost controls.
- The cross-user network: contacts, trust, capability grants, receipts (Stages 3, 4, 6, 7). This cannot be self-hosted in a meaningful way, because the network is the point.

### Enterprise (custom)
- SSO and SCIM, organisation policy, private relay capacity, support and service commitments, managed model execution or provider-cost pass-through where contractually permitted.

The paywall attaches to scale, time and people (machines, retention, seats, governance, network), not to the idea of agents talking to each other.

## 5. What is source-available, and what stays hosted-only

**Source-available today:** the whole repository under BUSL-1.1, plus the reviewed Apache-2.0 `packages/runtime-core/`.

**Recommended direction for trust (needs counsel, section 8):** the part that edits a user's agent settings and reads their repositories is the trust surface, so it should be the most open and the most inspectable: the M9R Node, hook installers, provider adapters and protocol docs. The hosted control plane stays under BUSL-1.1 and commercial terms.

**Hosted-only, never part of the code grant:**
- The production Supabase project and service-role operations, secrets and deployment configuration.
- The hosted Relay, retention, audit exports and operations.
- Multi-tenant accounts, billing and provider-cost accounting.
- SSO/SCIM, enterprise tooling and support.
- The brand, trademarks and hosted domains (`TRADEMARK_POLICY.md`).

## 6. Trust commitments to publish (they are what make the open local layer believable)
1. A plain list of exactly what `m9r init` changes on a machine, with backups and `m9r uninstall` to reverse it.
2. Local-only mode works with no account and no network.
3. Provider credentials never pass through M9R.
4. What is sent to the cloud (metadata and task records) and what never is (full private transcripts), with secret redaction before anything leaves the machine.
5. The local API listens on loopback only, behind a per-user token.

## 7. Provider safeguards required before launch (unchanged from v1)
- Route provider access through customer-owned credentials or a contractually approved M9R account model; never pool keys between customers.
- Show the selected provider and a concise data-routing disclosure before a hosted turn.
- Do not send sensitive workspace data through unpaid Google Gemini paths by default; require a paid or data-processing-safe configuration, or an explicit user decision.
- Keep provider-specific restrictions, citations, output ownership and model terms attached to the provider integration.
- Provider terms on driving subscription logins: reviewed 2026-09-20 against Anthropic's and OpenAI's public documents. The reading is that a user's own local, unmodified provider CLI or app used by that user on their own machine is fine, while pooling, reselling or proxying subscription credentials is not. Get a real legal read before public launch.

## 8. Decisions needed from the owner and counsel
1. **Licence path for the local layer:** (A) keep BUSL-1.1 for everything except `runtime-core`, or (B) relicense the local Node, CLI and adapters as Apache-2.0 and keep the hosted control plane BUSL-1.1. B builds more trust; the cost is that anyone may build on the local layer, though not on your network or hosted service. Counsel decides.
2. Free retention window (proposed 7 days) once storage cost is measured.
3. Whether Pro's current price still fits the new scope (multi-machine, retention, phone approvals).
4. A public statement on self-hosting: allowed for own use, not as a competing service.
5. Waitlist versus install-now, and whether the free tier is gated by invite during early access.
6. Whether the local-only mode requires no sign-in at all (recommended).

## 9. What this is not
Not a final price sheet, legal terms, privacy notice or provider contract. Not a claim that billing enforcement or the paid features exist yet: in the first release only the free tier is built.

## 10. Owner answers, 2026-09-20 (recorded)
1. **Licence path: B.** The local layer (M9R Node, CLI, hook installers, provider adapters, protocol docs) becomes **Apache-2.0**; the hosted control plane stays BUSL-1.1 with commercial terms. Motivation: adoption and virality while keeping the hosted network as the business. Still needs counsel to confirm dependency-licence compatibility and the exact repo split before the announcement; once a version is released under Apache-2.0 it cannot be taken back for that version.
2. Free retention window: undecided; it is the number of days of history the free hosted dashboard keeps. Set once storage cost is measured.
3. Pro price: decision deferred until the Pro feature set (item 2 is part of it) is settled; billing is off, so nothing is charged meanwhile.
4. Self-hosting statement: to be published as "run it yourself for your own use; do not resell it as a competing hosted service" (see the copy file).
5. Waitlist: hybrid, see `M9R_NATIVE_FRONT_DOOR_DESIGN.md` section 21.
6. **Local-only mode needs no sign-in.** Sign-in matters only for cloud features (hosted dashboard, multi-machine sync, phone approvals, teams, cross-user identity).
