import { notFound } from "next/navigation";
import { Suspense } from "react";
import ConversationPanel from "@/components/product/ConversationPanel";
import ProductShell from "@/components/product/ProductShell";

/** Browser-test harness for the REAL shell. Tests intercept APIs with fixtures.
 * No authentication override, server fixture data, or production availability. */
export default function DashboardRuntimeBench() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <div className="wf-root" data-bs-mode="day"><Suspense>
    <ProductShell displayName="Local test" onboardingCompleted>
      <div className="wf-atmosphere"><div><div className="wf-board"><div className="wf-layout"><div className="wf-main">
        <ConversationPanel agents={[]} workspaceId={null} viewerUserId="preview-user" />
      </div></div></div></div></div>
    </ProductShell>
  </Suspense></div>;
}
