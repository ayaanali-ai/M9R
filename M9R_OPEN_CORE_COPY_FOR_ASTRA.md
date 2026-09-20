# Homepage "Open core" section: draft copy (hand this to Astra)

Status: **draft, 2026-09-20.** Based on `docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md` v2. Every line below must be true on the day the site goes live: the bracketed notes say what has to ship first. Design, layout and tone of voice are Astra's; this is the substance.

## Rules for this section
1. Say **"source-available open core"**. Never say "open source": the licence is BUSL-1.1, which is not an OSI open-source licence.
2. Say only what is built. Anything marked [after N1] or [later] must not appear as available until then.
3. Plain and calm. No "revolutionary", no fake numbers, no fake logos.

## Section headline (pick one)
- "The part that touches your machine, you can read."
- "Read every line that runs on your computer."
- "Open where it matters. Hosted where it helps."

## Lead paragraph
M9R connects the agents you already use, and to do that it edits your agent settings and reads your projects. So the local part is source-available: you can read it, run it, and see exactly what it changes. The network and the team features are the hosted service.

## Three short points (each as its own small window or room, per the site design)
1. **Read it.** The code that runs on your machine is public. `m9r init` shows what it will change before it changes anything, backs up every file, and `m9r uninstall` puts it all back. [after N1]
2. **Works without us.** Local-only mode needs no account and no network. Your agents talk to each other on your own machine. [after N1]
3. **Your logins stay yours.** M9R never touches your Claude, Codex or OpenCode credentials. Each agent keeps running in its own app.

## Free and paid, in one plain table
| | Free, for one person | Paid |
|---|---|---|
| All your agents on your own machine | Yes, no limit | |
| Reach your agents across your own computers | | Yes |
| Timeline and activity dashboard | Yes, recent history | Longer history and search |
| Phone approvals and notifications | | Yes |
| Teams, roles, shared memory, audit | | Yes [later] |
| Agents that work with other people's agents | | Yes [later] |

Line under the table: "Free means free for one person. You pay when it needs the cloud, the network or a team."

## What we keep, and why
"We keep the hosted service, the network, our brand and our support. You can run the code yourself for your own use; you can't resell it as a competing hosted service." (This restates the licence's use grant in plain words.)

## Small print line (footer of the section)
"M9R is source-available under the Business Source License 1.1 and converts to GPL-2.0-or-later on 2029-09-04. Read the licence on GitHub."

## FAQ lines (optional, accordion)
- **Is it open source?** It is source-available open core. You can read, modify and self-host it for your own use. The Business Source License does not allow offering it as a competing hosted service.
- **Do I need an account?** Not for local-only mode. [after N1]
- **What does M9R send to the cloud?** Task and activity metadata, with secrets redacted first. Full private transcripts stay on your machine. [after N1]
- **Can I self-host?** Yes, for your own use.
- **Will it always be free for one person?** That is the plan for the first release. Pricing for paid features is set separately.

## Do not use
"open source", "fully open", "free forever" (until owner decides), "trusted by", any customer count, any performance number we have not measured, and any statement that team or cross-user features exist today.
