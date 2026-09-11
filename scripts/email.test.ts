// Tests for the email lib's safe-by-default behavior. Run with:
//   npm run test
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailEnabled, sendEmail } from "@/lib/email";

test("email is disabled when Resend env is absent", () => {
  const hadKey = process.env.RESEND_API_KEY;
  const hadFrom = process.env.RESEND_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  try {
    assert.equal(emailEnabled(), false);
  } finally {
    if (hadKey !== undefined) process.env.RESEND_API_KEY = hadKey;
    if (hadFrom !== undefined) process.env.RESEND_FROM = hadFrom;
  }
});

test("sendEmail returns false (no throw) when unconfigured", async () => {
  const hadKey = process.env.RESEND_API_KEY;
  const hadFrom = process.env.RESEND_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  try {
    const ok = await sendEmail({ to: "x@example.com", subject: "t", text: "t" });
    assert.equal(ok, false);
  } finally {
    if (hadKey !== undefined) process.env.RESEND_API_KEY = hadKey;
    if (hadFrom !== undefined) process.env.RESEND_FROM = hadFrom;
  }
});
