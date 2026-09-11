"use client";

/**
 * WorkspaceSwitcher — the sidebar workspace control.
 * ----------------------------------------------------------------------------
 * Shows the active workspace and opens a dropdown to switch between projects or
 * create a new one (Linear-style). Switching writes a cookie via
 * /api/projects/active and refreshes server data; creating posts to
 * /api/projects then switches to the new workspace.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePopover } from "@/components/product/usePopover";
import type { ProjectItem } from "@/lib/projects-service";
import type { WorkspacePlanUsage } from "@/lib/plan-limits-service";

export default function WorkspaceSwitcher({
  projects,
  activeProjectId,
  workspaceUsage,
}: {
  projects: ProjectItem[];
  activeProjectId: string | null;
  workspaceUsage?: WorkspacePlanUsage | null;
}) {
  const router = useRouter();
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const active = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;
  const activeName = active?.name ?? "Default workspace";
  const mark = activeName.trim().charAt(0).toUpperCase() || "D";
  const createLimitReached = workspaceUsage?.limitReached === true;
  const usageLabel = workspaceUsage
    ? workspaceUsage.maxWorkspaces === null
      ? `${workspaceUsage.plan === "paid" ? "Paid" : "Plan"} · ${workspaceUsage.workspaceCount} workspace${workspaceUsage.workspaceCount === 1 ? "" : "s"}`
      : `${workspaceUsage.plan === "paid" ? "Paid" : "Free"} · ${workspaceUsage.workspaceCount}/${workspaceUsage.maxWorkspaces} workspaces`
    : `Personal · ${projects.length || 1} workspace${projects.length === 1 ? "" : "s"}`;

  async function switchTo(projectId: string) {
    if (projectId === active?.id) return setOpen(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        setError("Couldn't switch workspace.");
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace() {
    const name = newName.trim();
    if (!name || createLimitReached) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json()) as { ok: true; project: ProjectItem } | { error: string };
      if (!res.ok || !("ok" in json)) {
        setError(("error" in json && json.error) || "Couldn't create workspace.");
        return;
      }
      // Make the new workspace active immediately, then refresh.
      await fetch("/api/projects/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: json.project.id }),
      });
      setNewName("");
      setCreating(false);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-switcher-wrap" ref={ref}>
      <button
        type="button"
        className="workspace-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="workspace-switcher-mark">{mark}</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-xs font-medium text-[color:var(--ol-text-secondary)]">{activeName}</span>
          <span className="mt-0.5 block text-[9px] text-[color:var(--ol-text-faint)]">{usageLabel}</span>
        </span>
        <svg className={`h-3 w-3 text-[color:var(--ol-text-faint)] transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="m3.5 5 2.5 2 2.5-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="popover-menu workspace-popover" role="menu">
          <div className="popover-label">Workspaces</div>
          <div className="max-h-56 overflow-y-auto">
            {(projects.length ? projects : [{ id: "_default", name: "Default workspace", description: null, createdAt: "" }]).map(
              (p) => {
                const isActive = p.id === (active?.id ?? "_default");
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={busy || p.id === "_default"}
                    onClick={() => switchTo(p.id)}
                    className="popover-item"
                  >
                    <span className="workspace-switcher-mark workspace-switcher-mark-sm">
                      {p.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
                    {isActive && (
                      <svg className="h-3.5 w-3.5 text-[color:var(--ol-accent-text)]" viewBox="0 0 14 14" fill="none" aria-hidden>
                        <path d="m3 7 2.5 2.5L11 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                );
              },
            )}
          </div>

          <div className="popover-divider" />

          {creating ? (
            <div className="px-2 pb-1.5 pt-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createWorkspace();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Workspace name…"
                className="w-full rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-0)] px-2.5 py-1.5 text-xs text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-border-strong)]"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void createWorkspace()}
                  disabled={busy || !newName.trim() || createLimitReached}
                  className="rounded-md bg-[color:var(--ol-accent)] px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[color:var(--ol-accent-hover)] disabled:opacity-40"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="px-1.5 py-1 text-[11px] text-[color:var(--ol-text-muted)] hover:text-[color:var(--ol-text-secondary)]"
                >
                  Cancel
                </button>
              </div>
              {createLimitReached && (
                <p className="mt-1.5 text-[10px] leading-snug text-[color:var(--ol-danger)]" role="alert">
                  {workspaceUsage?.message}
                </p>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="popover-item text-[color:var(--ol-text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={createLimitReached}
              onClick={() => {
                if (!createLimitReached) setCreating(true);
              }}
            >
              <span className="popover-item-glyph" aria-hidden>
                <svg viewBox="0 0 14 14" fill="none">
                  <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
              New workspace
            </button>
          )}

          {createLimitReached && !creating && (
            <div className="px-3 pb-2 pt-1 text-[10px] leading-snug text-[color:var(--ol-danger)]" role="alert">
              {workspaceUsage?.message}
            </div>
          )}
          {error && <div className="px-3 pb-2 pt-1 text-[10px] text-[color:var(--ol-danger)]">{error}</div>}
        </div>
      )}
    </div>
  );
}
