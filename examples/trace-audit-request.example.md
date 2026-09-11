<!-- SYNTHETIC example trace-audit request. Fake agent run, fake logs, no secrets.
     Clearly labeled synthetic — not customer data, not a real submission. -->

# SYNTHETIC Trace Audit Request (example)

Project/tool: acme-docs-site (synthetic example)
Agent used: Claude Code (synthetic log)
Goal of the run: Refactor the marketing nav into a shared component
Was it successful: Yes, after two failed builds

Log/trace:
```
[synthetic] read src/components/Nav.tsx
[synthetic] read src/components/Nav.tsx        # re-read, no edit between reads
[synthetic] edit src/components/Nav.tsx
[synthetic] npm run build -> FAILED (type error in Nav.tsx)
[synthetic] edit src/components/Footer.tsx     # unrelated file
[synthetic] edit src/app/page.tsx              # unrelated file
[synthetic] npm run build -> FAILED (same type error)
[synthetic] edit src/components/Nav.tsx        # finally fixed the real error
[synthetic] npm run build -> OK
[synthetic] npm run lint -> OK
```

Known token/cost metadata:
- input tokens: 12,400 (approx, from CLI summary)
- output tokens: 3,100 (approx)
- cost: unknown (not reported by the tool)
- energy: unknown

What felt wasteful:
- Re-read the same file with no edit in between.
- Two failed builds with edits to unrelated files before isolating the real error.

Can RunLeak quote this publicly? yes/no: yes (synthetic example, safe to quote)

<!--
Expected RunLeak output for this synthetic request:
- Normalized ledger: exact_model_calls/exact_token_count populated only if the source provides
  explicit per-call fields; the approximate totals above stay qualitative unless structured.
- Findings: redundant_file_read, build_fix_loop (from the evidence above).
- Prevention rules: redundant_file_read, build_fix_loop (deterministic, finding-based).
- Advisory policy: cost honesty = warn (tokens approx, cost null); energy honesty = pass with
  caveats; build/lint = pass.
- CI gate dry-run: non-blocking (exit 0) by default.
- Unknown stays unknown: cost and energy remain null; no estimation.
-->
