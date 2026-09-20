# Get-started content for the homepage and docs (hand this to Astra)

Status: **draft copy and structure, 2026-09-20.** The commands below are what the product does today or will do at the end of build slice N1 (`M9R_NATIVE_FRONT_DOOR_DESIGN.md`). Wording is a starting point; the design is Astra's. Do not invent steps that are not listed here.

## 1. The get-started block for the homepage (keep it tiny)

Placement: directly under the hero, before the dense window/room sections.

**Two commands, nothing more:**

```
npm i -g m9r-cli
m9r-cli setup
```

One line under it: "One command sets up your agents locally, asking first and backing everything up. Undo anytime with `m9r-cli uninstall`." Today that means Claude Code; add Codex and OpenCode to the line only once they ship.

Two variants depending on launch mode (owner decides):
- **Install now:** show the block above with a copy button.
- **Waitlist:** show the same block greyed as "Early access" plus the waitlist form, and the line "Install commands unlock when your invite arrives."

## 2. What `m9r-cli setup` does (for the docs page and any explainer)

Runs once per machine, not per project. **Local mode: no account, no sign-in, no network.**
1. Shows a plan of exactly what it will change and asks first: small hooks in your Claude Code settings and a short standing-instruction block in your own `CLAUDE.md`. (`--dry-run` shows the plan and changes nothing.)
2. Makes a backup of every file it edits.
3. Writes the changes. Running it again changes nothing.
4. Tells you the steps only you can do (see section 3).

Today this covers **Claude Code** (terminal and the Claude Desktop code tab, which read the same settings). Codex, OpenCode and the M9R tools inside each app arrive in the next build slices, and the copy must not claim them until they ship. Signing in and connecting to the hosted dashboard is a separate, optional step for later.

Then use it: type `@codex …` inside Claude and it becomes a task for that agent; `m9r-cli send @claude "…"` sends one from any terminal. Nothing to open. The web app and the overlay are only for watching.

## 3. The steps a user must do themselves (be honest about these on the page)

- **Install Node** if it is not already installed.
- **Stay logged in** to Claude, Codex and OpenCode yourself. M9R never handles those logins.
- **Codex:** trust the M9R hooks once by typing `/hooks` inside Codex and choosing to trust them. This is Codex's own rule.
- **Claude Desktop:** restart it once so it loads the M9R tools.
- **Windows first:** the login background service is Windows only at launch; Mac and Linux follow.

## 4. The check command

`m9r-cli doctor` prints a live checklist: each agent connected or not, and which one-time steps above are still open, with the exact fix beside each. Suggested look: a short list with green ticks and amber "do this next" lines.

## 5. Undo

`m9r-cli uninstall` removes everything M9R added and restores the backups. It removes only its own blocks, never the user's own content.

## 6. The dashboard first-login card (design when the app UI is redone)

A single card with live status rows:
1. This machine connected
2. Claude connected
3. Codex connected
4. OpenCode connected (if installed)
5. Codex hooks trusted
6. Claude Desktop restarted

Each row: status (done / needs you / not installed), and a one-line fix. The card disappears when everything is done.

## 7. The docs page: `/docs/get-started`

Sections in order: What you need, Install, Run `m9r-cli setup` (with what it asks), The steps only you can do, Try it (`@codex` from Claude), Check with `m9r-cli doctor`, Undo, Troubleshooting (agent not found, hook not trusted, Desktop not showing tools). Generated from the same step list as the CLI so the two never disagree.

## 8. Tone and rules
Plain and calm, no hype. Every claim must be true today. Never say "open source" (see the open-core note in `M9R_MASTER_PLAN.md`): say "source-available open core". Never show fake screenshots or invented numbers.

## Note on the command name (2026-09-20)
The machine-setup command is `m9r-cli setup` for now, not `m9r-cli init` (`init` is the older per-repo connect flow). The homepage block should therefore read `npm i -g m9r-cli` then `m9r-cli setup`. The two may merge into one `init` later; this file will be updated if so.
