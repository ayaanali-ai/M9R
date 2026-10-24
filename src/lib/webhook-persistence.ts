/** The database transaction owns deduplication and the write, never a process-local cache. */
export async function persistWebhook(
  db: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> },
  name: "apply_stripe_subscription_event" | "post_github_delivery",
  args: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`Could not persist webhook: ${error.message}`);
  if (typeof data !== "boolean") throw new Error("Webhook persistence returned an invalid acknowledgement.");
  return data;
}
