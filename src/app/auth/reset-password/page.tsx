"use client";

/**
 * Landed on after /auth/confirm has already exchanged the recovery link's
 * code for a session (see AuthForm.tsx's submitResetRequest, which points
 * resetPasswordForEmail's redirectTo at /auth/confirm?next=/auth/reset-password
 * — the same code-exchange path every other confirmation link already uses).
 * This page only has one job: read that already-established session and let
 * the human set a new password with supabase.auth.updateUser.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import BackLink from "@/components/product/BackLink";

const passwordChecks = [
  { label: "8 or more characters", test: (value: string) => value.length >= 8 },
  { label: "One uppercase letter", test: (value: string) => /[A-Z]/.test(value) },
  { label: "One number", test: (value: string) => /\d/.test(value) },
] as const;

type Status = "checking" | "ready" | "invalid" | "done";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      if (!supabase) {
        if (!cancelled) setStatus("invalid");
        return;
      }
      // /auth/confirm already exchanged the recovery code for a session before
      // redirecting here — this only confirms it actually landed.
      const { data } = await supabase.auth.getSession();
      if (!cancelled) setStatus(data.session ? "ready" : "invalid");
    })();
    return () => { cancelled = true; };
  }, []);

  const passwordIsValid = passwordChecks.every(({ test }) => test(password));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !passwordIsValid) return;
    const supabase = createClient();
    if (!supabase) {
      setNotice("Sign-in is temporarily unavailable. Please try again shortly.");
      return;
    }
    setBusy(true);
    setNotice(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setNotice(error.message.toLowerCase().includes("password") ? "Your password does not meet the security requirements." : "That reset link has expired. Request a new one.");
      return;
    }
    setStatus("done");
    setTimeout(() => router.replace("/dashboard"), 1500);
  }

  return (
    <main className="auth-min-shell">
      <BackLink href="/" label="Back to home" className="auth-back" />
      <div className="auth-card">
          {status === "checking" && (
            <header className="auth-heading">
              <p className="auth-eyebrow">One moment</p>
              <h1>Confirming your reset link&hellip;</h1>
            </header>
          )}

          {status === "invalid" && (
            <>
              <header className="auth-heading">
                <p className="auth-eyebrow">Link expired</p>
                <h1>That reset link is invalid or expired</h1>
                <p>Request a new one from the sign-in page.</p>
              </header>
              <p className="auth-switch-copy">
                <a href="/auth">Back to sign in</a>
              </p>
            </>
          )}

          {status === "ready" && (
            <>
              <header className="auth-heading">
                <p className="auth-eyebrow">Almost done</p>
                <h1>Set a new password</h1>
              </header>
              <form onSubmit={submit} className="auth-form">
                <div className="auth-field">
                  <label htmlFor="new-password">New password</label>
                  <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="product-input auth-input"
                    placeholder="Create a strong password"
                    disabled={busy}
                  />
                </div>
                <div className="auth-requirements" aria-label="Password requirements">
                  {passwordChecks.map(({ label, test }) => {
                    const met = test(password);
                    return (
                      <span key={label} className={met ? "auth-requirement-met" : ""}>
                        <span aria-hidden="true">{met ? "✓" : "·"}</span>
                        {label}
                      </span>
                    );
                  })}
                </div>
                {notice && (
                  <div className="auth-notice auth-notice-error" role="alert">
                    <span className="auth-notice-mark" aria-hidden="true">!</span>
                    <span>{notice}</span>
                  </div>
                )}
                <button type="submit" disabled={busy || !passwordIsValid} className="auth-submit">
                  {busy && <span className="auth-spinner" aria-hidden="true" />}
                  <span>{busy ? "Saving…" : "Set new password"}</span>
                </button>
              </form>
            </>
          )}

          {status === "done" && (
            <header className="auth-heading">
              <p className="auth-eyebrow">Done</p>
              <h1>Password updated</h1>
              <p>Opening your workspace&hellip;</p>
            </header>
          )}
      </div>
    </main>
  );
}
