# C5 — Cua Driver Windows re-test

**Status: PARTIAL — not signed off (2026-10-04)**

Reference: [official Cua Driver README](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md). The report uses the typed SDK surface and keeps the native package isolated from M9R.

## Acceptance target

Using the newest Cua Driver release, record whether click, type, scroll, drag, and screenshot work in the background on Chromium, Electron, and a native Windows app. Record the route, delivery mode, verification state, and any explicit fallback/refusal. This is a report-only compatibility task; it does not add Cua Driver to M9R's runtime.

## What was actually tested

The newest registry version observed during this run was `@trycua/cua-driver` **0.33.2**. It was installed only under `.workcache/c5-cua-driver-0.33.2`; the earlier `0.33.1` probe remains under `.workcache/c5-cua-driver`. The Windows optional package supplied the native `.node` runtime and SDK DLL. No PATH change, autostart task, daemon, account, or user Chrome profile was modified.

### SDK/native preflight

The embedded SDK runtime loaded successfully:

- `isAvailable()` returned `true`.
- `metadata()` for the current package returned driver version `0.33.2`, contract `0.8.0`, and capability version `1`.
- `listApps` returned 114 processes.
- With no visible fixture, `listWindows` returned zero windows; with the controlled Notepad fixture it returned one visible window.

### Native Windows fixture — Notepad

The test opened a temporary fixture file in a separate Notepad process and closed that process after the run.

| Capability | Observed result | Classification |
|---|---|---|
| Screenshot | `getWindowState(includeScreenshot: true)` wrote a PNG (21,852 bytes in the latest 0.33.2 run). | **PASS** |
| Click, background | Refused with `background_unavailable`: “UIA pixel click busy”; no fallback input was sent. | **FAIL for background** |
| Type, background | Posted through `PostMessage`, but returned `effect: unverifiable` and recommended foreground retry. The fixture file did not contain the marker afterward. | **PARTIAL / unverified** |
| Scroll, background | Explicitly refused: background delivery is unavailable for Notepad mouse scroll. | **FAIL for background** |
| Drag | Posted through global input, but returned `effect: unverifiable`; it was not a verified background delivery. | **PARTIAL / unverified** |

The run is evidence of the current Windows behavior, not a pass. A foreground retry is a separate behavior and cannot be counted toward the background acceptance criterion.

### Chromium

The first launch of Chrome 154.0.8037.97 crashed its GPU process with Windows status `-1073741790` (`0xC000001D`). A second isolated run using `--disable-gpu --in-process-gpu --disable-extensions` did expose a visible window and produced an action matrix with driver `0.33.2`:

| Capability | Observed result | Classification |
|---|---|---|
| Screenshot | 25,400-byte PNG before and after the run. | **PASS** |
| Click, background | Posted to Chromium with no foreground swap. | **PASS** |
| Type, background | Explicit `background_unavailable` refusal for `Chrome_WidgetWin_1`; foreground retry recommended. | **FAIL for background / classified** |
| Scroll, background | Explicit `background_unavailable` refusal for `Chrome_WidgetWin_1`; foreground retry recommended. | **FAIL for background / classified** |
| Drag | Explicit background refusal because `InjectSyntheticPointerInput` returned access denied; foreground retry recommended. | **FAIL for background / classified** |

This is now observed Cua Driver evidence rather than an untested Chromium row. The GPU workaround is isolated to the compatibility probe and is not an M9R runtime change.

### Electron

Not signed off. The current Electron registry version is **44.5.1**. The isolated runtime and fixture were run with and without GPU/sandbox flags, including the newest Driver `0.33.2`; the process still terminated with `0xC0000005 EXCEPTION_ACCESS_VIOLATION` before exposing a visible window. No click, type, scroll, drag, or screenshot result is claimed for Electron. This remains a host-runtime blocker, not a Cua Driver pass or fail.

## Why this matters to M9R

M9R's existing quiet browser path is its own CDP broker (`src/lib/native/agent-chrome-input.ts` and related modules). C5 does **not** show that M9R has integrated Cua Driver, and this report does not add it as a dependency. C5 is the gate before any desktop-app scope is widened.

## Remaining C5 gates

The upstream test guidance requires Windows E2E to run from an interactive console or RDP session. The Cua Driver session can request desktop scope, but the current Codex execution context is `msi\\codexsandboxoffline`; its desktop capture returns `BitBlt failed: The handle is invalid (0x80070006)`. The native computer-control bridge also reports that the trusted `sky` service is not configured. Chromium now has a classified matrix, and Notepad has a classified matrix, but Electron still has no visible-window evidence. A clean three-framework result requires running the prepared probes inside the owner's interactive Windows session.

1. Run the prepared `0.33.2` matrix from the owner's interactive Windows session (the files are already under `.workcache/c5-cua-driver-0.33.2`).
2. Capture an Electron window and run the same five capabilities; if Electron still crashes there, record that host result explicitly.
3. Repeat the native run with the newest matching Driver binary and capture verified foreground fallbacks separately from background results.
4. Publish the action-by-action matrix and only mark C5 **DONE** if all three framework rows have observed evidence and the background behavior is clearly classified.
