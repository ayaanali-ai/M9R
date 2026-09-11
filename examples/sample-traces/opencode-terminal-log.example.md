<!-- SYNTHETIC / REDACTED example. Not customer data. No secrets. No real source. -->

# SYNTHETIC OpenCode-style terminal log (redacted example)

Project/tool: docs-site (synthetic)
Agent used: OpenCode-style agent (synthetic terminal log)
Goal of the run: Fix a failing build and tidy the homepage
Was it successful: Eventually, after repeated build attempts

Terminal log:
```
$ npm run build
[synthetic] ERROR: Type error in src/app/page.tsx
$ # edited src/app/layout.tsx (unrelated)
$ npm run build
[synthetic] ERROR: Type error in src/app/page.tsx (same error)
$ # edited src/components/Hero.tsx (unrelated)
$ npm run build
[synthetic] ERROR: Type error in src/app/page.tsx (same error)
$ # finally edited src/app/page.tsx
$ npm run build
[synthetic] OK
$ npm run lint
[synthetic] OK
```

Commands run:
- npm run build (x4)
- npm run lint

Files changed:
- src/app/layout.tsx
- src/components/Hero.tsx
- src/app/page.tsx

Known token/cost metadata: not reported (unknown).

Additional notes (for detector coverage):
- Pasted the entire build log (thousands of lines, truncated) into the run each time.
- Tried again, same error, another attempt after several attempts before diagnosing.
- Re-ran the same grep search repeatedly with no new input.

What felt wasteful:
- Three failed builds, twice editing unrelated files before fixing the real error.
- Carrying the full build log forward and retrying without isolating the root cause.

Can RunLeak quote this publicly? yes (synthetic example).

<!-- Demonstrates: build_fix_loop + scope_creep + bloated_tool_output + retry_spiral +
     repeated_tool_call evidence; usage metadata MISSING so exact tokens/cost stay null;
     build eventually passes. -->
