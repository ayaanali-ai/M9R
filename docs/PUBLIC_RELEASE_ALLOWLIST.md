# M9R public release allowlist

Status: engineering release manifest, 2026-09-10.

This manifest separates three things that must not be conflated:

1. the small Apache-2.0 `@m9r/runtime-core` package;
2. the wider M9R repository, which remains source-available under BUSL-1.1;
3. the hosted service and local/private material that must not ship as public
   package content.

## Apache-2.0 package

The first distributable Apache-2.0 package is limited to:

- `packages/runtime-core/dist/` — generated package output;
- `packages/runtime-core/README.md`;
- `packages/runtime-core/BOUNDARY.md`;
- `packages/runtime-core/LICENSE`;
- `packages/runtime-core/NOTICE`;
- the package metadata and exports in `packages/runtime-core/package.json`.

The package contains provider-neutral protocol and adapter contracts only. It
does not contain the dashboard, hosted relay, authentication, billing,
provider credentials, retained workspace data, or the experimental terminal
runtime.

## Source-available repository

If the wider repository is published, its source remains governed by the root
BUSL-1.1 license and its Additional Use Grant. The following public materials
must accompany that source:

- `LICENSE` and `cli/LICENSE`;
- `OPEN_CORE.md`, `OPEN_CORE_ANNOUNCEMENT.md`, and `OPEN_CORE_LAUNCH_PLAN.md`;
- `COMPATIBILITY.md`, `SECURITY.md`, `TRADEMARK_POLICY.md`, and
  `THIRD_PARTY_NOTICES.md`;
- `docs/OPEN_CORE_ARCHITECTURE.md`;
- `HOSTED_TERMS_DRAFT.md` and the legal/dependency review packet;
- the public README and the versioned package documentation.

Publishing the wider source does not grant rights to M9R marks, production
credentials, hosted account data, or third-party provider accounts.

## Never include in a public release snapshot

- `.env`, `.env.*` except reviewed examples;
- `.oathlock/local.json`, live tokens, runtime state, or local logs;
- `.claude/settings.local.json` and other machine-local configuration;
- `.release-excluded/`, `artifacts/`, raw demo recordings, screenshots, and
  generated decks;
- `node_modules/`, `.next/`, temporary npm caches, and test output;
- Supabase service-role credentials, Stripe secrets, provider credentials, and
  deployment secrets;
- unreviewed customer content, transcripts, attachments, or workspace exports.

## Internal working material excluded from the initial snapshot

These files are useful for product direction and design review, but are not
required to announce or distribute the first multiplayer-first open-core
boundary. Keep them out of the initial staged snapshot unless the owner
explicitly reviews them for publication:

- `docs/M9R_SPATIAL_DESIGN.md`;
- `docs/designs/m9r-personal-agent-goal-gateway.md`;
- `docs/research/multiplayer-agi-master-strategy.md`;
- `docs/research/multiplayer-agi-complete-audit.md`.

The initial snapshot also excludes the broader internal material categories
that are not required to run or understand the multiplayer-first release:

- `docs/designs/`, `docs/hackathon/`, `docs/proof/`, `docs/research/`, and
  `docs/research-*`;
- internal strategy, planning, phase-audit, historical RunLeak, and provider
  integration planning documents listed in the release-manifest checker;
- `oathlock-specs-complete/`, `runleak-analyzer-mvp/`, and `experiments/`;
- historical screenshots, trace exports, and old OathLock/V2 planning files.

These files remain in the working tree for project history and tests, but the
manifest and staged-snapshot gate omit them from the first M9R public release.

The Goal Gateway application slice is also excluded until its unapplied
migration, hosted authorization path, and public product contract receive a
separate review:

- `src/app/api/agent/goals/`;
- `src/app/api/goals/`;
- `src/lib/goal/`;
- `scripts/goal-gateway.test.ts`;
- `scripts/goal-workforce.test.ts`;
- `supabase/migrations/20260910213942_goal_gateway.sql`;
- `supabase/migrations/20260910221615_goal_context_receipts.sql`.

The provider-neutral Goal contract at
`packages/runtime-core/src/goal-contract.ts` is part of the public runtime-core
slice; excluding the hosted gateway does not remove that contract from the
Apache-2.0 package.

## Release procedure

Before publication, run these checks from a clean release candidate:

```text
npm run open-core:public-surface
npm run open-core:public-surface -- --staged
npm run open-core:check -- --strict
npm run open-core:history-audit
npm run open-core:manifest -- --check
npm audit --omit=dev
npm run typecheck
npm run lint
npm run build
```

Before staging, run `npm run open-core:manifest` and save its JSON output
outside the repository for human review. It records the exact eligible paths,
sizes, and SHA-256 hashes without changing the Git index. The `--check` form
fails closed if a required release document is missing or an excluded path is
present in the candidate tree.

The checks prove repository state only. A release still requires a human
review of the exact staged file list, provider/dependency terms, legal packet,
and live hosted multiplayer behavior.
