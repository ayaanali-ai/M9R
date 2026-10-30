# Accepted Windows runtime

`accepted-runtime.json` records the owner-accepted complete Windows runtime for stable packaging. Its `buildId` and artifact hashes are the release allowlist. It is not a selector for which pill binary to build.

`accepted-ui/m9r-overlay.exe` is a preserved historical artifact for recovery and comparison. Runtime builders do not load it. `npm run build:engine` compiles the pill from the current checkout into the same isolated staging root as the engine and hashes the resulting complete runtime. `M9R_OVERLAY_EXE` is rejected as a build input.

Stable packaging checks every runtime artifact against this identity; a source-built pill change must be deliberately reviewed and promoted into the stable identity first. The release publishes that identity as a separate policy asset. The installer compares stable packages to that external policy and never trusts the copy inside the ZIP as its own authority. Local candidates require an external candidate receipt bound to the exact ZIP, source commit, runtime build ID, and pill hash.

Promote a new runtime only after its source snapshot and patch provenance are recorded, its full artifact set is reviewed, and the owner accepts that exact build. Keep prior accepted packages and rollback evidence until the new build has passed owner-run product checks. These hashes protect against accidental component mixing; they do not prove publisher identity or replace code signing.
