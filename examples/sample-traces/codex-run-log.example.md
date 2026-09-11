<!-- SYNTHETIC / REDACTED example. Not customer data. No secrets. No real source. -->

# SYNTHETIC Codex-style run log (redacted example)

Project/tool: billing-service (synthetic)
Agent used: Codex-style CLI (synthetic log)
Goal of the run: Add a retry wrapper around the payments client
Was it successful: Yes

Log:
```
[synthetic] plan: add retry wrapper with backoff
[synthetic] edit src/payments/client.ts
[synthetic] edit src/payments/retry.ts
[synthetic] run: npm test -> 12 passed
[synthetic] run: npm run lint -> OK
[synthetic] run: npm run build -> OK
```

Commands run:
- npm test
- npm run lint
- npm run build

Files changed:
- src/payments/client.ts
- src/payments/retry.ts

Known token/cost metadata (explicit, from CLI summary):
- input tokens: 8200
- output tokens: 1500
- total tokens: 9700
- cost: not reported (unknown)

What felt wasteful: nothing obvious this run.

Can RunLeak quote this publicly? yes (synthetic example).

<!-- Demonstrates: explicit token metadata present (exact tokens preserved); cost still null
     (never derived from tokens); build/lint pass. -->
