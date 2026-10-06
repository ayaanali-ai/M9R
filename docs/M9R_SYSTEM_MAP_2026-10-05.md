# M9R system map — 2026-10-05

This is the checkout map to use before moving, renaming, or deleting files. It
records observed entry points and deployment boundaries; it does not turn a
design note into a live acceptance claim.

## Runtime and deployment boundaries

| Surface | Entry point and lifecycle | Deploy target / owner | State, secrets, and current proof |
| --- | --- | --- | --- |
| Web application | `src/app` through Next/OpenNext; `scripts/build-cloudflare.mjs` produces `.open-next` | Cloudflare Worker `m9r-web`, configured by root `wrangler.jsonc`, serving `m9r.dev` and `www.m9r.dev` | Wrangler deployment history is present. The remote secret list contains `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` (verified 2026-10-05). |
| Cron scheduler | `services/cron-scheduler/src/index.ts`; Cloudflare invokes `scheduled()` and exposes only `/health` | Separate Worker `m9r-cron-scheduler`, configured by `services/cron-scheduler/wrangler.jsonc` | Enabled deployment completed on 2026-10-05. `/health` returned 200. Two `idle-session-sweep` invocations (`*/15 * * * *`) returned HTTP 200 with no exceptions; the other three sweep logs remain open. |
| Network core | `services/network-core/src/index.ts`; Durable Object actor plus D1 history; scheduled cleanup in `scheduled()` | Cloudflare Worker `m9r-network-core` | Its `17 4 * * *` trigger is network-history cleanup, not one of the four application sweeps. |
| Relay | The live path is `services/relay-do`; the container wrapper is separate | Durable Object relay path | `services/mission-relay/wrangler.jsonc` is explicitly marked **DO NOT DEPLOY** because Containers are outside the startup-credit boundary. |
| Mission worker and bridge | Container wrappers under `services/mission-worker` and `services/mission-bridge` | Local/reference configurations only | Both configs are explicitly marked **DO NOT DEPLOY**. Do not treat their Wrangler files as live services. |
| Web coordinator | `services/web-coordinator/src/index.ts` | Local Cloudflare Durable Object config `m9r-web-coordinator-local` | No production deployment claim is recorded here. |
| Local engine and CLI | `scripts/m9r-cli.ts`, `scripts/build-cli.mjs`, and the generated `m9r-engine` executable | Owner's Windows machine; provider hosts start one engine process per MCP stdio session | The overlay and provider adapters own launch/restart behavior. Generated executables in the checkout are artifacts, not source entry points. |
| Resident and provider bridge | `src/lib/native/*`, `src/lib/bridge/*`, and `services/mission-bridge` local code | Owner's Windows machine and provider-specific ACP/MCP child processes | Uses environment-scoped values such as `M9R_APP_URL`, `M9R_AGENT_TOKEN`, and provider paths. Values must remain outside source and reports. |
| Browser broker | Native broker and web setup code under `src/lib/native`; the extension connects over the local bridge | Owner's Windows machine | The broker owns local page claims, approvals, and browser actions. CDP is the browser-control boundary; it is not a Cloudflare Worker dependency. |
| Browser extension and shared pill | `extensions/browser` plus the shared `pill/src` package; the managed updater writes `%LOCALAPPDATA%\\M9R\\extension` | Owner's Chrome/Edge profile | The stale New Tab files were removed from the managed install. Chrome still needs one extension reload before live verification. Desktop and extension remain one shared pill codebase. |
| Desktop overlay | `overlay/src` and `overlay/src-tauri`; Tauri starts and supervises the local engine | Owner's Windows desktop | The overlay is a view and command shell over the native feed; it is not the browser broker or the hosted web app. |
| Runtime core | `packages/runtime-core` | Shared contracts package | `BOUNDARY.md` explicitly excludes process supervision, discovery, routing, authorization, PTY, and a complete local control plane. Do not create a second “Node core” package until its supervisor boundary is specified. |

## Non-negotiable cutover gates

1. Keep the shared `CRON_SECRET` present on both Workers.
2. Exercise an authenticated internal route and inspect Cloudflare Worker logs.
3. Record one successful scheduled invocation for each sweep before calling the migration fully verified.

## Repository hygiene boundary

- Keep this monorepo layout until the entry-point and lifecycle map changes.
- Do not delete or move the dirty OS-stage, pill, or extension changes as a
  cleanup shortcut.
- Do not deploy the explicitly stopped Container configurations.
- Treat root executables, recordings, mockups, and generated hashed assets as
  an artifact-triage task. They are not safe to delete merely because they are
  untracked; each needs a reference/ownership check first.
- The active Cua source of truth is `docs/M9R_CUA_WAVE_PLAN.md`; the competitive
  research document now points to that source and labels uniqueness claims as
  candidates until live evidence exists.

## Evidence still open

- Cloudflare secrets are configured and the scheduler is deployed. Two
  successful `idle-session-sweep` executions are recorded in the 2026-10-05
  `wrangler tail --status ok` output; `work-signal-sweep`, `stale-run-sweep`,
  and `workflow-scheduler` still need successful execution logs.
- Chrome live pill, message, approval, reconnect, and navigation behavior still
  require an owner-session run after the extension reload.
- The provider capability matrix is recorded in
  `docs/M9R_PROVIDER_CAPABILITY_MATRIX_2026-10-05.md`; its six live
  provider-to-provider directions and OpenCode activity signal remain
  unproven.
- C3's reviewed Cloudflare preview/deployment and two-machine changing-frame
  proof remain deliberately deferred behind the OS-stage sequence.

## Security check record

- `npx wrangler whoami`, scheduler dry run, secret-name checks, deployment, and
  `/health` all passed in the authenticated Cloudflare account.
- `npm audit --omit=dev` reports **0 vulnerabilities** after the compatible
  Next.js, Monaco, and transitive patch updates.
- A full npm audit still reports 10 high findings in development-only shadcn,
  glob, and TypeScript-parser tooling. The available automatic fix is a
  breaking shadcn downgrade, so it was not forced into the product checkout.
- Wrangler does not provide a separate repository security scanner. The live
  follow-up is Cloudflare Workers Security/Logs plus `wrangler tail` captures
  for the remaining three sweep jobs.
