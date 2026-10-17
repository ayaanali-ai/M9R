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
    return `M9R desktop tools are available for ${taskId}; delivery has not started desktop work. Use only M9R's own tools (m9r_stage_app / m9r_stage_action / m9r_computer_action / m9r_computer_observe) for every part of this task -- never your own provider's built-in computer-use, screenshot-automation, or any other non-M9R automation capability, even as a fallback after an M9R action fails or errors. If an M9R action fails, retry it or report the failure plainly; do not switch to a different automation system to work around it. The default and normal task mode is owner-preview: prepare with mode "owner-preview", then pass that same mode on every m9r_stage_action call. This is a desktop-wide view of the desktop the owner is currently using: Use m9r_stage_app to open a normal installed app or restore the existing personal browser without a separate profile or extra browser window. If the task specifically asks for icon clicking, use the labeled cursor on its visible desktop icon, taskbar icon, or Start menu; double-click a desktop shortcut. After m9r_stage_app selects an app, use view "app" on actions to capture and control that exact app window without relying on owner focus; view "desktop" remains available for desktop icons and other windows. Use coordinates from the latest capture for clicks, typing, scrolling, dragging, and keys; capture again after any screen change. Use mode "background" only when the task explicitly asks for an isolated Windows desktop. Approval remains required for money-like controls. Verify effects in the returned capture; a posted input is not proof of success.`;
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
