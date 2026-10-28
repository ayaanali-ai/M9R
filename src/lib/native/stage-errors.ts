import type { CuaStageCapture } from "./cua-stage-driver";

export type StageFailureKind = "authorization" | "validation" | "driver" | "runtime";

export class StageInputNotDispatchedError extends Error {
  readonly dispatchState = "not-dispatched" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StageInputNotDispatchedError";
  }
}

export class StageCaptureRefreshError extends StageInputNotDispatchedError {
  readonly capture: CuaStageCapture;
  constructor(capture: CuaStageCapture) {
    super("The desktop changed since the last capture. Inspect the refreshed capture and choose the next action; no input was sent.");
    this.name = "StageCaptureRefreshError";
    this.capture = capture;
  }
}

export class StageWindowSelectionError extends StageInputNotDispatchedError {
  readonly windowTitles: string[];
  readonly windowChoices?: Array<{ title: string; windowRef: string }>;
  constructor(windowTitles: string[], windowChoices?: Array<{ title: string; windowRef: string }>) {
    super("The requested app has multiple windows or the requested selection no longer matches. Choose a windowRef or exact windowTitle from the returned choices and retry the launch request.");
    this.name = "StageWindowSelectionError";
    this.windowTitles = windowTitles;
    this.windowChoices = windowChoices;
  }
}

export class StageAuthorizationError extends Error {
  readonly failureKind = "authorization" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StageAuthorizationError";
  }
}

export class StageValidationError extends Error {
  readonly failureKind = "validation" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StageValidationError";
  }
}

export interface StageErrorCause {
  name?: string;
  message: string;
  tool?: string;
  errorCode?: string;
  code?: string;
}

export interface SerializedStageFailure {
  ok: false;
  error: string;
  failureKind: StageFailureKind;
  code?: string;
  driverError?: { tool: string; errorCode: string; message: string };
  causes?: StageErrorCause[];
  dispatchState?: "not-dispatched";
  recovery?: { kind: "capture_refreshed"; capture: CuaStageCapture }
    | { kind: "window_selection"; windowTitles: string[]; windowChoices?: Array<{ title: string; windowRef: string }> };
}

const MAX_CAUSES = 8;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_FIELD_LENGTH = 120;

function safeText(value: unknown, limit = MAX_MESSAGE_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(authorization|x-m9r-key|(?:m9r[-_ ]?)?session[-_ ]?token|(?:broker|access|api)[-_ ]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, limit) : undefined;
}

function field(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return (value as Record<string, unknown>)[key]; }
  catch { return undefined; }
}

function errorName(value: unknown): string | undefined {
  return safeText(field(value, "name"), MAX_FIELD_LENGTH);
}

function collectCauses(error: unknown): StageErrorCause[] {
  const result: StageErrorCause[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || result.length >= MAX_CAUSES || value === null || value === undefined) return;
    if (typeof value !== "object" && typeof value !== "function") {
      const message = safeText(value);
      if (message) result.push({ message });
      return;
    }
    if (visited.has(value as object)) return;
    visited.add(value as object);

    const message = safeText(field(value, "message"));
    const tool = safeText(field(value, "tool"), MAX_FIELD_LENGTH);
    const errorCode = safeText(field(value, "errorCode"), MAX_FIELD_LENGTH);
    const code = safeText(field(value, "code"), MAX_FIELD_LENGTH);
    const name = errorName(value);
    if (message || tool || errorCode || code) {
      result.push({
        ...(name ? { name } : {}),
        message: message ?? (tool && errorCode ? `${tool} (${errorCode})` : "Stage operation failed."),
        ...(tool ? { tool } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(code ? { code } : {}),
      });
    }

    const inner = field(value, "inner");
    if (inner !== undefined) visit(inner, depth + 1);
    const cause = field(value, "cause");
    if (cause !== undefined) visit(cause, depth + 1);
    const errors = field(value, "errors");
    if (Array.isArray(errors)) {
      for (const item of errors) visit(item, depth + 1);
    }
  };

  visit(error, 0);
  return result;
}

export function serializeStageFailure(error: unknown, fallback: string): SerializedStageFailure {
  const causes = collectCauses(error);
  const rootMessage = safeText(field(error, "message")) ?? safeText(error) ?? fallback;
  const uniqueMessages = [...new Set(causes.map((cause) => {
    if (cause.tool && cause.errorCode) return `${cause.tool} (${cause.errorCode}): ${cause.message}`;
    return cause.message;
  }).filter((message) => message !== rootMessage))];
  const formatted = [rootMessage, ...uniqueMessages].join("; Caused by: ").slice(0, 8_000);
  const driverCause = causes.find((cause) => cause.tool && cause.errorCode && cause.message);
  const code = causes.find((cause) => cause.code)?.code;
  const explicitKind = field(error, "failureKind");
  const failureKind: StageFailureKind = explicitKind === "authorization" || explicitKind === "validation"
    ? explicitKind
    : driverCause ? "driver" : "runtime";

  return {
    ok: false,
    error: formatted || fallback,
    failureKind,
    ...(code ? { code } : {}),
    ...(driverCause ? { driverError: { tool: driverCause.tool!, errorCode: driverCause.errorCode!, message: driverCause.message } } : {}),
    ...(causes.length > 1 ? { causes } : {}),
    ...(error instanceof StageInputNotDispatchedError ? { dispatchState: error.dispatchState } : {}),
    ...(error instanceof StageCaptureRefreshError ? { recovery: { kind: "capture_refreshed" as const, capture: error.capture } } : {}),
    ...(error instanceof StageWindowSelectionError ? { recovery: { kind: "window_selection" as const,
      windowTitles: error.windowTitles.slice(0, 40).map((title) => safeText(title, 160) ?? "Untitled"),
      ...(error.windowChoices ? { windowChoices: error.windowChoices.slice(0, 40).map((choice) => ({
        title: safeText(choice.title, 160) ?? "Untitled", windowRef: choice.windowRef })) } : {}) } } : {}),
  };
}
