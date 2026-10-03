// M9R overlay shell. It shows a feed and nothing else: all logic (routing, approvals, liveness) stays in m9r-cli, which
// writes ~/.m9r/feed.json and the web broker writes ~/.m9r/web-activity.json. This file owns the view-only merge plus
// the window, tray, and local UI events; it never changes either source file.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::{Path, PathBuf},
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
/// A scaffold only: press/release is surfaced to the UI, but no audio device or transcription provider is opened.
const HOLD_TO_TALK_HOTKEY_MODS: Modifiers = Modifiers::CONTROL.union(Modifiers::ALT).union(Modifiers::SHIFT);
const HOLD_TO_TALK_HOTKEY_CODE: Code = Code::Space;
const HOLD_TO_TALK_HOTKEY_LABEL: &str = "Ctrl+Alt+Shift+Space";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HoldToTalkEvent {
    Pressed,
    Released,
}

impl HoldToTalkEvent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pressed => "pressed",
            Self::Released => "released",
        }
    }
}

/// Suppresses OS key-repeat notifications so the frontend sees one start and one end per hold.
#[derive(Default)]
struct HoldToTalkState {
    pressed: bool,
}

impl HoldToTalkState {
    fn transition(&mut self, pressed: bool) -> Option<HoldToTalkEvent> {
        if self.pressed == pressed {
            return None;
        }
        self.pressed = pressed;
        Some(if pressed { HoldToTalkEvent::Pressed } else { HoldToTalkEvent::Released })
    }
}

/// The engine child the overlay started, so quitting the overlay stops it too.
static ENGINE: Mutex<Option<Child>> = Mutex::new(None);

const PILL: &str = "pill";
const COLLAPSED_W: f64 = 220.0;
const TOP_MARGIN: f64 = 8.0;

// ── One-pill window (default; M9R_PILL_NEXT=0 for the older overlay UI) ───────────────────────────────────────────────────────────────
// The new pill UI draws its own island inside a fixed, transparent, top-centre window and tells this side three things:
// where the island is (so everything around it stays click-through), when it has folded away (the window shrinks to a
// wake strip), and when it needs the keyboard (the message field). The old overlay UI does not use any of this.

/// The new UI's panel width (its `PANEL_W`); the island is centred in it, and tall enough for its largest view.
const NEXT_W: f64 = 720.0;
const NEXT_H: f64 = 320.0;
/// The strip the folded-away island leaves behind so the pointer can wake it (the UI draws the same 240 x 6 strip).
const WAKE_W: f64 = 240.0;
const WAKE_H: f64 = 6.0;
/// Margin around the island that still counts as over it, matching the UI.
const HIT_MARGIN: f64 = 14.0;

fn next_mode() -> bool {
    // The one pill is the default; M9R_PILL_NEXT=0 starts the older overlay UI instead.
    std::env::var("M9R_PILL_NEXT").as_deref() != Ok("0")
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct IslandRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl IslandRect {
    /// A rectangle the UI reports must be finite, non-negative, and inside the window; anything else is ignored.
    fn checked(x: f64, y: f64, w: f64, h: f64) -> Option<IslandRect> {
        let sane = [x, y, w, h].iter().all(|v| v.is_finite()) && w >= 0.0 && h >= 0.0 && x >= -1.0 && y >= -1.0 && x + w <= NEXT_W + 1.0 && y + h <= NEXT_H + 1.0;
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
    collapsed: bool,
}

static NEXT: Mutex<NextPill> = Mutex::new(NextPill { rect: IslandRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }, collapsed: false });

/// The size the window should have: the whole panel, or just the wake strip while the island is folded away.
fn next_window_size(collapsed: bool) -> (f64, f64) {
    if collapsed { (WAKE_W, WAKE_H) } else { (NEXT_W, NEXT_H) }
}

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

fn spawn_heartbeat(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(window) = app.get_webview_window(PILL) {
            let at = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let visible = window.is_visible().unwrap_or(false);
            let path = heartbeat_path();
            // Write beside, then rename, so the broker never reads half a file.
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, heartbeat_json(at, visible, std::process::id())).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
        std::thread::sleep(HEARTBEAT_EVERY);
    });
}

/// The island reports where it is drawn, in logical pixels from the window's top-left.
#[tauri::command]
fn pill_set_rect(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let rect = IslandRect::checked(x, y, width, height).ok_or("island rectangle is outside the window")?;
    NEXT.lock().unwrap().rect = rect;
    Ok(())
}

/// The island folded away (the window becomes the wake strip) or came back. Keeps the window's centre and top edge.
#[tauri::command]
fn pill_set_collapsed(window: WebviewWindow, collapsed: bool) -> Result<(), String> {
    {
        let mut state = NEXT.lock().unwrap();
        if state.collapsed == collapsed {
            return Ok(());
        }
        state.collapsed = collapsed;
    }
    let (w, h) = next_window_size(collapsed);
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let cx = pos.x + size.width as i32 / 2;
    window.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new(cx - (w * scale).round() as i32 / 2, pos.y)).map_err(|e| e.to_string())?;
    // The wake strip must receive the pointer; everything else about click-through is decided by the watcher below.
    if collapsed {
        let _ = window.set_ignore_cursor_events(false);
    }
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

/// Makes the transparent area around the island click-through, so the pill never blocks the page or app underneath. The
/// window turns solid only while the pointer is over the island (plus its margin).
fn spawn_click_through_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let Some(window) = app.get_webview_window(PILL) else { continue };
            let (rect, collapsed) = {
                let state = NEXT.lock().unwrap();
                (state.rect, state.collapsed)
            };
            if collapsed {
                ignoring = None; // pill_set_collapsed made the strip solid; re-evaluate when it expands
                continue;
            }
            let (Ok(cursor), Ok(pos), Ok(scale)) = (window.cursor_position(), window.outer_position(), window.scale_factor()) else { continue };
            let inside = rect.hit(HIT_MARGIN, (cursor.x - pos.x as f64) / scale, (cursor.y - pos.y as f64) / scale);
            if ignoring != Some(!inside) {
                ignoring = Some(!inside);
                let _ = window.set_ignore_cursor_events(!inside);
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

/// The web broker writes this separately from the native feed. If M9R_FEED is overridden for a local preview/test,
/// keep the companion activity file beside that override; the production default is ~/.m9r/web-activity.json.
fn web_activity_path() -> PathBuf {
    feed_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("web-activity.json")
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
    place_with(window, saved, COLLAPSED_W);
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

/// A view-only merge of the native feed and separately persisted web activity.
#[tauri::command]
fn read_feed() -> Option<String> {
    read_view_feed(&feed_path(), &web_activity_path())
}

fn read_view_feed(native_path: &Path, web_path: &Path) -> Option<String> {
    let native = fs::read_to_string(native_path).ok();
    let web = fs::read_to_string(web_path).ok();
    merge_view_feed(native.as_deref(), web.as_deref())
}

/// Compose sources only in memory for the renderer. This never writes back to feed.json, which remains native-only.
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

/// The agents a typed message addresses and the text to send them: every distinct `@handle` that starts a word is a
/// recipient, and the handles are removed from what they receive (the same rule the terminal hook applies).
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

/// Sends what the owner typed to the agents it names, through the engine's own `send` (the same human-typed path the
/// terminal hook uses), so routing, approval rules and delivery stay in one place.
#[tauri::command]
async fn send_message(text: String) -> Result<String, String> {
    if text.len() > 4000 {
        return Err("That message is too long.".into());
    }
    let (handles, goal) = parse_mentions(&text);
    if handles.is_empty() {
        return Err("Start with who it is for, like @claude or @codex.".into());
    }
    if goal.trim().is_empty() {
        return Err("Add what you want them to do after the @name.".into());
    }
    if handles.iter().any(|h| !plain_id(h)) {
        return Err("Bad agent name".into());
    }
    let engine = find_engine().ok_or("The M9R engine was not found. Run setup again.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut replies = Vec::new();
        for h in handles {
            replies.push(engine_call(&engine, &["send", &format!("@{h}"), &goal])?);
        }
        Ok(replies.join("
"))
    })
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

/// Watches both source files (a quarter-second poll: no extra dependency) and emits a merged view when either changes.
fn spawn_feed_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let native_path = feed_path();
        let web_path = web_activity_path();
        let mut last_native: Option<(SystemTime, u64)> = None;
        let mut last_web: Option<(SystemTime, u64)> = None;
        let mut last_change_at = Instant::now();
        let mut stale_reported = false;
        loop {
            let native = file_stamp(&native_path);
            let web = file_stamp(&web_path);
            let native_changed = native != last_native;
            let any_changed = native_changed || web != last_web;
            last_native = native;
            last_web = web;

            if native_changed && native.is_some() {
                last_change_at = Instant::now();
                if stale_reported {
                    stale_reported = false;
                    let _ = app.emit("engine-ok", ());
                }
            }
            if any_changed {
                if let Some(view) = read_view_feed(&native_path, &web_path) {
                    let _ = app.emit("feed", view);
                } else {
                    let _ = app.emit("feed-missing", ());
                }
            } else if native.is_some() && !stale_reported && last_change_at.elapsed() > Duration::from_secs(20) {
                // Web activity does not keep the native engine healthy: only native feed writes reset this timer.
                stale_reported = true;
                let _ = app.emit("engine-stale", ());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    fs::metadata(path).ok().map(|meta| (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()))
}

fn main() {
    let toggle_shortcut = Shortcut::new(Some(TOGGLE_HOTKEY_MODS), TOGGLE_HOTKEY_CODE);
    let hold_to_talk_shortcut = Shortcut::new(Some(HOLD_TO_TALK_HOTKEY_MODS), HOLD_TO_TALK_HOTKEY_CODE);
    let hold_to_talk_state = std::sync::Arc::new(Mutex::new(HoldToTalkState::default()));
    let handler_hold_to_talk_state = hold_to_talk_state.clone();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_pill(app);
                    } else if shortcut == &hold_to_talk_shortcut {
                        let pressed = event.state() == ShortcutState::Pressed;
                        let transition = handler_hold_to_talk_state.lock().unwrap().transition(pressed);
                        if let Some(transition) = transition {
                            // This is only an input-state hook for a future provider/privacy contract. It deliberately
                            // does not open a microphone, record audio, or start transcription.
                            let _ = app.emit("hold-to-talk", transition.as_str());
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![resize_pill, read_feed, decide, send_message, list_sessions, link_sessions, dismiss_task, pill_set_rect, pill_set_collapsed, pill_set_focus])
        .setup(move |app| {
            let window = app.get_webview_window(PILL).expect("pill window");
            // Never take keyboard focus: clicking the pill must not pull you out of the terminal you were typing in.
            let _ = window.set_focusable(false);
            let _ = window.set_always_on_top(true);
            if next_mode() {
                // The one-pill UI ships inside the overlay's bundle under /pill-next; the window is its fixed panel.
                let _ = window.set_size(LogicalSize::new(NEXT_W, NEXT_H));
                let _ = window.set_ignore_cursor_events(true);
                match "http://tauri.localhost/pill-next/index.html".parse() {
                    Ok(url) => { let _ = window.navigate(url); }
                    Err(e) => eprintln!("M9R: could not open the one-pill UI ({e})"),
                }
                place_with(&window, &load_saved(app.handle()), NEXT_W);
                spawn_click_through_watcher(app.handle().clone());
            } else {
                place(&window, &load_saved(app.handle()));
            }
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
                    let _ = fs::remove_file(heartbeat_path());
                    stop_engine();
                    app.exit(0)
                }
                _ => {}
            })
            .build(app)?;

            spawn_heartbeat(app.handle().clone());
            spawn_feed_watcher(app.handle().clone());
            spawn_engine_supervisor();
            spawn_fullscreen_watcher(app.handle().clone());
            // Best effort: if something else already holds this chord, the tray menu's "Show / hide" still works.
            // The result is no longer silently discarded -- a failure here was previously invisible even to us.
            match app.global_shortcut().register(toggle_shortcut) {
                Ok(()) => eprintln!("M9R: registered global hotkey {TOGGLE_HOTKEY_LABEL}"),
                Err(e) => eprintln!("M9R: could not register global hotkey {TOGGLE_HOTKEY_LABEL} ({e}); use the tray menu's Show/hide instead"),
            }
            match app.global_shortcut().register(hold_to_talk_shortcut) {
                Ok(()) => eprintln!("M9R: registered hold-to-talk scaffold {HOLD_TO_TALK_HOTKEY_LABEL} (no audio capture)"),
                Err(e) => eprintln!("M9R: could not register hold-to-talk scaffold {HOLD_TO_TALK_HOTKEY_LABEL} ({e})"),
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

#[cfg(test)]
mod one_pill_window_tests {
    use super::{heartbeat_json, next_window_size, IslandRect, HIT_MARGIN, NEXT_H, NEXT_W, WAKE_H, WAKE_W};

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
        assert!(IslandRect::checked(216.0, 0.0, 288.0, 32.0).is_some());
        assert!(IslandRect::checked(0.0, 0.0, NEXT_W, NEXT_H).is_some());
        assert!(IslandRect::checked(f64::NAN, 0.0, 10.0, 10.0).is_none());
        assert!(IslandRect::checked(0.0, 0.0, -1.0, 10.0).is_none());
        assert!(IslandRect::checked(100.0, 0.0, NEXT_W, 10.0).is_none(), "wider than the window allows");
        assert!(IslandRect::checked(0.0, 0.0, 10.0, NEXT_H + 50.0).is_none());
    }

    #[test]
    fn the_island_and_its_margin_are_solid_and_everything_else_is_click_through() {
        let r = IslandRect::checked(216.0, 0.0, 288.0, 32.0).unwrap();
        assert!(r.hit(HIT_MARGIN, 300.0, 10.0));
        assert!(r.hit(HIT_MARGIN, 216.0 - HIT_MARGIN, 0.0), "the margin counts");
        assert!(!r.hit(HIT_MARGIN, 216.0 - HIT_MARGIN - 1.0, 10.0));
        assert!(!r.hit(HIT_MARGIN, 300.0, 32.0 + HIT_MARGIN + 1.0));
    }

    #[test]
    fn a_retracted_island_is_never_hit_even_at_its_old_position() {
        let r = IslandRect::checked(268.0, 0.0, 184.0, 0.0).unwrap();
        assert!(!r.hit(HIT_MARGIN, 300.0, 0.0));
        assert!(!IslandRect::default().hit(HIT_MARGIN, 0.0, 0.0));
    }

    #[test]
    fn the_window_is_the_panel_or_just_the_wake_strip() {
        assert_eq!(next_window_size(false), (NEXT_W, NEXT_H));
        assert_eq!(next_window_size(true), (WAKE_W, WAKE_H));
    }
}

#[cfg(test)]
mod hold_to_talk_tests {
    use super::{parse_mentions, HoldToTalkEvent, HoldToTalkState};

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
