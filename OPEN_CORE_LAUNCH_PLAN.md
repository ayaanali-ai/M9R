# M9R Open-Core Launch Plan

This is the launch plan for the first honest open-core release. It is not a
license grant and it is not legal advice.

## Current release checkpoint — 2026-09-11

The public M9R repository is live at
[`ayaanali-ai/M9R`](https://github.com/ayaanali-ai/M9R), with `main` currently
at `fb1ccdb`. The local mention-popover rendering fix is included there.
Use a clean checkout of that repository for subsequent release work. Do not
continue publishing from the historical OathLock checkout.

## What we are announcing

Use this claim:

> M9R is preparing a source-available open-core release: provider-neutral
> coordination contracts and multiplayer primitives for the agents you already
> use, with shared conversations, retained workspace history, approvals,
> governance, and billing available as the managed team service.

The first announcement does **not** promise a production-ready terminal
runtime, Mosaic-level terminal persistence, or a complete offline control
plane. Those remain explicitly labeled experimental work.

This source announcement is separate from a general commercial launch. The
hosted Terms and Privacy pages still contain operator, address, and governing-
jurisdiction placeholders, and the DPA is available only as a draft. Do not
present hosted signup, pricing, or provider routing as legally cleared
commercial terms until those details are supplied and reviewed.

Do not announce “M9R is open source.” The initial repository split is
source-available open core: the root repository is BUSL-1.1 and only the
extracted runtime-core slice is Apache-2.0. A qualified legal review is still
required before publishing final hosted-service terms.

## What users get

### Public core

- Provider-neutral coordination/session contracts.
- Provider-neutral multiplayer and adapter contracts in `@m9r/runtime-core`.
- Versioned protocol documentation and a clear boundary around hosted-only
  collaboration services.
- `.oathlock` and `oathlock` compatibility preserved during the M9R rename.

The resident and terminal runtime remain an experimental follow-up and are
not included in the initial public capability promise.

### Hosted service

- Multiplayer workspaces and live session sharing.
- Human-controlled agent handoffs and redirects.
- Retained history, approvals, evidence, and memory.
- Team administration, billing, quotas, and managed provider execution.

## Current public pricing surface

The live pricing page was checked on 2026-09-10. Keep the local core free and
describe the hosted tiers exactly as they are currently presented:

| Plan | Price | Positioning |
| --- | ---: | --- |
| Free | $0 forever | Up to two workspaces, two connected agents, workspace chat and runs, evidence chain, and up to ten active rules. |
| Pro | $14/seat/month monthly, $11/seat/month billed annually ($132/year) | Unlimited agent connections, history, workspace rules, workflow automation, and priority support. |
| Team | Custom | Shared workspaces, SSO/SAML, moderation and audit controls, data residency, and dedicated onboarding. |

These are current product-packaging values, not legal terms or a claim that
paywall enforcement is complete. Do not promise unlimited hosted compute or
provider spend in a seat price until the cost model is live; provider/model
costs should be shown separately or passed through with an explicit allowance.

## Demo sequence

### Web demo — 60 seconds

1. Open one workspace with a real channel and an active agent.
2. Show a teammate joining the same live session.
3. Send a human redirect and show the event appear in the shared timeline.
4. Open the review/diff surface and show the change boundary.
5. End on the paid hosted value: shared control and a durable record.

### Terminal demo — deferred

Do not publish a terminal demo until the local runtime, reconnect behavior, and
cross-platform install path are verified on the exact build being shown.

Never fake a second user, live relay, terminal persistence, or provider
completion in the demo.
If a path is fixture-backed, label it as a fixture.

## Release gates before public announcement

- [x] Extract and document the first local package boundary in
  `packages/runtime-core/`.
- [x] Finish the dependency inventory and full-history secret scans; the
  remaining license/provider compatibility question is explicitly with counsel.
- [x] Remove private artifacts, production credentials, and unreviewed URLs
  from the scoped public surface; rerun the deterministic public-surface gate
  on the release candidate.
- [x] Verify the public package boundary and local production web routes. The
  announcement must still use a verified multiplayer demo rather than claim
  unverified live provider completion.
- [x] Observe one real provider error through the exact public deployment with
      no fixture-backed activity. The 2026-09-10 acceptance conversation used
      the Render deployment: a `claude-code -> everyone` result reported its
      provider weekly-limit error. The expected OpenCode acknowledgement is
      labeled `you -> everyone`, with the handoff labeled `you -> you`, so it
      is ambiguous self-authored evidence rather than provider-attributed
      OpenCode completion. This confirms observed error propagation, not
      successful multi-provider execution.
- [ ] Capture a clean successful two-provider acceptance run on the exact
      public deployment before using it as the public demo or claiming that
      every advertised provider completed work successfully.
- [x] Publish security/disclosure, compatibility, trademark, and commercial
  boundary documents as review drafts.
- [x] Publish an architecture diagram that separates the Apache-2.0
  runtime-core contracts, M9R Cloud, provider-owned execution, and deferred
  terminal/runtime work.
- [ ] Qualified counsel reviews and approves the BUSL/Apache boundary,
  dependency/provider terms, trademark language, and hosted-service terms.

## How to close the remaining external gates

### Two-provider acceptance

Run one bounded acceptance conversation against the exact public deployment
using two independently authenticated, supported provider connections. The
test message should be neutral and non-sensitive. The gate closes only when
the transcript contains a provider-attributed completion from each connection,
with the connection identity and completion event visible in the hosted
record. A human-authored acknowledgement, a handoff addressed back to the
same identity, a fixture event, a timeout, or a quota/error result does not
count. Stop after a provider-owned quota or authentication failure; do not
retry blindly or create synthetic evidence.

The resulting redacted record must identify the deployment, conversation,
provider labels, start/end times, completion/error state, and the exact claim
it supports without exposing credentials, private prompts, customer content,
or provider tokens. The public demo may show only behavior covered by that
record.

### Counsel and owner approval

Counsel should approve or reject the decision matrix in
[`docs/OPEN_CORE_LEGAL_REVIEW.md`](docs/OPEN_CORE_LEGAL_REVIEW.md), including
the BUSL-1.1/Apache-2.0 boundary, hosted-use grant, dependency/provider terms,
trademark policy, and hosted-service terms. The human owner must separately
review the exact staged file list and the generated release manifest. These
are approvals of the release candidate, not approvals inferred from passing
tests.

Until both gates and the staged-snapshot review are complete, the only safe
public wording is that M9R is **preparing a source-available open-core
release**. Do not publish a final license claim, a provider-success demo, or a
repository snapshot as legally cleared.

## Deferred gates before terminal or full self-hosting claims

These are intentionally not launch blockers for the multiplayer-first
announcement. They must pass before M9R advertises a production terminal,
Mosaic-equivalent session persistence, or a complete offline control plane:

- [ ] Verify clean-machine local-runtime install and reconnect.
- [ ] Add and verify a supported local-only runtime mode without M9R Cloud.
- [ ] Verify cross-platform provider-process behavior and terminal/session
  persistence on the exact build shown in a public demo.

Do not push, publish, or announce a release commit until the human owner has
reviewed the exact staged file list and the remaining counsel gate. A passing
engineering checklist does not constitute legal approval.

## Announcement drafts

### Company account

> M9R is preparing a source-available open-core release.
>
> Use M9R as the multiplayer layer for the agents you already use: shared
> conversations, redirects, approvals, history, and team control.
>
> One room for humans and the agents they already use.

### Founder account

> AI coding agents are getting better at working alone.
>
> The next problem is what happens when a team uses several of them at once.
>
> I’m building M9R as the multiplayer layer for the agents you already use: a
> shared workspace when you want it, with a human in control of every handoff.

### Terminal hook

> AI agents are no longer isolated workers.
>
> M9R gives the agents you already use one shared room to communicate,
> redirect, and hand work to one another.

Post only after the corresponding demo path has been verified on the exact
build being shown.
