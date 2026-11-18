import type { TaskDeliveryMode } from "./multiplayer-task-context";

/**
 * Decide how one action should reach one target. This is intentionally a
 * small policy function: it does not dispatch input or steal focus. The
 * existing computer-use router remains the authority that selects a concrete
 * adapter and validates an owner lease.
 */
export type RequestedDelivery = "auto" | "background" | "visible" | "exclusive";

/** A physical-only operation describes a limitation, never consent to leave background mode. */
export function requestedActionDelivery(background: boolean, confirmedForeground: boolean, needsExclusive: boolean): RequestedDelivery {
  if (confirmedForeground) return "exclusive";
  if (background) return "background";
  return needsExclusive ? "exclusive" : "auto";
}

export interface ActionDeliveryRequest {
  readonly target: { readonly capabilities: readonly string[] };
  readonly requested?: RequestedDelivery;
  readonly targetVisible?: boolean;
  readonly targetBackgroundSafe?: boolean;
  readonly requiresPhysicalInput?: boolean;
  readonly requiresForegroundTurn?: boolean;
  readonly ownerLeaseValid?: boolean;
  readonly allowForegroundEscalation?: boolean;
}

export type ActionDeliveryDecision =
  | { readonly ok: true; readonly mode: TaskDeliveryMode; readonly escalated: boolean;
      readonly authorization: "not-required" | "owner-approval-required" | "owner-lease-held"; readonly reason: string }
  | { readonly ok: false; readonly code: "background-unavailable" | "foreground-lease-required"; readonly reason: string };

function has(target: { readonly capabilities: readonly string[] }, capability: string): boolean {
  return target.capabilities.some((value) => value === capability);
}

/**
 * Background work is semantic/UIA/CDP work. A request never falls back to
 * physical foreground input unless the caller explicitly permits a foreground
 * turn. This planner never grants that turn: the native owner-authorization
 * boundary still has to approve it or observe Agents Free mode.
 */
export function selectActionDelivery(request: ActionDeliveryRequest): ActionDeliveryDecision {
  const requested = request.requested ?? "auto";
  // Only capabilities with a known semantic or per-target implementation
  // qualify. Broad namespace matches used to treat `input.key`, window
  // management and system-global input as background-safe merely because
  // they started with a familiar prefix.
  const backgroundRoute = has(request.target, "observe.screenshot") || has(request.target, "observe.accessibility") || has(request.target, "observe.dom")
    || has(request.target, "input.click.element") || has(request.target, "input.text.insert")
    || has(request.target, "input.text.replace") || has(request.target, "input.scroll.element")
    || has(request.target, "input.menu.invoke") || has(request.target, "menu.invoke") || has(request.target, "clipboard.read")
    || has(request.target, "clipboard.write") || has(request.target, "system.background-api")
    || has(request.target, "system.display-brightness") || has(request.target, "system.output-audio")
    || has(request.target, "system.microphone") || has(request.target, "browser.navigate") || has(request.target, "browser.tabs")
    || has(request.target, "file.save-as") || has(request.target, "presence.cursor")
    || has(request.target, "window.frame.no-activate") || has(request.target, "window.frame");
  const physical = request.requiresPhysicalInput === true;
  const foregroundTurn = request.requiresForegroundTurn === true;
  const backgroundSafe = request.targetBackgroundSafe === true && backgroundRoute && !physical && !foregroundTurn;

  if (requested === "background" || (requested === "auto" && backgroundSafe)) {
    if (backgroundSafe) return { ok: true, mode: "background-semantic", escalated: false, authorization: "not-required", reason: "The selected target exposes a route that does not require global focus." };
    return { ok: false, code: "background-unavailable", reason: "This action explicitly requested background-only delivery, but the target has no safe background route." };
  }

  if (requested === "exclusive" || physical || foregroundTurn) {
    if (request.ownerLeaseValid) return { ok: true, mode: "exclusive-input", escalated: false, authorization: "owner-lease-held", reason: "This action requires the shared OS input device and holds a valid owner lease." };
    if (request.allowForegroundEscalation) return { ok: true, mode: "exclusive-input", escalated: false, authorization: "owner-approval-required",
      reason: "This action requires shared OS input; the explicit request must pass the owner authorization gate before input is sent." };
    return { ok: false, code: "foreground-lease-required", reason: "Shared OS input requires a target-bound owner lease." };
  }

  if (requested === "visible" || request.targetVisible === true) {
    if (backgroundRoute) return { ok: true, mode: "visible-semantic", escalated: false, authorization: "not-required", reason: "The visible target exposes a non-global-input route; pointer movement is not required." };
    if (request.allowForegroundEscalation) return { ok: true, mode: "exclusive-input", escalated: true,
      authorization: request.ownerLeaseValid ? "owner-lease-held" : "owner-approval-required",
      reason: "The visible target lacks a semantic route; the foreground action must pass the owner authorization gate before input is sent." };
    return { ok: false, code: "foreground-lease-required", reason: "The visible target has no semantic route and requires explicit foreground authorization." };
  }

  if (backgroundRoute) return { ok: true, mode: "visible-semantic", escalated: false, authorization: "not-required", reason: "Auto mode selected the target's non-global-input route without taking the physical input device." };
  return { ok: false, code: "background-unavailable", reason: "No safe semantic delivery route is advertised for this target." };
}

