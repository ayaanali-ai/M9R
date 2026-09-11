/**
 * Session redaction tests — proves the privacy gate catches major secret
 * patterns before a session is ever analyzed, and stays honest about limits.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { redactSession, REDACTION_DISCLAIMER } from "../src/lib/session-redaction.ts";

const SECRETS: Array<{ name: string; secret: string; type: string }> = [
  { name: "OpenAI key", secret: "sk-abcdefghijklmnopqrstuvwxyz1234", type: "openai_key" },
  { name: "Anthropic key", secret: "sk-ant-api03-abcdefghijklmnopqrstuv", type: "anthropic_key" },
  { name: "GitHub token", secret: "ghp_abcdefghijklmnopqrstuvwxyz1234", type: "github_token" },
  { name: "Stripe key", secret: "sk_live_abcdefghij1234567890", type: "stripe_key" },
  { name: "AWS access key", secret: "AKIAIOSFODNN7EXAMPLE", type: "aws_access_key" },
  {
    name: "JWT",
    secret:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N1f",
    type: "jwt",
  },
  { name: "Database URL", secret: "postgres://user:secretpass@db.example.com:5432/app", type: "database_url" },
];

for (const { name, secret, type } of SECRETS) {
  test(`redacts ${name}`, () => {
    const session = `Running setup with key ${secret} now.`;
    const result = redactSession(session);
    assert.ok(!result.redactedText.includes(secret), `${name} value should be gone`);
    assert.ok(result.countsByType[type] >= 1, `expected a ${type} count`);
    assert.ok(result.redactedText.includes("[REDACTED:"), "placeholder should be present");
  });
}

test("redacts a PEM private key block", () => {
  const session = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA1234567890abcdef
-----END RSA PRIVATE KEY-----`;
  const result = redactSession(session);
  assert.ok(!result.redactedText.includes("MIIEowIBAAKCAQEA"), "key body gone");
  assert.ok(result.countsByType.private_key >= 1);
});

test("redacts a bearer token", () => {
  const result = redactSession("Authorization: Bearer abcdefghijklmnop1234567890");
  assert.ok(!result.redactedText.includes("abcdefghijklmnop1234567890"));
  assert.ok(result.countsByType.bearer_token >= 1);
});

test("redacts env secret assignments while keeping the key label", () => {
  const result = redactSession("MY_SERVICE_TOKEN=supersecretvalue123456");
  assert.ok(!result.redactedText.includes("supersecretvalue123456"));
  assert.match(result.redactedText, /MY_SERVICE_TOKEN=\[REDACTED:ENV_SECRET\]/);
});

test("redacts inline password assignments", () => {
  const result = redactSession("db password: hunter2longpassword");
  assert.ok(!result.redactedText.includes("hunter2longpassword"));
  assert.ok(result.countsByType.password >= 1);
});

test("redacts email addresses", () => {
  const result = redactSession("contact me at jane.doe@example.com about it");
  assert.ok(!result.redactedText.includes("jane.doe@example.com"));
  assert.ok(result.countsByType.email >= 1);
});

test("redacts high-entropy long strings as a heuristic catch-all", () => {
  const blob = "dGhpc2lzYXZlcnlsb25nYmFzZTY0c3RyaW5ndGhhdGlzaGlnaGVudHJvcHk=";
  const result = redactSession(`token blob ${blob}`);
  assert.ok(!result.redactedText.includes(blob));
  assert.ok(result.countsByType.high_entropy >= 1);
  // Heuristic matches lower the honest confidence below "high".
  assert.notEqual(result.confidence, "high");
});

test("never claims guaranteed safety — always carries the disclaimer", () => {
  const result = redactSession("hello world, nothing secret here");
  assert.ok(result.warnings.includes(REDACTION_DISCLAIMER));
  assert.equal(result.countsByType ? Object.keys(result.countsByType).length : 0, 0);
  // No secrets found is honest "high" confidence but still warns about limits.
  assert.equal(result.confidence, "high");
  assert.ok(result.warnings.some((w) => /does not guarantee/i.test(w)));
});

test("preserves non-secret session structure (commands stay analyzable)", () => {
  const session = "$ npm run build\nError: build failed\nApi key: sk-abcdefghijklmnopqrstuvwxyz1234";
  const result = redactSession(session);
  assert.ok(result.redactedText.includes("npm run build"), "command preserved");
  assert.ok(result.redactedText.includes("Error: build failed"), "error preserved");
  assert.ok(!result.redactedText.includes("sk-abcdefghijklmnopqrstuvwxyz1234"));
});
