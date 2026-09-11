import { PageHeader } from "@/components/product/WorkspaceUI";
import MemoryView from "@/components/product/MemoryView";

/**
 * Memory — the merged home for what used to be two screens, Findings
 * (/dashboard/findings) and Workspace Rules (/dashboard/workspace-rules), both
 * now deleted. One loop, one place: an agent flags something, a human confirms
 * it, every agent carries it into the next run.
 *
 * The view is a client component because both of its sources are cookie/RLS
 * GETs it already owns -- the same component backs the Agent Workspace's Memory
 * drawer, so the two surfaces cannot drift.
 */
export default function MemoryPage() {
  return (
    <div className="product-page-shell">
      <PageHeader
        eyebrow="Workspace"
        title="Memory"
        description="What this workspace has learned and asks every agent to remember."
      />
      <div className="mt-7">
        <MemoryView />
      </div>
    </div>
  );
}
