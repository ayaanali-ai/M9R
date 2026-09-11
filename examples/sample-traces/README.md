# OathLock sample traces

Anonymized coding-agent execution traces used as analyzer fixtures. Both files
describe the **same** task — _"Fix a timezone off-by-one bug in `formatDueDate()`
and add a regression test"_ — recorded as a clean run and a messy run so the
detectors can be exercised and compared.

| File | What it represents |
| --- | --- |
| `oathlock-clean-coding-agent.json` / `.jsonl` | An efficient run: read once, edit, one test fail → fix → pass. Provider reported token usage. |
| `oathlock-messy-coding-agent.json` / `.jsonl` | A wasteful run: same file re-read 3×, a 48k-char build log dumped into context, the same wrong command retried 3×, and a provider that reported **no** usage metadata. |

## Why JSONL exists

The `.json` form is the whole trace as one object (easy to read/diff). The
`.jsonl` form is the **same trace, one event per line**: line 1 is a `meta`
record, each following line is a `step` record. JSONL is friendlier for
streaming ingestion and append-only logging. The two forms round-trip to
identical analyzer findings (asserted in tests).

## What detectors should fire

Detectors live in `src/lib/coding-agent-detectors.ts`; the adapter
`src/lib/oathlock-trace-adapter.ts` maps a trace into the analyzer's
`NormalizedManualTrace`.

**Messy run** — fires:

- `repeated_context` → `redundant_file_read` (same file re-read 3×)
- `bloated_tool_output` (full build log dumped into context)
- `retry_spiral` (same failing command retried 3×)
- `missing_usage_metadata` (no token/cost metadata reported)
- plus `repeated_tool_call` and `build_fix_loop` as secondary signals

**Clean run** — materially fewer findings:

- `build_fix_loop` (the single test fail → fix) and a low-confidence
  `repeated_tool_call` (the test command was run twice: once failing, once to
  verify the fix). It does **not** fire repeated_context, bloated_tool_output,
  retry_spiral, or missing_usage_metadata.

**`model_overkill` does not fire** on either trace, and this is correct: neither
trace contains evidence of a large/expensive model being used for a trivial
mechanical step (e.g. formatting or a lint fix). Nothing is faked to make it
fire.

Run the analyzer yourself:

```bash
npm run analyze:trace -- examples/sample-traces/oathlock-messy-coding-agent.json
npm run analyze:trace -- examples/sample-traces/oathlock-clean-coding-agent.json
```

## Honesty / anonymization notes

- **Representative numbers.** Token and cost values are representative of a real
  session, not measured by this harness. Where a provider reported no usage (the
  messy run), `token_usage` and `estimated_cost_usd` are `null` everywhere and
  listed in `missing_metadata` — never estimated or invented.
- **Claim discipline.** The adapter only re-expresses what the trace states.
  When usage is absent, the normalized `exact_*` fields stay `null` and
  `missing_usage_metadata` fires instead of any detector claiming a confirmed
  token/cost number. A test asserts this.
- **No sensitive data.** No secrets, API keys, credentials, environment
  variables, customer PII, or full file contents. Tool input/output is
  summarized, paths are repo-relative, and `session_id` is a random opaque
  token.

Regenerate all eight files with:

```bash
node scripts/export-oathlock-trace.ts
```
