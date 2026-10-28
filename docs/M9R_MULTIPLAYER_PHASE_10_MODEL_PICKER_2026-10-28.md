# M9R Multiplayer Phase 10 — live model picker

Status: source implementation complete; full phase matrix remains part of the post-Phase-11 verification pass.

## What changed

- M9R now projects the exact model catalog reported by each managed provider connection into a bounded UI state. A missing catalog stays `catalog_unavailable`; M9R does not invent model IDs.
- The existing owner validation and persistence path is the only write path. The pill sends a model/effort selection to the authenticated owner broker, which validates it against that provider's live catalog and persists it by connection identity.
- Provider adapters keep their existing behavior: Codex/OpenCode can apply a supported choice on the next turn; adapters without a live apply primitive persist the choice for the next provider restart and report that state to the user.
- Added the owner-only `/web/ui/model` route and the equivalent `pill-model` native command. The desktop Tauri pill uses the same route through the resident engine; the extension pill uses its existing authenticated bridge with one additional typed message.
- The desktop pill prefers the broker's fresh `read_pill_state` envelope and falls back to the compatibility feed while the broker is starting. Existing message, approval, browser-control, and feed behavior remains intact.
- Settings now renders provider rows only when live model data exists. A disconnected provider or provider with no catalog is shown as such rather than displaying a stale/default list.

## Safety boundaries

- No provider app session is used as M9R's source of truth.
- No credentials, session tokens, process IDs, or provider continuation data enter the UI model state.
- Model IDs, labels, and effort choices are bounded and validated at both the bridge and pill boundaries.
- The browser-control contract and existing `ui-command` path were not changed.

## Verification performed

- `npm --prefix pill run build` — passed.
- `node scripts/build-cli.mjs` — passed.
- `node scripts/build-engine.mjs` — passed; broker/runtime identity was generated successfully.
- `git diff --check` — passed.
- Full runtime/live-provider tests are intentionally deferred until the remaining phases are complete, per the phase plan.

## Not included yet

Phase 11 remains the final clean-build, artifact, runtime, and live-provider qualification pass. It will verify the complete set together rather than changing provider or browser behavior during this phase.

