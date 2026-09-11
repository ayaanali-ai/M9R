import { redirect } from "next/navigation";
import AuthForm from "@/components/product/AuthForm";
import BackLink from "@/components/product/BackLink";
import { createClient } from "@/lib/supabase/server";
import { safeRelativePath } from "@/lib/safe-redirect";
import AuthDebugBadge from "@/components/AuthDebugBadge";

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
 * OAuth restored alongside email/password (AuthForm.tsx, unchanged), per
 * explicit reversal of the earlier OAuth-only pass. Keeps the minimal shell
 * (no marketing editorial panel) since that part of the rebuild stands.
 */
export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const { next, error } = await searchParams;
  const nextParam = Array.isArray(next) ? next[0] : next;
  const errorParam = Array.isArray(error) ? error[0] : error;
  const initialNotice = noticeForError(errorParam);
  const destination = safeRelativePath(nextParam);

  const supabase = await createClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  if (data.user) redirect(destination);

  return (
    <main className="auth-min-shell">
      <AuthDebugBadge />
      <BackLink href="/" label="Back to home" className="auth-back" />
      <AuthForm configured={Boolean(supabase)} next={destination} initialNotice={initialNotice} />
    </main>
  );
}
