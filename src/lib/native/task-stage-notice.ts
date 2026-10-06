import type { WebBrokerClient } from "./web-broker-client";
import { readTaskStagePolicy } from "./task-desktop-stage";

/** Optional stage preparation never turns successful task delivery into a failed delivery. */
export async function prepareTaskStageNotice(root: string, web: WebBrokerClient | undefined, token: string, handle: string, taskId: string): Promise<string> {
  try {
    if (!readTaskStagePolicy(root).handles.includes(handle)) return "";
    if (!web?.prepareTaskStage) return "M9R task stage unavailable: the owner-launched broker is not connected.";
    const result = await web.prepareTaskStage(token, taskId);
    if (!result.ok) return `M9R task stage unavailable: ${(result.error ?? "preparation failed").slice(0, 240)}`;
    const stage = result.stage as { name?: unknown; controlEnabled?: unknown; approvedApps?: unknown } | undefined;
    if (!stage || typeof stage.name !== "string" || !/^agent-[a-f0-9]{24}$/.test(stage.name)) return "M9R task stage returned an invalid response.";
    const appIds = Array.isArray(stage.approvedApps) ? stage.approvedApps.filter((id): id is string => typeof id === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(id)).slice(0, 16) : [];
    return `M9R prepared your Windows virtual desktop ${stage.name} for ${taskId}. It has not switched the owner's desktop. ${stage.controlEnabled === true
      ? `Owner-authorized stage control is enabled. Use m9r_stage_app to launch an approved app ID (${appIds.join(", ") || "none configured"}), m9r_stage_action to inspect/control its exact window, then discard only after preserving your result. Verify effects: posted input does not prove success.`
      : "Computer control is not enabled; the owner must grant it separately. Desktop preparation alone does not prove an app is running."}`;
  } catch { return "M9R task stage permission settings could not be read; computer access remains disabled."; }
}
