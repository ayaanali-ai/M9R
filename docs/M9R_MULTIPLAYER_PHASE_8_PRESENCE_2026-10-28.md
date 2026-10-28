# M9R Multiplayer — Phase 8: Presence, cursors, and pill collaboration

Status: source implementation complete; the end-of-phases verification matrix remains deferred.

## What is now implemented

- `src/lib/native/multiplayer-presence.ts` is the provider-neutral presence layer.
- A run is bounded to the existing `MAX_ACTIVE_AGENTS` value (16). Every agent receives a deterministic label and color derived from its stable M9R identity, never from roster order or a provider session id.
- Presence events are schema-validated, fenced to the run and the agent branch, and accepted only when their revision is newer than the last accepted revision. Late or duplicated provider events are ignored instead of flashing stale state in the pill.
- Cursor presence is a semantic state (`observing`, `preparing`, `acting`, `waiting`, `asking`, `blocked`, `completed`, or `stopped`) with a visibility bit. It intentionally does not expose desktop coordinates, window handles, credentials, prompts, or raw provider logs.
- The snapshot has a compact headline and three featured identities. Additional agents are represented as `+N more`; the full bounded roster remains available to a richer view.

## Existing routes preserved

- The current broker-owned browser route, desktop stage route, provider runtime ownership, and mutation scheduler are unchanged.
- `web-ui-bridge` adds `collaboration` as an optional field to the existing `ui-state` message. Older consumers can ignore it.
- The extension sanitizer accepts only the bounded presence fields and strips everything else.
- Both pill shells convert the optional field into the shared pill snapshot. The desktop feed path derives the same bounded summary when the native feed does not yet carry presence events.
- The overview renders a compact presence headline and overflow marker; it does not replace the existing task/activity or approval behavior.

## Verification boundary

Compile-only checks and the CLI/pill builds are appropriate for this phase. The presence unit cases are included but are not run yet, per the owner’s instruction to run the complete matrix after all phases are implemented.
