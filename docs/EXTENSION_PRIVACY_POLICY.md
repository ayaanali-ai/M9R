# M9R browser extension privacy notice

**Draft for the public `/privacy/extension` page. Replace every bracketed value before publishing.** This template describes the current extension/broker workflow; it is not legal advice.

- Publisher: **[legal publisher name]**
- Contact: **[public privacy/support email]**
- Effective date: **[YYYY-MM-DD]**

## What this extension does

M9R Web Presence connects your browser to the M9R broker running on your computer. When you authorize a browser task, the extension can display agent presence and messages, open pages, read requested page text, click eligible controls, and type text you supplied. The extension requires the local M9R broker and does not run an AI model by itself.

## Information handled

For the browser task you request, the extension may handle:

- page URLs and origins used to enforce the approved site and path;
- page text returned by a requested read, including text in ordinary visible fields when explicitly targeted;
- the requested action, target selector, action result, and any text you ask the agent to type;
- agent/provider labels, presence, short M9R messages, and session identifiers used by the on-page display;
- your site-permission and message-preview visibility choices.

The extension refuses targeted reads or typing for hidden and password inputs and fields marked with payment-card, one-time-code, or password autocomplete values. These are targeted safeguards, not a guarantee that other page text or ordinary fields are free of sensitive information. Do not run an agent on a page unless you are comfortable sharing the requested content with that agent.

## How information is used and shared

The extension uses this information only to carry out the browser workflow you requested and show its on-page presence UI. It sends browser messages to the local broker at `ws://127.0.0.1:47821/ext` over the computer's loopback interface. The broker passes requested page results and task data to the M9R agent session you selected; that agent/provider may process the information under its own account settings, terms, and privacy policy. M9R collaboration services may also receive information when you explicitly use a shared M9R workflow. The extension itself does not directly send page data to a remote M9R collection endpoint and contains no analytics or advertising code.

The local extension-to-broker WebSocket is not TLS-encrypted. It is restricted to loopback on the same computer. Do not use this local setup on a shared or untrusted computer. Any onward transmission by an agent, provider, or M9R collaboration service is outside the extension's direct connection and follows that service's own terms and transport.

## Storage and retention

The extension does not store page text, form values, or browsing history. It stores named-tab-to-tab-ID mappings in Chrome session storage to resume tabs across service-worker restarts; Chrome clears this storage when the extension is disabled, reloaded, updated, or the browser restarts. It stores hidden-message-preview choices as M9R session identifiers in Chrome local extension storage until you clear the extension's data. Temporary presence-message display is held in memory and expires after a few seconds. The local broker and the selected agent/provider may maintain their own logs, records, or retention periods; consult those products' settings and policies.

## Your controls

Chrome site access is requested only when needed and only for the selected HTTP/HTTPS origin. Chrome's grant covers the whole origin; M9R separately enforces its approved actions, path, and expiry. You can revoke the Chrome site permission and the corresponding M9R grant to block future access. Use the extension's **Stop all browser actions** control to stop new broker actions; an action already sent to a page may still finish. Revocation or stopping cannot retract information already delivered to an agent, provider, or collaborator.

## Permissions

The extension uses `tabs` to find and manage M9R tabs and check their URLs, `scripting` to inject its packaged presence/action code after access is granted, `alarms` to maintain its local broker connection, and `storage` for tab mappings and preview preferences. Required host access is limited to the local broker; normal HTTP/HTTPS site access is optional and requested at runtime. The extension does not request cookies, browsing-history, debugger, or download permissions.

## Contact and changes

For privacy questions or requests, contact **[public privacy/support email]**. This notice will be updated if the extension's data handling changes.
