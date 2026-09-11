"use client";

import Activity from "reicon-react/icons/Activity";
import { User as UserIcon } from "lucide-react";

/**
 * M9R WorkspaceUI primitives
 * ----------------------------------------------------------------------------
 * The shared building blocks the dashboard redesign is assembled from. They
 * consume the semantic token layer in globals.css (`--ol-*`) and the `.ol-*`
 * classes, so hierarchy comes from surface tier + type + one accent — not
 * from a pile of tinted pills. Every dashboard page should reach for these
 * (Button, Surface, Dialog, Textarea, StatusDot, ListRow, StatusLozenge,
 * PageHeader, WorkspaceEmpty) instead of inventing a new one-off class.
 */

import { useEffect, useId, useRef } from "react";

/**
 * Button — the single button primitive. Four roles, one accent:
 *  - `primary`   cobalt; reserved for promote / brand (at most one per view)
 *  - `secondary` quiet surface + hairline (the default action)
 *  - `ghost`     text-only (cancel / dismiss)
 *  - `danger`    destructive; only ever rendered inside <DestructiveZone/>
 * Press-scale and motion are token-driven so every button feels the same.
 * `icon` / `iconRight` take a ReactNode (the app uses inline SVGs, not a
 * webfont). Behaviorally a plain <button>, so it drops into existing handlers.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size,
  icon,
  iconRight,
  className = "",
  children,
  type = "button",
  ...rest
}: {
  variant?: ButtonVariant;
  size?: "sm";
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ["ol-btn", `ol-btn--${variant}`, size === "sm" ? "ol-btn--sm" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {icon}
      {children}
      {iconRight}
    </button>
  );
}

/**
 * DestructiveZone — a bordered, labelled region that is the ONLY place a
 * hard-delete action is allowed to live (Option C: delete is gated to draft
 * rules). Wrapping the delete button here makes the consequence read as weighty
 * and keeps destructive actions out of the normal action row.
 */
export function DestructiveZone({
  label = "Destructive (drafts only)",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ol-destructive-zone">
      <p className="ol-destructive-zone__label">{label}</p>
      {children}
    </div>
  );
}

/**
 * StatusLozenge — the single pill primitive. `tone` maps to the rule lifecycle
 * (active / draft / review / archived) and to genuine semantic states
 * (ok / warn / danger / info); `neutral` is the quiet default. A `dot` is opt-in
 * so status chips can read as state without shouting.
 */
export type LozengeTone =
  | "neutral"
  | "active"
  | "draft"
  | "review"
  | "archived"
  | "ok"
  | "warn"
  | "danger"
  | "info"
  | "stale";

const LOZENGE_CLASS: Record<LozengeTone, string> = {
  neutral: "",
  active: "ol-lozenge--active",
  // A human-authored draft is a calm, neutral state; a review candidate asks for
  // a decision (warn); an archived rule is muted history.
  draft: "",
  review: "ol-lozenge--warn",
  archived: "ol-lozenge--muted",
  ok: "ol-lozenge--ok",
  warn: "ol-lozenge--warn",
  danger: "ol-lozenge--danger",
  info: "ol-lozenge--info",
  // Stale is an absence of freshness, not a warning — it gets a dead, muted
  // tone distinct from "warn" (which stays reserved for "needs your decision").
  stale: "ol-lozenge--stale",
};

/* Icon-only glyphs: one character per state; the word moves to the tooltip
   and screen-reader text so the UI stays quiet without losing meaning. */
const LOZENGE_GLYPH: Record<LozengeTone, string> = {
  neutral: "○",
  active: "●",
  draft: "◇",
  review: "◐",
  archived: "○",
  ok: "●",
  warn: "◐",
  danger: "⚠",
  info: "◍",
  stale: "○",
};

export function StatusLozenge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: LozengeTone;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`ol-lozenge ${LOZENGE_CLASS[tone]} ${className}`.trim()}>
      <span aria-hidden>{LOZENGE_GLYPH[tone]}</span>
      <span className="ol-lozenge__text">{children}</span>
    </span>
  );
}

/**
 * Text-only fallback glyphs, kept for surfaces that can only render a
 * character (plain-text exports, the static design mocks). The live UI does
 * NOT use these: AgentMark below renders each provider's actual wordless
 * mark, tinted with that provider's real brand color -- a deliberate call
 * (this used to be monochrome-only, "no vendor brand color, no implied
 * endorsement"; product wanted agents visually distinguishable at a glance
 * over that trademark caution, so the reversal is intentional, not an
 * oversight).
 */
export const AGENT_GLYPH: Record<string, string> = {
  "claude-code": "✳",
  codex: "◎",
  "grok-build": "✦",
  opencode: "◈",
};

/**
 * Anthropic's terracotta is Claude Code's real, current brand color. Neither
 * OpenAI nor x.ai publishes a signature color for Codex/Grok, so those two
 * used to render neutral gray rather than a stale or guessed hex -- but
 * product chose a deliberate identity color for Codex anyway (soft violet)
 * since distinguishing agents at a glance outweighs the no-official-color
 * caution here. OpenCode stays neutral by choice, not by omission.
 */
export const AGENT_BRAND_COLOR: Partial<Record<string, string>> = {
  "claude-code": "#D97757",
  // OpenAI's real Codex/ChatGPT mark color is white/near-black (theme-dependent),
  // not a tinted hue -- matching their actual brand rather than the placeholder
  // violet used before.
  codex: "#F2EFE9",
};

/**
 * Status ring colors -- the same three-value semantic system used everywhere
 * else (ok/warn/neutral), never a fourth hue invented just for this. active
 * = currently doing real work, waiting = blocked on a human decision (this
 * agent specifically, not the workspace-wide approval count), idle = online
 * but nothing in flight right now.
 */
export type AgentMarkStatus = "active" | "waiting" | "idle";
export const AGENT_MARK_RING_COLOR: Record<AgentMarkStatus, string> = {
  active: "var(--ol-ok)",
  waiting: "var(--ol-warn)",
  idle: "var(--ol-border-strong)",
};

/**
 * Anthropic's mark, inlined rather than pulled through Claude.toSvg() like it
 * used to be -- same treatment Codex and Grok already get below, and the only
 * way to reach the path itself.
 *
 * Why reaching it matters: this mark's rays taper to genuinely thin points, and
 * a fill-only path that thin rasterizes with visible hairline seams between the
 * rays at small sizes. Confirmed by rendering the same path at every size the
 * app actually uses -- seams at 15/24/28/38px, clean only at ~100px, and every
 * real usage here is far below that. Stroking the path in its own fill color
 * re-covers those sub-pixel seams without changing the silhouette; round joins
 * keep the ray tips from growing spikes. This is a rasterization fix, not a
 * redesign of the mark.
 */
const CLAUDE_MARK_PATH = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

export function AgentMark({ agentKey, size = 28, status }: { agentKey: string; size?: number; status?: AgentMarkStatus }) {
  const brand = AGENT_BRAND_COLOR[agentKey];
  const ringSize = size + 6;
  const mark = (
    <span
      className="ol-agentmark flex shrink-0 items-center justify-center rounded-md"
      style={brand ? {
        width: size,
        height: size,
        color: brand,
        background: "transparent",
        border: "1px solid var(--ol-border-subtle)",
      } : { width: size, height: size, color: "var(--ol-text-secondary)", background: "transparent", border: "1px solid var(--ol-border-subtle)" }}
      aria-hidden
    >
      {agentKey === "claude-code" ? (
        <svg className="ol-agentmark__brand" width={Math.round(size * .54)} height={Math.round(size * .54)} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={0.35} strokeLinejoin="round" aria-label="Claude" role="img">
          <path d={CLAUDE_MARK_PATH} />
        </svg>
      ) : agentKey === "codex" ? (
        <svg className="ol-agentmark__brand" width={Math.round(size * .58)} height={Math.round(size * .58)} viewBox="0 0 41 41" fill="currentColor" aria-label="Codex" role="img">
          <path d="M37.532 16.871A10.1 10.1 0 0 0 25.822 3.851 10.1 10.1 0 0 0 8.692 7.478 10.1 10.1 0 0 0 3.268 24.129a10.1 10.1 0 0 0 11.711 13.02 10.1 10.1 0 0 0 17.133-3.631 10.1 10.1 0 0 0 5.42-16.647Zm-15.034 21.014a7.49 7.49 0 0 1-4.799-1.735l8.201-4.734a1.31 1.31 0 0 0 .655-1.133V19.054l3.366 1.944a.13.13 0 0 1 .066.092v9.299a7.5 7.5 0 0 1-7.489 7.496ZM6.392 31.006a7.49 7.49 0 0 1-.894-5.023l8.201 4.742a1.31 1.31 0 0 0 1.308 0l9.724-5.615v3.888a.13.13 0 0 1-.048.103l-8.051 4.649a7.5 7.5 0 0 1-10.24-2.744ZM4.297 13.619a7.49 7.49 0 0 1 3.902-3.286v9.475c-.002.47.248.904.65 1.132l9.723 5.614-3.366 1.944a.13.13 0 0 1-.114.01L7.04 23.856a7.5 7.5 0 0 1-2.743-10.237Zm27.658 6.437-9.724-5.615 3.367-1.943a.13.13 0 0 1 .113-.01l8.052 4.648a7.5 7.5 0 0 1-1.159 13.528v-9.476a1.31 1.31 0 0 0-.649-1.132Zm3.351-5.044-8.202-4.741a1.31 1.31 0 0 0-1.308 0l-9.723 5.615v-3.888a.13.13 0 0 1 .048-.103l8.051-4.645a7.5 7.5 0 0 1 11.134 7.762ZM14.242 21.942l-3.367-1.944a.13.13 0 0 1-.065-.092v-9.299a7.5 7.5 0 0 1 12.293-5.756l-8.201 4.734a1.31 1.31 0 0 0-.654 1.133l-.006 11.224Zm1.829-3.943 4.331-2.501 4.331 2.5v5l-4.331 2.5-4.331-2.5v-4.999Z" />
        </svg>
      ) : agentKey === "grok-build" ? (
        /* Grok's own mark, inlined the same way Codex's is above. Path from
           lobehub/lobe-icons (MIT) — neither reicon-brands nor simple-icons
           ships an xAI/Grok icon (simple-icons request #13853 is still open),
           and x.ai serves no public brand kit, so inlining is the only route
           that gets Grok to the same fidelity as its two siblings. */
        <svg className="ol-agentmark__brand" width={Math.round(size * .56)} height={Math.round(size * .56)} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-label="Grok" role="img">
          <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
        </svg>
      ) : (
        <Activity size={Math.round(size * 0.52)} aria-hidden />
      )}
    </span>
  );
  if (!status) return mark;
  // BUG FOUND AND FIXED: this ring was `rounded-full` (a circle) wrapped
  // around `mark`, which is `rounded-md` (a rounded square) -- a square-
  // cornered box sitting inside a circular ring always leaves mismatched
  // gaps at the corners. Read live in the terminal pane header (which is
  // the one real caller that passes `status`) as "is this thing even on,"
  // not as a clean status indicator. Matching the ring's radius to the
  // mark's own makes it read as two concentric rounded squares -- the
  // ring traces the shape it's actually indicating, not a different one.
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-md"
      style={{ width: ringSize, height: ringSize, boxShadow: `0 0 0 1.5px ${AGENT_MARK_RING_COLOR[status]}` }}
    >
      {mark}
    </span>
  );
}

/**
 * A real person's own terminal, never an agent's -- item #28 Part A's whole
 * point (one shell per person, whatever they choose to run inside it isn't
 * what owns the pane). BUG FOUND AND FIXED: TerminalPane.tsx was rendering
 * AgentMark with the owning connection's provider key, branding a personal
 * shell with a Claude/Codex/OpenCode logo -- exactly backwards from that
 * design. Same box/ring shape as AgentMark for visual consistency, but a
 * neutral person glyph, never a provider mark, regardless of what's typed
 * into the shell.
 */
export function PersonMark({ size = 28, status }: { size?: number; status?: AgentMarkStatus }) {
  const ringSize = size + 6;
  const mark = (
    <span
      className="ol-agentmark flex shrink-0 items-center justify-center rounded-md"
      style={{ width: size, height: size, color: "var(--ol-text-secondary)", background: "transparent", border: "1px solid var(--ol-border-subtle)" }}
      aria-hidden
    >
      <UserIcon size={Math.round(size * 0.56)} />
    </span>
  );
  if (!status) return mark;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-md"
      style={{ width: ringSize, height: ringSize, boxShadow: `0 0 0 1.5px ${AGENT_MARK_RING_COLOR[status]}` }}
    >
      {mark}
    </span>
  );
}

/**
 * Surface — a panel / row / elevated container. Elevation reads through surface
 * tier + hairline border; real shadow is reserved for `elevated` (inspector,
 * menus). Renders a plain div and forwards className so callers can add layout.
 */
export function Surface({
  as: Tag = "div",
  variant = "panel",
  className = "",
  children,
  ...rest
}: {
  as?: React.ElementType;
  variant?: "panel" | "row" | "elevated";
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const base = variant === "row" ? "ol-row" : variant === "elevated" ? "ol-elevated" : "ol-panel";
  return (
    <Tag className={`${base} ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * Section — a labelled group header (title · count · description) with optional
 * action, matching the registry's grouped-lane pattern. `count` renders in a
 * quiet mono chip; children are the group body.
 */
export function Section({
  title,
  count,
  description,
  aside,
  children,
}: {
  title: string;
  count?: number;
  description?: string;
  /** Navigation and status only (a StatusLozenge, a back-link) -- never a
   * mutating action. Every current caller of this puts one of those two
   * things here; there is no button-placement convention for this slot
   * because nothing has ever needed one. If a real action needs a home
   * near a section header, that's a deliberate new decision, not this prop. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[color:var(--ol-text-primary)]" style={{ fontSize: "var(--ol-text-base)", fontWeight: 600 }}>
          {title}
        </h3>
        {typeof count === "number" && (
          <span className="ol-mono ol-num rounded bg-white/[0.04] px-1.5 py-0.5 text-[color:var(--ol-text-muted)]" style={{ fontSize: "var(--ol-text-2xs)" }}>
            {count}
          </span>
        )}
        {description && (
          <span className="text-[color:var(--ol-text-muted)]" style={{ fontSize: "var(--ol-text-xs)" }}>
            {description}
          </span>
        )}
        {aside && <span className="ml-auto">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

/**
 * Meta — a quiet monospace line for identifiers / receipts (run ids, counts,
 * "seen 3m ago"). Muted by default so records read as records.
 */
export function Meta({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`ol-mono ol-num flex flex-wrap items-center gap-x-3 text-[color:var(--ol-text-faint)] ${className}`.trim()}
      style={{ fontSize: "var(--ol-text-2xs)" }}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  /** Navigation and status only, same contract as Section's aside -- every
   * current caller passes a back-link. Not a place for a mutating button. */
  aside?: React.ReactNode;
}) {
  return (
    <header className="workspace-page-header">
      <div>
        {eyebrow && <div className="workspace-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </header>
  );
}

/**
 * Dialog — the one modal/overlay primitive. Backdrop click and Escape both
 * close; focus moves onto the dialog on open. Consolidates what used to be
 * 7 separate ad hoc overlay implementations scattered across the dashboard
 * (approval-center's own overlay, the onboarding tour, the command palette,
 * etc.) — new dialogs should render this instead of a bespoke fixed/inset div.
 */
export function Dialog({
  open,
  onClose,
  title,
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ol-dialog-overlay" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className={`ol-dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {title && (
          <h2 id={titleId} className="ol-dialog__title">
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Textarea — the multi-line counterpart to `.product-input`. Every dashboard
 * textarea before this was a one-off Tailwind arbitrary-value string (7-8
 * distinct variants); new ones should render this instead.
 */
export function Textarea({
  className = "",
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`product-textarea ${className}`.trim()} {...rest} />;
}

/**
 * StatusDot — a bare colored dot for the cases that just need presence/state
 * at a glance (an agent's live indicator, an unread marker) without the
 * StatusLozenge's text label. Same tone vocabulary as StatusLozenge so the
 * two never drift into different color meanings for the same state.
 */
export function StatusDot({
  tone = "neutral",
  className = "",
  title,
}: {
  tone?: LozengeTone;
  className?: string;
  title?: string;
}) {
  return <span className={`ol-status-dot ol-status-dot--${tone} ${className}`.trim()} title={title} aria-hidden />;
}

/**
 * ListRow — the shared row primitive for tabular/list data (channels, rules,
 * runs, commands). Consolidates ~6 distinct per-page div-based "row" class
 * families onto one hover/active/spacing convention.
 */
export function ListRow({
  as: Tag = "div",
  active = false,
  className = "",
  children,
  ...rest
}: {
  as?: React.ElementType;
  active?: boolean;
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={`ol-list-row ${active ? "ol-list-row--active" : ""} ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}

export function WorkspaceEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="workspace-empty">
      <div className="workspace-empty-glyph" aria-hidden>
        <span />
        <span />
      </div>
      <div className="mt-4 text-sm font-medium text-[color:var(--ol-text-secondary)]">{title}</div>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-[color:var(--ol-text-faint)]">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
