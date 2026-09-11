import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import styles from "./showcase.module.css";

export const metadata: Metadata = {
  title: "M9R Hackathon Showcase | Human-Controlled AI Agent Runs",
  description:
    "See how M9R gives AI coding agents bounded work, retained evidence, human review, and a durable run record.",
};

const flow = [
  ["Load rules", "The connected agent reads the active repository rules before work begins."],
  ["Bound the run", "A human grants a task, mode, budget, lease, and allowed repository scope."],
  ["Retain events", "Presence, work signals, evidence, and resident status remain visible in the workspace."],
  ["Review the diff", "Write output stays isolated until a human approves or rejects its bounded manifest."],
  ["Record the result", "Approved evidence becomes a retained review record and Run Passport."],
] as const;

// These are hardcoded snapshots, not live-computed -- they will go stale
// again as the suite grows and the CLI version bumps. Verify against
// `npm test`'s printed count and cli/package.json's version before reusing
// this page for a future showcase, rather than trusting these numbers.
const evidence = [
  { value: "2037", label: "full automated tests passed for this release" },
  { value: "60", label: "resident and resilience tests passed" },
  { value: "0.6.2", label: "published M9R CLI version" },
  { value: "Live", label: "production app and database rate limiting" },
] as const;

export default function HackathonShowcasePage() {
  return (
    <div className={styles.page}>
      <Nav />
      <main>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Hackathon showcase</p>
            <h1>Human control for autonomous coding agents.</h1>
            <p className={styles.lede}>
              Bound the work, inspect the evidence, and approve what enters the record.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/agents">Try the live flow</Link>
              <Link className={styles.secondary} href="/auth">Open M9R</Link>
            </div>
          </div>
          <figure className={styles.heroVisual}>
            <Image
              src="/og-v2.png"
              alt="M9R product overview showing the agent control plane"
              width={1200}
              height={630}
              priority
            />
            <figcaption>
              The public sample uses bundled data. Signed-in workspaces retain real run events.
            </figcaption>
          </figure>
        </section>

        <section className={styles.problem}>
          <h2>Autonomy needs a control plane.</h2>
          <p>
            Coding agents can execute quickly, but provider chat history is not a durable approval system.
            M9R puts rules, bounded authorization, live status, evidence, and human decisions in one workspace.
          </p>
        </section>

        <section className={styles.flowSection}>
          <div className={styles.sectionIntro}>
            <h2>From assignment to reviewed record</h2>
            <p>Each transition is explicit, attributable, and designed to fail closed.</p>
          </div>
          <ol className={styles.flow}>
            {flow.map(([title, body]) => (
              <li key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.proofSection}>
          <div className={styles.proofCopy}>
            <h2>Evidence judges can inspect</h2>
            <p>
              This release is backed by automated verification, a published CLI, retained event models,
              explicit review routes, and production abuse controls.
            </p>
            <div className={styles.proofLinks}>
              <Link href="/security">Review security</Link>
              <Link href="/auth">Enter workspace</Link>
            </div>
          </div>
          <dl className={styles.metrics}>
            {evidence.map((item) => (
              <div key={item.value}>
                <dt>{item.value}</dt>
                <dd>{item.label}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={styles.architecture}>
          <h2>Built for controlled execution</h2>
          <div className={styles.archGrid}>
            <article>
              <h3>Agent edge</h3>
              <p>Node CLI and provider adapters report bounded events without requiring M9R to hold raw source code.</p>
            </article>
            <article>
              <h3>Control service</h3>
              <p>Next.js routes enforce identity, scope, state transitions, request limits, and human approval records.</p>
            </article>
            <article>
              <h3>Durable record</h3>
              <p>Postgres, row-level security, retained events, and explicit review decisions support the Run Passport.</p>
            </article>
            <article>
              <h3>Isolated writes</h3>
              <p>Write grants create isolated workspaces and bounded manifests before adoption into the primary repository.</p>
            </article>
          </div>
        </section>

        <section className={styles.finalCta}>
          <h2>Watch a run become reviewable.</h2>
          <p>Connect an agent for the live workflow, or use the bundled sample when judge time is limited.</p>
          <div className={styles.actions}>
            <Link className={styles.primary} href="/agents">Connect an agent</Link>
            <Link className={styles.secondary} href="/auth">Try the production app</Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
