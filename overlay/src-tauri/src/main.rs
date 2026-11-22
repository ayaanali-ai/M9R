// M9R overlay shell. It shows a feed and nothing else: all logic (routing, approvals, liveness) stays in m9r-cli, which
// writes ~/.m9r/feed.json and the web broker writes ~/.m9r/web-activity.json. This file owns the view-only merge plus
// the window, tray, and local UI events; it never changes either source file.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod native_dictation;
#[cfg(windows)]
mod ctrl_alt_hold;

use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, WindowEvent,
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
/// Hold Ctrl+Alt (no letter) to open the message pill and dictate into its draft field.
///
/// Win32's RegisterHotKey -- which tauri-plugin-global-shortcut wraps -- cannot register a
/// modifier-only combination; it requires a non-modifier virtual key. The older Ctrl+Alt+M chord
/// worked around that, but a bare Ctrl+Alt is detected separately via ctrl_alt_hold.rs's
/// low-level keyboard hook instead (see that module for why).
const HOLD_TO_TALK_HOTKEY_LABEL: &str = "Ctrl+Alt";
/// Private single-instance handoff used by the installer to close the running pill cleanly.
const UPDATE_SHUTDOWN_ARGUMENT: &str = "--m9r-update-shutdown";
/// Passed to a second launch to open the app window on the already-running instance, the same
/// as clicking the tray's "Open M9R" item -- lets the app window be opened from the command line
/// instead of needing a click on the user's own desktop.
const OPEN_APP_ARGUMENT: &str = "--m9r-open-app";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HoldToTalkEvent {
    Pressed,
    Released,
}

impl HoldToTalkEvent {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pressed => "pressed",
            Self::Released => "released",
        }
    }
}

/// Suppresses OS key-repeat notifications so the frontend sees one start and one end per hold.
#[derive(Default)]
pub(crate) struct HoldToTalkState {
    pressed: bool,
}

impl HoldToTalkState {
    pub(crate) fn transition(&mut self, pressed: bool) -> Option<HoldToTalkEvent> {
        if self.pressed == pressed {
            return None;
        }
        self.pressed = pressed;
        Some(if pressed { HoldToTalkEvent::Pressed } else { HoldToTalkEvent::Released })
    }
}

/// Tells spawn_broker_watchdog's background thread to stop polling/restarting the broker. The overlay
/// never started the broker or m9r-engine as its own children -- those are an intentional background
/// service (the broker is launched by its own Windows Scheduled Task specifically so it survives
/// independent of this pill process, serving MCP for every agent session) -- so this flag only affects
/// this process's own watchdog thread, nothing else keeps running or stops because of it.
static BROKER_WATCHDOG_STOPPING: AtomicBool = AtomicBool::new(false);

pub(crate) const PILL: &str = "pill";
const SCREEN_GLOW: &str = "screen-glow";
/// The full-window Clonk-style app, a real OS window (decorations, taskbar entry, resizable) --
/// unlike the pill, closing it must never shut down the engine or the pill overlay.
const APP_WINDOW: &str = "app";
/// The real, live M9R workspace (agents, missions, memory, approvals, rooms) embedded as
/// an ordinary native window -- the same data the web app already serves, not a reimplementation.
const WORKSPACE: &str = "workspace";
const COLLAPSED_W: f64 = 220.0;
const TOP_MARGIN: f64 = 0.0;

// ── One-pill window (the only packaged desktop frontend) ────────────────────────────────────────────────────────────────────────────
// The new pill UI draws its own island inside a fixed, transparent, top-centre window and tells this side three things:
// where the island is (so everything around it stays click-through), when it has folded away (the window shrinks to a
// wake handle), and when it needs the keyboard (the message field). The old overlay UI does not use any of this.

/// The new UI's panel width (its `PANEL_W`); the island is centred in it, and tall enough for its largest view.
const NEXT_W: f64 = 1440.0;
const NEXT_H: f64 = 900.0;
const NOTCH_LIP_W: f64 = 288.0;
const NOTCH_LIP_H: f64 = 32.0;
/// Margin around the island that still counts as over it, matching the UI.
const HIT_MARGIN: f64 = 14.0;

fn next_mode() -> bool {
    // The legacy overlay is no longer a desktop build input. Keep this helper
    // as a small compatibility seam for the existing placement code, but never
    // allow a local flag to select a second frontend.
    true
}

/// WebView2 does not show its own permission prompt for an unhandled `getUserMedia` request from a window this
/// small and chromeless (220x36, no decorations) -- there is nowhere for its default infobar to render, so the
/// request is left pending and the page sees it as a silent, permanent "not-allowed". Confirmed live 2026-10-10:
/// holding Ctrl+Alt+M opened the message view, but no Windows mic prompt ever appeared and the listening meter never
/// moved. Registering our own `PermissionRequested` handler and auto-approving the microphone (our own first-party
/// pill content, never third-party pages) is the standard fix; everything else stays default-denied.
#[cfg(windows)]
fn allow_microphone_permission(window: &WebviewWindow) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW},
        PermissionRequestedEventHandler,
    };
    let result = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
                kind.0 = 0;
                if args.PermissionKind(&mut kind).is_ok() && kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                }
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
    if let Err(e) = result {
        eprintln!("M9R: could not install the microphone permission handler ({e})");
    }
}

#[cfg(not(windows))]
fn allow_microphone_permission(_window: &WebviewWindow) {}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct IslandRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl IslandRect {
    fn startup_lip(window_width: f64) -> Self {
        let w = NOTCH_LIP_W.min(window_width * 0.95);
        Self { x: (window_width - w) / 2.0, y: 0.0, w, h: NOTCH_LIP_H }
    }

    /// A rectangle the UI reports must be finite, non-negative, and inside the window; anything else is ignored.
    fn checked(x: f64, y: f64, w: f64, h: f64, window_width: f64, window_height: f64) -> Option<IslandRect> {
        let sane = [x, y, w, h].iter().all(|v| v.is_finite()) && w >= 0.0 && h >= 0.0 && x >= -1.0 && y >= -1.0
            && x + w <= window_width + 1.0 && y + h <= window_height + 1.0;
        sane.then_some(IslandRect { x, y, w, h })
    }

    /// Whether a point (logical pixels from the window's top-left) is over the island or its margin. An empty rectangle
    /// (the island is retracted) is never hit.
    fn hit(&self, margin: f64, px: f64, py: f64) -> bool {
        if self.w <= 0.0 || self.h <= 0.0 {
            return false;
        }
        px >= self.x - margin && px <= self.x + self.w + margin && py >= self.y - margin && py <= self.y + self.h + margin
    }
}

#[derive(Default)]
struct NextPill {
    rect: IslandRect,
}

static NEXT: Mutex<NextPill> = Mutex::new(NextPill { rect: IslandRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 } });

// ── One pill at a time ──────────────────────────────────────────────────────────────────────────────────────────
// While this pill is running and visible it writes a heartbeat beside the feed; the web broker reads it and the in-page
// pill steps aside. Three missed beats (6 s) and the in-page pill comes back, so a crash never leaves you with none.

const HEARTBEAT_FILE: &str = "pill-desktop.json";
const HEARTBEAT_EVERY: Duration = Duration::from_secs(2);

fn heartbeat_path() -> PathBuf {
    feed_path().parent().unwrap_or_else(|| Path::new(".")).join(HEARTBEAT_FILE)
}

fn heartbeat_json(at_ms: u128, visible: bool, pid: u32) -> String {
    format!("{{\"pid\":{pid},\"at\":{at_ms},\"visible\":{visible}}}")
}

/// Replace the heartbeat without leaving the previous generation in place.
/// Windows' `rename` refuses to overwrite an existing destination, so a
/// one-time successful write would otherwise age out after six seconds and
/// make the broker hide the pill even though the process is still alive.
fn replace_heartbeat(tmp: &Path, path: &Path) {
    if fs::rename(tmp, path).is_ok() {
        return;
    }
    // The destination is normally the existing heartbeat on Windows. Remove
    // only that exact file, then retry the already-complete temp write. A
    // failed retry leaves the old heartbeat untouched only when the remove
    // itself was refused; the next loop will try again.
    if fs::remove_file(path).is_ok() {
        let _ = fs::rename(tmp, path);
    }
}

fn spawn_heartbeat(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(_window) = app.get_webview_window(PILL) {
            let at = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let visible = true;
            let path = heartbeat_path();
            // Write beside, then rename, so the broker never reads half a file.
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, heartbeat_json(at, visible, std::process::id())).is_ok() {
                replace_heartbeat(&tmp, &path);
            }
        }
        std::thread::sleep(HEARTBEAT_EVERY);
    });
}

/// The island reports where it is drawn, in logical pixels from the window's top-left.
#[tauri::command]
fn pill_set_rect(window: WebviewWindow, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let window_width = size.width as f64 / scale;
    let window_height = size.height as f64 / scale;
    let rect = IslandRect::checked(x, y, width, height, window_width, window_height)
        .ok_or_else(|| format!("pill hit area ({x}, {y}, {width}, {height}) is outside the {window_width} × {window_height} logical window at scale {scale}"))?;
    NEXT.lock().unwrap().rect = rect;
    Ok(())
}

/// Only the message field needs the keyboard. Everywhere else the pill must never pull focus from what you are typing in.
#[tauri::command]
fn pill_set_focus(window: WebviewWindow, focused: bool) -> Result<(), String> {
    window.set_focusable(focused).map_err(|e| e.to_string())?;
    if focused {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Opens the Windows microphone privacy page after speech recognition reports denied permission.
#[tauri::command]
fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg("ms-settings:privacy-microphone")
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not open Windows microphone settings: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Microphone settings are only available from the Windows desktop pill.".to_string())
    }
}

/// Makes the transparent area around the island click-through, so the pill never blocks the page or app underneath. The
/// window turns solid only while the pointer is over the island (plus its margin).
fn spawn_click_through_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        let mut toggle_failed = false;
        loop {
            // A 16 ms poll did the same window/cursor queries ~62 times a second even
            // when the pointer was nowhere near the pill. 50 ms keeps hit testing
            // responsive while cutting those idle wakeups by about 68%.
            std::thread::sleep(Duration::from_millis(50));
            let Some(window) = app.get_webview_window(PILL) else { continue };
            let rect = NEXT.lock().unwrap().rect;
            let (Ok(cursor), Ok(pos), Ok(scale)) = (window.cursor_position(), window.inner_position(), window.scale_factor()) else { continue };
            let inside = rect.hit(HIT_MARGIN, (cursor.x - pos.x as f64) / scale, (cursor.y - pos.y as f64) / scale);
            if ignoring != Some(!inside) {
                match window.set_ignore_cursor_events(!inside) {
                    Ok(()) => {
                        ignoring = Some(!inside);
                        toggle_failed = false;
                    }
                    Err(error) => {
                        if !toggle_failed {
                            eprintln!("M9R pill: could not change click-through: {error}");
                            toggle_failed = true;
                        }
                    }
                }
            }
        }
    });
}

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

/// The owner broker's redacted desktop-pill snapshot. The pill reads this
/// before falling back to the legacy merged feed, so it never discovers or
/// selects provider sessions itself.
fn desktop_pill_state_path() -> PathBuf {
    feed_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("desktop-pill-state.json")
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    /// Horizontal centre and top of the pill in physical pixels, so growing the panel keeps it where you put it.
    cx: Option<i32>,
    y: Option<i32>,
    /// Pill settings (sound, auto-close delay). Previously only held in the JS
    /// island's in-memory `State.settings`: the pill called `saveSettings` on
    /// every change but no transport ever implemented it, so a restart always
    /// reset sound/auto-close to their defaults (Package 4, M9R Source of
    /// Truth 5.0 diagnosis). Stored alongside the window position in the same
    /// file so settings persistence does not depend on any provider session.
    sound_enabled: Option<bool>,
    sound_volume: Option<f64>,
    auto_close_interval: Option<f64>,
    /// Appearance preferences for the desktop's full-screen, click-through edge light.
    glow_style: Option<String>,
    glow_color: Option<String>,
}

#[derive(Clone, Serialize)]
struct ScreenGlowSnapshot {
    revision: u64,
    visible: bool,
    style: String,
    color: String,
    live: bool,
}

impl Default for ScreenGlowSnapshot {
    fn default() -> Self {
        Self { revision: 0, visible: false, style: "status".into(), color: "#FFFFFF".into(), live: false }
    }
}

#[derive(Default)]
struct ScreenGlowState(Mutex<ScreenGlowSnapshot>);

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
        // Preserve whatever settings are already on disk; this call only ever moves the pill.
        let mut saved = load_saved(app);
        saved.cx = Some(cx);
        saved.y = Some(y);
        let _ = fs::write(p, serde_json::to_string(&saved).unwrap_or_default());
    }
}

/// Puts the pill at the top centre of the primary monitor, or where the user last left it if that spot is still on a screen.
fn place(window: &WebviewWindow, saved: &Saved) {
    place_with(window, saved, COLLAPSED_W);
}

fn place_next_pill(window: &WebviewWindow, saved: &Saved) {
    let saved_point = saved.cx.zip(saved.y);
    let monitor = window.available_monitors().unwrap_or_default().into_iter().find(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        saved_point.is_some_and(|(x, y)| x >= pos.x && x < pos.x + size.width as i32
            && y >= pos.y && y < pos.y + size.height as i32)
    }).or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.set_size(LogicalSize::new(NEXT_W, NEXT_H));
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = ((NEXT_W * scale).round() as u32).min(area.size.width);
    let height = ((NEXT_H * scale).round() as u32).min(area.size.height);
    let left = area.position.x;
    let top = area.position.y;
    let center = saved_point.map_or(left + area.size.width as i32 / 2, |(x, _)| x);
    let desired_top = saved_point.map_or(top + (TOP_MARGIN * scale).round() as i32, |(_, y)| y);
    let x = (center - width as i32 / 2).clamp(left, left + (area.size.width - width) as i32);
    let y = desired_top.clamp(top, top + (area.size.height - height) as i32);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
}

fn place_with(window: &WebviewWindow, saved: &Saved, width: f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (width * scale).round() as i32;
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

/// Read only a broker-published, versioned pill state envelope. Returning the
/// inner state JSON keeps the Tauri command transport simple while the broker
/// remains the sole writer and owner of provider/UI state.
#[tauri::command]
fn read_pill_state() -> Option<String> {
    let path = desktop_pill_state_path();
    let modified = fs::metadata(&path).ok()?.modified().ok()?;
    if modified.elapsed().ok()?.as_secs() > 10 {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    if value.get("version")?.as_u64()? != 1 || value.get("surface")?.as_str()? != "desktop-pill" {
        return None;
    }
    value.get("state").map(serde_json::Value::to_string)
}

#[cfg(test)]
fn read_view_feed(native_path: &Path, web_path: &Path) -> Option<String> {
    let native = fs::read_to_string(native_path).ok();
    let web = fs::read_to_string(web_path).ok();
    merge_view_feed(native.as_deref(), web.as_deref())
}

/// Compose sources only in memory for the renderer. This never writes back to feed.json, which remains native-only.
#[cfg(test)]
fn merge_view_feed(native_text: Option<&str>, web_text: Option<&str>) -> Option<String> {
    if native_text.is_none() && web_text.is_none() {
        return None;
    }

    let mut native: serde_json::Value = match native_text {
        Some(text) => serde_json::from_str(text).ok()?,
        None => serde_json::json!({
            "surface": "native",
            "version": 1,
            "seq": 0,
            "agents": [],
            "needsYou": [],
            "inProgress": [],
            "recent": [],
            "pings": [],
            "reserved": { "people": [], "channels": [] }
        }),
    };
    let object = native.as_object_mut()?;
    object.insert("surface".into(), serde_json::Value::String("native".into()));
    for key in ["agents", "needsYou", "inProgress", "recent", "pings"] {
        if let Some(items) = object.get_mut(key).and_then(serde_json::Value::as_array_mut) {
            for item in items {
                if let Some(item) = item.as_object_mut() {
                    item.insert("surface".into(), serde_json::Value::String("native".into()));
                    if key == "agents" {
                        if let Some(sessions) = item.get_mut("sessions").and_then(serde_json::Value::as_array_mut) {
                            for session in sessions {
                                if let Some(session) = session.as_object_mut() {
                                    session.insert("surface".into(), serde_json::Value::String("native".into()));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // A malformed or wrong-surface companion file cannot contaminate native data; it simply contributes no web rows.
    let web_items = web_text
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .filter(|value| value.get("surface").and_then(serde_json::Value::as_str) == Some("web"))
        .and_then(|value| value.get("items").and_then(serde_json::Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut item| {
            let object = item.as_object_mut()?;
            object.insert("surface".into(), serde_json::Value::String("web".into()));
            Some(item)
        })
        .collect();
    object.insert("web".into(), serde_json::Value::Array(web_items));
    serde_json::to_string(&native).ok()
}

fn m9r_home() -> PathBuf {
    std::env::var("M9R_HOME").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default()).join(".m9r")
    })
}

/// The self-contained engine: explicit override, matching adjacent runtime, then user-wide installation.
fn find_engine() -> Option<PathBuf> {
    let name = if cfg!(windows) { "m9r-engine.exe" } else { "m9r-engine" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("M9R_ENGINE") {
        candidates.push(p.into());
    }
    // A released overlay and its adjacent engine are updated together. An older
    // user-wide installation must not override that matching runtime.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    candidates.push(m9r_home().join("bin").join(name));
    candidates.into_iter().find(|p| p.is_file())
}

/// Port the resident web broker listens on; must match `DEFAULT_BROKER_PORT` in
/// `src/lib/native/web-broker-paths.ts`.
const BROKER_PORT: u16 = 47821;
/// The owner-launched Windows Scheduled Task that runs `m9r-web-broker.exe` -- the only launch path that
/// passes the broker's own provenance check, so a stuck broker is restarted through this task, never by
/// spawning the exe directly.
const BROKER_TASK_NAME: &str = "M9R Web Broker";

/// A handful of connected agents (Claude, Codex, the pill) can jam the broker's single request thread
/// behind a contested local-state write (see local-store.ts's file lock); when that happens the broker's
/// own /health stops answering, and nothing it owns internally can save it. This watchdog is a second,
/// independent OS process checking the first one from the outside -- the only thing that still works once
/// a process has wedged itself -- and restarts it through the real scheduled task so the restart keeps the
/// same "owner-launched" provenance a manual respawn would fail. Off when `M9R_NO_BROKER_WATCHDOG` is set
/// (tests and spikes that run their own broker on a throwaway port).
fn spawn_broker_watchdog() {
    if std::env::var("M9R_NO_BROKER_WATCHDOG").is_ok() {
        return;
    }
    BROKER_WATCHDOG_STOPPING.store(false, Ordering::SeqCst);
    std::thread::spawn(|| {
        let mut consecutive_failures = 0u32;
        loop {
            if BROKER_WATCHDOG_STOPPING.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_secs(20));
            if BROKER_WATCHDOG_STOPPING.load(Ordering::SeqCst) {
                return;
            }
            if broker_health_ok() {
                consecutive_failures = 0;
                continue;
            }
            consecutive_failures += 1;
            eprintln!("M9R: broker health check failed ({consecutive_failures} in a row)");
            // Three failures 20s apart (~60s of the broker being unreachable) before restarting, so one
            // slow response under a brief burst of agent activity never trips a restart on its own.
            if consecutive_failures >= 3 {
                eprintln!("M9R: restarting the web broker via its scheduled task after sustained health-check failure");
                restart_broker_task();
                consecutive_failures = 0;
                // Give the freshly-restarted broker a moment before the next check, instead of
                // re-polling an exe that is still mid-startup and counting that as a new failure.
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    });
}

/// A raw, dependency-free HTTP/1.1 GET to the broker's own liveness endpoint. Intentionally not the
/// `fetch`/`reqwest` kind of client: a short TCP connect+read timeout here must never depend on anything
/// that could itself be the thing hanging.
fn broker_health_ok() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], BROKER_PORT)),
        Duration::from_secs(3),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let request = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut response = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                response.extend_from_slice(&buf[..n]);
                if response.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&response);
    text.starts_with("HTTP/1.1 200") && text.contains("\"ok\":true")
}

/// True if any `m9r-web-broker.exe` process is still alive. There is supposed to be exactly one such
/// process system-wide (it is the singleton owner-launched broker), so matching by image name here --
/// unlike `m9r-engine.exe`, which legitimately runs several roles at once and must never be bulk-killed
/// by name -- does not risk taking down an unrelated process.
#[cfg(windows)]
fn broker_image_still_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut query = Command::new("tasklist");
    query.args(["/FI", "IMAGENAME eq m9r-web-broker.exe", "/FO", "CSV", "/NH"]).creation_flags(CREATE_NO_WINDOW);
    match query.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_lowercase().contains("m9r-web-broker.exe"),
        // Could not even ask the process table; do not assume it is gone.
        Err(_) => true,
    }
}

/// Stops then starts the owner-launched broker task. A plain `/Run` on an already-"running" task record
/// is a no-op when the process is wedged but the scheduler still thinks it's up, so the stuck process must
/// be ended first -- and `/End` is only a request to the scheduler, not proof the process actually exited
/// (it can stop the task's own wrapper while the real `m9r-web-broker.exe` survives, orphaned, still holding
/// the port). Confirmed live on 2026-11-10: the scheduled task's last-run time moved while the broker stayed
/// the same pre-existing process. This now verifies the exit instead of assuming it, and force-stops the
/// exact lingering image before ever calling `/Run` again, rather than risking a second broker on the port.
fn restart_broker_task() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut end = Command::new("schtasks");
        end.args(["/End", "/TN", BROKER_TASK_NAME]).creation_flags(CREATE_NO_WINDOW);
        let _ = end.output();

        // Poll for the real process to disappear instead of trusting `/End` after a fixed sleep.
        let deadline = Instant::now() + Duration::from_secs(10);
        while broker_image_still_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
        }

        if broker_image_still_running() {
            eprintln!("M9R: '{BROKER_TASK_NAME}' survived /End; force-stopping the lingering m9r-web-broker.exe image before restart");
            let mut kill = Command::new("taskkill");
            kill.args(["/IM", "m9r-web-broker.exe", "/F"]).creation_flags(CREATE_NO_WINDOW);
            let _ = kill.output();
            let kill_deadline = Instant::now() + Duration::from_secs(5);
            while broker_image_still_running() && Instant::now() < kill_deadline {
                std::thread::sleep(Duration::from_millis(250));
            }
            if broker_image_still_running() {
                eprintln!("M9R: m9r-web-broker.exe is still running after a forced stop; refusing to start a second instance on the same port");
                return;
            }
        }

        let mut run = Command::new("schtasks");
        run.args(["/Run", "/TN", BROKER_TASK_NAME]).creation_flags(CREATE_NO_WINDOW);
        match run.output() {
            Ok(out) if out.status.success() => eprintln!("M9R: '{BROKER_TASK_NAME}' restarted"),
            Ok(out) => eprintln!("M9R: '{BROKER_TASK_NAME}' restart reported failure: {}", String::from_utf8_lossy(&out.stderr)),
            Err(e) => eprintln!("M9R: could not run schtasks to restart '{BROKER_TASK_NAME}': {e}"),
        }
    }
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

/// Sends what the owner typed to the broker-owned UI bridge. The broker owns
/// recipient selection and the managed provider lifecycle; the pill never
/// parses mentions or launches a provider-specific route itself.
#[tauri::command]
async fn send_message(text: String) -> Result<String, String> {
    if text.trim().is_empty() || text.chars().count() > 4000 {
        return Err("That message is empty or too long.".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || engine_call(&engine, &["pill-send", &text]))
        .await
        .map_err(|e| e.to_string())?
}

/// Persists and applies a provider-reported model through the resident owner
/// broker. The overlay never talks to a provider process directly.
#[tauri::command]
async fn select_model(handle: String, model: Option<String>, effort: Option<String>) -> Result<String, String> {
    if !plain_id(handle.trim().trim_start_matches('@')) {
        return Err("Bad agent handle".into());
    }
    if model.as_ref().is_some_and(|value| value.trim().is_empty() || value.chars().count() > 160)
        || effort.as_ref().is_some_and(|value| value.trim().is_empty() || value.chars().count() > 160) {
        return Err("Bad provider model selection".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    let handle = handle.trim().trim_start_matches('@').to_string();
    let mut args = vec!["pill-model".to_string(), format!("@{handle}")];
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) { args.push(model); }
    if let Some(effort) = effort.filter(|value| !value.trim().is_empty()) {
        if args.len() == 2 { args.push(String::new()); }
        args.push(effort);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        engine_call(&engine, &refs)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_owner_work_mode(mode: String) -> Result<String, String> {
    if mode != "working" && mode != "agents-free" { return Err("Invalid owner work mode".into()); }
    let engine = find_engine().ok_or("The M9R engine was not found.")?;
    tauri::async_runtime::spawn_blocking(move || engine_call(&engine, &["pill-work-mode", &mode]))
        .await.map_err(|error| error.to_string())?
}

/// Approves or denies a broker-owned pill approval. The broker UI contract
/// intentionally has no `allow for a day` route; that legacy grant remains
/// available only through the compatibility feed path.
#[tauri::command]
async fn pill_decide(approval_id: String, decision: String) -> Result<String, String> {
    if !plain_id(&approval_id) || !matches!(decision.as_str(), "allow" | "deny") {
        return Err("Bad desktop pill approval decision".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || engine_call(&engine, &["pill-decide", &approval_id, &decision]))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
fn parse_mentions(text: &str) -> (Vec<String>, String) {
    let mut handles: Vec<String> = Vec::new();
    let mut kept: Vec<&str> = Vec::new();
    for word in text.split_whitespace() {
        let trimmed = word.trim_end_matches(|c: char| ",.:;!?)".contains(c));
        if let Some(h) = trimmed.strip_prefix('@') {
            let h = h.to_lowercase();
            if !h.is_empty() && h.len() <= 39 && h.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                if !handles.contains(&h) {
                    handles.push(h);
                }
                continue;
            }
        }
        kept.push(word);
    }
    (handles, kept.join(" "))
}

/// Checks for a signed, newer M9R release. Never applies anything -- this only answers the
/// pill's "Update available" button with a verified version comparison (see engine-update-core.ts).
#[tauri::command]
async fn check_for_update() -> Result<String, String> {
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || engine_call(&engine, &["update", "check"]))
        .await
        .map_err(|e| e.to_string())?
}

fn plain_version(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Applies a verified update the pill already offered via check_for_update. Re-runs the exact
/// installer that was itself hashed as part of the currently-installed release (persisted to
/// M9R_HOME/tools by install-m9r.ps1), with -Yes standing in for the consent this button's own
/// "Update available" screen already collected. Detached so it survives this process being
/// stopped and relaunched by that same script, the same way it handles a normal install.
#[tauri::command]
async fn apply_update(version: String) -> Result<(), String> {
    if !plain_version(&version) {
        return Err("Bad version".into());
    }
    let installer = m9r_home().join("tools").join("install-m9r.ps1");
    if !installer.is_file() {
        return Err("No local installer was found to apply this update. Reinstall M9R from a current release first.".into());
    }
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(&installer)
    .args(["-Version", &version, "-Yes"])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: this installer
        // stops and relaunches the overlay itself, so the update must not be a child of
        // the process it is about to stop.
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Saves a fact or decision to the shared project memory agents read at session start (`m9r note`).
#[tauri::command]
async fn save_memory(text: String) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > 2000 {
        return Err("That note is empty or too long.".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || engine_call(&engine, &["pill-note", &text]))
        .await
        .map_err(|e| e.to_string())?
}

/// Clears one item from the pill's own lists (an old answer, a stale failed push, an approval you don't want to act
/// on right now) without acting on it -- the task itself is untouched, this only stops the overlay from showing it.
/// Confirmed real complaint 2026-09-22: items with no natural close action (answers shown for up to 10 minutes,
/// failed pushes for longer) had no way to clear them, so they stacked up on screen across a long testing session.
#[tauri::command]
async fn dismiss_task(task_id: String) -> Result<String, String> {
    if !plain_id(&task_id) {
        return Err("Bad task id".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || engine_call(&engine, &["dismiss", &task_id]))
        .await
        .map_err(|e| e.to_string())?
}

fn valid_glow_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Keep the presentation window on the pill's primary display, click-through, and non-activating.
/// The window is hidden while the pill is hidden or a full-screen app owns that display.
fn apply_screen_glow_window(app: &AppHandle, desired: &ScreenGlowSnapshot) -> Result<(), String> {
    let glow = app.get_webview_window(SCREEN_GLOW).ok_or("the screen-glow window is not registered")?;
    let pill = app.get_webview_window(PILL).ok_or("the pill window is not registered")?;
    let pill_visible = pill.is_visible().unwrap_or(false);
    let pill_hwnd = pill.hwnd().map(|handle| handle.0 as isize).unwrap_or(0);
    if !desired.visible || !pill_visible || fullscreen_app_in_front(pill_hwnd) {
        glow.hide().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let monitor = pill.primary_monitor().map_err(|error| error.to_string())?
        .ok_or("Windows did not report the pill's primary monitor")?;
    let position = monitor.position();
    let size = monitor.size();
    glow.set_position(PhysicalPosition::new(position.x, position.y)).map_err(|error| error.to_string())?;
    glow.set_size(PhysicalSize::new(size.width, size.height)).map_err(|error| error.to_string())?;
    glow.set_focusable(false).map_err(|error| error.to_string())?;
    glow.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
    glow.set_always_on_top(true).map_err(|error| error.to_string())?;
    glow.show().map_err(|error| error.to_string())?;
    // Keep the interactive pill above the transparent frame without activating it.
    let _ = pill.set_always_on_top(true);
    Ok(())
}

#[tauri::command]
fn read_screen_glow(state: State<'_, ScreenGlowState>) -> Result<ScreenGlowSnapshot, String> {
    state.0.lock().map(|snapshot| snapshot.clone()).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_screen_glow(
    app: AppHandle,
    state: State<'_, ScreenGlowState>,
    visible: bool,
    style: String,
    color: String,
    live: bool,
) -> Result<(), String> {
    if style != "status" && style != "rainbow" {
        return Err("Edge glow style must be status or rainbow.".into());
    }
    if !valid_glow_color(&color) {
        return Err("Edge glow color must be a six-digit hexadecimal color.".into());
    }
    let snapshot = {
        let mut current = state.0.lock().map_err(|error| error.to_string())?;
        if current.visible != visible || current.style != style || current.color != color || current.live != live {
            current.revision = current.revision.saturating_add(1);
            current.visible = visible;
            current.style = style;
            current.color = color;
            current.live = live;
        }
        current.clone()
    };
    apply_screen_glow_window(&app, &snapshot)?;
    app.emit_to(SCREEN_GLOW, "screen-glow-update", snapshot).map_err(|error| error.to_string())
}

/// Persists the pill's own settings (sound, auto-close delay) beside its saved window
/// position, so they survive a restart without depending on any provider session.
#[tauri::command]
fn save_settings(app: AppHandle, sound_enabled: bool, sound_volume: f64, auto_close_interval: f64,
    glow_style: String, glow_color: Option<String>) -> Result<(), String> {
    if glow_style != "status" && glow_style != "rainbow" && glow_style != "off" {
        return Err("Edge glow style must be status, rainbow, or off.".into());
    }
    if glow_color.as_deref().is_some_and(|color| !valid_glow_color(color)) {
        return Err("Edge glow color must be null or a six-digit hexadecimal color.".into());
    }
    let mut saved = load_saved(&app);
    saved.sound_enabled = Some(sound_enabled);
    saved.sound_volume = Some(sound_volume);
    saved.auto_close_interval = Some(auto_close_interval);
    saved.glow_style = Some(glow_style);
    saved.glow_color = glow_color;
    let path = saved_path(&app).ok_or("No app config directory is available.")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_string(&saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Reads back the last saved pill settings, if any. The pill applies its own defaults
/// for any field this returns as `null` (first run, or an older file with none saved).
#[tauri::command]
fn load_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let saved = load_saved(&app);
    Ok(serde_json::json!({
        "soundEnabled": saved.sound_enabled,
        "soundVolume": saved.sound_volume,
        "autoCloseInterval": saved.auto_close_interval,
        "glowStyle": saved.glow_style,
        "glowColor": saved.glow_color,
    }))
}

#[tauri::command]
fn log_debug(msg: String) {
    if std::env::var("M9R_DEBUG").as_deref() == Ok("1") { eprintln!("M9R: [frontend] {msg}"); }
}

#[cfg(windows)]
#[tauri::command]
async fn start_dictation() -> Result<(), String> {
    if std::env::var("M9R_DEBUG").as_deref() == Ok("1") { eprintln!("M9R: start_dictation command received from the pill"); }
    let result = native_dictation::start();
    if std::env::var("M9R_DEBUG").as_deref() == Ok("1") { eprintln!("M9R: start_dictation result = {result:?}"); }
    result
}

#[cfg(not(windows))]
#[tauri::command]
async fn start_dictation() -> Result<(), String> {
    Err("Windows dictation is available only on Windows.".into())
}

#[cfg(windows)]
#[tauri::command]
async fn stop_dictation() -> Result<(), String> {
    native_dictation::stop()
}

#[cfg(not(windows))]
#[tauri::command]
async fn stop_dictation() -> Result<(), String> {
    Err("Windows dictation is available only on Windows.".into())
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
                if let Ok(snapshot) = app.state::<ScreenGlowState>().0.lock().map(|state| state.clone()) {
                    let _ = apply_screen_glow_window(&app, &snapshot);
                }
            } else if !fullscreen && hidden_for_fullscreen {
                hidden_for_fullscreen = false;
                let _ = window.show();
                if let Ok(snapshot) = app.state::<ScreenGlowState>().0.lock().map(|state| state.clone()) {
                    let _ = apply_screen_glow_window(&app, &snapshot);
                }
            }
        }
    });
}

/// Shows the pill if hidden, hides it if shown. The one manual control the person has over it, reachable from the tray
/// menu and from a global hotkey (Ctrl+Alt+Shift+M) so it works even if the tray icon is tucked into Windows' overflow drawer,
/// which is where a new icon lands by default and easy to never notice.
fn toggle_pill(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PILL) {
        if w.is_visible().unwrap_or(true) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
        if let Ok(snapshot) = app.state::<ScreenGlowState>().0.lock().map(|state| state.clone()) {
            let _ = apply_screen_glow_window(app, &snapshot);
        }
    }
}

/// Shows (and focuses) the full app window, which starts hidden far off-screen (see its
/// tauri.conf.json x/y) so a hidden native window can never leave any compositor artifact near
/// the pill. Centering only happens here, the first time it's actually opened -- after that its
/// position is whatever the owner last moved it to, same as any real window.
#[tauri::command]
fn open_app_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(APP_WINDOW).ok_or("the app window is not registered")?;
    if !window.is_visible().unwrap_or(false) {
        let _ = window.center();
    }
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Window presentation only; never routes into pill or provider lifecycle.
#[tauri::command]
fn app_window_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let window = app.get_webview_window(APP_WINDOW).ok_or("the app window is not registered")?;
    match action.as_str() {
        "windowless" => window.set_decorations(false),
        "framed" => window.set_decorations(true),
        "drag" => window.start_dragging(),
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize() } else { window.maximize() }
        }
        "hide" => window.hide(),
        _ => return Err("unsupported app window action".into()),
    }.map_err(|error| error.to_string())
}

/// Explicit owner clicks may reveal an existing local file or open an HTTP(S)
/// result. Never execute a referenced file or pass agent text to a shell.
#[tauri::command]
fn open_output_reference(kind: String, location: String) -> Result<(), String> {
    let argument = output_reference_argument(&kind, &location)?;
    let mut command = Command::new(
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("explorer.exe")
    );
    command.arg(argument).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

fn output_reference_argument(kind: &str, location: &str) -> Result<String, String> {
    match kind {
        "file" => {
            let bytes = location.as_bytes();
            if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || ![b'/', b'\\'].contains(&bytes[2]) {
                return Err("Only an absolute local file reference can be revealed.".into());
            }
            let path = fs::canonicalize(&location).map_err(|_| "This referenced file is not available on this computer.")?;
            if !path.is_file() { return Err("This reference is not a file.".into()); }
            // Explorer expects the familiar drive path, not canonicalize's
            // Windows extended-length (\\?\) spelling. Reveal the owner's
            // referenced path after verifying the target exists.
            Ok(format!("/select,{}", location.replace('/', "\\")))
        }
        "link" => {
            let url = tauri::Url::parse(&location).map_err(|_| "Invalid output link.")?;
            if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() {
                return Err("Only HTTP(S) result links without embedded credentials can be opened.".into());
            }
            Ok(url.to_string())
        }
        _ => Err("Unsupported output reference.".into()),
    }
}

#[cfg(test)]
mod output_reference_tests {
    use super::output_reference_argument;

    #[test]
    fn output_urls_are_http_only_and_never_carry_credentials() {
        for location in ["javascript:alert(1)", "file:///C:/secret.txt", "data:text/html,test", "https://user:pass@example.com/"] {
            assert!(output_reference_argument("link", location).is_err());
        }
        assert_eq!(output_reference_argument("link", "https://example.com/result").unwrap(), "https://example.com/result");
    }

    #[test]
    fn output_files_require_an_existing_local_drive_path() {
        for location in ["relative.txt", "\\\\server\\share\\file", "C:\\m9r-missing-output-fixture\\result.txt"] {
            assert!(output_reference_argument("file", location).is_err());
        }
        assert!(output_reference_argument("execute", "https://example.com").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn output_file_reveal_uses_an_explorer_compatible_path() {
        let location = format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
        let argument = output_reference_argument("file", &location).unwrap();
        assert_eq!(argument, format!("/select,{}", location.replace('/', "\\")));
        assert!(!argument.contains("\\\\?\\"));
    }
}

/// Shows and focuses the real workspace window, reusing the one created at startup (defined in
/// tauri.conf.json, same pattern as the pill) rather than ever building a second instance of it.
fn show_workspace(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WORKSPACE) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn stop_engine() {
    BROKER_WATCHDOG_STOPPING.store(true, Ordering::SeqCst);
}

fn has_update_shutdown_argument(args: &[String]) -> bool {
    args.iter().any(|arg| arg == UPDATE_SHUTDOWN_ARGUMENT)
}

fn has_open_app_argument(args: &[String]) -> bool {
    args.iter().any(|arg| arg == OPEN_APP_ARGUMENT)
}

/// Exits this pill overlay process only. The broker/engine keep running in the background for other
/// agent sessions -- that is intentional, not a bug (see BROKER_WATCHDOG_STOPPING's own comment) -- and
/// startDesktopOverlay's own retry loop (desktop-pill-presence.ts) checks this heartbeat removal and
/// deliberately does not relaunch the pill after this call, so an intentional quit stays quit.
fn shutdown_pill(app: &AppHandle) {
    let _ = fs::remove_file(heartbeat_path());
    stop_engine();
    app.exit(0);
}

/// Shared by the hold-to-talk hotkey, however it was detected (currently only the raw Ctrl+Alt
/// keyboard hook in ctrl_alt_hold.rs, but this stays decoupled from that detection mechanism).
pub(crate) fn report_hold_to_talk(app: &AppHandle, state: &Mutex<HoldToTalkState>, pressed: bool) {
    if std::env::var("M9R_DEBUG").as_deref() == Ok("1") {
        eprintln!("M9R: hold-to-talk raw key state pressed={pressed}");
    }
    let transition = state.lock().unwrap().transition(pressed);
    if let Some(transition) = transition {
        if std::env::var("M9R_DEBUG").as_deref() == Ok("1") {
            eprintln!("M9R: hold-to-talk transition -> {}", transition.as_str());
        }
        if transition == HoldToTalkEvent::Pressed {
            if let Some(window) = app.get_webview_window(PILL) {
                let _ = window.show();
            }
        }
        let _ = app.emit("hold-to-talk", transition.as_str());
    }
}

fn main() {
    let toggle_shortcut = Shortcut::new(Some(TOGGLE_HOTKEY_MODS), TOGGLE_HOTKEY_CODE);
    tauri::Builder::default()
        // Register first: duplicate launches must exit before starting another
        // heartbeat writer, tray, hotkey handler, or engine supervisor.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if has_update_shutdown_argument(&args) {
                shutdown_pill(app);
            } else if has_open_app_argument(&args) {
                let _ = open_app_window(app.clone());
            } else {
                // The app already runs persistently in the background (tray + hidden pill), so a
                // second launch is always a deliberate click on the app's icon -- the same gesture
                // every other installed app treats as "open it," not "flash the pill."
                show_workspace(app);
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_pill(app);
                    }
                })
                .build(),
        )
        .manage(ScreenGlowState::default())
        // The canonical pill is broker-state based. Do not expose the old
        // merged-feed, provider-session linking, or compatibility decision
        // commands to the production window; those paths could resurrect
        // historical provider/session state after a restart.
        .invoke_handler(tauri::generate_handler![resize_pill, read_pill_state, send_message, select_model, set_owner_work_mode, pill_decide, save_memory, dismiss_task, start_dictation, stop_dictation, log_debug, pill_set_rect, pill_set_focus, open_microphone_settings, open_app_window, app_window_action, open_output_reference, save_settings, load_settings, read_screen_glow, set_screen_glow, check_for_update, apply_update])
        .setup(move |app| {
            // If no pill instance exists, the installer handoff can start this process. Exit
            // before creating the tray, heartbeat, feed watcher, or engine supervisor.
            if has_update_shutdown_argument(&std::env::args().collect::<Vec<_>>()) {
                shutdown_pill(app.handle());
                return Ok(());
            }
            let window = app.get_webview_window(PILL).expect("pill window");
            if let Some(screen_glow) = app.get_webview_window(SCREEN_GLOW) {
                let _ = screen_glow.set_focusable(false);
                let _ = screen_glow.set_ignore_cursor_events(true);
                let _ = screen_glow.hide();
            }
            // Never take keyboard focus: clicking the pill must not pull you out of the terminal you were typing in.
            let _ = window.set_focusable(false);
            let _ = window.set_always_on_top(true);
            allow_microphone_permission(&window);
            #[cfg(windows)]
            native_dictation::init(app.handle().clone());
            #[cfg(windows)]
            ctrl_alt_hold::spawn(app.handle().clone());
            if next_mode() {
                // The one-pill UI is the root of the single canonical frontend bundle.
                let _ = window.set_ignore_cursor_events(true);
                place_next_pill(&window, &load_saved(app.handle()));
                if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
                    // The visible lip can receive its first click before WebView reports geometry.
                    NEXT.lock().unwrap().rect = IslandRect::startup_lip(size.width as f64 / scale);
                }
                match "http://tauri.localhost/index.html".parse() {
                    Ok(url) => { let _ = window.navigate(url); }
                    Err(e) => eprintln!("M9R: could not open the one-pill UI ({e})"),
                }
                spawn_click_through_watcher(app.handle().clone());
            } else {
                place(&window, &load_saved(app.handle()));
            }
            let _ = window.show();
            // A normal M9R launcher passes --m9r-open-app. The resident tray/pill
            // startup remains unchanged, but a deliberate app launch must present
            // the full native window on the first process, not only on a duplicate
            // launch handled by the single-instance callback.
            if has_open_app_argument(&std::env::args().collect::<Vec<_>>()) {
                let _ = open_app_window(app.handle().clone());
            }
            // Debug aid for a live "the pill shows the wrong thing" report: M9R_DEBUG=1 opens DevTools on the
            // pill's own webview so the actual console/network error is visible instead of guessing from a
            // screenshot. Never on by default -- devtools is a real attack-surface increase to leave open.
            if std::env::var("M9R_DEBUG").as_deref() == Ok("1") {
                window.open_devtools();
            }

            let open = MenuItem::with_id(app, "open-app", "Open M9R", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "toggle", &format!("Show / hide pill ({TOGGLE_HOTKEY_LABEL})"), true, None::<&str>)?;
            let dnd = CheckMenuItem::with_id(app, "dnd", "Do not disturb", true, false, None::<&str>)?;
            // Labeled "Close Pill," not "Quit": this only exits the pill overlay process. The
            // broker/engine background service keeps running for other agent sessions by design
            // (see shutdown_pill's own comment) -- "Quit" would wrongly imply it stops everything.
            let quit = MenuItem::with_id(app, "quit", "Close Pill", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &show, &dnd, &quit])?;
            let mut tray = TrayIconBuilder::new().tooltip("M9R").menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(move |app, event| match event.id.as_ref() {
                "toggle" => toggle_pill(app),
                "open-app" => { let _ = open_app_window(app.clone()); }
                "dnd" => {
                    let _ = app.emit("dnd", dnd.is_checked().unwrap_or(false));
                }
                "quit" => shutdown_pill(app),
                _ => {}
            })
            .build(app)?;

            spawn_heartbeat(app.handle().clone());
            spawn_broker_watchdog();
            spawn_fullscreen_watcher(app.handle().clone());
            // Best effort: if something else already holds this chord, the tray menu's "Show / hide" still works.
            // The result is no longer silently discarded -- a failure here was previously invisible even to us.
            match app.global_shortcut().register(toggle_shortcut) {
                Ok(()) => eprintln!("M9R: registered global hotkey {TOGGLE_HOTKEY_LABEL}"),
                Err(e) => eprintln!("M9R: could not register global hotkey {TOGGLE_HOTKEY_LABEL} ({e}); use the tray menu's Show/hide instead"),
            }
            // The dictation hotkey (bare Ctrl+Alt, no letter) is registered by ctrl_alt_hold::spawn
            // above instead -- Win32's RegisterHotKey cannot represent a modifier-only chord.
            eprintln!("M9R: dictation hotkey is {HOLD_TO_TALK_HOTKEY_LABEL} (hold)");
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::Moved(pos) => {
                    // Position persistence is pill-specific framing; the app and workspace windows
                    // are ordinary resizable app windows with no saved-position concept.
                    if window.label() == PILL {
                        if let Ok(size) = window.outer_size() {
                            save_position(window.app_handle(), pos.x + size.width as i32 / 2, pos.y);
                        }
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == PILL {
                        shutdown_pill(window.app_handle());
                    } else {
                        // Closing the app or workspace window should hide it, not quit the whole
                        // app or destroy the window -- "Open M9R" from the tray must keep working.
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the M9R overlay");
}

#[cfg(test)]
mod screen_glow_tests {
    use super::{valid_glow_color, Saved, ScreenGlowSnapshot};

    #[test]
    fn edge_glow_color_accepts_only_rgb_hex_values() {
        assert!(valid_glow_color("#ffffff"));
        assert!(valid_glow_color("#A1b2C3"));
        assert!(!valid_glow_color("white"));
        assert!(!valid_glow_color("#fff"));
        assert!(!valid_glow_color("##112233"));
        assert!(!valid_glow_color("#１２３４５６"));
    }

    #[test]
    fn older_window_settings_keep_defaults_and_custom_glow_round_trips() {
        let old: Saved = serde_json::from_str(r#"{"sound_enabled":true,"auto_close_interval":15.0}"#).unwrap();
        assert_eq!(old.glow_style, None);
        assert_eq!(old.glow_color, None);

        let saved = Saved { glow_style: Some("rainbow".into()), glow_color: Some("#32A8FF".into()), ..Saved::default() };
        let restored: Saved = serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
        assert_eq!(restored.glow_style.as_deref(), Some("rainbow"));
        assert_eq!(restored.glow_color.as_deref(), Some("#32A8FF"));
    }

    #[test]
    fn screen_frame_starts_hidden_and_non_live() {
        let state = ScreenGlowSnapshot::default();
        assert!(!state.visible);
        assert!(!state.live);
        assert_eq!(state.style, "status");
    }
}

#[cfg(test)]
mod one_pill_window_tests {
    use super::{has_open_app_argument, has_update_shutdown_argument, heartbeat_json, IslandRect, HIT_MARGIN, NEXT_H, NEXT_W, OPEN_APP_ARGUMENT, UPDATE_SHUTDOWN_ARGUMENT};

    #[test]
    fn startup_lip_only_accepts_clicks_near_the_visible_notch() {
        for width in [240.0, 720.0, NEXT_W] {
            let lip = IslandRect::startup_lip(width);
            assert!(lip.hit(0.0, width / 2.0, 16.0));
            assert!(!lip.hit(0.0, width / 2.0, 80.0));
            assert!(!lip.hit(0.0, 0.0, 16.0));
            assert!(IslandRect::checked(lip.x, lip.y, lip.w, lip.h, width, NEXT_H).is_some());
        }
    }

    #[test]
    fn only_the_private_installer_argument_requests_shutdown() {
        assert!(has_update_shutdown_argument(&[
            "m9r-overlay.exe".into(),
            UPDATE_SHUTDOWN_ARGUMENT.into(),
        ]));
        assert!(!has_update_shutdown_argument(&["m9r-overlay.exe".into()]));
        assert!(!has_update_shutdown_argument(&["m9r-overlay.exe".into(), "--quit".into()]));
    }

    #[test]
    fn the_app_launcher_argument_is_distinct_from_pill_startup() {
        assert!(has_open_app_argument(&[
            "m9r-overlay.exe".into(),
            OPEN_APP_ARGUMENT.into(),
        ]));
        assert!(!has_open_app_argument(&["m9r-overlay.exe".into()]));
        assert!(!has_open_app_argument(&[
            "m9r-overlay.exe".into(),
            UPDATE_SHUTDOWN_ARGUMENT.into(),
        ]));
    }

    #[test]
    fn the_heartbeat_is_the_json_the_broker_reads() {
        let v: serde_json::Value = serde_json::from_str(&heartbeat_json(1_700_000_000_123, true, 42)).unwrap();
        assert_eq!(v["at"], 1_700_000_000_123u64);
        assert_eq!(v["visible"], true);
        assert_eq!(v["pid"], 42);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&heartbeat_json(1, false, 1)).unwrap()["visible"], false);
    }

    #[test]
    fn only_a_sane_rectangle_inside_the_window_is_accepted() {
        assert!(IslandRect::checked(216.0, 0.0, 288.0, 32.0, NEXT_W, NEXT_H).is_some());
        assert!(IslandRect::checked(198.0, 0.0, 704.0, 432.0, NEXT_W, NEXT_H).is_some());
        assert!(IslandRect::checked(0.0, 0.0, NEXT_W, NEXT_H, NEXT_W, NEXT_H).is_some());
        assert!(IslandRect::checked(f64::NAN, 0.0, 10.0, 10.0, NEXT_W, NEXT_H).is_none());
        assert!(IslandRect::checked(0.0, 0.0, -1.0, 10.0, NEXT_W, NEXT_H).is_none());
        assert!(IslandRect::checked(100.0, 0.0, NEXT_W, 10.0, NEXT_W, NEXT_H).is_none(), "wider than the window allows");
        assert!(IslandRect::checked(0.0, 0.0, 10.0, 432.0, 720.0, 400.0).is_none());
    }

    #[test]
    fn the_island_and_its_margin_are_solid_and_everything_else_is_click_through() {
        let r = IslandRect::checked(216.0, 0.0, 288.0, 32.0, NEXT_W, NEXT_H).unwrap();
        assert!(r.hit(HIT_MARGIN, 300.0, 10.0));
        assert!(r.hit(HIT_MARGIN, 216.0 - HIT_MARGIN, 0.0), "the margin counts");
        assert!(!r.hit(HIT_MARGIN, 216.0 - HIT_MARGIN - 1.0, 10.0));
        assert!(!r.hit(HIT_MARGIN, 300.0, 32.0 + HIT_MARGIN + 1.0));
    }

    #[test]
    fn a_retracted_island_is_never_hit_even_at_its_old_position() {
        let r = IslandRect::checked(268.0, 0.0, 184.0, 0.0, NEXT_W, NEXT_H).unwrap();
        assert!(!r.hit(HIT_MARGIN, 300.0, 0.0));
        assert!(!IslandRect::default().hit(HIT_MARGIN, 0.0, 0.0));
    }

}

#[cfg(test)]
mod hold_to_talk_tests {
    use super::{parse_mentions, HoldToTalkEvent, HoldToTalkState, HOLD_TO_TALK_HOTKEY_LABEL};

    #[test]
    fn hold_to_talk_hotkey_is_bare_ctrl_alt() {
        // No letter: Win32's RegisterHotKey cannot represent this, so it's detected via
        // ctrl_alt_hold.rs's low-level keyboard hook instead of tauri-plugin-global-shortcut.
        assert_eq!(HOLD_TO_TALK_HOTKEY_LABEL, "Ctrl+Alt");
    }

    #[test]
    fn mentions_pick_recipients_and_leave_the_message() {
        assert_eq!(parse_mentions("@claude check the pricing page"), (vec!["claude".to_string()], "check the pricing page".to_string()));
        assert_eq!(parse_mentions("@Claude and @codex, compare notes @claude"), (vec!["claude".to_string(), "codex".to_string()], "and compare notes".to_string()));
        assert_eq!(parse_mentions("mail me@example.com about it").0, Vec::<String>::new());
        assert_eq!(parse_mentions("just words").0.len(), 0);
        assert_eq!(parse_mentions("@claude").1, "");
        assert_eq!(parse_mentions("@bad_name hi").0.len(), 0, "underscores are not part of a handle");
    }

    #[test]
    fn emits_one_press_and_release_for_a_hold() {
        let mut state = HoldToTalkState::default();
        assert_eq!(state.transition(true), Some(HoldToTalkEvent::Pressed));
        assert_eq!(state.transition(false), Some(HoldToTalkEvent::Released));
    }

    #[test]
    fn ignores_repeated_keydown_and_unmatched_keyup() {
        let mut state = HoldToTalkState::default();
        assert_eq!(state.transition(false), None);
        assert_eq!(state.transition(true), Some(HoldToTalkEvent::Pressed));
        assert_eq!(state.transition(true), None);
        assert_eq!(state.transition(true), None);
        assert_eq!(state.transition(false), Some(HoldToTalkEvent::Released));
        assert_eq!(state.transition(false), None);
    }

    #[test]
    fn event_payloads_are_stable_for_the_frontend() {
        assert_eq!(HoldToTalkEvent::Pressed.as_str(), "pressed");
        assert_eq!(HoldToTalkEvent::Released.as_str(), "released");
    }
}

#[cfg(test)]
mod feed_view_tests {
    use super::{merge_view_feed, read_view_feed};
    use serde_json::Value;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn merges_split_files_for_the_view_without_losing_surface_identity() {
        let native_source = r#"{"surface":"native","version":1,"seq":4,"agents":[{"handle":"codex","sessions":[{"id":"s1"}]}],"needsYou":[{"kind":"approval","taskId":"t1"}],"inProgress":[],"recent":[{"text":"native item"}],"pings":[{"id":4}],"reserved":{"people":[],"channels":[]}}"#;
        let web_source = r#"{"version":1,"surface":"web","items":[{"surface":"native","agent":"codex","provider":"codex-cli","kind":"action","text":"Read issue"}]}"#;

        let view: Value = serde_json::from_str(&merge_view_feed(Some(native_source), Some(web_source)).unwrap()).unwrap();

        assert_eq!(view["surface"], "native");
        assert_eq!(view["agents"][0]["surface"], "native");
        assert_eq!(view["agents"][0]["sessions"][0]["surface"], "native");
        assert_eq!(view["needsYou"][0]["surface"], "native");
        assert_eq!(view["recent"][0]["surface"], "native");
        assert_eq!(view["pings"][0]["surface"], "native");
        assert_eq!(view["web"][0]["surface"], "web");
        assert_eq!(view["web"][0]["text"], "Read issue");
        assert!(!native_source.contains("\"web\""), "the source feed remains native-only");
    }

    #[test]
    fn web_activity_remains_visible_when_the_native_file_is_absent() {
        let web_source = r#"{"version":1,"surface":"web","items":[{"agent":"claude","provider":"claude-code","kind":"message","text":"Found the issue"}]}"#;

        let view: Value = serde_json::from_str(&merge_view_feed(None, Some(web_source)).unwrap()).unwrap();

        assert_eq!(view["surface"], "native");
        assert!(view["agents"].as_array().unwrap().is_empty());
        assert_eq!(view["web"][0]["surface"], "web");
        assert_eq!(view["web"][0]["agent"], "claude");
    }

    #[test]
    fn wrong_surface_web_documents_are_not_mixed_into_the_view() {
        let native_source = r#"{"version":1,"seq":0,"agents":[],"needsYou":[],"inProgress":[],"recent":[],"pings":[]}"#;
        let wrong_web_source = r#"{"version":1,"surface":"native","items":[{"text":"wrong source"}]}"#;

        let view: Value = serde_json::from_str(&merge_view_feed(Some(native_source), Some(wrong_web_source)).unwrap()).unwrap();

        assert!(view["web"].as_array().unwrap().is_empty());
        assert_eq!(view["surface"], "native");
    }

    #[test]
    fn reader_loads_native_and_web_files_from_distinct_paths() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("m9r-feed-view-{}-{nonce}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let native_path = dir.join("feed.json");
        let web_path = dir.join("web-activity.json");
        fs::write(&native_path, r#"{"surface":"native","version":1,"seq":1,"agents":[],"needsYou":[],"inProgress":[],"recent":[],"pings":[]}"#).unwrap();
        fs::write(&web_path, r#"{"version":1,"surface":"web","items":[{"agent":"codex","provider":"codex-cli","kind":"action","text":"On web"}]}"#).unwrap();

        let view: Value = serde_json::from_str(&read_view_feed(&native_path, &web_path).unwrap()).unwrap();

        assert_eq!(view["web"][0]["surface"], "web");
        assert_eq!(view["web"][0]["text"], "On web");
        let disk_native: Value = serde_json::from_str(&fs::read_to_string(&native_path).unwrap()).unwrap();
        assert!(disk_native.get("web").is_none(), "merging must not mutate native feed.json");
        fs::remove_dir_all(dir).unwrap();
    }
}
