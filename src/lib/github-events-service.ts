/**
 * Git-as-events, v1: turns a real GitHub push/PR/review into a message in
 * the channel bound to that repo — closing the gap where git activity only
 * ever showed up because an agent self-reported it after the fact
 * (github-link-service.ts's static commit/branch/PR links).
 *
 * Scope, stated honestly: this only *receives* events (push, pull_request,
 * pull_request_review) and renders them as chat messages. It does not mint
 * GitHub App installation tokens or call back to GitHub (no status checks,
 * no auto-merge, no comment-posting) — that's a distinct, larger piece this
 * intentionally does not build yet. A GitHub App's webhook secret is the
 * same mechanism a plain repo webhook uses for signing deliveries, so this
 * works whether the app is a full GitHub App install or a per-repo webhook;
 * only which one the user has determines whether more capability is
 * unlocked later without touching this file.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { supabase } from "@/lib/supabase";

export type GithubWebhookEventName = "push" | "pull_request" | "pull_request_review";

export interface GithubWebhookVerification {
  ok: boolean;
  reason?: "no_secret_configured" | "missing_signature" | "bad_signature";
}

/** Verifies the `X-Hub-Signature-256` header against GITHUB_APP_WEBHOOK_SECRET using the raw request body — GitHub signs the exact bytes sent, so this must run before any JSON.parse. */
export function verifyGithubWebhookSignature(rawBody: string, signatureHeader: string | null): GithubWebhookVerification {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  if (!secret) return { ok: false, reason: "no_secret_configured" };
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return { ok: false, reason: "missing_signature" };

  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

function safe(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Reduces a raw webhook payload to one plain-text line for the channel, or null if this event/action isn't one v1 renders. Never throws — an unrecognized shape is a silent skip, not a 500. */
export function renderGithubEventAsMessage(eventName: string, payload: unknown): { repoFullName: string; body: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const repo = p.repository as Record<string, unknown> | undefined;
  const repoFullName = safe(repo?.full_name);
  if (!repoFullName) return null;

  if (eventName === "push") {
    const ref = safe(p.ref);
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    const commits = Array.isArray(p.commits) ? (p.commits as Array<Record<string, unknown>>) : [];
    if (commits.length === 0) return null; // branch delete / empty push — nothing worth posting
    const pusher = safe((p.pusher as Record<string, unknown> | undefined)?.name, "someone");
    const head = commits[commits.length - 1];
    const message = safe(head?.message).split("\n")[0].slice(0, 200);
    const count = commits.length;
    const noun = count === 1 ? "commit" : "commits";
    return { repoFullName, body: `**${pusher}** pushed ${count} ${noun} to \`${branch}\`: ${message}` };
  }

  if (eventName === "pull_request") {
    const action = safe(p.action);
    if (!["opened", "closed", "reopened", "review_requested"].includes(action)) return null;
    const pr = p.pull_request as Record<string, unknown> | undefined;
    const number = p.number;
    const title = safe(pr?.title);
    const user = safe((pr?.user as Record<string, unknown> | undefined)?.login, "someone");
    const merged = pr?.merged === true;
    const verb = action === "closed" ? (merged ? "merged" : "closed") : action === "review_requested" ? "requested review on" : "opened";
    return { repoFullName, body: `**${user}** ${verb} PR #${String(number)}: ${title}` };
  }

  if (eventName === "pull_request_review") {
    const action = safe(p.action);
    if (action !== "submitted") return null;
    const review = p.review as Record<string, unknown> | undefined;
    const pr = p.pull_request as Record<string, unknown> | undefined;
    const reviewer = safe((review?.user as Record<string, unknown> | undefined)?.login, "someone");
    const state = safe(review?.state).toLowerCase();
    const verbByState: Record<string, string> = { approved: "approved", changes_requested: "requested changes on", commented: "commented on" };
    const verb = verbByState[state] ?? "reviewed";
    const number = pr?.number;
    return { repoFullName, body: `**${reviewer}** ${verb} PR #${String(number)}` };
  }

  return null;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

/** Routes a rendered event to its bound channel (if any) and posts it as a system message. Silent no-op for an unbound repo — the same refusal discipline as mission-channel-binding.ts, not an error a webhook sender needs to retry on. */
export async function postGithubEventToBoundChannel(input: { repoFullName: string; body: string }): Promise<{ posted: boolean }> {
  const db = requireService();
  const { data: binding } = await db
    .from("github_repo_bindings")
    .select("workspace_id, conversation_id")
    .eq("repo_full_name", input.repoFullName)
    .maybeSingle();
  if (!binding) return { posted: false };

  const { error } = await db.from("conversation_messages").insert({
    workspace_id: binding.workspace_id,
    conversation_id: binding.conversation_id,
    sender_connection_id: null,
    sender_user_id: null,
    sender_kind: "system",
    sender_display_name: "GitHub",
    recipient_connection_id: null,
    kind: "message",
    body: input.body,
  });
  if (error) throw new Error(`Could not post GitHub event: ${error.message}`);
  return { posted: true };
}
