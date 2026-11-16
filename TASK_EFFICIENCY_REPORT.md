# Local task efficiency reports

Run `npm run report:efficiency -- --help` for arguments. This command reads existing
recordings; it does not dispatch agents, call a model, browse, or change input evidence.
Only an explicitly requested output file is written, and existing files are not overwritten.

Example in PowerShell (replace the paths and timestamps with the exact recording scope):

```powershell
npm run report:efficiency -- --format claude --transcript .workcache/recording.jsonl --from 2026-11-16T17:38:00Z --to 2026-11-16T18:25:00Z --state .workcache/state-snapshot.json --tasks T473,T474 --out .workcache/efficiency-report.json
```

`--state` and `--tasks` are optional but must be supplied together. Task IDs select
the state evidence, not the transcript messages. A timestamp window in one session
can contain other work; inspect source line numbers before attributing all activity
to a goal. UTC or explicit offsets are required. The selected wall-clock window
and observed transcript span are reported separately.

## Accounting

- Claude: latest known usage fields per `message.id`; streaming snapshots are not
  added together. Missing counters remain null and per-field coverage is reported.
- Codex: differences between recorded cumulative `event_msg/token_count` snapshots.
  Do not add `last_token_usage` or duplicate `token_usage_record` events. A baseline
  is needed; resets and samples spanning the window boundary are declared. A
  recognized session start inside the window permits a zero baseline.
- These are reported counters, not unique content-token counts. Cache reads are
  repeated context processing. Provider formats are not interchangeable.
- Tool IDs deduplicate repeated blocks. Repeated arguments or operation IDs are
  candidates for review, not proof that an observation or retry was unnecessary.
- Tool wait is call-to-result time, including transport and execution. Intervals
  are unioned to avoid counting concurrent work twice. Nested stage timings are
  displayed separately and must not be added together as exclusive latency.
- Whole-task stage aggregates remain useful when bounded raw intervals were lost,
  but cannot establish where that lost time falls within a window. Missing state,
  missing tasks and incomplete raw histories are explicit.
- Unattributed time is not measured model reasoning. It can include queues,
  network, idle time, compaction and missing instrumentation. Queue waits are not CPU time.
- Image blocks and decoded image bytes are separate from text bytes. Serialized
  result-content bytes include wire representation overhead; they are not model tokens.
- A typed failure is counted. Prose without a typed outcome stays unknown.

Output excludes raw prompts, tool arguments, images, errors and narrated diagnoses.
It contains counts, durations, source line numbers, input SHA-256 digests and bounded
lists of the largest results. Treat the original recordings and optional state/review
files as private evidence; the report does not make them safe to publish.

## Review and cost

Artifact correctness and owner interventions default to null. Agent completion
claims and user-text entries cannot establish either. Supply `--review PATH` only
after an explicit review. The JSON schema is:

```json
{"artifactCorrect": false, "ownerInterventions": 2, "evidence": "Reference to the owner-reviewed saved artifact and intervention record"}
```

These remain supplied review findings, not automatic verification. The report
keeps an evidence digest, not the private review text.

An optional `--rates PATH` accepts nonnegative `inputUsdPerMillion`,
`outputUsdPerMillion`, `cacheReadUsdPerMillion`, `cacheWriteUsdPerMillion`, and
`inputAccounting` (`exclusive` or `includes-cache-read`). No prices are built in.
Incomplete counters, resets and uncertain window boundaries are not priced.
Configured estimates are API estimates, not subscription bills or allowance use.
Without explicit rates the estimate is null. The transcript decoder does not
collect provider-reported USD; it never substitutes zero for that missing field.

## New managed turns

The Claude managed adapter forwards explicitly reported result usage/cost into the
owner's task store, keyed by its dispatch ID. Repeated reports replace the same
sample. At most 32 samples per task are retained; `droppedSamples` exposes lost raw
coverage. Providers that do not emit supported counters produce unknown values.
Reported USD is a provider report, not a verified subscription charge.

Task-store samples and transcript counters are separate evidence sources. They
can describe the same work: do not add them together. This measurement does not
change completion, routing, permissions or task execution. No report is evidence
of an efficiency improvement until matched outcomes and comparable runs support it.
