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
const ONBOARDING_ROLLOUT_AT = Date.parse("2026-07-15T00:00:00Z");

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
  const [{ data: identity }, { data: settings }] = reviewerDemo
    ? [{ data: null }, { data: null }]
    : await Promise.all([
        supabase.from("users").select("username").eq("id", user.id).maybeSingle(),
        supabase.from("user_settings").select("walkthrough_completed").eq("user_id", user.id).maybeSingle(),
      ]);
  const username = (identity?.username as string | null) ??
    (user.user_metadata?.username as string | undefined) ?? null;
  const activeCookie = reviewerDemo ? null : await getActiveProjectId();
  // Resolve the workspace before loading any connection-scoped navigation
  // data. Querying agent connections first made it possible for a stale or
  // missing workspace cookie to surface another workspace's live agents.
  const projects = reviewerDemo ? [] : await listProjects().catch(() => []);
  // Resolve the active workspace: the cookie if still valid, else the first project.
  const activeProjectId =
    (activeCookie && projects.some((p) => p.id === activeCookie) ? activeCookie : projects[0]?.id) ??
    null;
  const [workspaceUsage, agentStatus] = reviewerDemo
    ? [null, { byKey: {}, agents: [] }]
    : await Promise.all([
        getCurrentWorkspacePlanUsage().catch(() => null),
        loadAgentStatusSummary(activeProjectId).catch(() => ({ byKey: {}, agents: [] })),
      ]);

  return (
    <div className={`${wfMono.variable} wf-root contents`} data-bs-mode="day" suppressHydrationWarning>
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
        onboardingCompleted={Boolean(settings?.walkthrough_completed)}
        onboardingAutoStart={
          !settings?.walkthrough_completed && Date.parse(user.created_at) >= ONBOARDING_ROLLOUT_AT
        }
      >
        {children}
      </ProductShell>
    </div>
  );
}
