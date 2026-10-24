import assert from "node:assert/strict";
import test from "node:test";
import { persistWebhook } from "../src/lib/webhook-persistence.ts";

test("webhook database failures propagate so the sender retries", async () => {
  await assert.rejects(persistWebhook({ rpc: async () => ({ data: null, error: { message: "write unavailable" } }) }, "apply_stripe_subscription_event", {}), /write unavailable/);
});

test("webhook success returns the transaction's deduplication decision", async () => {
  let calls = 0;
  const result = await persistWebhook({ rpc: async (name, args) => {
    calls++;
    assert.equal(name, "post_github_delivery");
    assert.equal(args.p_delivery_id, "delivery-1");
    return { data: false, error: null };
  } }, "post_github_delivery", { p_delivery_id: "delivery-1" });
  assert.equal(result, false);
  assert.equal(calls, 1);
});
