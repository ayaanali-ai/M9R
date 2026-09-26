/**
 * The raw terminal multiplayer view (build plan item #21) is deliberately
 * opt-in until it is as polished as the reference bar we hold it to.
 *
 * Pane access is intentionally disabled in every environment until the
 * shared-room flow has passed an end-to-end multiplayer test. Keep the
 * implementation and API code for the next verification cycle, but do not
 * expose an environment switch that can accidentally publish the unfinished
 * surface.
 *
 * This does NOT gate `npx m9r-cli terminal runtime` (the local resident
 * process that spawns agent sessions). That is a separate feature that
 * happens to share the word "terminal".
 */
export const TERMINAL_ENABLED = false;
