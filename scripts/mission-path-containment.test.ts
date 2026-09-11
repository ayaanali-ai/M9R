/**
 * Canonical repository-path containment — Phase 4D §3 adversarial tests
 *
 * Replaces raw string-prefix scope checks. Every case here is something the
 * PREVIOUS `path.startsWith(allowed + "/")` implementation either accepted
 * wrongly (a traversal escape) or rejected wrongly (a legitimate subpath
 * whose trailing slash didn't line up) — see mission-collaboration-graph.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeRepoPath, isRepoPathContained, isRepoPathContainedByAny } from "../src/lib/mission/mission-path-containment.ts";
import { validateScopeNarrowing } from "../src/lib/mission/mission-collaboration-graph.ts";

test("canonicalizeRepoPath collapses '.' and repeated separators", () => {
  const result = canonicalizeRepoPath("src//./lib///app");
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.segments, ["src", "lib", "app"]);
});

test("canonicalizeRepoPath resolves '..' within the path", () => {
  const result = canonicalizeRepoPath("src/lib/../app");
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.segments, ["src", "app"]);
});

test("canonicalizeRepoPath fails closed on '..' that climbs above the root", () => {
  const result = canonicalizeRepoPath("src/../../outside");
  assert.equal(result.ok, false);
});

test("canonicalizeRepoPath fails closed on a bare '..'", () => {
  assert.equal(canonicalizeRepoPath("..").ok, false);
});

test("canonicalizeRepoPath normalizes Windows backslashes", () => {
  const result = canonicalizeRepoPath("src\\lib\\app");
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.segments, ["src", "lib", "app"]);
});

test("canonicalizeRepoPath normalizes mixed separators", () => {
  const result = canonicalizeRepoPath("src\\lib/app\\file.ts");
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.segments, ["src", "lib", "app", "file.ts"]);
});

test("canonicalizeRepoPath fails closed on a leading separator (absolute path)", () => {
  assert.equal(canonicalizeRepoPath("/etc/passwd").ok, false);
  assert.equal(canonicalizeRepoPath("\\etc\\passwd").ok, false);
});

test("canonicalizeRepoPath fails closed on a drive-letter path", () => {
  assert.equal(canonicalizeRepoPath("C:\\Windows\\System32").ok, false);
  assert.equal(canonicalizeRepoPath("c:/repo/src").ok, false);
});

test("canonicalizeRepoPath fails closed on a UNC path", () => {
  assert.equal(canonicalizeRepoPath("\\\\server\\share\\file").ok, false);
  assert.equal(canonicalizeRepoPath("//server/share/file").ok, false);
});

test("canonicalizeRepoPath treats an empty path and '.' both as the repository root", () => {
  const empty = canonicalizeRepoPath("");
  const dot = canonicalizeRepoPath(".");
  assert.ok(empty.ok && dot.ok);
  if (empty.ok && dot.ok) {
    assert.deepEqual(empty.segments, []);
    assert.deepEqual(dot.segments, []);
  }
});

test("canonicalizeRepoPath strips leading and trailing separators", () => {
  const leading = canonicalizeRepoPath("./src/app/");
  assert.ok(leading.ok);
  if (leading.ok) assert.deepEqual(leading.segments, ["src", "app"]);
});

test("isRepoPathContained: sibling-prefix collision — src/app does NOT contain src/application", () => {
  assert.equal(isRepoPathContained("src/application", "src/app"), false);
});

test("isRepoPathContained: src/app IS contained by src/app itself and by src/", () => {
  assert.equal(isRepoPathContained("src/app", "src/app"), true);
  assert.equal(isRepoPathContained("src/app", "src"), true);
});

test("isRepoPathContained: a traversal escape is never contained, even by the repository root", () => {
  assert.equal(isRepoPathContained("src/../../etc/passwd", "."), false);
  assert.equal(isRepoPathContained("src/../../etc/passwd", ""), false);
});

test("isRepoPathContained: an absolute path is never contained by anything, including itself", () => {
  assert.equal(isRepoPathContained("/etc/passwd", "/etc/passwd"), false);
});

test("isRepoPathContained: a drive-letter path cannot bypass a repo-relative policy", () => {
  assert.equal(isRepoPathContained("C:\\repo\\src\\secret.ts", "src"), false);
});

test("isRepoPathContained: mixed-separator equivalents are recognized as the same path", () => {
  assert.equal(isRepoPathContained("src\\lib\\app", "src/lib"), true);
});

test("isRepoPathContainedByAny checks every candidate container", () => {
  assert.equal(isRepoPathContainedByAny("scripts/build.ts", ["src", "scripts"]), true);
  assert.equal(isRepoPathContainedByAny("infra/deploy.ts", ["src", "scripts"]), false);
});

// ---------------------------------------------------------------------------
// validateScopeNarrowing — integration through the canonical utility
// ---------------------------------------------------------------------------

test("validateScopeNarrowing rejects a child allowed path that only LOOKS covered via a raw string prefix but escapes via '..'", () => {
  const parent = { allowedPaths: ["src/"], prohibitedPaths: [] };
  const child = { allowedPaths: ["src/../outside"], prohibitedPaths: [] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, false);
  assert.deepEqual(result.excessAllowedPaths, ["src/../outside"]);
});

test("validateScopeNarrowing distinguishes src/app from src/application (sibling-prefix collision)", () => {
  const parent = { allowedPaths: ["src/app"], prohibitedPaths: [] };
  const child = { allowedPaths: ["src/application"], prohibitedPaths: [] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, false, "src/application must NOT be treated as covered by src/app");
});

test("validateScopeNarrowing rejects an absolute child path even when the parent allows the repository root", () => {
  const parent = { allowedPaths: ["."], prohibitedPaths: [] };
  const child = { allowedPaths: ["/etc/passwd"], prohibitedPaths: [] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, false, "an absolute path must never be treated as contained by the repository root");
});

test("validateScopeNarrowing rejects a Windows drive-letter child path", () => {
  const parent = { allowedPaths: ["."], prohibitedPaths: [] };
  const child = { allowedPaths: ["C:\\Windows\\System32"], prohibitedPaths: [] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, false);
});

test("validateScopeNarrowing still accepts a genuine subdirectory regardless of trailing-slash style", () => {
  const parent = { allowedPaths: ["src"], prohibitedPaths: [] };
  const child = { allowedPaths: ["src/lib/app/"], prohibitedPaths: [] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, true);
});

test("validateScopeNarrowing: a child prohibition that is a broader ancestor of the parent's still satisfies it", () => {
  const parent = { allowedPaths: ["src"], prohibitedPaths: ["src/secrets/keys.ts"] };
  const child = { allowedPaths: ["src"], prohibitedPaths: ["src/secrets"] }; // broader — covers the parent's specific file
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, true);
});

test("validateScopeNarrowing: a child cannot narrow a prohibition away via a traversal string", () => {
  const parent = { allowedPaths: ["src"], prohibitedPaths: ["src/secrets"] };
  const child = { allowedPaths: ["src"], prohibitedPaths: ["src/secrets/../not-secrets"] }; // canonicalizes to src/not-secrets, does not cover src/secrets
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, false);
  assert.deepEqual(result.droppedProhibitedPaths, ["src/secrets"]);
});
