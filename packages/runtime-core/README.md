# `@m9r/runtime-core`

This is the first extracted slice for M9R's planned open core. It contains only
provider-neutral coordination contracts, protocol constants, and validation for
operator-authored adapter configuration, durable Goal requests, scoped Context
Packets, and evidence-backed Completion Receipts.

This package is Apache-2.0. It is intentionally a library boundary, not a
promise that M9R's terminal runtime or hosted multiplayer service is ready for
general self-hosted distribution.

The rest of the repository remains under the current repository license until
the local/cloud split is completed and reviewed. M9R Cloud remains the managed
multiplayer and commercial service.

It does not contain the dashboard, M9R Cloud API client, Supabase, Stripe,
hosted relay operations, provider credentials, authentication, a PTY manager,
terminal persistence, agent discovery, Goal persistence, authorization, mission
creation, provider routing, or a complete offline control plane.
Existing application imports continue to use compatibility shims while the
boundary is verified.

```bash
npm run build
```

The package preserves compatibility identifiers such as
`oathlock-terminal-v1` and `oathlock-json-stdio`. The M9R name and marks are
reserved; see the [M9R trademark policy](https://github.com/ayaanali-ai/M9R/blob/main/TRADEMARK_POLICY.md).
