# Accepted Windows runtime

`accepted-runtime.json` records the owner-accepted complete Windows runtime. Its `buildId` and artifact hashes are the release allowlist.

`accepted-ui/m9r-overlay.exe` is the owner-confirmed live pill binary and the canonical pill input. Its SHA-256 must match `accepted-runtime.json` at `artifacts["m9r-overlay.exe"]`. The engine builder uses this exact path and rejects caller-selected binaries or a differing Cargo target. Promote a different pill only after its source and output have been owner-reviewed, then update this binary and the accepted runtime identity together.

Stable packaging checks every runtime artifact against this identity. The release publishes that identity as a separate policy asset. The installer compares stable packages to that external policy and never trusts the copy inside the ZIP as its own authority. Local candidates require an external candidate receipt bound to the exact ZIP, source commit, runtime build ID, and accepted pill hash.

Promote a new runtime only after its source snapshot and patch provenance are recorded, its full artifact set is reviewed, and the owner accepts that exact build. Keep prior accepted packages and rollback evidence until the new build has passed owner-run product checks. These hashes protect against accidental component mixing; they do not prove publisher identity or replace code signing.
