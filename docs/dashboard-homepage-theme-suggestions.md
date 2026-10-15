# Dashboard: carrying the homepage theme over (suggestions only, nothing built)

2026-10-02. Written from source and from the checks I ran. I could not get the in-app browser to load localhost this session, so nothing below is from a screenshot of the running page. The homepage description comes from `ReferenceHome.module.css`, the dashboard description from `dashboard-chrome.css`. Please look at both in a browser before approving.

## Checks run on Codex's dashboard build (main tree, branch codex/dashboard-m9r-rework-20261002)

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean. |
| `npm run build` (production) | Succeeds. |
| Dashboard-related tests (181) | 179 pass, 2 fail. Both failures are old source-text assertions, not behaviour. |
| Authenticated flows (send, model switch, approvals) | Not checked. They need a signed-in browser session, which I can't do. |

The two failures:

1. `agent selection is URL state shared by the sidebar picker and the floor` expects `aria-current={selected ? "true" : undefined}`. The new sidebar picker uses `aria-current={selectedAgent === key ? "page" : undefined}`. That is the more correct value for links, so update the test.
2. `disconnect route revokes a coding agent…` expects an older select string. Codex's agent-settings commit added `created_by` to the select, an owner-or-workspace-owner check, and moved the revoke into `revokeAgentConnection`. The behaviour is stricter than before. Update the test so it matches the new code.

## Before vs now

| | Before (fd40e53c) | Now |
|---|---|---|
| Type | Geist sans | Inter |
| Palette | Warm greys, near-black / off-white | Neutral black (#070707, #111, #262626), white text |
| Accent | Muted grey | Bright blue #1084fe, with #459ffe focus ring |
| Layout | 820px reading column, soft ethereal shadow | 320px sidebar, full-width conversation, slim capsule composer |
| Sidebar | Brand link, channel switcher, plain agent picker | Mac-style red/yellow/green dots, search, 56px cursor mascots with status dot and preview line, bottom destinations and account menu |
| Agent marks | Provider marks (`AgentMark`) | Cursor-face mascots (CursorAvatar, expression data, mascot bodies) |
| Brand | `product-brand` link | None (neutral chrome) |
| Kept | Memory nav, command palette, day/night toggle, endpoint status | Same, all still present |

Where it came from: the new look is the OpenMausBot reference (Apache-2.0, attributed in `third_party/dashboard-reference/`). It reads as that product's look, not M9R's. The blue accent, the traffic-light dots, Inter, and the "Bramble" sample character are the most recognisable parts.

## What the homepage actually is

Periwinkle-to-plum gradient background (#708cff into #29222b), scanline overlay, grey Windows-95 style windows with bevelled edges, a pixel face for labels, Garamond and Instrument Serif italic for headlines, cream (#f3dd9d) buttons with a hard offset shadow, and pill buttons with a lilac glow on hover. The copy says each agent "shows up with a name and a cursor you can see".

## Suggested changes, in priority order

1. **Remove the reference's tells (do before anything public).** Replace the three traffic-light dots, the "Bramble" sample character in `/design/dashboard`, and the iOS-blue accent. This is the part that stops it being a copy. The reference attribution can stay in `third_party/`.
2. **Cursor icon.** Replace the reference cursor-face mascots with M9R's own: the provider logos you already chose for Claude, Codex and OpenCode, drawn as a cursor arrow in each provider's colour, with the agent name as a small tag beside it, the same way agents appear on a shared page. Keep the 56px contact-row slot and the status dot. The "sample" mascot art then isn't needed in the product at all.
3. **Colour.** Keep the black you like, but layered near-blacks (as in the homepage's plum end), not neutral grey. Take one accent from the homepage: either the cream #f3dd9d for primary actions, or the periwinkle #708cff for focus, selection and links. I'd pick one, not both. This removes the iOS blue.
4. **Type.** One display face plus one text face. Use the homepage's italic serif for the conversation header and empty states only, and keep a clean sans (Inter is fine) for message text and controls so long reading stays comfortable. Drop the pixel face from the dashboard except for tiny labels like "Needs you".
5. **Channel creation.** Today it is the generic `ol-dialog` overlay with `NewChannelForm`. Suggest a small homepage-style window: bevelled title bar reading "New channel", cream primary button, the member list shown as cursors you add (Claude, Codex, OpenCode, teammates), and a one-line room-URL preview under the name field (that's the thing users care about). Same form fields and handlers, new skin.
6. **Approvals and "needs you".** Use the same window styling as channel creation, so the in-page pill, the desktop pill, and the dashboard approvals feel like one product. This lines up with the one-pill work.
7. **Sidebar chrome.** Remove the window dots; use the title row for the M9R mark and the search field. Keep the bottom destinations. Keep search, since it is useful with many agents.
8. **Backgrounds and motion.** Optional and subtle: the homepage gradient as a very low-opacity wash behind the empty state only, and the scanline texture off by default (it hurts text legibility in long threads). Honour reduced motion, as the current build already does.
9. **Light mode.** Currently white and grey. Pick whether it stays; if so, use the homepage's cream and ink for it instead of generic white.

## Seen in the running app (2026-10-02, signed in, localhost:3000)

This section replaces guesses above with what the live pages actually show.

1. **Three different looks in one product.** The create-a-room page (`/rooms/new`) is the homepage look: blue dotted-map background, pixel title, italic serif, cream button. The chat dashboard is the reference look: white or grey panels, Inter, traffic-light dots, blue cursor mascots. Settings (`/dashboard/settings`) is a third, older editorial look: serif heading, mono labels, pale grey cards. A person moving from the room page into the dashboard to settings sees three products. This is the strongest argument for moving the homepage theme over.
2. **It is light mode here, not the black you liked.** The signed-in dashboard opened light. Dark exists, but it is not the default and the toggle is not obvious. For the demo, make dark the default for new sessions.
3. **One mascot for everything.** General, Agents, Activity and Demo all use the same blue cursor character, even though only agents should look like agents. Suggest: provider logos as cursors for Claude, Codex and OpenCode, a plain icon for system channels (Agents, Activity), and initials for people.
4. **The General channel is full of agent loop chatter.** The latest messages are agents saying "No action taken: this is a repeat loop" to each other. That would be the first thing a viewer sees in a demo. Before recording: clear or archive that channel, or demo in a fresh room.
5. **"New room" is hidden behind the + menu** (New channel / Connect agent / New room). Rooms URLs are the headline feature, so give it a primary button in the sidebar.
6. **The sidebar opens as an overlay at laptop widths** and hides the conversation. At 1568 px wide it should dock, as it did in the reference.
7. **A debug strip ("Agent endpoints · 2 connected") sits at the very top** of the chat, above the header. Hide it behind the bug icon for demos.
8. **Header controls are unlabelled icons** (monitor, bug, ellipsis). Add tooltips or labels; "computer" and "debug" mean nothing to a new viewer.
9. Everything in the earlier list still applies, in this order: remove the reference tells (traffic-light dots, blue accent, sample mascot), own cursor icons, one palette across the three looks, channel creation as a homepage-style window, approvals styled like the pill.

## What I would not change

Existing handlers (send, attach, mention, review, panels), the model picker's connection to the real API, URL-driven agent selection, the Memory nav, the command palette, and the endpoint status panel. All of these are behaviour, not theme.

## Open questions for you

- Accent: cream or periwinkle?
- Light mode: keep, restyle, or drop for now?
- Do you want the homepage serif in the dashboard header, or sans only?

Nothing here has been built. Say which items you approve and I will build exactly those.
