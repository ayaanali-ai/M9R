import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyGithubWebhookSignature, renderGithubEventAsMessage } from "../src/lib/github-events-service.ts";

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

test("signature verification fails closed when GITHUB_APP_WEBHOOK_SECRET is unset", () => {
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  const result = verifyGithubWebhookSignature("{}", "sha256=whatever");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_secret_configured");
});

test("signature verification fails without a signature header", () => {
  process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
  const result = verifyGithubWebhookSignature("{}", null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_signature");
});

test("signature verification rejects a wrong signature", () => {
  process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
  const result = verifyGithubWebhookSignature('{"a":1}', "sha256=" + "0".repeat(64));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_signature");
});

test("signature verification accepts a correctly signed body", () => {
  process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
  const body = JSON.stringify({ hello: "world" });
  const result = verifyGithubWebhookSignature(body, sign("test-secret", body));
  assert.equal(result.ok, true);
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
});

test("a push with commits renders a one-line summary naming pusher, branch, and count", () => {
  const rendered = renderGithubEventAsMessage("push", {
    ref: "refs/heads/main",
    repository: { full_name: "acme/runleak" },
    pusher: { name: "ayaan" },
    commits: [{ message: "fix: typo" }, { message: "feat: real thing\n\nlonger body" }],
  });
  assert.ok(rendered);
  assert.equal(rendered!.repoFullName, "acme/runleak");
  assert.match(rendered!.body, /ayaan/);
  assert.match(rendered!.body, /`main`/);
  assert.match(rendered!.body, /2 commits/);
  assert.match(rendered!.body, /feat: real thing/);
});

test("a branch-delete push (no commits) renders nothing", () => {
  const rendered = renderGithubEventAsMessage("push", {
    ref: "refs/heads/old-branch",
    repository: { full_name: "acme/runleak" },
    pusher: { name: "ayaan" },
    commits: [],
  });
  assert.equal(rendered, null);
});

test("an opened pull_request renders with author and title", () => {
  const rendered = renderGithubEventAsMessage("pull_request", {
    action: "opened",
    number: 42,
    repository: { full_name: "acme/runleak" },
    pull_request: { title: "Add git events", user: { login: "ayaan" }, merged: false },
  });
  assert.ok(rendered);
  assert.match(rendered!.body, /opened PR #42/);
  assert.match(rendered!.body, /Add git events/);
});

test("a merged pull_request close says merged, not closed", () => {
  const rendered = renderGithubEventAsMessage("pull_request", {
    action: "closed",
    number: 42,
    repository: { full_name: "acme/runleak" },
    pull_request: { title: "Add git events", user: { login: "ayaan" }, merged: true },
  });
  assert.ok(rendered);
  assert.match(rendered!.body, /merged PR #42/);
});

test("an unhandled pull_request action (e.g. synchronize) renders nothing", () => {
  const rendered = renderGithubEventAsMessage("pull_request", {
    action: "synchronize",
    number: 42,
    repository: { full_name: "acme/runleak" },
    pull_request: { title: "Add git events", user: { login: "ayaan" } },
  });
  assert.equal(rendered, null);
});

test("a submitted review renders with reviewer and verb matching state", () => {
  const rendered = renderGithubEventAsMessage("pull_request_review", {
    action: "submitted",
    repository: { full_name: "acme/runleak" },
    pull_request: { number: 42 },
    review: { user: { login: "reviewer1" }, state: "approved" },
  });
  assert.ok(rendered);
  assert.match(rendered!.body, /reviewer1/);
  assert.match(rendered!.body, /approved PR #42/);
});

test("an unrecognized event name renders nothing rather than throwing", () => {
  const rendered = renderGithubEventAsMessage("issues", { repository: { full_name: "acme/runleak" } });
  assert.equal(rendered, null);
});

test("a payload missing repository renders nothing", () => {
  const rendered = renderGithubEventAsMessage("push", { commits: [{ message: "x" }] });
  assert.equal(rendered, null);
});
