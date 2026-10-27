# M9R desktop and pill audit — 2026-10-17

## Scope and disposition

Owner requested an audit, including harmless live checks through M9R only, without a subagent. This is an evidence checkpoint, not completion of an exhaustive line-by-line audit or owner-readiness sign-off. No product implementation, runtime installation, process termination/restart, credentials, or architecture changes were performed by this audit. Other agents were editing this checkout concurrently; their changes are not attributed to this audit.

The local concurrency architecture discussed with the owner is a proposal awaiting review. It has not been added as an approved implementation requirement to the cumulative tracker.

## Observed live results

1. The current authenticated Codex session's inbox returned empty. Persisted state nevertheless contained T251, the owner's Calculator request, delivered by push to this exact session at 2026-10-17T18:07:03.309Z. Its delivery state was queued and no result was recorded. T247/T248/T250 also had push-delivery records. Therefore the earlier assertion that an empty inbox proved failed pill delivery was wrong.
2. `m9r_stage_prepare(T251, owner-preview)` succeeded. The stored task could be used without asking the owner to resend or copy credentials.
3. `m9r_stage_app(T251, launch, calc.exe)` failed after approximately 26 seconds: "The desktop launch outcome is uncertain; inspect the stage before issuing another launch. The requested application did not expose a new exact window. Its launcher response is not proof it opened."
4. Process inspection found CalculatorApp.exe PID 15984. Existence alone does not establish when it launched, which window the broker saw, or whether it matched. The subsequent app-window observation reported no selected application window.
5. A fresh desktop capture was followed by one M9R taskbar click at the visible Calculator icon. Windows acknowledged shell invocation, but the returned capture still showed the prior foreground app. Activation was not verified. No launch or click was blindly replayed.
6. `m9r_stage_app(T250, launch, explorer.exe)` succeeded. A structure read returned partial status, 378 elements, and a same-capture fallback. Search Home was an enabled Edit supporting set_value/text.
7. `replace_element` on that freshly returned search ref set `hello`; the returned image visibly contained hello. This was UIA value replacement, not proof of animated keyboard typing. A later capture after interruption showed an empty search field; the cause was not attributed without correlated evidence.
8. The provider-neutral structured observation returned target 9f8a45d3-3537-47c4-9f79-03a9eeeca1f7, revision 5f8b2fb3-a5c5-48eb-8026-73ce04deb58a, structured representation, controls and capture, but no structure status/elements object. Observation took about 5.1 seconds. The direct stage structure read did return that metadata. This discrepancy requires installed contract reconciliation.

No physical-pointer before/after measurements, human-paced typing video, comprehensive action-family matrix, closed-window recovery experiment, or independent provider-parity run was completed during this checkpoint.

## Findings and code evidence

### A. Task discovery conflates unread delivery with pending work

`local-store.ts::claimInboxTasks` excludes queued/done pushes and already-delivered rows. This is an intentional replay fence. `mcp-server.ts`'s inbox therefore cannot serve as a pending-task listing. The agent-facing response "Inbox is empty" does not explain that delivered unfinished work may still exist. The computer-use resolver requires explicit taskId when multiple delivered unfinished tasks exist, while stage tools require taskId outright. Several outstanding pushes make discovery ambiguous even though delivery succeeded.

Needed: a provider-neutral authenticated pending/current-work lookup, clear unread-versus-pending semantics, and durable binding of a pushed user turn to its task context. Preserve replay fences. Do not repair this by indiscriminate resend or clearing deliveredAt.

### B. Provider-tool fallback was an agent decision

The earlier use of OpenAI Computer Use was made by this assistant after misclassifying a native task. No M9R code path invoking @oai/sky was established by this audit. M9R cannot be said to automatically fall back to another provider based on that event. Product enforcement needs tool exposure/routing constraints in addition to agent instructions, within what each provider supports.

### C. Extension disable is source-only at this checkpoint

Current dirty `mcp-server.ts` gates extension tools behind WEB_EXTENSION_ROUTE_ENABLED=false. This session's tool catalogue still exposes m9r_web_*; earlier calls reached extension-readiness timeouts. The tracker explicitly says the disable change has not been rebuilt/deployed. Local source and callable installed surface differ. A permanent release needs convergence and contract checks; skipping extension-specific tests alone does not prove installed removal.

### D. Launch aliases and renderer identity are distinct

`task-stage-apps.ts::stageWindowMatchesApp` compares executable basenames, allowing a separate windowExecutable when populated. Resolving calc.exe through PATH supplies the launcher basename, while the observed running app is CalculatorApp.exe. This is a strong source-backed explanation for the selection failure; the exact driver candidate list/launch trace still needs correlation before declaring it the sole cause. The general fix must carry installed application identity across launcher handoff, including an already-existing window, rather than special-case Calculator.

Owner-preview currently adopts existing windows specially for Chromium, while general app discovery mostly requires a window absent from the pre-launch list. A pre-existing single-instance app can therefore activate without satisfying selection. Reuse by literal appId also makes aliases potentially behave differently.

### E. Reference identity remains unsafe without metadata

`cua-stage-driver.ts::elementByToken` re-walks the tree and may fall back to a matching numeric token suffix. With no expected role/label, a single suffix candidate is accepted. Tree position uniqueness does not establish the same control after a layout change. Source supports optional expected metadata, but the installed tool schema exposed in this session does not expose those fields on click_element/replace_element. Persisted observation-to-control identity needs stronger validation.

### F. Point targeting chooses the smallest child, not necessarily the actionable field

`hitTarget` selects the smallest enabled containing element. It can choose a Text child inside an Edit; replace mode subsequently requires set_value. Earlier T249 hit this exact refusal while the parent Edit was present and replace_element succeeded. Needs a generic actionable-ancestor policy and a regression reproducing the parent/child case. Do not treat it as an app limitation.

### G. Semantic click does not remember a typing field

Coordinate click paths remember confirmed editable targets. `clickElement` dispatches and returns without the corresponding field-memory update. A following type/key/hotkey can therefore take a different targeting/presentation path depending on whether selection used pixels or structure. Needs one shared post-selection mechanism.

### H. Typing has multiple materially different semantics

Foreground type_text carries delay_ms=30 by default. Remembered background fields and replace_element use atomic set_value; these cannot demonstrate character-by-character typing. Text that appears instantly can be consistent with the current selected operation. Human-paced visual typing must be explicitly implemented and verified without repeatedly overwriting document contents or losing Unicode fidelity. Exact label equality in remembered-field validation can also reject a field whose accessible name changes with its value.

### I. Native cursor colors are not owned by a durable M9R palette

`agentCursorDetails` hashes handle plus session ID for the cursor session name. `ensureAgentSession` selects cua.default with motion settings but no durable provider color assignment. The pill separately hardcodes Claude #D97757, Codex #7AA2F7, OpenCode #34D399 and generic #9AA1AC. No unified persisted color allocator was found in these paths. The driver's exact default color-selection algorithm was not established; session churn as the precise algorithmic cause remains unverified.

Proposed reviewable fix: persist an appearance identity by stable agent/provider identity; allocate available accessible colors once, preserve assignments across reconnect/restart, retain distinct session labels, and pass the same assignment to pill and native cursor theme/rendering. Validate driver theme customization support before selecting the implementation. Multiple simultaneous sessions need distinct labels/patterns even if provider color is shared.

### J. Cursor overlay position is not physical input isolation

Foreground actions use SendInput. `computer-use-mcp.ts` explicitly reports pointerIsolationVerified:false. The separate native browser click helper in `native-input-host/src/win32.rs` reads and moves the shared system pointer; it belongs to the browser-native helper path and must not be conflated with every Cua action. No evidence establishes that this helper caused the reported Cua top-left motion. That specific motion remains unresolved pending timestamped pointer/overlay/window geometry traces.

### K. Shared-desktop foreground ownership is not concurrent independent focus

The driver helper tries background delivery, then brings the target forward on recognized refusal. Explicit foreground actions also activate first. User focus changes can conflict with that transition. Multiple sessions have per-stage queues, but independent queues do not establish independent physical input or serialize all shared focus use. Audit cancellation, human intervention, and cross-agent input leasing together.

### L. Recovery reopens an app, not its full task state

`task-desktop-stage.ts::act` narrows relaunch recovery to a genuinely gone anchor, uses persisted app identity when available, and avoids the earlier same-queue re-entry deadlock. That is useful existing work. It does not persist a general file/browser-location/document checkpoint, safely re-resolve stale refs after relaunch, or restore arbitrary unsaved content. Retrying an old coordinate/ref after recovery can still target a changed screen. The shared action receipt protects dispatch replay, not restoration of all application semantics.

### M. Structure-first still captures pixels and truncates

`readStructure` requests UIA plus screenshot for same-capture fallback, bounded to 512 elements/depth 24; fallback can follow bounded retries. The neutral wrapper limits structured elements to 200. Native Chrome UIA is not automatically the website DOM. Pine Sense/See caching and push/diff observation are not implemented by this tree read. Preserve fallback but expose truncation, accurate capabilities and timing, and avoid calling a screenshot-backed controls list a complete semantic tree.

### N. Additional API gaps

window_frame accepts negative coordinates in its specialized validation but an earlier shared x/y validator rejects negative values first, limiting negative-origin monitors. Native pixel scrolling is explicitly refused. Window move/resize, menus and clipboard do not consistently move the overlay to a meaningful action target. Clipboard is shared. Dedicated minimize/maximize state operations and richer clipboard payloads are not exposed by the current stage action union even though surrounding driver/window capabilities are broader. These require capability inventory and live checks, not assumed support.

### O. Existing live harness is unsafe to run as-is

Untracked `scripts/_live-item8-check.ts` contains a global `taskkill /IM notepad.exe /F` before creating its test window. It also hardcodes screen points, catches fatal errors as text, and does not exercise every action its header claims. This audit did not run it. Replace that approach with exact disposable-window ownership and nonzero failure reporting before reuse.

## Runtime inventory

Observed one feed engine (PID 2028), two MCP parent/child engine pairs (18524/10312 and 21596/20876), one overlay (17248), one broker (6568), one Cua driver child of the broker (26156). These roles explain the engine count; count alone does not prove duplicates. No process was killed.

Installed engine hash matched its manifest. Installed build source was f720e4a6 with dirty=true and build time 2026-10-16T20:05:57.155Z. Checkout HEAD was b84394ea plus ongoing dirty changes. Broker hash differed from the shared manifest but matched its separately managed web-broker-install.json; this is not by itself corruption. Loaded-image/source convergence and newly changed extension registration still need explicit activation evidence.

Pill desktop record reported visible:true with PID 17248 during the check.

## Verification run

- Eight isolated test files passed outside the sandbox, exit 0: cua-stage-driver, task-stage-actions, task-desktop-stage, native-codex-delivery, mcp-connection, task-delivery-pump, computer-use-mcp, computer-use-router (185 dot-reporter results).
- Seven further files passed, exit 0: pill-state, pill-shells, pill-bridge, desktop-pill-presence, runtime-build-identity, stage-operation-receipts, computer-use-contract (51 dot-reporter results).
- Initial sandbox test run failed on EPERM renaming temporary fixture state locks. The same affected tests passed with normal temporary-file access. Do not classify those initial failures as proven product failures.
- Source fixtures do not close runtime/live requirements. No fresh all-action, all-provider, pointer-isolation or background equivalence claim is made.

## Twelve-item reconciliation

Retain the original numbering. This does not erase historical successful live evidence or accept contradictory blanket claims that no live evidence exists.

1. Baseline/snapshot: historical closure retained; this audit did not recreate it.
2. Provenance: engine disk hash verified; current source and live exposed schema differ. Convergence open.
3. Lifecycle: roles inventoried, no duplicate proven by counts; drain/restart/watchdog/no-interruption live matrix not rerun.
4. Quarantine: historical review exists; no new deletion/retention sign-off in this audit.
5. Binding/continuity: authenticated native preparation worked; pending-push discovery and cross-provider renewal remain gaps.
6. User-facing metadata: historical T201 reply evidence exists; ordinary tool/schema/task-context behavior and exposure need scope-specific review, not denial of that proof.
7. Structure observation: native and Chrome historical proofs exist; fresh Explorer partial tree/fallback verified. Contract fidelity, truncation and native browser content coverage remain open.
8. Actions/cursors: fresh semantic field replacement worked; Calculator selection failed. Findings D through N remain relevant; no universal sign-off.
9. Route exclusivity: source disable exists, installed extension tools remain exposed. Live convergence/exclusivity open.
10. Provider neutrality: shared fixtures passed; independent live provider parity not rerun. Earlier Claude T246 recorded a real unbound-identity failure.
11. Full live matrix: open; earlier positive individual runs remain valid evidence within their exact scope.
12. Owner test card/demo gates: gated on unresolved acceptance. No owner-ready sign-off.

## Local desktop terminology relevant to the proposal

Current `native-input-host/src/virtual_desktop.rs` implements Windows shell virtual desktops (Task View family), using a private shell COM interface for creation/activation gated to Windows builds 26100 and 26200. This is not Win32 CreateDesktopW isolation, a second interactive Windows session, or a VM. It does not establish independent simultaneous input streams.

Task View virtual desktops, Win32 desktop objects, separate interactive Windows sessions, and local VMs are different mechanisms. Further local concurrency architecture selection is pending owner/Claude review. Do not silently replace personal existing windows with VM windows or describe an unproven mechanism as equivalent background input.

## Resumed audit: additional direct evidence, approximately 18:43–18:50 UTC

### Live results added

- A fresh Search Home Edit ref advertised set_value/text. `click_element` with foreground confirmation was refused: "The accessibility element does not advertise a click action; no click was sent." This is a live semantic-selection gap, even though the element is editable and enabled.
- After fresh capture, a coordinate click on the same search field succeeded via foreground SendInput. `type` with insert/foreground then visibly entered all five characters of hello. The driver reported "Typed 5 char(s) ... via SendInput". The owner reported that this sequence drove the physical pointer. That observation is consistent with this action's foreground route, but no timestamped pointer-position measurement was taken. A final image does not prove typing cadence.
- Ctrl+A was dispatched; the returned image did not clearly show the requested field highlight, so the hotkey's intended effect was not signed off. File Explorer was transitioning to search results during this sequence; input focus/caret continuity remains a shared mechanism to inspect.
- Closed only the audit-created Explorer window with one exact-window Alt+F4. The tool returned uncertain because the post-action capture no longer had a window. No Alt+F4 replay was issued. A subsequent direct stage read_structure succeeded and showed Home again, with a fresh tree. Recovery reopened the app but did not restore the hello search.
- Repeated the controlled close once to compare the *other* observation entry point. `m9r_computer_observe(target=app-window, structured)` then failed: "This task has no selected application window. Open the requested app before using the app view." Source confirms that its prepare call can delete the missing selection before the act recovery branch can use it. This is a reproduced shared recovery inconsistency.
- Reopened Explorer explicitly through M9R and restored hello using a fresh ref. The returned image confirmed hello. Recorded the original Explorer result for T250 and the unsuccessful Calculator attempt for T251 without claiming a calculation occurred.
- A metadata-only clipboard read (includeText=false) returned supported=true, format names and text=null. Clipboard content was neither read nor changed. Clipboard writes/paste fidelity remain untested.
- A second neutral structured observation again omitted the structure object/status, despite a direct stage read having it. It returned 105 controls, a screenshot capture, no observe.accessibility capability and no text-replace capability. Observation time was approximately 10.45 seconds. This is not a basis for a speed claim.

### Further findings

P. **Preparation destroys recovery context.** In owner-preview prepare(), a missing/moved selected window leads to adoptCurrentDesktop(), clearing the persisted anchor/appId and deleting ownedApps. The direct act() recovery needs that very selection. The source explains the live direct-stage-versus-neutral-observe difference above. Keep recovery intent separate from a currently valid window anchor.

Q. **Background insertion can replace the whole field.** deliverTextToExactWindow() sends selected-field background text through typeIntoExactField(), which calls set_value with only the supplied new text. It does not read the prior value/caret or implement insertion. This is a source-confirmed mismatch for mode=insert when that branch is used; a live non-empty-field preservation test is still required.

R. **Foreground lease checks are not wired to these target routes.** The generic router defines owner-input leases, but saveObservation() constructs routes with requiresOwnerInputLease=false and action routing supplies no ownerInputLease. Direct stage actions also bypass that router and have per-session queues rather than a cross-session shared-input arbiter. Existing permissions authorize access; they are not a proof of exclusive focus/input ownership. Do not claim the generic router's lease tests establish this live integration.

S. **Stop does not yet have a demonstrated in-flight input cancellation contract.** Stage policy/identity is rechecked at several boundaries and the cursor reaper observes revocation. The shared stage/action/driver calls inspected do not carry an AbortSignal through an in-flight text/drag call. Cancellation of the provider turn, hiding a pill card, revoking future calls and stopping an already-dispatched operation are different effects. End-to-end explicit-stop latency still needs proof.

T. **Known pre-dispatch refusal becomes generic uncertainty.** The live click_element refusal explicitly said no click was sent, but the stage service reported an uncertain operation. All exceptions from runTaskStageAction() are settled uncertain, including pre-dispatch validation failures. Preserve uncertainty after ambiguous dispatch, but represent proven no-dispatch failures separately so recovery does not stall needlessly.

U. **Failed post-action capture obscures completed close actions.** Both controlled Alt+F4 calls reached the close effect but the capture failed afterward. This is the same broader dispatch-versus-effect-versus-capture distinction, requiring a verifiable window-closed postcondition. Do not retry the close simply because its capture failed.

V. **Lifecycle intent must survive a window and session context change.** Automatic reopening exists, but prepare(), explicit desktop selection, and a broker restart have different effects on selection state. The persisted record stores appId/anchor, not a durable full task checkpoint. Closed/moved/minimized/occluded windows need explicit separate states rather than a generic unavailable category.

W. **Multi-monitor validation is demonstrably inconsistent.** A direct invocation of parseTaskStageAction({kind:window_frame,view:app,x:-100,y:50,width:800,height:600}) returned "Invalid stage action coordinates." The desktop-to-screen mapping also stores width/height without an explicit virtual-screen origin in that helper. The negative-origin case requires a coherent geometry contract; live multiple-display proof remains absent.

X. **Launcher matching reproduced in isolation.** stageWindowMatchesApp({appName:CalculatorApp.exe,...},{executable:C:\\Windows\\System32\\calc.exe,args:[]}) returned false. This supports finding D and the actual launch failure; the exact installed driver's discovery candidates still need capture before concluding it explains every failed Calculator launch.

Y. **Shared browser/window ownership is not established by per-stage queues.** Existing personal Chromium selection can return the same owner window to different agent stages. Registry registration checks stage names but does not reject an anchor already registered by another stage. Need a window ownership/coordination check spanning providers before claiming simultaneous agents cannot interfere. No second provider was invoked in this audit.

Z. **Capability descriptions lag lower-layer action support.** Driver clickElement accepts expand/toggle/select as well as click/invoke/press, while capabilitiesForDesktop() and the neutral preflight semantic-click test still recognize only click/invoke/press. Combined with the 200-control prefix limit and installed metadata loss, a working lower-level capability can disappear at the agent-facing layer.

AA. **Cursor/typing presentation still depends on outcome category.** The live foreground click returned foregroundConfirmed=true but status=unverifiable. Driver field memory only records status=confirmed. The neutral layer may accept foreground confirmation as selection, while the driver has no remembered field to reposition to for later typing. This explains a source-level inconsistency, not a measured account of every cursor jump. Semantic click has no corresponding memory update either.

AB. **Window presentation deliberately flashes instead of activating.** native-input-host::present_owner_window() uses no-activate presentation and FLASHW_TRAY. task-desktop-stage.ts then makes a best-effort focus call and swallows its failure. The observed taskbar flashing is therefore consistent with explicit implementation choices, not proof that Windows universally prohibits focus. Expose presentation/focus outcomes distinctly.

AC. **Creation and cleanup can leave untracked desktop state.** create() holds the registry lock across native desktop creation. If the native call succeeds but a validation/registry write fails, the created desktop is retained and may lack a mapping. Lock reclamation is age-only at 30 seconds and releases lack ownership tokens; review slow-holder/two-contender races. This is a source risk, not a newly observed abandoned desktop.

AD. **Appearance needs one stable owner.** Session-specific labels are useful for attribution, but appearance should be assigned by durable agent identity and shared across pill/cursor surfaces. The driver theme-selection contract accepts an installed theme ID, not a raw color property. A persistent M9R assignment alone will not recolor the native cursor unless that assignment is actually supported by the chosen theme/rendering mechanism. Validate this before implementation.

AE. **Freshness is bounded expiry, not event-driven scene tracking.** Desktop captures expire after 30 seconds. Desktop actions invalidate cached desktop captures, but app-window mutations do not uniformly invalidate those caches. Owner/other-agent window changes are not represented by a universal scene revision. Fresh hit-testing reduces some risk, but the prior screenshot's intended point can change meaning. Sense-style change notification remains relevant and unimplemented here.

### Additional verification and current source caveats

- Root npm run typecheck completed with exit 0.
- cargo test --manifest-path native-input-host/Cargo.toml --offline passed 16 tests (15 library, 1 binary); only incremental-cache hard-link warnings occurred. No installed helper was replaced.
- The earlier 236 isolated checks plus these 16 Rust tests total 252 passing checks across the audit runs. These are not 252 live desktop tests.
- Concurrent edits appeared in local-store.ts, task-delivery-pump.ts and native-codex-delivery.test.ts. Re-ran the two relevant delivery suites afterward: 41/41 passed, exit 0. Their new age-bound retry logic is source-only evidence unless separately deployed; it does not implement pending-task discovery.
- Audited key-file SHA-256 snapshot: cua-stage-driver.ts 075c2a1f273a36dd42997e78e6bded811f2666559d61ed3164b225dceec90ed3; task-desktop-stage.ts 75e4dea85e6d2be89de4a636d15a78755a14b04c3635ca6f4b7cef88b95b727f; computer-use-mcp.ts 7181f95710bc9021d416db5bc91f560bfc8e8a321e43fa0069c7a18c8c7e26bc; mcp-server.ts c30b04eb20e265539a514b25c20431285fbcfbb177ba42ad2ed55607d421f21e; task-delivery-pump.ts 18b666e728f46574eeb3a38f7836cad8a8ce4094cbc70ed9fe9863e353e83106. This is a point-in-time snapshot while others edit, not a frozen release baseline.

### Remaining live coverage, explicitly not claimed complete

| Capability | Evidence in this audit | Remaining proof |
|---|---|---|
| Delivery/binding | Persisted push and native preparation verified | Automatic current-task discovery and independent provider renewal |
| Launch/select | Explorer passes; calc.exe selection fails | Generic installed-app identity/handoff and existing-window selection |
| Structure | Direct Explorer tree partial, 378 elements, same-capture fallback | Neutral metadata fidelity, browser page semantics, bounded truncation behavior |
| Click/type | Foreground point click and complete hello visible; ref click refuses Edit | Semantic equivalence, nonempty-field insertion, Unicode/caret behavior, pacing video |
| Key/hotkey | Alt+F4 close/recovery effects observed; Ctrl+A dispatched | Full focus/selection proof and cancellation |
| Scroll/drag/window/menu | Source/fixture coverage inspected | Reversible before/after effects on disposable rich controls and exact restoration metadata |
| Clipboard | Metadata-only read returned formats and null text | Controlled write/paste/restore proof with owner data preserved |
| Recovery | Direct stage reopen works but loses search; neutral observe loses selection | Shared state restoration and fresh replanning across all entry points |
| Pointer/cursor | Owner reports pointer movement on SendInput sequence | Measured physical-pointer isolation, color persistence, multi-display alignment, idle/error motion |
| Concurrency | Per-stage queues and process roles verified | Cross-agent input ownership and independent live provider runs |

T252 initially awaited approval. The owner subsequently approved it; persisted approval event was 2026-10-17T18:49:15.604Z, after delivery/read at 18:48:43.279Z. The unread inbox did not redeliver that approval. Native preparation then succeeded; the following authorized tests were run without bypassing approval.

### T252 continuation — 2026-10-17 18:55 UTC

- Native scroll_delta, app view, x=62/y=435, deltaY=8 lines, confirmFocusForeground=true visibly scrolled the navigation pane. Receipt reported foreground SendInput, status=unverifiable; the visible movement, not that status, supports this limited pass.
- window_frame x=200/y=140/width=1100/height=750 returned confirmed with verified bounds; the app visibly restored to that size. A title-bar drag from app (500,22) to (550,62), 400 ms, dispatched via SendInput. A fresh desktop capture at 18:53:57 showed Explorer around screenshot (135,98), consistent with the expected physical position after movement. This is visible movement evidence, not an exact numeric post-drag bounds measurement.
- Fresh app capture identified Maximize. Native click (941,17) restored the maximized window, visibly verified. Operation dd60505c28b1bfd7ebf8634dc059eaf4fe19f8db89e18c7979a51da6bcf14ee3.
- Fresh search click (845,38), then Ctrl+A visibly selected hello; Right collapsed the selection, leaving hello unchanged. Hotkey operation ed6ba08d9743b0646d5c8e65b9faea4db3931d98aff3f925766e99751b9b0586; Right operation c5e72b6253137c3e26a9f8d6653575d3f33b16f56999ca2c9461a0b8fbc36a17.
- invoke_menu([View]) failed with "menu path segment 0 was not found" and an uncertain outcome. It was not replayed. Separate fresh native toolbar click (348,70) opened View; desktop capture at 18:55:02 proved the popup. App capture at 18:54:56 omitted that popup. Escape dismissed it. Click operation 6179bce2250a7ea643ae94b4479be5e78a53a5c90034d2ecd292153de58d3ccf; Escape aff6d86635eec1b95f3fe06b75b708ffe72bc0a88626e0983482a2b0712b807e.
- **AF: Exact-app visual capture can omit an owned popup.** Same live sequence showed no View menu in app capture but showed it in desktop capture. Popup-aware observation/targeting needs explicit coverage; a successful native menu click does not fix invoke_menu lookup.
- All live control in this continuation used M9R owner-preview. No provider built-in automation, extension route, product-code changes, process termination/restart, clipboard modification, or file edit was used. Existing search text and files were preserved. Window maximization restored; navigation scroll position was changed by the test.
- Remaining unproven: isolated physical pointer, persistent cursor colors/animation, background/foreground equivalence, independent provider concurrency/parity, stop latency, multi-display geometry, clipboard write/paste preservation, full Unicode/caret/pacing behavior, browser-native acceptance. These require additional controlled capabilities/authorization or independent sessions; this run does not close their release gates.
