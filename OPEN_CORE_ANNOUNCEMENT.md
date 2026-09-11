# M9R source-available open-core announcement

## Safe preparation announcement

This version is safe to publish before the final repository snapshot and legal
review are complete because it announces the direction, not a completed public
release or a provider-success demo:

> M9R is preparing to open-source the core coordination layer behind its
> multiplayer AI workspace.
>
> The goal is simple: bring the agents you already use into one shared space,
> let them exchange work across providers, and keep humans in control of
> redirects, approvals, and handoffs.
>
> The initial release will be source-available open core. The provider-neutral
> `@m9r/runtime-core` package will be Apache-2.0, while M9R Cloud remains the
> managed layer for hosted workspaces, history, governance, billing, and team
> operations.
>
> We are deliberately not claiming a finished self-hosted terminal or uniform
> provider availability yet. We are publishing the boundary clearly and
> proving the real product before making broader promises.

Do not attach a provider-success demo to this version unless the corresponding
provider-attributed acceptance record has passed the launch gate.

## Final release announcement (gated)

> M9R is preparing a source-available open-core release.
>
> M9R is the multiplayer coordination layer for humans and the AI agents they
> already use. Bring compatible agents into one shared workspace, let them
> exchange work through a common protocol, and let people join, redirect,
> review, and approve what happens.
>
> The initial public boundary includes the provider-neutral
> `@m9r/runtime-core` contract slice and the documented multiplayer protocol
> surface. M9R Cloud continues to provide hosted workspaces, retained history,
> governance, billing, and managed operations.
>
> Provider connections remain customer-authorized and provider-specific:
> M9R does not transfer provider keys, pool customer credentials, or guarantee
> that every provider is available under the same terms or data policy.
>
> The repository is source-available under BUSL-1.1; the extracted
> `@m9r/runtime-core` package is Apache-2.0. This is not an announcement that
> the entire repository is OSI-approved open source. The terminal/resident
> runtime remains experimental and is not part of the initial terminal-product
> promise.

## Claims this draft may make

- Humans and compatible agents can collaborate in shared M9R workspaces.
- Provider availability and data handling remain subject to the connected
  provider's account, region, billing mode, and terms.
- The initial public package is provider-neutral and independently buildable.
- M9R Cloud is the managed layer for hosted multiplayer, retention,
  governance, billing, and operations.
- The source boundary, security policy, compatibility notes, trademark policy,
  and dependency/provider review materials are published with the release.
- The public architecture boundary is shown in
  [`docs/OPEN_CORE_ARCHITECTURE.md`](docs/OPEN_CORE_ARCHITECTURE.md).

## Claims this draft must not make yet

- That M9R is fully open source or that the whole repository is Apache-2.0.
- That M9R provides a production-ready self-hosted terminal or Mosaic-level
  terminal persistence.
- That a clean-machine terminal installation has been verified.
- That every provider has completed legal or commercial clearance.
- That a provider task completed when the observed result was only a timeout,
  quota error, or fixture-backed event.

## Launch assets still required before a broader product announcement

- A verified multiplayer demo using the actual supported connections.
- A license, dependency, trademark, and provider-terms review approved by the
  human owner and qualified counsel.
- A public repository snapshot whose exact staged file list has been reviewed.
