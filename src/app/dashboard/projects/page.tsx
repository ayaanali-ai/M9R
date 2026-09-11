import { PageHeader } from "@/components/product/WorkspaceUI";
import ProjectsView from "@/components/product/ProjectsView";
import { getCurrentWorkspacePlanUsage, listProjects } from "@/lib/projects-service";
import { getActiveProjectId } from "@/lib/active-project";

export default async function ProjectsPage() {
  // Best-effort load — never block the page if the query fails.
  const [projects, workspaceUsage] = await Promise.all([
    listProjects().catch(() => []),
    getCurrentWorkspacePlanUsage().catch(() => null),
  ]);
  const activeCookie = await getActiveProjectId();
  const activeProjectId =
    (activeCookie && projects.some((p) => p.id === activeCookie) ? activeCookie : projects[0]?.id) ??
    null;

  return (
    <>
      <PageHeader
        eyebrow="Registry"
        title="Workspaces"
        description="Create, switch, and manage the workspaces your evidence and rules live in."
      />
      <div className="mt-7">
        <ProjectsView
          projects={projects}
          activeProjectId={activeProjectId}
          workspaceUsage={workspaceUsage}
        />
      </div>
    </>
  );
}
