# One-shot M9R Web setup (Windows 10/11)

The supported quick path is `m9r web setup`. It detects Claude Code, Codex, and OpenCode, previews the exact user-config changes, installs the MCP entries and existing identity hooks, copies the fixed-ID browser extension, starts the loopback broker, and registers it for the current Windows user at sign-in. No admin rights, API keys, or M9R session tokens are needed.

```powershell
m9r web setup
```

For a script/non-interactive run, pass the agent list explicitly and accept the displayed plan:

```powershell
m9r web setup --agents claude-code,codex --yes
```

For this repository checkout before the updated CLI is published:

```powershell
npm ci
npm run build:cli
node .\cli\dist\m9r.js web setup
```

The only browser action that cannot be automated is loading the unpacked extension: setup copies its folder path to the clipboard and opens the detected browser's extensions page. In each browser you use, turn on **Developer mode**, select **Load unpacked**, and choose the copied `%LOCALAPPDATA%\M9R\extension` folder. Then approve the requested site in the extension when you first use it.

To remove the web-managed broker, extension files, and MCP entries:

```powershell
m9r web uninstall
```

Use `m9r web setup --dry-run` to preview without writing files or starting processes. The same setup can be selected from the standalone installer with `.install-m9r.ps1 -Web`; the engine form is `m9r-engine.exe web setup` (or `m9r-engine.exe setup --web`).

M9R Web currently has working SessionStart identity bootstraps for Claude Code and Codex. OpenCode's MCP entry can be configured, but OpenCode SessionStart identity delivery is not implemented yet, so authenticated M9R web tools are not ready there.

## Manual appendix: Load unpacked and broker details

This is the development / Load unpacked path for Chrome and Edge. It connects the extension to the M9R broker running on the same PC. The development manifest pins a fixed ID, and the broker allow-lists that ID only. The Chrome Web Store build intentionally uses a different manifest (no development key), so it will need its own release broker allow-list before publication.

## 1. Prepare M9R

Install Node.js LTS, clone the M9R repository, and install its locked dependencies from PowerShell:

```powershell
cd C:\RunLeak\runleak   # replace with the folder where you cloned M9R
npm ci
```

Keep the repository folder in a stable location while using the unpacked extension. Its development ID can change if the folder moves.

## 2. Load unpacked in Chrome or Edge

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose `<M9R-repo>\extensions\browser` (for example, `C:\RunLeak\runleak\extensions\browser`).
4. Confirm the development ID shown on the extension card is `mahhaigfogjneccbmbpbedlnkhgdcmhb` in both Chrome and Edge.
5. Pin M9R if you want its panel visible in the toolbar.

When you first use a site, open the M9R panel and approve that origin in Chrome/Edge. The browser permission is origin-wide; M9R separately checks its own grant scope and action list. Only approve sites whose contents you are willing to expose to the agent you choose.

## 3. Start the local broker manually

In a PowerShell window, start the broker. Keep this process running while agents use browser tools.

```powershell
npx.cmd tsx scripts/m9r-web-broker.ts
```

The development manifest contains a fixed public key, so this build has the stable extension ID `mahhaigfogjneccbmbpbedlnkhgdcmhb`; the broker allows only that ID. Do not use `M9R_ALLOW_ANY_EXTENSION=1` outside isolated local development. The broker listens on loopback port `47821` by default; set `M9R_WEB_BROKER_PORT` before starting it only if you intentionally use another port.

## 4. Connect Claude Code

Find the Node executable with `where.exe node`, then replace the sample repo and Node paths below with the paths on this PC. In PowerShell, add M9R as a user-scoped stdio MCP server:

```powershell
claude mcp add --scope user --transport stdio m9r `
  --env 'M9R_HOME=C:\Users\<you>\.m9r' `
  --env 'M9R_WEB_BROKER_PORT=47821' `
  -- 'C:\Program Files\nodejs\node.exe' `
  --disable-warning=ExperimentalWarning `
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON `
  --import 'C:\RunLeak\runleak\scripts\register-alias.mjs' `
  'C:\RunLeak\runleak\scripts\m9r-mcp.ts'
```

Check it with `claude mcp list` and `/mcp` inside Claude Code. If the project asks you to approve the MCP server, review and approve it. The local M9R session bootstrap also needs to be installed and a new Claude session started; web tools require the session token supplied by its M9R SessionStart card. Do not put that token in the MCP config.

## 5. Connect Codex

Codex CLI, its IDE extension, and Codex desktop share `~/.codex/config.toml`. Add this table there, using the same Node/repository paths and M9R home directory as above:

```toml
[mcp_servers.m9r]
command = "C:\\Program Files\\nodejs\\node.exe"
args = [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  "--import",
  "C:\\RunLeak\\runleak\\scripts\\register-alias.mjs",
  "C:\\RunLeak\\runleak\\scripts\\m9r-mcp.ts",
]
cwd = "C:\\RunLeak\\runleak"
startup_timeout_sec = 20

[mcp_servers.m9r.env]
M9R_HOME = "C:\\Users\\<you>\\.m9r"
M9R_WEB_BROKER_PORT = "47821"
```

Restart Codex and check `/mcp` or run `codex mcp list`. As with Claude Code, keep the session token in M9R's session bootstrap, not this config.

## 6. Connect OpenCode

OpenCode v2 uses `mcp.servers`; older versions use the legacy `mcp.m9r` layout. The one-shot setup detects the installed CLI version and updates the matching user config. For this manual example, use the schema supported by your installed version. Replace `<M9R-repo>` and the Node executable path; use the supported `{env:...}` form for your Windows profile path.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "m9r": {
        "type": "local",
        "command": [
          "C:\\Program Files\\nodejs\\node.exe",
          "--disable-warning=ExperimentalWarning",
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          "--import",
          "C:\\RunLeak\\runleak\\scripts\\register-alias.mjs",
          "C:\\RunLeak\\runleak\\scripts\\m9r-mcp.ts"
        ],
        "cwd": "C:\\RunLeak\\runleak",
        "environment": {
          "M9R_HOME": "{env:USERPROFILE}\\.m9r",
          "M9R_WEB_BROKER_PORT": "47821"
        }
      }
    }
  }
}
```

Check with `opencode mcp list`. Older OpenCode releases may still use the legacy `mcp.<name>` layout from earlier M9R examples:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "m9r": {
      "type": "local",
      "command": ["<node-exe>", "--import", "<repo>\\scripts\\register-alias.mjs", "<repo>\\scripts\\m9r-mcp.ts"],
      "enabled": true,
      "environment": {
        "M9R_HOME": "<user-home>\\.m9r",
        "M9R_WEB_BROKER_PORT": "47821"
      }
    }
  }
}
```

The current OpenCode docs use `mcp.servers` and `disabled` for opting out; use the legacy form only if that matches the installed version's config schema. Avoid copying a demo's restrictive `permission` block into your everyday config unless you intend to disable those tools.

## 7. Verify a complete connection

1. Confirm the M9R broker says it is listening and the extension completes the ready handshake (the development build ID is fixed and pre-authorized).
2. Confirm the M9R MCP server appears in the provider's MCP panel/list.
3. Start a fresh agent session so it receives its M9R identity card. Never copy a session token into source control or a shared config file.
4. Ask the agent to call `m9r_web_open` on a harmless test page, approve the browser's site prompt, then use `m9r_web_read`. Use `m9r_web_type` and `m9r_web_click` only on a test form.
5. Use the extension panel's **Stop all browser actions** control to stop future broker actions. An action already dispatched to the page can still finish; restart the broker to resume.

The extension does not make an agent's provider account available to M9R. Each provider remains logged in and operates under its own account, quota, and data-handling policy.

## Official configuration references

- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [Codex MCP documentation](https://developers.openai.com/codex/mcp)
- [OpenCode MCP server documentation](https://opencode.ai/v2/docs/mcp-servers)
