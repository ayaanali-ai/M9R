// Tests for the webhook notifier's safe-by-default behavior. Run with:
//   npm run test
import { test } from "node:test";
import assert from "node:assert/strict";
import { leadWebhookEnabled, notifyLead } from "@/lib/notify";

test("webhook is disabled when LEAD_WEBHOOK_URL is absent", () => {
  const had = process.env.LEAD_WEBHOOK_URL;
  delete process.env.LEAD_WEBHOOK_URL;
  try {
    assert.equal(leadWebhookEnabled(), false);
  } finally {
    if (had !== undefined) process.env.LEAD_WEBHOOK_URL = had;
  }
});

test("notifyLead returns false (no throw) when unconfigured", async () => {
  const had = process.env.LEAD_WEBHOOK_URL;
  delete process.env.LEAD_WEBHOOK_URL;
  try {
    const ok = await notifyLead("test lead");
    assert.equal(ok, false);
  } finally {
    if (had !== undefined) process.env.LEAD_WEBHOOK_URL = had;
  }
});
