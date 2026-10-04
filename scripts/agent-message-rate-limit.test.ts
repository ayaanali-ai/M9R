import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("agent-to-agent messages are rate-limited by sender+recipient identity, not by IP", () => {
  const lib = read("src/lib/rate-limit.ts");
  assert.match(lib, /export async function enforceAgentMessageRateLimit\(\s*senderConnectionId: string,\s*recipientConnectionId: string \| null,?\s*\)/);
  // Keyed on identity, never on the request's IP -- two agents on the same machine must not share a bucket with
  // each other or with ordinary human dashboard traffic from that address.
  const fn = lib.split("export async function enforceAgentMessageRateLimit")[1]!;
  assert.doesNotMatch(fn, /clientAddress|cf-connecting-ip/);
  assert.match(fn, /\$\{senderConnectionId\}\\0\$\{recipientConnectionId/, "the bucket key is built from both identities");
  assert.match(fn, /limit: 20, windowSeconds: 60/, "generous enough for real back-and-forth, tight enough to catch a runaway loop");
  // Reuses the same durable bucket primitive and RPC as the existing per-IP limiter -- no parallel rate-limit system.
  assert.match(lib, /async function consumeBucket/);
  assert.match(fn, /consumeBucket\(key,/);
});

test("the agent messages route enforces the rate limit before sending, keyed on the real sender and recipient (never a client-supplied sender)", () => {
  const route = read("src/app/api/agent/conversations/[id]/messages/route.ts");
  assert.match(route, /import \{ enforceAgentMessageRateLimit \} from "@\/lib\/rate-limit"/);
  const post = route.split("export async function POST")[1]!.split("export async function GET")[0]!;
  // The check must happen before sendConversationMessage, not after -- a limited request must never reach delivery.
  const limitIndex = post.indexOf("enforceAgentMessageRateLimit(");
  const sendIndex = post.indexOf("sendConversationMessage(");
  assert.ok(limitIndex > 0 && sendIndex > 0 && limitIndex < sendIndex, "rate limit must be checked before the message is sent");
  assert.match(post, /enforceAgentMessageRateLimit\(agent\.connectionId, recipientConnectionId\)/, "sender identity comes from the authenticated agent, never the request body");
  assert.match(post, /status: 429/);
});
