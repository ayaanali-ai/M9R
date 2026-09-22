// M9R overlay shell. It shows a feed and nothing else: all logic (routing, approvals, liveness) stays in m9r-cli, which
// writes ~/.m9r/feed.json. This file owns only the window: placement, size, staying on top without taking focus, the
// tray, and telling the UI when the feed file changed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// The one manual way to show or hide the pill that does not depend on finding the tray icon (Windows tucks a new tray
/// icon into the hidden/overflow drawer by default, so a person can easily have no visible way to reach it otherwise).
// Plain Alt+Shift collides with Windows' own built-in input-language-switch hotkey on most systems with more than
// one keyboard layout installed (confirmed 2026-09-22: it's a low-level system hook, not a RegisterHotKey caller,
// so it can consume the chord before this app ever sees it -- flaky in practice even though a synthetic SendKeys
// test bypasses that layer and looks fine). Four modifiers is not a real Windows default for anything.
const TOGGLE_HOTKEY_MODS: Modifiers = Modifiers::CONTROL.union(Modifiers::ALT).union(Modifiers::SHIFT);
const TOGGLE_HOTKEY_CODE: Code = Code::KeyM;
const TOGGLE_HOTKEY_LABEL: &str = "Ctrl+Alt+Shift+M";

/// The engine child the overlay started, so quitting the overlay stops it too.
static ENGINE: Mutex<Option<Child>> = Mutex::new(None);

const PILL: &str = "pill";
const COLLAPSED_W: f64 = 220.0;
const TOP_MARGIN: f64 = 8.0;

/// Where the feed lives: `M9R_FEED` (tests and the mock), else `<M9R_HOME or ~/.m9r>/feed.json`.
fn feed_path() -> PathBuf {
    if let Ok(p) = std::env::var("M9R_FEED") {
        return p.into();
    }
    let home = std::env::var("M9R_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".m9r")
    });
    home.join("feed.json")
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    /// Horizontal centre and top of the pill in physical pixels, so growing the panel keeps it where you put it.
    cx: Option<i32>,
    y: Option<i32>,
}

fn saved_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

fn load_saved(app: &AppHandle) -> Saved {
    saved_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_position(app: &AppHandle, cx: i32, y: i32) {
    if let Some(p) = saved_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, serde_json::to_string(&Saved { cx: Some(cx), y: Some(y) }).unwrap_or_default());
    }
}

/// Puts the pill at the top centre of the primary monitor, or where the user last left it if that spot is still on a screen.
fn place(window: &WebviewWindow, saved: &Saved) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (COLLAPSED_W * scale).round() as i32;
    let monitors = window.available_monitors().unwrap_or_default();
    if let (Some(cx), Some(y)) = (saved.cx, saved.y) {
        let on_screen = monitors.iter().any(|m| {
            let p = m.position();
            let s = m.size();
            cx >= p.x && cx < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
        });
        if on_screen {
            let _ = window.set_position(PhysicalPosition::new(cx - w / 2, y));
            return;
        }
    }
    if let Ok(Some(m)) = window.primary_monitor() {
        let p = m.position();
        let s = m.size();
        let x = p.x + (s.width as i32 - w) / 2;
        let y = p.y + (TOP_MARGIN * m.scale_factor()).round() as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// The UI asks for the size that fits its content; the window keeps its horizontal centre and its top edge.
#[tauri::command]
fn resize_pill(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let cx = pos.x + size.width as i32 / 2;
    let new_w = (width * scale).round() as i32;
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new(cx - new_w / 2, pos.y)).map_err(|e| e.to_string())
}

/// The current feed text, or nothing when the file does not exist yet.
#[tauri::command]
fn read_feed() -> Option<String> {
    fs::read_to_string(feed_path()).ok()
}

fn m9r_home() -> PathBuf {
    std::env::var("M9R_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".m9r")
    })
}

/// The self-contained M9R engine (no Node needed): `M9R_ENGINE`, else the copy `m9r-cli setup` installed, else one next to this program.
fn find_engine() -> Option<PathBuf> {
    let name = if cfg!(windows) { "m9r-engine.exe" } else { "m9r-engine" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("M9R_ENGINE") {
        candidates.push(p.into());
    }
    candidates.push(m9r_home().join("bin").join(name));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Keeps `m9r-engine feed --watch` running so the pill always has fresh data. The engine refuses to start when another
/// writer already holds the feed lock, so a second copy exits at once; a fast exit therefore backs off instead of respawning.
/// Off when `M9R_FEED` points somewhere else (the mock feed and tests own that file).
fn spawn_engine_supervisor() {
    if std::env::var("M9R_FEED").is_ok() || std::env::var("M9R_NO_ENGINE").is_ok() {
        return;
    }
    std::thread::spawn(|| loop {
        let mut wait = Duration::from_secs(5);
        if let Some(engine) = find_engine() {
            let mut cmd = Command::new(engine);
            cmd.args(["feed", "--watch", "--serve-hooks"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            let started = Instant::now();
            if let Ok(child) = cmd.spawn() {
                *ENGINE.lock().unwrap() = Some(child);
                loop {
                    std::thread::sleep(Duration::from_secs(2));
                    let mut guard = ENGINE.lock().unwrap();
                    match guard.as_mut().map(|c| c.try_wait()) {
                        Some(Ok(None)) => continue,
                        _ => {
                            *guard = None;
                            break;
                        }
                    }
                }
                if started.elapsed() < Duration::from_secs(3) {
                    wait = Duration::from_secs(30);
                }
            }
        } else {
            wait = Duration::from_secs(30);
        }
        std::thread::sleep(wait);
    });
}

fn engine_call(engine: &PathBuf, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(engine);
    // A click on the pill is a person deciding, so the engine is told it is human (the same flag a person's own script may set).
    cmd.args(args).env("M9R_SEND_AS_HUMAN", "1").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(format!("{}{}", text, String::from_utf8_lossy(&out.stderr)).trim().to_string())
    }
}

fn plain_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Sessions M9R knows for one agent (`@codex`, `@claude`, ...), for the pill's link picker.
#[tauri::command]
async fn list_sessions(handle: String) -> Result<String, String> {
    if !plain_id(&handle) {
        return Err("Bad agent name".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || engine_call(&engine, &["sessions-json", &handle]))
        .await
        .map_err(|e| e.to_string())?
}

/// Links a task's own session to a chosen partner session, so future tasks from it always go there.
#[tauri::command]
async fn link_sessions(from_handle: String, from_session: String, to_handle: String, to_session: String) -> Result<String, String> {
    for s in [&from_handle, &to_handle] {
        if !plain_id(s) {
            return Err("Bad agent name".into());
        }
    }
    for s in [&from_session, &to_session] {
        if s.is_empty() || s.len() > 128 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("Bad session id".into());
        }
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || {
        engine_call(
            &engine,
            &["link", "--from-handle", &from_handle, "--from-session", &from_session, "--to-handle", &to_handle, "--to-session", &to_session],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Approve or deny a task from the pill. `action` is "approve", "deny" or "allow_day" (a one-day rule for this pair of agents, then approve).
/// Every argument is checked here, and the engine, not this shell, decides what is allowed (protected actions never get a rule).
#[tauri::command]
async fn decide(task_id: String, action: String, from: Option<String>, to: Option<String>) -> Result<String, String> {
    if !plain_id(&task_id) {
        return Err("Bad task id".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "approve" => engine_call(&engine, &["approve", &task_id, "--yes"]),
        "deny" => engine_call(&engine, &["deny", &task_id, "--yes"]),
        "allow_day" => {
            let (f, t) = (from.unwrap_or_default(), to.unwrap_or_default());
            if !plain_id(&f) || !plain_id(&t) {
                return Err("Bad agent name".into());
            }
            engine_call(&engine, &["allow", &format!("@{f}"), &format!("@{t}"), "--for", "1d"])?;
            engine_call(&engine, &["approve", &task_id, "--yes"])
        }
        _ => Err("Unknown action".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Is a fullscreen app in front (a game, a video, a presentation)? Heuristic: the foreground window is not this pill, covers
/// its whole monitor (no border), and is not the desktop or the shell. Windows has no single official "is fullscreen" flag.
#[cfg(windows)]
fn fullscreen_app_in_front(pill_hwnd: isize) -> bool {
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowRect(hwnd: isize, rect: *mut [i32; 4]) -> i32;
        fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
        fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    }
    #[repr(C)]
    struct MonitorInfo {
        size: u32,
        monitor: [i32; 4],
        work: [i32; 4],
        flags: u32,
    }
    unsafe {
        let fg = GetForegroundWindow();
        if fg == 0 || fg == pill_hwnd {
            return false;
        }
        let mut buf = [0u16; 64];
        let len = GetClassNameW(fg, buf.as_mut_ptr(), 64).max(0) as usize;
        let class = String::from_utf16_lossy(&buf[..len]);
        // The desktop and the taskbar are always window-sized to the monitor; never treat them as "fullscreen".
        if class == "Progman" || class == "WorkerW" || class == "Shell_TrayWnd" {
            return false;
        }
        let mut rect = [0i32; 4];
        if GetWindowRect(fg, &mut rect) == 0 {
            return false;
        }
        let mon = MonitorFromWindow(fg, 2 /* MONITOR_DEFAULTTONEAREST */);
        let mut info = MonitorInfo { size: std::mem::size_of::<MonitorInfo>() as u32, monitor: [0; 4], work: [0; 4], flags: 0 };
        if mon == 0 || GetMonitorInfoW(mon, &mut info) == 0 {
            return false;
        }
        rect == info.monitor
    }
}
#[cfg(not(windows))]
fn fullscreen_app_in_front(_pill_hwnd: isize) -> bool {
    false
}

/// Hides the pill while a fullscreen app has focus (a game, a video call, a presentation), and shows it again once that ends.
/// Skips the check entirely when the person hid the pill themselves from the tray menu.
fn spawn_fullscreen_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut hidden_for_fullscreen = false;
        loop {
            std::thread::sleep(Duration::from_millis(700));
            let Some(window) = app.get_webview_window(PILL) else { continue };
            let user_hidden = !window.is_visible().unwrap_or(true);
            if user_hidden && !hidden_for_fullscreen {
                continue; // the person hid it on purpose; leave it alone
            }
            let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
            let fullscreen = fullscreen_app_in_front(hwnd);
            if fullscreen && !hidden_for_fullscreen {
                hidden_for_fullscreen = true;
                let _ = window.hide();
            } else if !fullscreen && hidden_for_fullscreen {
                hidden_for_fullscreen = false;
                let _ = window.show();
            }
        }
    });
}

/// Shows the pill if hidden, hides it if shown. The one manual control the person has over it, reachable from the tray
/// menu and from a global hotkey (Alt+Shift+M) so it works even if the tray icon is tucked into Windows' overflow drawer,
/// which is where a new icon lands by default and easy to never notice.
fn toggle_pill(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PILL) {
        if w.is_visible().unwrap_or(true) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

fn stop_engine() {
    if let Some(mut child) = ENGINE.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Watches the feed file's modified time and size (a quarter-second poll: no extra dependency, well under 1% CPU) and tells the UI.
fn spawn_feed_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let path = feed_path();
        let mut last: Option<(SystemTime, u64)> = None;
        let mut last_change_at = Instant::now();
        let mut stale_reported = false;
        loop {
            match fs::metadata(&path) {
                Ok(meta) => {
                    let key = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
                    if last != Some(key) {
                        last = Some(key);
                        last_change_at = Instant::now();
                        if stale_reported {
                            stale_reported = false;
                            let _ = app.emit("engine-ok", ());
                        }
                        if let Ok(text) = fs::read_to_string(&path) {
                            let _ = app.emit("feed", text);
                        }
                    } else if !stale_reported && last_change_at.elapsed() > Duration::from_secs(20) {
                        // The feed writer normally touches this file every few seconds; if it has gone quiet, the resident
                        // engine likely died between the supervisor's restart attempts. Say so rather than looking merely idle.
                        stale_reported = true;
                        let _ = app.emit("engine-stale", ());
                    }
                }
                Err(_) => {
                    if last.take().is_some() {
                        let _ = app.emit("feed-missing", ());
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

fn main() {
    let toggle_shortcut = Shortcut::new(Some(TOGGLE_HOTKEY_MODS), TOGGLE_HOTKEY_CODE);
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_pill(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![resize_pill, read_feed, decide, list_sessions, link_sessions])
        .setup(move |app| {
            let window = app.get_webview_window(PILL).expect("pill window");
            // Never take keyboard focus: clicking the pill must not pull you out of the terminal you were typing in.
            let _ = window.set_focusable(false);
            let _ = window.set_always_on_top(true);
            place(&window, &load_saved(app.handle()));
            let _ = window.show();
            // Debug aid for a live "the pill shows the wrong thing" report: M9R_DEBUG=1 opens DevTools on the
            // pill's own webview so the actual console/network error is visible instead of guessing from a
            // screenshot. Never on by default -- devtools is a real attack-surface increase to leave open.
            if std::env::var("M9R_DEBUG").as_deref() == Ok("1") {
                window.open_devtools();
            }

            let show = MenuItem::with_id(app, "toggle", &format!("Show / hide ({TOGGLE_HOTKEY_LABEL})"), true, None::<&str>)?;
            let dnd = CheckMenuItem::with_id(app, "dnd", "Do not disturb", true, false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &dnd, &quit])?;
            let mut tray = TrayIconBuilder::new().tooltip("M9R").menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(move |app, event| match event.id.as_ref() {
                "toggle" => toggle_pill(app),
                "dnd" => {
                    let _ = app.emit("dnd", dnd.is_checked().unwrap_or(false));
                }
                "quit" => {
                    stop_engine();
                    app.exit(0)
                }
                _ => {}
            })
            .build(app)?;

            spawn_feed_watcher(app.handle().clone());
            spawn_engine_supervisor();
            spawn_fullscreen_watcher(app.handle().clone());
            // Best effort: if something else already holds this chord, the tray menu's "Show / hide" still works.
            // The result is no longer silently discarded -- a failure here was previously invisible even to us.
            match app.global_shortcut().register(toggle_shortcut) {
                Ok(()) => eprintln!("M9R: registered global hotkey {TOGGLE_HOTKEY_LABEL}"),
                Err(e) => eprintln!("M9R: could not register global hotkey {TOGGLE_HOTKEY_LABEL} ({e}); use the tray menu's Show/hide instead"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Moved(pos) = event {
                if let Ok(size) = window.outer_size() {
                    save_position(window.app_handle(), pos.x + size.width as i32 / 2, pos.y);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the M9R overlay");
}
