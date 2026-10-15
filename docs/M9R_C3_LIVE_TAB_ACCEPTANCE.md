# C3 — Live tab view acceptance

**Status: implementation, hosted room-member broadcast policies, local Cloudflare build, and local Worker smoke checks pass. Production deployment and two-machine acceptance are still pending, so C3 is not signed off.**

## Room setup

The dashboard conversation at `/dashboard/agents?conversation=…` is a workspace conversation, not a room. The room creation flow is already present in `main`: open the dashboard's left sidebar and choose **New room** (also available from the **New** menu). Name the room and create it. The application then opens the room URL.

The host shares that room URL. On the second machine, sign in with the second account, open the URL, request to join, and have the host admit the request. Both people must show as active members in the same room before starting C3. Only the source machine needs the test tab open; the viewer machine stays on the room page.

## Local implementation

- `src/app/rooms/[roomId]/RoomLiveView.tsx` captures only a browser tab selected through the browser's screen-sharing picker. Window and full-screen sources are rejected.
- Frames are sent as ephemeral, private Supabase Realtime broadcasts. The app does not add frames to room history or include page URL/title metadata.
- The local sender caps the stream at 3 frames/second, 800×450, 30 KiB per JPEG frame, and five minutes. Sharing stops when the user stops it, the room page is hidden, the relay disconnects, room membership cannot be confirmed within the 2-second check, or the component unmounts.
- Admitted room members can view frames. The viewer has no remote input controls.
- `supabase/migrations/20261004042347_room_live_tab_broadcast.sql` authorizes private broadcast read/write only for active members of the room named by the topic. Its version matches the migration already applied to the hosted Supabase project.

## Verification and remaining gates

- `npm run typecheck` — passed locally on 2026-10-04.
- `node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs --test ./scripts/agent-chrome-input.test.ts ./scripts/cross-machine-room.test.ts` — 15 passed locally on 2026-10-04. The run exposed and fixed a stale test reference to the pre-deployment migration filename.
- Hosted migration `room_live_tab_broadcast` (`20261004042347`) and its active-member SELECT/INSERT policies were applied and verified in `pg_policies`.
- Root cause of the repeated build failure: `scripts/build-cloudflare.mjs` forced `next build --webpack`, bypassing the project's `next build --turbopack` package build that OpenNext invokes and that successfully compiles this app. The wrapper now calls `opennextjs-cloudflare build` directly and defaults the public relay URL from `wrangler.jsonc`.
- Local Windows build: Turbopack compiled all 137 routes. OpenNext's normal Windows packaging first failed with `EPERM` when creating a symlink for `node_modules/shiki`. Re-running with a temporary local junction shim produced `.open-next/worker.js`; OpenNext emitted non-fatal copy warnings for `hast-util-to-html`, `hast-util-whitespace`, and `property-information`. This workaround is not part of the repository and the warnings mean a Linux/Cloudflare build is still the release build to verify.
- Secret hygiene: the build was run with `.env.local` moved out of discovery and restored afterward. A scan of `.open-next/cloudflare/next-env.mjs` found zero configured secret names.
- `npx wrangler deploy --dry-run --outdir .workcache/c3-wrangler-dry-run` — passed; Wrangler read 577 assets and reported 37,227.53 KiB upload (7,145.07 KiB gzip). No deploy was performed.
- Local Wrangler Worker smoke: `GET /` and `GET /rooms/new` both returned HTTP 200, run while `.env.local` was hidden. This does not exercise authenticated room membership or frame delivery.
- Wrangler OAuth had already been refreshed and `whoami` confirmed the account in the preceding C3 work. No production deployment was performed during this investigation.
- Remaining sign-off gates: build the reviewed C3-only changes on Cloudflare's Linux build path; deploy that reviewed artifact; confirm both named accounts are active in one room; share a tab from the source machine; observe changing frames on the viewer machine; verify the viewer has no control path. The current checkout has unrelated uncommitted changes, so the full working tree is not a safe deploy candidate.
