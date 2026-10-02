# Item 11 and workspace controls — 2026-10-02

## Status

Implementation is present. The three approved hosted migrations are applied. Item 11 remains open until real provider measurements and application checks are complete. Items 12–16 were not implemented in this slice.

## Free memory policy

Every workspace receives **10 MiB (10,485,760 bytes)** of shared persistent text memory, pooled across members, agents, and channels. Counts note title/body, persistent workspace rule text, and archived session title/transcript text; an archived message is counted once. Drafts count. Live chat, attachments, local files, and audit metadata are outside this text allowance.

The database serializes quota-affecting writes. Growth above the allowance is rejected and rolled back; existing memory stays readable and deletable. Legacy workspaces above the allowance can shrink their data. Deleting memory frees allocation.

Workspace facts and channel facts appear in Memory → Shared notes. Agents propose drafts; only owner/admin-reviewed notes are returned as shared facts. Facts are data, not instructions. Existing reviewed workspace rules retain their instruction role. Private-channel access is checked before reading, proposing, searching, or exporting its memory.

## Controls

- Agent settings: connection defaults plus channel-specific overrides, including explicit provider default versus inheritance. Allowed choices come from the specific connection. Writes require connection ownership or workspace ownership.
- Bridge applies fresh authorized settings between turns; unsupported choices fail rather than silently using another model. Native browser sessions accept their own `agents.json` settings before launch.
- People panel: channel agent membership and human membership. Owner/admin authorization is enforced server-side. Built-in channels and DMs protect their membership invariants.
- Team settings: checked invite/role/removal responses and confirmation dialogs. Invite tokens are visible only to administrators. Removing/leaving a team revokes that member's connections, tokens, and channel participation transactionally; shared memory remains.

## Hosted application

With explicit user approval, these exact migrations were executed together in one transaction on the linked **RunLeak** Supabase project and recorded in `supabase_migrations.schema_migrations`:

1. `20261002010000_agent_run_settings.sql`
2. `20261002020000_workspace_shared_memory.sql`
3. `20261002030000_team_channel_controls.sql`

No broad `db push` was used. Other pending migrations were not included. This does not deploy the application or restart native binaries.

## Observed verification

- Typecheck passed after model/effort, quota, API, and human-control changes.
- Earlier combined focused batch: 127 passed. Latest focused batch: 103 passed, zero failures (settings/memory, Codex adapter, native sessions, browser awareness, conversation deletion). These batches overlap; do not add their totals.
- Isolated PostgreSQL via PGlite executes all three migration sources. Checks quota rollback, legacy shrink/delete, transactional human roster, departed-agent/token revocation, review authorization, and rollback when the audit function fails.
- Signed-in localhost UI loads this workspace's model choices, channel agents, and shared-memory allowance. Usage observed after migration: 2,551 bytes out of 10,485,760. This is a snapshot, not a guaranteed current balance.
- Local Next application runs on port 3001. The configured local relay was absent; it was started on `127.0.0.1:8787`, and the UI changed to Live.
- No real users/agents were removed and no workspace memory was created/deleted during these read-only UI checks.

## Remaining sign-off evidence

1. Run the same bounded multiplayer task before and after, with the same provider/model/effort, fresh comparable sessions, and actual input/output/cache counters for Claude, Codex, and OpenCode. No measured savings are claimed yet.
2. Verify a saved model/effort actually reaches the next real provider turn; exercise channel overrides/inheritance and revocation while idle.
3. Exercise draft → human review → authorized agent retrieval, including private-channel denial, through real sessions.
4. Rebuild/restart the native packaged runtime before checking its changed prompt/awareness/usage behavior. Current source/test evidence is not evidence that an already-running binary has changed.

Native receipts use `web-sessions/provider-usage.jsonl` under the configured local store root. Only reported counters are retained; absent counters remain null. The ledger contains no prompts or credentials and is separate from hosted workspace memory.

## Reproduce the isolated SQL check

Install the official `@electric-sql/pglite` package in a temporary directory, set `M9R_PGLITE_PATH` to its `dist/index.js` absolute path, then run `node scripts/item11-memory-sql-check.mjs`. The script uses an isolated database and does not access Supabase.
