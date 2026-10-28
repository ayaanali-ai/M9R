import { z } from "zod";
import {
  checkComputerUseAction,
  computerUseActionRequirements,
  computerUseCapabilitySchema,
  isComputerUseTargetFresh,
  type ComputerUseAction,
  type ComputerUseCapability,
  type ComputerUseTarget,
} from "./computer-use-contract";

const targetKindSchema = z.enum(["desktop", "desktop-window", "browser-chrome", "browser-tab", "browser-frame", "web-element"]);

export const computerUseRouteSchema = z.object({
  routeId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  targetKinds: z.array(targetKindSchema).min(1).max(6)
    .refine((values) => new Set(values).size === values.length, "Route target kinds must be unique."),
  capabilities: z.array(computerUseCapabilitySchema).max(32)
    .refine((values) => new Set(values).size === values.length, "Route capabilities must be unique."),
  priority: z.number().int().min(-1_000).max(1_000).default(0),
  requiresOwnerInputLease: z.boolean().default(false),
}).strict();

export type ComputerUseRouteDescriptor = z.input<typeof computerUseRouteSchema>;
type ParsedRoute = z.output<typeof computerUseRouteSchema>;

/** Constructed only by the owner-controlled approval path, never from agent tool input. */
export interface OwnerAcknowledgedInputLease {
  sessionId: string;
  targetId: string;
  grantedAt: number;
  expiresAt: number;
  visibleNoticeId: string;
}

const ownerInputLeaseSchema = z.object({
  sessionId: z.string().min(1).max(256),
  targetId: z.string().min(1).max(512),
  grantedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  visibleNoticeId: z.string().min(1).max(256),
}).strict().refine((lease) => lease.expiresAt > lease.grantedAt, "Input lease must have a positive lifetime.");

export interface ComputerUseRouteRequest {
  sessionId: string;
  target: ComputerUseTarget;
  action: ComputerUseAction;
  routes: readonly ComputerUseRouteDescriptor[];
  nowMs: number;
  maxObservationAgeMs: number;
  /** The caller persists this per target/task and passes it on later actions. */
  pinnedRouteId?: string;
  /** Trusted owner-UI grant; absent or invalid means no shared OS input. */
  ownerInputLease?: OwnerAcknowledgedInputLease;
}

export type ComputerUseRouteSelection =
  | { ok: true; routeId: string; pinned: boolean }
  | { ok: false; code: "invalid-route-catalog" | "target-mismatch" | "stale-observation" | "unsupported-target-capability" | "no-compatible-route" | "owner-input-lease-required" | "pinned-route-unavailable"; required?: ComputerUseCapability[]; match?: "all" | "any" };

function leaseIsValid(lease: OwnerAcknowledgedInputLease | undefined, request: ComputerUseRouteRequest): boolean {
  if (!lease || !ownerInputLeaseSchema.safeParse(lease).success) return false;
  return lease.sessionId === request.sessionId
    && lease.targetId === request.target.targetId
    && lease.grantedAt <= request.nowMs
    && request.nowMs < lease.expiresAt;
}

function routeSupports(route: ParsedRoute, request: ComputerUseRouteRequest, required: ComputerUseCapability[], match: "all" | "any"): boolean {
  if (!route.targetKinds.includes(request.target.kind)) return false;
  const supports = match === "all"
    ? required.every((capability) => route.capabilities.includes(capability))
    : required.some((capability) => route.capabilities.includes(capability));
  return supports;
}

/**
 * Select a route only when both the observed target and the adapter advertise
 * the required capability. Routes that need the shared OS input device require
 * a live, target- and session-bound owner lease; semantic routes always win.
 */
export function selectComputerUseRoute(request: ComputerUseRouteRequest): ComputerUseRouteSelection {
  if (!isComputerUseTargetFresh(request.target, request.nowMs, request.maxObservationAgeMs)) {
    return { ok: false, code: "stale-observation" };
  }

  const targetCheck = checkComputerUseAction(request.target, request.action);
  if (!targetCheck.ok) {
    if (targetCheck.code === "unsupported-capability") {
      return { ok: false, code: "unsupported-target-capability", required: targetCheck.required, match: targetCheck.match };
    }
    return { ok: false, code: targetCheck.code };
  }

  const parsedRoutes: ParsedRoute[] = [];
  const routeIds = new Set<string>();
  for (const candidate of request.routes) {
    const parsed = computerUseRouteSchema.safeParse(candidate);
    if (!parsed.success || routeIds.has(parsed.data?.routeId ?? "")) return { ok: false, code: "invalid-route-catalog" };
    routeIds.add(parsed.data.routeId);
    parsedRoutes.push(parsed.data);
  }

  const { capabilities: required, match } = computerUseActionRequirements(request.action);
  if (request.pinnedRouteId) {
    const pinned = parsedRoutes.find((route) => route.routeId === request.pinnedRouteId);
    if (!pinned || !routeSupports(pinned, request, required, match)) return { ok: false, code: "pinned-route-unavailable" };
    if (pinned.requiresOwnerInputLease && !leaseIsValid(request.ownerInputLease, request)) {
      return { ok: false, code: "owner-input-lease-required" };
    }
    return { ok: true, routeId: pinned.routeId, pinned: true };
  }

  const compatible = parsedRoutes.filter((route) => routeSupports(route, request, required, match));
  if (compatible.length === 0) return { ok: false, code: "no-compatible-route" };
  const leaseGranted = leaseIsValid(request.ownerInputLease, request);
  const selectable = compatible.filter((route) => !route.requiresOwnerInputLease || leaseGranted);
  if (selectable.length === 0) return { ok: false, code: "owner-input-lease-required" };

  selectable.sort((left, right) => {
    const sharedInputOrder = Number(left.requiresOwnerInputLease) - Number(right.requiresOwnerInputLease);
    if (sharedInputOrder !== 0) return sharedInputOrder;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0;
  });
  return { ok: true, routeId: selectable[0]!.routeId, pinned: false };
}
