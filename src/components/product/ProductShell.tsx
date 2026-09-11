"use client";

import Link from "next/link";
import "./dashboard-renovation.css";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import M9RMark from "@/components/M9RMark";
import { AgentMark } from "@/components/product/WorkspaceUI";
import { createClient } from "@/lib/supabase/browser";
import WorkspaceSwitcher from "@/components/product/WorkspaceSwitcher";
import DashboardOnboarding from "@/components/product/DashboardOnboarding";
import MachineConnectionBanner from "@/components/product/MachineConnectionBanner";
import SidebarChannelList from "@/components/product/ChannelSwitcher";
import type { ProjectItem } from "@/lib/projects-service";
import type { WorkspacePlanUsage } from "@/lib/plan-limits-service";
import type { AgentStatusSummary, ConnectedAgentNavItem } from "@/lib/agent-status-summary";
import {
  applyDashboardMode,
  DASHBOARD_MODE_EVENT,
  nextDashboardMode,
  readDashboardMode,
  type DashboardMode,
} from "@/lib/dashboard-mode";

// Two-region navigation (Slack's rail + contextual sidebar). The rail holds the
// destinations; the wide region holds whatever that destination navigates
// *within*. Runs / Rules / Findings are no longer rail-level nouns — Rules and
// Findings merge into Memory, and the run ledger stops being a user-facing
// destination at all. Approvals stay inline in the chat feed, never a page.
type RailRegion = "chat" | "memory";
const RAIL_ITEMS = [
  ["/dashboard/agents", "Chat", "agent", "chat"],
  ["/dashboard/memory", "Memory", "memory", "memory"],
] as const satisfies ReadonlyArray<readonly [string, string, string, RailRegion]>;
// The reviewer demo workspace is read-only seeded data; Memory and Settings
// have nothing meaningful to show there, so the rail is Chat-only.
const REVIEWER_RAIL_HREFS = new Set<string>(["/dashboard/agents"]);

// Agent picker entries are derived from live connections, never from a
// provider allowlist. A connection-scoped key keeps two copies of one
// provider independently addressable and lets any valid agent kind appear.
type AgentLink = { key: string; label: string; agentKind?: string; connectionId?: string };

function agentLinksForStatus(status: AgentStatusSummary): AgentLink[] {
  return [
    { key: "all", label: "All agents" },
    ...status.agents.filter((agent) => agent.agentKind !== "codex").map((agent: ConnectedAgentNavItem) => ({
      key: agent.key,
      label: agent.label,
      agentKind: agent.agentKind,
      connectionId: agent.connectionId,
    })),
  ];
}

export default function ProductShell({
  displayName,
  projects = [],
  activeProjectId = null,
  workspaceUsage = null,
  agentStatus = { byKey: {}, agents: [] },
  reviewerDemo = false,
  onboardingCompleted = false,
  onboardingAutoStart = false,
  children,
}: {
  displayName: string;
  projects?: ProjectItem[];
  activeProjectId?: string | null;
  workspaceUsage?: WorkspacePlanUsage | null;
  agentStatus?: AgentStatusSummary;
  reviewerDemo?: boolean;
  onboardingCompleted?: boolean;
  onboardingAutoStart?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Claude-style hidden nav: when collapsed, the sidebar is fully gone; hovering
  // the seal trigger peeks it as a floating overlay, clicking the trigger pins
  // it back open.
  const [peek, setPeek] = useState(false);
  const [mode, setMode] = useState<DashboardMode>("night");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const agentLinks = agentLinksForStatus(agentStatus);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // The pre-paint script in the dashboard layout already applied the persisted
    // mode; here we only sync React state to what is on the DOM.
    queueMicrotask(() => setMode(readDashboardMode()));
    const onModeChange = (event: Event) => {
      setMode((event as CustomEvent<DashboardMode>).detail);
    };
    window.addEventListener(DASHBOARD_MODE_EVENT, onModeChange);
    return () => window.removeEventListener(DASHBOARD_MODE_EVENT, onModeChange);
  }, []);

  function toggleMode() {
    applyDashboardMode(nextDashboardMode(mode));
  }

  useEffect(() => {
    // Restore the collapse preference off the synchronous effect body.
    queueMicrotask(() => {
      try {
        // Hidden is the default (Claude-style); an explicit "0" pins it open.
        const stored = window.localStorage.getItem("oathlock_sidebar_collapsed");
        setCollapsed(stored === null ? true : stored === "1");
      } catch {
        /* no persistence available */
      }
    });
  }, []);

  function toggleCollapsed() {
    setPeek(false);
    setCollapsed((value) => {
      try {
        window.localStorage.setItem("oathlock_sidebar_collapsed", value ? "0" : "1");
      } catch {
        /* no persistence available */
      }
      return !value;
    });
  }
  const railItems = reviewerDemo ? RAIL_ITEMS.filter(([href]) => REVIEWER_RAIL_HREFS.has(href)) : RAIL_ITEMS;
  const isActiveHref = (href: string) => pathname === href || pathname.startsWith(href + "/");
  // Which contextual sidebar the wide region shows. Driven by the route, not by
  // click state, so a deep link or a back button lands on the right region.
  const region: RailRegion = isActiveHref("/dashboard/memory") ? "memory" : "chat";
  const initial = displayName.replace(/^@/, "").trim().charAt(0).toUpperCase() || "O";

  async function signOut() {
    setSigningOut(true);
    await createClient()?.auth.signOut();
    router.replace("/");
    router.refresh();
  }

  return (
    <div className={`product-shell m9r-workspace min-h-screen text-[color:var(--ol-text-primary)] ${collapsed ? "product-shell--collapsed" : ""}`.trim()}>
      <a href="#workspace-content" className="product-skip-link">
        Skip to workspace
      </a>

      {/* Hidden-nav trigger (Claude-style): only exists while collapsed. Hover
          peeks the sidebar as an overlay; click pins it open. */}
      {collapsed && (
        <button
          type="button"
          className="product-nav-trigger"
          onMouseEnter={() => setPeek(true)}
          onFocus={() => setPeek(true)}
          onClick={toggleCollapsed}
          aria-label="Open sidebar"
          aria-expanded={peek}
          title="Open sidebar"
        >
          <M9RMark animated={false} className="h-[21px] w-[21px] shrink-0" />
        </button>
      )}

      <aside
        className={`product-sidebar ${collapsed && peek ? "product-sidebar--peek" : ""}`.trim()}
        onMouseLeave={collapsed ? () => setPeek(false) : undefined}
      >
        {/* Region 1: the icon rail. Workspace identity pinned top, destinations
            in the middle, Settings pinned bottom — Settings is a full page of
            its own, so it navigates instead of opening a wide region. */}
        <div className="product-rail">
          {reviewerDemo ? (
            <span className="product-rail-demo-mark" title="YC demo workspace · seeded, read-only data" aria-label="YC demo workspace">
              YC
            </span>
          ) : (
            <div className="product-workspace-switcher">
              <WorkspaceSwitcher
                projects={projects}
                activeProjectId={activeProjectId}
                workspaceUsage={workspaceUsage}
              />
            </div>
          )}

          <nav className="product-rail-nav" aria-label="Workspace destinations">
            {railItems.map(([href, label, icon]) => {
              const active = isActiveHref(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={active ? "product-rail-btn product-nav-active" : "product-rail-btn"}
                  data-tip={label}
                  aria-label={label}
                  prefetch={false}
                >
                  <NavIcon name={icon} />
                </Link>
              );
            })}
          </nav>

          {!reviewerDemo && (
            <div className="product-rail-foot">
              <Link
                href="/dashboard/settings"
                aria-current={isActiveHref("/dashboard/settings") ? "page" : undefined}
                className={isActiveHref("/dashboard/settings") ? "product-rail-btn product-nav-active" : "product-rail-btn"}
                data-tip="Settings"
                aria-label="Settings"
                prefetch={false}
              >
                <NavIcon name="settings" />
              </Link>
            </div>
          )}
        </div>

        {/* Region 2: the contextual sidebar. Its content is a pure function of
            the selected rail destination. */}
        <div className="product-sidebar-wide">
        <div className="flex items-center">
          <Link href="/dashboard" className="product-brand min-w-0 flex-1">
            <M9RMark animated={false} className="h-[23px] w-[23px] shrink-0" />
            <span>M9R</span>
          </Link>
          <button
            type="button"
            className="product-collapse-btn"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Pin sidebar open" : "Hide sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Pin sidebar open" : "Hide sidebar"}
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
              {collapsed ? (
                <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>

        <nav className="product-nav" aria-label={region === "memory" ? "Memory navigation" : "Chat navigation"}>
          {region === "memory" ? (
            <MemorySidebarRegion />
          ) : (
            <>
              <SidebarChannelList chatActive={isActiveHref("/dashboard/agents")} agents={agentStatus.agents} />
              <SidebarAgentPicker chatActive={isActiveHref("/dashboard/agents")} agentStatus={agentStatus} />
            </>
          )}
        </nav>

        <div className="product-sidebar-footer">
          {/* Upload now lives in the primary nav above; the footer stays focused
              on the account row. The theme toggle used to live in the removed
              top bar -- it's the only reason that bar existed once the account
              avatar/sign-out and page identity are already covered here and by
              the nav itself, so it moved in next to the account row instead of
              floating at the top of every page. */}
          <MachineConnectionBanner hasLiveConnection={agentStatus.agents.length > 0} reviewerDemo={reviewerDemo} />
          <div className="product-account">
            <span className="product-avatar">{initial}</span>
            <span className="product-account-email min-w-0 flex-1 truncate text-[11px] text-[color:var(--ol-text-muted)]">{displayName}</span>
            <button
              type="button"
              className="product-theme-toggle"
              onClick={toggleMode}
              aria-pressed={mode === "night"}
              aria-label={mode === "day" ? "Switch to Night Watch" : "Switch to Day mode"}
              title={mode === "day" ? "Switch to Night Watch" : "Switch to Day mode"}
            >
              {mode === "day" ? (
                <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M13.5 9.1A5.5 5.5 0 0 1 6.9 2.5 5.5 5.5 0 1 0 13.5 9.1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.5 3.5l1.15 1.15M11.35 11.35 12.5 12.5M12.5 3.5l-1.15 1.15M4.65 11.35 3.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="product-signout"
              onClick={signOut}
              disabled={signingOut}
              aria-label="Sign out"
              title="Sign out"
            >
              {signingOut ? <span className="product-mini-loader" /> : (
                <svg viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M7.25 3.25H4.5v11.5h2.75M10.25 5.5 13.75 9l-3.5 3.5M13.25 9H7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </div>
        </div>
      </aside>

      <div className="product-main-frame">
        <main id="workspace-content" className="product-content" tabIndex={-1}>
          {children}
        </main>
      </div>

      {paletteOpen && (
      <CommandPalette
        reviewerDemo={reviewerDemo}
        agentLinks={agentLinks}
          mode={mode}
          onToggleMode={toggleMode}
          onSignOut={() => void signOut()}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      <nav className="product-mobile-nav" aria-label="Mobile workspace navigation">
        {railItems.map(([href, label, icon]) => {
          const active = isActiveHref(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={active ? "product-mobile-active" : ""}
              prefetch={false}
            >
              <NavIcon name={icon} />
              <span>{label}</span>
            </Link>
          );
        })}
        {!reviewerDemo && (
          <Link
            href="/dashboard/settings"
            aria-current={isActiveHref("/dashboard/settings") ? "page" : undefined}
            className={isActiveHref("/dashboard/settings") ? "product-mobile-active" : ""}
            prefetch={false}
          >
            <NavIcon name="settings" />
            <span>Settings</span>
          </Link>
        )}
        <button type="button" className="product-mobile-more" onClick={() => setPaletteOpen(true)} aria-label="Open more workspace destinations">
          <span aria-hidden>•••</span>
          <span>More</span>
        </button>
      </nav>

      <DashboardOnboarding completed={onboardingCompleted} autoStart={onboardingAutoStart} reviewerDemo={reviewerDemo} />

    </div>
  );
}

// ---------------------------------------------------------------------------
// ⌘K operator palette — jump anywhere, filter agents, flip the mode, sign out.
// Review decisions deliberately do NOT live here; those stay explicit clicks
// in the chat surface (a recorded decision is never one blind keystroke).
// ---------------------------------------------------------------------------

type PaletteCommand = { id: string; label: string; hint: string; run: () => void };

function CommandPalette({
  reviewerDemo,
  agentLinks,
  mode,
  onToggleMode,
  onSignOut,
  onClose,
}: {
  reviewerDemo: boolean;
  agentLinks: AgentLink[];
  mode: "day" | "night";
  onToggleMode: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const go = (href: string) => {
    router.push(href);
    onClose();
  };

  const commands: PaletteCommand[] = [
    { id: "floor", label: "Go to Chat", hint: "Chat", run: () => go("/dashboard/agents") },
    ...agentLinks.filter(({ key }) => key !== "all").map(({ key, label }): PaletteCommand => ({
      id: `agent-${key}`,
      label: `Chat: ${label}`,
      hint: "Agent",
      run: () => go(`/dashboard/agents?agent=${key}`),
    })),
    ...(reviewerDemo
      ? []
      : [
          // Rules and Findings had their own entries here until their pages
          // were deleted; both are Memory now, one entry.
          { id: "memory", label: "Go to Memory", hint: "Memory", run: () => go("/dashboard/memory") },
          { id: "settings", label: "Go to Settings", hint: "Registry", run: () => go("/dashboard/settings") },
          // B-1: these had a real page but no nav home anywhere --
          // findable only by typing the URL by hand. Missions has no
          // top-level index (only /dashboard/missions/[missionId]), so
          // there's nothing generic to link here without a specific run.
          { id: "projects", label: "Go to Projects", hint: "Registry", run: () => go("/dashboard/projects") },
          { id: "approvals", label: "Go to Approvals", hint: "Registry", run: () => go("/dashboard/approvals") },
        ]),
    { id: "help", label: "Go to Help", hint: "Registry", run: () => go("/dashboard/help") },
    {
      id: "mode",
      label: mode === "day" ? "Switch to Night Watch" : "Switch to Day mode",
      hint: "Mode",
      run: () => {
        onToggleMode();
        onClose();
      },
    },
    { id: "signout", label: "Sign out", hint: "Account", run: () => onSignOut() },
  ];

  const q = query.trim().toLowerCase();
  const matches = q ? commands.filter((cmd) => cmd.label.toLowerCase().includes(q)) : commands;
  const active = Math.min(index, Math.max(0, matches.length - 1));

  // Window-level so palette keys work no matter which element holds focus.
  const keyStateRef = useRef({ matches, active });
  useEffect(() => {
    keyStateRef.current = { matches, active };
  }, [matches, active]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const { matches: current, active: activeIndex } = keyStateRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex(Math.min(current.length - 1, activeIndex + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex(Math.max(0, activeIndex - 1));
      } else if (event.key === "Enter" && current[activeIndex]) {
        event.preventDefault();
        current[activeIndex].run();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bs-palette-overlay" role="dialog" aria-modal="true" aria-label="Command palette">
      <button type="button" className="bs-palette-scrim" aria-label="Close command palette" onClick={onClose} />
      <div className="bs-palette">
        <div className="bs-palette-inputrow">
          <span className="bs-micro" aria-hidden>⌘K</span>
          <input
            ref={inputRef}
            className="bs-palette-input"
            placeholder="Jump to a page, agent, or action…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            aria-label="Search commands"
          />
        </div>
        <ul className="bs-palette-list" role="listbox" aria-label="Commands">
          {matches.length === 0 && <li className="bs-palette-empty bs-mono">No matching command</li>}
          {matches.map((cmd, i) => (
            <li key={cmd.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className="bs-palette-item"
                data-active={i === active}
                onMouseEnter={() => setIndex(i)}
                onClick={() => cmd.run()}
              >
                <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                <span className="bs-micro">{cmd.hint}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="bs-palette-foot bs-micro">↑↓ move · Enter run · Esc close</div>
      </div>
    </div>
  );
}

/**
 * Memory's contextual sidebar — navigation, not a second copy of the page.
 * Same job the channel list does for Chat: say what is waiting and get you
 * into it. Counts come from the two GETs Memory itself reads (both
 * cookie/RLS-scoped), so this never shows a number the page disagrees with.
 */
function MemorySidebarRegion() {
  const [counts, setCounts] = useState<{ review: number; remembered: number; archived: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(async () => {
      try {
        const [rulesRes, flagsRes] = await Promise.all([
          fetch("/api/workspace-rules"),
          fetch("/api/agent/findings"),
        ]);
        if (!rulesRes.ok) return;
        const rules = ((await rulesRes.json()) as { rules?: Array<{ status: string }> }).rules ?? [];
        const flags = flagsRes.ok
          ? ((await flagsRes.json()) as { findings?: Array<{ reviewState: string }> }).findings ?? []
          : [];
        if (cancelled) return;
        setCounts({
          review:
            rules.filter((r) => r.status === "needs_review").length +
            flags.filter((f) => f.reviewState === "observed").length,
          remembered: rules.filter((r) => r.status === "active").length,
          archived:
            rules.filter((r) => r.status === "retired").length +
            flags.filter((f) => f.reviewState !== "observed").length,
        });
      } catch {
        /* the page itself reports load failures -- the sidebar just stays quiet */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="product-channels">
      <div className="product-channels-heading">
        <span className="product-nav-label">Memory</span>
      </div>
      {counts === null ? (
        <p className="product-channels-empty">Loading…</p>
      ) : (
        <>
          <MemoryNavLink href="/dashboard/memory#memory-review" label="Needs your review" count={counts.review} />
          <MemoryNavLink href="/dashboard/memory#memory-remembered" label="What the team remembers" count={counts.remembered} />
          <MemoryNavLink href="/dashboard/memory#memory-history" label="History" count={counts.archived} />
          {counts.review + counts.remembered + counts.archived === 0 && (
            <p className="product-channels-empty">Nothing remembered yet</p>
          )}
        </>
      )}
    </div>
  );
}

function MemoryNavLink({ href, label, count }: { href: string; label: string; count: number }) {
  return (
    <div className="product-channel-row">
      <Link href={href} className="product-channel-link">
        <span className="product-channel-glyph" aria-hidden>·</span>
        <span className="product-channel-name">{label}</span>
        {count > 0 && <b className="product-channel-unread">{count}</b>}
      </Link>
    </div>
  );
}

function SidebarAgentPicker({
  chatActive,
  agentStatus,
}: {
  chatActive: boolean;
  agentStatus: AgentStatusSummary;
}) {
  const searchParams = useSearchParams();
  const selectedAgent = searchParams.get("agent") ?? "all";

  return (
    <div className={`wf-agent-picker ${chatActive ? "" : "opacity-70"}`.trim()} aria-label="Agent filter">
      <div className="wf-micro mb-1 mt-1 text-[color:var(--ol-text-faint)]">Agents</div>
      {agentLinksForStatus(agentStatus).map(({ key, label, agentKind }) => {
        const selected = selectedAgent === key;
        const status = key === "all" ? null : agentStatus.byKey[agentKind ?? ""];
        return (
          <div key={key} className="wf-agent-picker-row">
            <Link
              href={key === "all" ? "/dashboard/agents" : `/dashboard/agents?agent=${key}`}
              aria-current={selected ? "true" : undefined}
              data-tip={label}
            >
              <AgentMark agentKey={agentKind ?? "other"} size={17} />
              <span className="wf-agent-picker-label min-w-0 truncate">{label}</span>
              {status && (
                <span
                  className="wf-agent-dot"
                  data-connected={status.connected}
                  data-live={status.live}
                  aria-hidden
                />
              )}
            </Link>
          </div>
        );
      })}
    </div>
  );
}

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="4" height="4" rx="1"/><rect x="11" y="3" width="4" height="4" rx="1"/><rect x="3" y="11" width="4" height="4" rx="1"/><rect x="11" y="11" width="4" height="4" rx="1"/></>,
    // Agent Workspace: a robot/agent head.
    agent: <><rect x="4" y="6" width="10" height="8" rx="2"/><path d="M9 3v3M6.5 9.5h.01M11.5 9.5h.01"/></>,
    trace: <><path d="M3 5h7M3 9h12M3 13h9"/><circle cx="13" cy="5" r="2"/></>,
    rule: <><path d="M4 4h10v10H4z"/><path d="m6.5 9 1.5 1.5 3.5-4"/></>,
    // Memory (Rules + Findings merged): a retained record — stacked leaves
    // bound on the left, deliberately not the checkbox the old Rules icon used.
    memory: <><path d="M4 3.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H5.5A1.5 1.5 0 0 1 4 13z"/><path d="M4 12.5h9M7.5 6.5h3"/></>,
    // Evidence: a document with lines.
    evidence: <><path d="M5 3h6l3 3v9H5z"/><path d="M10.5 3v3h3M7 9h4M7 12h4"/></>,
    // Projects: stacked layers.
    projects: <><path d="M9 3 2.5 6 9 9l6.5-3z"/><path d="M2.5 9.5 9 12.5l6.5-3M2.5 12.5 9 15.5l6.5-3"/></>,
    upload: <><path d="M9 12V3m0 0L5.5 6.5M9 3l3.5 3.5"/><path d="M3 11.5V15h12v-3.5"/></>,
    // Settings: a real gear -- a hub, a body ring, and 8 teeth attached to
    // the ring's outer edge (not converging on the center point). The
    // previous version was 8 spokes radiating straight from the hub, which
    // is a sun/asterisk silhouette, not a gear -- confirmed live and
    // flagged as a bug, not a taste call.
    settings: <><circle cx="9" cy="9" r="2"/><circle cx="9" cy="9" r="4.7"/><path d="M13.7 9L15.3 9M12.32 12.32L13.45 13.45M9 13.7L9 15.3M5.68 12.32L4.55 13.45M4.3 9L2.7 9M5.68 5.68L4.55 4.55M9 4.3L9 2.7M12.32 5.68L13.45 4.55"/></>,
    help: <><circle cx="9" cy="9" r="6"/><path d="M7.4 7a1.7 1.7 0 1 1 2.4 1.55c-.55.26-.8.65-.8 1.2M9 12.5h.01"/></>,
    // Callsign: a broadcasting beacon — concentric arcs around a center dot.
    callsign: <><circle cx="9" cy="9" r="1.3"/><path d="M6 6a4.2 4.2 0 0 1 6 0M4 4a7 7 0 0 1 10 0"/></>,
    // Finding: a magnifying glass over a record.
    finding: <><path d="M4.5 3h6l2.5 2.5V11h-8.5z"/><path d="M6.5 6.5h3M6.5 8.5h1.5"/><circle cx="12.5" cy="13" r="2"/><path d="m14.3 14.8 1.4 1.4"/></>,
    // Efficiency: three measured bars.
    efficiency: <><path d="M4.5 14V9M9 14V4.5M13.5 14v-3"/></>,
    // Approvals: a checkmark in a shield.
    approval: <><path d="M9 2.5 14.5 5v4.5c0 3.2-2.3 5.6-5.5 6.5-3.2-.9-5.5-3.3-5.5-6.5V5z"/><path d="m6.5 9 1.8 1.8L11.5 7"/></>,
  };
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}
