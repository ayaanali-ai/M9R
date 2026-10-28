import { z } from "zod";
import {
  parseComputerUseTarget,
  type ComputerUseTarget,
} from "./computer-use-contract";
import { computerUseRouteSchema, type ComputerUseRouteDescriptor } from "./computer-use-router";

export const SURFACE_CAPABILITY_LEVELS = [
  "browser-cdp",
  "ui-automation",
  "document-application",
  "visual-physical",
] as const;

export type SurfaceCapabilityLevel = (typeof SURFACE_CAPABILITY_LEVELS)[number];
export type SurfaceTargetKind = ComputerUseTarget["kind"];

const surfaceIdSchema = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_.:%-]+$/);
const adapterIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const availabilitySchema = z.enum(["implemented", "configured", "unavailable"]);
const targetKindSchema = z.enum(["desktop", "desktop-window", "browser-chrome", "browser-tab", "browser-frame", "web-element"]);

export const surfaceAdapterDescriptorSchema = z.object({
  adapterId: adapterIdSchema,
  level: z.enum(SURFACE_CAPABILITY_LEVELS),
  routeId: adapterIdSchema,
  targetKinds: z.array(targetKindSchema).min(1).max(6).refine((values) => new Set(values).size === values.length, "Surface target kinds must be unique."),
  priority: z.number().int().min(-1_000).max(1_000),
  availability: availabilitySchema,
}).strict();

export type SurfaceAdapterDescriptor = z.infer<typeof surfaceAdapterDescriptorSchema>;

export interface M9RSurfaceBinding {
  readonly surfaceId: string;
  readonly adapterId: string;
  readonly level: SurfaceCapabilityLevel;
  readonly target: ComputerUseTarget;
  /** This route is the existing M9R broker route; it is not the old extension UI. */
  readonly route: ComputerUseRouteDescriptor;
}

export interface M9RSurfaceAdapter extends SurfaceAdapterDescriptor {
  canHandle(target: ComputerUseTarget): boolean;
  bind(surfaceId: string, target: ComputerUseTarget): M9RSurfaceBinding;
}

export type SurfaceAdapterResolveResult =
  | { readonly ok: true; readonly adapter: M9RSurfaceAdapter }
  | { readonly ok: false; readonly error: string };

export type SurfaceBindingResult =
  | { readonly ok: true; readonly binding: M9RSurfaceBinding }
  | { readonly ok: false; readonly error: string };

export interface M9RSurfaceAdapterCatalog {
  register(adapter: M9RSurfaceAdapter): void;
  resolve(target: ComputerUseTarget, preferredAdapterId?: string): SurfaceAdapterResolveResult;
  bind(surfaceId: string, target: ComputerUseTarget, preferredAdapterId?: string): SurfaceBindingResult;
  descriptors(): readonly SurfaceAdapterDescriptor[];
}

export interface CreateSurfaceAdapterOptions {
  readonly adapterId: string;
  readonly level: SurfaceCapabilityLevel;
  readonly routeId: string;
  readonly targetKinds: readonly SurfaceTargetKind[];
  readonly priority?: number;
  readonly availability?: z.input<typeof availabilitySchema>;
}

/**
 * Build one surface adapter descriptor over the existing Computer Use target
 * contract. It selects a route; it never launches a browser, focuses a
 * window, or dispatches input by itself.
 */
export function createM9RSurfaceAdapter(options: CreateSurfaceAdapterOptions): M9RSurfaceAdapter {
  const descriptor = surfaceAdapterDescriptorSchema.parse({
    adapterId: options.adapterId,
    level: options.level,
    routeId: options.routeId,
    targetKinds: options.targetKinds,
    priority: options.priority ?? 0,
    availability: options.availability ?? "implemented",
  });
  return {
    ...descriptor,
    canHandle(target) {
      return descriptor.availability !== "unavailable" && descriptor.targetKinds.includes(target.kind);
    },
    bind(surfaceId, target) {
      const parsedSurfaceId = surfaceIdSchema.parse(surfaceId);
      const parsedTarget = parseComputerUseTarget(target);
      if (!this.canHandle(parsedTarget)) throw new Error(`Surface adapter ${descriptor.adapterId} cannot handle ${parsedTarget.kind}.`);
      const route = computerUseRouteSchema.parse({
        routeId: descriptor.routeId,
        targetKinds: [parsedTarget.kind],
        capabilities: parsedTarget.capabilities,
        priority: descriptor.priority,
        requiresOwnerInputLease: false,
      });
      return { surfaceId: parsedSurfaceId, adapterId: descriptor.adapterId, level: descriptor.level, target: parsedTarget, route };
    },
  };
}

export function createM9RSurfaceAdapterCatalog(adapters: readonly M9RSurfaceAdapter[] = [
  /** Existing broker-owned browser/CDP route; no extension UI is revived. */
  createM9RSurfaceAdapter({
    adapterId: "m9r-browser-cdp",
    level: "browser-cdp",
    routeId: "m9r-browser-broker",
    targetKinds: ["browser-chrome", "browser-tab", "browser-frame", "web-element"],
    priority: 100,
  }),
  /** Existing owner-launched desktop-stage/UIA route. */
  createM9RSurfaceAdapter({
    adapterId: "m9r-ui-automation",
    level: "ui-automation",
    routeId: "m9r-desktop-stage",
    targetKinds: ["desktop", "desktop-window"],
    priority: 50,
  }),
]): M9RSurfaceAdapterCatalog {
  const byId = new Map<string, M9RSurfaceAdapter>();
  const catalog: M9RSurfaceAdapterCatalog = {
    register(adapter) {
      if (byId.has(adapter.adapterId)) throw new Error(`Surface adapter is already registered: ${adapter.adapterId}`);
      surfaceAdapterDescriptorSchema.parse(adapter);
      byId.set(adapter.adapterId, adapter);
    },
    resolve(target, preferredAdapterId) {
      const parsedTarget = parseComputerUseTarget(target);
      if (preferredAdapterId) {
        const preferred = byId.get(preferredAdapterId);
        if (!preferred || !preferred.canHandle(parsedTarget)) return { ok: false, error: "preferred surface adapter is unavailable for this target" };
        return { ok: true, adapter: preferred };
      }
      const compatible = [...byId.values()].filter((adapter) => adapter.canHandle(parsedTarget));
      compatible.sort((left, right) => right.priority - left.priority || left.adapterId.localeCompare(right.adapterId));
      const adapter = compatible[0];
      return adapter ? { ok: true, adapter } : { ok: false, error: `no M9R surface adapter can handle ${parsedTarget.kind}` };
    },
    bind(surfaceId, target, preferredAdapterId) {
      const resolved = catalog.resolve(target, preferredAdapterId);
      if (!resolved.ok) return resolved;
      try { return { ok: true, binding: resolved.adapter.bind(surfaceId, target) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "surface binding failed" }; }
    },
    descriptors() {
      return [...byId.values()].map(({ canHandle: _canHandle, bind: _bind, ...descriptor }) => descriptor);
    },
  };
  for (const adapter of adapters) catalog.register(adapter);
  return catalog;
}
