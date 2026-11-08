# Multiplayer stream implementation checklist

Base: `bfe44444718d80dd1fe8922d4117e13d6997524d`, including the seven approved background-input and cursor-renderer commits on `c086d199`.

The original checkout and its four modified provider files are excluded. Edge/notch glow is excluded. No install, live runtime update, or GitHub publication is authorized by this implementation pass.

1. [x] Persistent per-agent session streams through production desktop lifecycle; ordered within a stream, independent across agents, cancellation and diagnostic identity.
2. [ ] Same-window independent semantic targets; revalidated stable identities and region fencing, same-target serialization retained; real two-field harness.
3. [ ] Owner work mode and scoped foreground approval, end-to-end through pill/broker/dispatch.
4. [ ] Per-action background capabilities; semantic-first delivery with no unapproved physical fallback.
5. [ ] Bounded foreground handoff with safe owner-context restoration.
6. [ ] Existing custom cursor renderer driven by live streams and exact targets, persistent task lifetime and cleanup.
7. [ ] Provider-to-provider task coordination, assignment/claim/help/yield/resume, delivery/wakeup, verified completion and bounded stop.
8. [ ] Final integrated checks and repeatable acceptance/evidence plan.

Existing source evidence: T1 exercises overlapping WM_CHAR writes to two native helper windows; T2 exercises same-stage serialization; T3 exercises real Notepad background text while an independent foreground typer runs. These are preserved, and do not establish arbitrary-app or two-distinct-fields coverage by themselves.

Item 1 verification: 40 tests passed (`agent-input-stream.test.ts` and `task-desktop-stage.test.ts`); focused native-input-stream TypeScript project and full root TypeScript check passed. The normal Windows sandbox stalls in the existing local-store directory-publication path before stream code; the same suite completes outside that sandbox. The isolated worktree uses the already installed pill dependencies through a local directory junction; no dependency files were changed.
