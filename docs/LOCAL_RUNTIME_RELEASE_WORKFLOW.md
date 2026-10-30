# Local M9R runtime release workflow

Use this path when changing the engine, provider bridge, hook, broker, or other packaged runtime code.

## Build a candidate

From the repository root, run `npm run build:candidate` on Windows. The command builds the CLI and runtime under a unique `engine/candidates/<UTC-time>-<source-commit>/` directory, then packages that same runtime. It records the source commit, runtime build ID, accepted pill hash, and package checksum in `candidate.json`.

The candidate builder reads the accepted pill at `release-assets/accepted-ui/m9r-overlay.exe` and verifies it against `release-assets/accepted-runtime.json`. It does not publish into `cli/dist` or `engine/dist`, update the accepted runtime policy, or write to the installed `%USERPROFILE%\.m9r\bin`.

If packaging fails after the runtime has been built, resume packaging that exact verified runtime with `npm run build:candidate -- --resume .\engine\candidates\<candidate-id>`. Resume refuses paths outside `engine/candidates/`, rechecks the full runtime manifest, and will not overwrite a completed candidate.

## Review and promote

Review `candidate.json` and `runtime/m9r-build-info.json`. The source commit identifies the code; the runtime build ID identifies the exact packaged files; the package SHA-256 identifies the installer archive. The candidate must retain the currently accepted pill hash unless a pill change is deliberately reviewed and promoted.

Install an accepted local candidate through a runtime-only update flow. Do not use the first-run installer for a routine runtime update: that flow also previews and applies agent setup and startup configuration. The runtime-only updater must verify the candidate manifest, quiesce only M9R-owned processes, replace only the manifest-listed runtime files transactionally, and restart the owned broker. If an artifact is locked, it must stop without partially replacing the install and report the exact file.

For a public release, promote the reviewed runtime manifest to `release-assets/accepted-runtime.json`, package that exact runtime, and retain one verified previous runtime for rollback. Never source a release binary from an arbitrary worktree, Cargo target folder, or old package directory.

`engine/candidates/` is ignored by Git and excluded from the root Docker build context. Candidates are generated artifacts; source and policy changes remain version-controlled.
