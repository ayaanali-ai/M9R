<!-- SYNTHETIC / REDACTED example. Not customer data. No secrets. No real source. -->

# SYNTHETIC Claude Code-style summary (redacted example)

Project/tool: acme-web (synthetic)
Agent used: Claude Code (synthetic summary)
Goal of the run: Extract the marketing nav into a shared component
Was it successful: Yes, after two failed builds

Summary:
- Read src/components/Nav.tsx.
- Read src/components/Nav.tsx again (no edit between reads).
- Edited src/components/Nav.tsx to extract a shared <NavLinks /> component.
- Ran `npm run build` -> FAILED (type error in Nav.tsx).
- Edited src/components/Footer.tsx (unrelated) and src/app/page.tsx (unrelated).
- Ran `npm run build` -> FAILED (same type error).
- Edited src/components/Nav.tsx again -> fixed the real type error.
- Ran `npm run build` -> OK.
- Ran `npm run lint` -> OK.

Commands run:
- npm run build
- npm run lint

Files changed:
- src/components/Nav.tsx
- src/components/Footer.tsx
- src/app/page.tsx

Known token/cost metadata: not reported by the tool (unknown).

What felt wasteful:
- Re-read the same file with no edit in between.
- Two failed builds with edits to unrelated files before isolating the real error.
- Used the strongest model for a simple formatting / lint fix (model overkill).

Can RunLeak quote this publicly? yes (synthetic example).

<!-- Demonstrates: redundant_file_read + build_fix_loop + model_overkill evidence; usage
     metadata MISSING, so exact tokens/cost stay null (unknown stays unknown). -->
