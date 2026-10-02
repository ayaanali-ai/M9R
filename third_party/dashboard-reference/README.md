# Dashboard UI source attribution

Source: OpenMausBot, https://github.com/milind-soni/OpenMausBot (main, retrieved 2026-10-01).
Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see LICENSE and the retained upstream NOTICE.

## Imported source

The files in `src/components/product/dashboard-chrome/` include upstream `src/components/CursorAvatar.tsx`, `src/components/cursor-face-data.ts`, and `shared/mascot-bodies.ts`. CursorAvatar adds a Next.js client directive, attribution, and a local import path. The generated face and body data are retained.

CursorAvatar also replaces an empty interface with an equivalent type alias to satisfy the host lint rules.

## Adapted presentation

`Chrome.tsx`, `DashboardModels.tsx`, and `dashboard-chrome.css` adapt the sidebar, chat header, model menu, message bubbles, and composer presentation to M9R props, routes, and authenticated APIs. They do not import the Electron bridge or agent runtime.

Reference Git blob hashes:

| Upstream file | Blob |
| --- | --- |
| src/components/Sidebar.tsx | d53ee705f3676493f89f7a367cb4d03205e78c10 |
| src/components/ChatView.tsx | eb53fdab8fa7558e0465b30a2a9b81863e9fc206 |
| src/components/Composer.tsx | 666383d2b0f874771c8fc8264cc439e3c82bc13d |
| src/styles.css | f6722295f04554a255fc6bc398b276261163dd15 |
| src/components/Avatar.tsx | aab3ec4aa967d13fa965cd4c97b17ac26454e87a |

The upstream NOTICE is preserved verbatim and describes dependencies of the full upstream project; those descriptions do not imply every referenced dependency was imported into M9R. M9R retains its own name, logo, permissions, and network runtime.
