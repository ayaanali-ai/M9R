use crate::{InputDispatchError, InputDispatchState, MouseButton};
use std::ffi::c_void;
use std::mem::size_of;

type Hwnd = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct KeyboardInput {
    vk: u16,
    scan: u16,
    flags: u32,
    time: u32,
    extra_info: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
union InputData {
    mouse: MouseInput,
    keyboard: KeyboardInput,
    alignment: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Input {
    kind: u32,
    data: InputData,
}

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> Hwnd;
    fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
    fn IsWindowVisible(window: Hwnd) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    fn Sleep(milliseconds: u32);
    fn SetForegroundWindow(window: Hwnd) -> i32;
    fn BringWindowToTop(window: Hwnd) -> i32;
    fn ShowWindow(window: Hwnd, command: i32) -> i32;
    fn IsIconic(window: Hwnd) -> i32;
    fn AttachThreadInput(attach_from: u32, attach_to: u32, attach: i32) -> i32;
    fn GetCurrentThreadId() -> u32;
}

const INPUT_MOUSE: u32 = 0;
const MOUSEEVENTF_MOVE: u32 = 0x0001;
const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
const MOUSEEVENTF_VIRTUALDESK: u32 = 0x4000;
const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;
const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;
const INPUT_KEYBOARD: u32 = 1;
const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const KEYEVENTF_UNICODE: u32 = 0x0004;
const SW_RESTORE: i32 = 9;
const SW_MINIMIZE: i32 = 6;
const SW_SHOW: i32 = 5;
const VK_MENU: u16 = 0x12;

/// A key to send: either a real virtual-key code (used for modifiers, function
/// keys, navigation keys, and any key the agent needs to combine with a
/// modifier -- Windows cannot deliver a *-down/-up pair for an arbitrary
/// Unicode character as a virtual key), or a literal Unicode code unit (used
/// for ordinary typed text, where `SendInput`'s `KEYEVENTF_UNICODE` mode
/// delivers the exact character without needing a keyboard-layout-specific
/// virtual-key mapping at all).
#[derive(Clone, Copy)]
pub enum KeySpec {
    Virtual { vk: u16, extended: bool },
    Unicode(u16),
}

/// Maps a key name as used throughout M9R's task/action layer to a virtual-key
/// code and whether it is one of the "extended" keys (the navigation cluster,
/// not their numpad counterparts) `SendInput` needs flagged. Single
/// letters/digits map to their ASCII value, which is also their VK code.
/// Punctuation VK codes below are the standard US keyboard layout OEM codes;
/// a non-US active layout may produce a different character for the same VK,
/// same as it would for any other application receiving these events.
pub fn vk_for_key_name(name: &str) -> Option<(u16, bool)> {
    let lower = name.to_ascii_lowercase();
    if name.len() == 1 {
        let ch = name.chars().next()?;
        if ch.is_ascii_alphanumeric() {
            return Some((ch.to_ascii_uppercase() as u16, false));
        }
        let oem = match ch {
            ';' => 0xBA,
            '=' => 0xBB,
            ',' => 0xBC,
            '-' => 0xBD,
            '.' => 0xBE,
            '/' => 0xBF,
            '`' => 0xC0,
            '[' => 0xDB,
            '\\' => 0xDC,
            ']' => 0xDD,
            '\'' => 0xDE,
            _ => return None,
        };
        return Some((oem, false));
    }
    if let Some(n) = lower.strip_prefix('f') {
        if let Ok(num) = n.parse::<u32>() {
            if (1..=24).contains(&num) {
                return Some(((0x70 + num - 1) as u16, false));
            }
        }
    }
    Some(match lower.as_str() {
        "ctrl" | "control" => (0x11, false),
        "alt" => (0x12, false),
        "shift" => (0x10, false),
        "meta" | "win" => (0x5B, true),
        "enter" | "return" => (0x0D, false),
        "escape" | "esc" => (0x1B, false),
        "tab" => (0x09, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" => (0x2E, true),
        "insert" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" => (0x21, true),
        "pagedown" => (0x22, true),
        "arrowup" | "up" => (0x26, true),
        "arrowdown" | "down" => (0x28, true),
        "arrowleft" | "left" => (0x25, true),
        "arrowright" | "right" => (0x27, true),
        "capslock" => (0x14, false),
        "printscreen" => (0x2C, true),
        _ => return None,
    })
}

fn send_key_event(key: KeySpec, up: bool) -> bool {
    let (vk, scan, mut flags) = match key {
        KeySpec::Virtual { vk, extended } => {
            (vk, 0, if extended { KEYEVENTF_EXTENDEDKEY } else { 0 })
        }
        KeySpec::Unicode(unit) => (0, unit, KEYEVENTF_UNICODE),
    };
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = Input {
        kind: INPUT_KEYBOARD,
        data: InputData {
            keyboard: KeyboardInput {
                vk,
                scan,
                flags,
                time: 0,
                extra_info: 0,
            },
        },
    };
    unsafe { SendInput(1, &input, size_of::<Input>() as i32) == 1 }
}

/// One attempt at `AttachThreadInput` + `SetForegroundWindow` for `window`.
/// Returns true once `GetForegroundWindow()` actually reports `window`.
fn try_raise_to_foreground(window: Hwnd) -> bool {
    unsafe {
        let foreground = GetForegroundWindow();
        let current_thread = GetCurrentThreadId();
        let mut foreground_thread = 0u32;
        if !foreground.is_null() {
            GetWindowThreadProcessId(foreground, &mut foreground_thread);
        }
        let mut target_thread = 0u32;
        GetWindowThreadProcessId(window, &mut target_thread);
        let attached_to_foreground = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, 1) != 0;
        let attached_to_target = target_thread != 0
            && target_thread != current_thread
            && target_thread != foreground_thread
            && AttachThreadInput(current_thread, target_thread, 1) != 0;
        BringWindowToTop(window);
        let raised = SetForegroundWindow(window) != 0;
        if attached_to_target {
            AttachThreadInput(current_thread, target_thread, 0);
        }
        if attached_to_foreground {
            AttachThreadInput(current_thread, foreground_thread, 0);
        }
        raised || GetForegroundWindow() == window
    }
}

/// Brings a window to the real OS foreground (the one that receives
/// `SendInput` keyboard events), not merely visually on top. Windows refuses
/// `SetForegroundWindow` from a background process's thread unless that
/// thread's input state is attached to the current foreground thread's (the
/// first attempt below), and can still refuse that even when attached --
/// Windows additionally locks foreground activation to whichever process most
/// recently received real input. Two further, equally standard workarounds
/// for that lock, tried in order before giving up: (1) a harmless dummy Alt
/// key tap via `SendInput`, which resets Windows' notion of "last input" and
/// is the same trick most input-automation tools use for this exact
/// restriction; (2) minimizing and immediately restoring the target window,
/// which Windows always permits regardless of the foreground lock.
pub fn bring_window_to_real_foreground(window: usize) -> Result<(), &'static str> {
    let window = window as Hwnd;
    if window.is_null() {
        return Err("no window handle was given to bring to the foreground");
    }
    unsafe {
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        } else if IsWindowVisible(window) == 0 {
            // A window can win real foreground activation (SetForegroundWindow
            // only moves Z-order/input focus) while still never having been
            // shown -- e.g. a just-launched app whose window exists but has
            // not painted/shown its first frame yet. That leaves it "focused"
            // (taskbar highlight, keyboard input reaching it) with nothing
            // visible on screen, which looked like a flaky invisible-success
            // bug from the outside. Force it visible before raising.
            ShowWindow(window, SW_SHOW);
        }
    }
    if try_raise_to_foreground(window) {
        return Ok(());
    }
    send_key_event(
        KeySpec::Virtual {
            vk: VK_MENU,
            extended: false,
        },
        false,
    );
    send_key_event(
        KeySpec::Virtual {
            vk: VK_MENU,
            extended: false,
        },
        true,
    );
    if try_raise_to_foreground(window) {
        return Ok(());
    }
    unsafe {
        ShowWindow(window, SW_MINIMIZE);
        ShowWindow(window, SW_RESTORE);
    }
    if try_raise_to_foreground(window) || unsafe { GetForegroundWindow() } == window {
        return Ok(());
    }
    Err("Windows declined to raise the target window to the foreground")
}

/// Sends one real key press-and-release (or a modifier-combination hotkey,
/// pressed in order and released in reverse order) via `SendInput`. The
/// caller is responsible for having already confirmed the intended window is
/// the real OS foreground -- `SendInput` keyboard events always go to
/// whichever window currently has that, never to a window the caller merely
/// intends to target.
pub fn send_key_combo(keys: &[KeySpec]) -> Result<(), InputDispatchError> {
    if keys.is_empty() || keys.len() > 4 {
        return Err(InputDispatchError::not_dispatched(
            "a key combination must contain 1-4 keys",
        ));
    }
    let mut input_sent = false;
    for key in keys {
        if !send_key_event(*key, false) {
            return Err(dispatch_error(
                "Windows declined a trusted key-down event",
                input_sent,
            ));
        }
        input_sent = true;
        unsafe { Sleep(8) };
    }
    unsafe { Sleep(16) };
    for key in keys.iter().rev() {
        if !send_key_event(*key, true) {
            return Err(dispatch_error(
                "Windows declined a trusted key-up event",
                input_sent,
            ));
        }
        input_sent = true;
        unsafe { Sleep(8) };
    }
    Ok(())
}

/// Types literal text by sending a Unicode down/up pair per UTF-16 code unit.
/// This bypasses virtual-key/keyboard-layout mapping entirely, so it works
/// for any character the target control can render, not just what the
/// system's active keyboard layout can produce.
pub fn send_unicode_text(text: &str) -> Result<(), InputDispatchError> {
    let mut input_sent = false;
    for unit in text.encode_utf16() {
        if !send_key_event(KeySpec::Unicode(unit), false) {
            return Err(dispatch_error(
                "Windows declined a trusted Unicode key-down event",
                input_sent,
            ));
        }
        input_sent = true;
        if !send_key_event(KeySpec::Unicode(unit), true) {
            return Err(dispatch_error(
                "Windows declined a trusted Unicode key-up event",
                input_sent,
            ));
        }
        input_sent = true;
        unsafe { Sleep(4) };
    }
    Ok(())
}

/// Sends one or more clicks of the given button at an absolute screen point.
/// The caller supplies real screen coordinates (already resolved from
/// whatever local/window-relative space the agent observed) -- this function
/// does no window lookup or DPI scaling of its own, unlike the Chrome-only
/// `click_visible_chrome_tab`.
pub fn send_click_at_screen_point(
    x: i32,
    y: i32,
    button: MouseButton,
    count: u32,
) -> Result<(), InputDispatchError> {
    if count < 1 || count > 3 {
        return Err(InputDispatchError::not_dispatched(
            "click count must be 1-3",
        ));
    }
    if !send_mouse(x, y, MOUSEEVENTF_MOVE) {
        return Err(InputDispatchError::not_dispatched(
            "Windows declined trusted mouse movement",
        ));
    }
    unsafe { Sleep(16) };
    let (down, up) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    for click in 0..count {
        if !send_mouse(x, y, down) {
            return Err(InputDispatchError::uncertain(
                "Windows declined the trusted mouse click after pointer movement was sent",
            ));
        }
        unsafe { Sleep(60) };
        if !send_mouse(x, y, up) {
            let _ = send_mouse(x, y, up);
            return Err(InputDispatchError::uncertain(
                "Windows declined the trusted mouse release after click input was sent",
            ));
        }
        if click + 1 < count {
            unsafe { Sleep(90) };
        }
    }
    Ok(())
}

/// Presses and holds the left button at an absolute screen point without
/// releasing it, moves to a second point, and releases -- a drag.
pub fn send_drag(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    duration_ms: u32,
) -> Result<(), InputDispatchError> {
    if !send_mouse(from_x, from_y, MOUSEEVENTF_MOVE) {
        return Err(InputDispatchError::not_dispatched(
            "Windows declined trusted mouse movement",
        ));
    }
    unsafe { Sleep(16) };
    if !send_mouse(from_x, from_y, MOUSEEVENTF_LEFTDOWN) {
        return Err(InputDispatchError::uncertain(
            "Windows declined the trusted mouse press after pointer movement was sent",
        ));
    }
    let steps = ((duration_ms / 16).clamp(8, 40)) as i32;
    for step in 1..=steps {
        let t = step as f64 / steps as f64;
        let x = (from_x as f64 + (to_x - from_x) as f64 * t).round() as i32;
        let y = (from_y as f64 + (to_y - from_y) as f64 * t).round() as i32;
        if !send_mouse(x, y, MOUSEEVENTF_MOVE) {
            let _ = send_mouse(to_x, to_y, MOUSEEVENTF_LEFTUP);
            return Err(InputDispatchError::uncertain(
                "Windows declined trusted mouse movement during the drag after drag input was sent",
            ));
        }
        unsafe { Sleep((duration_ms / steps as u32).max(1)) };
    }
    if !send_mouse(to_x, to_y, MOUSEEVENTF_LEFTUP) {
        let _ = send_mouse(to_x, to_y, MOUSEEVENTF_LEFTUP);
        return Err(InputDispatchError::uncertain(
            "Windows declined the trusted mouse release after drag input was sent",
        ));
    }
    Ok(())
}

/// Scrolls the mouse wheel at an absolute screen point. `amount` is in wheel
/// clicks (120 units each, matching `WHEEL_DELTA`); positive scrolls up.
pub fn send_scroll_at_screen_point_axis(
    x: i32,
    y: i32,
    amount: i32,
    horizontal: bool,
) -> Result<(), InputDispatchError> {
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 {
        return Err(InputDispatchError::not_dispatched(
            "Windows returned no virtual screen bounds",
        ));
    }
    if !send_mouse(x, y, MOUSEEVENTF_MOVE) {
        return Err(InputDispatchError::not_dispatched(
            "Windows declined trusted mouse movement",
        ));
    }
    unsafe { Sleep(16) };
    const MOUSEEVENTF_WHEEL: u32 = 0x0800;
    const MOUSEEVENTF_HWHEEL: u32 = 0x01000;
    let input = Input {
        kind: INPUT_MOUSE,
        data: InputData {
            mouse: MouseInput {
                dx: absolute_axis(x, origin_x, width),
                dy: absolute_axis(y, origin_y, height),
                mouse_data: (amount * 120) as u32,
                flags: (if horizontal {
                    MOUSEEVENTF_HWHEEL
                } else {
                    MOUSEEVENTF_WHEEL
                }) | MOUSEEVENTF_ABSOLUTE
                    | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                extra_info: 0,
            },
        },
    };
    if unsafe { SendInput(1, &input, size_of::<Input>() as i32) } != 1 {
        return Err(InputDispatchError::uncertain(
            "Windows declined the trusted scroll event after pointer movement was sent",
        ));
    }
    Ok(())
}

fn dispatch_error(message: &'static str, input_sent: bool) -> InputDispatchError {
    match input_sent {
        true => InputDispatchError::uncertain(message),
        false => InputDispatchError {
            message: message.to_owned(),
            state: InputDispatchState::NotDispatched,
        },
    }
}

fn absolute_axis(value: i32, origin: i32, extent: i32) -> i32 {
    if extent <= 1 {
        return 0;
    }
    (((value - origin) as f64 * 65_535.0 / (extent - 1) as f64).round() as i32).clamp(0, 65_535)
}

/// Sends a pointer event in physical screen coordinates. The Win32
/// `SM_*VIRTUALSCREEN` metrics describe the multi-monitor coordinate space;
/// this is unrelated to Windows Task View / virtual desktops.
fn send_mouse(x: i32, y: i32, flags: u32) -> bool {
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 {
        return false;
    }
    let input = Input {
        kind: INPUT_MOUSE,
        data: InputData {
            mouse: MouseInput {
                dx: absolute_axis(x, origin_x, width),
                dy: absolute_axis(y, origin_y, height),
                mouse_data: 0,
                flags: flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                extra_info: 0,
            },
        },
    };
    unsafe { SendInput(1, &input, size_of::<Input>() as i32) == 1 }
}
