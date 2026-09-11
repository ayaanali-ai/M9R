/**
 * The raw terminal multiplayer view (build plan item #21) is deliberately
 * opt-in until it is as polished as the reference bar we hold it to.
 *
 * The flag is public configuration, not a secret. Keeping the default false
 * means a missing deployment variable cannot accidentally expose a half-built
 * surface. Set NEXT_PUBLIC_M9R_TERMINAL_ENABLED=true only after the shared
 * PTY, multi-viewer presence, and cross-agent handoff behavior have been
 * re-verified end to end.
 *
 * This does NOT gate `npx m9r-cli terminal runtime` (the local resident
 * process that spawns agent sessions). That is a separate feature that
 * happens to share the word "terminal".
 */
export const TERMINAL_ENABLED = process.env.NEXT_PUBLIC_M9R_TERMINAL_ENABLED === "true";
