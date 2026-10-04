# C1 — Agent-owned Chrome

**Status: not signed off.** Synthetic live input and the no-banner check pass outside the restricted command sandbox. Owner sign-in persistence remains unverified.

## Verified

- The 2026-10-03 headed-Chrome fixture recorded a trusted click and typed input, denied an unapproved origin, refused a sensitive field, enforced site revocation, and left the normal Chrome profile untouched by construction. Evidence: `.m9r/c1-live-acceptance/result.json`.
- That fixture recorded `persisted: false`; it did not establish owner sign-in persistence.
- On 2026-10-04, the live broker test failed inside the restricted command sandbox. A diagnostic Chrome launch showed its GPU subprocess exiting with Windows `STATUS_ACCESS_DENIED`, after which Chrome closed the CDP connection during `Page.enable`.
- Re-running the same synthetic live acceptance outside the restricted sandbox passed: trusted click and text input, unapproved-origin denial, sensitive-field refusal, site-revocation denial, and snapshot. Evidence: `.m9r/c1-live-acceptance/result.json`.
- Captured the actual dedicated Chrome window during the passing run. The page showed the successful click and typed text, with no debugging/automation banner. Screenshot: `.m9r/c1-live-acceptance/window.png`.
- The fixture's `persisted` value was `false`; no owner account was signed in. Owner sign-in persistence across a profile restart is not verified.

## Still required for sign-off

1. Have the owner sign in once in the dedicated profile and verify the session survives a profile restart. Do not record or handle the owner's credentials.
2. Keep the live run outside the restricted command sandbox on this machine: its Chrome GPU subprocess is denied inside the sandbox, which makes CDP tab setup fail before page actions run.

Do not mark C1 complete until both remaining gates pass. C2's typing and drag acceptance is tracked separately in `docs/M9R_C2_QUIET_INPUT_ACCEPTANCE.md`.
