import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGithubLinks, hasAnyGithubLink } from "../src/lib/github-link.ts";

test("all four links validate when well-formed", () => {
  const result = validateGithubLinks({
    commit: "a1b2c3d",
    branch: "feature/watchfloor-v2",
    pullRequestUrl: "https://github.com/acme/runleak/pull/42",
    ciUrl: "https://github.com/acme/runleak/actions/runs/123",
  });
  assert.equal(result.ok, true);
  assert.equal(result.normalized!.commit, "a1b2c3d");
});

test("a run is valid with zero links declared", () => {
  const result = validateGithubLinks({});
  assert.equal(result.ok, true);
  assert.equal(hasAnyGithubLink(result.normalized), false);
});

test("rejects a malformed commit SHA", () => {
  const result = validateGithubLinks({ commit: "not-a-sha!" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /commit/.test(e)));
});

test("rejects a non-https URL", () => {
  const result = validateGithubLinks({ pullRequestUrl: "http://github.com/acme/runleak/pull/42" });
  assert.equal(result.ok, false);
});

test("rejects a javascript: URL", () => {
  const result = validateGithubLinks({ ciUrl: "javascript:alert(1)" });
  assert.equal(result.ok, false);
});

test("hasAnyGithubLink is true when at least one field is set", () => {
  assert.equal(hasAnyGithubLink({ commit: "a1b2c3d", branch: null, pullRequestUrl: null, ciUrl: null }), true);
  assert.equal(hasAnyGithubLink(null), false);
});
