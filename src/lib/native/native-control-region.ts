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
  if (!sameEpoch || current.role !== observed.role || current.className !== observed.className
    || current.automationId !== observed.automationId) return false;
  // The control's display label can legitimately change (a document title's
  // unsaved-state marker, a live counter, status text) without the control
  // itself changing identity. A stable automationId is a stronger, non-mutable
  // identity signal; only fall back to requiring an exact label match when no
  // automationId is available to lean on.
  if (observed.automationId.trim()) return true;
  return current.label === observed.label;
}

/** The nearest exposed document owns the field even when one window hosts several documents. */
export function nativeDocumentAncestor(element: NativeWindowStructureElement,
  elements: Iterable<NativeWindowStructureElement>): NativeWindowStructureElement | undefined {
  let nearest: NativeWindowStructureElement | undefined;
  for (const candidate of elements) {
    if (candidate.role.toLowerCase() !== "document" || candidate.path.length >= element.path.length
      || (nearest && candidate.path.length <= nearest.path.length)) continue;
    if (candidate.path.every((segment, index) => element.path[index] === segment)) nearest = candidate;
  }
  return nearest;
}
