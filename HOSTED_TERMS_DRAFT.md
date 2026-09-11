# M9R hosted service terms — draft for counsel

Status: **engineering/product draft; not binding terms and not legal advice**

Prepared: 2026-09-10

This draft is a checklist for counsel and product review. It must not be
published as M9R's Terms of Service without a qualified lawyer adapting it to
the actual entity, jurisdiction, Stripe account, provider contracts, privacy
notice, DPA, and launch pricing.

## 1. Service scope

M9R Cloud is a hosted multiplayer coordination service for humans and
customer-authorized AI-agent integrations. The service may provide shared
workspaces, conversations, live presence, handoffs, approvals, retained
history, memory, usage controls, and administration according to the selected
plan. The initial public product claim is multiplayer-first; the experimental
local terminal runtime is not included in the hosted-service promise.

## 2. Customer control and provider routing

The customer is responsible for selecting providers, models, tools, prompts,
files, and recipients. M9R should identify the provider receiving a request
and disclose the relevant data path before execution. M9R must not pool one
customer's credentials with another customer's credentials. Provider terms,
model restrictions, acceptable-use rules, and data-processing commitments
remain applicable to each integration.

Provider access is conditional, not universal: M9R may restrict a provider by
age, region, account type, billing mode, intended audience, data sensitivity,
or provider approval. The service must not share or transfer provider API keys,
resell provider accounts, or route sensitive workspace data through an unpaid
provider path whose terms permit training, improvement use, or human review.
The final terms must identify these restrictions and explain when a provider
connection is unavailable.

## 3. Customer content and privacy

The final terms must define customer ownership/control of submitted content,
agent outputs, workspace membership, retention, deletion, export, backups,
subprocessors, security measures, incident notice, and any training or
service-improvement use. They must be consistent with the privacy notice and,
where applicable, a data-processing agreement.

## 4. Plans, limits, and billing

The free multiplayer allowance and paid team features must be stated plainly.
Paid features may include private team workspaces, higher limits, retained
history, governance, managed execution, support, and enterprise controls.
Provider/model spend must not be represented as unlimited merely because a
seat is paid. The final terms must cover authorization, invoices, taxes,
renewal, cancellation, refunds, credits, failed payments, and Stripe's role.

## 5. Acceptable use and safety

The final terms must prohibit unlawful use, credential theft, abusive or
automated traffic, evasion of provider restrictions, harmful impersonation,
and attempts to use M9R to obtain unauthorized access. They must define
account security, administrator authority, suspension, emergency response,
appeals, and handling of content that violates law or provider terms.

## 6. Availability, changes, and termination

The final terms must describe service availability disclaimers, maintenance,
backups, feature changes, beta/experimental features, data export windows,
termination effects, and deletion of retained workspace data. No statement
should imply that a live agent, provider, or relay is available without an
observed service commitment.

## 7. IP, branding, and liability

The final terms must separate the M9R code licenses from hosted-service rights,
M9R marks, third-party marks, customer content, provider output, feedback,
indemnities, warranty disclaimers, liability limits, dispute venue, and any
consumer-specific rights. [`TRADEMARK_POLICY.md`](TRADEMARK_POLICY.md) is a
separate brand-use policy and is not replaced by the hosted terms.

## Counsel handoff questions

1. Is BUSL-1.1 with the GPL-2.0-or-later change license correct for the intended
   source-available open-core boundary?
2. What entity, governing law, consumer disclosures, and payment terms apply?
3. What provider-specific flow is permitted for each enabled model/provider?
4. What privacy, DPA, retention, export, deletion, and subprocessors language
   is required for shared agent conversations and files?
5. Are the free/Team boundary, usage limits, and managed-execution pricing
   described without creating an unintended guarantee?

Until these questions are answered, this file is a review packet, not a
published contract.
