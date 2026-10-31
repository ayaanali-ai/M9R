// Detects "Ctrl+Alt held, nothing else" as the dictation hold-to-talk hotkey.
//
// Win32's RegisterHotKey -- what tauri-plugin-global-shortcut wraps -- requires a non-modifier
// virtual key; it cannot register a modifier-only chord like Ctrl+Alt on its own (confirmed
// against the crate's `Shortcut` API, which always takes a `Code`). The only way to observe a
// bare-modifier combo system-wide is a WH_KEYBOARD_LL low-level keyboard hook that watches raw
// key state directly, so that is what this module does, reporting through the same
// `report_hold_to_talk` path the old plugin-based handler used.
//
// A low-level hook's callback only fires while the thread that installed it is pumping messages,
// so this owns a dedicated thread for the lifetime of the app (same shape as native_dictation.rs's
// recognizer thread) running a plain GetMessageW loop after SetWindowsHookExW.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{VK_LCONTROL, VK_LMENU, VK_RCONTROL, VK_RMENU};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::{report_hold_to_talk, HoldToTalkState};

static CTRL_DOWN: AtomicBool = AtomicBool::new(false);
static ALT_DOWN: AtomicBool = AtomicBool::new(false);
/// Count, not a flag: multiple non-modifier keys can be down at once (e.g. a fumbled chord), and
/// "no other key held" must mean none of them, not just the last one released.
static OTHER_KEYS_DOWN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: OnceLock<Mutex<HoldToTalkState>> = OnceLock::new();

/// Starts the dedicated hook thread. Call once, at app setup.
pub fn spawn(app: AppHandle) {
    if APP.set(app).is_err() {
        eprintln!("M9R: ctrl+alt hold-to-talk hook already started");
        return;
    }
    let _ = STATE.set(Mutex::new(HoldToTalkState::default()));
    std::thread::spawn(|| {
        // SAFETY: hmod=None and threadid=0 install a global low-level keyboard hook, which is the
        // documented form for WH_KEYBOARD_LL; the hinstance argument is ignored for this hook type.
        let hook = match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) } {
            Ok(hook) => hook,
            Err(e) => {
                eprintln!("M9R: could not install the Ctrl+Alt hold-to-talk keyboard hook ({e})");
                return;
            }
        };
        eprintln!("M9R: Ctrl+Alt hold-to-talk hook installed");
        // Low-level hooks are delivered through this thread's message queue; without pumping it,
        // the callback below never fires. This loop runs for the lifetime of the app.
        let mut msg = MSG::default();
        // SAFETY: standard message pump; hwnd=None means "any window or thread message owned by
        // this thread," which is exactly what a hook-only thread needs.
        while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        // SAFETY: hook was installed by this same call above and never shared across threads.
        let _ = unsafe { UnhookWindowsHookEx(hook) };
    });
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: lparam points to a valid KBDLLHOOKSTRUCT for the duration of this call, per the
        // WH_KEYBOARD_LL contract.
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let vk = info.vkCode;
        let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
        if down || up {
            match vk {
                v if v == VK_LCONTROL.0 as u32 || v == VK_RCONTROL.0 as u32 => {
                    CTRL_DOWN.store(down, Ordering::SeqCst)
                }
                v if v == VK_LMENU.0 as u32 || v == VK_RMENU.0 as u32 => {
                    ALT_DOWN.store(down, Ordering::SeqCst)
                }
                _ => {
                    if down {
                        OTHER_KEYS_DOWN.fetch_add(1, Ordering::SeqCst);
                    } else {
                        // Never go negative: a key held before the hook was installed would
                        // otherwise report a key-up with no matching key-down.
                        let _ =
                            OTHER_KEYS_DOWN.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                                Some(n.saturating_sub(1))
                            });
                    }
                }
            }
            let pressed = CTRL_DOWN.load(Ordering::SeqCst)
                && ALT_DOWN.load(Ordering::SeqCst)
                && OTHER_KEYS_DOWN.load(Ordering::SeqCst) == 0;
            if let (Some(app), Some(state)) = (APP.get(), STATE.get()) {
                report_hold_to_talk(app, state, pressed);
            }
        }
    }
    // Always pass the event on -- this hook only observes, it never consumes a keystroke.
    // SAFETY: hhk=None is valid for a hook chain installed with SetWindowsHookExW threadid=0.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
