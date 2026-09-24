# M9R Web Presence privacy policy — draft

**Status: draft; not a published policy or legal advice.** Before store submission, replace every bracketed field, publish this text at a stable HTTPS URL, and verify it against the exact release build and the store's current data disclosures.

- Publisher/legal entity: **[M9R publisher legal name]**
- Contact: **[privacy/support email]**
- Effective date: **[date]**
- Public policy URL: **[HTTPS policy URL]**

## What the extension does

M9R Web Presence connects a browser to the M9R service running on the same computer at `127.0.0.1:47821`. It can show presence markers for connected agents and carry owner-authorized browser commands to a tab. It is not a standalone agent and requires the local M9R browser broker.

## Information handled

When the owner uses an M9R browser workflow, the extension may handle:

- the URL and origin of a tab M9R is opening or controlling, to enforce the approved site and path;
- page text requested by an agent, including visible text and the value of a specifically selected non-sensitive input or textarea;
- the selector and action requested (`open`, `read`, `click`, or `type`), and a bounded action result or error;
- text supplied for an approved type action;
- agent labels and target positions/selectors used to display presence markers;
- the site permission decision made by the browser owner.

The extension refuses targeted reads or typing for hidden/password inputs and fields marked for payment-card, one-time-code, or password autocomplete. This is a targeted-field safeguard, not a guarantee that page text or ordinary visible fields contain no sensitive information.

## Where information goes

The extension sends browser messages to the local M9R broker over loopback WebSocket. Depending on the owner's M9R configuration and the action requested, the broker may deliver page text, URLs, action results, or owner-supplied text to the connected agent/provider and to authorized M9R collaborators. Those recipients may process the information under their own terms. The extension does not control or independently verify onward handling by those systems. Do not use M9R on pages or with content you are not comfortable sharing with the selected agent and collaborators.

The extension package contains no analytics or advertising code and does not intentionally send browser data to an M9R-operated remote collection endpoint. The local broker is the extension's configured network destination. Chrome site access is requested per origin when needed; Chrome's permission covers that entire origin, while M9R separately checks the approved action/path/expiry.

## Storage, retention, and deletion

This extension does not write page content or browser history to `chrome.storage` or to an extension-owned remote database. It stores only M9R tab-name-to-tab-ID mappings in Chrome's session-only storage so a service-worker restart or a retried command reuses the same tab; Chrome clears this storage when the extension is disabled, reloaded, updated, or the browser restarts. Pending permission prompts remain in service-worker memory and can be lost when Chrome suspends or restarts the worker. The local M9R broker, agent/provider, and M9R collaboration services may have their own logs or retention behavior. Check their applicable settings and policies; this extension cannot promise their retention or deletion behavior.

Revoke a site's Chrome permission in Chrome's extension/site-access settings and revoke the corresponding M9R grant in M9R. Revocation blocks future extension actions but cannot retract information already delivered to an agent, provider, or collaborator.

## Permissions

`tabs` supports finding and updating M9R-managed tabs and checking their URLs. `scripting` injects the packaged presence/action code into an explicitly permitted page. `alarms` periodically reconnects the local broker. `storage` keeps only session-scoped names for M9R-managed tabs across service-worker restarts. Loopback host access connects to the local broker; optional HTTP/HTTPS host access is requested for a chosen site when the owner approves access. No cookies, browsing-history, debugger, or download permission is requested.

## Changes and contact

We will update this policy when the extension's data handling changes. For privacy questions or requests, contact **[privacy/support email]**. This draft must not be submitted or presented as a final policy until the publisher, contact, date, and public URL are supplied and the release behavior has been re-audited.
