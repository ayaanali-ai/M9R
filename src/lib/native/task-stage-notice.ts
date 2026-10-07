import { renderInboxInjection } from "./inbox-core";
import type { LocalStore } from "./local-store";
import type { WebBrokerClient } from "./web-broker-client";
import { readTaskStagePolicy } from "./task-desktop-stage";
import { isM9rPushedPrompt } from "./codex-delivery-core";

/** Optional stage preparation never turns successful task delivery into a failed delivery. */
export async function prepareTaskStageNotice(root: string, web: WebBrokerClient | undefined, token: string, handle: string, taskId: string, timeoutMs?: number): Promise<string> {
  // Preserve the delivery adapter's call signature; preparation now belongs to
  // the task's explicit tool call, so no transport timeout is consumed here.
  void timeoutMs;
  try {
    if (!readTaskStagePolicy(root).handles.includes(handle)) return "";
    if (!web?.prepareTaskStage) return "M9R task stage unavailable: the owner-launched broker is not connected.";
    // Delivery does not imply desktop isolation. Let the actual task choose its
    // mode rather than silently preparing a background desktop for every prompt.
    return `M9R desktop tools are available for ${taskId}; no desktop has been prepared by delivery. For a cursor visible on the owner's current screen, use m9r_stage_prepare with mode "owner-preview", then m9r_stage_app and m9r_stage_action with that same mode and this task ID. For explicitly requested isolated work use mode "background" instead. Use your own session token and identity. Capture the exact app window before choosing coordinates, then use cursor/click actions; do not substitute the Computer Use pointer. Authorization is checked by each tool. Report tool failures exactly; cursor metadata alone is not visual confirmation.`;
  } catch { return "M9R task stage permission settings could not be read; computer access remains disabled."; }
}

/** Prepare the current session's first approved inbox task before its hook injects that task into the prompt. */
export async function prepareHookInboxTaskStageNotice(input: {
  root: string;
  store: LocalStore;
  web: WebBrokerClient;
  handle: string;
  event: string;
  sessionId?: string;
  cwd?: string;
  prompt?: string;
  timeoutMs?: number;
}): Promise<string> {
  try {
    if (input.event !== "UserPromptSubmit" || !input.sessionId || isM9rPushedPrompt(input.prompt ?? "")) return "";
    const token = input.store.identityTokenFor(input.handle, input.sessionId);
    if (!token) return "";
    const tasks = input.store.tasksForSession(input.handle, input.sessionId);
    const cursor = input.store.cursorFor(input.handle, input.sessionId, input.cwd);
    const injection = renderInboxInjection(tasks, cursor);
    if (!injection.text) return "";
    const task = injection.includedIds
      .map((id) => input.store.getTask(id))
      .find((item) => item && (item.approval === "approved" || item.approval === "not_needed"));
    if (!task) return "";
    return prepareTaskStageNotice(input.root, input.web, token, input.handle, task.id, input.timeoutMs);
  } catch {
    return "";
  }
}
