# C1 — Agent-owned Chrome

**Status: signed off.** Synthetic live input and the no-banner check pass outside the restricted command sandbox, and an owner-authenticated GitHub session survived an M9R channel restart in the same isolated profile.

## Verified

- The 2026-10-03 headed-Chrome fixture recorded a trusted click and typed input, denied an unapproved origin, refused a sensitive field, enforced site revocation, and left the normal Chrome profile untouched by construction. Evidence: `.m9r/c1-live-acceptance/result.json`.
- That fixture recorded `persisted: false`; it did not establish owner sign-in persistence.
- On 2026-10-04, the live broker test failed inside the restricted command sandbox. A diagnostic Chrome launch showed its GPU subprocess exiting with Windows `STATUS_ACCESS_DENIED`, after which Chrome closed the CDP connection during `Page.enable`.
- Re-running the same synthetic live acceptance outside the restricted sandbox passed: trusted click and text input, unapproved-origin denial, sensitive-field refusal, site-revocation denial, and snapshot. Evidence: `.m9r/c1-live-acceptance/result.json`.
- Captured the actual dedicated Chrome window during the passing run. The page showed the successful click and typed text, with no debugging/automation banner. Screenshot: `.m9r/c1-live-acceptance/window.png`.
- The synthetic fixture's `persisted` value was `false` by design; it did not contain an owner account and was not the persistence test.
- The owner sign-in path is now separated from the agent channel: `m9r web chrome setup` opens the same dedicated profile in ordinary headed Chrome with no CDP endpoint or automation flags. After the owner closes that window, `m9r web chrome start` reopens the exact profile under the M9R broker.
- On 2026-10-04, the owner signed into GitHub during `m9r web chrome setup`, closed the ordinary window, and the M9R broker reopened `https://github.com/` successfully. The broker's visible page read showed the signed-in `Dashboard` surface before and after stopping and restarting the M9R channel. Evidence: `.m9r/c1-live-acceptance/owner-session-persistence.json`. No credentials or cookies were read or recorded.

## Sign-off gates

1. `m9r web chrome setup` provides the normal-browser owner sign-in path; the saved session was reopened and read after an M9R channel restart.
2. The live run was performed outside the restricted command sandbox because this machine denies Chrome's GPU subprocess inside the sandbox; the controlled broker run passed outside it.

C2's typing and drag acceptance is tracked separately in `docs/M9R_C2_QUIET_INPUT_ACCEPTANCE.md`.
