"use client";

/**
 * ProjectsView — create, switch, and manage workspaces.
 * ----------------------------------------------------------------------------
 * Mirrors the sidebar switcher but as a full management surface: a create form
 * plus a grid of workspace cards, with the active one clearly marked. Switching
 * and creating both go through the same /api/projects routes and refresh the
 * server-rendered state so the whole shell stays in sync.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectItem } from "@/lib/projects-service";
import type { WorkspacePlanUsage } from "@/lib/plan-limits-service";

export default function ProjectsView({
  projects,
  activeProjectId,
  workspaceUsage,
}: {
  projects: ProjectItem[];
  activeProjectId: string | null;
  workspaceUsage?: WorkspacePlanUsage | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When no rows exist yet (pre-migration / first run), show a friendly default.
  const list: ProjectItem[] =
    projects.length > 0
      ? projects
      : [{ id: "_default", name: "Default workspace", description: "Your personal workspace", createdAt: "" }];
  const active = activeProjectId ?? list[0]?.id ?? null;
  const createLimitReached = workspaceUsage?.limitReached === true;
  const usageLabel = workspaceUsage
    ? workspaceUsage.maxWorkspaces === null
      ? `${workspaceUsage.plan === "paid" ? "Paid" : "Plan"} plan - ${workspaceUsage.workspaceCount} workspace${workspaceUsage.workspaceCount === 1 ? "" : "s"}`
      : `${workspaceUsage.plan === "paid" ? "Paid" : "Free"} plan - ${workspaceUsage.workspaceCount}/${workspaceUsage.maxWorkspaces} workspaces`
    : null;

  async function createWorkspace() {
    const trimmed = name.trim();
    if (!trimmed || createLimitReached) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const json = (await res.json()) as { ok: true; project: ProjectItem } | { error: string };
      if (!res.ok || !("ok" in json)) {
        setError(("error" in json && json.error) || "Couldn't create workspace.");
        return;
      }
      await switchTo(json.project.id, false);
      setName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(projectId: string, refresh = true) {
    if (projectId === "_default") return;
    const res = await fetch("/api/projects/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (!res.ok) {
      setError("Couldn't switch workspace.");
      return;
    }
    if (refresh) router.refresh();
  }

  return (
    <div>
      {/* Create */}
      <div className="ol-panel p-4" style={{ borderRadius: "var(--ol-radius-lg)" }}>
        <div className="bs-micro">Create a workspace</div>
        <p className="mt-1.5 text-[13px] font-medium text-[color:var(--ol-text-primary)]">
          Group connected agents, rules, and evidence by product, environment, or team.
        </p>
        {usageLabel && (
          <p className="mt-2 text-[12px] text-[color:var(--ol-text-secondary)]">{usageLabel}</p>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createWorkspace();
            }}
            placeholder="e.g. Production agents"
            className="product-input sm:max-w-xs"
            disabled={createLimitReached}
          />
          <button
            onClick={() => void createWorkspace()}
            disabled={busy || !name.trim() || createLimitReached}
            className="ol-btn ol-btn--primary shrink-0"
          >
            Create workspace
          </button>
        </div>
        {createLimitReached && (
          <p className="mt-2 text-[12px] text-[color:var(--ol-danger)]" role="alert">
            {workspaceUsage?.message}
          </p>
        )}
        {error && (
          <p className="mt-2 text-[12px] text-[color:var(--ol-danger)]" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* List */}
      <div className="ol-panel mt-4 divide-y divide-[color:var(--ol-border-subtle)] overflow-hidden p-0" style={{ borderRadius: "var(--ol-radius-lg)" }}>
        {list.map((project) => {
          const isActive = project.id === active;
          return (
            <div key={project.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="workspace-switcher-mark">{project.name.charAt(0).toUpperCase()}</span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-[color:var(--ol-text-primary)]">
                    {project.name}
                  </div>
                  <div className="ol-mono text-[10.5px] text-[color:var(--ol-text-faint)]">
                    {project.createdAt ? `Created ${new Date(project.createdAt).toLocaleDateString()}` : "Personal workspace"}
                    {project.description ? ` · ${project.description}` : ""}
                  </div>
                </div>
              </div>
              {isActive ? (
                <span className="ol-lozenge ol-lozenge--active">
                  <span className="ol-lozenge__dot" />
                  Active
                </span>
              ) : (
                <button
                  onClick={() => void switchTo(project.id)}
                  className="ol-btn ol-btn--secondary ol-btn--sm"
                  disabled={busy}
                >
                  Switch
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
