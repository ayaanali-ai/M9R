# Item #25 — an independent pointer for headless-route-less targets

Status: **designed, not built.** Per the owner's explicit instruction, this is a design
document only; no code changes ship with it. Scope: decide the approach before any
implementation work is scheduled, so it can be built once, correctly, rather than
discovered piecemeal during a live rehearsal.

## The constraint (confirmed, not assumed)

Per `PROGRESS_NOTES.md` section 14.6: for a target with **no headless route at all** —
the example is Paint's raw canvas, which exposes no UIA Invoke/Value pattern and no
`WM_CHAR`/`PostMessage` queue — `SendInput` is the only way in, and `SendInput` always
drives **the one real OS cursor**. Every other M9R dispatch path (UIA invoke, UIA value
write, `WM_CHAR`/`PostMessageW` injection) is headless: it does not require moving the
visible system cursor at all, so two agents acting through those paths never fight over
one pointer. Paint's canvas (and anything else with zero headless route) is the one case
where M9R is already forced onto the real cursor today, so it is also the one case where
two agents can collide.

Windows does not give an application a second cursor to use instead:

- There is exactly **one system cursor** and **one active input desktop** per Windows
  session. `SendInput` always targets whichever desktop is currently active — it has no
  per-window or per-process targeting.
- `CreateDesktop` can create additional virtual desktops, but switching to one hides the
  owner's own screen; it does not give simultaneous visual co-presence of two live
  cursors, which is the actual product requirement (the owner and/or a second agent
  needs to keep watching the primary desktop while this agent works).
- A kernel-level virtual HID driver (a synthetic mouse/keyboard device) still ends up
  driving input on the *same* active desktop as everything else once Windows routes it;
  it does not create a second screen or a second cursor either. It would let M9R
  originate `SendInput`-equivalent events from a different logical device, but the
  OS-level collision (one cursor, one desktop) is unchanged.
- App-specific message injection (`WM_CHAR`/`PostMessageW`, UIA patterns) is by
  definition unavailable here — that is the premise of this item. If a target gains a
  headless route later, it moves out of this problem entirely and needs no independent
  pointer.

So "independent pointer" cannot mean a second cursor on the same visible desktop — Windows
has no such primitive. It can only mean a second **surface**: a separate screen, with its
own cursor, that the agent drives instead of the one the owner is looking at.

## Options considered

1. **Kernel-level virtual HID driver.** Rejected per above: it changes which process
   originates the input event, not which desktop/cursor receives it. Doesn't solve
   simultaneous co-presence. Also the highest-risk option to build and ship (kernel-mode
   driver signing, crash blast radius, antivirus/EDR false positives) for a problem it
   doesn't actually fix.
2. **Virtual-desktop switching (`CreateDesktop`/`SwitchDesktop`).** Gives a genuinely
   separate cursor and input stream, but switching *hides* the owner's current desktop —
   it is mutually exclusive visual presence, not parallel. Usable only if the product
   accepts "the owner's screen blanks to the agent's desktop while it works," which
   conflicts with the multi-agent/parallel-cursor demo this item exists to support.
3. **Isolated secondary Windows session (e.g. loopback RDP).** Windows supports multiple
   concurrent sessions reachable via Remote Desktop even on a single machine — a loopback
   RDP connection to `localhost` (or `127.0.0.1`) opens a second, genuinely separate
   session with its own desktop, its own cursor, and its own input queue, rendered into an
   ordinary window on the owner's primary desktop. The owner keeps watching their own
   screen; the agent's cursor lives inside the RDP window, fully independent of the real
   system cursor. This is the only option of the three that gives true simultaneous visual
   co-presence without new kernel code.
4. **App-specific injection.** Not applicable by definition — this item is scoped to
   targets with no such route.

## Recommendation

**Isolated secondary Windows session via loopback RDP** (option 3). It is the only
candidate that satisfies the actual requirement (owner and agent both have a live,
independently-driven cursor visible at the same time) using only existing OS primitives,
with no kernel driver to sign, ship, or get flagged by AV/EDR.

Known costs/open questions for whoever builds this, intentionally left open here rather
than decided prematurely:

- Requires Windows Pro/Enterprise-class RDP host support (or a loopback-capable RDP
  listener) — needs a concrete compatibility check against the SKUs M9R actually targets
  before committing resources.
- A second session means a second desktop-session worth of GPU/compositor/app state;
  the target app (e.g. Paint) must be launched *inside* that session, not shared with the
  owner's own running instance — this is a real second process, not a view into the
  existing one.
- The RDP client window itself needs to be captured into M9R's own cursor-overlay
  presentation layer so the agent's pointer inside it reads as "this agent is working,"
  consistent with every other target type — that capture/overlay integration is new work,
  not reuse of the existing `cursor_overlay.rs` path (which assumes one shared desktop).
- Latency/resource cost of a second session per concurrently-active no-headless-route
  target needs to be measured before this is considered viable for more than one such
  agent at a time.

## Explicit non-goals of this document

This document decides the *approach*, not the implementation. No code, test, or
infrastructure for a secondary session ships with it. Building it is separate,
follow-on work, to be scheduled and estimated on its own — the owner's instruction was to
design this before testing/rehearsal, not to build it before testing/rehearsal.
