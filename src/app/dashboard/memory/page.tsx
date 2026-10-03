import { PageHeader } from "@/components/product/WorkspaceUI";
import MemoryView from "@/components/product/MemoryView";

/** Memory: facts and decisions the team saved. People and agents both write here; agents keep their own memory and rules. */
export default function MemoryPage() {
  return (
    <div className="product-page-shell">
      <PageHeader
        title="Memory"
        description="Facts and decisions your team saved, shared with every agent in the workspace."
      />
      <div className="mt-7">
        <MemoryView />
      </div>
    </div>
  );
}
