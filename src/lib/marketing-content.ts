/** Public copy is shared by the homepage and docs. Preview is not a release claim. */
export const SOURCE_URL = "https://github.com/ayaanali-ai/M9R";
export const SIGNUP_URL = "/auth?mode=signup";

export const COMMANDS = [
  { id: "connect", title: "Connect your agents", command: "npx m9r-cli connect", detail: "Find the Claude Code, Codex, and OpenCode CLIs already on this machine and open one human approval.", preview: false },
  { id: "web-setup", title: "Add browser work", command: "npx m9r-cli web setup", detail: "Install the managed browser extension, start the local broker, and load the one extension folder in Chrome or Edge.", preview: false },
  { id: "doctor", title: "Check what is ready", command: "npx m9r-cli doctor", detail: "Confirm the saved connection and API reachability after setup.", preview: false },
  { id: "disconnect", title: "Disconnect hosted access", command: "npx m9r-cli disconnect", detail: "Revoke the connection and remove its local token and temporary state.", preview: false },
] as const;

export const MANUAL_STEPS = [
  ["Keep your providers ready.", "Install Node.js 18 or newer and the agent CLIs you want to use. Keep each provider app signed in; M9R never handles those logins."],
  ["Approve once.", "The connect command opens one browser approval for the providers it detects. Approve it, then let the command finish."],
  ["Load one extension folder.", "The web setup command opens the browser extension page. Turn on Developer mode and load the copied managed folder once."],
  ["Verify the connection.", "Run doctor if anything looks offline. Do not start the development broker or load a second extension copy."],
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
