import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicResume } from "@/lib/agent-resume-service";
import styles from "./resume.module.css";

export const dynamic = "force-dynamic";

const AGENT_LABEL: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude",
  "grok-build": "Grok Build",
  other: "Connected agent",
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const resume = await getPublicResume(slug);
  if (!resume) return { title: "Resume not found — M9R" };
  const label = AGENT_LABEL[resume.agentKind] ?? "Connected agent";
  return {
    title: `${label}'s resume — M9R`,
    description: `${resume.record.reviewed} human-reviewed tasks, ${resume.record.approvalRate !== null ? Math.round(resume.record.approvalRate * 100) : "—"}% approval rate.`,
  };
}

/**
 * Public Agent Resume — no login required. Deliberately aggregate-only: real
 * work counts, real human-approval rate, nothing self-reported and nothing
 * private (no task titles, no workspace name). The one thing M9R is
 * for, made shareable outside the dashboard entirely.
 */
export default async function PublicResumePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resume = await getPublicResume(slug);
  if (!resume) notFound();

  const label = AGENT_LABEL[resume.agentKind] ?? "Connected agent";
  const approvalPct = resume.record.approvalRate !== null ? `${Math.round(resume.record.approvalRate * 100)}%` : "—";
  const since = new Date(resume.publicSince).toLocaleDateString(undefined, { year: "numeric", month: "long" });

  return (
    <div className={styles.page}>
      <div className={styles.frame}>
        <nav className={styles.nav}>
          <Link href="/" className={styles.mark}>M9R</Link>
          <span className={styles.badge}>Public resume</span>
        </nav>

        <h1 className={styles.headline}>
          {label}&rsquo;s <span>resume</span>.
        </h1>
        <p className={styles.sub}>
          Real tasks, every one reviewed by a real human. Built automatically by M9R every time this agent completes work.
        </p>

        {resume.record.runsTotal === 0 ? (
          <p className={styles.empty}>No completed work recorded yet. Check back once this agent has run its first reviewed task.</p>
        ) : (
          <>
            <div className={styles.standing}>
              <span className={styles["standing-dot"]} />
              {resume.standingLabel} · sharing since {since}
            </div>
            <div className={styles.cards}>
              <div className={styles.card}>
                <span className={styles["card-num"]}>{resume.record.runsTotal}</span>
                <span className={styles["card-lbl"]}>tasks recorded</span>
              </div>
              <div className={`${styles.card}`}>
                <span className={`${styles["card-num"]} ${styles.accent}`}>{approvalPct}</span>
                <span className={styles["card-lbl"]}>approval rate</span>
              </div>
              <div className={styles.card}>
                <span className={styles["card-num"]}>{resume.record.reviewed}</span>
                <span className={styles["card-lbl"]}>reviewed & approved</span>
              </div>
              {resume.record.needsFollowUp + resume.record.notAccepted > 0 && (
                <div className={styles.card}>
                  <span className={styles["card-num"]}>{resume.record.needsFollowUp + resume.record.notAccepted}</span>
                  <span className={styles["card-lbl"]}>needed follow-up</span>
                </div>
              )}
            </div>
          </>
        )}

        <p className={styles.footnote}>
          Every number here comes from a human decision recorded on M9R, not a self-report. <Link href="/">See how M9R works →</Link>
        </p>
      </div>
    </div>
  );
}
