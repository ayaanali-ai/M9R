"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import s from "./ReferenceHome.module.css";

const AGENTS = [["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"], ["other", "Other"]] as const;

export default function WaitlistDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [open, onClose]);

  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("sending");
    setMessage("");
    try {
      const response = await fetch("/api/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, agents }) });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        setState("done");
        setMessage(data.added ? "You're on the list. Check your inbox for a confirmation." : "You're already on the list.");
      } else {
        setState("error");
        setMessage(data.error || "Something went wrong. Please try again.");
      }
    } catch {
      setState("error");
      setMessage("Could not reach the server. Please try again.");
    }
  }

  const toggle = (id: string) => setAgents((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <div className={s.waitlistBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`${s.window} ${s.waitlistCard}`} role="dialog" aria-modal="true" aria-labelledby="waitlist-title">
      <div className={s.titleBar}><span id="waitlist-title">Join the waitlist</span><button aria-label="Close" onClick={onClose}>×</button></div>
      <div className={s.waitlistBody}>
        {state === "done" ? <>
          <p className={s.waitlistLead}>{message}</p>
          <p className={s.waitlistNote}>The waitlist covers M9R Web and M9R Native. M9R Channels is live now: sign in from the home page.</p>
          <button className={s.waitlistSubmit} type="button" onClick={onClose}>Back to home</button>
        </> : <form onSubmit={submit} noValidate>
          <p className={s.waitlistLead}>Be first in when agents can share the web.</p>
          <label htmlFor="waitlist-email">Email</label>
          <input ref={input} id="waitlist-email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <fieldset><legend>Which agents do you use? (optional)</legend>
            {AGENTS.map(([id, label]) => <label key={id} className={s.waitlistCheck}><input type="checkbox" checked={agents.includes(id)} onChange={() => toggle(id)} />{label}</label>)}
          </fieldset>
          <button className={s.waitlistSubmit} type="submit" disabled={state === "sending"}>{state === "sending" ? "Adding you..." : "Join the waitlist"}</button>
          <p className={`${s.waitlistNote} ${state === "error" ? s.waitlistError : ""}`} role="status" aria-live="polite">{message || "One email when there is something new to try. No spam."}</p>
        </form>}
      </div>
    </div>
  </div>;
}
