import { redirect } from "next/navigation";
import { JetBrains_Mono } from "next/font/google";
import ProductShell from "@/components/product/ProductShell";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspacePlanUsage, listProjects } from "@/lib/projects-service";
import { getActiveProjectId } from "@/lib/active-project";
import { isReviewerDemoAppMetadata } from "@/lib/reviewer-demo-access";
import { loadAgentStatusSummary } from "@/lib/agent-status-summary";
import WatchfloorModeScript from "@/components/product/WatchfloorModeScript";

export const dynamic = "force-dynamic";

/**
 * Watchfloor type system (design constitution — see DESIGN.md):
 *  - ONE sans (Geist, from the root layout) does everything, Linear-style:
 *    titles are just the same face bigger and tighter (--wf-display maps to
 *    it in globals.css). Space Grotesk is retired.
 *  - JetBrains Mono: instrument voice — ids, telemetry, timestamps, tables.
 */
const wfMono = JetBrains_Mono({
  variable: "--wf-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  if (!supabase) redirect("/auth");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth");

  const reviewerDemo = isReviewerDemoAppMetadata(user.app_metadata);
  // These three are mutually independent -- identity/settings only need
  // user.id, the active-project cookie read has no DB dependency at all,
  // and listProjects() is scoped by the authenticated session, not by
  // anything the other two produce. They used to run as three sequential
  // awaits; only activeProjectId (below) and the workspace-scoped pair
  // after it have a real dependency to wait on.
  const [{ data: identity }, activeCookie, projects] = reviewerDemo
    ? [{ data: null }, null, []]
    : await Promise.all([
        supabase.from("users").select("username").eq("id", user.id).maybeSingle(),
        getActiveProjectId(),
        listProjects().catch(() => []),
      ]);
  const username = (identity?.username as string | null) ??
    (user.user_metadata?.username as string | undefined) ?? null;
  // Resolve the active workspace: the cookie if still valid, else the first project.
  const activeProjectId =
    (activeCookie && projects.some((p) => p.id === activeCookie) ? activeCookie : projects[0]?.id) ??
    null;
  // agentStatus must wait for activeProjectId to be resolved above -- querying
  // agent connections before the workspace is known made it possible for a
  // stale or missing workspace cookie to surface another workspace's live
  // agents. workspaceUsage has the same real dependency.
  const [workspaceUsage, agentStatus] = reviewerDemo
    ? [null, { byKey: {}, agents: [] }]
    : await Promise.all([
        getCurrentWorkspacePlanUsage().catch(() => null),
        loadAgentStatusSummary(activeProjectId).catch(() => ({ byKey: {}, agents: [] })),
      ]);

  return (
    // data-m9r-app-shell: an explicit marker the browser extension checks before mounting its own floating presence
    // overlay (the pill, the dock). The dashboard already has its own in-page chat, composer and @mention menu; the
    // overlay has nothing to add here and was confirmed to sit above the @mention menu at a higher z-index, catching
    // its clicks. See extensions/browser/src/content.js.
    <div className={`${wfMono.variable} wf-root contents`} data-bs-mode="night" data-m9r-app-shell suppressHydrationWarning>
      {/* Pre-paint: restore the persisted Watchfloor mode before first render
          so Night Watch users never see a bone flash. Uses the supported
          pre-hydration InlineScript pattern; raw scripts warn on soft nav. */}
      <WatchfloorModeScript />
      <ProductShell
        displayName={reviewerDemo ? "YC reviewer" : username ? `@${username}` : "Set username"}
        projects={projects}
        activeProjectId={activeProjectId}
        workspaceUsage={workspaceUsage}
        agentStatus={agentStatus}
        reviewerDemo={reviewerDemo}
      >
        {children}
      </ProductShell>
    </div>
  );
}
