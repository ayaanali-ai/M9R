<!-- SYNTHETIC / REDACTED example. Not customer data. No secrets. No real source. -->

# SYNTHETIC Gemini CLI-style run (redacted example)

Project/tool: launch-site (synthetic)
Agent used: Gemini CLI-style agent (synthetic run)
Goal of the run: Draft homepage marketing copy and a results report blurb
Was it successful: Yes, but the draft copy overclaimed

Run notes:
```
[synthetic] generated homepage hero copy
[synthetic] generated "results" section copy
[synthetic] draft copy claimed: "cuts your AI bill by 40%, guaranteed"
[synthetic] draft copy claimed: "production-validated savings"
[synthetic] no measured cost/energy data exists to support these claims
```

Commands run: (none — copy drafting run)

Files changed:
- src/app/page.tsx (draft hero copy)
- src/app/report/page.tsx (draft results blurb)

Known token/cost metadata (explicit):
- prompt tokens: 640
- candidates tokens: 410
- total tokens: 1050
- cost: not reported (unknown)
- energy: unknown

What felt wasteful:
- The drafted public copy made unsupported savings/production claims with no measured evidence.

Can RunLeak quote this publicly? yes (synthetic example).

<!-- Demonstrates: claims_drift evidence (unsupported public-copy claims); explicit token
     metadata present; cost/energy stay unknown (never estimated). -->
