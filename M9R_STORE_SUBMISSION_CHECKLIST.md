# M9R Web Presence — Chrome Web Store submission checklist

Status: the package is reproducibly buildable and the store manifest is statically guarded. This is not a submission or an approval prediction. The dashboard has not been used, screenshots are not staged, and publisher/support/privacy details still need your real values.

## Package to upload

Build to a new path so the existing candidate ZIP is not overwritten:

```powershell
node scripts/build-browser-store-package.mjs dist/m9r-web-presence-store-2026-09-24-final-v2.zip
```

Upload `dist/m9r-web-presence-store-2026-09-24-final-v2.zip` in Chrome Web Store Developer Dashboard → **Add new item** → **Choose file**. Do not upload `extensions/browser/store-assets/m9r-web-presence-0.1.0-candidate.zip`; this sprint created separate fresh artifacts and left the existing file untouched. The builder uses a fixed UTC ZIP timestamp, normalized lexical entry ordering, a separate MV3 manifest template, generated PNG icons, and no test page. The package builder test builds it twice and checks byte-for-byte identity.

## Store listing tab — fields to enter

| Dashboard field | Paste/select |
|---|---|
| Name | `M9R Web Presence` |
| Short description | `Connect your approved M9R agents to browser pages you choose.` |
| Detailed description | Paste the **Detailed description** from [`extensions/browser/store-assets/listing-draft.md`](extensions/browser/store-assets/listing-draft.md). |
| Primary category | `Productivity` |
| Language | `English (United States)` |
| Store icon | `icons/icon-128.png` generated inside the ZIP (128×128). |
| Screenshots | 1–5 real screenshots, each 1280×800. Capture synthetic/demo content only; stage using `node scripts/stage-browser-store-screenshots.mjs <source-folder> <destination-folder>`. None are currently staged. |
| YouTube promotional video | **Pending.** Current Chrome listing documentation lists a YouTube feature-video URL; prepare one or confirm the live dashboard marks it optional before submit. |
| Small promotional tile | **Pending.** Current Chrome listing documentation lists a 440×280 PNG/JPEG; prepare it or confirm the live dashboard marks it optional. |
| Marquee promotional tile | Optional in Chrome's listing documentation; if used, 1400×560 PNG/JPEG. |
| Homepage URL | `[public M9R product URL]` — only enter a live page describing this extension. |
| Support URL | `[public support URL]` — must be reachable and monitored before submission. |
| Official URL / verified publisher | Leave unset until a site is verified to the publisher account. |
| Mature content | `No` if the final content and demo remain as described. |

The current Chrome documentation says a listing needs a 128×128 icon, at least one 1280×800 screenshot (up to five), a YouTube video URL, and a 440×280 small promo tile; the 1400×560 marquee tile is optional. The Developer Dashboard is the final authority for fields shown to this account, so recheck it when uploading. [Store listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)

## Privacy practices tab — fields to enter

| Dashboard field | Paste/select |
|---|---|
| Single purpose | `Connect the user's browser to the local M9R broker so agents the user authorizes can coordinate on that user's browser task.` |
| `tabs` justification | `Find the owner's active tab, create and update M9R-managed tabs, and check tab URLs/origins so the broker can enforce the owner's selected browser task and grant.` |
| `scripting` justification | `Inject the extension's packaged presence and page-action code into an HTTP/HTTPS page only after the owner has granted that site; no executable code is downloaded.` |
| `alarms` justification | `Reconnect and maintain the extension's connection to the local M9R broker.` |
| `storage` justification | `Retain M9R named-tab IDs across service-worker restarts and store the owner's hidden-message-preview preference; the extension does not persist page text or form values.` |
| Required host access | `http://127.0.0.1/*` and `http://localhost/*` connect to the local broker only. |
| Optional host access | `http://*/*`, `https://*/*`; requested at runtime for the one selected origin after an owner action. Chrome's grant is origin-wide; path/action limits are enforced separately by M9R. |
| Remote code | Select **No**. The packaged extension includes its executable code; do not add runtime-loaded scripts or eval-based code. |
| Data categories | Disclose at minimum **Website content** and **Web browsing activity**. Also select the dashboard's **Form data**, **Personal communications**, **User-generated content**, **Personal information**, **Financial/payment**, **Authentication**, or other categories whenever content the extension can read includes them. The field-value guards are targeted, not a guarantee that arbitrary page text contains no such data. Do not certify “no data collected.” |
| Data use / Limited Use statements | Certify only after confirming each statement against the release behavior: use is for the user-requested browser feature; no sale, advertising, or unrelated profiling; sharing with the selected agent/provider and authorized M9R collaborators is disclosed. |
| Privacy policy URL | `[public HTTPS URL for /privacy/extension]`; host the text in [`docs/EXTENSION_PRIVACY_POLICY.md`](docs/EXTENSION_PRIVACY_POLICY.md) after replacing its publisher, email, and effective-date placeholders. |

Chrome requires a narrow single purpose, minimum permissions, accurate data disclosures (including local handling), and a privacy policy for user-data handling. Its User Data FAQ says transfers between an extension and a native program on the same computer do not need encryption; the current extension connects by loopback WebSocket to a local Node broker, so confirm that the reviewer considers this arrangement covered by that exception. Separately review any onward transmission by the selected agent/provider or M9R collaboration path. [Privacy dashboard fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [permission guidance](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions/)

## Distribution tab — recommended pilot values

- Price: **Free**.
- Visibility: **Unlisted for an initial controlled pilot**, then change to Public only after the install, consent, and reviewer path are proven. Unlisted still requires review and is not a policy bypass.
- Regions: all regions where you intend to support and respond to users; choose a narrower list if support/legal coverage is not ready.
- Test instructions: explain that the extension requires the local broker and an already-authenticated agent CLI. Use a synthetic, non-sensitive page and account. Do not provide real provider credentials or customer data. A reviewer-ready self-contained test environment has not yet been prepared.
- Publishing: choose deferred/manual publishing if available so approval does not automatically make the listing public.

## Before clicking “Submit for Review”

- [ ] Replace publisher/contact/date/URL placeholders; publish the policy over HTTPS and make sure it loads without sign-in.
- [ ] Create a monitored support URL and a reviewer test path. The product currently relies on a local Node broker; reviewer setup is still an open readiness item.
- [ ] Capture real, sanitized extension screenshots and prepare the current dashboard's required promo media.
- [ ] Build the ZIP to a fresh path; run its package test and install that exact ZIP in an isolated Chrome profile.
- [ ] Verify the store manifest, each permission warning, permission prompt disclosure, per-origin runtime permission, no-remote-code behavior, agent presence/messages, and stop-all behavior in Chrome.
- [ ] Match the privacy policy, in-product disclosure, store listing, and dashboard data categories to the exact build. Include onward sharing with the chosen provider.
- [ ] Confirm the loopback Node broker transport is acceptable under the applicable Chrome user-data rule; do not claim encryption for `ws://`.
- [ ] Review ownership/authorization for all listing graphics, brand marks, demo content, and any video.
- [ ] Submit with deferred publishing; wait for actual review feedback. A static manifest check is not a Chrome Web Store approval.

## Static manifest assessment

The store template is MV3; it has no `content_scripts`; install-time site access is limited to loopback; HTTP/HTTPS sites are optional and requested at runtime; there are no cookies/history/debugger/download permissions; and the only web-accessible resources are the three static provider badge SVGs. The build guard rejects extra permissions, broad required hosts, static all-sites injection, external connections, or exposing script files. This is a structural check against the current template, not an official Chrome validator or review result. `tabs` still exposes tab metadata, so keep its justification tied to behavior and revisit minimization before public release.
