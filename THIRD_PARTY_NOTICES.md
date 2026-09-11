# M9R third-party notices and provider-term review

Prepared 2026-09-10 from the repository manifests and lockfiles. This is a
release inventory and engineering review, not legal advice or a substitute for
permission from a provider.

## Recommended licensing direction

If M9R is going to use “open core” in the practical sense intended by this
release, the recommended split is:

- Apache-2.0 for the first independently buildable public core slice:
  provider-neutral protocol and adapter contracts in `@m9r/runtime-core`.
- A later, separately reviewed Apache-2.0 boundary for resident/terminal code
  only after its local runtime, dependency isolation, and clean-machine tests
  are proven. The first announcement does not promise that terminal product.
- A separate proprietary or source-available license for M9R Cloud: hosted
  multiplayer relay, hosted workspace, retention, billing, credential vault,
  governance, and managed model execution.
- A separate trademark policy. Apache-2.0 does not grant the right to use the
  M9R name, logos, domains, or product marks.

This is the cleanest adoption model because users can fork, embed, and run the
local core without asking M9R for permission, while the hosted business remains
separate. It requires a real repository/package split; changing the root
license alone does not create that boundary.

The current repository is still BUSL-1.1. BUSL is source-available and not an
OSI open-source license. The root license now names GPL-2.0-or-later as the
change license, matching the GPLv2-compatible form required by the BUSL-1.1
template; counsel should still confirm the choice against the intended
boundary before publication.

## Package-license inventory

The root lockfile contains 938 non-root package entries. The CLI lockfile
contains 101 non-root entries. The lock metadata reports these license labels:

| Lockfile | License label | Entries |
| --- | --- | ---: |
| Root | MIT | 751 |
| Root | Apache-2.0 | 75 |
| Root | BSD-3-Clause | 20 |
| Root | MPL-2.0 | 14 |
| Root | BSD-2-Clause | 12 |
| Root | LGPL-3.0-or-later | 10 |
| Root | ISC | 33 |
| Root | Other/compound labels | 23 |
| CLI | MIT | 90 |
| CLI | Apache-2.0 | 1 |
| CLI | BSD-3-Clause | 2 |
| CLI | ISC | 7 |
| CLI | BSD-2-Clause | 1 |

These are package metadata labels, not a legal compatibility opinion. The
release process must preserve each package's license and notice files when a
package is redistributed.

### Direct runtime dependencies

The direct dependencies in `package.json` are primarily Apache-2.0, MIT, BSD,
ISC, and MPL-2.0 packages. The important direct entries are:

| Package family | Locked versions | License metadata |
| --- | --- | --- |
| Agent Client Protocol packages | `@agentclientprotocol/claude-agent-acp@0.64.0`, `@agentclientprotocol/codex-acp@1.1.7`, `@agentclientprotocol/sdk@1.3.0` | Apache-2.0 |
| AI SDK provider packages | `@ai-sdk/anthropic@4.0.49`, `@ai-sdk/azure@4.0.63`, `@ai-sdk/cerebras@3.0.44`, `@ai-sdk/cohere@4.0.37`, `@ai-sdk/google@4.0.64`, `@ai-sdk/groq@4.0.37`, `@ai-sdk/mistral@4.0.39`, `@ai-sdk/openai@4.0.60`, `@ai-sdk/openai-compatible@3.0.44`, `@ai-sdk/perplexity@4.0.39`, `@ai-sdk/togetherai@3.0.45`, `@ai-sdk/xai@4.0.54` | Apache-2.0 |
| Other provider SDKs | `@anthropic-ai/sdk@0.105.0`, `@google/genai@2.13.0` | MIT, Apache-2.0 |
| UI/runtime infrastructure | `@monaco-editor/react@4.7.0`, `@supabase/ssr@0.12.0`, `@supabase/supabase-js@2.108.2`, `@xterm/addon-fit@0.11.0`, `@xterm/addon-webgl@0.19.0`, `@xterm/xterm@6.0.0`, `border-beam@1.3.0`, `chokidar@4.0.3`, `clsx@2.1.1`, `metal-fx@2.0.10`, `motion@12.42.2`, `next@16.3.4`, `node-pty@1.1.0`, `radix-ui@1.6.6`, `react@19.2.4`, `react-dom@19.2.4`, `reicon-brands@1.0.2`, `reicon-react@1.1.302`, `shadcn@4.16.0`, `shiki@4.4.3`, `stripe@22.4.0`, `tailwind-merge@3.6.0`, `tw-animate-css@1.4.0`, `ws@8.21.1` | Mostly MIT; `lucide-react` and `yaml` are ISC; `web-push` is MPL-2.0; `class-variance-authority`, `ai`, and Paper shaders are Apache-2.0 |

### Manual-review package entries

These entries need the package's own bundled license text checked when the
distribution shape changes:

- `@anthropic-ai/claude-agent-sdk@0.3.220` and its platform packages identify
  their license as `SEE LICENSE IN README.md` or `SEE LICENSE IN LICENSE.md`.
- `@img/sharp-*` uses compound Apache-2.0/LGPL-3.0-or-later metadata.
- `dompurify@3.4.15` reports `(MPL-2.0 OR Apache-2.0)`.
- `json-schema@0.4.0` reports `(AFL-2.1 OR BSD-3-Clause)`.
- The remaining compound/rare labels are recorded in `package-lock.json` and
  must not be flattened into MIT or Apache-2.0 in a generated notice.

The current production audit is clean after pinning `dompurify@3.4.15`, but
dependency vulnerability status and license metadata must be rerun before each
release.

## Provider and hosted-service terms

M9R should treat provider APIs as customer-authorized integrations, not as
rights granted by M9R's software license. The hosted service should route a
customer's own key/account where the provider permits it, avoid sharing keys
between customers, and disclose which provider receives prompts, files,
conversation context, and tool activity.

### High-impact findings checked 2026-09-10

These are engineering release conditions drawn from the linked provider terms,
not legal conclusions:

- OpenAI's current Services Agreement permits customer applications to make
  API-powered services available to end users, but prohibits sharing or
  transferring API keys, reselling or leasing account access, and shared login
  credentials. Each end user must have an individual account where the terms
  require one. M9R must keep provider credentials customer-scoped and must not
  present a pooled M9R account as the user's provider account.
- Anthropic's current help guidance says individuals and hobbyists may use the
  Claude API, but those uses remain subject to the Commercial Terms. Those
  Commercial Terms allow a customer to power products for its users while also
  stating that the commercial Services are not for consumer use and restricting
  competing services or resale without approval. An individual using their own
  API account is therefore not the same thing as M9R presenting a pooled,
  consumer-facing Claude service. M9R must obtain provider-specific approval or
  keep the Anthropic path strictly customer-authorized until counsel confirms
  the intended hosted model is permitted.
- Google's Gemini API Additional Terms require users to be at least 18 and
  describe the API as for professional or business use rather than consumer
  use. Unpaid Services may use submitted content to improve products and may
  expose inputs and outputs to human reviewers; sensitive workspace data must
  not be routed through that path by default. M9R must enforce or disclose
  provider eligibility, region, billing mode, and data routing before enabling
  Gemini for a workspace.

Until these conditions are implemented or expressly approved for the chosen
account model, provider availability must be labeled “provider-specific terms
apply” and must not be advertised as uniform across every model or customer.

| Integration | Primary terms reviewed | Release implication |
| --- | --- | --- |
| OpenAI / Codex | [Services Agreement](https://openai.com/policies/services-agreement/), [Service Terms](https://openai.com/policies/service-terms/) | Keep API keys customer-scoped; do not transfer or pool keys; document end-user responsibility, output handling, usage policies, and any applicable data-processing terms. |
| Anthropic / Claude | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [API individual-use guidance](https://support.anthropic.com/en/articles/8987200-can-i-use-the-anthropic-api-for-individual-use) | Individual/hobbyist API use is currently described as allowed under the Commercial Terms; that does not clear a pooled or consumer-facing M9R service. Keep credentials customer-scoped and retain provider-specific restrictions and data commitments in the M9R provider disclosure. |
| Google Gemini | [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) | Free/unpaid use can allow content to be used to improve products and reviewed by humans; paid use has different data treatment. Do not silently send sensitive workspace data through an unpaid path. The terms also include age, region, consumer-use, and competing-model restrictions. |
| Azure / Azure OpenAI | [Microsoft Product Terms](https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure) | Azure customer, region, data-processing, and service-specific terms control. The M9R provider record must identify the Azure tenant/project and region rather than treating Azure as generic OpenAI. |
| Mistral | [Commercial Terms](https://legal.mistral.ai/terms/commercial-terms-of-service/), [Legal Center](https://legal.mistral.ai/terms/get-started/) | Review the selected product and deployment path separately. Mistral's commercial terms distinguish Mistral infrastructure, partner infrastructure, and customer infrastructure, and restrict some third-party product integrations. |
| Cohere | [Legal terms](https://cohere.com/legal), [SaaS Agreement](https://cohere.com/saas-agreement) | Do not rely on a generic “all providers are equivalent” disclosure. Confirm the selected Cohere contract's data-use, subprocessors, and end-user rights before hosted routing. |
| Perplexity | [API Terms](https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service), [Search addendum](https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service-search) | Search output has separate ownership, citation, display, and reliability considerations. Preserve citations and do not promise that search output is owned or indemnified like ordinary model output. |
| Groq | [Legal policies](https://console.groq.com/docs/legal), [Services Agreement overview](https://console.groq.com/docs/legal/contractual-framework-overview) | Keep API keys and hosted-model terms customer-scoped; review the current service-specific terms and data-processing addendum for each deployment. |
| xAI | [Developer API docs](https://docs.x.ai/developers/rest-api-reference/inference), [xAI legal resources](https://x.ai/legal) | Before enabling hosted pass-through, capture the applicable API/enterprise terms, data processing terms, model restrictions, and regional availability. |
| Together AI | [Terms of Service](https://www.together.ai/terms-of-service), [privacy/security](https://docs.together.ai/docs/privacy-and-security) | Preserve model-specific third-party terms and the provider's data-sharing settings; do not represent Together-hosted models as M9R-owned models. |
| Cerebras | [Terms of Use](https://www.cerebras.ai/terms-of-service) | Their API terms require compliance with third-party model terms. Record the selected model and keep the model-provider restrictions visible to the customer. |
| Supabase | [Supabase Terms](https://supabase.com/terms), [DPA](https://supabase.com/legal/dpa) | Supabase is part of M9R Cloud's hosted control plane, not the local core. Keep service-role credentials private and provide the required privacy/DPA disclosures before commercial use. |
| Stripe | [General Services Agreement](https://stripe.com/legal/ssa), [Services Terms](https://stripe.com/legal/ssa-services-terms) | Stripe billing remains hosted/commercial. The account country, payment services, privacy/DPA, prohibited-business rules, refunds, and tax obligations must be finalized with the actual Stripe account holder. |

## Release decision

- The dependency inventory is ready for counsel/maintainer review.
- The provider matrix is ready for implementation of per-provider disclosures,
  key ownership rules, and a “terms not cleared” provider flag.
- This document does **not** grant permission to redistribute provider SDKs,
  bundle provider credentials, or resell provider access.
- The legal gate remains open until counsel confirms the license split, the
  BUSL change-license transition wording, trademark policy, and provider-specific
  hosted-routing terms.

## Sources and maintenance

The package inventory is derived from `package-lock.json` and
`cli/package-lock.json`. The provider links above are the primary terms or
official legal/documentation pages checked on 2026-09-10. Recheck them when a
provider SDK, account type, model catalog, billing arrangement, or data flow
changes.
