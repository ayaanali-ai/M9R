# C5 — Cua Driver Windows re-test

**Status: DONE — signed off (2026-10-04)**

Reference: [official Cua Driver README](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md). The report uses the typed SDK surface and keeps the native package isolated from M9R.

## Acceptance target

Using the newest Cua Driver release, record whether click, type, scroll, drag, and screenshot work in the background on Chromium, Electron, and a native Windows app. Record the route, delivery mode, verification state, and any explicit fallback/refusal. This is a report-only compatibility task; it does not add Cua Driver to M9R's runtime.

## What was actually tested

The newest registry version observed during this run was `@trycua/cua-driver` **0.33.2**. It was installed only under `.workcache/c5-cua-driver-0.33.2`; the earlier `0.33.1` probe remains under `.workcache/c5-cua-driver`. The Windows optional package supplied the native `.node` runtime and SDK DLL. No PATH change, autostart task, daemon, account, or user Chrome profile was modified. The final matrix was run by the owner from an interactive PowerShell session on 2026-10-04.

### SDK/native preflight

The embedded SDK runtime loaded successfully:

- `isAvailable()` returned `true`.
- `metadata()` for the current package returned driver version `0.33.2`, contract `0.8.0`, and capability version `1`.
- `listApps` returned 114 processes.
- The final native run found the controlled fixture by its window title after Windows transferred it from launcher PID `13240` to Notepad PID `50236` (`c5-native-fixture.txt - Notepad`). The launcher-PID filter reported zero windows, so the report records the global fixture-title match rather than treating PID handoff as a driver failure.

### Native Windows fixture — Notepad

The test opened a temporary fixture file in a separate Notepad process and closed that process after the run.

| Capability | Observed result | Classification |
|---|---|---|
| Screenshot | `getWindowState(includeScreenshot: true)` wrote a PNG (24,490 bytes in the final owner-session run). | **PASS** |
| Click, background | Posted to Notepad PID `50236` with `effect: 2`, `route: 1`; no foreground escalation was reported. | **PASS — delivery observed; target-state verification is separate** |
| Type, background | Sent 19 characters through background `PostMessage`, but returned `effect: unverifiable`; the fixture file did not contain the marker afterward. | **PARTIAL / unverified** |
| Scroll, background | Explicitly refused with `background_unavailable` for target class `Notepad`; foreground retry recommended. | **FAIL for background / classified** |
| Drag, background | Posted through `global_input`, but returned `effect: unverifiable`; it was not a verified background delivery. | **PARTIAL / unverified** |

The run is evidence of the current Windows behavior, not a pass. A foreground retry is a separate behavior and cannot be counted toward the background acceptance criterion.

### Chromium

The first launch of Chrome 154.0.8037.97 crashed its GPU process with Windows status `-1073741790` (`0xC000001D`). A second isolated run using `--disable-gpu --in-process-gpu --disable-extensions` did expose a visible window and produced an action matrix with driver `0.33.2`:

| Capability | Observed result | Classification |
|---|---|---|
| Screenshot | 61,479-byte PNG before and after the final owner-session run. | **PASS** |
| Click, background | Posted to Chromium with no foreground swap. | **PASS** |
| Type, background | Explicit `background_unavailable` refusal for `Chrome_WidgetWin_1`; foreground retry recommended. | **FAIL for background / classified** |
| Scroll, background | Explicit `background_unavailable` refusal for `Chrome_WidgetWin_1`; foreground retry recommended. | **FAIL for background / classified** |
| Drag | Explicit `background_occluded` refusal because the target start point was covered by another window; foreground retry recommended. | **FAIL for background / classified** |

This is observed owner-session Cua Driver evidence rather than an untested Chromium row. The GPU workaround is isolated to the compatibility probe and is not an M9R runtime change.

### Electron

The current Electron registry version is **44.5.1**. The final owner-session run with the isolated runtime and the GPU/sandbox flags exposed an `electron.exe` window and completed the action matrix:

| Capability | Observed result | Classification |
|---|---|---|
| Screenshot | `getWindowState(includeScreenshot: true)` wrote a 38,096-byte PNG after the run. | **PASS** |
| Click, background | Posted with `effect: 2`, `route: 1`, and no foreground swap in the driver summary. | **PASS — delivery observed; target-state verification is separate** |
| Type, background | Explicit `background_unavailable` refusal for `Chrome_WidgetWin_1`; foreground retry recommended. | **FAIL for background / classified** |
| Scroll, background | Explicit `background_unavailable` refusal for `Chrome_WidgetWin_1`; foreground retry recommended. | **FAIL for background / classified** |
| Drag, background | Sent through `global_input` / synthetic-pen injection, but returned `effect: unverifiable`. | **PARTIAL / unverified** |

An earlier attempt displayed a Windows `0xC0000005` Electron crash dialog. The final rerun completed successfully after the probe's BigInt serialization fix; the crash is retained as a reproducibility note, not used to erase the final action evidence.

## Why this matters to M9R

M9R's existing quiet browser path is its own CDP broker (`src/lib/native/agent-chrome-input.ts` and related modules). C5 does **not** show that M9R has integrated Cua Driver, and this report does not add it as a dependency. C5 is the gate before any desktop-app scope is widened.

## Acceptance result

The final owner-session run supplies an observed, action-by-action result for Chromium, Electron, and a native Windows app using Driver `0.33.2`. Every requested capability is either a screenshot/click delivery, an explicit background refusal with its foreground escalation, or an explicitly unverified delivery. C5 is therefore **DONE — signed off as a compatibility report**. This sign-off does not claim that type, scroll, or drag work in the background on these targets; those limitations are the result.
