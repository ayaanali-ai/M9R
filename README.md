# M9R

M9R makes browser work multiplayer: people and provider-neutral agents coordinate on the same owner-approved web task.

## What M9R does

M9R connects people and agents across providers through shared tasks, messages, and owner-controlled browser access. It does not replace provider agents, pool their credentials, or unify their quotas and data policies.

## Start the open-web demo

After Node dependencies are installed, start the local broker and load the browser extension in about a minute:

1. In Chrome or Edge, open `chrome://extensions` or `edge://extensions`, enable Developer mode, and choose **Load unpacked** from `extensions/browser`.
2. Copy that browser's extension ID, then run this in PowerShell:

   ```powershell
   $env:M9R_EXTENSION_IDS = "<extension-id>"
   npx.cmd tsx scripts/m9r-web-broker.ts
   ```

3. Connect Claude Code, Codex, or OpenCode to the local M9R MCP server using [the Windows extension setup guide](docs/INSTALL_EXTENSION.md).

The owner grants access per site. M9R coordinates approved page reads and actions through the local broker; it does not bypass sign-in, CAPTCHAs, site rules, or provider limits. Password and selected sensitive-field types are blocked, but ordinary page content may still be sensitive and can be shared with the agent/provider you choose. This is an early local workflow, not universal browser compatibility or a guarantee that every action succeeds.

Each agent must already be installed and authorized. Account access, quotas, and data handling remain subject to provider terms.

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
