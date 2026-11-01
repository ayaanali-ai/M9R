import type { TaskDeliveryMode } from "./multiplayer-task-context";

/**
 * Decide how one action should reach one target. This is intentionally a
 * small policy function: it does not dispatch input or steal focus. The
 * existing computer-use router remains the authority that selects a concrete
 * adapter and validates an owner lease.
 */
export type RequestedDelivery = "auto" | "background" | "visible" | "exclusive";

export interface ActionDeliveryRequest {
  readonly target: { readonly capabilities: readonly string[] };
  readonly requested?: RequestedDelivery;
  readonly targetVisible?: boolean;
  readonly targetBackgroundSafe?: boolean;
  readonly requiresPhysicalInput?: boolean;
  readonly ownerLeaseValid?: boolean;
  readonly allowForegroundEscalation?: boolean;
}

export type ActionDeliveryDecision =
  | { readonly ok: true; readonly mode: TaskDeliveryMode; readonly escalated: boolean; readonly reason: string }
  | { readonly ok: false; readonly code: "background-unavailable" | "foreground-lease-required"; readonly reason: string };

function has(target: { readonly capabilities: readonly string[] }, capability: string): boolean {
  return target.capabilities.some((value) => value === capability);
}

/**
 * Background work is semantic/UIA/CDP work. A request never falls back to
 * physical foreground input unless the caller explicitly allows escalation
 * and supplies a valid owner lease.
 */
export function selectActionDelivery(request: ActionDeliveryRequest): ActionDeliveryDecision {
  const requested = request.requested ?? "auto";
  const semantic = has(request.target, "observe.accessibility") || has(request.target, "observe.dom")
    || has(request.target, "input.click.element") || has(request.target, "input.text.insert")
    || has(request.target, "input.text.replace") || has(request.target, "input.key");
  const physical = request.requiresPhysicalInput === true;
  const backgroundSafe = request.targetBackgroundSafe === true && semantic && !physical;

  if (requested === "background" || (requested === "auto" && backgroundSafe)) {
    if (backgroundSafe) return { ok: true, mode: "background-semantic", escalated: false, reason: "The target exposes a semantic route that is safe without global focus." };
    if (request.allowForegroundEscalation && request.ownerLeaseValid) return { ok: true, mode: "exclusive-input", escalated: true, reason: "Background delivery was unavailable; the caller explicitly authorized a bounded foreground escalation." };
    return { ok: false, code: "background-unavailable", reason: "The target cannot accept safe background delivery and no explicit foreground escalation was granted." };
  }

  if (requested === "exclusive" || physical) {
    if (request.ownerLeaseValid) return { ok: true, mode: "exclusive-input", escalated: false, reason: "This action requires the shared OS input device and holds a valid owner lease." };
    return { ok: false, code: "foreground-lease-required", reason: "Shared OS input requires a target-bound owner lease." };
  }

  if (requested === "visible" || request.targetVisible === true) {
    if (semantic) return { ok: true, mode: "visible-semantic", escalated: false, reason: "The visible target exposes a semantic route; pointer movement is not required." };
    if (request.allowForegroundEscalation && request.ownerLeaseValid) return { ok: true, mode: "exclusive-input", escalated: true, reason: "The visible target lacks a semantic route; explicit foreground escalation is available." };
    return { ok: false, code: "foreground-lease-required", reason: "The visible target has no semantic route and requires explicit foreground authorization." };
  }

  if (semantic) return { ok: true, mode: "visible-semantic", escalated: false, reason: "Auto mode selected the semantic route without taking the physical input device." };
  return { ok: false, code: "background-unavailable", reason: "No safe semantic delivery route is advertised for this target." };
}

