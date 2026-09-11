import assert from "node:assert/strict";
import test from "node:test";
import { buildPullRequestCandidate } from "@/lib/mission/mission-pull-request";

const base = {
  workspaceId: "workspace-1",
  missionId: "mission-1",
  assignmentId: "assignment-1",
  participantId: "agent-a",
  owner: "acme",
  repo: "runleak",
  headBranch: "oathlock/feature-x",
  baseBranch: "main",
  title: "Add feature X",
};

test("a valid candidate builds with a deterministic digest", () => {
  const candidate = buildPullRequestCandidate(base);
  assert.equal(candidate.owner, "acme");
  assert.equal(candidate.headBranch, "oathlock/feature-x");
  assert.equal(candidate.baseBranch, "main");
  assert.ok(candidate.candidateDigest.length > 0);
});

test("the digest is stable for identical input and changes when any field changes", () => {
  const first = buildPullRequestCandidate(base);
  const second = buildPullRequestCandidate(base);
  assert.equal(first.candidateDigest, second.candidateDigest);

  const changed = buildPullRequestCandidate({ ...base, title: "Add feature Y" });
  assert.notEqual(first.candidateDigest, changed.candidateDigest);
});

test("rejects head and base branches that are the same", () => {
  assert.throws(() => buildPullRequestCandidate({ ...base, headBranch: "main", baseBranch: "main" }));
});

test("rejects an empty or missing title", () => {
  assert.throws(() => buildPullRequestCandidate({ ...base, title: "" }));
  assert.throws(() => buildPullRequestCandidate({ ...base, title: "   " }));
});

test("rejects an invalid branch name", () => {
  assert.throws(() => buildPullRequestCandidate({ ...base, headBranch: "-bad" }));
  assert.throws(() => buildPullRequestCandidate({ ...base, headBranch: "bad..branch" }));
  assert.throws(() => buildPullRequestCandidate({ ...base, headBranch: "bad/" }));
});

test("rejects an owner or repo that isn't a valid GitHub path segment", () => {
  assert.throws(() => buildPullRequestCandidate({ ...base, owner: "acme/evil" }));
  assert.throws(() => buildPullRequestCandidate({ ...base, repo: "" }));
});

test("body defaults to empty when omitted, and is never left longer than the 8000-char cap", () => {
  const longBody = Array.from({ length: 3000 }, (_, i) => `line ${i} of this PR description`).join("\n");
  const candidate = buildPullRequestCandidate({ ...base, body: longBody });
  assert.ok(candidate.body.length <= 8000);
  const noBody = buildPullRequestCandidate(base);
  assert.equal(noBody.body, "");
});

test("a candidate proposed for a different mission never collides on digest", () => {
  const missionA = buildPullRequestCandidate(base);
  const missionB = buildPullRequestCandidate({ ...base, missionId: "mission-2" });
  assert.notEqual(missionA.candidateDigest, missionB.candidateDigest);
});
