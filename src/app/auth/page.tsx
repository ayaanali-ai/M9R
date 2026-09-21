import { redirect } from "next/navigation";
import M9RAuthCard from "@/components/product/M9RAuthCard";
import { createClient } from "@/lib/supabase/server";
import { safeRelativePath } from "@/lib/safe-redirect";

export const dynamic = "force-dynamic";

// Maps the ?error= code set by /auth/confirm to a friendly message. Without
// this the user gets silently dropped on the login page after a failed or
// expired email-confirmation link, with no explanation.
function noticeForError(code: string | undefined) {
  if (!code) return null;
  if (code === "confirmation") {
    return {
      tone: "error" as const,
      text: "That confirmation link is invalid or has expired. Sign in below to try again.",
    };
  }
  if (code === "configuration") {
    return {
      tone: "error" as const,
      text: "Sign-in is temporarily unavailable. Please try again shortly.",
    };
  }
  return null;
}

/**
 * Authentication remains handled by AuthForm; this route only supplies the
 * centered auth card and keeps the existing safe destination/confirmation flow.
 */
export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[]; mode?: string | string[] }>;
}) {
  const { next, error, mode } = await searchParams;
  const modeParam = Array.isArray(mode) ? mode[0] : mode;
  const nextParam = Array.isArray(next) ? next[0] : next;
  const errorParam = Array.isArray(error) ? error[0] : error;
  const initialNotice = noticeForError(errorParam);
  const destination = safeRelativePath(nextParam);

  const supabase = await createClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  if (data.user) redirect(destination);

  return <M9RAuthCard configured={Boolean(supabase)} next={destination} initialNotice={initialNotice} initialMode={modeParam === "signup" ? "signup" : "login"} />;
}
