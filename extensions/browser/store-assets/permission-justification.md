# Store permission justifications

| Permission or access | What it is used for in the code | Scope and caveat |
|---|---|---|
| `tabs` | Read the current site of a tab to enforce which sites the owner allowed; find the active tab; create and update M9R-managed tabs; open the one-time microphone setup page. | Tab URLs are sensitive; they are used only for site checks and never stored. |
| `scripting` | Inject the extension's own packaged overlay and page-action code into sites the owner has allowed. | No remote code is fetched or evaluated; all injected files ship in the package. |
| `alarms` | Wake the service worker periodically to keep the connection to the local M9R app alive. | Connection maintenance only. |
| `storage` | Keep named-tab mappings across service-worker restarts, the pill's position and open state, the motion preference, hidden message previews, whether the all-sites question was asked, and a short local log of Alt+M / Alt+N presses for troubleshooting. | No page text, form values or browsing history; the key log holds no typed text and can be cleared. |
| Required `http://127.0.0.1/*`, `http://localhost/*` | Connect to the local M9R app at `ws://127.0.0.1:47821` and show the overlay on the owner's own local pages. | Loopback only; not access to other sites. |
| Optional `http://*/*`, `https://*/*` | Requested at runtime, for a site the owner chose (or all sites if the owner explicitly clicks Allow all websites for agent research). | Never granted at install. Chrome's grant is per site; M9R also limits each approved grant by action, path and time. |
| `web_accessible_resources`: `pill.html`, `composer.html`, `assets/providers/*.svg` (http/https pages) | The thread pill and the message bar are extension pages shown in a frame on the page, so a website's own scripts cannot read what the owner types. The provider badges are the small agent icons on cursors. | Only these three resources are exposed; no scripts, no other pages. The frames accept commands only with a per-tab secret that the extension's own content script registers. |
| Microphone (web API, not a manifest permission) | Push-to-talk while Alt+M is held, in the message bar's frame; turned on once from an extension page. | Speech is recognised by Chrome's speech service; the extension never receives or stores audio. |

Not requested: cookies, history, debugger, downloads, native messaging, `activeTab`, or access to all sites at install. No remote code is loaded. Recheck this table against the packed manifest and the code immediately before every submission.
