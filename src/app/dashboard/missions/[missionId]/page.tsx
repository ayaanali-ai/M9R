import Link from "next/link";
import { notFound } from "next/navigation";
import MissionCommandCenter from "@/components/product/MissionCommandCenter";
import { PageHeader } from "@/components/product/WorkspaceUI";
import { getMission, type MissionSummaryDto } from "@/lib/mission/mission-application-service";
import { resolveMissionPrincipalForServerComponent } from "@/lib/mission/mission-principal";
import { MissionApiError } from "@/lib/mission/mission-application-errors";

export const dynamic = "force-dynamic";

export default async function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  const { missionId } = await params;
  const principal = await resolveMissionPrincipalForServerComponent();
  let mission: MissionSummaryDto;
  try {
    mission = await getMission(principal, missionId);
  } catch (error) {
    if (error instanceof MissionApiError && error.code === "mission_not_found") notFound();
    throw error;
  }

  return (
    <>
      <PageHeader
        eyebrow="Mission record"
        title="Mission workspace"
        description="A durable workspace for the objective, its team conversation, and the review record."
        aside={<Link href="/dashboard/agents" className="text-xs font-medium text-[color:var(--ol-accent-text)] hover:underline">← Back to chat</Link>}
      />
      <MissionCommandCenter missionId={missionId} mission={mission} viewerUserId={principal.kind === "human" ? principal.userId : null} />
    </>
  );
}
