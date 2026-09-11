import { redirect } from "next/navigation";

/**
 * /dashboard — now an agent command center.
 * ----------------------------------------------------------------------------
 * The hub users land on after login is the agent-focused dashboard. We redirect
 * to /dashboard/agents so connected agents, their runs, submitted sessions,
 * recommended/active rules, and the two-run rule proof are the first thing a
 * user sees. (The legacy cost/waste overview lives under /dashboard/traces.)
 */
export default function DashboardPage() {
  redirect("/dashboard/agents");
}
