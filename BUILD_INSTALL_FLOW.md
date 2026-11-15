# M9R build / update / install flow — locked, enforced in code

This is the one place to look (or to point another agent at) for how M9R gets
built, packaged, and installed. It is linked from `AGENTS.md` so every Claude
Code session in this repo sees it automatically. If this document and the code
ever disagree, the code wins — fix one or the other immediately, don't leave
them split.

Everything below used to be *decided* (see the "locked in" section this file
replaces, formerly in `PROGRESS_NOTES.md`) but not *enforced*. As of
2026-11-11 it is enforced as real guard code, found by trying to trip each
guard on a live build/install run.

## 1. One folder, one trunk (guards 1A / 2B / 3A)

- **1A** — there is exactly one working folder: `C:\RunLeak\runleak`. No
  long-lived worktrees, no second checkout.
- **2B** — the designated trunk branch is whatever is written in
  `scripts/trunk-branch.txt` (currently `codex/recovery-build-20261110`,
  tonight's recovery branch — this is a placeholder carried over from the
  recovery effort, not a final naming decision; update that file, not this
  one, when the long-term convention changes).
- **3A**, enforced in `scripts/build-candidate.mjs` (runs first, before
  anything else): refuses to build unless —
  1. `cwd` is exactly `C:\RunLeak\runleak` (or `CI=1` is set, for a CI
     checkout's own directory),
  2. the current branch matches `scripts/trunk-branch.txt`,
  3. `git status --porcelain=v1` is clean, with **no exceptions** besides
     `engine/candidates/` (this script's own prior outputs — never source).

  Anything else untracked or modified is a hard refusal. There is no
  "just this once" override. If a build trips this and you didn't expect it,
  the fix is to commit, gitignore, or delete the offending path — never to
  widen the exception list casually. (`build-engine.mjs` runs a second,
  content-aware dirty check of its own — see §3 below — with a short,
  deliberate exclusion list for retained local evidence; that list is not the
  same regex as 3A's, and both have been tripped and verified for real.)
- **3B**, enforced in `scripts/build-candidate.mjs`, immediately after 3A and
  before any compile step: runs `npx tsc --noEmit -p .` across the whole
  project and hard-refuses the build if it does not pass clean. 3A only
  proves the tree is clean and on trunk; it says nothing about whether the
  source is actually valid. A real regression shipped past that gap on
  2026-11-11: a fix referenced `deps` inside a function that does not close
  over it (`createPersistentWindowsStageHost`, a standalone factory, not a
  closure inside `createWindowsDesktopStageManager`), compiled fine under
  the bundler (no cross-file type resolution there), and only surfaced
  **after a real install**, live, as `Blocked: M9R could not launch Notepad
  because the native desktop helper is unavailable (deps is not defined)`.
  `tsc --noEmit` catches that class of error in seconds; nothing before this
  guard ever ran it as part of the build. 3B runs first, before the ~10
  minute from-source compile, so a typecheck failure fails fast instead of
  burning a full build first.

- **3C**, immediately after the typecheck: runs `node scripts/run-test-suite.mjs all`
  and refuses compilation if the aggregate behavioral suite fails. Its explicit
  manifest is `scripts/test-files.json`; real-desktop side-effect tests remain
  separate from this build gate. Passing it does not establish live acceptance.
  Native renderer tests are also run separately with `cargo test` before a
  cursor change is released; compilation alone is not a renderer test.

## 2. The pill is always built from source (guard 4A)

There is no committed, "owner-accepted" `m9r-overlay.exe` and no manual
accept step. `scripts/build-engine.mjs` runs `npm run build` (a real Tauri
build) in `overlay/` fresh on **every single build**, deletes any prior
`overlay/src-tauri/target/release/m9r-overlay.exe` first, and fails loudly if
the fresh binary isn't produced. `M9R_OVERLAY_EXE` as a build input is
explicitly rejected.

This replaced a design where a pre-built, manually-"accepted"
`release-assets/accepted-ui/m9r-overlay.exe` was copied instead — the exact
gap that let a real pill source fix (hiding the work-mode toggle) sit
committed for hours without ever actually shipping, discovered live on
2026-11-11. That design is gone, not deprecated — don't resurrect a
static-pill shortcut for "speed."

Verified for real: a full `build-candidate.mjs` run shows
`Compiling m9r-overlay v0.1.0` and `Packaged .../m9r-overlay.exe, built fresh
from overlay/ source this run` every time.

## 3. Candidate build (`npm run build:candidate`)

`scripts/build-candidate.mjs`:
1. Runs guard 3A (above).
2. Builds the CLI, engine (SEA executables), native-input-host, and pill —
   all from source — into an isolated `engine/candidates/<timestamp>-<short
   sha>/` directory. Never touches `cli/dist`, `engine/dist`, or
   `~/.m9r/bin`.
3. `build-engine.mjs` independently computes source provenance via content
   diffs (`git diff --quiet`, not just `git status`, so native tooling
   touching a tracked file's mtime doesn't false-positive) plus
   `git ls-files --others --exclude-standard`, against a short, explicit list
   of retained-local-evidence path patterns (diagnostics, scratch roots,
   private trackers, `engine/` itself, etc. — see
   `heldLocalProvenancePatterns` in that file). Anything untracked outside
   that list makes the runtime fingerprint "dirty" and should be investigated
   — it has caught real stale scratch directories before (e.g.
   `.scratch-lease-test/`, found and deleted 2026-11-11).
4. Verifies the runtime manifest hash-by-hash, verifies the pill binary's own
   hash against that manifest, writes `candidate-build.json` and
   `candidate.json` receipts, and packages the ZIP + sha256 sidecar via
   `package-engine-release.ps1 -Candidate` (which intentionally does **not**
   run the separate, stable/non-candidate `accepted-runtime.json` equality
   check — that check is for the different, untouched stable-release
   pipeline).

## 4. Install only from a tagged release (guard 5B)

`scripts/install-m9r.ps1`, inside `Assert-AcceptedRuntimePackage` /
`Assert-LocalCandidateReceipt`:
- A normal (non-local-candidate) install downloads a numbered GitHub release
  and verifies it against the owner-accepted runtime policy — unchanged by
  any of tonight's work.
- A **local candidate** install (`-AllowLocalCandidate -PackagePath ...
  -CandidateReceiptPath ...`) verifies the external `candidate.json` receipt
  matches the ZIP and runtime artifacts exactly, **and** requires the
  receipt's `sourceCommit` to be pointed at by a tag matching `release-*` in
  this repo (e.g. `release-20261110-recovery-v6`). No tag, no install —
  "Nothing was installed."

  Verified for real on 2026-11-11: an untagged commit's candidate was
  refused with `Refusing to install candidate source commit <sha>: it is not
  pointed at by any 'release-*' tag`; tagging that same commit let the
  installer proceed past the guard to the real first-run consent prompt.

## 5. Branch / worktree cleanup (6A / 6B)

Separate operational chore — deciding when the recovery branch
(`codex/recovery-build-20261110`) merges into or is renamed to a long-term
trunk, and cleaning up any stray worktrees. Not part of the guard code above,
not blocking it.

## Verifying these guards still work

Each guard was confirmed by deliberately tripping it, not just by reading the
code:
- 3A: ran `build-candidate.mjs` against a dirty tree (refused), then against
  a clean one (proceeded).
- 3B: `npx tsc --noEmit -p .` confirmed clean on the current tree (the fix
  for the 2026-11-11 `deps`-out-of-scope regression, see above). Tripping it
  for real (a deliberately broken reference, full `build-candidate.mjs` run,
  confirm the hard refusal, then revert) is still open — left for the next
  full build/install pass rather than run here.
- 4A: read the real build output and confirmed `overlay/src-tauri` was
  actually compiled, not copied.
- 5B: ran `install-m9r.ps1 -AllowLocalCandidate` against an untagged commit's
  candidate (refused), then against the same candidate after tagging its
  commit (proceeded to the consent prompt).

If you change any of these three scripts, re-run the same three checks before
trusting the change.
