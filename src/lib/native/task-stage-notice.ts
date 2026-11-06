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
    return `M9R desktop tools are available for ${taskId}; task delivery has not started desktop work. Use m9r_stage_app, m9r_stage_action, m9r_computer_action, and m9r_computer_observe as appropriate for computer interaction. Choose an efficient route from the user's goal and the current observation; no app-specific action sequence is required. When an app-launch action returns the selected window or a capture, continue from that exact result instead of assuming the app was already open or opening a duplicate window. Preserve existing windows and tabs unless the user asks to change them.

The normal mode is "owner-preview" on the owner's real Windows desktop. It may bring the selected window to the foreground when an action requires physical input. "background" is an M9R routing mode for operations supported without taking owner focus; it maps to windows on the same Windows desktop and never creates or switches a Windows virtual desktop. If an operation needs foreground input, select owner-preview for that operation rather than retrying the same background action indefinitely. Use view "app" for the selected app window and view "desktop" for desktop-wide inspection or interaction. Use current UI structure/references when they expose the target; use the latest screenshot coordinates when needed, and refresh observation after relevant UI changes.

For a requested resize, move, minimize, restore, or dock, keep acting on the already-selected window instead of launching the app again. Read window_status for its current state and (when it is not minimized) frame; desktop structure also exposes each window's screenRect in absolute virtual-screen coordinates, while rect stays screenshot-local for clicks. Restore a minimized window before relying on its frame. Use window_frame with explicit screen bounds or snap for standard monitor placement, then trust only the returned actual frame/status when reporting where the window ended up. An app may impose minimum or maximum sizing, which is surfaced as a partial geometry result rather than silently treated as an exact match.

Treat dispatch outcomes according to their typed result. A DesktopInputNotDispatchedError or StageInputNotDispatchedError means the input was not sent and may be reconsidered after observing current state. An unknown or uncertain outcome does not prove that input was withheld: observe and reconcile the UI before deciding whether to continue, and never blindly replay a possibly delivered action. A fresh capture by itself does not establish whether the preceding input was sent. Verify visible postconditions; a successful OS input call alone is not proof that the application accepted the action.

Keep using the exact app window returned by m9r_stage_app through the task; a dialog opening or closing does not authorize launching a second app instance. After a dialog changes or disappears, capture the selected app and its currently owned popups again, then plan against that fresh state rather than reusing a popup reference. Before transferring a calculated value, independently evaluate the user's exact expression and compare it with a fresh read of the source display; correct and recheck the source if they differ. Verify the destination separately after entry. If a fresh app structure marks the exact control canReadValue, m9r_stage_action read_value reads only that selected non-password UI Automation value without focusing or changing the control; otherwise use a fresh structure or capture and report when the value cannot be established.

For goals that depend on a comparison such as latest, newest, or most recent, identify the requested item and compare its displayed dates or timestamps from the authoritative source when available; search rank and first-visible position alone are not proof. Gather only enough fresh evidence to decide, and stop searching once the comparison is established. For requested playback or another media state, verify that the requested item itself is active; an ad, preview, loading state, or unrelated queued item does not satisfy it. Report the observed title/date and distinguish verified results from missing evidence.

For an exact-path save, use m9r_stage_action with the app view and a save_as action containing one absolute Windows file path instead of composing a folder path and basename through raw typing. Set createParentDirectories to true only when the requested destination includes a folder that needs to be created. Set replaceExisting to true only when the user authorized replacing that exact file. The action resolves the current app-owned Save As dialog and reports whether the exact path exists after the dialog closes; that proves path persistence only, not the document's contents. When a task asks for a new note/document, create a new document in the app and leave already-open documents intact. After saving, reopen the exact requested file and compare its contents or visible output with the requested result before reporting success. If the dialog is custom or does not expose one unambiguous accessible File name field and Save control, stop and inspect it rather than typing a directory into the document or guessing at coordinates. A save-dialog click or a closed dialog alone does not prove the file was saved correctly.

For long lists and scrollable app regions, inspect the current structure and scroll state first. When a visible element exposes the UI Automation scroll action, use scroll_element against that current ref with the default small increment, then re-read structure and visible content before moving again. Use a large increment only when the user requests a broad jump. Track direction and already checked ranges, stop when the requested items are found, and do not repeatedly return to the top or bottom without new evidence. If no semantic scroll pattern is exposed, use an ordinary one-notch scroll and inspect its fresh capture before continuing.

An explicit owner task authorizes the ordinary actions it names on the identified target across apps and websites; do not refuse them because unrelated content exists elsewhere in the same app. Re-observe when the actual target is stale or multiple actionable targets are genuinely indistinguishable, rather than treating the mere presence of other windows or tabs as ambiguity. Purchases and other money-moving actions require owner approval. For deletion, verify the exact named target and confirm the result.`;
  } catch { return "M9R task stage permission settings could not be read; computer access remains disabled."; }
}

/** Add the native stage contract to an already-claimed OpenCode poll envelope. */
export function addOpenCodeTaskStageNotice(context: string, stageNotice: string): string {
  if (!stageNotice) return context;
  try {
    const parsed: unknown = JSON.parse(context);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return context;
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope.prompt !== "string" || envelope.prompt.length === 0) return context;
    return JSON.stringify({ ...envelope, prompt: `${stageNotice}\n\n${envelope.prompt}` });
  } catch {
    // A malformed provider envelope must remain untouched; the poller will
    // reject it rather than receiving a partially rewritten task.
    return context;
  }
}

/** Prepare the current session's first approved inbox task before its hook injects that task into the prompt. */
export async function prepareHookInboxTaskStageNotice(input: {
  root: string;
  store: LocalStore;
  web: WebBrokerClient;
  handle: string;
  provider: string;
  event: string;
  /** SessionStart auto-delivery is enabled by the provider hook that owns that transport. */
  autoDeliverOnSessionStart?: boolean;
  sessionId?: string;
  cwd?: string;
  prompt?: string;
  timeoutMs?: number;
}): Promise<string> {
  try {
    const isPromptDelivery = input.event === "UserPromptSubmit";
    const isSessionStartDelivery = input.event === "SessionStart" && input.autoDeliverOnSessionStart === true;
    if ((!isPromptDelivery && !isSessionStartDelivery) || !input.sessionId) return "";
    if (isPromptDelivery && isM9rPushedPrompt(input.prompt ?? "")) return "";
    // SessionStart is evaluated before handleHookEvent issues the identity for
    // a genuinely new provider session. Bootstrap the same exact-session
    // identity here so the first delivered task gets its native desktop
    // contract too. An explicitly revoked session remains fail-closed; this
    // is not a discovery or recovery path.
    let token = input.store.identityTokenFor(input.handle, input.sessionId);
    if (!token && isSessionStartDelivery && !input.store.identityWasRevoked(input.handle, input.sessionId)) {
      token = input.store.issueIdentity(input.handle, input.provider, input.sessionId).token;
    }
    if (!token) return "";
    const tasks = input.store.tasksForSession(input.handle, input.sessionId);
    const cursor = input.store.cursorFor(input.handle, input.sessionId, input.cwd);
    // Match the trusted provider-delivery path: pending owner approvals must
    // remain at the frontier and must not cause a stage notice for later work.
    const injection = renderInboxInjection(tasks, cursor, { includePending: false, items: 1 });
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
