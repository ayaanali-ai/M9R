"use client";

import { useEffect, useRef, useState } from "react";
import AuthForm from "@/components/product/AuthForm";
import HomePrompt from "./HomePrompt";
import styles from "./UseM9RHome.module.css";

const GITHUB_URL = "https://github.com/ayaanali-ai/M9R";
const X_URL = "https://x.com/useM9R";

const COMMAND = "npx m9r-cli connect";

/**
 * This page opens its own sheet rather than HomeAuthModal: that modal ships a
 * white card, a red mark and a marketing column, all of which MonopoHome still
 * wants. Keeping a local one leaves that caller untouched.
 */
type Panel = "login" | "signup";

export default function UseM9RHome({ configured }: { configured: boolean }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [panel]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission);
      // the command stays selectable text either way.
    }
  }

  return (
    <div className={styles.home}>
      <div className={styles.mark}>
        <span className={styles.markText}>&quot;@useM9R&quot;</span>
      </div>

      <main className={styles.center}>
        <div className={styles.commandRow}>
          <span className={styles.commandUnderlined}>
            <code className={styles.command}>{COMMAND}</code>
            {/* Freehand pencil stroke: deliberately uneven control points and a
                slight overshoot past each end, so it never reads as a border. */}
            <svg className={styles.underline} viewBox="0 0 240 12" preserveAspectRatio="none" aria-hidden="true">
              <path
                d="M3 7.4C21 5.1 39.5 8.6 58 6.2c18.2-2.3 36.6 2.9 54.8 1.1 17.4-1.7 34.6 3.4 52 1.6 16.1-1.6 32 2.1 47.9 2.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M9 9.9C27.4 8.2 45.6 10.4 64 9.1c19.3-1.4 38.4 1.3 57.7.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.9"
                strokeLinecap="round"
                opacity="0.55"
              />
            </svg>
          </span>
          <button type="button" className={styles.copy} onClick={copyCommand} aria-label={copied ? "Copied" : "Copy command"}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M10.5 2.5h-8v8" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
      </main>

      <HomePrompt onSignup={() => setPanel("signup")} />

      <button type="button" className={styles.getStarted} onClick={() => setPanel("signup")}>
        Get Started
      </button>

      <div className={styles.social}>
        <a href={GITHUB_URL} aria-label="GitHub" target="_blank" rel="noreferrer">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
            />
          </svg>
        </a>
        <a href={X_URL} aria-label="X" target="_blank" rel="noreferrer">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12.6 0h2.45l-5.35 6.12L16 16h-4.94l-3.87-5.06L2.76 16H.3l5.72-6.54L0 0h5.06l3.5 4.63L12.6 0Zm-.86 14.53h1.36L4.32 1.39H2.86l8.88 13.14Z"
            />
          </svg>
        </a>
      </div>

      <footer className={styles.footer}>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
        <span>© 2026 M9R</span>
      </footer>

      {panel && (
        <div
          className={styles.scrim}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={panel === "signup" ? "Create your M9R account" : "Sign in to M9R"}>
            <div className={styles.sheetHead}>
              <span className={styles.sheetMark}>&quot;@useM9R&quot;</span>
              <button type="button" className={styles.sheetClose} onClick={() => setPanel(null)} aria-label="Close">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className={styles.sheetForm}>
              <AuthForm
                configured={configured}
                hideHeading
                oauthLabelPrefix="Continue with"
                initialMode={panel}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
