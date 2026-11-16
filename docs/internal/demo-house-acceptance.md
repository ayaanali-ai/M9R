# Shared house drawing rehearsal

Status: implementation checks in progress; live acceptance not yet run.

The owner chose this workflow on 2026-11-15: Claude Code and Codex agree on
house colors and approximate size, record their agreement in a new Sticky
Note, then draw together in one Paint window. One agent edits while the other
observes and offers useful checks; they hand over deliberately so both
contribute. These are rehearsal instructions, not app-specific runtime code.

## Owner instruction for each run

@claude @codex Work together on ONE house drawing. First discuss and agree on
the house's colors, approximate size, and who will draw each part. Exchange a
proposal and a useful response before starting. Record the final agreement
once in a new Sticky Note. Open ONE Paint window and use that same canvas.
Claude draws the walls and roof while Codex observes and checks the result;
then explicitly hand over so Codex draws the door and windows while Claude
observes. The observer may inspect and send specific feedback but must not
change tools, selection, colors, or focus during the other agent's editing
turn. Refresh the shared window after each handoff. Correct actual mistakes
if found; do not invent criticism. Preserve unrelated windows and documents.
Save the final drawing as a new uniquely named PNG in Desktop, reopen that
file, and both verify the requested house is visible before reporting done.
Keep discussion brief, natural, and visible in the M9R conversation.

## Acceptance evidence

- Record installed source/build identity, run start/end, task and conversation
  lineage, final path, and observed result. Never substitute narration for proof.
- Both agents exchange relevant messages with readable speaker/recipient labels.
- One agreement note and one shared Paint PID/HWND; no competing canvases.
- Both contribute, with explicit editing handoff and useful observer feedback.
- Final saved/reopened artifact visibly matches the agreed plan.
- Both cursors become visible and clear after their work ends, including the
  final marker. No owner cursor/focus theft from the overlay.
- No human rescue, wrong-window input, duplicated text/work, or blind replay of
  uncertain actions. If a run fails, retain the actual error/evidence and stop
  treating the build as accepted.
- Three consecutive passing complete runs. Use fresh output filenames. Change
  the agreed colors or proportions between runs; do not add app-specific fixes
  or pre-draw the artifact to obtain a pass.

## Verification boundaries

Unit/fixture checks cover native bitmap clearing, cursor host lifecycle,
replacement semantics, durable peer-message fallback, bounded conversation
context at action boundaries, pill participant propagation, and shared HWND
binding. These are prerequisites, not proof of live Paint competence.

The shared-interface instructions use existing observation, work-claim, and
mutation-fence capabilities. They guide editor/observer roles; they are not a
new native transaction lock covering every multi-call drawing sequence.
Live interleaving, Windows activation, and the initial-marker failure mechanism
remain to be verified in the combined installed build.

## Live runs

Pending combined candidate build, tagged installation, and rehearsal.

### Run 1 — failed, v22 / 37ed798d

Installed candidate `2026-11-15T21-54-26-775Z-37ed798d`, release tag
`release-20261115-recovery-v22`. Submitted 2026-11-16T00:05:29Z;
owner tasks T413 (Claude) and T414 (Codex), delegated task T415,
conversation `conversation-1df11eccedabc63971a6c491`.
No completed house PNG was produced. Agents reported separate agreement-note
work; Paint discovery timed out. Claude's roster query incorrectly reported no
other agents because managed native sessions consulted legacy endpoint activity.
The packaged renderer fallback looked up Explorer's identity instead of the
requested AppsFolder identity and did not retain the resolved exact image path.
These source defects have regression coverage; the next installed build still
requires a complete live run. The supervisor deliberately stopped both agents
with an owner stop command; this was not a product crash or owner stop request.
Passing complete rehearsals: **0 / 3**.
