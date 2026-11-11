use crate::{InputDispatchError, InputDispatchState, MouseButton};
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::atomic::{AtomicU32, AtomicU8};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;

type Hwnd = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point { x: i32, y: i32 }

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect { left: i32, top: i32, right: i32, bottom: i32 }

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
    fn GetWindowRect(window: Hwnd, rect: *mut Rect) -> i32;
    fn GetClientRect(window: Hwnd, rect: *mut Rect) -> i32;
    fn ScreenToClient(window: Hwnd, point: *mut Point) -> i32;
    fn ChildWindowFromPointEx(parent: Hwnd, point: Point, flags: u32) -> Hwnd;
    fn GetSystemMetrics(index: i32) -> i32;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    fn Sleep(milliseconds: u32);
    fn SetForegroundWindow(window: Hwnd) -> i32;
    fn BringWindowToTop(window: Hwnd) -> i32;
    fn ShowWindow(window: Hwnd, command: i32) -> i32;
    fn IsIconic(window: Hwnd) -> i32;
    fn AttachThreadInput(attach_from: u32, attach_to: u32, attach: i32) -> i32;
    fn GetCurrentThreadId() -> u32;
    fn SetWindowsHookExW(id_hook: i32, callback: Option<unsafe extern "system" fn(i32, usize, isize) -> isize>, module: *mut c_void, thread_id: u32) -> *mut c_void;
    fn UnhookWindowsHookEx(hook: *mut c_void) -> i32;
    fn CallNextHookEx(hook: *mut c_void, code: i32, wparam: usize, lparam: isize) -> isize;
    fn GetMessageW(message: *mut HookMessage, window: Hwnd, minimum: u32, maximum: u32) -> i32;
    fn TranslateMessage(message: *const HookMessage) -> i32;
    fn DispatchMessageW(message: *const HookMessage) -> isize;
    fn PeekMessageW(message: *mut HookMessage, window: Hwnd, minimum: u32, maximum: u32, remove: u32) -> i32;
    fn PostThreadMessageW(thread_id: u32, message: u32, wparam: usize, lparam: isize) -> i32;
    fn PostMessageW(window: Hwnd, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn EnumChildWindows(
        parent: Hwnd,
        callback: extern "system" fn(Hwnd, isize) -> i32,
        lparam: isize,
    ) -> i32;
    fn GetClassNameW(window: Hwnd, buffer: *mut u16, max_count: i32) -> i32;
}

const WH_KEYBOARD_LL: i32 = 13;
const WH_MOUSE_LL: i32 = 14;
const LLKHF_INJECTED: u32 = 0x10;
const LLMHF_INJECTED: u32 = 0x01;
const PM_NOREMOVE: u32 = 0;
const WM_M9R_INPUT_MONITOR_START: u32 = 0x8001;
const WM_M9R_INPUT_MONITOR_STOP: u32 = 0x8002;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MBUTTONDOWN: u32 = 0x0207;
const WM_MBUTTONUP: u32 = 0x0208;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_MOUSEHWHEEL: u32 = 0x020E;
const CWP_SKIPINVISIBLE: u32 = 0x0001;
const CWP_SKIPDISABLED: u32 = 0x0002;
const CWP_SKIPTRANSPARENT: u32 = 0x0004;
const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;
const MK_MBUTTON: usize = 0x0010;
const WHEEL_DELTA: i32 = 120;
static PHYSICAL_INPUT_EPOCH: AtomicU64 = AtomicU64::new(0);
static PHYSICAL_INPUT_MONITOR_ACTIVE: AtomicBool = AtomicBool::new(false);
static PHYSICAL_INPUT_MONITOR_STATUS: AtomicU8 = AtomicU8::new(0);
static PHYSICAL_INPUT_MONITOR_THREAD_ID: AtomicU32 = AtomicU32::new(0);
static PHYSICAL_INPUT_MONITOR_THREAD: OnceLock<Result<(), &'static str>> = OnceLock::new();
static PHYSICAL_INPUT_MONITOR_CONTROL: Mutex<()> = Mutex::new(());

#[repr(C)]
#[derive(Clone, Copy)]
struct HookPoint { x: i32, y: i32 }

#[repr(C)]
struct HookMessage {
    window: Hwnd,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    point: HookPoint,
    private: u32,
}

#[repr(C)]
struct LowLevelKeyboardEvent {
    virtual_key: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}

#[repr(C)]
struct LowLevelMouseEvent {
    point: HookPoint,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}

fn note_physical_input(flags: u32, injected_mask: u32) {
    if flags & injected_mask == 0 {
        PHYSICAL_INPUT_EPOCH.fetch_add(1, Ordering::Relaxed);
    }
}

unsafe extern "system" fn keyboard_input_monitor(code: i32, wparam: usize, lparam: isize) -> isize {
    if code >= 0 && lparam != 0 {
        // The callback reads only the injected flag; key values and timing are
        // deliberately neither retained nor logged.
        let event = unsafe { &*(lparam as *const LowLevelKeyboardEvent) };
        note_physical_input(event.flags, LLKHF_INJECTED);
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

unsafe extern "system" fn mouse_input_monitor(code: i32, wparam: usize, lparam: isize) -> isize {
    if code >= 0 && lparam != 0 {
        // The callback reads only the injected flag; coordinates and button
        // data are deliberately neither retained nor logged.
        let event = unsafe { &*(lparam as *const LowLevelMouseEvent) };
        note_physical_input(event.flags, LLMHF_INJECTED);
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
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

const VK_RETURN: u16 = 0x0D;

/// Treat all conventional newline spellings as one logical line break. The
/// foreground path turns that break into an actual Return key; the WM_CHAR
/// path maps it to the carriage return expected by classic multiline EDIT
/// controls. Keeping this normalization at the native text boundary makes
/// callers provider- and application-neutral.
fn normalize_text_line_endings(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                normalized.push('\n');
            }
            '\n' => normalized.push('\n'),
            other => normalized.push(other),
        }
    }
    normalized
}

fn foreground_text_key(unit: u16) -> KeySpec {
    if unit == b'\n' as u16 {
        KeySpec::Virtual {
            vk: VK_RETURN,
            extended: false,
        }
    } else {
        KeySpec::Unicode(unit)
    }
}

fn background_text_char(unit: u16) -> u16 {
    if unit == b'\n' as u16 {
        b'\r' as u16
    } else {
        unit
    }
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

fn keyboard_input(key: KeySpec, up: bool) -> Input {
    let (vk, scan, mut flags) = match key {
        KeySpec::Virtual { vk, extended } => (vk, 0, if extended { KEYEVENTF_EXTENDEDKEY } else { 0 }),
        KeySpec::Unicode(unit) => (0, unit, KEYEVENTF_UNICODE),
    };
    if up { flags |= KEYEVENTF_KEYUP; }
    Input { kind: INPUT_KEYBOARD, data: InputData { keyboard: KeyboardInput {
        vk, scan, flags, time: 0, extra_info: 0,
    } } }
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

fn ensure_physical_input_monitor_thread() -> Result<(), &'static str> {
    *PHYSICAL_INPUT_MONITOR_THREAD.get_or_init(|| {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        thread::Builder::new().name("m9r-physical-input-watch".to_owned()).spawn(move || {
            // Hooks are installed only for a foreground handoff. Between
            // handoffs this thread waits for private control messages and does
            // not observe owner input.
            let mut message = HookMessage {
                window: std::ptr::null_mut(), message: 0, wparam: 0, lparam: 0,
                time: 0, point: HookPoint { x: 0, y: 0 }, private: 0,
            };
            unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE); }
            PHYSICAL_INPUT_MONITOR_THREAD_ID.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
            if ready_tx.send(()).is_err() { return; }
            let (mut keyboard, mut mouse): (*mut c_void, *mut c_void) = (std::ptr::null_mut(), std::ptr::null_mut());
            loop {
                let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
                if result <= 0 { break; }
                match message.message {
                    WM_M9R_INPUT_MONITOR_START => {
                        if keyboard.is_null() {
                            keyboard = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_input_monitor), std::ptr::null_mut(), 0) };
                            if keyboard.is_null() {
                                PHYSICAL_INPUT_MONITOR_STATUS.store(2, Ordering::Release);
                                continue;
                            }
                            mouse = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_input_monitor), std::ptr::null_mut(), 0) };
                            if mouse.is_null() {
                                unsafe { UnhookWindowsHookEx(keyboard); }
                                keyboard = std::ptr::null_mut();
                                PHYSICAL_INPUT_MONITOR_STATUS.store(2, Ordering::Release);
                                continue;
                            }
                        }
                        PHYSICAL_INPUT_MONITOR_ACTIVE.store(true, Ordering::Release);
                        PHYSICAL_INPUT_MONITOR_STATUS.store(1, Ordering::Release);
                    }
                    WM_M9R_INPUT_MONITOR_STOP => {
                        PHYSICAL_INPUT_MONITOR_ACTIVE.store(false, Ordering::Release);
                        if !keyboard.is_null() { unsafe { UnhookWindowsHookEx(keyboard); } keyboard = std::ptr::null_mut(); }
                        if !mouse.is_null() { unsafe { UnhookWindowsHookEx(mouse); } mouse = std::ptr::null_mut(); }
                        PHYSICAL_INPUT_MONITOR_STATUS.store(0, Ordering::Release);
                    }
                    _ => unsafe { TranslateMessage(&message); DispatchMessageW(&message); },
                }
            }
            PHYSICAL_INPUT_MONITOR_ACTIVE.store(false, Ordering::Release);
            if !keyboard.is_null() { unsafe { UnhookWindowsHookEx(keyboard); } }
            if !mouse.is_null() { unsafe { UnhookWindowsHookEx(mouse); } }
            PHYSICAL_INPUT_MONITOR_THREAD_ID.store(0, Ordering::Release);
        }).map_err(|_| "Windows could not create the physical input-monitor thread")?;
        ready_rx.recv().map_err(|_| "Windows physical input-monitor thread stopped before initialization")
    })
}

fn wait_for_physical_input_monitor_status(expected: u8) -> Result<(), &'static str> {
    for _ in 0..1_000 {
        match PHYSICAL_INPUT_MONITOR_STATUS.load(Ordering::Acquire) {
            status if status == expected => return Ok(()),
            2 => return Err("Windows could not install the physical input-monitor hooks"),
            _ => thread::sleep(std::time::Duration::from_millis(1)),
        }
    }
    Err("Windows physical input-monitor did not acknowledge the handoff")
}

pub fn start_physical_input_monitor() -> Result<(), &'static str> {
    let _guard = PHYSICAL_INPUT_MONITOR_CONTROL.lock().map_err(|_| "physical input-monitor control is unavailable")?;
    if PHYSICAL_INPUT_MONITOR_ACTIVE.load(Ordering::Acquire) { return Ok(()); }
    ensure_physical_input_monitor_thread()?;
    PHYSICAL_INPUT_MONITOR_STATUS.store(0, Ordering::Release);
    let thread_id = PHYSICAL_INPUT_MONITOR_THREAD_ID.load(Ordering::Acquire);
    if thread_id == 0 || unsafe { PostThreadMessageW(thread_id, WM_M9R_INPUT_MONITOR_START, 0, 0) } == 0 {
        return Err("Windows could not start monitoring owner input during the foreground handoff");
    }
    wait_for_physical_input_monitor_status(1)
}

pub fn stop_physical_input_monitor() -> Result<(), &'static str> {
    let _guard = PHYSICAL_INPUT_MONITOR_CONTROL.lock().map_err(|_| "physical input-monitor control is unavailable")?;
    if !PHYSICAL_INPUT_MONITOR_ACTIVE.load(Ordering::Acquire) { return Ok(()); }
    let thread_id = PHYSICAL_INPUT_MONITOR_THREAD_ID.load(Ordering::Acquire);
    if thread_id == 0 || unsafe { PostThreadMessageW(thread_id, WM_M9R_INPUT_MONITOR_STOP, 0, 0) } == 0 {
        return Err("Windows could not stop the owner-input monitor after the foreground handoff");
    }
    wait_for_physical_input_monitor_status(0)
}

/// Returns an in-memory generation advanced only by non-injected keyboard or
/// mouse events. The low-level hooks inspect only the injected bit; they never
/// store key names, text, cursor coordinates, or button data. Agent SendInput
/// is excluded so an approved agent turn can restore focus unless the owner
/// supplied physical input during that turn.
pub fn physical_input_epoch() -> Result<u64, &'static str> {
    if !PHYSICAL_INPUT_MONITOR_ACTIVE.load(Ordering::Acquire) {
        return Err("Windows physical input-monitor thread is no longer active");
    }
    Ok(PHYSICAL_INPUT_EPOCH.load(Ordering::Acquire))
}

#[cfg(test)]
mod physical_input_monitor_tests {
    #[test]
    fn injected_events_do_not_advance_owner_input_epoch() {
        let before = super::PHYSICAL_INPUT_EPOCH.load(std::sync::atomic::Ordering::Relaxed);
        super::note_physical_input(super::LLKHF_INJECTED, super::LLKHF_INJECTED);
        assert_eq!(super::PHYSICAL_INPUT_EPOCH.load(std::sync::atomic::Ordering::Relaxed), before);
        super::note_physical_input(0, super::LLKHF_INJECTED);
        assert_eq!(super::PHYSICAL_INPUT_EPOCH.load(std::sync::atomic::Ordering::Relaxed), before + 1);
    }
}

/// Restores one previously captured owner window without synthetic keystrokes,
/// minimize/restore tricks, or showing a hidden window. The caller must first
/// verify the captured physical-input epoch and that the foreground is still the
/// exact authorized agent target.
pub fn restore_window_to_foreground(window: usize) -> bool {
    let window = window as Hwnd;
    !window.is_null() && unsafe { IsWindowVisible(window) != 0 && IsIconic(window) == 0 }
        && try_raise_to_foreground(window)
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
    let normalized = normalize_text_line_endings(text);
    let units = normalized.encode_utf16().collect::<Vec<_>>();
    if units.is_empty() { return Ok(()); }
    // One monolithic SendInput for the whole string drops/corrupts characters
    // whenever the target control can't keep up with an unthrottled burst
    // (observed live: everything after the first line garbled). Dispatch one
    // character's down/up pair per SendInput call, with the same inter-key
    // pacing every other dispatch loop in this file already uses.
    let mut total_inserted: u32 = 0;
    let expected = (units.len() as u32).saturating_mul(2);
    for unit in units {
        let key = foreground_text_key(unit);
        let pair = [keyboard_input(key, false), keyboard_input(key, true)];
        let inserted = unsafe { SendInput(2, pair.as_ptr(), size_of::<Input>() as i32) };
        total_inserted += inserted;
        if inserted != 2 { break; }
        unsafe { Sleep(8) };
    }
    let inserted = total_inserted;
    if inserted == expected { return Ok(()); }
    if inserted == 0 {
        return Err(InputDispatchError::not_dispatched("Windows declined the Unicode text input sequence"));
    }
    return Err(InputDispatchError::uncertain(format!(
        "Windows accepted {inserted} of {expected} Unicode text events; inspect the field before retrying"
    )));
}

/// `WM_CHAR`: a UTF-16 code unit delivered as a window message, consumed
/// directly by `DefWindowProc`/standard edit controls as literal text input.
/// Unlike `KEYEVENTF_UNICODE`, this is not a hardware-level event at all -- it
/// never enters the systemwide input queue and carries no notion of "the
/// foreground window", so it can be posted to a window that is not, and will
/// not become, the OS foreground window.
const WM_CHAR: u32 = 0x0102;

/// Types literal text into one specific window by posting `WM_CHAR` directly
/// to its message queue, one UTF-16 code unit at a time. This is the
/// background-safe sibling of `send_unicode_text`: it never touches
/// `SendInput`, never requires (or changes) OS foreground, and cannot steal
/// focus from whatever window the user is actually looking at. It only
/// reaches plain Win32 controls that handle `WM_CHAR` for text entry
/// (standard edit/richedit controls and anything built on them) -- a control
/// with its own custom input handling that ignores `WM_CHAR` is out of scope
/// for this channel and must fall back to the real-foreground `SendInput`
/// path or a UI Automation `SetValue`/pattern call instead.
///
/// `PostMessageW` only reports whether the message was successfully queued
/// for the target thread, not whether the control actually inserted the
/// character -- the same "best input signal available, verify the real
/// effect separately" contract every other dispatch primitive in this module
/// already has.
pub fn post_text_to_window(window: usize, text: &str) -> Result<(), InputDispatchError> {
    let window = window as Hwnd;
    if window.is_null() {
        return Err(InputDispatchError::not_dispatched(
            "post_text_to_window requires a non-null window handle",
        ));
    }
    let mut input_sent = false;
    let normalized = normalize_text_line_endings(text);
    for unit in normalized.encode_utf16() {
        let unit = background_text_char(unit);
        if unsafe { PostMessageW(window, WM_CHAR, unit as usize, 0) } == 0 {
            return Err(dispatch_error(
                "Windows declined to queue a WM_CHAR message for the target window",
                input_sent,
            ));
        }
        input_sent = true;
    }
    Ok(())
}

#[cfg(test)]
mod text_input_tests {
    use super::{
        background_text_char, foreground_text_key, normalize_text_line_endings, KeySpec, VK_RETURN,
    };

    #[test]
    fn normalizes_crlf_cr_and_lf_to_one_line_break_each() {
        assert_eq!(
            normalize_text_line_endings("one\r\ntwo\rthree\nfour"),
            "one\ntwo\nthree\nfour"
        );
    }

    #[test]
    fn foreground_text_uses_return_for_a_line_break() {
        assert!(matches!(
            foreground_text_key(b'\n' as u16),
            KeySpec::Virtual {
                vk: VK_RETURN,
                extended: false
            }
        ));
        assert!(matches!(
            foreground_text_key(b'x' as u16),
            KeySpec::Unicode(unit) if unit == b'x' as u16
        ));
    }

    #[test]
    fn background_edit_text_uses_carriage_return_for_a_line_break() {
        assert_eq!(
            background_text_char(b'\n' as u16),
            b'\r' as u16
        );
        assert_eq!(
            background_text_char(b'x' as u16),
            b'x' as u16
        );
    }
}

/// Resolves the first descendant window, in enumeration order, whose real
/// window class is an Edit/RichEdit variant (see `EDIT_LIKE_CLASSES`). Some
/// real apps (e.g. Windows 11 Notepad, whose text surface is a RichEditD2DPT
/// control nested under a NotepadTextBox wrapper) host their actual
/// text-editing surface as a child window of the top-level frame rather
/// than being an editable control themselves; `post_text_to_window`'s
/// caller uses this to redirect WM_CHAR to the real surface instead of the
/// frame. A window with no such descendant (including one that already IS
/// an editable control, which has no children) returns `None`, leaving the
/// caller's original target untouched.
///
/// Classic Win32 Edit, plus the RichEdit control class variants, including
/// "RichEditD2DPT" -- confirmed by direct observation to be the real child
/// text surface Windows 11's own packaged Notepad hosts internally, under a
/// "NotepadTextBox" wrapper, inside its top-level frame.
const EDIT_LIKE_CLASSES: &[&str] = &[
    "Edit", "RichEdit", "RichEdit20A", "RichEdit20W", "RichEdit50W", "RichEditD2DPT",
];

extern "system" fn collect_edit_child(window: Hwnd, lparam: isize) -> i32 {
    let mut class_buffer = [0u16; 64];
    let written = unsafe { GetClassNameW(window, class_buffer.as_mut_ptr(), class_buffer.len() as i32) };
    if written > 0 {
        let class_name = String::from_utf16_lossy(&class_buffer[..written as usize]);
        if EDIT_LIKE_CLASSES.contains(&class_name.as_str()) {
            unsafe { *(lparam as *mut Hwnd) = window };
            return 0; // stop enumeration: found one
        }
    }
    1 // continue enumeration
}

/// Diagnostic only: collects every descendant window's own class name, in
/// enumeration order, regardless of what it is. Used to see what a real
/// app's actual window tree looks like when `find_edit_child_window` finds
/// nothing, instead of guessing why.
extern "system" fn collect_all_child_classes(window: Hwnd, lparam: isize) -> i32 {
    let mut class_buffer = [0u16; 64];
    let written = unsafe { GetClassNameW(window, class_buffer.as_mut_ptr(), class_buffer.len() as i32) };
    let class_name = if written > 0 { String::from_utf16_lossy(&class_buffer[..written as usize]) } else { String::new() };
    let collector = unsafe { &mut *(lparam as *mut Vec<String>) };
    collector.push(class_name);
    1 // continue enumeration
}

pub fn list_child_window_classes(window: usize) -> Result<Vec<String>, InputDispatchError> {
    let window = window as Hwnd;
    if window.is_null() {
        return Err(InputDispatchError::not_dispatched(
            "list_child_window_classes requires a non-null window handle",
        ));
    }
    let mut collected: Vec<String> = Vec::new();
    unsafe { EnumChildWindows(window, collect_all_child_classes, &mut collected as *mut Vec<String> as isize) };
    Ok(collected)
}

pub fn find_edit_child_window(window: usize) -> Result<Option<usize>, InputDispatchError> {
    let window = window as Hwnd;
    if window.is_null() {
        return Err(InputDispatchError::not_dispatched(
            "find_edit_child_window requires a non-null window handle",
        ));
    }
    let mut found: Hwnd = std::ptr::null_mut();
    unsafe { EnumChildWindows(window, collect_edit_child, &mut found as *mut Hwnd as isize) };
    Ok(if found.is_null() { None } else { Some(found as usize) })
}

/// `WM_CLOSE`: the standard request for a window to close itself, the same
/// message Windows sends when the owner clicks a window's own title-bar X.
/// Posting it directly is foreground-independent and does not require
/// `SendInput`/focus, the same property `post_text_to_window` relies on.
/// Test-only scaffolding: used to provoke a real app's own "unsaved changes"
/// dialog for the Phase 0 T3 proof, never a production action path (a real
/// agent action closes a window through its UI Automation `WindowPattern`
/// instead, which this module does not implement).
const WM_CLOSE: u32 = 0x0010;

pub fn post_close_window(window: usize) -> Result<(), InputDispatchError> {
    let window = window as Hwnd;
    if window.is_null() {
        return Err(InputDispatchError::not_dispatched(
            "post_close_window requires a non-null window handle",
        ));
    }
    if unsafe { PostMessageW(window, WM_CLOSE, 0, 0) } == 0 {
        return Err(InputDispatchError::not_dispatched(
            "Windows declined to queue a WM_CLOSE message for the target window",
        ));
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

/// Resolves an exact window's deepest same-process child at a screen point and
/// converts the point into that child window's client coordinates. This does
/// not inspect or change the OS cursor position.
fn window_message_target(window: usize, pid: u32, x: i32, y: i32) -> Result<(Hwnd, Point), InputDispatchError> {
    let root = window as Hwnd;
    if root.is_null() || !(-32_768..=32_767).contains(&x) || !(-32_768..=32_767).contains(&y) {
        return Err(InputDispatchError::not_dispatched("invalid target window or screen point for window-message input"));
    }
    let mut bounds = Rect::default();
    if unsafe { GetWindowRect(root, &mut bounds) } == 0
        || x < bounds.left || y < bounds.top || x >= bounds.right || y >= bounds.bottom {
        return Err(InputDispatchError::not_dispatched("the input point is outside the exact target window"));
    }

    let mut target = root;
    for _ in 0..64 {
        let mut local = Point { x, y };
        if unsafe { ScreenToClient(target, &mut local) } == 0 {
            return Err(InputDispatchError::not_dispatched("Windows could not map the screen point into the target window"));
        }
        let child = unsafe { ChildWindowFromPointEx(
            target,
            local,
            CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
        ) };
        if child.is_null() || child == target { break; }
        let mut child_pid = 0u32;
        if unsafe { GetWindowThreadProcessId(child, &mut child_pid) } == 0 || child_pid != pid {
            return Err(InputDispatchError::not_dispatched("the point resolves to a child outside the exact target process"));
        }
        target = child;
    }

    let mut local = Point { x, y };
    if unsafe { ScreenToClient(target, &mut local) } == 0 {
        return Err(InputDispatchError::not_dispatched("Windows could not map the point into the resolved target control"));
    }
    let mut client = Rect::default();
    if unsafe { GetClientRect(target, &mut client) } == 0
        || local.x < client.left || local.y < client.top || local.x >= client.right || local.y >= client.bottom
        || !(-32_768..=32_767).contains(&local.x) || !(-32_768..=32_767).contains(&local.y) {
        return Err(InputDispatchError::not_dispatched("the resolved control has no usable client point for window-message input"));
    }
    Ok((target, local))
}

fn packed_signed_point(x: i32, y: i32) -> Result<isize, InputDispatchError> {
    if !(-32_768..=32_767).contains(&x) || !(-32_768..=32_767).contains(&y) {
        return Err(InputDispatchError::not_dispatched("mouse-message coordinates exceed the Win32 signed-point range"));
    }
    let packed = (x as u16 as u32) | ((y as u16 as u32) << 16);
    Ok((packed as i32) as isize)
}

fn post_mouse_message(window: Hwnd, message: u32, wparam: usize, lparam: isize, input_sent: &mut bool) -> Result<(), InputDispatchError> {
    if unsafe { PostMessageW(window, message, wparam, lparam) } == 0 {
        return Err(dispatch_error("Windows declined to queue a targeted mouse message", *input_sent));
    }
    *input_sent = true;
    Ok(())
}

/// Posts a single mouse click to a same-process child of the exact target
/// window. Unlike SendInput, this queues messages to the target HWND and does
/// not move, sample, or restore the owner's physical pointer. Queue acceptance
/// is dispatch evidence only; the caller must inspect the app effect.
pub fn post_click_to_window(window: usize, pid: u32, x: i32, y: i32, button: MouseButton) -> Result<(), InputDispatchError> {
    let (target, local) = window_message_target(window, pid, x, y)?;
    let point = packed_signed_point(local.x, local.y)?;
    let (down, up, mask) = match button {
        MouseButton::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
        MouseButton::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
        MouseButton::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
    };
    let mut input_sent = false;
    post_mouse_message(target, WM_MOUSEMOVE, 0, point, &mut input_sent)?;
    post_mouse_message(target, down, mask, point, &mut input_sent)?;
    post_mouse_message(target, up, 0, point, &mut input_sent)
}

/// Posts a wheel event to the deepest same-process control at the exact screen
/// point without using the system pointer. `amount` is a signed number of
/// standard wheel notches, bounded to keep the packed delta well-formed.
pub fn post_scroll_to_window(window: usize, pid: u32, x: i32, y: i32, amount: i32, horizontal: bool) -> Result<(), InputDispatchError> {
    if amount == 0 || !(-50..=50).contains(&amount) {
        return Err(InputDispatchError::not_dispatched("window-message scroll amount must be between -50 and 50 notches"));
    }
    let (target, _) = window_message_target(window, pid, x, y)?;
    let point = packed_signed_point(x, y)?;
    let delta = (amount * WHEEL_DELTA) as i16 as u16 as usize;
    let message = if horizontal { WM_MOUSEHWHEEL } else { WM_MOUSEWHEEL };
    let mut input_sent = false;
    post_mouse_message(target, message, delta << 16, point, &mut input_sent)
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
