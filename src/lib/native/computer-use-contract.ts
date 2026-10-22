import { z } from "zod";

/**
 * Provider-neutral wire contract shared by native desktop, browser-chrome,
 * and website routes. Target-specific metadata stays opaque to callers.
 */

const opaqueRef = z.string().min(1).max(512);
const observationRevision = z.string().min(1).max(128);
const timestampMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const computerUseCapabilitySchema = z.enum([
  "observe.screenshot",
  "observe.accessibility",
  "observe.dom",
  "input.click.element",
  "input.click.point",
  "input.click.middle",
  "input.click.right",
  "input.click.double.element",
  "input.click.double.point",
  "input.text.insert",
  "input.text.replace",
  "input.key",
  "input.select-text.all",
  "input.select-text.text",
  "input.scroll.pixel.horizontal",
  "input.scroll.pixel.vertical",
  "input.scroll.line.horizontal",
  "input.scroll.line.vertical",
  "input.scroll.page.horizontal",
  "input.scroll.page.vertical",
  "input.drag",
  "input.drag.duration",
  "input.focus",
  "input.shared-os",
  "browser.navigate",
  "window.frame",
  "window.state",
  "menu.invoke",
  "clipboard.read",
  "clipboard.write",
]);

const targetIdentity = {
  targetId: opaqueRef,
  revision: observationRevision,
  observedAt: timestampMs,
  capabilities: z.array(computerUseCapabilitySchema).max(32)
    .refine((values) => new Set(values).size === values.length, "Target capabilities must be unique."),
};

/** A target is a snapshot-scoped identity, not a display name or raw coordinate. */
export const computerUseTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    ...targetIdentity,
    kind: z.literal("desktop"),
  }).strict(),
  z.object({
    ...targetIdentity,
    kind: z.literal("desktop-window"),
    windowRef: opaqueRef,
    processId: z.number().int().min(1).max(0xffff_ffff).optional(),
  }).strict(),
  z.object({
    ...targetIdentity,
    kind: z.literal("browser-chrome"),
    browserInstanceId: opaqueRef.optional(),
  }).strict(),
  z.object({
    ...targetIdentity,
    kind: z.literal("browser-tab"),
    browserInstanceId: opaqueRef.optional(),
    tabId: opaqueRef.optional(),
    url: z.string().max(4096).optional(),
  }).strict(),
  z.object({
    ...targetIdentity,
    kind: z.literal("browser-frame"),
    browserInstanceId: opaqueRef.optional(),
    tabId: opaqueRef.optional(),
    frameId: opaqueRef.optional(),
    origin: z.string().max(2048).optional(),
  }).strict(),
  z.object({
    ...targetIdentity,
    kind: z.literal("web-element"),
    browserInstanceId: opaqueRef.optional(),
    tabId: opaqueRef.optional(),
    frameId: opaqueRef.optional(),
    documentId: opaqueRef.optional(),
    snapshotId: opaqueRef,
    elementRef: opaqueRef,
  }).strict(),
]);

const coordinate = z.number().int().min(-65_536).max(65_535);
const pointLocatorSchema = z.object({
  kind: z.literal("point"),
  x: coordinate,
  y: coordinate,
  coordinateSpace: z.enum(["target-local", "desktop-screen", "page-viewport"]),
}).strict().superRefine((point, context) => {
  if (point.coordinateSpace !== "desktop-screen" && (point.x < 0 || point.y < 0 || point.x > 16_383 || point.y > 16_383)) {
    context.addIssue({ code: "custom", path: ["coordinateSpace"], message: "Local and viewport coordinates must be nonnegative and within the captured target." });
  }
});

export const computerUseLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("element"), ref: opaqueRef, snapshotId: opaqueRef }).strict(),
  pointLocatorSchema,
]);

const textValue = z.string().min(1).max(5_000)
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/, "Text contains unsupported control characters.");
const navigationUrl = z.string().max(4096).url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Navigation only accepts HTTP or HTTPS URLs.");

export const computerUsePostconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url-equals"), url: navigationUrl }).strict(),
  z.object({ kind: z.literal("visible-text-contains"), text: textValue }).strict(),
  z.object({
    kind: z.literal("accessible-control-present"),
    role: z.string().min(1).max(80).optional(),
    label: z.string().min(1).max(160).optional(),
  }).strict(),
]).superRefine((condition, context) => {
  if (condition.kind === "accessible-control-present" && condition.role === undefined && condition.label === undefined) {
    context.addIssue({ code: "custom", path: ["label"], message: "Match an accessible control by role, label, or both." });
  }
});

const actionEnvelope = {
  operationId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
  targetId: opaqueRef,
  /** Binds the request to the exact observation used to plan it. */
  targetRevision: observationRevision,
  /** Optional generic postcondition. Only a fresh observable match can produce a verified result. */
  postcondition: computerUsePostconditionSchema.optional(),
};

export const computerUseActionSchema = z.discriminatedUnion("kind", [
  z.object({ ...actionEnvelope, kind: z.literal("observe") }).strict(),
  z.object({ ...actionEnvelope, kind: z.literal("focus") }).strict(),
  z.object({
    ...actionEnvelope,
    kind: z.literal("click"),
    locator: computerUseLocatorSchema,
    button: z.enum(["left", "middle", "right"]).default("left"),
    count: z.union([z.literal(1), z.literal(2)]).default(1),
    // Explicit per-action foreground delivery is an owner-authorized rung,
    // not an automatic retry or standing mode. It requires input.shared-os
    // to be advertised by the exact desktop-window target.
    confirmFocusForeground: z.boolean().optional(),
  }).strict().superRefine((action, context) => {
    if (action.count === 2 && action.button !== "left") {
      context.addIssue({ code: "custom", path: ["button"], message: "Double-click is defined as two left-button activations." });
    }
  }),
  z.object({
    ...actionEnvelope,
    kind: z.literal("text"),
    /** insert preserves existing content; replace explicitly replaces the field value. */
    mode: z.enum(["insert", "replace"]),
    text: textValue,
    /** Browser routes require an explicit fresh field ref; desktop routes may use current caret focus. */
    locator: computerUseLocatorSchema.optional(),
    confirmFocusForeground: z.boolean().optional(),
  }).strict().superRefine((action, context) => {
    if (action.confirmFocusForeground && action.mode !== "insert") {
      context.addIssue({ code: "custom", path: ["confirmFocusForeground"], message: "Foreground delivery is only valid for caret insertion, not whole-field replacement." });
    }
  }),
  z.object({
    ...actionEnvelope,
    kind: z.literal("key"),
    key: z.string().min(1).max(32).regex(/^[\w-]+$/),
    modifiers: z.array(z.enum(["Control", "Alt", "Shift", "Meta"])).max(3)
      .refine((values) => new Set(values).size === values.length, "Key modifiers must be unique.").optional(),
    confirmFocusForeground: z.boolean().optional(),
  }).strict(),
  z.object({
    ...actionEnvelope,
    kind: z.literal("select_text"),
    locator: computerUseLocatorSchema,
    selection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("all") }).strict(),
      z.object({ kind: z.literal("text"), text: textValue, occurrence: z.number().int().min(0).max(100).optional() }).strict(),
    ]),
  }).strict(),
  z.object({
    ...actionEnvelope,
    kind: z.literal("scroll"),
    unit: z.enum(["pixel", "line", "page"]),
    deltaX: z.number().int().min(-16_383).max(16_383),
    deltaY: z.number().int().min(-16_383).max(16_383),
    at: computerUseLocatorSchema.optional(),
    // One explicit foreground delivery for this one scroll action.
    confirmFocusForeground: z.boolean().optional(),
  }).strict().superRefine((action, context) => {
    if (action.deltaX === 0 && action.deltaY === 0) {
      context.addIssue({ code: "custom", path: ["deltaY"], message: "Scroll must move at least one axis." });
    }
    if (action.deltaX !== 0 && action.deltaY !== 0) {
      context.addIssue({ code: "custom", path: ["deltaY"], message: "Use one axis per scroll operation so each dispatch and its effect can be reconciled independently." });
    }
  }),
  z.object({
    ...actionEnvelope,
    kind: z.literal("drag"),
    from: computerUseLocatorSchema,
    to: computerUseLocatorSchema,
    durationMs: z.number().int().min(1).max(10_000).optional(),
    confirmFocusForeground: z.boolean().optional(),
  }).strict().superRefine((action, context) => {
    if (action.from.kind === "point" && action.to.kind === "point"
      && action.from.coordinateSpace !== action.to.coordinateSpace) {
      context.addIssue({ code: "custom", path: ["to", "coordinateSpace"], message: "A point drag must use one coordinate frame." });
    }
  }),
  z.object({ ...actionEnvelope, kind: z.literal("navigate"), url: navigationUrl }).strict(),
  z.object({ ...actionEnvelope, kind: z.literal("window_frame"), x: coordinate, y: coordinate,
    width: z.number().int().min(1).max(16383), height: z.number().int().min(1).max(16383) }).strict(),
  z.object({ ...actionEnvelope, kind: z.literal("window_state"), state: z.enum(["minimized", "maximized", "restored"]) }).strict(),
  z.object({ ...actionEnvelope, kind: z.literal("invoke_menu"), path: z.array(z.string().trim().min(1).max(160)).min(1).max(16) }).strict(),
  z.object({ ...actionEnvelope, kind: z.literal("clipboard"), mode: z.enum(["read", "write"]), includeText: z.boolean().optional(),
    text: z.string().min(1).max(500).optional(), confirmSharedClipboard: z.literal(true).optional() }).strict().superRefine((action, context) => {
      if ((action.mode === "write" || action.includeText) && !action.confirmSharedClipboard) context.addIssue({ code: "custom", path: ["confirmSharedClipboard"],
        message: "Shared clipboard text access requires explicit confirmation." });
      if (action.mode === "write" && (!action.text || action.includeText !== undefined) || action.mode === "read" && action.text !== undefined) {
        context.addIssue({ code: "custom", path: ["mode"], message: "Clipboard read and write have distinct semantics." });
      }
    }),
]);

export const computerUseResultSchema = z.object({
  operationId: opaqueRef,
  targetId: opaqueRef,
  routeId: opaqueRef.optional(),
  dispatchStatus: z.enum(["not-dispatched", "dispatched", "unknown"]),
  effectStatus: z.enum(["not-checked", "observed", "verified", "mismatch", "unknown"]),
  operationReceipt: z.object({
    status: z.enum(["in_progress", "applied", "uncertain"]),
    updatedAt: z.string().datetime().optional(),
  }).strict().optional(),
  observation: z.object({
    revision: observationRevision,
    observedAt: timestampMs,
    evidenceRef: opaqueRef,
  }).strict().optional(),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_000),
    retry: z.enum(["never", "same-operation-id", "refresh-target", "new-operation-id"]),
  }).strict().optional(),
}).strict().superRefine((result, context) => {
  if (["observed", "verified", "mismatch"].includes(result.effectStatus) && !result.observation) {
    context.addIssue({ code: "custom", path: ["observation"], message: "Observed effect status requires fresh observation evidence." });
  }
});

/** Per-call timing telemetry is separate from effect evidence: elapsed time never proves an action succeeded. */
export const computerUseTelemetrySchema = z.object({
  timingsMs: z.object({
    observationMs: z.number().finite().min(0).optional(),
    routingMs: z.number().finite().min(0).optional(),
    actionMs: z.number().finite().min(0).optional(),
    verificationMs: z.number().finite().min(0).optional(),
    totalMs: z.number().finite().min(0),
  }).strict(),
  /** True when this call found an existing durable operation receipt instead of creating a new dispatch. */
  priorReceiptFound: z.boolean(),
}).strict();

export type ComputerUseCapability = z.infer<typeof computerUseCapabilitySchema>;
export type ComputerUseTarget = z.infer<typeof computerUseTargetSchema>;
export type ComputerUseLocator = z.infer<typeof computerUseLocatorSchema>;
export type ComputerUseAction = z.infer<typeof computerUseActionSchema>;
export type ComputerUsePostcondition = z.infer<typeof computerUsePostconditionSchema>;
export type ComputerUseResult = z.infer<typeof computerUseResultSchema>;
export type ComputerUseTelemetry = z.infer<typeof computerUseTelemetrySchema>;
export interface ComputerUseActionRequirements {
  capabilities: ComputerUseCapability[];
  match: "all" | "any";
}

/** The minimum semantic capabilities a route must implement for an action. */
export function computerUseActionRequirements(action: ComputerUseAction): ComputerUseActionRequirements {
  switch (action.kind) {
    case "observe": return { capabilities: ["observe.screenshot", "observe.accessibility", "observe.dom"], match: "any" };
    case "focus": return { capabilities: ["input.focus", "input.shared-os"], match: "all" };
    case "click": {
      const capabilities: ComputerUseCapability[] = [action.locator.kind === "element" ? "input.click.element" : "input.click.point"];
      if (action.button === "middle") capabilities.push("input.click.middle");
      if (action.button === "right") capabilities.push("input.click.right");
      if (action.count === 2) capabilities.push(`input.click.double.${action.locator.kind}`);
      // The one-shot foreground focus-confirmation step is itself use of the
      // real shared OS input device, so it requires the same advertised
      // capability every other shared-OS-input path would -- it is not
      // exempted just because it is bounded to one click.
      if (action.confirmFocusForeground) capabilities.push("input.shared-os");
      return { capabilities, match: "all" };
    }
    case "text": return { capabilities: [action.mode === "insert" ? "input.text.insert" : "input.text.replace",
      ...(action.confirmFocusForeground ? ["input.shared-os" as const] : [])], match: "all" };
    case "key": return { capabilities: ["input.key", ...(action.confirmFocusForeground ? ["input.shared-os" as const] : [])], match: "all" };
    case "select_text": return { capabilities: [action.selection.kind === "all" ? "input.select-text.all" : "input.select-text.text"], match: "all" };
    case "scroll": {
      const capabilities: ComputerUseCapability[] = [];
      if (action.deltaX !== 0) capabilities.push(`input.scroll.${action.unit}.horizontal`);
      if (action.deltaY !== 0) capabilities.push(`input.scroll.${action.unit}.vertical`);
      if (action.confirmFocusForeground) capabilities.push("input.shared-os");
      return { capabilities, match: "all" };
    }
    case "drag": return {
      capabilities: ["input.drag", ...(action.durationMs === undefined ? [] : ["input.drag.duration" as const]),
        ...(action.confirmFocusForeground ? ["input.shared-os" as const] : [])],
      match: "all",
    };
    case "navigate": return { capabilities: ["browser.navigate"], match: "all" };
    case "window_frame": return { capabilities: ["window.frame"], match: "all" };
    case "window_state": return { capabilities: ["window.state"], match: "all" };
    case "invoke_menu": return { capabilities: ["menu.invoke"], match: "all" };
    case "clipboard": return { capabilities: [action.mode === "read" ? "clipboard.read" : "clipboard.write"], match: "all" };
  }
}

/** Caller supplies the route's freshness budget; future observations fail closed. */
export function isComputerUseTargetFresh(target: ComputerUseTarget, nowMs: number, maxAgeMs: number): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return false;
  return target.observedAt <= nowMs && nowMs - target.observedAt <= maxAgeMs;
}

export type ComputerUseActionCheck =
  | { ok: true }
  | { ok: false; code: "target-mismatch" | "stale-observation" }
  | { ok: false; code: "unsupported-capability"; required: ComputerUseCapability[]; match: "all" | "any" };

/**
 * Validate that an action still refers to the observed target and that the
 * target advertised the required semantic capability. This does not select a
 * route or authorize shared OS input; those remain router responsibilities.
 */
export function checkComputerUseAction(target: ComputerUseTarget, action: ComputerUseAction): ComputerUseActionCheck {
  if (target.targetId !== action.targetId) return { ok: false, code: "target-mismatch" };
  if (target.revision !== action.targetRevision) return { ok: false, code: "stale-observation" };
  const { capabilities: required, match } = computerUseActionRequirements(action);
  const supported = match === "all"
    ? required.every((capability) => target.capabilities.includes(capability))
    : required.some((capability) => target.capabilities.includes(capability));
  return supported ? { ok: true } : { ok: false, code: "unsupported-capability", required, match };
}

export const parseComputerUseTarget = (value: unknown): ComputerUseTarget => computerUseTargetSchema.parse(value);
export const parseComputerUseAction = (value: unknown): ComputerUseAction => computerUseActionSchema.parse(value);
export const parseComputerUseResult = (value: unknown): ComputerUseResult => computerUseResultSchema.parse(value);
