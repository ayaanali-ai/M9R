"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/browser";
import { safeRelativePath } from "@/lib/safe-redirect";
import { validateUsername } from "@/lib/username";

type AuthMode = "login" | "signup" | "reset";
type OAuthProvider = "google" | "github";
type Notice = { tone: "error" | "success"; text: string };

const passwordChecks = [
  { label: "8 or more characters", test: (value: string) => value.length >= 8 },
  { label: "One uppercase letter", test: (value: string) => /[A-Z]/.test(value) },
  { label: "One number", test: (value: string) => /\d/.test(value) },
] as const;

function getFriendlyError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("invalid login credentials")) {
    return "The email or password is incorrect. Check your details and try again.";
  }
  if (normalized.includes("email not confirmed")) {
    return "Confirm your email before signing in. Check your inbox for the verification link.";
  }
  if (normalized.includes("user already registered")) {
    return "An account already exists for this email. Sign in instead.";
  }
  if (normalized.includes("password")) {
    return "Your password does not meet the security requirements.";
  }
  if (normalized.includes("rate") || normalized.includes("too many")) {
    return "Too many attempts. Wait a moment before trying again.";
  }

  return "We couldn’t complete that request. Please try again.";
}

export default function AuthForm({
  configured,
  next = "/dashboard",
  initialNotice = null,
  initialMode = "login",
  hideHeading = false,
  oauthLabelPrefix = "",
}: {
  configured: boolean;
  /** Safe, same-origin relative path to land on after auth (e.g. a claim URL). */
  next?: string;
  /** Message to show on first render, e.g. after a failed email confirmation. */
  initialNotice?: Notice | null;
  /** Which tab opens first — the homepage's wide modal opens on signup. */
  initialMode?: AuthMode;
  /** Suppress the built-in heading when the host surface prints its own greeting. */
  hideHeading?: boolean;
  /** Prefix for the social buttons, e.g. "Continue with" → "Continue with Google". */
  oauthLabelPrefix?: string;
}) {
  // Re-validate on the client so a tampered prop can never become an open redirect.
  const destination = safeRelativePath(next);
  const emailId = useId();
  const firstNameId = useId();
  const lastNameId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const passwordHelpId = useId();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Which OAuth provider is mid-redirect (null = none), so we can show a spinner.
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const [notice, setNotice] = useState<Notice | null>(initialNotice);

  const passwordIsValid = passwordChecks.every(({ test }) => test(password));
  const namesProvided = firstName.trim().length > 0 && lastName.trim().length > 0;

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setPassword("");
    setNotice(null);
    // Don't clear the name fields — the user may have already typed them before
    // switching tabs.
  }

  /**
   * One-click social sign-in. Supabase handles the OAuth dance; on success the
   * browser is redirected to the provider and back to /auth/confirm, so there's
   * no local success state to manage — only errors before the redirect.
   */
  async function signInWithProvider(provider: OAuthProvider) {
    if (busy || oauthBusy) return;
    const supabase = createClient();
    if (!configured || !supabase) {
      setNotice({ tone: "error", text: "Sign-in is temporarily unavailable. Please try again shortly." });
      return;
    }
    setOauthBusy(provider);
    setNotice(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(destination)}`,
      },
    });
    if (error) {
      setNotice({ tone: "error", text: getFriendlyError(error.message) });
      setOauthBusy(null);
    }
    // On success the browser navigates away — no further handling needed.
  }

  /** Request a password-reset email. Always shows the same success notice, win or lose, so this can't be used to enumerate registered emails. */
  async function submitResetRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const supabase = createClient();
    if (!configured || !supabase) {
      setNotice({ tone: "error", text: "Sign-in is temporarily unavailable. Please try again shortly." });
      return;
    }
    setBusy(true);
    setNotice(null);
    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent("/auth/reset-password")}`,
    });
    setBusy(false);
    setNotice({ tone: "success", text: `If an account exists for ${email.trim()}, a password reset link is on its way.` });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    if (mode === "signup" && !namesProvided) {
      setNotice({ tone: "error", text: "Enter your first and last name to continue." });
      return;
    }

    const checkedUsername = validateUsername(username);
    if (mode === "signup" && !checkedUsername.ok) {
      setNotice({ tone: "error", text: checkedUsername.error });
      return;
    }

    if (mode === "signup" && !passwordIsValid) {
      setNotice({ tone: "error", text: "Complete all password requirements to continue." });
      return;
    }

    const supabase = createClient();
    if (!configured || !supabase) {
      setNotice({
        tone: "error",
        text: "Sign-in is temporarily unavailable. Please try again shortly.",
      });
      return;
    }

    setBusy(true);
    setNotice(null);

    try {
      if (mode === "signup" && checkedUsername.ok) {
        const availability = await fetch("/api/auth/username", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: checkedUsername.username }),
        });
        const availabilityData = await availability.json().catch(() => ({})) as { available?: boolean; error?: string };
        if (!availability.ok || !availabilityData.available) {
          setNotice({ tone: "error", text: availabilityData.error ?? "That username is already taken." });
          return;
        }
      }
      const result =
        mode === "login"
          ? await (async () => {
              const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ identifier: email.trim(), password }),
              });
              const data = await response.json().catch(() => ({})) as { error?: string };
              return response.ok
                ? { data: { session: true }, error: null }
                : { data: { session: null }, error: { message: data.error ?? "Invalid login credentials" } };
            })()
          : await supabase.auth.signUp({
              email: email.trim(),
              password,
              options: {
                emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(destination)}`,
                // Store the parts plus a composed full name. `name` is what the
                // workspace/account services read, so we set it too.
                data: {
                  first_name: firstName.trim(),
                  last_name: lastName.trim(),
                  full_name: `${firstName.trim()} ${lastName.trim()}`.trim(),
                  name: `${firstName.trim()} ${lastName.trim()}`.trim(),
                  username: checkedUsername.ok ? checkedUsername.username : undefined,
                },
              },
            });

      if (result.error) {
        setNotice({ tone: "error", text: getFriendlyError(result.error.message) });
        return;
      }

      if (mode === "signup" && !result.data.session) {
        setNotice({
          tone: "success",
          text: `Confirmation sent to ${email.trim()}. Open the link in that email to activate your account.`,
        });
        return;
      }

      // Confirm the session was actually persisted (cookies written) before we
      // navigate. Without this, a full navigation can still land on a server
      // render that hasn't seen the cookies yet — the signed-out auth loop.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        setNotice({
          tone: "error",
          text: "Signed in, but the session didn't persist. Please try again.",
        });
        return;
      }

      setNotice({ tone: "success", text: "Signed in. Opening your workspace…" });
      // Full document navigation (not a soft router.replace) so the freshly
      // written Supabase auth cookies are sent on the next request and the
      // destination's server components/middleware see the session immediately.
      // A soft navigation races cookie propagation and can render signed-out
      // (e.g. the /claim approval page looping back to /auth).
      window.location.assign(destination);
    } catch {
      setNotice({
        tone: "error",
        text: "We couldn’t reach the sign-in service. Check your connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  if (mode === "reset") {
    return (
      <div className="auth-card">
        <header className="auth-heading">
          <p className="auth-eyebrow">Reset your password</p>
          <h1>We&rsquo;ll email you a link</h1>
          <p>Enter the email on your account and we&rsquo;ll send a link to set a new password.</p>
        </header>

        <form onSubmit={submitResetRequest} className="auth-form">
          <div className="auth-field">
            <label htmlFor={emailId}>Email</label>
            <input
              id={emailId}
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="product-input auth-input"
              placeholder="you@company.com"
              disabled={busy}
            />
          </div>

          {notice && (
            <div
              className={`auth-notice auth-notice-${notice.tone}`}
              role={notice.tone === "error" ? "alert" : "status"}
              aria-live={notice.tone === "error" ? "assertive" : "polite"}
            >
              <span className="auth-notice-mark" aria-hidden="true">{notice.tone === "success" ? "✓" : "!"}</span>
              <span>{notice.text}</span>
            </div>
          )}

          <button type="submit" disabled={busy || !email} className="auth-submit">
            {busy && <span className="auth-spinner" aria-hidden="true" />}
            <span>{busy ? "Sending…" : "Send reset link"}</span>
          </button>
        </form>

        <p className="auth-switch-copy">
          <button type="button" onClick={() => changeMode("login")} disabled={busy}>
            Back to sign in
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <div className="auth-mode-switch" role="tablist" aria-label="Authentication method">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "login"}
          className={mode === "login" ? "auth-mode-active" : ""}
          onClick={() => changeMode("login")}
          disabled={busy}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signup"}
          className={mode === "signup" ? "auth-mode-active" : ""}
          onClick={() => changeMode("signup")}
          disabled={busy}
        >
          Create account
        </button>
      </div>

      {!hideHeading && (
        <header className="auth-heading">
          <p className="auth-eyebrow">{mode === "login" ? "Welcome back" : "Private by default"}</p>
          <h1>{mode === "login" ? "Enter your workspace" : "Create your workspace"}</h1>
          <p>
            {mode === "login"
              ? "Access your records, reports, and workspace rules."
              : "Start a secure workspace for your AI coding agents."}
          </p>
        </header>
      )}

      {/* --- Social sign-in — fast, one-click ----------------------------- */}
      <div className="auth-oauth-grid">
        <button
          type="button"
          className="auth-oauth-btn"
          onClick={() => signInWithProvider("google")}
          disabled={busy || oauthBusy !== null}
        >
          {oauthBusy === "google" ? <span className="auth-spinner" aria-hidden /> : <GoogleMark />}
          <span>{`${oauthLabelPrefix} Google`.trim()}</span>
        </button>
        <button
          type="button"
          className="auth-oauth-btn"
          onClick={() => signInWithProvider("github")}
          disabled={busy || oauthBusy !== null}
        >
          {oauthBusy === "github" ? <span className="auth-spinner" aria-hidden /> : <GitHubMark />}
          <span>{`${oauthLabelPrefix} GitHub`.trim()}</span>
        </button>
      </div>

      <div className="auth-divider" role="separator">
        <span>or continue with email</span>
      </div>

      <form onSubmit={submit} className="auth-form">
        {/* Name fields — signup only. Stored as first_name / last_name (plus a
            composed full_name / name) in user metadata. */}
        {mode === "signup" && (
          <div className="auth-field" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div className="auth-field" style={{ margin: 0 }}>
              <label htmlFor={firstNameId}>First name</label>
              <input
                id={firstNameId}
                type="text"
                autoComplete="given-name"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="product-input auth-input"
                placeholder="Ada"
                disabled={busy}
              />
            </div>
            <div className="auth-field" style={{ margin: 0 }}>
              <label htmlFor={lastNameId}>Last name</label>
              <input
                id={lastNameId}
                type="text"
                autoComplete="family-name"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="product-input auth-input"
                placeholder="Lovelace"
                disabled={busy}
              />
            </div>
          </div>
        )}

        {mode === "signup" && (
          <div className="auth-field">
            <label htmlFor={usernameId}>Username</label>
            <input
              id={usernameId}
              type="text"
              autoComplete="username"
              required
              minLength={3}
              maxLength={30}
              pattern="[A-Za-z0-9][A-Za-z0-9_]{2,29}"
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              className="product-input auth-input"
              placeholder="ada_lovelace"
              aria-describedby={`${usernameId}-help`}
              disabled={busy}
            />
            <span id={`${usernameId}-help`} className="text-[10px] text-[color:var(--ol-text-faint)]">
              3–30 letters, numbers, or underscores. This is shown in your workspace.
            </span>
          </div>
        )}

        <div className="auth-field">
          <label htmlFor={emailId}>{mode === "login" ? "Email or username" : "Work email"}</label>
          <input
            id={emailId}
            type={mode === "login" ? "text" : "email"}
            inputMode={mode === "login" ? "text" : "email"}
            autoComplete={mode === "login" ? "username" : "email"}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="product-input auth-input"
            placeholder="you@company.com"
            disabled={busy}
          />
        </div>

        <div className="auth-field">
          <label htmlFor={passwordId}>Password</label>
          <input
            id={passwordId}
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={mode === "signup" ? passwordHelpId : undefined}
            className="product-input auth-input"
            placeholder={mode === "login" ? "Enter your password" : "Create a strong password"}
            disabled={busy}
          />
          {mode === "login" && (
            <button type="button" className="auth-forgot-password" onClick={() => changeMode("reset")} disabled={busy}>
              Forgot password?
            </button>
          )}
        </div>

        {mode === "signup" && (
          <div id={passwordHelpId} className="auth-requirements" aria-label="Password requirements">
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
        )}

        {notice && (
          <div
            className={`auth-notice auth-notice-${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
            aria-live={notice.tone === "error" ? "assertive" : "polite"}
          >
            <span className="auth-notice-mark" aria-hidden="true">
              {notice.tone === "success" ? "✓" : "!"}
            </span>
            <span>{notice.text}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !email || !password || (mode === "signup" && !namesProvided)}
          className="auth-submit"
        >
          {busy && <span className="auth-spinner" aria-hidden="true" />}
          <span>
            {busy
              ? mode === "login"
                ? "Signing in…"
                : "Creating account…"
              : mode === "login"
                ? "Sign in securely"
                : "Create account"}
          </span>
        </button>
      </form>

      {mode === "signup" && (
        <p className="auth-switch-copy text-[10px]">
          By creating an account, you agree to the <Link href="/terms">Terms of Service</Link> and
          acknowledge the <Link href="/privacy">Privacy Policy</Link>.
        </p>
      )}

      <p className="auth-switch-copy">
        {mode === "login" ? "New to M9R?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => changeMode(mode === "login" ? "signup" : "login")}
          disabled={busy}
        >
          {mode === "login" ? "Create an account" : "Sign in"}
        </button>
      </p>

      <div className="auth-trust-note">
        <span aria-hidden="true">◇</span>
        Your evidence and rules remain isolated to your workspace.
      </div>
    </div>
  );
}

/* Brand marks for the OAuth buttons (inline so there are no extra deps). */
function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
