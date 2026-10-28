export type DesktopInputGateCode =
  | "dispatch-gate"
  | "target-identity"
  | "position-unconfirmed"
  | "overlay-not-visible"
  | "foreground-lease"
  | "background-unavailable";

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
