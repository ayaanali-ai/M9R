"use client";

import { useEffect, useState } from "react";
import { Bell, BellRing, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AgentMark, Button, StatusLozenge } from "@/components/product/WorkspaceUI";
import { workspaceRunState, type AgentView, type WsRun } from "@/lib/agent-workspace-data";
import type { RunPassport } from "@/lib/run-passport-service";
import { base64UrlToUint8Array } from "@/lib/push-subscription";
import { relAt, short, agentForRun, CopyButton, type Selected } from "./shared";

// ---------------------------------------------------------------------------
// Agent dock — vertical on desktop, horizontal rail on smaller screens.
// ---------------------------------------------------------------------------

export function MobileAgentRail({
  agents,
  selected,
  onSelect,
}: {
  agents: AgentView[];
  selected: Selected;
  onSelect: (next: Selected) => void;
}) {
  const entries: Array<[string, string, string]> = [["all", "All agents", "other"], ...agents.filter((agent) => agent.key !== "codex").map((agent) => [agent.id, agent.label, agent.key] as [string, string, string])];
  return (
    <nav
      aria-label="Agent filters"
      // Was scrolling with the scrollbar hidden entirely (scrollbar-width:none
      // + webkit-scrollbar:hidden) -- functional on touch via swipe, but with
      // no visible affordance the row read as clipped/broken rather than
      // scrollable. Keep the horizontal scroll, just don't hide the cue that
      // there's more to see.
      className="flex gap-1.5 overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch] [scroll-snap-type:x_proximity] lg:hidden"
    >
      {entries.map(([id, label, agentKey]) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id as Selected)}
          aria-pressed={selected === id}
          className="wf-micro flex flex-none items-center gap-1.5 rounded border px-2 py-1.5 text-[color:var(--ol-text-muted)] aria-pressed:text-[color:var(--ol-text-primary)] [scroll-snap-align:start]"
          style={{ borderColor: selected === id ? "var(--ol-border-default)" : "var(--ol-border-subtle)" }}
        >
          <AgentMark agentKey={agentKey} size={15} />
          {label}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Connect ceremony — the guided first run. Every step is derived from real
// server state and lights as init progresses; nothing is faked.
// ---------------------------------------------------------------------------

export function ConnectCeremony({ agent }: { agent: AgentView }) {
  // Step truth: 1–2 are done when a connection row exists (approval is what
  // creates it); 3 when the connection has been seen (the agent checked in).
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setClock(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);
  const approved = agent.registered;
  const seen = approved && Boolean(agent.lastSeenAt);
  const steps: Array<{ label: string; state: "done" | "active" | "pending"; detail: string }> = [
    {
      label: "Run the connect command",
      state: approved ? "done" : "active",
      detail: approved ? "Connection registered." : "Run this in the repo the agent works in.",
    },
    {
      label: "Approve in the browser",
      state: approved ? "done" : "pending",
      detail: approved
        ? "Approved. The automatic M9R workflow was installed in the repo instructions."
        : "The connect command opens a claim page. A human approves it there.",
    },
    {
      label: "Agent verified on the floor",
      state: seen ? "done" : approved ? "active" : "pending",
      detail: seen
        ? `Seen ${relAt(agent.lastSeenAt, clock)}. Give the agent a normal task. The floor takes over.`
        : "Waiting for the agent's first check-in. This lights the moment it loads rules.",
    },
  ];

  return (
    <section className="wf-ceremony mt-4" aria-label="Connect this agent">
      <div className="wf-micro text-[color:var(--ol-text-faint)]">Bring {agent.label} onto the floor</div>
      <ol className="mt-3">
        {steps.map((step, index) => (
          <li key={step.label} className={`wf-ceremony-step wf-ceremony-step--${step.state}`}>
            <span className="wf-ceremony-marker" aria-hidden>{step.state === "done" ? "✓" : index + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="wf-ceremony-label">{step.label}</div>
              <p className="wf-ceremony-detail">{step.detail}</p>
              {index === 0 && !approved && (
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded border border-[color:var(--ol-border-subtle)] bg-[color:color-mix(in_srgb,var(--ol-text-primary)_6%,transparent)] px-2.5 py-1.5 font-mono text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-secondary)]">
                    {agent.setupCommand}
                  </code>
                  <CopyButton text={agent.setupCommand} label={`Copy ${agent.key} setup command`} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="wf-micro mt-3 text-[color:var(--ol-text-faint)]">
        This page refreshes itself. Steps light as they complete. Nothing connects until a human approves.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Control strip — identity, memory loaded, revocation, and the decisions inbox.
// ---------------------------------------------------------------------------

export function ControlStrip({
  agent,
}: {
  agent: AgentView | null;
}) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setClock(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="wf-strip" aria-label="Agent Identity">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        {agent ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <AgentMark agentKey={agent.key} size={24} status={!agent.registered ? undefined : agent.connected ? "active" : "idle"} />
              <span className="truncate text-[length:var(--ol-text-sm)] font-medium text-[color:var(--ol-text-primary)]">{agent.label}</span>
            </span>
            <span className="ol-mono text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-muted)]">
              {!agent.registered
                ? "Not registered"
                : agent.connected
                  ? `M9R online · ${agent.repoHint || "workspace"} · seen ${relAt(agent.lastSeenAt, clock)} · ${agent.providerReadiness === "ready" ? "Provider session ready" : "Provider session unverified"}`
                  : `Registered · Offline · ${agent.repoHint || "workspace"} · seen ${relAt(agent.lastSeenAt, clock)} · Provider session unverified`}
            </span>
            {agent.registered && (
              // Disconnect/revoke lives in Settings now, not on the strip --
              // this is a quiet navigational pointer to it (not a mutating
              // action, so it belongs in this identity block, not the action
              // row on the right), so revoke stays reachable from where a
              // human would actually notice they need it.
              <Link
                href="/dashboard/settings#connections"
                className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-faint)] underline decoration-dotted hover:text-[color:var(--ol-text-secondary)]"
              >
                Manage connection
              </Link>
            )}
          </>
        ) : null /* the agent picker (sidebar or MobileAgentRail) already shows "All agents" as the selected chip -- this strip doesn't need to repeat it */}

      </div>

      <div className="flex shrink-0 items-center gap-2">
        <NotifyOptIn />
        <ModelOverrideControl agent={agent} />
        <FileAccessControl agent={agent} />
        <ReconnectAgentsButton />
      </div>
    </div>
  );
}

/**
 * Cannot reach into anyone's machine directly -- this only records a request
 * the CLI's own poll loop (checkReconnectRequest in oathlock-terminal-bridge.ts)
 * picks up within ~20s, and only helps if that process is still alive but a
 * bridge inside it exhausted its restart budget. If the whole process is
 * gone, nothing is listening.
 *
 * Real outcome, not a blind timer: the local runtime now reports back what it
 * actually did (see the POST handler on /api/agent/bridge-commands), so this
 * polls for that confirmation instead of reverting to idle after a fixed
 * delay with no idea whether anything happened. If nothing ever reports back,
 * that's said plainly too -- "no response" is real information, not a bug.
 */
const RECONNECT_POLL_INTERVAL_MS = 3_000;
/** The local poll loop runs every ~20s; give it two full cycles before giving up. */
const RECONNECT_POLL_TIMEOUT_MS = 42_000;

function ReconnectAgentsButton() {
  const [state, setState] = useState<"idle" | "sending" | "waiting" | "done" | "timeout" | "error">("idle");
  const [summary, setSummary] = useState<string | null>(null);

  async function sendReconnect() {
    setState("sending");
    setSummary(null);
    let requestedAt: string;
    try {
      const response = await fetch("/api/dashboard/agents/reconnect", { method: "POST" });
      if (!response.ok) { setState("error"); window.setTimeout(() => setState("idle"), 4_000); return; }
      requestedAt = new Date().toISOString();
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 4_000);
      return;
    }
    setState("waiting");
    const deadline = Date.now() + RECONNECT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_POLL_INTERVAL_MS));
      try {
        const response = await fetch("/api/dashboard/agents/reconnect", { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { handledAt?: string | null; summary?: string | null };
        if (response.ok && body.handledAt && Date.parse(body.handledAt) >= Date.parse(requestedAt)) {
          setState("done");
          setSummary(body.summary ?? null);
          window.setTimeout(() => setState("idle"), 6_000);
          return;
        }
      } catch { /* keep polling -- one dropped check isn't a reason to give up before the deadline */ }
    }
    setState("timeout");
    window.setTimeout(() => setState("idle"), 6_000);
  }

  const label = state === "sending" ? "Sending reconnect request…"
    : state === "waiting" ? "Waiting for your machine to respond…"
      : state === "done" ? (summary ?? "Reconnected.")
        : state === "timeout" ? "No response from your machine — is the local runtime still running?"
          : state === "error" ? "Couldn't send the request, try again."
            : "Ask any still-running M9R runtime on your machine to retry a stuck agent bridge. Only helps if the runtime process itself is still alive.";

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void sendReconnect()}
        disabled={state === "sending" || state === "waiting"}
        aria-label={label}
        title={label}
        className="ol-mono flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--ol-border-subtle)] bg-transparent text-[color:var(--ol-text-secondary)] hover:text-[color:var(--ol-text-primary)] disabled:opacity-60"
      >
        {state === "sending" || state === "waiting" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
      </button>
      {state !== "idle" && state !== "sending" && (
        <span className="ol-mono text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-faint)] max-w-[220px] truncate" title={label}>
          {state === "waiting" ? "Waiting…" : label}
        </span>
      )}
    </span>
  );
}

export function NotifyOptIn() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [pushStatus, setPushStatus] = useState<"unknown" | "subscribed" | "available" | "error">("unknown");
  const [busy, setBusy] = useState(false);
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null;
  const pushAvailable = Boolean(vapidPublicKey && typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window);

  useEffect(() => {
    // Defer off the synchronous effect body (repo lint: no cascading renders).
    let cancelled = false;
    queueMicrotask(() => {
      if (typeof Notification === "undefined") return;
      setPermission(Notification.permission);
      if (!pushAvailable) return;
      void navigator.serviceWorker.ready.then(async (registration) => {
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) setPushStatus(subscription ? "subscribed" : "available");
      }).catch(() => {
        if (!cancelled) setPushStatus("available");
      });
    });
    return () => { cancelled = true; };
  }, [pushAvailable]);

  async function enableNotifications() {
    if (busy || typeof Notification === "undefined") return;
    setBusy(true);
    try {
      const nextPermission = permission === "default" ? await Notification.requestPermission() : permission;
      setPermission(nextPermission);
      if (nextPermission !== "granted" || !pushAvailable || !vapidPublicKey) return;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(vapidPublicKey),
      });
      const response = await fetch("/api/notifications/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error("push subscription rejected");
      setPushStatus("subscribed");
    } catch {
      setPushStatus("error");
    } finally {
      setBusy(false);
    }
  }

  if (permission === "unsupported" || permission === "denied") return null;
  if (permission === "granted" && (!pushAvailable || pushStatus === "subscribed")) return null;
  const label = busy ? "Enabling notifications…" : permission === "granted" ? "Enable push notifications" : "Enable notifications";
  return (
    <button
      type="button"
      onClick={() => void enableNotifications()}
      disabled={busy}
      aria-label={label}
      title={label}
      className="ol-mono flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--ol-border-subtle)] bg-transparent text-[color:var(--ol-text-secondary)] hover:text-[color:var(--ol-text-primary)] disabled:opacity-60"
    >
      {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : permission === "granted" ? <BellRing size={14} aria-hidden /> : <Bell size={14} aria-hidden />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Model override — only Codex and Claude Code today. Both go through the ACP
// wrapper path (acp-stdio-adapter.ts) whose createSession applies this via
// the real session/set_config protocol call, live-verified against actual
// bridge logs before this control was built: a valid model produces "set
// model to X", an unavailable one is skipped with the agent's real available
// list named, never a silent no-op. OpenCode has no equivalent mechanism
// confirmed yet, so it deliberately gets no control here rather than one
// that would silently do nothing.
// ---------------------------------------------------------------------------

const MODEL_OVERRIDE_PROVIDERS = new Set(["codex", "claude-code"]);

// Real, current model ids only -- no guessed/stale names. Anthropic's list is
// confirmed current (Claude 5 family, GA); Codex's list is intentionally
// empty until OpenAI's current model ids are confirmed, so that provider
// falls back to free text rather than a dropdown of made-up names.
const MODEL_CATALOG: Record<string, { id: string; label: string }[]> = {
  "claude-code": [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  ],
  // Only the one value confirmed live in this workspace (the strip's own
  // "Model: gpt-5.5" readout) -- not a guessed full catalog. Extend once
  // the real list is confirmed.
  codex: [{ id: "gpt-5.5", label: "GPT-5.5" }],
};

function ModelOverrideControl({ agent }: { agent: AgentView | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(agent?.model ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!agent?.connected || !agent.connectionId || !MODEL_OVERRIDE_PROVIDERS.has(agent.key)) return null;
  // Prefer the real, live list this connection's own ACP session already
  // reported (agent.availableModels) over the hardcoded catalog -- the
  // catalog only exists as a fallback for a connection that hasn't started
  // a session yet, so there's nothing real to show.
  const knownModels = (agent.availableModels && agent.availableModels.length > 0) ? agent.availableModels : (MODEL_CATALOG[agent.key] ?? []);

  async function save(nextModel: string | null) {
    if (busy || !agent?.connectionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/connections/${agent.connectionId}/model`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: nextModel }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not save the model.");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the model.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => { setValue(agent.model ?? ""); setOpen(true); }}>
        {agent.model ? `Model: ${agent.model}` : "Set model"}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {knownModels.length > 0 ? (
        <select
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label={`Model override for ${agent.label}`}
          disabled={busy}
          className="rounded border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] px-2 py-1 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-primary)]"
        >
          <option value="">Provider default</option>
          {knownModels.map((model) => (
            <option key={model.id} value={model.id}>{model.label}</option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Provider default"
          aria-label={`Model override for ${agent.label}`}
          disabled={busy}
          className="w-40 rounded border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] px-2 py-1 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-primary)]"
        />
      )}
      <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void save(value.trim() || null)}>
        {busy ? "Saving…" : "Save"}
      </Button>
      {agent.model && (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)}>
          Clear
        </Button>
      )}
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <span role="alert" className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-danger)]">{error}</span>}
    </div>
  );
}

interface DeniedPattern { id: string; pattern: string }

/**
 * #20 resident write-path access control: the missing human-facing half of
 * agent_file_permissions -- enforcement already exists at the real ACP
 * tool-call boundary (acp-stdio-adapter.ts's requestPermission), this is
 * just where a human actually sets a deny pattern. Opt-in only: an empty
 * list means unrestricted, never a default lockout, so the control reads
 * "File access: unrestricted" rather than implying danger by default.
 */
function FileAccessControl({ agent }: { agent: AgentView | null }) {
  const [open, setOpen] = useState(false);
  const [patterns, setPatterns] = useState<DeniedPattern[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!agent?.connected || !agent.connectionId) return null;
  const connectionId = agent.connectionId;

  function load() {
    setError(null);
    fetch(`/api/dashboard/agents/${connectionId}/file-permissions`)
      .then((res) => res.json())
      .then((json: { patterns?: DeniedPattern[]; error?: string }) => {
        if (json.error) { setError(json.error); return; }
        setPatterns(json.patterns ?? []);
      })
      .catch(() => setError("Could not load the file access list."));
  }

  async function addPattern() {
    const pattern = draft.trim();
    if (!pattern || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${connectionId}/file-permissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
      const json = (await res.json().catch(() => ({}))) as { pattern?: DeniedPattern; error?: string };
      if (!res.ok || !json.pattern) throw new Error(json.error || "Could not add that pattern.");
      setPatterns((current) => [...(current ?? []), json.pattern!].sort((a, b) => a.pattern.localeCompare(b.pattern)));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that pattern.");
    } finally {
      setBusy(false);
    }
  }

  async function removePattern(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${connectionId}/file-permissions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove that pattern.");
      setPatterns((current) => (current ?? []).filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that pattern.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(true); load(); }}>
        File access
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex flex-col gap-1 rounded border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] p-2">
        <span className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-faint)]">
          {patterns === null ? "Loading…" : patterns.length === 0 ? "Unrestricted -- no denied paths" : `${patterns.length} denied path${patterns.length === 1 ? "" : "s"}`}
        </span>
        {patterns && patterns.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {patterns.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <code className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-secondary)]">{p.pattern}</code>
                <button type="button" disabled={busy} onClick={() => void removePattern(p.id)} className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-text-faint)] hover:text-[color:var(--ol-danger)]">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addPattern(); } }}
            placeholder=".env, secrets/**"
            aria-label={`Add a denied file pattern for ${agent.label}`}
            disabled={busy}
            className="w-32 rounded border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-1)] px-2 py-1 text-[length:var(--ol-text-xs)] text-[color:var(--ol-text-primary)]"
          />
          <Button type="button" variant="secondary" size="sm" disabled={busy || !draft.trim()} onClick={() => void addPattern()}>Add</Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
        </div>
        {error && <span role="alert" className="text-[length:var(--ol-text-2xs)] text-[color:var(--ol-danger)]">{error}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strip board — the floor itself. Each run is a strip sitting in the bay that
// matches its real state; strips advance as the state machine advances. The
// DECISION bay is the human's queue; the RECORDED bay is the Run Ledger below.
// ---------------------------------------------------------------------------

/**
 * FLIP strip advance — when a run crosses a trust boundary (Working → Evidence
 * → Decision) the strip physically travels to its new bay instead of teleporting.
 * Positions are recorded per run id across renders (server refreshes included —
 * run.id is the stable key); on re-parent, WAAPI plays the inverted delta.
 * Skipped under prefers-reduced-motion.
 */
const stripRects = new Map<string, DOMRect>();

function flipStrip(runId: string, el: HTMLElement | null) {
  if (!el) return;
  const prev = stripRects.get(runId);
  const next = el.getBoundingClientRect();
  stripRects.set(runId, next);
  if (!prev) return;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
    { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  );
}

/**
 * The three-bay strip board is gone: live work is the Live Sessions floor and
 * the selected run is the Run Detail below, so the only list that earns space
 * here is the human queue — runs whose evidence or decision is waiting on YOU.
 * When nothing needs a human, this renders nothing at all.
 */
export function StripBoard({
  runs,
  agents,
  passports,
  currentRunIds,
  selectedRunId,
  onSelect,
}: {
  runs: WsRun[];
  agents: AgentView[];
  passports: RunPassport[];
  currentRunIds: Set<string>;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setClock(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);
  // Starts collapsed: this panel used to render fully expanded on every
  // load, permanently eating ~130-200px above the chat -- the actual
  // primary surface on this floor -- on every screen, every time,
  // regardless of how many rows it had. Confirmed live on a normal laptop
  // window (1406x694) this alone left the chat squeezed to about half its
  // container. Collapsed by default to a single summary line; the count is
  // still visible so nothing waiting is hidden, just not force-expanded.
  const [expanded, setExpanded] = useState(false);
  const passportsByRunId = new Map(passports.map((passport) => [passport.run_id, passport]));
  const needsHuman = runs
    .map((run) => {
      const owner = agentForRun(agents, run);
      return {
        run,
        owner,
        state: workspaceRunState(run, owner, passportsByRunId.get(run.id) ?? null, currentRunIds.has(run.id)),
      };
    })
    .filter((item) => item.state.stage === "evidence" || item.state.stage === "approval");
  if (needsHuman.length === 0) return null;

  return (
    <section className="wf-lanes mt-4" aria-label="Runs waiting on you">
      <div className="wf-bay" data-attention="true">
        <button
          type="button"
          className="wf-bay-head wf-bay-head--toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="wf-micro wf-zone-label--attention">
            Waiting on you
            <span className="ol-num ml-2">{needsHuman.length}</span>
          </span>
          <span className="wf-bay-toggle-chevron" data-expanded={expanded} aria-hidden="true">▾</span>
        </button>
        {expanded && (
          <div className="wf-bay-strips">
            {needsHuman.map(({ run, owner, state }) => (
              <button
                key={run.id}
                ref={(el) => flipStrip(run.id, el)}
                type="button"
                className="wf-run-strip"
                data-selected={run.id === selectedRunId}
                onClick={() => onSelect(run.id)}
              >
                <AgentMark agentKey={owner?.key ?? run.agent_kind ?? "other"} size={18} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[color:var(--ol-text-primary)]">
                  {run.task_title || "Run"}
                </span>
                <span className="ol-mono shrink-0 text-[10px] text-[color:var(--ol-text-faint)]">
                  {owner?.label ?? run.agent_kind ?? "agent"} · {relAt(run.last_seen_at, clock)} · {short(run.id)}
                </span>
                <StatusLozenge tone={state.tone === "danger" ? "danger" : "warn"}>
                  {state.label}
                </StatusLozenge>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
