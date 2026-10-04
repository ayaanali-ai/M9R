# Dashboard v2: plan for approval (nothing built yet)

2026-10-03. Based on the running app (signed in, localhost:3000) and the source. A mockup of the proposed look is `docs/dashboard-v2-mockup.html`.

## 1. What is on the dashboard today

Counted from the code and the live pages.

| Area | What is there now | Size |
|---|---|---|
| Sidebar | Channel list (General, Agents, Activity, Demo), All conversations, Memory, Connected agents, account | `ProductShell.tsx`, 576 lines |
| Top of chat | **Agent endpoints** strip, **Finish setting up M9R** card, **Recent native activity** list | `WorkspaceEndpointCard`, `DashboardOnboarding`, `MachineConnectionBanner` |
| Chat header | Thread picker, Agent settings, Live sessions icon, debug icon, ⋯ menu | `ConversationPanel.tsx` |
| ⋯ menu / side panels | People, Shared drafts, Agent whispers, Goal handoffs, Inbox, Terminal (flagged off) | `agent-workspace/*`, about 3,000 lines |
| Settings | 9 sections: Agent access, Workspace name, Workspace identity, Team, Connected agents, Git events, Account, Subscription, Data & privacy | `SettingsView.tsx`, 1,161 lines |
| Memory | 3 tabs (Shared notes, Rules, Sessions) plus Needs your review / What the team remembers / Lower confidence / History | `MemoryView.tsx` 827 lines, `memory/*` |
| Other routes | /dashboard/projects, /dashboard/missions/[id], /dashboard/approvals, /dashboard/help | legacy mission and project screens |

## 2. Cut, merge, keep

This is a UI cut. No tables or APIs are dropped, so nothing in the database or the broker can break.

**Cut from the UI**
- **Agent endpoints strip.** Connection health moves to one small dot in the sidebar footer and the Agents section of Settings. The strip is the thing in your screenshot: it repeats information the sidebar already shows.
- **"Finish setting up M9R" card and "Recent native activity".** Replace with a single first-run card that shows only until Claude or Codex is connected, then never again. Activity history stays in the Activity channel.
- **Sessions tab** (Memory) and the **Live sessions** icon. You said they don't work and aren't needed. Remove the screen, the icon and their routes' links.
- **Rules tab.** Remove from the UI. Keep the rule engine on the server until I confirm nothing delivers rules to agents through it; I'll check before deleting any server code.
- **Agent whispers, Goal handoffs, Inbox.** Not part of the demo story; the pill handles approvals and agent-to-agent asks. Hide them behind a developer flag rather than deleting.
- **Projects page, Missions page, Help page.** Legacy. Workspace switching moves into Settings; help becomes a "?" link to the docs.
- **Git events** settings section (no part of the launch story).
- **The debug (bug) icon** in the chat header. Move behind the developer flag.

**Keep, but rework**
- **People → "Members"** in a room: who is in, who is waiting to be admitted (the Rooms URL flow depends on it).
- **Shared drafts → "Docs"**: one list of the documents agents and people edit together. It is the only collaborative-artifact surface, so it earns a slot. If you'd rather cut it, say so.
- **Approvals** page stays; the pill is the fast path and this is the history.
- **Memory** becomes one page (section 5).
- **Settings** becomes five sections (section 4).

## 3. New structure

- **Sidebar:** Workspace name, search, "New room" as a primary button, then rooms and channels, then Memory, then the account row with a connection dot. No Connected agents row; that lives in Settings.
- **Chat header:** name, member cursors (who is here), model picker, Docs, Members. Nothing else.
- **One identity system** (section 6) instead of the blue mascot.
- **Dark by default**, light kept.

## 4. Settings v2: five sections

1. **Account**: name, username, email, sign out.
2. **Workspace**: name, members and roles (merges Workspace name, Workspace identity and Team), invite by email.
3. **Agents**: connected agents with live status, model, what each can do (merges Connected agents and Agent access), connect another.
4. **Plan & billing**: the current Subscription section, trimmed.
5. **Privacy & data**: export, delete, what is stored (current section, trimmed).

Left rail with five items, one column of content, same type and surfaces as the room page.

## 5. Memory v2

- One page, no tabs.
- **Top:** a search box that searches everything agents remember.
- **Needs your review**: a short list of things agents want to remember; Keep / Edit / Forget.
- **What your agents remember**: grouped by topic, each with who learned it and when, and a Forget button. Shared notes are folded in here.
- **Lower confidence** collapses to "Maybe" at the bottom.
- Drops: Rules tab, Sessions tab, History as a separate section (an "Earlier" link keeps it).

## 6. Identity marks instead of the mascot

The blue cursor character is the reference's. Options:

- **A. Provider cursors (recommended).** Claude, Codex and OpenCode appear as an arrow cursor in the provider's own colour carrying its real logo, with the name as a small tag, the way they look on a page. People are initials in a round chip. System channels (Agents, Activity) get a plain line icon. A channel row shows a small stack of the cursors of who is in it. This matches the pill and the demo, and nothing in it comes from the reference.
- **B. Pixel glyphs.** One letter in the homepage's dot-matrix face on a dark tile. Distinctive, but it doesn't say which agent is which.
- **C. No avatars in the list.** Text rows with a coloured status dot, like Slack. Fastest to scan, loses the personality.

## 7. Visual direction from the homepage

From the Create-a-room page, the one screen already in the homepage style. Real values from `room-url.module.css`:

- **Background:** `#141414` with a dark navy wash (`rgb(7 7 16 / 61%)` fading to `80%`) over the dotted cloud-map image. In the dashboard, keep the wash and drop the image to a very faint version behind the empty state only.
- **Type:** four faces. Array (dot-matrix display) for page titles, Garamond for body, a pixel face at 11–12 px for small caps labels, Instrument Serif italic for descriptions and empty states. Rule: dot-matrix for page titles only; Garamond for message text and long reading; pixel face for labels only.
- **Colour:** ink `#f4efe9`, body `#e2d9d0`, muted `#c9beb2`, lines `rgb(196 185 179 / 25%)`, panels `rgb(20 20 20 / 48%)`, inputs cream `#efe9e2`, primary button gold `#f3dd9d` with a small hard offset shadow, error `#f18b87`. Focus ring gold. One accent: the gold. This removes the reference's iOS blue.
- **Shape:** 8 px radius panels, hairline borders, no big shadows.
- **Motion:** reveals and count-ups only; reduced-motion respected.

**Licence check before anything is public:** the room page loads its fonts from `/reference-innerwebs/` (hashed filenames copied from another site). Instrument Serif is open-licence; I could not verify the other three. Either confirm their licences or substitute open ones (for example Fraunces or EB Garamond for body, a free dot-matrix face for display).

## 8. Build order, so nothing breaks

1. Remove the strips and cut UI (section 2), no new styling. Typecheck, tests, click through.
2. New tokens and the five-section Settings.
3. Memory v2.
4. Sidebar, header, identity marks, dark default.
5. Delete dead components only after a search shows no imports.

After each step: typecheck, the dashboard tests (I'll update the two stale ones and add tests for the new structure), the production build, and a screenshot pass in your signed-in Chrome. I will not touch the database or broker.

## 9. Decisions I need

1. Cut list in section 2: approve as written? (Default: yes. Say which to keep.)
2. Docs (Shared drafts): keep or cut? (Default: keep.)
3. Identity marks: A, B or C? (Default: A.)
4. Dark by default? (Default: yes.)
5. Fonts: keep the homepage fonts for now and fix licences before public launch, or swap to open fonts now? (Default: keep for tonight.)
