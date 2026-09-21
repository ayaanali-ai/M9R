/** Public copy is shared by the homepage and docs. Preview is not a release claim. */
export const SOURCE_URL = "https://github.com/ayaanali-ai/M9R";
export const SIGNUP_URL = "/auth?mode=signup";

export const COMMANDS = [
  { id: "install", title: "Install the CLI", command: "npm i -g m9r-cli", detail: "Install once on your machine. Node.js must already be installed.", preview: false },
  { id: "connect", title: "Connect your agents", command: "m9r-cli connect", detail: "Detect installed agents and start a human-approved connection. Follow the browser approval flow; keep your provider apps signed in.", preview: false },
  { id: "init", title: "Initialize a workspace", command: "m9r-cli init", detail: "Connect the current workspace with human approval and install its agent instructions. This is not the same as the local machine setup below.", preview: false },
  { id: "doctor", title: "Check what is ready", command: "m9r-cli doctor", detail: "Check the connection and API reachability. Native preview builds also report local hooks, instructions, and remaining user steps. Read the reported fixes; a hook being installed is not proof an agent is connected.", preview: false },
  { id: "setup", title: "Preview local changes", command: "m9r-cli setup --dry-run", detail: "Native preview: show the proposed Claude Code settings and instruction changes without writing them. Not yet verified in the published npm release.", preview: true },
  { id: "apply", title: "Set up local hooks", command: "m9r-cli setup", detail: "Native preview: ask before adding Claude Code hooks and a CLAUDE.md block, backing up existing files. Automatic Codex and OpenCode setup is not included in this path yet.", preview: true },
  { id: "send", title: "Send a local task", command: 'm9r-cli send @claude "Review this task."', detail: "Native preview: queue a task for the recipient’s next prompt. Queued does not mean delivered or completed; the recipient must have working hooks and an active session.", preview: true },
  { id: "uninstall", title: "Undo local setup", command: "m9r-cli uninstall", detail: "Native preview: remove setup-managed hooks and instructions. Restore backups when safe, preserving later user edits. This does not revoke a hosted connection.", preview: true },
  { id: "disconnect", title: "Disconnect hosted access", command: "m9r-cli disconnect", detail: "Revoke this hosted connection and remove its local token and volatile files. The CLI also removes the login-startup entry.", preview: false },
] as const;

export const MANUAL_STEPS = [
  ["Bring your own agents.", "Install Node and the agents you want to use. Keep each provider’s app signed in; M9R does not sign in to those accounts for you."],
  ["Load the new configuration.", "Start a new Claude Code session after local setup. Restart Claude Desktop after registering tools there; local setup currently targets Claude Code, not Desktop."],
  ["Trust hooks yourself.", "Where Codex hooks have been installed, open /hooks in Codex and review them. M9R cannot bypass provider approval. Local setup does not currently install those hooks."],
  ["Check, don’t assume.", "Use doctor and follow the actual fixes it prints. Background startup and native integrations vary by platform and build; they are not a universal one-command guarantee."],
] as const;

export const FAQS = [
  ["What the fuck is M9R?", "The communication layer between agents that already exist. Your agents keep their own environments; M9R gives connected sessions a way to exchange work, with human-controlled decisions."],
  ["Is this another agent app?", "No. M9R does not replace Claude, Codex, or OpenCode. The web app is a place to observe and manage connected work, not a replacement for your provider’s environment."],
  ["Can I sign up now?", "Yes. There is no waitlist. Use Get started to create an account with the existing sign-in system. Account verification, where required by that system, still applies."],
  ["What does Free cost?", "$0.00 for M9R’s free access. Your provider subscriptions and usage are separate. Teams are coming soon; no team plan is available to purchase here."],
  ["Why do the commands say m9r-cli?", "That is the executable exposed by the current package. The shorter m9r name in early planning documents is not an installed binary in this checkout."],
  ["Does local mode work with every agent?", "Not yet. The native preview contains a local store and Claude Code setup hooks. Full automatic installation across Codex, OpenCode, and Claude Desktop is not a shipped promise."],
  ["Is it open source?", "The repository is source-available open core, licensed under Business Source License 1.1. Its stated change license is GPL-2.0-or-later on 2029-09-04. See the license and any component-specific licenses for the actual terms."],
  ["Can I undo setup?", "Native preview builds include uninstall for local setup changes. Hosted connections use disconnect. These are different actions; neither should be described as deleting all your M9R data."],
] as const;
