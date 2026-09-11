# M9R Open Core

This document defines the source-available/open-core boundary for M9R. It is a
repository decision record and release guide. The repository-level license is
BUSL-1.1; the hosted boundary below explains what M9R operates as a service and
what a self-hosting user may run themselves.

## Product decision — 2026-09-10

M9R is proceeding as source-available open core with a deliberately small
Apache-2.0 package boundary. `@m9r/runtime-core` is the first extracted local
coordination/protocol/adapter-contract slice. The root application and CLI remain BUSL-1.1
until their local/runtime responsibilities are actually separated. M9R Cloud
is the managed multiplayer, retention, governance, billing, and enterprise
service. Existing `.oathlock` state, `oathlock`/`m9r-cli` compatibility, and
protocol versions are not split or silently migrated.

This is deliberately not marketed as OSI open source. BUSL-1.1 is a
source-available license with a future change license, not an OSI-approved
license. Public copy must say **source-available open core** unless the license
strategy is changed and reviewed.

The repository now has a deterministic local gate for the parts that can be
verified from source: `npm run open-core:check`. Use
`npm run open-core:check -- --strict` for a release-candidate check; it also
blocks on untracked debug or artifact output. A passing deterministic check is
not a substitute for the manual dependency, history, clean-machine, security,
and legal gates below.

## Product boundary

M9R has two cooperating products:

1. **M9R Runtime** is the future local layer. It may eventually own real
   terminal processes, agent bridges, file watcher, local session state, and
   the local control surface; those capabilities remain separately gated until
   the runtime is proven and extracted. The first release does not promise a
   terminal product.
2. **M9R Cloud** is the current hosted collaboration and governance layer. It carries
   authenticated multiplayer workspaces, hosted relay infrastructure, team
   history, approvals, memory retention, billing, and administration.

The runtime is useful without the hosted service. The hosted service makes a
team's real local work visible, shareable, reviewable, and cumulative.

## Licensing decision

The intended split is:

| Area | License/status | Notes |
| --- | --- | --- |
| Root application and CLI, including hosted implementation | BUSL-1.1 | Source-available for now; this is not an OSI open-source license. |
| `packages/runtime-core/` | Apache-2.0 | First independently buildable local protocol/adapter-contract slice; not the complete offline control plane or terminal product. |
| Change license for the licensed work | GPL-2.0-or-later on the stated change date | Uses the GPLv2-compatible change-license form required by BUSL-1.1; counsel must review repo-wide scope before public release. |
| Hosted control plane, managed relay, hosted history, billing, enterprise controls | Commercial service / additional terms | Running M9R Cloud is separate from receiving source code. |
| Brand, trademarks, hosted domains, production credentials | Reserved | See [`TRADEMARK_POLICY.md`](TRADEMARK_POLICY.md); not granted by either code license. |

This is intentionally called open core in product language, but the current
license is source-available rather than OSI open source. Do not market the
repository as Apache-licensed today. The root `LICENSE` and `cli/LICENSE` are
the controlling license files; counsel still needs to review whether the
repo-wide scope and hosted-use grant are correct before a public announcement.

## What is open-core material

The first public package boundary should contain only code that can be
distributed without hosted-account or production-secret dependency:

- `packages/runtime-core/` as the first independently buildable slice;
  its exact allowlist is documented in `packages/runtime-core/BOUNDARY.md`
- provider-neutral protocol and adapter contracts
- versioned multiplayer relay/client protocol documentation
- self-hostable examples and development fixtures that contain no credentials

The resident, PTY, terminal-session, file-watching, and full CLI extraction
remain experimental follow-up work. They are not part of the first public
announcement or an implied Mosaic-equivalent terminal promise.

## What stays hosted-only initially

- production Supabase project and service-role operations
- hosted relay deployment and operational controls
- multi-tenant account/workspace administration
- hosted retention, memory quotas, and audit exports
- Stripe billing, prepaid balances, and provider-cost accounting
- SSO/SCIM, enterprise policy, and support tooling
- M9R-managed provider credentials
- production deployment configuration and secrets

This boundary is about dependency and operational ownership, not merely which
folder a file currently lives in. The Apache-2.0 boundary is effective only for
the reviewed `runtime-core` package. The rest of the repository remains a
BUSL-1.1 monolith until further extraction, dependency isolation, and legal
review land.

The proposed product boundary is documented in
[`docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md`](docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md):
basic human/agent multiplayer is the free adoption surface, while private team
governance, retained history, higher limits, managed execution, and enterprise
operations are paid M9R Cloud capabilities. This is a product boundary, not a
claim that billing enforcement is complete.

## Release gates before announcing open core

- [x] Record the single-repository BUSL-1.1 direction and preserve the CLI's
      existing `oathlock` compatibility alias.
- [x] Establish the first independently buildable local package boundary in
      `packages/runtime-core/`; the complete CLI/dashboard extraction remains a
      separate release gate.
- [x] Add a deterministic source/metadata gate with `npm run open-core:check`.
- [x] Run an isolated packed-CLI install smoke test on the current machine.
- [x] Verify the Windows autostart/launch command builders (20 tests pass on
      the current Windows workstation); this is not a clean-OS terminal claim.
- [x] Inventory package license metadata and provider terms in
      [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); compatibility and
      commercial clearance still require counsel.
- [x] Add a draft trademark policy and a proposed free multiplayer/team
      commercial boundary for counsel and product review.
- [x] Add a repository-level BUSL-1.1 license file with an explicit licensed
      work and change date.
- [x] Prepare a hosted-service terms draft and counsel handoff packet; final
      publication still requires qualified legal review.
- [ ] Have counsel confirm dependency-license compatibility for the curated
      public package and any bundled assets.
- [x] Scan full Git history for secrets before making the repository public.
      The expanded audit covers provider/API key prefixes, private-key markers,
      and historical blobs; the current matches are documented synthetic test
      fixtures only. This is an engineering scan, not a legal or guarantee of
      safety for future commits.
- [x] Move generated demo/deck artifacts out of the public worktree and add an
      ignored release-exclusion boundary.
- [x] Define the curated package/repository allowlist in
      [`docs/PUBLIC_RELEASE_ALLOWLIST.md`](docs/PUBLIC_RELEASE_ALLOWLIST.md)
      and enforce its high-risk exclusions with the public-surface gate.
- [x] Scope the first announcement to multiplayer coordination and the
      extracted runtime-core contracts; defer the unverified terminal promise.
- [x] Observe one real provider error through the exact public deployment with
      no fixture-backed activity. On 2026-09-10, the authenticated M9R CLI
      used `https://m9r-dashboard.onrender.com` for a bounded acceptance
      conversation: a `claude-code -> everyone` result reported its
      provider-owned weekly-limit error. The transcript also contains the
      expected OpenCode acknowledgement text, but it is labeled
      `you -> everyone`, and the OpenCode handoff is labeled `you -> you`; that
      is ambiguous self-authored evidence, not proof that OpenCode responded.
      This verifies one observed provider failure and honest error text, not
      successful provider routing.
- [ ] Capture a clean successful two-provider acceptance run on the exact
      public deployment before using it as the public demo or claiming that
      every advertised provider completed work successfully.
- [x] Keep the initial announcement scoped so clean-machine terminal
      self-hosting and a local-only runtime are not represented as shipped
      capabilities.
- [x] Publish a security policy and responsible-disclosure contact.
- [x] Publish the compatibility policy for existing `.oathlock` state and the
      load-bearing `oathlock` CLI identifiers.
- [x] Triage the remaining full-suite failures; the full repository suite now
      passes 2,162/2,162 tests. This does not replace legal or clean-machine
      runtime review.
- [ ] Have counsel review the license boundary, provider terms, and trademark
      language.

The engineering gate for a multiplayer-first source-available announcement is
complete. Public language may say **"M9R is preparing a source-available
open-core release"** and must not say **"M9R is open source"** or imply that
the full repository is Apache-licensed. Qualified counsel remains the external
gate before publishing final license/hosted-terms language or presenting the
repository as legally cleared for redistribution.

## Deferred runtime gates

These are important before advertising terminal self-hosting or a complete
offline control plane, but they do not block the scoped multiplayer-first
announcement:

- [ ] Verify a clean-machine self-host install for the future local runtime.
- [ ] Add and verify a supported local-only runtime mode without M9R Cloud.
- [ ] Verify provider process reconnect and Mosaic-equivalent terminal/session
      persistence before publishing a terminal demo.

## Compatibility rule

The open-core work must not rename or migrate these load-bearing identifiers as
part of the licensing pass:

- `.oathlock` on-disk state
- `oathlock`/`m9r-cli` command compatibility
- existing `OATHLOCK_*` environment variables
- persisted provider kinds
- relay and evidence protocol version strings

Brand migration and legal packaging are separate from runtime compatibility.
