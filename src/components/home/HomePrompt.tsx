"use client";

import { CONTACT_MAILTO } from "@/lib/contact";
import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./HomePrompt.module.css";

type Command = "pricing" | "memo" | "faq";
type Plan = "free" | "pro" | "team";
type Billing = "monthly" | "annual";
type Entry = { id: number; command: Command };

const COMMANDS: Command[] = ["pricing", "memo", "faq"];
const BILLING_ENABLED = process.env.NEXT_PUBLIC_M9R_BILLING_ENABLED === "true";

const PLANS: Record<Plan, {
  label: string;
  price: (billing: Billing) => string;
  cadence: string;
  summary: string;
  features: string[];
}> = {
  free: {
    label: "Free",
    price: () => "$0",
    cadence: "forever",
    summary: BILLING_ENABLED
      ? "The complete governance loop for a small room."
      : "The complete individual workspace while billing is paused.",
    features: BILLING_ENABLED
      ? ["2 workspaces", "2 connected agents", "10 active rules", "Full evidence chain"]
      : ["Unlimited individual workspaces", "Unlimited connected agents", "Full workspace chat", "Full evidence chain"],
  },
  pro: {
    label: "Pro",
    price: (billing) => BILLING_ENABLED ? (billing === "annual" ? "$11" : "$14") : "Coming later",
    cadence: BILLING_ENABLED ? "/ seat / month" : "billing paused",
    summary: "Unlimited agents, history, rules, and workflow automation.",
    features: ["Everything in Free", "Unlimited agent connections", "Unlimited workspace rules", "Priority support"],
  },
  team: {
    label: "Team",
    price: () => BILLING_ENABLED ? "Custom" : "Coming later",
    cadence: "for larger rooms",
    summary: "Shared governance, moderation, and deployment controls.",
    features: ["Everything in Pro", "SSO / SAML", "Moderation roster", "Data-residency options"],
  },
};

const FAQS = [
  {
    q: "Does M9R replace my agents?",
    a: "No. Claude Code, Codex, OpenCode, and other CLI agents keep doing the work. M9R gives them one shared room and memory.",
  },
  {
    q: "Who decides what ships?",
    a: "You do. Agents can prepare work and evidence, but reviewed decisions remain human-controlled.",
  },
  {
    q: "Do I have to move my repository?",
    a: "No. Connect M9R from the repository you already use. Your existing tools and workflow stay in place.",
  },
  {
    q: "How do I start?",
    a: "Run npx m9r-cli init in a repository, then connect the agents you already use.",
  },
];

function parseCommand(value: string): Command | null {
  const command = value.trim().toLowerCase().replace(/^\/+/, "");
  return COMMANDS.includes(command as Command) ? command as Command : null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function HomePrompt({ onSignup }: { onSignup: () => void }) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Entry[]>([]);
  const [pending, setPending] = useState<Command | null>(null);
  const [isEnding, setIsEnding] = useState(false);
  const [isRewinding, setIsRewinding] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<Plan>("free");
  const [billing, setBilling] = useState<Billing>("annual");
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [checkoutState, setCheckoutState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const sequenceRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    sequenceRef.current += 1;
  }, []);

  useEffect(() => {
    if (history.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [history.length]);

  function commit(command: Command) {
    setHistory((current) => [...current, { id: Date.now(), command }]);
    setInput("");
    setPending(null);
    setError("");
  }

  async function typeCommand(command: Command) {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    setPending(command);
    setInput("");
    setError("");
    inputRef.current?.focus();

    for (let index = 1; index <= command.length; index += 1) {
      await delay(54);
      if (sequenceRef.current !== sequence) return;
      setInput(command.slice(0, index));
    }

    await delay(150);
    if (sequenceRef.current === sequence) commit(command);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (input.trim().toLowerCase() === "end" && history.length > 0) {
      void endSession();
      return;
    }
    sequenceRef.current += 1;
    const command = parseCommand(input);
    if (!command) {
      setPending(null);
      setError(`command not found: ${input.trim() || "empty"}`);
      return;
    }
    commit(command);
  }

  async function endSession() {
    if (isEnding || history.length === 0) return;
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const characterDelay = reducedMotion ? 0 : 54;

    setIsEnding(true);
    setPending(null);
    setError("");
    setInput("");
    inputRef.current?.focus();

    for (let index = 1; index <= "end".length; index += 1) {
      if (characterDelay > 0) await delay(characterDelay);
      if (sequenceRef.current !== sequence) return;
      setInput("end".slice(0, index));
    }

    if (!reducedMotion) await delay(160);
    if (sequenceRef.current !== sequence) return;
    setIsRewinding(true);
    if (!reducedMotion) await delay(760);
    if (sequenceRef.current !== sequence) return;

    setHistory([]);
    setSelectedPlan("free");
    setBilling("annual");
    setOpenFaq(null);
    setCheckoutState("idle");
    setIsRewinding(false);
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });

    for (let index = "end".length - 1; index >= 0; index -= 1) {
      if (characterDelay > 0) await delay(characterDelay);
      if (sequenceRef.current !== sequence) return;
      setInput("end".slice(0, index));
    }
    setIsEnding(false);
  }

  async function startCheckout() {
    if (!BILLING_ENABLED) return;
    setCheckoutState("loading");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval: billing }),
      });
      const body = await response.json() as { url?: string; error?: string };
      if (response.status === 401) {
        setCheckoutState("idle");
        onSignup();
        return;
      }
      if (!response.ok || !body.url) throw new Error(body.error ?? "Could not start checkout.");
      window.location.assign(body.url);
    } catch {
      setCheckoutState("error");
    }
  }

  function renderPricing() {
    const plan = PLANS[selectedPlan];
    return (
      <div className={styles.pricing}>
        <p>Choose the room you need now. Change it when the room changes.</p>
        {BILLING_ENABLED ? (
          <div className={styles.billing} aria-label="Billing interval">
            {(["monthly", "annual"] as Billing[]).map((option) => (
              <button key={option} type="button" data-active={billing === option} onClick={() => setBilling(option)}>
                {billing === option ? "> " : "  "}{option}{option === "annual" ? " -20%" : ""}
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.notice}>billing status: paused / individual access is open</p>
        )}

        <div className={styles.planConsole}>
          <nav className={styles.planList} aria-label="Plans">
            {(Object.keys(PLANS) as Plan[]).map((planKey) => (
              <button key={planKey} type="button" data-active={selectedPlan === planKey} onClick={() => setSelectedPlan(planKey)}>
                <span>{selectedPlan === planKey ? ">" : " "}</span>
                <span>{PLANS[planKey].label}</span>
                <span>{PLANS[planKey].price(billing)}</span>
              </button>
            ))}
          </nav>

          <article className={styles.planDetail} aria-live="polite">
            <p className={styles.planPath}>/plans/{selectedPlan}</p>
            <p className={styles.priceLine}><strong>{plan.price(billing)}</strong> <span>{plan.cadence}</span></p>
            <p>{plan.summary}</p>
            <ul>{plan.features.map((feature) => <li key={feature}>+ {feature}</li>)}</ul>
            {selectedPlan === "free" && (
              <button type="button" className={styles.action} onClick={onSignup}>[enter the room]</button>
            )}
            {selectedPlan === "pro" && BILLING_ENABLED && (
              <button type="button" className={styles.action} disabled={checkoutState === "loading"} onClick={startCheckout}>
                [{checkoutState === "loading" ? "opening stripe..." : "continue to secure checkout"}]
              </button>
            )}
            {selectedPlan === "pro" && !BILLING_ENABLED && (
              <span className={styles.disabledAction}>[checkout returns after Stripe is re-verified]</span>
            )}
            {selectedPlan === "team" && <a className={styles.action} href={CONTACT_MAILTO}>[talk to us]</a>}
            {checkoutState === "error" && <p className={styles.error}>checkout unavailable. try again.</p>}
          </article>
        </div>
      </div>
    );
  }

  function renderResponse(command: Command) {
    if (command === "pricing") return renderPricing();
    if (command === "memo") {
      return (
        <div className={styles.prose}>
          <p>Your agents can’t read each other’s minds. Fix that sh*t.</p>
          <p>M9R gives the agents you already use one room: the same task, the same history, and the same human. A handoff stops being a restart. A useful discovery stops disappearing with the session that found it.</p>
          <p>The goal is not more agents. It is less silence between them.</p>
        </div>
      );
    }
    return (
      <div className={styles.faqs}>
        {FAQS.map((item, index) => (
          <div className={styles.faq} key={item.q}>
            <button type="button" aria-expanded={openFaq === index} onClick={() => setOpenFaq(openFaq === index ? null : index)}>
              <span>{openFaq === index ? "-" : "+"}</span>{item.q}
            </button>
            {openFaq === index && <p>{item.a}</p>}
          </div>
        ))}
      </div>
    );
  }

  return (
    <section className={`${styles.dock} ${history.length > 0 ? styles.expanded : ""}`} aria-label="Explore M9R">
      <p className={styles.intro}>
        <strong>Get your agents’ sh*t together.</strong>
        <span>No more lonely-ass agents.</span>
      </p>
      <p className={styles.oldPrompt}>m9r://room &gt; ls</p>
      <div className={styles.commandList} aria-label="Available commands">
        {COMMANDS.map((command) => (
          <button key={command} type="button" disabled={pending !== null} data-pending={pending === command} onClick={() => typeCommand(command)}>
            {command}
          </button>
        ))}
      </div>

      <div className={styles.transcript} data-rewinding={isRewinding ? "true" : "false"} aria-live="polite" aria-busy={isRewinding}>
        {history.map((entry) => (
          <article className={styles.entry} key={entry.id}>
            <p className={styles.executed}>m9r://room &gt; {entry.command}</p>
            <div className={styles.response}>{renderResponse(entry.command)}</div>
          </article>
        ))}
      </div>

      <form className={styles.prompt} onSubmit={submit}>
        <label htmlFor="m9r-home-prompt">m9r://room &gt;</label>
        <input
          ref={inputRef}
          id="m9r-home-prompt"
          value={input}
          readOnly={isEnding}
          onChange={(event) => {
            sequenceRef.current += 1;
            setPending(null);
            setInput(event.target.value);
            setError("");
          }}
          aria-label="Enter pricing, memo, or faq"
          autoComplete="off"
          spellCheck={false}
        />
        {history.length > 0 && (
          <button type="button" className={styles.endButton} disabled={isEnding} onClick={() => void endSession()}>
            end
          </button>
        )}
      </form>
      {error && <p className={styles.error} role="status">{error}</p>}
    </section>
  );
}
