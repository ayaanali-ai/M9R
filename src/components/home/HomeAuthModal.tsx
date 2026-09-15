"use client";

import AuthForm from "@/components/product/AuthForm";
import Overlay from "./Overlay";
import styles from "./HomeAuthModal.module.css";

export type AuthModalSize = "compact" | "wide";

/**
 * The wide modal's right pane, as an agent plan. `live: false` items are
 * honestly marked -- nothing here is aspirational unless the dot says so.
 */
const PLAN: { label: string; note: string; live: boolean }[] = [
  {
    label: "Shared memory across Claude Code, Codex, and OpenCode",
    note: "Every agent reads the same archived sessions.",
    live: true,
  },
  {
    label: "Live multiplayer terminal",
    note: "Watch teammates' cursors and steer a run in real time.",
    live: true,
  },
  {
    label: "Cross-agent handoffs, rendered as reviewable cards",
    note: "Work moves between agents with its evidence attached.",
    live: true,
  },
  {
    label: "Evidence drafts a human approves before anything is recorded",
    note: "Agents prepare; you decide what the run passport says.",
    live: true,
  },
  {
    label: "One-click approval for every connected agent",
    note: "In progress -- approvals are still per-run today.",
    live: false,
  },
  {
    label: "Scheduled and unattended controlled runs",
    note: "On the roadmap.",
    live: false,
  },
];

export default function HomeAuthModal({
  size,
  configured,
  onClose,
}: {
  size: AuthModalSize;
  configured: boolean;
  onClose: () => void;
}) {
  const signup = size === "wide";

  return (
    <Overlay label={signup ? "Start for free with M9R" : "Sign in to M9R"} onClose={onClose}>
      <div className={styles.grid} data-size={size}>
        <div className={styles.pane}>
          <span className={styles.mark} aria-hidden="true">✳</span>
          <h2 className={styles.greeting}>
            {signup ? "Start for free" : "Welcome back"}
            <span>{signup ? "with M9R." : "to M9R."}</span>
          </h2>
          <div className={styles.form}>
            <AuthForm
              configured={configured}
              hideHeading
              oauthLabelPrefix="Continue with"
              initialMode={signup ? "signup" : "login"}
            />
          </div>
        </div>
        {signup && (
          <aside className={styles.aside} aria-label="What M9R does">
            <p className={styles.asideLabel}>Agent plan</p>
            <ul className={styles.plan}>
              {PLAN.map((item) => (
                <li key={item.label} data-live={item.live ? "true" : "false"}>
                  <span className={styles.dot} aria-hidden="true">
                    {item.live ? "✓" : ""}
                  </span>
                  <span className={styles.planText}>
                    <span className={styles.planLabel}>{item.label}</span>
                    <span className={styles.planNote}>{item.note}</span>
                  </span>
                  <span className={styles.srOnly}>{item.live ? " (live)" : " (not yet available)"}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </Overlay>
  );
}
