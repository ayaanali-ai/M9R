/** Only throw before target input has been dispatched. Never infer this from message text. */
export class DesktopInputNotDispatchedError extends Error {
  readonly dispatchState = "not-dispatched" as const;
}
