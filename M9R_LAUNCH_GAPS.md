# Launch gap register (2026-09-20)

Purpose: everything I could verify that would make M9R look broken, dishonest or unfinished to someone who tries it or reads about it, with evidence, a fix, and who does it. Each item was checked against the live site, the published npm package, the public repository, the code, or a primary source; where I could not verify something it says so. Nothing here has been fixed unless marked **done**.

## A. Broken right now (a new person hits these first)
| # | Gap | Evidence | Fix | Who |
|---|---|---|---|---|
| A1 | **The published CLI cannot reach the service.** `m9r-cli` 0.6.14 has `https://m9r-web-staging.m9r.workers.dev` baked in as its default in 8 places; that Worker was deleted on 2026-09-20 and now returns 404. The live homepage tells visitors to run `npx m9r-cli connect`, which therefore fails. I said earlier the published CLI would keep working because both Workers share a database; that stopped being true when the staging Worker was deleted. | `npm pack m9r-cli@0.6.14` and grep; `curl` of the old host returns 404, of `app` returns 401 on `/api/agent/whoami` | Publish 0.6.15 (the repo default is already `app`), and meanwhile redeploy a small shim Worker named `m9r-web-staging` that proxies `/api/*` to `app` and redirects pages (a redirect alone would drop the CLI's Authorization header) | shim: me; publish: owner |
| A2 | **Sign-in on `app.m9r.workers.dev` will fail** until the host is on the Supabase redirect list. Everything account-based depends on it (approving `connect`, the dashboard). | Not yet added; I cannot change Supabase Auth settings | Add `https://app.m9r.workers.dev/**` under Authentication, URL Configuration | owner |
| A3 | **Email addresses point at domains nobody owns.** Pages show `contact@m9r.dev` and `hello@m9r.dev` (unregistered per the `.dev` registry), the live homepage shows `runleak@proton.me`, push settings use `admin@m9r.app` (unregistered). Anyone who registers `m9r.dev` would receive real users' mail. The email sender is `OathLock <onboarding@resend.dev>`, the Resend sandbox, which can only send to the account owner, so no invite or confirmation email can reach anyone else. | grep of `src/`, `wrangler.jsonc`; registry lookups | Buy the domain, set up Email Routing and sending, replace every address and the sender name | owner buys; me wire |

## B. Wrong or misleading in our own materials
| # | Gap | Evidence | Fix |
|---|---|---|---|
| B1 | **Command name.** The package installs `m9r-cli` and `oathlock`, not `m9r`. My README section, the designer file and the CLI's own next-step text say `m9r ...`. | `cli/package.json` bin | **Done:** added an `m9r` bin alias (takes effect at the next publish). Until then use `m9r-cli`. |
| B2 | **Hooks written by `npx m9r-cli setup` would point into the npx cache**, which is later cleared, so the hooks would die silently (they fail silent by design). | `hookEntryPath` resolves next to the running module | At setup, copy the small hook runtime (5 files) to `~/.m9r/bin/` and point hooks there, as the older capture hook does per repo. Also refuse a dev-tree path. |
| B3 | **Waitlist contradiction.** The owner decided to keep a waitlist; the new copy says "No waitlist" and "Can I sign up now? Yes". There is no waitlist route, table or form at all. | `src/lib/marketing-content.ts`, `src/app/pricing/page.tsx`; no `/api/waitlist` | Align the copy, then build form, API and double opt-in (needs the domain) |
| B4 | **Old brand showing.** "OathLock" appears in 8 user-facing files, twice on the live homepage, in the CLI alias `oathlock`, the `OATHLOCK_*` environment variables, and the folder `.oathlock/` (hooks, capture, memory). | grep; live homepage | Rename user-visible strings now; move the folder to `.m9r/` with a migration and keep `.oathlock` readable for one release |
| B5 | **Live homepage tone and content** (profanity, `runleak@proton.me`, `npx m9r-cli connect` that cannot work per A1). The new homepage is not deployed; `/docs` and `/faq` return 404 on the live site. | live fetch | Replace when Astra's site is ready; until then consider a plain holding page |
| B6 | **`connect` is missing from the published `--help`**, so the documented first command is invisible. | published help output | Fixed in the repo help; ships with the next publish |

## C. Shared context and memory (the Mosaic comparison)
| # | Gap | Evidence | Fix |
|---|---|---|---|
| C1 | **We never show users where their memory lives.** The folder is `.oathlock/memory/<owner>/<channel>/<session>.md` (109 files, 4.5 MB here); no page, command, doc or the dashboard Memory view says where it is or what is in it. Mosaic's demo is described as showing its store location. | grep of README, marketing copy, `MemoryView.tsx` | A `m9r-cli memory` command (prints the path, lists recent sessions, opens the folder), the path shown on the web Memory page and in the docs, folder renamed per B4 |
| C2 | **Agents are not told to use it**, there is no index, and files are raw transcripts up to 503 KB (about 125,000 tokens). `search_memory` exists only in channel sessions. | file sizes; bootstrap block text | The C1 slice in `M9R_NEXT_BUILD_PLAN.md` section 8 (distilled files, index, instruction update, relevance hint) |
| C3 | **Cross-person sharing is unverified end to end.** | not tested | Test with a second account after A2 |
| C4 | **N1 session card pointed at a non-existent `index.md`.** | code | **Done** |

## D. Coverage and honesty of claims
| # | Gap | Fix |
|---|---|---|
| D1 | `m9r setup` covers **Claude Code only**. Codex needs N2 and a manual `/hooks` trust step; OpenCode is unbuilt. The current copy says so ("native preview", "not yet"): keep it that way and never list Codex or OpenCode as working until they are. | keep copy honest; ship N2, N7a |
| D2 | Tested on **Windows only**; Claude Desktop **unverified** (docs say hooks fire there); no macOS or Linux login service. Mosaic is macOS-first, so many developers will be on Mac. | test on a Mac; document the platforms plainly |
| D3 | **Competitor facts were wrong in our own notes.** Mosaic also has live multiplayer terminals with human control and is GPL-3.0 (genuinely open source); we cannot claim live collaboration they lack. | **Done** in `M9R_COMPETITORS.md`; reflect in positioning |
| D4 | **Public repository is stale** (`ayaanali-ai/M9R`, last pushed 2026-09-15, licence shown as "Other") and does not contain this week's work or the Apache-2.0 decision. | after counsel, push and add a clear LICENSE/NOTICE per component |

## E. Quality
| # | Gap | Fix |
|---|---|---|
| E1 | 16 TypeScript errors that were hidden until 2026-09-20 (11 from Stage 1/N1 were fixed): `ui-button.test`, `jev.test`, `conversation-service`, `open-next.config`, and the obsolete container wrappers. | clean before any release gate; delete the wrappers |
| E2 | Two failing tests not caused by this work: `cli-package` "packed CLI runtime" (Windows temp-folder EPERM, fails on the committed code too) and a homepage-structure test tied to uncommitted homepage edits. | fix the temp cleanup; update the test with the new homepage |
| E3 | The deleted staging Worker held old baked secrets; the Supabase service-role key, Resend key and lead webhook were in that bundle. | optional rotation (owner) |

## What I could not verify
Mosaic's demo videos and the exact location their demo shows; how Mosaic agents actually read the store in the product; cross-account behaviour of our memory export.

## Status update (2026-09-20, later): owner answers and what changed
- **A1 published CLI points at the deleted staging host:** fixed in the next publish. `m9r-cli@0.6.15` is built, dry-run verified (82 files, 311.7 kB), and its default address is `app.m9r.workers.dev` (checked in the packed tarball). The optional proxy shim for already-installed 0.6.14 copies was **not** built (owner asked what it is; recommendation: skip it if 0.6.15 goes out now, because only people who already installed 0.6.14 benefit). Owner publishes.
- **A2 Supabase redirect:** owner reports it is added. **Not verified by me** (I cannot sign in). Test: open `https://app.m9r.workers.dev/auth` and sign in once.
- **A3 email addresses and domain:** owner deferred buying a domain ("not now"). Still true: pages show `contact@m9r.dev` / `hello@m9r.dev` (unregistered) and the live homepage shows `runleak@proton.me`. Sender name changed to `M9R` (takes effect at the next web deploy; it is still the Resend sandbox address, which only reaches the account owner).
- **B1 command name:** decided `m9r-cli` (the package name). All docs, CLI output, README and the designer file now say `m9r-cli`; the `m9r` alias I had added was removed.
- **B2 hooks under npx:** **done.** `setup` copies the 5-file hook program into `~/.m9r/bin/` (with a `package.json` marking it as ES modules), points the hooks there, refreshes the copy when the CLI is updated, refuses if the program is missing next to the CLI, and `uninstall` removes it. Verified on the real packed tarball installed into a scratch folder: setup, the copied hook printing an inbox item, the doctor block, and a clean uninstall.
- **B3 waitlist:** owner decision now: **no waitlist** (open sign-up). The new copy already says so; no waitlist backend or double opt-in is needed. This reverses the earlier "keep the waitlist" decision.
- **B4 old brand:** sender name changed. **Not done:** the identifiers `.oathlock/` (folder), `OATHLOCK:...` block markers in users' `CLAUDE.md`/`AGENTS.md`, `OATHLOCK.md`, `OATHLOCK_*` environment variables and the `oathlock` command alias. Renaming markers and folders needs a compatibility migration (read both names for a release, write the new one) or existing installs stop updating and uninstalling cleanly; planned as its own slice.
- **B6 `connect` missing from `--help`:** fixed in 0.6.15 (verified in the packed help output).
