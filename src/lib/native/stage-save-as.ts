import { win32 } from "node:path";

export interface SaveAsTarget {
  /** Canonical absolute Windows path to the file the user requested. */
  path: string;
  /** Parent directory, kept distinct from the filename throughout the flow. */
  directory: string;
  /** The requested leaf name, never a directory or a path fragment. */
  fileName: string;
}

export interface SaveAsControl {
  role: string;
  label: string;
  automationId: string;
  enabled: boolean;
  actions?: { invoke?: boolean; legacy?: boolean; setValue?: boolean };
}

function normalizeSaveLabel(value: string): string {
  return value.replace(/&/g, "").replace(/[:.…]+$/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function containsExactFileName(text: string, fileName: string): boolean {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_.-])${escaped}(?![\\p{L}\\p{N}_.-])`, "iu").test(text);
}

/**
 * Split and validate a requested Windows save path before any dialog input.
 * The original spelling is normalized once; later code never asks the model
 * to decide which part belongs in the file-name field.
 */
export function resolveSaveAsTarget(input: string, pathApi: typeof win32 = win32): SaveAsTarget {
  if (typeof input !== "string" || input.length === 0 || input.length > 32_760
    || /[\u0000-\u001f\u007f]/.test(input) || /[\\/]$/.test(input) || !pathApi.isAbsolute(input)) {
    throw new Error("Save As needs one absolute Windows file path; no dialog input was sent.");
  }
  const windowsInput = input.replace(/\//g, "\\").toLocaleLowerCase("en-US");
  if (windowsInput.startsWith("\\\\?\\") || windowsInput.startsWith("\\\\.\\") || windowsInput.startsWith("\\??\\")) {
    throw new Error("Save As does not accept Windows device namespace paths; no dialog input was sent.");
  }
  const canonical = pathApi.normalize(input);
  const root = pathApi.parse(canonical).root;
  const fileName = pathApi.basename(canonical);
  if (!root || canonical === root || !fileName || fileName === "." || fileName === ".."
    || /[<>:"|?*]/.test(fileName) || /[ .]$/.test(fileName)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(fileName)) {
    throw new Error("Save As path has no valid Windows filename; no dialog input was sent.");
  }
  const directory = pathApi.dirname(canonical);
  if (directory === canonical) {
    throw new Error("Save As needs a file path, not a directory; no dialog input was sent.");
  }
  return { path: canonical, directory, fileName };
}

/** Resolve exactly one current, enabled Windows Save As name field. */
export function findSaveAsNameField<T extends SaveAsControl>(controls: readonly T[]): T | undefined {
  const editable = controls.filter((control) => control.enabled
    && /^(?:edit|combobox)$/i.test(control.role)
    && control.actions?.setValue === true);
  const labeled = editable.filter((control) => /^(?:file name|filename)$/i.test(normalizeSaveLabel(control.label)));
  if (labeled.length === 1) return labeled[0];
  if (labeled.length > 1) return undefined;
  const identified = editable.filter((control) => /^(?:filename|filenamecontrolhost|1001)$/i.test(control.automationId));
  return identified.length === 1 ? identified[0] : undefined;
}

/** Resolve one explicit Save button, never a coincidental toolbar or menu item. */
export function findSaveAsButton<T extends SaveAsControl>(controls: readonly T[]): T | undefined {
  const buttons = controls.filter((control) => control.enabled && /^button$/i.test(control.role)
    && (control.actions?.invoke === true || control.actions?.legacy === true)
    && /^(?:save|save as)$/i.test(normalizeSaveLabel(control.label)));
  return buttons.length === 1 ? buttons[0] : undefined;
}

/**
 * Resolve one explicit, enabled button in a dialog by its exact accessible
 * label (e.g. "Save", "Don't Save", "Cancel") -- the generic sibling of
 * findSaveAsButton for ordinary confirm/prompt dialogs that have no file
 * name field at all. Ambiguity (zero or more than one match) is never
 * guessed through.
 */
export function findDialogButton<T extends SaveAsControl>(controls: readonly T[], label: string): T | undefined {
  const target = normalizeSaveLabel(label);
  const buttons = controls.filter((control) => control.enabled && /^button$/i.test(control.role)
    && (control.actions?.invoke === true || control.actions?.legacy === true)
    && normalizeSaveLabel(control.label) === target);
  return buttons.length === 1 ? buttons[0] : undefined;
}

export interface SaveAsConflictDecision {
  recognized: boolean;
  confirm?: boolean;
  dismiss?: boolean;
  reason?: string;
}

/**
 * A conflict dialog is actionable only if its accessible text names the exact
 * requested leaf and clearly asks to replace/overwrite it. Generic prompts are
 * left untouched for a fresh observation.
 */
export function classifySaveAsConflict(controls: readonly SaveAsControl[], fileName: string, replaceAuthorized: boolean): SaveAsConflictDecision {
  const text = controls.map((control) => control.label).join(" ").replace(/\s+/g, " ").trim();
  const namesTarget = containsExactFileName(text, fileName);
  const asksReplace = /\b(?:already exists|replace|overwrite|do you want to replace)\b/i.test(text);
  if (!namesTarget || !asksReplace) return { recognized: false, reason: "The conflict dialog did not identify the exact requested file." };
  const buttonLabels = controls.filter((control) => control.enabled && /^button$/i.test(control.role)
    && (control.actions?.invoke === true || control.actions?.legacy === true)).map((control) => normalizeSaveLabel(control.label));
  const positive = buttonLabels.filter((label) => /^(?:replace|yes|overwrite)$/i.test(label));
  const negative = buttonLabels.filter((label) => /^(?:no|cancel|keep both)$/i.test(label));
  if (replaceAuthorized && positive.length === 1) return { recognized: true, confirm: true };
  if (!replaceAuthorized && negative.length === 1) return { recognized: true, dismiss: true, reason: "The existing file was preserved because replacement was not authorized." };
  return { recognized: true, reason: replaceAuthorized
    ? "The exact target conflict was recognized, but there is no unique Replace/Yes control."
    : "The exact target conflict was recognized, but there is no unique safe dismissal control." };
}
