import { z } from "zod";
import {
  computerUseTargetSchema,
  parseComputerUseTarget,
  type ComputerUseTarget,
} from "./computer-use-contract";

/**
 * Phase 7 target binding.
 *
 * The existing computer-use route already fences an action to an observed
 * targetId and revision. This module adds the multiplayer-level identity
 * check that sits above that route: a provider may only mutate a target that
 * has an explicit, stable window/tab identity, and one target identity cannot
 * silently become owned by a different agent in the same run.
 *
 * Browser instance/tab/frame fields are deliberately optional in the base
 * computer-use wire contract so the current broker and its explicit legacy
 * tab path remain compatible. A multiplayer binding is stricter: callers that
 * opt into the multiplayer mutation fence must provide the CDP-style identity
 * fields before claiming a mutation.
 */

const identifier = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:%-]*$/);

const targetBindingSchema = z.object({
  runId: identifier,
  branchId: identifier,
  agentId: identifier,
  surfaceId: identifier,
  target: computerUseTargetSchema,
}).strict();

export type MultiplayerTargetBinding = z.infer<typeof targetBindingSchema>;

export type TargetIdentityErrorCode =
  | "invalid-binding"
  | "missing-browser-instance"
  | "missing-tab"
  | "missing-frame"
  | "missing-window"
  | "duplicate-target";

export type TargetIdentityValidation =
  | { readonly ok: true; readonly binding: MultiplayerTargetBinding; readonly key: string }
  | { readonly ok: false; readonly code: Exclude<TargetIdentityErrorCode, "duplicate-target">; readonly error: string };

export interface TargetIdentityConflict {
  readonly code: "duplicate-target";
  readonly key: string;
  readonly existingAgentId: string;
  readonly requestedAgentId: string;
  readonly error: string;
}

export type TargetIdentityClaim =
  | { readonly ok: true; readonly duplicate: boolean; readonly key: string }
  | { readonly ok: false; readonly code: TargetIdentityErrorCode; readonly error: string; readonly key?: string };

export interface TargetIdentityOwner {
  readonly key: string;
  readonly runId: string;
  readonly branchId: string;
  readonly agentId: string;
  readonly surfaceId: string;
  readonly operationId?: string;
}

export interface TargetIdentityRegistry {
  claim(binding: MultiplayerTargetBinding, operationId: string): TargetIdentityClaim;
  /** Release only the active operation. Ownership remains bound to the agent. */
  release(operationId: string): void;
  /** Explicitly forget a target after the caller has observed it close or be replaced. */
  forget(binding: MultiplayerTargetBinding): void;
  snapshot(): readonly TargetIdentityOwner[];
}

function safePart(value: string): string {
  return value.replace(/[|\u0000-\u001f]/g, "_");
}

/**
 * Return a stable identity for the observed window/tab, excluding its
 * revision and capabilities. A new observation of the same target therefore
 * remains the same binding while a changed targetId remains a new binding.
 */
export function targetIdentityKey(target: ComputerUseTarget): string {
  switch (target.kind) {
    case "desktop":
      return `desktop|target=${safePart(target.targetId)}`;
    case "desktop-window":
      return `desktop-window|target=${safePart(target.targetId)}|window=${safePart(target.windowRef)}`;
    case "browser-chrome":
      return `browser-chrome|target=${safePart(target.targetId)}|instance=${safePart(target.browserInstanceId ?? "")}`;
    case "browser-tab":
      return `browser-tab|target=${safePart(target.targetId)}|instance=${safePart(target.browserInstanceId ?? "")}|tab=${safePart(target.tabId ?? "")}`;
    case "browser-frame":
      return `browser-frame|target=${safePart(target.targetId)}|instance=${safePart(target.browserInstanceId ?? "")}|tab=${safePart(target.tabId ?? "")}|frame=${safePart(target.frameId ?? "")}`;
    case "web-element":
      return `web-element|target=${safePart(target.targetId)}|instance=${safePart(target.browserInstanceId ?? "")}|tab=${safePart(target.tabId ?? "")}|frame=${safePart(target.frameId ?? "")}|document=${safePart(target.documentId ?? "")}|snapshot=${safePart(target.snapshotId)}|element=${safePart(target.elementRef)}`;
  }
}

function validateStableIdentity(binding: MultiplayerTargetBinding): TargetIdentityValidation {
  const parsed = targetBindingSchema.safeParse(binding);
  if (!parsed.success) {
    return { ok: false, code: "invalid-binding", error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "binding"}: ${issue.message}`).join("; ") };
  }
  const target = parseComputerUseTarget(parsed.data.target);
  switch (target.kind) {
    case "browser-chrome":
      if (!target.browserInstanceId) return { ok: false, code: "missing-browser-instance", error: "A browser-chrome binding requires an opaque browserInstanceId." };
      break;
    case "browser-tab":
      if (!target.browserInstanceId) return { ok: false, code: "missing-browser-instance", error: "A browser-tab binding requires an opaque browserInstanceId." };
      if (!target.tabId) return { ok: false, code: "missing-tab", error: "A browser-tab binding requires an opaque tabId; do not rely on the focused tab." };
      break;
    case "browser-frame":
      if (!target.browserInstanceId) return { ok: false, code: "missing-browser-instance", error: "A browser-frame binding requires an opaque browserInstanceId." };
      if (!target.tabId) return { ok: false, code: "missing-tab", error: "A browser-frame binding requires an opaque tabId." };
      if (!target.frameId) return { ok: false, code: "missing-frame", error: "A browser-frame binding requires an opaque frameId." };
      break;
    case "web-element":
      if (!target.browserInstanceId) return { ok: false, code: "missing-browser-instance", error: "A web-element binding requires an opaque browserInstanceId." };
      if (!target.tabId) return { ok: false, code: "missing-tab", error: "A web-element binding requires an opaque tabId." };
      break;
    case "desktop-window":
      if (!target.windowRef) return { ok: false, code: "missing-window", error: "A desktop-window binding requires an explicit windowRef." };
      break;
    case "desktop":
      break;
  }
  return { ok: true, binding: parsed.data, key: targetIdentityKey(target) };
}

/** Validate bindings before any mutation lease is requested. */
export function validateDistinctTargetBindings(bindings: readonly MultiplayerTargetBinding[]):
  | { readonly ok: true; readonly bindings: readonly MultiplayerTargetBinding[] }
  | { readonly ok: false; readonly error: string; readonly conflict?: TargetIdentityConflict } {
  const seen = new Map<string, MultiplayerTargetBinding>();
  const accepted: MultiplayerTargetBinding[] = [];
  for (const binding of bindings) {
    const validated = validateStableIdentity(binding);
    if (!validated.ok) return validated;
    const previous = seen.get(validated.key);
    if (previous && previous.agentId !== validated.binding.agentId) {
      const conflict: TargetIdentityConflict = {
        code: "duplicate-target",
        key: validated.key,
        existingAgentId: previous.agentId,
        requestedAgentId: validated.binding.agentId,
        error: `Target identity ${validated.key} is already bound to agent ${previous.agentId}; ${validated.binding.agentId} must observe its own target before mutating.`,
      };
      return { ok: false, error: conflict.error, conflict };
    }
    seen.set(validated.key, validated.binding);
    accepted.push(validated.binding);
  }
  return { ok: true, bindings: accepted };
}

export function createTargetIdentityRegistry(): TargetIdentityRegistry {
  const owners = new Map<string, TargetIdentityOwner>();
  const active = new Map<string, string>();
  const operations = new Map<string, string>();
  return {
    claim(binding, operationId) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) return { ok: false, code: "invalid-binding", error: "The target identity operation ID is invalid." };
      const validated = validateStableIdentity(binding);
      if (!validated.ok) return validated;
      const priorOperationKey = operations.get(operationId);
      if (priorOperationKey) {
        return priorOperationKey === validated.key
          ? { ok: true, duplicate: true, key: validated.key }
          : { ok: false, code: "duplicate-target", error: "This operation ID is already bound to a different target identity.", key: priorOperationKey };
      }
      const owner = owners.get(validated.key);
      if (owner && (owner.agentId !== validated.binding.agentId || owner.runId !== validated.binding.runId || owner.branchId !== validated.binding.branchId)) {
        return { ok: false, code: "duplicate-target", error: `Target identity ${validated.key} is already owned by agent ${owner.agentId}.`, key: validated.key };
      }
      const activeOperation = active.get(validated.key);
      if (activeOperation && activeOperation !== operationId) return { ok: false, code: "duplicate-target", error: `Target identity ${validated.key} is already in use by operation ${activeOperation}.`, key: validated.key };
      const nextOwner: TargetIdentityOwner = { ...validated.binding, key: validated.key, operationId };
      owners.set(validated.key, nextOwner);
      active.set(validated.key, operationId);
      operations.set(operationId, validated.key);
      return { ok: true, duplicate: false, key: validated.key };
    },
    release(operationId) {
      const key = operations.get(operationId);
      if (!key) return;
      operations.delete(operationId);
      if (active.get(key) === operationId) active.delete(key);
      const owner = owners.get(key);
      if (owner?.operationId === operationId) owners.set(key, { ...owner, operationId: undefined });
    },
    forget(binding) {
      const validated = validateStableIdentity(binding);
      if (!validated.ok) return;
      if (active.has(validated.key)) return;
      owners.delete(validated.key);
    },
    snapshot() {
      return [...owners.values()].map((owner) => ({ ...owner }));
    },
  };
}
