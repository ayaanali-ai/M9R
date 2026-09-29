# M9R

M9R makes browser work multiplayer: people and provider-neutral agents coordinate on the same owner-approved web task.

## What M9R does

M9R connects people and agents across providers through shared tasks, messages, and owner-controlled browser access. It does not replace provider agents, pool their credentials, or unify their quotas and data policies.

## Start the open-web demo

Use the one supported local setup path:

```powershell
m9r web setup
```

For a repository checkout before the updated CLI is installed, run `npm ci`, `npm run build:cli`, then `node .\cli\dist\m9r.js web setup`. Setup configures the local broker and provider entries and gives you the exact unpacked-extension folder to load in Chrome or Edge. Do not also run the development broker script or load a second extension copy; those are manual troubleshooting paths, not additional installs. See the [Windows extension setup guide](docs/INSTALL_EXTENSION.md) for the manual steps and current provider limitations.

The owner grants access per site. M9R coordinates approved page reads and actions through the local broker; it does not bypass sign-in, CAPTCHAs, site rules, or provider limits. Password and selected sensitive-field types are blocked, but ordinary page content may still be sensitive and can be shared with the agent/provider you choose. This is an early local workflow, not universal browser compatibility or a guarantee that every action succeeds.

Each agent must already be installed and authorized. Account access, quotas, and data handling remain subject to provider terms.

## What is proven today

Implemented in the current code path, with automated tests: the local web broker and its per-site claims and owner approvals; the browser extension's presence overlay, message bar and thread pill; agents on one computer messaging each other from their own terminals, with approvals for agent-started work; and the M9R Web setup and CLI.

Not yet proven end to end: provider-attributed live completion, meaning a third-party agent finishing a whole shared task under its own provider account with M9R coordinating it. That is a separate release gate and is not claimed here. Provider availability and quotas can prevent a turn from completing, and cross-machine sharing between different people is not built yet.

## Open-core model

M9R is a **source-available open-core** project:

- The root application and CLI are licensed under **BUSL-1.1**.
- The provider-neutral [`@m9r/runtime-core`](packages/runtime-core/) package is
  licensed under **Apache-2.0**.
- M9R Cloud provides the managed hosted workspace, retained history, governance,
  billing, and hosted operations.

This repository is not claiming that the entire project is OSI-approved open
source or Apache-licensed. Read [`OPEN_CORE.md`](OPEN_CORE.md) for the boundary
and [`TRADEMARK_POLICY.md`](TRADEMARK_POLICY.md) for use of the M9R name and marks.

## Running from source

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

For self-hosting requirements and service configuration, see
[`SELF_HOSTING.md`](SELF_HOSTING.md). Never commit provider credentials,
service-role keys, or local CLI credential files.

Database migrations live in `supabase/migrations/`; the Workspace Rules migration has its own guide in
[`docs/migrations/workspace-rules-v5.1.md`](docs/migrations/workspace-rules-v5.1.md).

## Runtime core

`@m9r/runtime-core` contains provider-neutral contracts for coordination and
adapter integrations. It is intentionally separate from M9R Cloud's hosted
services and account infrastructure.

See the [runtime-core README](packages/runtime-core/README.md) and its
[boundary document](packages/runtime-core/BOUNDARY.md).

## Security and limitations

M9R coordinates connected agents; it does not guarantee that an agent's output
is correct. Provider authentication, model availability, quotas, permissions,
and data handling remain part of the connected provider's responsibility.

Read [`SECURITY.md`](SECURITY.md) before connecting an agent or deploying an
instance. Report security issues privately using the process in that file.

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md)
before submitting changes. Keep provider credentials, local CLI state, customer
content, and deployment secrets out of commits.

## License

The M9R repository is source-available under [BUSL-1.1](LICENSE). The
`@m9r/runtime-core` package is available under
[Apache-2.0](packages/runtime-core/LICENSE).
