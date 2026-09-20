/**
 * The one list of setup steps. The CLI (`setup`, `doctor`), the docs page, the dashboard onboarding card and the README
 * all read this, so they can never disagree (design section 20). Keep wording plain and true: a step marked `you` is
 * something M9R cannot do for the user, and the page must say so.
 */
export interface OnboardingStep {
  id: string;
  who: "m9r" | "you";
  title: string;
  detail: string;
  /** Present only for steps the user must do; the exact fix shown beside an open row in `doctor`. */
  fix?: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: "install", who: "you", title: "Install M9R", detail: "Node must be installed. Then install the CLI.", fix: "npm i -g m9r-cli" },
  { id: "setup", who: "m9r", title: "Set up this machine", detail: "One command shows exactly what it will change in your agent settings, asks first, and backs everything up.", fix: "m9r-cli setup" },
  { id: "claude-hooks", who: "m9r", title: "Claude Code hooks", detail: "Small hooks in your Claude settings let a mention like @codex become a task, and bring replies back at your next prompt." },
  { id: "standing-instruction", who: "m9r", title: "Standing instruction", detail: "A short block in your own CLAUDE.md tells Claude to handle approved inbox tasks and never act on unapproved ones." },
  { id: "new-session", who: "you", title: "Start a new Claude Code session", detail: "Hooks load when a session starts. Sessions that were already open before setup do not have them yet.", fix: "Open a new Claude Code session, or restart Claude Desktop." },
  { id: "codex-trust", who: "you", title: "Trust the Codex hooks", detail: "Codex requires you to review and trust non-managed hooks once. M9R will not bypass that.", fix: "In Codex, type /hooks and choose to trust the M9R hooks." },
  { id: "logins", who: "you", title: "Stay logged in to your agents", detail: "M9R never handles your Claude, Codex or OpenCode logins. Each agent keeps running in its own app." },
  { id: "undo", who: "m9r", title: "Undo anytime", detail: "Removes everything M9R added and restores the backups. It never touches your own content.", fix: "m9r-cli uninstall" },
];

/** The steps only the user can do, in order; used for the "still open" lines in `doctor`. */
export const USER_STEPS = ONBOARDING_STEPS.filter((s) => s.who === "you");

/** Markdown for the README and the docs page, so both are generated from the same list. */
export function renderStepsMarkdown(): string {
  return ONBOARDING_STEPS.map((s, i) => `${i + 1}. **${s.title}.** ${s.detail}${s.fix ? ` \`${s.fix}\`` : ""}`).join("\n");
}
