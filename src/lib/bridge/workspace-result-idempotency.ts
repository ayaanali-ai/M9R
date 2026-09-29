import { createHash } from "node:crypto";

/** One stable key per logical result, shared by Relay and HTTP retries. */
export function workspaceResultIdempotencyKey(input: {
  parentMessageId: string;
  identity: string;
  body: string;
  outcome?: "ok" | "failed" | "incomplete";
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.body, input.outcome ?? null]))
    .digest("hex")
    .slice(0, 24);
  const suffix = `:${digest}`;
  return `${`result:${input.parentMessageId}:${input.identity}`.slice(0, 256 - suffix.length)}${suffix}`;
}
