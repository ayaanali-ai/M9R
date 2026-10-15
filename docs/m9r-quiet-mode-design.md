# Independent browser input

## Current behavior

Browser click-like actions are sent to the requested Chrome tab through the extension's allow-listed `chrome.debugger` input helper. The extension does not invoke the native input host, and its manifest no longer requests `nativeMessaging`. The visible agent cursor is the in-page M9R overlay; it is separate from the owner's physical mouse.

The owner must enable **Independent browser input** from the extension panel. Chrome grants the optional `debugger` permission from that user gesture and shows its debugging banner while attached. If the setting or permission is off, Chrome refuses the attachment, DevTools already owns the tab, or the page cannot be debugged, M9R returns an error. There is no physical-mouse fallback.

This changes browser-page input only. It does not provide an independent Windows OS pointer, desktop-app input, or a claim that the full desktop cursor path is isolated from the owner's mouse.

## Click safety and delivery

1. The worker checks the requested site grant and plans a visible, enabled page target.
2. It records the target identity and URL, then animates the labeled in-page cursor to the planned location.
3. After cursor travel and immediately before each press, it rechecks Stop All, the tab URL, the site grant, target identity, and hit-test result.
4. It sends the click to that exact tab with the allow-listed Chrome debugger API. It does not require that tab to become the foreground tab.
5. Chrome disconnects during input produce an `input_outcome_unknown` refusal. The helper does not replay a click or text insertion because the first input may already have landed. A release may be attempted as cleanup after an uncertain press; the press is never repeated automatically.

Stop All marks existing debugger sessions stopped before detaching them. A fresh running broker state resumes those sessions; an owner-cancelled Chrome debugging banner remains cancelled until separately re-enabled.

## Permission and failure behavior

- The `debugger` permission is optional and requested only after the owner enables independent browser input.
- Ordinary site grants and consequential-action approvals remain separate checks.
- Browser clicks are refused with `quiet_input_required` while independent input is disabled or unavailable.
- Debugger conflicts, restricted browser pages, changed targets/grants, owner stop, and uncertain input outcomes return failures. None silently escalate to a native click.
- The debugger command allow-list lives in `extensions/browser/src/quiet-input.js`. Agents never receive direct CDP access.

## Verification boundary

Automated coverage is in `scripts/web-broker-extension.test.ts` and `scripts/quiet-input.test.js`. These tests verify route selection, no native-input fallback, target/grant revalidation, exact tab targeting, Stop All, and no automatic replay after an uncertain input result.

Those tests do not prove live behavior in the owner's installed Chrome, physical-pointer stability on every machine, or desktop-app control. Those still require live acceptance before the browser path or M9R as a whole is called demo-ready.
