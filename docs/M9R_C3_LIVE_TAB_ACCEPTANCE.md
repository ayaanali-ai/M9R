# C3 — Live tab view acceptance

**Status: implementation, hosted room-member broadcast policies, candidate typecheck, and focused room tests pass. Cloudflare Linux build, preview deployment, and two-machine frame verification remain. C3 is not signed off.**

## Two-machine setup

Create a room from the dashboard sidebar's **New room** action or the **New** menu. Share its URL with the second machine. Sign in there, request to join, and have the host admit it. Confirm both people are active members in that room. The source machine selects a browser tab in the screen-sharing picker; the viewer stays on the room page.

## Implementation

- `RoomLiveView.tsx` captures only a browser tab selected by the browser picker. Window and full-screen sources are rejected.
- JPEG frames are private Supabase Realtime broadcasts. Frames are not stored in room history and do not include page URL or title metadata.
- The source caps sharing at 3 frames/second, 800×450, 30 KiB per frame, and five minutes. Sharing stops when the person stops it, the page is hidden, the relay disconnects, active membership cannot be confirmed within two seconds, or the component unmounts.
- Active room members can view frames. The viewer has no remote input controls.
- Migration `20261004042347_room_live_tab_broadcast.sql` restricts private broadcast reads and writes to active members of the room named in the topic. This migration was already applied to the hosted Supabase project and verified in `pg_policies`.

## Verification and remaining gates

- On the C3-only worktree based on current `main`, `npm run typecheck` passed and `scripts/cross-machine-room.test.ts` passed 11/11 on 2026-10-04.
- The required Cloudflare-managed Linux build and review deployment are still pending. No production deployment was performed.
- Sign-off requires a successful Cloudflare Linux build, preview deployment, both named accounts active in one room, changing source-tab frames visible on the second machine, and confirmation the viewer has no control path.
