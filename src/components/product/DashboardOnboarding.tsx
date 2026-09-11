"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const STORAGE_KEY = "oathlock_walkthrough_completed";

const STEPS = [
  { title: "Welcome to M9R", body: "This tour uses your real production workspace. It explains the workflow without creating fake runs or changing records.", href: "/dashboard/agents" },
  { title: "The Watchfloor", body: "Agents and humans share one real chat workspace with channels, messages, and threads. The Approval Center keeps decisions and run evidence close to the conversation.", href: "/dashboard/agents" },
  { title: "Connect an agent", body: "Connect any coding agent that can run the M9R CLI, then run npx m9r-cli init in the repository you control. Codex, Claude Code, OpenCode, Grok, and other providers can appear as soon as they connect. Browser multiplayer works through the approved connection; the local terminal runtime is optional and experimental, not required for the shared workspace.", href: "/dashboard/agents" },
  { title: "Memory and Rules", body: "Memory and workspace rules are reviewable context for future work. An agent flags something, you confirm it, and the whole team carries it forward.", href: "/dashboard/memory" },
  { title: "Ready for Review", body: "The agent prepares evidence. A human approves evidence. M9R records the decision. Empty queues are normal until a controlled run reaches a decision.", href: "/dashboard/agents" },
  { title: "You are ready", body: "Open Help and select Start product tour whenever you want to revisit this guide.", href: "/dashboard/help" },
] as const;

export default function DashboardOnboarding({ completed, autoStart, reviewerDemo = false }: { completed: boolean; autoStart: boolean; reviewerDemo?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const requested = search.get("tour") === "1";
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reviewerDemo) return;
    let locallyCompleted = false;
    try { locallyCompleted = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* unavailable */ }
    if (requested || (autoStart && !completed && !locallyCompleted)) queueMicrotask(() => setOpen(true));
  }, [autoStart, completed, requested, reviewerDemo]);

  useEffect(() => {
    if (!open) return;
    const href = STEPS[step].href;
    const current = `${pathname}${search.toString() ? `?${search}` : ""}`;
    if (!current.startsWith(href)) router.push(href);
  }, [open, pathname, router, search, step]);

  if (!open || reviewerDemo) return null;

  async function persistAndClose() {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* server persistence remains */ }
    await fetch("/api/walkthrough", { method: "PATCH" }).catch(() => null);
    setOpen(false);
    router.replace(pathname);
  }

  const current = STEPS[step];
  return (
    <div className="onboarding-overlay" role="dialog" aria-labelledby="onboarding-title">
      <section className="onboarding-card">
        <button type="button" className="onboarding-close" aria-label="Close product tour" onClick={() => void persistAndClose()}>×</button>
        <div className="bs-micro">Product tour · {step + 1}/{STEPS.length}</div>
        <h2 id="onboarding-title">{current.title}</h2>
        <p>{current.body}</p>
        <div className="onboarding-actions">
          <span className="text-[10px] text-[color:var(--ol-text-faint)]">You can use the page while this guide stays open.</span>
          <span className="flex-1" />
          <button type="button" className="product-btn product-btn-secondary" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>Back</button>
          {step === STEPS.length - 1
            ? <button type="button" className="product-btn product-btn-primary" onClick={() => void persistAndClose()}>Finish</button>
            : <button type="button" className="product-btn product-btn-primary" onClick={() => setStep((value) => value + 1)}>Next</button>}
        </div>
      </section>
    </div>
  );
}
