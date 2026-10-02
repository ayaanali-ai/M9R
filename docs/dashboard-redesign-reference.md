# Item 8 — M9R dashboard reference and implementation

Updated 2026-10-02. Local implementation; visual acceptance and authenticated workflow sign-off remain pending. This replaces the earlier recoloring pass.

## Reference and attribution

- Source reference: OpenMausBot, https://github.com/milind-soni/OpenMausBot
- Visual reference: https://docs.openmausbot.com/screenshots/docs-fresh-bot.png
- Imported CursorAvatar, expression data, and mascot body definitions; adapted Sidebar, ChatView, Composer, and model-picker presentation.
- Apache-2.0 license, upstream NOTICE, source paths, and reference blob hashes are recorded in third_party/dashboard-reference/.
- The dashboard chrome uses neutral window controls without a brand mark or name.

## Implemented locally

- Single 320px sidebar, 56px cursor mascots, searchable contacts, selected conversation treatment, bottom destinations and account menu.
- Compact header with 28px mascot, thread/model pickers, computer/review actions, and overflow controls.
- Source Midnight palette, Inter typography, rounded message bubbles, muted date separators, and slim capsule composer.
- Live shell and conversation use shared components. Existing send, attachment, mention, review, and panel handlers remain in place.
- Model picker reads connected agents and reported model lists; changes use the existing authenticated connection model API.
- Activity opens the real inbox. New channel opens the existing creation dialog across dashboard routes. Both consume their URL action once.
- Development-only /design/dashboard provides the reference onboarding scene with explicit sample data. Its local interactions are not live agent operations.
- Scrollbars follow the selected light/dark theme; reduced-motion preferences are respected.

## Evidence and limits

- TypeScript passed after the component import. No functional test suite was added or run in this continuation.
- Scoped lint identified a render-time ref callback and an empty upstream interface; both were corrected. Rerunning lint on those two files passed with one upstream unused-variable warning. The initial full scope also reported two existing ConversationPanel warnings.
- Local preview returned HTTP 200 and rendered in the browser. Compared with the official screenshot at 1280 by 720; adjusted sidebar search, greeting indentation, question position, and composer height.
- Scoped git diff --check passed.
- The prior production-build result predates this source-based rewrite and does not validate the current version.
- Authenticated message delivery, model switching, approvals, and deployed appearance remain unverified in this continuation.

## Remaining differences

The reference's call controls, cloud-computer provisioning, integrations, and automation backends were not imported. The preview demonstrates the reference scene; it does not establish that every reference feature exists in M9R. Final visual approval remains with the user.
