/**
 * What a person sees when a request fails. Server-side failures and anything that reads like database or deployment
 * internals (a missing table, a migration, a constraint name) are replaced with a plain sentence; the real message is
 * logged on the server instead. Messages meant for people (validation, "Workspace memory is full") pass through.
 */
const INTERNAL = /schema cache|migration|relation "|column "|violates|PGRST|SQLSTATE|\bpublic\.[a-z_]+|supabase|postgres|row-level security|service role|duplicate key|syntax error|\bRPC\b|could not find the (table|function)/i;

export function publicErrorMessage(message: string, status: number): string {
  if (status >= 500 || INTERNAL.test(message)) {
    return status === 503 ? "This is temporarily unavailable. Please try again in a moment." : "Something went wrong on our side. Please try again.";
  }
  return message;
}

/** Same rule for the status the message is sent with: leaked-internals messages never ride on a 4xx that implies the person erred. */
export function logInternalError(scope: string, message: string, status: number): void {
  if (status >= 500 || INTERNAL.test(message)) console.error(`${scope}:`, message);
}
