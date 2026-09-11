# M9R open-core commercial boundary

Status: proposed product boundary, 2026-09-10. This document defines what we
can offer after the bounded live multiplayer acceptance check; it does not
promise Mosaic-level terminal persistence or a complete offline control plane.

## Product principle

M9R should make the basic multiplayer idea easy to try, then charge for the
team operating layer. The free experience must demonstrate humans and agents
sharing a workspace; paid plans should make that workspace useful for a real
team with privacy, control, history, and predictable limits.

## Proposed free/community tier

The free hosted tier can include:

- up to two workspaces and up to two connected agents;
- basic human-to-human and human-to-agent multiplayer messaging;
- full workspace chat and agent runs;
- evidence chain and Run Passport;
- up to ten active workspace rules and bounded history;
- bring-your-own provider credentials where the provider permits it;
- public documentation, compatibility protocols, and the Apache-2.0
  `@m9r/runtime-core` package once its boundary is released.

The free tier should not include M9R-funded model inference, unlimited storage,
unlimited agent connections, private team administration, or a promise that
local terminals are production-ready.

## Team/paid tier

The paid hosted tiers can include:

### Pro

- unlimited agent connections and materially higher usage limits;
- unlimited workspace rules and channel workflow automation;
- longer retained history and priority support;
- the same basic multiplayer workspace, evidence, and review surface as Free.

### Team

- private workspaces and team membership;
- unlimited agent/member limits;
- roles, permissions, approvals, task assignment, and handoffs;
- retained shared history, memory, search, exports, and audit views;
- team-wide provider routing, usage budgets, and cost controls;
- organization policy, SSO/SCIM, support, and service commitments;
- managed M9R model execution or provider-cost pass-through when contractually
  permitted;
- private relay capacity and administrative controls.

The paywall should attach to higher limits, private retention, team governance,
and managed operations—not to the existence of the multiplayer concept itself.

The current public pricing surface is Free / Pro / Team. The live page lists
Pro at $14 per seat monthly or $11 per seat when billed annually ($132 yearly)
and Team as custom. These are product-pricing values, not a legal promise or a
statement that paywall enforcement is complete.

## Open-core source boundary

The public source boundary should contain code that a user can run or inspect
without M9R Cloud credentials. The current first slice is only the protocol and
adapter-contract package. The full resident, PTY runtime, agent discovery,
reconnect behavior, local file activity, and self-hosted browser surface remain
separate release gates until verified.

The hosted control plane remains outside the Apache-2.0 package boundary:

- multi-tenant accounts and workspace administration;
- hosted relay operations and retention;
- billing and provider-cost accounting;
- M9R-managed credentials;
- team governance, enterprise controls, and support operations.

## Provider safeguards required before launch

- Route provider access through customer-owned credentials or a contractually
  approved M9R account model; never pool keys between customers.
- Show the selected provider and a concise data-routing disclosure before a
  hosted turn.
- Do not send sensitive workspace data through unpaid Google Gemini paths by
  default; require a paid/data-processing-safe configuration or an explicit
  user decision.
- Keep provider-specific restrictions, citations, output ownership, and model
  terms attached to the provider integration rather than claiming all models
  have identical rules.

## What this is not

This is not a final price sheet, legal terms of service, privacy notice, or
provider contract. It is the product boundary to implement and validate before
announcing an open-core release.
