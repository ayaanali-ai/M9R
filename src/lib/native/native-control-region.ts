import { createHash } from "node:crypto";
import type { NativeWindowStructureElement } from "./windows-desktop-stage";

function providerIdentity(element: NativeWindowStructureElement) {
  return { automationId: element.automationId, role: element.role, className: element.className };
}
function canonicalIdentity(element: NativeWindowStructureElement): string {
  return JSON.stringify(providerIdentity(element));
}

/**
 * A window/process generation supplies the outer scope. Inside it, only a unique
 * semantic ValuePattern control gets an independent region. RuntimeId is required
 * as a live revalidation epoch, never used as the persistent region identity.
 * Weak/partial trees retain the whole-window mutation fence.
 */
export function nativeValueControlRegion(element: NativeWindowStructureElement,
  elements: readonly NativeWindowStructureElement[], complete: boolean): string | undefined {
  if (!complete || !element.enabled || !element.actions?.setValue || !element.runtimeId?.length || !element.automationId.trim()) return undefined;
  const identity = canonicalIdentity(element);
  // Require window-wide uniqueness rather than baking mutable ancestor/index
  // paths into the key. A reparented live field must retain the same lock.
  const twins = elements.filter((candidate) => candidate.automationId === element.automationId);
  if (twins.length !== 1) return undefined;
  return `uia-value-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function sameNativeControlEpoch(observed: NativeWindowStructureElement, current: NativeWindowStructureElement): boolean {
  const sameEpoch = observed.runtimeId?.length
    ? JSON.stringify(observed.runtimeId) === JSON.stringify(current.runtimeId)
    : JSON.stringify(observed.path) === JSON.stringify(current.path);
  return Boolean(sameEpoch && current.role === observed.role && current.label === observed.label
    && current.className === observed.className && current.automationId === observed.automationId);
}
