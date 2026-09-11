# Open-core legal review packet

Status: **prepared for qualified counsel; not legal approval**

Prepared: 2026-09-10

## Product decision to review

M9R intends to release a source-available open-core product. The initial
repository license is BUSL-1.1 with the stated GPL-2.0-or-later change license. The
first extracted local package, `@m9r/runtime-core`, is Apache-2.0; the root
application and CLI remain a mixed BUSL-1.1 monorepo. M9R Cloud remains the
hosted multiplayer, retention, governance, billing, and enterprise service.

Public copy must say **source-available open core** unless counsel and the
licensor deliberately choose an OSI-approved license. SPDX lists BUSL-1.1 as a
license identifier, while OSI separately defines the approval process and the
Open Source Definition. This packet does not decide whether the current
Additional Use Grant is enforceable or commercially sufficient.

## Recommended disposition for counsel

The engineering recommendation is to approve or reject these decisions as a
single release boundary. This keeps the review tied to the product we are
actually announcing rather than to an implied future terminal product.

| Decision | Engineering position | Consequence if not approved |
| --- | --- | --- |
| Repository license | Keep the root application and CLI under BUSL-1.1 with the stated GPL-2.0-or-later change license and Additional Use Grant. | Do not publish the repository under the current license text. |
| Public package | Keep only `@m9r/runtime-core` under Apache-2.0; it contains provider-neutral contracts and no hosted credentials, billing, relay operations, or terminal implementation. | Remove or rework the package boundary before publishing it. |
| Hosted service | Treat M9R Cloud, hosted relay, retention, governance, billing, and managed execution as a separate service subject to final Terms, Privacy, DPA, and provider agreements. | Do not publish final hosted-service or pricing language as legally cleared. |
| Provider access | Use customer-authorized, provider-specific credentials and disclosures; do not pool or transfer provider keys. | Disable the affected provider path or obtain provider-specific approval. |
| Brand | Keep M9R/OathLock marks reserved under the separate trademark policy; code licenses grant no trademark rights. | Remove the mark or obtain written permission before distribution/branding. |
| Public snapshot | Publish only the reviewed allowlist and manifest; exclude credentials, local state, generated artifacts, customer data, and internal strategy material. | Do not publish the snapshot until the exact staged file list is reviewed. |

This matrix is a proposed product/legal position, not a legal opinion or a
substitute for counsel's written approval.

## Questions counsel must answer

1. Does the repo-wide BUSL-1.1 text correctly identify the licensed work,
   licensor, change date, change license, and Additional Use Grant?
2. Does the hosted-use restriction cover M9R Cloud without unintentionally
   restricting ordinary self-hosting, internal use, or user modifications?
3. Is the Apache-2.0 runtime-core package correctly separated from the BUSL
   monorepo, or should it move to a separately reviewed repository/package
   boundary before public release?
4. Which dashboard, hosted relay, billing, provider-credential, and deployment
   files must remain private, and how should that boundary be published?
5. Are the M9R name, logo, domains, screenshots, demo assets, and third-party
   UI/component assets properly separated from the code license?
6. Do OpenAI/Codex, Anthropic/Claude Code, ACP, OpenCode, Stripe, Supabase,
   Monaco, and other provider/dependency terms allow the intended distribution,
   branding, and hosted integration model?
7. What privacy, DPA, retention, subprocessors, export-control, and consumer
   messaging obligations apply to hosted workspaces and agent transcripts?

## Materials for counsel

- [`LICENSE`](../LICENSE) — current BUSL-1.1 text and Additional Use Grant.
- [`OPEN_CORE.md`](../OPEN_CORE.md) — product boundary and release gates.
- [`packages/runtime-core/BOUNDARY.md`](../packages/runtime-core/BOUNDARY.md) —
  first extracted package boundary.
- [`OPEN_CORE_DEPENDENCY_AUDIT.md`](OPEN_CORE_DEPENDENCY_AUDIT.md) — dependency
  metadata and vulnerability status.
- [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) — package-license
  inventory and provider-term review matrix.
- [`TRADEMARK_POLICY.md`](../TRADEMARK_POLICY.md) — draft mark-use policy.
- [`docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md`](OPEN_CORE_COMMERCIAL_BOUNDARY.md) —
  proposed free multiplayer and paid team boundary.
- [`docs/SECURITY.md`](SECURITY.md) and [`SECURITY.md`](../SECURITY.md) — current
  limitations and disclosure contact.

## Current provider-term observations

Checked against the linked official terms on 2026-09-10. These observations
are implementation constraints for counsel to confirm, not legal approval:

- OpenAI's current Services Agreement permits API-powered customer
  applications to be made available to end users, but restricts sharing or
  transferring API keys, reselling or leasing account access, and shared
  credentials. M9R should keep provider credentials scoped to the customer
  and should not present pooled M9R credentials as an end user's account.
- Anthropic's current help guidance says individuals and hobbyists may use the
  Claude API, but those uses remain subject to the Commercial Terms. The
  Commercial Terms permit powering customer products for users while stating
  that the commercial Services are not for consumer use and restricting
  competing services or resale without approval. The intended M9R Anthropic
  account model therefore requires a provider-specific legal decision before
  M9R is positioned as a pooled or consumer-facing Claude service.
- Google's Gemini API Additional Terms require users to be at least 18 and
  describe the API as for professional or business use. Unpaid Services may
  use submitted content to improve Google products and may involve human
  review. M9R must not silently route sensitive workspace data through that
  path and must account for region, billing mode, and user eligibility.

## Primary public references checked

- [SPDX License List](https://spdx.org/licenses/)
- [OSI Approved Licenses](https://opensource.org/licenses)
- [Open Source Definition](https://opensource.org/osd)
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
- [OpenAI Service Terms](https://openai.com/policies/service-terms/)
- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- [Google Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)

The references are starting points for counsel, not a conclusion that M9R's
integration is covered by any provider's terms.
