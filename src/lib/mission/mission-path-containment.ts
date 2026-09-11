/**
 * Canonical repository-path containment — Phase 4D §3.
 * ----------------------------------------------------------------------------
 * Replaces raw string-prefix scope checks (the previous
 * `mission-collaboration-graph.ts` implementation compared
 * `path.startsWith(allowed + "/")`) with real segment-wise canonicalization.
 * A prefix check never resolves `..`, never normalizes separators, and
 * cannot tell `src/app` from `src/application` without the exact right
 * trailing-slash discipline every caller has to get right by hand. This
 * module is the ONE place every authority/delegation-scope comparison in
 * the Mission domain goes through.
 *
 * Paths here are always REPOSITORY-RELATIVE. There is no on-disk root to
 * resolve against and none is required — canonicalization is pure string
 * segment processing, never a filesystem call, so it works identically
 * whether or not the path exists (required: Plans reason about paths that
 * don't exist yet).
 *
 * Case sensitivity: canonical comparison is case-SENSITIVE. Git repository
 * identity (paths as they exist in the tree, on any OS) is the authority
 * this module protects, and case-sensitive is the conservative choice: a
 * case-insensitive match would treat "src/App" and "src/app" as the same
 * path when a case-sensitive filesystem or a case-sensitive `git` checkout
 * would not, silently WIDENING what a scope covers. Never resolves
 * symlinks — no authoritative on-disk resolution mechanism exists in this
 * layer (see mission-process-host.ts's disposable/worktree environments;
 * they operate at a different layer entirely), so symlink-based escapes
 * are explicitly out of this module's scope, not silently assumed safe.
 */

/** A canonicalized repo-relative path: ok=false means the raw input escapes the repository root (absolute, drive-letter, UNC, or `..` past root) and must be treated as NEVER contained by anything. */
export type CanonicalPath = { ok: true; segments: string[] } | { ok: false; reason: string };

const DRIVE_LETTER_RE = /^[a-zA-Z]:/;

/**
 * Canonicalizes a single repo-relative path into normalized segments.
 * Fails closed (ok:false) rather than guessing whenever the input could
 * plausibly point outside the repository root:
 *   - absolute paths (leading `/` or `\`)
 *   - drive-letter paths (`C:\...`, `c:/...`)
 *   - UNC paths (`\\server\share\...`, `//server/share/...`)
 *   - `..` that would climb above the root
 * `.`, repeated separators, backslashes, and leading/trailing separators
 * are all normalized rather than rejected — they're noise, not an escape.
 */
export function canonicalizeRepoPath(rawPath: string): CanonicalPath {
  if (rawPath.length === 0) return { ok: true, segments: [] };

  // Mixed separators are normalized uniformly before splitting — a path is
  // never partially Windows-style and partially POSIX-style once through
  // this function.
  const normalizedSlashes = rawPath.replace(/\\/g, "/");

  if (DRIVE_LETTER_RE.test(normalizedSlashes)) {
    return { ok: false, reason: `drive-letter path "${rawPath}" is not repository-relative` };
  }
  // UNC (`//server/share/...`) and plain absolute (`/...`) both start with
  // a leading separator once normalized — both are refused as escaping the
  // repository root, which has no notion of an absolute filesystem path.
  if (normalizedSlashes.startsWith("/")) {
    return { ok: false, reason: `absolute or UNC path "${rawPath}" is not repository-relative` };
  }

  const rawSegments = normalizedSlashes.split("/");
  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment.length === 0 || rawSegment === ".") continue; // repeated/leading/trailing separators, "." — all no-ops
    if (rawSegment === "..") {
      if (segments.length === 0) {
        // Climbing above the repository root — fail closed, never clamp to
        // root and never silently ignore. A caller that meant "the root
        // itself" should supply "." or "", not "..".
        return { ok: false, reason: `"${rawPath}" traverses above the repository root` };
      }
      segments.pop();
      continue;
    }
    segments.push(rawSegment);
  }
  return { ok: true, segments };
}

/**
 * True when `candidate` is the same path as, or nested under, `container` —
 * compared as whole path SEGMENTS, never substrings. This is what makes
 * `src/app` and `src/application` distinguishable (the previous
 * string-prefix check got this right only by accident, via a hand-written
 * trailing-slash discipline every call site had to reproduce) and what
 * makes `src/../outside` fail (it canonicalizes to `outside`, a completely
 * different segment list than `src`, rather than being compared as a raw
 * string that happens to start with "src").
 *
 * A raw input that fails to canonicalize (`ok: false` — absolute,
 * drive-letter, UNC, or root-escaping `..`) is NEVER contained by anything,
 * regardless of `container` — traversal escapes fail closed.
 */
export function isRepoPathContained(candidateRaw: string, containerRaw: string): boolean {
  const candidate = canonicalizeRepoPath(candidateRaw);
  if (!candidate.ok) return false;
  const container = canonicalizeRepoPath(containerRaw);
  if (!container.ok) return false;

  // The repository root ("" / ".") contains everything.
  if (container.segments.length === 0) return true;
  if (candidate.segments.length < container.segments.length) return false;
  return container.segments.every((segment, index) => candidate.segments[index] === segment);
}

/** True when `candidateRaw` is contained by (equal to or nested under) at least one entry in `containerPaths`. Fails closed (false) if `candidateRaw` itself does not canonicalize. */
export function isRepoPathContainedByAny(candidateRaw: string, containerPaths: readonly string[]): boolean {
  return containerPaths.some((container) => isRepoPathContained(candidateRaw, container));
}
