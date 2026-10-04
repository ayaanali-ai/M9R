"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import styles from "../room-url.module.css";

type AccessState = "checking" | "ready" | "signed-out" | "guest" | "unavailable";

export default function NewRoomPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessState>("checking");
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
          setError("Could not verify your sign-in. Reload the page and try again.");
          setAccess("unavailable");
          return;
        }
        if (!data.user) {
          setAccess("signed-out");
          return;
        }
        setAccess(data.user.is_anonymous ? "guest" : "ready");
      } catch {
        if (!cancelled) {
          setError("Could not verify your sign-in. Reload the page and try again.");
          setAccess("unavailable");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const roomName = name.trim();
    if (!roomName || busy || access !== "ready") return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: roomName }),
      });
      const data = await response.json().catch(() => ({})) as { room?: { id: string }; error?: string };
      if (response.status === 401) {
        setError("Your sign-in session expired. Sign in again to create a room.");
        setAccess("signed-out");
        return;
      }
      if (!response.ok || !data.room) { setError(data.error ?? "Could not create the room."); return; }
      router.push(`/rooms/${data.room.id}`);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.createShell}>
        <section className={styles.createContent} aria-labelledby="create-room-title">
          <p className={styles.eyebrow}>M9R · ROOM NETWORK</p>
          <h1 className={styles.createTitle} id="create-room-title">Create a room</h1>
          <p className={styles.createLede}>Create a room, then invite people and connect agents. People you invite sign in to ask to join; you decide who gets in.</p>

          {access === "checking" && <p className={styles.loadingMessage} role="status">Checking your account…</p>}

          {access === "ready" && (
            <>
              <form className={styles.createForm} onSubmit={(event) => void createRoom(event)}>
                <label className={styles.fieldLabel} htmlFor="room-name">
                  Room name
                  <input
                    className={styles.createInput}
                    id="room-name"
                    name="name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Give this room a name"
                    maxLength={80}
                    autoComplete="off"
                    disabled={busy}
                    required
                  />
                </label>

                <div className={styles.agentShelf} aria-label="Agents that can join this room">
                  <p className={styles.agentShelfTitle}>Bring your agents</p>
                  <p className={styles.agentShelfCopy}>Create the room, then share its link with the people and agents you want to coordinate with.</p>
                  <div className={styles.agentList} aria-label="Example agent providers">
                    <span className={styles.agentPill}>Claude</span>
                    <span className={styles.agentPill}>Codex</span>
                    <span className={styles.agentPill}>OpenCode</span>
                  </div>
                </div>

                {error && <p className={styles.inlineError} role="alert">{error}</p>}

                <button className={styles.primaryButton} type="submit" disabled={busy || !name.trim()}>
                  {busy ? "Creating…" : "Create a room"}
                </button>
              </form>

              <p className={styles.createFootnote}>People you invite can request access from the link once they sign in. You decide who gets in.</p>
            </>
          )}

          {(access === "signed-out" || access === "guest") && (
            <div className={styles.createForm}>
              <p className={styles.agentShelfCopy}>
                {access === "guest"
                  ? "This browser is using a guest room session. Signing in here ends that session; you may need to reopen rooms you joined as a guest."
                  : "Room hosts need an M9R account. People you invite need to sign in to request to join."}
              </p>
              {error && <p className={styles.inlineError} role="alert">{error}</p>}
              <button className={styles.primaryButton} type="button" onClick={() => void continueToSignIn()} disabled={signInBusy}>
                {signInBusy ? "Opening sign-in…" : "Sign in to create a room"}
              </button>
            </div>
          )}

          {access === "unavailable" && error && <p className={styles.inlineError} role="alert">{error}</p>}
        </section>
      </main>
    </div>
  );
}
