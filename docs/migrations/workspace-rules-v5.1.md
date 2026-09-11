# Migration — Workspace Rules (v5.1)

Persistent, workspace-scoped rules (the "living ruleset" OathLock carries into
future AI coding-agent runs). This migration is required for the
**Workspace Rules** features: promoting generated rules, curating them over
time, and the before/after comparison actions that update rule health.

## What to run

**File:** [`supabase-workspace-rules.sql`](../../supabase-workspace-rules.sql)

**Where:** the **Supabase SQL editor** for your project
(Dashboard → SQL editor → New query → paste the file → Run).

Run it **after** the base schema and auth foundation:

1. `supabase-oathlock-phase1.sql`
2. `supabase-auth-foundation.sql`
3. `supabase-workspace-rules.sql`  ← this migration

## What it creates

A single new table, **`workspace_rules`**, holding the v5 `GeneratedRule`
lifecycle (rule_type / confidence / status / evidence / health counters such as
`times_seen`, `times_exported`, `times_helped`, plus `promoted_at` / `retired_at`).

It is intentionally a **new** table, not a change to the legacy `rules` table —
the legacy table is leak-type/severity/`is_active` shaped and cannot hold this
model without lossy normalization.

## RLS — do not weaken existing policies

The migration enables Row Level Security on `workspace_rules` and adds policies
that **mirror the existing project-owner model**: a user may read/write a
workspace rule only when they own its workspace (`workspace_id IN (SELECT id FROM
projects WHERE owner_id = auth.uid())`), plus full access for `service_role`.
There is **no public access**.

> Do not modify or relax the existing `projects` / `rules` / `traces` RLS
> policies. This migration only adds policies for the new table.

## Fallback behavior before the migration

The app degrades gracefully if the table doesn't exist yet:

- **Workspace Rules page** (`/dashboard/workspace-rules`) shows a
  "Workspace rules are unavailable. Run the v5.1 migration to enable them."
  migration-required message instead of erroring.
- The **Promote to workspace** panel and the comparison panel's per-rule actions
  are hidden / show a sign-in or unavailable state — they never imply that
  anything was persisted.

## Verify the table exists

Run this in the Supabase SQL editor — it should return one row:

```sql
select table_name
from information_schema.tables
where table_schema = 'public' and table_name = 'workspace_rules';
```

And confirm RLS is enabled (expect `rowsecurity = true`):

```sql
select relname, relrowsecurity as rowsecurity
from pg_class
where relname = 'workspace_rules';
```

Once the table is present, sign in and promote a few rules from a Blackbox
Report — they should appear under **Workspace Rules**.
