# Open-core dependency audit

Audit date: 2026-09-10

This is a release-readiness record, not a legal opinion. It covers the current
repository dependency metadata and npm's production vulnerability report.

## Package metadata

The current `package-lock.json` contains 938 package entries, and all 938
entries include a license field in the lock metadata. This is a metadata
completeness check; it does not prove that every license is compatible with the
planned distribution boundary. Counsel should review the curated public
package and any bundled assets separately.

## Vulnerability result

The initial `npm audit --omit=dev` report found two production-tree
DOMPurify/Monaco vulnerability buckets. The remediation was deliberately
narrow: npm override `dompurify` to `3.4.15`, refresh only the lockfile, and
rerun the audit.

Current result: **0 vulnerabilities** from `npm audit --omit=dev`.

Repeat this audit after any Monaco or DOMPurify upgrade and before each public
package release.

## Required follow-up

- The current package/license inventory and provider-term matrix are recorded in
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Refresh it when the
  curated public package changes.
- Counsel must confirm compatibility for the curated package and any bundled
  adapters; lockfile metadata alone is not a clearance decision.
- The first Apache-2.0 package boundary is `packages/runtime-core/`; it is
  intentionally limited to protocol and adapter contracts and does not bring
  the terminal runtime or hosted control plane into the public package.
- Repeat this audit after the public package boundary is extracted.
