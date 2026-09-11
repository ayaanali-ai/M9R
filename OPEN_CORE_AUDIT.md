# M9R Open-Core Boundary Audit

This is an implementation-readiness audit, not a license grant. It records
what is observable in the current repository before any public extraction.
The published M9R repository is a curated source snapshot. The boundary in
`OPEN_CORE.md` is the scoped release design, not a claim that every internal
working-tree file or hosted operation is distributable.

The dedicated Codex app-server multiplayer path was removed on 2026-09-10;
the supported Codex integration remains the existing ACP provider adapter.
`npm run open-core:check -- --strict` passes the deterministic source and
metadata checks. It does not replace the manual release review below.

## Observed repository shape

- The root package is `private: true` and now declares BUSL-1.1, but it combines
  the Next.js dashboard, Supabase access, Stripe billing, relay clients, agent
  adapters, terminal runtime code, tests, fixtures, and release tooling.
- `cli/` is a packageable candidate, currently named `m9r-cli`, with the
  historical `oathlock` executable retained as a compatibility alias. Its
  current package license is BUSL-1.1, so it is not yet an Apache-2.0 open-core
  package.
- The CLI has a narrow local-only terminal mode, but the distributable still
  bundles both local runtime code and hosted-control clients. `init`, rules,
  inbox, run, evidence, presence, and mission commands remain hosted
  integrations; `terminal runtime --local-only` is the first local slice and
  does not make the whole CLI offline.
- The repository tracks the local terminal/resident implementation across
  `src/lib/local-terminal-*`, resident modules, provider adapters, and mission
  protocol/relay modules. Those files are not yet an independently installable
  package with a stable dependency boundary.
- `packages/runtime-core/` is now the first independently buildable Apache-2.0
  local package slice. Its exact included/excluded surface is documented in
  `packages/runtime-core/BOUNDARY.md`; it is not the complete offline control
  plane or a terminal-product promise.

## Boundary map

| Area | Current status | Release decision |
| --- | --- | --- |
| Local PTY, terminal session, file-watch, resident primitives | Mixed into the monorepo | Candidate for Apache-2.0 core after import/dependency isolation |
| Provider adapter contracts and local agent integrations | Mixed; some paths call hosted APIs | Split local adapters from hosted registration/evidence paths |
| Mission relay protocol/client | Shared and currently defaults to hosted relay paths in runtime code | Publish only after a documented local relay/self-host mode exists |
| Dashboard, auth, workspace APIs, Supabase stores/migrations | Hosted control plane | Keep outside the initial open-core package |
| Stripe billing, prepaid/provider-cost accounting | Hosted/commercial | Keep private |
| M9R-native provider credential vault and admin routes | Hosted/sensitive | Keep private |
| `render*.yaml`, production relay deployment configuration | Operational deployment | Keep out of the core package; publish sanitized examples later |
| Tests, proof artifacts, screenshots, videos, old planning material | Mixed and broad | Curate a public release set; do not expose the current tree wholesale |

## Release findings and current disposition

1. No complete offline control plane exists yet. The repository now has a
   deliberately small independently buildable `@m9r/runtime-core` slice. The
   full local runtime and hosted-control client remain bundled in the CLI, so
   the first announcement must not present the CLI as a complete self-hosted
   replacement.
2. The complete local runtime and hosted-control client are still bundled
   together in the CLI build. This is a deferred terminal/self-hosting gate,
   not a blocker for the scoped multiplayer-first announcement.
3. The pre-cleanup repository included 61 generated/demo artifact files of
   roughly 117 MB. They are removed from the public snapshot and excluded by
   the release boundary; the snapshot uses an explicit allowlist.
4. User-local `.claude/settings.local.json` and generated/demo output are
   outside the public release surface. The release snapshot was checked against
   the public-surface gate, which rejects known debug, credential, and
   generated-output paths.
5. Generated runtime state under `cli/.oathlock/` is ignored for the watchdog
   lock and log, and the tracked copies are excluded from the release surface.
6. Git history contains historical `.oathlock/*` paths. The reproducible full
   history scan is now complete and found only documented synthetic redaction
   fixtures; the published snapshot uses a clean root commit rather than
   carrying the old internal history forward.
7. A bounded high-confidence secret-pattern scan found 21 current-tree matches
   and 10 historical matching commits. The reproducible history audit now
   classifies all historical matches as synthetic redaction fixtures in
   `docs/REAL_PROVIDER_TRACE_PRIVACY.md` and
   `runleak-analyzer-mvp/cases/006-redaction/dirty_trace.json`; it prints no
   matched content. Current-tree matches are covered by the same explicit
   review/allowlist gate.
8. The CLI documentation previously named `M9R_*` variables and an obsolete
   default URL while the implementation uses `OATHLOCK_*` and
   `https://m9r-dashboard.onrender.com`. The documentation was corrected in
   `cli/README.md`.
9. `npm audit --omit=dev` initially reported 10 production-tree advisories,
   including a critical Next.js issue. Next.js 16.3.4, the patched `sharp`
   override, and a targeted `dompurify@3.4.15` override are now installed;
   the current audit reports 0 vulnerabilities. Repeat it after dependency
   changes and review the curated public package separately.

10. The reproducible history check is `npm run open-core:history-audit`. It
    prints commit ids only and fails closed while any high-confidence match is
    unreviewed. It does not rewrite history.

11. `COMPATIBILITY.md` and `HOSTED_TERMS_DRAFT.md` now provide the public
    compatibility promise and the counsel handoff packet. Neither document is
    a substitute for final legal approval.

12. The full repository suite now reports 2,162 passing and 0 failing tests.
    Targeted release gates, typecheck, lint, production build, runtime-core
    tests, terminal bridge tests, Windows smoke, dependency audit, and both
    public-surface checks also pass. This is repository-wide test readiness,
    not legal approval or proof of a clean-machine/Mosaic-level terminal.

13. `docs/PUBLIC_RELEASE_ALLOWLIST.md` now separates the Apache-2.0 package,
    the wider BUSL source-available repository, hosted-only operations, and
    files that must never enter a public release snapshot.

14. Windows-specific launch coverage passes on the current workstation:
    `scripts/oathlock-windows-service.test.ts` and
    `scripts/oathlock-autostart.test.ts` passed 20/20 tests. This verifies the
    generated per-user PowerShell/Scheduled Task contract and cross-platform
    launch-script builders; it is not evidence of a fresh-machine terminal
    install or Mosaic-level terminal behavior.

15. A bounded acceptance conversation was inspected through the exact public
    Render deployment on 2026-09-10 using the authenticated M9R CLI. A
    `claude-code -> everyone` result returned the provider-owned weekly-limit
    error. The expected OpenCode acknowledgement is labeled `you -> everyone`
    and its handoff is labeled `you -> you`, so it is ambiguous self-authored
    evidence rather than provider-attributed OpenCode completion. This is not
    sufficient proof of successful live multi-provider routing; no clean
    two-provider acceptance run is retained.

16. The live pricing page was checked on 2026-09-10 and presents Free / Pro /
    Team. The release plan now matches the observed surface: Pro is $14 per
    seat monthly or $11 per seat billed annually ($132 yearly), and Team is
    custom. This is product packaging evidence only; billing enforcement and
    final hosted terms remain separate decisions.

## Safe next release order

1. Keep `packages/runtime-core` limited to its reviewed Apache-2.0 protocol and
   adapter-contract boundary until the full local runtime is proven and split.
2. Keep the local-only runtime smoke test green and expand it to reconnect,
   provider detection, file activity, and two local sessions.
3. Make the CLI depend on the extracted local package, while keeping hosted
   registration/evidence commands explicitly identified as integrations.
4. Run dependency/license/history audits on the curated package and public
   allowlist.
5. Have counsel review the repo-wide BUSL terms, Apache-2.0 package split,
   hosted-use grant, trademark policy, commercial boundary, and provider terms
   before public redistribution or final hosted-service terms. Do not describe
   counsel review as complete until it actually occurs.

## Compatibility constraints

The extraction must preserve `.oathlock`, `oathlock`/`m9r-cli` command
compatibility, `OATHLOCK_*` variables, provider-kind values, and relay/evidence
protocol versions. Branding and licensing changes must not silently migrate
existing workspaces.
