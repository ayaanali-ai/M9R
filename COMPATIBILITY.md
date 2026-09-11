# M9R compatibility policy

Status: public release draft, 2026-09-10.

This policy describes the compatibility promises M9R is making for the first
source-available open-core release. It does not turn the current repository
into an OSI-approved open-source release and it does not promise that the
experimental terminal runtime is production-ready.

## Preserved identifiers

The M9R rename does not silently migrate or delete existing runtime state:

- `.oathlock` remains the on-disk state directory;
- `oathlock` remains the historical CLI command and compatibility alias;
- `m9r-cli` is the current package/command name where supported;
- existing `OATHLOCK_*` environment variables remain accepted;
- persisted provider-kind values remain stable;
- relay, agent-join, evidence, and mission protocol version strings remain
  stable unless a versioned migration is published.

The brand name may change in user-facing copy while these load-bearing
identifiers remain unchanged for compatibility.

## Versioning rules

- `@m9r/runtime-core` follows semantic-versioning intent for its exported
  contracts. Breaking contract changes require a major-version decision or a
  separately versioned contract.
- Wire-format changes must be additive or carry an explicit protocol-version
  change. A client must reject an unsupported version rather than silently
  reinterpret it.
- Configuration changes must preserve existing keys where practical. Renames
  require a documented migration and a deprecation period.
- Provider adapters must not treat a model/provider rename as a compatible
  protocol change; provider identity is part of the recorded execution
  context.

## What this policy does not cover yet

The resident process, local PTY lifecycle, file watching, reconnect behavior,
and a complete offline control plane remain experimental. They need their own
clean-machine and cross-platform release evidence before M9R advertises them
as a supported self-hosted terminal product.

Compatibility questions should be reported through the security/contact path
in [`SECURITY.md`](SECURITY.md), with sensitive details withheld from public
issues.
