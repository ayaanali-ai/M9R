export type DesktopInputGateCode =
  | "dispatch-gate"
  | "target-identity"
  | "position-unconfirmed"
  | "overlay-not-visible"
  | "foreground-lease"
  | "background-unavailable"
  | "native-dispatch-unavailable"
  | "driver-refused"
  | "mutation-lease"
  | "mutation-revision";

/** Only throw before target input has been dispatched. Never infer this from message text. */
export class DesktopInputNotDispatchedError extends Error {
  readonly dispatchState = "not-dispatched" as const;

  /** Stable diagnostics for the gate that stopped delivery; never parse the message. */
  readonly code: DesktopInputGateCode;

  constructor(message: string, code: DesktopInputGateCode = "dispatch-gate") {
    super(message);
    this.name = "DesktopInputNotDispatchedError";
    this.code = code;
  }
}

/** The OS accepted some input in a multi-event sequence, or the native helper
 * could not prove whether it did. Callers must observe and reconcile instead
 * of automatically replaying the same physical action. */
export class DesktopInputOutcomeUnknownError extends Error {
  readonly dispatchState = "uncertain" as const;

  constructor(message: string) {
    super(message);
    this.name = "DesktopInputOutcomeUnknownError";
  }
}
