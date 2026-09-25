# Browser extension store readiness — 2026-09-23

This is a policy and packaging readiness review for the current M9R dev extension, not a legal opinion or a prediction of store acceptance. Store rules and forms change; re-check each primary source immediately before submission.

## Current extension versus a real-site release

The current `extensions/browser/manifest.json` is explicitly a localhost development build. It declares `tabs`, `scripting`, and `alarms`, grants `http://localhost/*` and `http://127.0.0.1/*`, and injects packaged content scripts only on those local origins. That is appropriate for the current test page, but it cannot act on normal HTTPS sites.

For a real-site release, the extension needs host access for the page in which it will read or act. Chrome documents `scripting` plus host permission (or temporary `activeTab` access) for injecting code. Because M9R acts from an owner-authorized agent flow rather than only a click on the current tab, the practical design is declared optional HTTP/HTTPS host patterns and a user-initiated per-site runtime request when the owner creates/approves a grant. The manifest can declare `optional_host_permissions: ["https://*/*", "http://*/*"]`; after the owner chooses `https://shop.example`, request only `https://shop.example/*` with `chrome.permissions.request`. Chrome ignores paths in requested origin patterns, so this is origin/site permission, not path-level isolation. M9R's own grant check must continue enforcing action, origin, expiry, and any future path scope. [Chrome scripting permission requirements](https://developer.chrome.com/docs/extensions/reference/api/scripting), [Chrome optional permission API](https://developer.chrome.com/docs/extensions/reference/api/permissions)

The current development manifest now declares optional HTTP/HTTPS site hosts while retaining required localhost access for its local demo. After `m9r-cli web approve` persists a cross-owner grant, the broker notifies the connected extension; the extension opens a per-grant consent page and asks Chrome for exactly that origin from a user click. If no extension is connected at approval, active grants are offered when its authorized socket reconnects. A denial is reported to the local broker and revokes that grant. Before every browser action, the extension checks `chrome.permissions.contains`; it also rechecks the grant's origin/path and the broker independently enforces the same path boundary. The toolbar popup can separately grant the active site to the browser owner's own agents. This is a development implementation, not a reviewed or packaged store release.

### Consent prompt copy

The extension's M9R screen says:

> Allow M9R on this site? An M9R agent grant was approved for: [site]. Chrome's site permission covers the entire site, not just the approved path. M9R will still enforce the grant's listed actions, path, and expiry locally. The agent may read visible page content and use the approved page controls; passwords and other sensitive fields remain blocked.

The button is “Continue to Chrome permission”; Chrome then shows its own host-access warning. “No thanks” does not grant access and stops the pending M9R grant. Because Chrome's host permission is site-level and ignores URL paths, the prompt deliberately makes that broader browser permission clear; `/cart` remains an M9R-enforced boundary, not a Chrome boundary. [Chrome requires optional permissions to be requested from a user gesture](https://developer.chrome.com/docs/extensions/reference/api/permissions)

`tabs` is currently used to create/update/find tabs and inspect their URL. Chrome says most Tabs API methods do not need the `tabs` permission; the permission exposes sensitive tab properties such as URL/title/favicon across tabs, while a matching host permission can expose those properties for that site. Keep `tabs` only if the shipping implementation truly needs cross-site tab metadata beyond sites the user granted; test removing it after the per-site permission flow exists. `scripting` is required for the current injection method and `alarms` is required for the keepalive alarm in `background.js`. [Chrome Tabs API permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Chrome alarms permission](https://developer.chrome.com/docs/extensions/reference/api/alarms)

## Single purpose and permission justification

Chrome expects one clear, narrow purpose and the minimum permissions needed for that purpose. The user-facing purpose should be stated plainly: “Let the user-approved M9R agents read or act on a site the browser owner explicitly granted, and show where those agents are acting.” Do not position this package as a generic browser automation extension while requesting broad page access. The listing, in-product explanation, permission prompt timing, and behavior must all tell the same story. Store policies apply across the extension and its associated listing/marketing experience; meeting the written checklist does not guarantee approval. [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies)

Recommended permission sequence:

1. Install with no host access to ordinary sites. Keep only APIs needed for baseline connection and tab management; validate whether `tabs` can be removed or made optional after per-origin permissions are implemented.
2. When an owner approves a grant for a site, explain the exact host and permitted operations in M9R UI, then call `chrome.permissions.request` from that direct user gesture for that origin only.
3. If permission is declined or removed, fail closed for that site and keep the grant inactive; do not silently fall back to broader access.
4. Request no cookies, browsing history, debugger, or all-sites required host permission for the first public release. Avoid static content-script matches for every site; inject only after the specific host permission is granted.

## Page content and form disclosures

Chrome's user-data policy treats website content/resources, form data, and browsing activity (including sites/URLs interacted with) as user data. Its FAQ says local-only processing still requires disclosure of how data is handled. M9R's behavior includes reading selected page text and, with `type` grants, inserting user-provided text into page controls. That warrants a clear pre-permission disclosure and a privacy policy describing what is read, what is sent to an agent or teammate, when it is retained, and how revocation/deletion work. The listing's data declarations, privacy policy, and actual behavior must agree. Do not claim “local-only” if an agent/provider or M9R relay receives page text. [Chrome User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [Chrome User Data Policy](https://developer.chrome.com/docs/webstore/user_data)

The disclosure should appear before the owner accepts the site permission, not only buried in policy text. State specifically that page text/selected content and URLs can be shared with the connected agent/provider, that allowed form text may be entered, that M9R does not intentionally read password fields, and that page content can still contain sensitive information. The actual implementation needs to match that promise; the current read tool can return non-password input values, so the “does not read passwords” language must not be broadened to “cannot access form data.” Chrome's Limited Use rules constrain use/transfer to the extension's clearly described user-facing function and disallow unrelated advertising or monetization uses. [Chrome User Data Policy](https://developer.chrome.com/docs/webstore/user_data)

## Manifest V3 and remote code

Chrome's MV3 store rules require the extension's functionality to be discernible from submitted code. The packaged extension may exchange data and commands with M9R, but executable logic must remain in the reviewed package unless a specifically documented API exception applies. Do not download JavaScript, evaluate server-provided strings, or create an interpreter for remote “actions.” Keep the command schema declarative and narrow (read/click/type plus validated selectors/values), validate it locally, and ship all action logic with the extension. [Chrome MV3 additional requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

## Privacy policy, disclosures, and review

Before submission, publish a reachable privacy-policy URL and align its data inventory with the Chrome dashboard privacy/data-use disclosures. Chrome's current policy materials require privacy disclosures for handled sensitive user data, including data kept locally, and describe Limited Use expectations. Supply accurate single-purpose text, permission justifications, support/contact information, and test instructions/accounts if reviewers need them. Expect review and possible questions; neither an unlisted release nor policy compliance guarantees approval. [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies), [Chrome User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [Chrome submission steps](https://developer.chrome.com/docs/webstore/publish/)

For Edge Add-ons, Microsoft's policy also requires permissions essential to the extension's declared function, appropriate data-handling disclosure, secure handling, and a privacy policy where personal information is accessed/transmitted/collected. The Partner Center listing asks for purpose, permissions, data collection, and a privacy URL when applicable. [Microsoft Edge Add-ons developer policies](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies), [Publish an Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)

## Distribution alternatives

- **Chrome Web Store unlisted:** the item is not listed in store search, but anyone with its URL can install. It still goes through the same review and policy requirements as other visibility modes; it is not a review bypass. It is a useful controlled pilot channel after policy readiness. [Chrome distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- **Chrome private distribution:** limits installs to specified trusted testers and is intended for testing; it likewise has the same policy requirements and review process. [Chrome distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- **Managed enterprise rollout:** Chrome enterprise administrators can deploy and control extensions through browser management policies; this is for managed organizations, not a substitute for a consumer install channel. [Chrome Enterprise extension management](https://support.google.com/chrome/a/answer/9039146?hl=en), [Chrome extension policies on Windows](https://support.google.com/chrome/a/answer/7532015?hl=en)
- **Edge external/enterprise distribution:** Microsoft documents external installation methods for software bundles and administrators, but managed-device and allow-list/policy restrictions apply. Treat this as an organization-led pilot, not as broad consumer self-hosting. [Edge alternate distribution](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options), [Edge self-hosted extensions](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-manage-extensions-webstore)

## Minimal-permission manifest plan

Keep the development manifest localhost-only. For a separate production manifest/build:

```json
{
  "manifest_version": 3,
  "permissions": ["alarms", "scripting"],
  "optional_host_permissions": ["https://*/*", "http://*/*"]
}
```

This is a target shape, not a drop-in manifest: preserve `background`, icons, and other packaging metadata; remove broad required host access and static all-site content scripts; add only the browser APIs demonstrated as necessary. Prefer omitting `tabs` if the extension can operate from tab IDs it created and access a tab URL under that site's optional host grant. If the shipped workflow must discover or inspect arbitrary tabs, retain/request `tabs` only after explaining that broader capability and test the warning surface. Prompt for one exact site from a direct owner action; do not request all-site access at install. Chrome's optional host permission syntax can declare wildcard schemes and request an individual origin later. [Chrome permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions), [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)

## 2026-09-24 packaging prototype

Added a separate production-oriented manifest template and local packaging helpers so the localhost development manifest remains unchanged. The template has no static content-script matches, keeps only loopback host access required by the current local WebSocket broker, declares per-site HTTP/HTTPS access as optional, and includes `tabs`, `scripting`, and `alarms` used by the current implementation. The build script packages only `permission.html`, `src/`, the generated manifest, and 16/32/48/128 PNG icons; it excludes the local test page. Icons are resized from the existing M9R star mark using the repository's already-installed `sharp` tooling; no dependency was added.

Draft assets now live under `extensions/browser/store-assets/`: a listing, a permission justification, a privacy policy with required publisher/contact/URL placeholders, and a manual screenshot capture checklist. `scripts/stage-browser-store-screenshots.mjs` only validates and stages manually captured PNGs; it does not launch a browser or manufacture screenshots. `scripts/build-browser-store-package.mjs` produces a ZIP and explicitly reports that packaging is not browser testing or submission.

**Still not store-ready:** the local broker/WebSocket integration has not been loaded and tested against the generated store manifest in Chrome; permission warning copy and the final data-use declarations need a release-build review; the public privacy/support URLs and publisher contact are missing; real screenshots have not been captured; Chrome's current dashboard requirements must be confirmed at submission time. This prototype was not submitted. Whether `tabs` can be removed remains unverified.

**Unverified / follow-up:** whether the current extension can remove `tabs` without changing tab selection/URL behavior; the current `background.js` uses `chrome.tabs.get(...).url` and therefore needs a matching site host grant or `tabs`. No Chrome or Edge submission has been made, no review feedback exists, and no legal conclusion about all jurisdictions is implied here.

## 2026-09-24 sprint update

The owner permission screen now includes a prominent explanation that requested page text, URLs, and action data can be shared with the selected agent/provider and authorized collaborators; the extension does not send page data merely because the Chrome permission is granted. The store package has a deterministic ZIP builder, explicit manifest allowlist checks, and tests for the narrow permission boundary. Provider display names/badge asset slots, agent-message previews, the compact who's-here bar, and owner stop-all controls are present in the extension code.

See [`M9R_STORE_SUBMISSION_CHECKLIST.md`](../M9R_STORE_SUBMISSION_CHECKLIST.md) for the current dashboard copy, package/upload steps, privacy disclosures, and open launch gates. The public policy text is [`EXTENSION_PRIVACY_POLICY.md`](EXTENSION_PRIVACY_POLICY.md); it still contains publisher/contact/effective-date placeholders. Screenshot staging now accepts only manually captured 1280x800 PNG files. The exact ZIP has not been installed in Chrome, no screenshots or promotional assets have been captured, and no store submission has occurred.

Chrome's published User Data FAQ says encryption is not required for transmission between an extension and a native program on the same computer. M9R currently uses a loopback WebSocket to a local Node broker rather than Chrome Native Messaging; confirm that this arrangement falls within the exception before certifying policy compliance. The extension itself does not directly send page data to a remote endpoint, but the selected agent/provider may process or transmit it under its own policy.
