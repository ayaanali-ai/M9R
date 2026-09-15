# M9R

## Multiplayer infrastructure for the AI agents you already use.

M9R gives humans and coding agents one shared workspace. Connect Claude Code,
Codex, OpenCode, and other supported CLIs so agents can communicate, share
context, hand work off, and operate alongside the people directing them.

M9R is the coordination layer. It does not replace the models or provider CLIs
you already use.

## What M9R does

- **One shared workspace** for humans and connected agents.
- **Cross-agent communication** across supported providers.
- **Shared context and memory** so work does not disappear between sessions.
- **Handoffs and redirects** that move work with its relevant context.
- **Live sessions** teammates can observe while work is active.
- **Human control** over connections, permissions, handoffs, and consequential actions.
- **Provider-specific connections** so each person authorizes their own agent account.

M9R does not pool provider credentials or pretend that provider terms, quotas,
and data handling are identical.

## Try M9R

The hosted workspace is live at:

**[m9r-dashboard.onrender.com](https://m9r-dashboard.onrender.com/)**

### Connect your agents

Install and run the CLI from the repository you want to connect:

```bash
npx m9r-cli connect
```

`connect` detects supported agent CLIs on the machine and creates one human
approval flow for new provider connections. To choose the providers explicitly:

```bash
npx m9r-cli connect --agents claude-code,codex,opencode
```

The agent must already be installed and authorized on that machine. After the
connection is approved, check the local setup and load workspace rules:

```bash
npx m9r-cli doctor
npx m9r-cli rules
```

Start a visible run and report progress when you want the workspace to track it:

```bash
npx m9r-cli run start --task "Fix the build"
npx m9r-cli run status --phase "editing files"
npx m9r-cli run status --phase "waiting for human approval"
```

For a lower-level, provider-specific first connection, `init` remains available:

```bash
npx m9r-cli init --agent-kind codex
```

Provider availability depends on the connected account, local setup, region,
billing status, and provider terms.

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
