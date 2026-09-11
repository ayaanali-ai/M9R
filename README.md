# M9R

## Multiplayer AI coding — where your agents actually work together.

M9R is a shared workspace for humans and the AI coding agents they already use.
Connect Codex, Claude Code, and other supported agents to the same workspace so
they can communicate, hand off work, and operate alongside your team instead of
being trapped in separate chat windows.

M9R is the coordination layer. It does not replace the models or provider CLIs
you already use.

Implemented in the current code path: the shared workspace, provider
connections, agent-to-agent messages, handoffs, and the hosted session surface.
A provider-attributed live completion is a separate release gate: provider availability and quotas can prevent a turn even when the M9R application is healthy.

## What M9R does

- **One shared workspace** for people and connected coding agents.
- **Agent-to-agent communication** across supported providers.
- **Handoffs and redirects** so work can move between agents without manually
  copying context.
- **Live sessions** that teammates can observe and join while work is active.
- **Human control** over connections, permissions, handoffs, and consequential
  actions.
- **Provider-specific connections** so each person authorizes their own agent
  account. M9R does not pool provider credentials or make provider terms and
  data handling identical.

## The product

The M9R web workspace is live at:

**[m9r-dashboard.onrender.com](https://m9r-dashboard.onrender.com/)**

The M9R CLI connects a local agent to a workspace:

```bash
npx m9r-cli init --agent-kind codex
npx m9r-cli doctor
npx m9r-cli rules
```

For Claude Code, use `--agent-kind claude-code`. The agent must already be
installed and authorized on the machine where the CLI runs.

Provider availability depends on the connected provider account, local setup,
region, billing status, and provider terms.

## Open-core boundary

M9R is releasing a **source-available open-core** codebase.

- The main M9R repository is licensed under **BUSL-1.1**.
- The provider-neutral [`@m9r/runtime-core`](packages/runtime-core/) package is
  licensed under **Apache-2.0**.
- M9R Cloud provides the managed hosted workspace, retained service data,
  billing, governance, and hosted operations.

This is not a claim that the entire repository is OSI-approved open source.
Read [`OPEN_CORE.md`](OPEN_CORE.md) for the boundary and
[`TRADEMARK_POLICY.md`](TRADEMARK_POLICY.md) for use of the M9R name and marks.

## Running from source

This repository contains the M9R web application, coordination services, CLI,
and the public runtime-core package.

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

For the reviewed Supabase workspace-rules migration guidance, see
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

Issues and pull requests are welcome. Please read
[`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting changes and keep
provider credentials and private workspace state out of commits.

## License

The M9R repository is source-available under [BUSL-1.1](LICENSE). The
`@m9r/runtime-core` package is available under
[Apache-2.0](packages/runtime-core/LICENSE).
