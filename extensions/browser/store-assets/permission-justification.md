# Store permission justifications — draft

| Permission | User-facing need in the current code | Scope and caveat |
|---|---|---|
| `tabs` | Find the active tab for the owner's permission flow, retain M9R-managed tab IDs, create/update managed tabs, and verify current URLs/origins. | Tab metadata is sensitive. Revisit whether it can be narrowed; the current implementation uses tab URL checks and owner active-tab lookup. |
| `scripting` | Inject packaged presence and page-action functions into a tab after site access is granted. | The extension ships the code; no remote executable code is fetched. |
| `alarms` | Wake the service worker periodically to reconnect/ping the local M9R broker. | Used for connection maintenance, not user tracking. |
| Required `http://127.0.0.1/*`, `http://localhost/*` host access | Connect the extension to the local broker at `ws://127.0.0.1:47821/ext`. | Verify Chrome's exact permission warning and WebSocket matching on the release build. It is not permission to read arbitrary localhost page content by itself. |
| Optional `http://*/*`, `https://*/*` host access | Allow M9R to request one chosen site origin after the owner initiates/approves a site grant. | Broad patterns are declared as optional only; runtime requests must stay origin-specific. Chrome permission is origin-wide; M9R applies its own path/action/expiry checks. |

Not requested: cookies, history, debugger, downloads, or all-sites access as a required install permission. Recheck this table against the packed manifest and every API call immediately before submission.
