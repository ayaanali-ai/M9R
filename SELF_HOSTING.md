# Self-hosting M9R (experimental maintainer notes)

> This document is not a public terminal-product promise. The first release is
> multiplayer-first: `@m9r/runtime-core` is the reviewed Apache-2.0 package,
> while the resident/terminal path remains experimental until the deferred
> clean-machine, reconnect, and persistence gates pass.

This guide records the experimental local-runtime path for the M9R
source-available release. The first public announcement is multiplayer-first:
it does not promise a production-ready terminal runtime, Mosaic-level terminal
persistence, or a complete offline control plane. The remaining local-runtime
gates are tracked in [`OPEN_CORE.md`](OPEN_CORE.md).

## Intended experience

```text
install the M9R runtime
        ↓
connect an existing coding agent
        ↓
start the local resident
        ↓
open the local/self-hosted workspace
        ↓
share only the sessions and files a human chooses
```

The browser is a collaboration surface. The resident remains the authority for
real local terminals, agent processes, and file activity.

## Current connection path

The hosted CLI path connects a local workspace to an M9R-compatible Agent Join
API. It does not provide a complete offline dashboard or local replacement for
M9R Cloud. A user testing the hosted package should use:

```bash
npx --yes m9r-cli@latest init --agent-kind claude-code
npx m9r-cli doctor
npx m9r-cli terminal runtime
```

For a local development server, set `OATHLOCK_API_URL` before `init`:

```bash
# PowerShell
$env:OATHLOCK_API_URL = "http://localhost:3000"
npx --yes m9r-cli@latest init --agent-kind codex

# macOS/Linux
export OATHLOCK_API_URL=http://localhost:3000
npx --yes m9r-cli@latest init --agent-kind codex
```

`init` is a human-approved connection step. The CLI stores local connection
state under `.oathlock`; it does not require renaming that directory to `.m9r`.
The historical `oathlock` executable remains available as a compatibility
alias.

The existing `oathlock` command and `.oathlock` directory remain compatibility
identifiers during the migration. They must not be removed by the open-core
release.

## Local-only mode: experimental implementation; full control plane remains a release gate

The CLI has a deliberately narrow local-only runtime experiment. It can start
the loopback terminal server without requiring an M9R account, hosted relay, or
agent token, but this path is not release-supported and must not be advertised
as the M9R terminal product:

```bash
npx --yes m9r-cli@latest terminal runtime --local-only
```

Open a local provider workspace directly at
`http://127.0.0.1:43117/workspace?provider=codex` (replace `codex` with a
supported provider). This mode runs real local PTYs and keeps their terminal
traffic on loopback. It does not yet provide hosted multiplayer, retained
history, approvals, evidence, or a local replacement for the full M9R Cloud
control plane.

A completed local-only release must be able to:

- run the resident without an M9R Agent Join API;
- start and reconnect to real terminal sessions;
- detect supported agents;
- record local file activity without uploading raw source by default;
- expose a documented local API/socket boundary;
- keep secrets in local configuration that is excluded from version control;
- explain clearly which features require a hosted relay or external provider.

The current implementation passes only the narrow terminal-start boundary:
registration, rules, inbox, run lifecycle, evidence, and hosted mission
commands still use the configured M9R API. Do not describe the current package
as an offline replacement for M9R Cloud until the remaining local-only
control-plane and smoke-test gates are complete.

## Hosted mode

Hosted mode adds the collaboration layer:

- authenticated workspaces;
- team members and agent ownership;
- relay-backed live sessions;
- approvals, evidence, and review history;
- retained memory and organization policy;
- billing and managed model execution.

The self-host guide must never ask a user to paste a service-role key into a
browser or commit a local agent token.

## Future local-runtime checklist

Maintainers can validate the packed CLI without touching the current
workspace's `node_modules` with:

```bash
npm run self-host:smoke
```

This is an isolated same-machine package/install smoke test. It proves the
current Windows package path, but it is not a terminal self-hosting launch
claim or a substitute for a future fresh-platform matrix.

Windows verification completed on 2026-09-10 in the current Windows
workspace: `npm run self-host:smoke` packed the CLI, installed it into an
isolated temporary directory using a temporary npm cache, and executed the
installed `m9r-cli help` entrypoint successfully. This proves the Windows
package/install path on this machine; it is not a clean-OS matrix result.

- [x] Current Windows workstation package/install smoke test.
- [ ] Fresh Windows install for the future terminal release.
- [ ] Fresh macOS install.
- [ ] Fresh Linux install.
- [ ] One-agent local-only smoke test.
- [ ] Two-agent local-only smoke test.
- [ ] Browser-to-resident terminal event test.
- [ ] File activity and diff test.
- [ ] Reconnect after closing the browser.
- [ ] No raw credentials in logs, bundles, examples, or packed artifacts.
- [ ] Self-host deployment with documented database migrations.
- [ ] Upgrade path that preserves `.oathlock` state.
- [ ] Uninstall path that explains what local state is retained or removed.
