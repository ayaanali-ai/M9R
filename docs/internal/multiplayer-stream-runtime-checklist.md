# Multiplayer stream implementation checklist

Base: `bfe44444718d80dd1fe8922d4117e13d6997524d`, including the seven approved background-input and cursor-renderer commits on `c086d199`.

The original checkout and its four modified provider files are excluded. Edge/notch glow is excluded. No install, live runtime update, or GitHub publication is authorized by this implementation pass.

1. [x] Persistent per-agent session streams through production desktop lifecycle; ordered within a stream, independent across agents, cancellation and diagnostic identity.
2. [x] Same-window independent semantic targets; revalidated stable identities and region fencing, same-target serialization retained; real two-field harness.
3. [ ] Owner work mode and scoped foreground approval, end-to-end through pill/broker/dispatch.
4. [ ] Per-action background capabilities; semantic-first delivery with no unapproved physical fallback.
5. [ ] Bounded foreground handoff with safe owner-context restoration.
6. [ ] Existing custom cursor renderer driven by live streams and exact targets, persistent task lifetime and cleanup.
7. [ ] Provider-to-provider task coordination, assignment/claim/help/yield/resume, delivery/wakeup, verified completion and bounded stop.
8. [ ] Final integrated checks and repeatable acceptance/evidence plan.

Existing source evidence: T1 exercises overlapping WM_CHAR writes to two native helper windows; T2 exercises same-stage serialization; T3 exercises real Notepad background text while an independent foreground typer runs. These are preserved, and do not establish arbitrary-app or two-distinct-fields coverage by themselves.

Item 1 verification: 40 tests passed (`agent-input-stream.test.ts` and `task-desktop-stage.test.ts`); focused native-input-stream TypeScript project and full root TypeScript check passed. The normal Windows sandbox stalls in the existing local-store directory-publication path before stream code; the same suite completes outside that sandbox. The isolated worktree uses the already installed pill dependencies through a local directory junction; no dependency files were changed.

## Item 2 verification and rerun

Independent streams now use separate, lazily started native helper processes. Shared HWND binding requires an explicit broker fence and an active assignment. Only complete, unambiguous, revalidated UIA ValuePattern controls get independent regions; weak identities and other operations retain the window fence. Region-scoped writes cannot fall back to shared-caret input. RuntimeId is a live revalidation epoch, not a durable field key. Revoked streams and broker shutdown reap their native helpers.

The supported same-window concurrency boundary is **independent ValuePattern replacements only**. Clicks, shared-caret typing, scroll, window manipulation and controls without a complete unique semantic identity remain serialized/excluded at window scope. This proves two-field semantic concurrency, not arbitrary simultaneous actions within an application.

Scoped regression suites passed (170 tests, including native-control-region, native-input-channels, multiplayer-dispatch-fence, task-desktop-stage, task-stage-actions, cua-stage-driver and windows-desktop-stage). The native production unit tests passed (3), including refusal of agent-context execution. Focused and full TypeScript checks passed.

Optional Windows proof, run from this worktree in an ordinary owner terminal:

```powershell
cargo build --offline --manifest-path native-input-host/Cargo.toml --features test-fixtures --bin m9r-native-input-fixture-host
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/register-alias.mjs --test ./scripts/native-same-window-streams.test.ts
```

This creates only a disposable, nonactivating two-edit fixture window. Its optional executable refuses targets outside its own marked form and is excluded from ordinary builds. The test uses production framed protocol, native revalidation and UIA SetValue. A fixture-only barrier immediately before the actual calls proves overlapping native in-flight dispatch across two helpers; both field values are read back. A same-field collision permits only one writer. It checks zero injected mouse/keyboard events, no target activation, owner cursor coordinates (inconclusive if physical owner movement occurs), and helper/process cleanup. It records counts, not keys or physical-input text. **This is gated concurrency stress evidence, not normal-case latency evidence or arbitrary-app coverage.** Production runtime/provider live acceptance remains post-install work.
