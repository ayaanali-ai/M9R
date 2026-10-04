"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import styles from "../room-url.module.css";

type AccessState = "checking" | "opening" | "signed-out" | "guest" | "unavailable";

// The rooms→workspace pivot: there is no separate "create a room" step anymore.
// Your workspace IS your room. A signed-in owner landing here is sent straight
// into it (created lazily on first visit); only someone with no real account
// (signed out, or still on a guest session from an old room link) sees a prompt.
export default function NewRoomPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessState>("checking");
  const [signInBusy, setSignInBusy] = useState(false);
  const supabaseRef = useRef<ReturnType<typeof createClient>>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        if (!supabase) {
          setError("Supabase is not configured.");
          setAccess("unavailable");
          return;
        }
        supabaseRef.current = supabase;
        const { data, error: sessionError } = await supabase.auth.getUser();
        if (cancelled) return;
        if (sessionError) {
          // getUser() (unlike getSession()) always round-trips to the auth server, and for a visitor with literally no
          // session at all -- confirmed live: every brand-new visitor clicking "Create a room" from the homepage --
          // Supabase returns this as an error (AuthSessionMissingError), not a null user. Treating that as a real
          // failure showed "Could not verify your sign-in. Reload the page and try again." to every first-time visitor
          // instead of the normal sign-in prompt. This is the expected shape of "not signed in," not a failure.
          if (sessionError.name === "AuthSessionMissingError") {
            setAccess("signed-out");
            return;
          }
          setError("Could not verify your sign-in. Reload the page and try again.");
          setAccess("unavailable");
          return;
        }
        if (!data.user) {
          setAccess("signed-out");
          return;
        }
        if (data.user.is_anonymous) {
          setAccess("guest");
          return;
        }
        setAccess("opening");
        const response = await fetch("/api/rooms/mine", { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { room?: { id: string }; error?: string };
        if (cancelled) return;
        if (!response.ok || !body.room) {
          setError(body.error ?? "Could not open your room.");
          setAccess("unavailable");
          return;
        }
        router.replace(`/rooms/${body.room.id}`);
      } catch {
        if (!cancelled) {
          setError("Could not verify your sign-in. Reload the page and try again.");
          setAccess("unavailable");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  async function continueToSignIn() {
    if (signInBusy) return;
    setSignInBusy(true);
    setError(null);
    try {
      if (access === "guest") {
        const supabase = supabaseRef.current;
        if (!supabase) {
          setError("Could not open sign-in. Reload the page and try again.");
          return;
        }
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        if (signOutError) {
          setError("Could not end this guest session. Reload the page and try again.");
          return;
        }
      }
      window.location.assign(`/auth?next=${encodeURIComponent("/rooms/new")}`);
    } catch {
      setError("Could not open sign-in. Check your connection and try again.");
    } finally {
      setSignInBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.createShell}>
        <section className={styles.createContent} aria-labelledby="create-room-title">
          <p className={styles.eyebrow}>M9R</p>
          <h1 className={styles.createTitle} id="create-room-title">Your room</h1>
          <p className={styles.createLede}>Your workspace is your room. Opening it now — invite people and agents once you&apos;re in.</p>

          {(access === "checking" || access === "opening") && <p className={styles.loadingMessage} role="status">Opening your room…</p>}

          {(access === "signed-out" || access === "guest") && (
            <div className={styles.createForm}>
              <p className={styles.agentShelfCopy}>
                {access === "guest"
                  ? "This browser is using a guest room session. Signing in here ends that session; you may need to reopen rooms you joined as a guest."
                  : "You need an M9R account to open your room. People you invite can join without one."}
              </p>
              {error && <p className={styles.inlineError} role="alert">{error}</p>}
              <button className={styles.primaryButton} type="button" onClick={() => void continueToSignIn()} disabled={signInBusy}>
                {signInBusy ? "Opening sign-in…" : "Sign in to open your room"}
              </button>
            </div>
          )}

          {access === "unavailable" && error && <p className={styles.inlineError} role="alert">{error}</p>}
        </section>
      </main>
    </div>
  );
}
