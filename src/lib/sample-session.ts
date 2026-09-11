/**
 * Sample session — M9R v5
 * ----------------------------------------------------------------------------
 * A representative (synthetic) coding-agent transcript and an improved follow-up,
 * used to power the public /report/sample page through the REAL pipeline
 * (parser → report → rules → comparison). Kept here so the page and its tests
 * share one source of truth.
 *
 * No customer data. The "improved" follow-up exists so the before/after preview
 * has something honest to compare against.
 */

export const SAMPLE_SESSION_NAME = "claude-auth-refactor.md";

export const V5_TAGLINE = "M9R makes every AI coding session improve the next one.";

/** A messy first run: retries on the same command, edit-thrash, repeated reads. */
export const SAMPLE_SESSION_TRANSCRIPT = `## User
Refactor the auth module and make the failing tests pass.

## Assistant
I'll start by reading the auth module.

⏺ Read(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  Error: 3 tests failed in auth.test.ts
⏺ Edit(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  Error: 2 tests failed
⏺ Read(src/lib/auth.ts)
⏺ Edit(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  Error: 2 tests failed
⏺ Read(src/lib/auth.ts)
⏺ Edit(src/lib/auth.ts)
⏺ Edit(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  Error: still failing
`;

/** A cleaner follow-up run after applying the generated rules. */
export const SAMPLE_FOLLOWUP_TRANSCRIPT = `## User
Refactor the auth module and make the failing tests pass.

## Assistant
I'll read the module fully and plan the change before editing.

⏺ Read(src/lib/auth.ts)
⏺ Edit(src/lib/auth.ts)
⏺ Bash(npm test)
  ⎿  All tests passed
`;
