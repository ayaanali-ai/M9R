# Accepted Windows runtime

`accepted-runtime.json` records the currently owner-accepted complete Windows runtime. Its `buildId` and artifact hashes are the release allowlist.

`accepted-ui/m9r-overlay.exe` is the preserved pill binary. Its SHA-256 must match `accepted-runtime.json` at `artifacts["m9r-overlay.exe"]`. The engine builder uses this path by default; an explicit `M9R_OVERLAY_EXE` is accepted only when its bytes match the same hash. Cargo target output is never an automatic fallback.

The release packager checks every runtime artifact against this identity. The installer checks the package identity and the extracted artifact hashes before asking for setup consent or changing files. A ZIP checksum alone is not approval to install a runtime.

Promote a new runtime only after its source snapshot and patch provenance are recorded, its full artifact set is reviewed, and the owner accepts that exact build. Update the pill artifact and accepted runtime identity together when promoting a pill change. Keep prior accepted packages and rollback evidence until the new build has passed owner-run product checks. These hashes protect against accidental component mixing; they do not prove publisher identity or replace code signing.
