# Runtime-core release boundary

`@m9r/runtime-core` is the first independently buildable Apache-2.0 slice of
the M9R open core. It is intentionally small: it defines stable multiplayer
coordination and adapter contracts that future local runtimes can consume
without connecting to M9R Cloud.

## Included

- Local coordination/terminal protocol constants and bounded validation.
- Provider-neutral adapter configuration parsing and provider identity helpers.
- Provider-neutral Goal contract validation and explicit lifecycle transitions.
- Scoped Context Packet validation with provenance, sensitivity, redaction, and expiry.
- Evidence-backed Completion Receipt validation with explicit conditions and unresolved risk.
- Stable compatibility identifiers such as `oathlock-terminal-v1` and
  `oathlock-json-stdio`.
- TypeScript declarations and ESM output produced by `npm run build`.

The package is not currently marketed as a terminal product. It does not
include a PTY, process supervisor, terminal persistence, agent discovery,
reconnect implementation, or proof of Mosaic-level multiplayer terminal
behavior. Its terminal-named contracts are compatibility surfaces for future
runtime work, not a user-facing terminal promise.

## Excluded

- The dashboard and browser application.
- Supabase, Stripe, hosted relay operations, account administration, and
  M9R-hosted memory or retention.
- M9R credentials, provider credentials, tokens, `.oathlock` state, and
  deployment secrets.
- Hosted registration, evidence submission, billing, and enterprise controls.
- Goal persistence, authorization, mission creation, provider routing, and
  autonomous execution.

This boundary is a real package boundary, but it is not the complete offline
M9R control plane. The CLI's hosted commands and the unverified terminal
runtime remain outside the public promise until they have their own release
evidence. Do not describe this package as a complete self-hosted replacement
for M9R Cloud.
