//! M9R's own agent-cursor visual overlay: a per-pixel-alpha layered window.
//! M9R's stage driver supplies verified screen positions to this renderer.
//! This module owns only presentation pixels for a custom shape,
//! persistent per-agent color/label, and fading agent-to-agent chatter
//! bubbles -- it never dispatches input and is never on the action path.
//!
//! Driven entirely by newline-delimited JSON commands on stdin so the TS
//! driver layer can feed it real positions without this module knowing
//! anything about Cua, UI Automation, or window targeting.
//!
//! Rendering uses Direct2D (anti-aliased vector geometry, layers, Gaussian
//! blur effect for soft shadows) and DirectWrite (real text layout), drawn
//! into a premultiplied BGRA DIB that is handed to `UpdateLayeredWindow`.

use serde_json::Value;
use std::collections::HashMap;
use std::io::{stdin, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A submitted command is not a presented frame. Retain work until the
/// compositor accepts it, including the transparent frame after the last hide.
struct PendingFrame(bool);

impl PendingFrame {
    fn invalidate(&mut self, changed: bool) { self.0 |= changed; }
    fn needed(&self, animating: bool) -> bool { self.0 || animating }
    fn presented(&mut self) { self.0 = false; }
}

fn presentation_snapshot(state: &SharedState, pending: &mut PendingFrame) -> HashMap<String, AgentState> {
    let guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let snapshot = guard.clone();
    pending.invalidate(PRESENTATION_DIRTY.swap(false, Ordering::AcqRel));
    snapshot
}

/// Set whenever a command actually changes presentation state (a new/moved
/// marker, a chatter bubble, or a removal) and cleared after the tick that
/// renders it. Lets the WM_TIMER loop below skip the render+blit entirely on
/// a tick where nothing changed, instead of repainting an unchanged frame at
/// the full 16ms timer rate for every agent that is simply sitting still
/// between actions -- the bulk of a real task's wall-clock time.
static PRESENTATION_DIRTY: AtomicBool = AtomicBool::new(true);

pub const MARKER_SIZE: f32 = 30.0;
const CHIP_OFFSET_SCALE: f32 = MARKER_SIZE / 46.0;
const MOVE_MIN_MS: f32 = 140.0;
const MOVE_MAX_MS: f32 = 420.0;
const MOVE_MS_PER_PIXEL: f32 = 0.20;
const MOVE_CURVE_MAX_PX: f32 = 32.0;
const EYE_BLINK_MIN_MS: u64 = 2000;
const EYE_BLINK_MAX_MS: u64 = 5000;
const BUBBLE_FADE_IN_MS: f32 = 220.0;
const BUBBLE_HOLD_MS: f32 = 2900.0;
const BUBBLE_FADE_OUT_MS: f32 = 700.0;
const BUBBLE_TOTAL_MS: f32 = BUBBLE_FADE_IN_MS + BUBBLE_HOLD_MS + BUBBLE_FADE_OUT_MS;
const BUBBLE_MAX_CHARS: usize = 48;
const ACTION_CUE_MS: u64 = 280;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb(pub u8, pub u8, pub u8);

#[derive(Clone, Debug)]
pub struct Bubble {
    pub text: String,
    pub started_at: Instant,
}

/// Flatten chat text to one compact line and cap it before rendering. DirectWrite
/// applies a second width-aware ellipsis so unusually wide glyphs still fit.
pub fn normalize_bubble_text(text: &str) -> String {
    let line = text.chars().map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = line.chars();
    let bounded = chars.by_ref().take(BUBBLE_MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        let mut shortened = bounded.chars().take(BUBBLE_MAX_CHARS - 1).collect::<String>();
        shortened.push('…');
        shortened
    } else { bounded }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BubblePlacement {
    pub left: f32,
    pub top: f32,
    pub tail_tip_x: f32,
    pub tail_tip_y: f32,
}

/// Place the bubble over the marker with its tail aimed at the live marker
/// position. This is evaluated from the animated marker coordinates every frame.
pub fn bubble_placement(cursor_x: f32, cursor_y: f32, bubble_height: f32) -> BubblePlacement {
    BubblePlacement {
        left: cursor_x - 5.0,
        top: cursor_y - bubble_height - 14.0,
        tail_tip_x: cursor_x + 17.0,
        tail_tip_y: cursor_y + 18.0,
    }
}

pub fn bubble_ink_color(fill: Rgb) -> Rgb {
    let linear = |channel: u8| {
        let value = channel as f32 / 255.0;
        if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
    };
    let luminance = 0.2126 * linear(fill.0) + 0.7152 * linear(fill.1) + 0.0722 * linear(fill.2);
    if luminance > 0.42 { Rgb(22, 24, 28) } else { Rgb(255, 255, 255) }
}

#[derive(Clone, Debug)]
pub struct AgentState {
    pub x: f32,
    pub y: f32,
    pub target_x: f32,
    pub target_y: f32,
    pub anim_from_x: f32,
    pub anim_from_y: f32,
    pub anim_control_x: f32,
    pub anim_control_y: f32,
    pub anim_duration_ms: f32,
    pub anim_start: Instant,
    pub color: Rgb,
    pub dark: Rgb,
    pub label: String,
    pub next_blink_at: Instant,
    pub blink_until: Option<Instant>,
    pub bubble: Option<Bubble>,
    pub action_cue_at: Option<Instant>,
}

/// Eased position along the current cursor glide. Uses monotonic time so
/// system-clock changes cannot jump a rendered cursor.
pub fn animated_position(agent: &AgentState, now: Instant) -> (f32, f32) {
    let elapsed_ms = now
        .saturating_duration_since(agent.anim_start)
        .as_secs_f32()
        * 1000.0;
    if elapsed_ms >= agent.anim_duration_ms || agent.anim_duration_ms <= 0.0 {
        return (agent.target_x, agent.target_y);
    }
    let t = ease_out_cubic((elapsed_ms / agent.anim_duration_ms).clamp(0.0, 1.0));
    let inverse = 1.0 - t;
    (
        inverse * inverse * agent.anim_from_x
            + 2.0 * inverse * t * agent.anim_control_x
            + t * t * agent.target_x,
        inverse * inverse * agent.anim_from_y
            + 2.0 * inverse * t * agent.anim_control_y
            + t * t * agent.target_y,
    )
}

fn movement_profile(from_x: f32, from_y: f32, to_x: f32, to_y: f32) -> (f32, f32, f32) {
    let dx = to_x - from_x;
    let dy = to_y - from_y;
    let distance = dx.hypot(dy);
    let duration_ms =
        (MOVE_MIN_MS + distance * MOVE_MS_PER_PIXEL).clamp(MOVE_MIN_MS, MOVE_MAX_MS);
    if distance < 1.0 {
        return ((from_x + to_x) * 0.5, (from_y + to_y) * 0.5, duration_ms);
    }

    // A shallow, deterministic quadratic arc keeps long moves from reading as
    // a straight-line teleport while preserving the exact target endpoint.
    // Choose the side from the target pair so repeat runs remain reproducible.
    let side = if (to_x.round() as i32 ^ to_y.round() as i32) & 1 == 0 {
        1.0
    } else {
        -1.0
    };
    let curve = (distance * 0.055).min(MOVE_CURVE_MAX_PX) * side;
    let midpoint_x = (from_x + to_x) * 0.5;
    let midpoint_y = (from_y + to_y) * 0.5;
    let perpendicular_x = -dy / distance;
    let perpendicular_y = dx / distance;
    (
        midpoint_x + perpendicular_x * curve,
        midpoint_y + perpendicular_y * curve,
        duration_ms,
    )
}

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

pub type SharedState = Arc<Mutex<HashMap<String, AgentState>>>;

fn darken(c: Rgb, factor: f32) -> Rgb {
    Rgb(
        (c.0 as f32 * factor) as u8,
        (c.1 as f32 * factor) as u8,
        (c.2 as f32 * factor) as u8,
    )
}

fn parse_color(value: Option<&Value>) -> Option<Rgb> {
    let arr = value?.as_array()?;
    if arr.len() != 3 {
        return None;
    }
    let get = |i: usize| arr.get(i)?.as_u64().map(|v| v.min(255) as u8);
    Some(Rgb(get(0)?, get(1)?, get(2)?))
}

/// Apply one parsed stdin command to shared state. Returns true if the
/// command was recognized (used only for diagnostics; malformed/unknown
/// commands are otherwise silently ignored -- this is a presentation-only
/// channel and must never crash the process over a bad line).
pub fn apply_command(state: &SharedState, line: &str) -> bool {
    apply_command_at(state, line, Instant::now())
}

/// Deterministic clock seam for movement tests; production uses `apply_command`.
pub fn apply_command_at(state: &SharedState, line: &str, now: Instant) -> bool {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let cmd = value.get("cmd").and_then(Value::as_str).unwrap_or("");
    let id = match value.get("id").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return false,
    };
    let mut guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
    if matches!(cmd, "upsert" | "say" | "hide") {
        PRESENTATION_DIRTY.store(true, Ordering::Release);
    }
    match cmd {
        "upsert" => {
            let x = value.get("x").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let y = value.get("y").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let color = parse_color(value.get("color")).unwrap_or(Rgb(200, 200, 200));
            let label = value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let dark = darken(color, 0.62);
            let has_action_cue = matches!(value.get("cue").and_then(Value::as_str), Some("edit" | "click"));
            guard
                .entry(id)
                .and_modify(|a| {
                    if a.target_x != x || a.target_y != y {
                        let (current_x, current_y) = animated_position(a, now);
                        let (control_x, control_y, duration_ms) =
                            movement_profile(current_x, current_y, x, y);
                        a.x = current_x;
                        a.y = current_y;
                        a.anim_from_x = current_x;
                        a.anim_from_y = current_y;
                        a.anim_control_x = control_x;
                        a.anim_control_y = control_y;
                        a.anim_duration_ms = duration_ms;
                        a.target_x = x;
                        a.target_y = y;
                        a.anim_start = now;
                        a.action_cue_at = None;
                    }
                    if has_action_cue {
                        let arrival = a.anim_start + Duration::from_secs_f32(a.anim_duration_ms / 1000.0);
                        a.action_cue_at = Some(now.max(arrival));
                    }
                    a.color = color;
                    a.dark = dark;
                    a.label = label.clone();
                })
                .or_insert_with(|| AgentState {
                    x,
                    y,
                    target_x: x,
                    target_y: y,
                    anim_from_x: x,
                    anim_from_y: y,
                    anim_control_x: x,
                    anim_control_y: y,
                    anim_duration_ms: 0.0,
                    anim_start: now,
                    color,
                    dark,
                    label,
                    next_blink_at: now + Duration::from_millis(EYE_BLINK_MIN_MS),
                    blink_until: None,
                    bubble: None,
                    action_cue_at: has_action_cue.then_some(now),
                });
        }
        "say" => {
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .map(normalize_bubble_text)
                .unwrap_or_default();
            if let Some(agent) = guard.get_mut(&id) {
                agent.bubble = Some(Bubble {
                    text,
                    started_at: now,
                });
            }
        }
        "hide" => {
            guard.remove(&id);
        }
        _ => return false,
    }
    true
}

/// Bubble opacity (0..1) at the given elapsed time since it started speaking,
/// following fade-in / hold / fade-out. Returns None once it should be
/// removed entirely.
pub fn bubble_opacity(elapsed_ms: f32) -> Option<f32> {
    if elapsed_ms >= BUBBLE_TOTAL_MS {
        return None;
    }
    if elapsed_ms < BUBBLE_FADE_IN_MS {
        return Some((elapsed_ms / BUBBLE_FADE_IN_MS).clamp(0.0, 1.0));
    }
    if elapsed_ms < BUBBLE_FADE_IN_MS + BUBBLE_HOLD_MS {
        return Some(1.0);
    }
    let into_fade = elapsed_ms - BUBBLE_FADE_IN_MS - BUBBLE_HOLD_MS;
    Some((1.0 - into_fade / BUBBLE_FADE_OUT_MS).clamp(0.0, 1.0))
}

/// A bubble needs continuous frames only while its opacity changes. During
/// the hold interval, the existing frame remains correct unless the marker
/// itself is moving (which is tracked separately by the caller).
fn bubble_animating(bubble: &Bubble, now: Instant, last_presented: Instant) -> bool {
    let elapsed_ms = now.saturating_duration_since(bubble.started_at).as_secs_f32() * 1000.0;
    // Paint the fully opaque endpoint even if the timer skipped the boundary.
    last_presented.saturating_duration_since(bubble.started_at).as_secs_f32() * 1000.0 < BUBBLE_FADE_IN_MS
        || (elapsed_ms >= BUBBLE_FADE_IN_MS + BUBBLE_HOLD_MS && elapsed_ms < BUBBLE_TOTAL_MS)
}

/// Raw marker outline in the preview's 100x100 viewBox space. The body is
/// this polygon filled AND stroked 22 units wide with round joins, which is
/// what turns four sharp corners into the thick rounded paper-plane blob.
const FLAG_POINTS: [(f32, f32); 4] = [(20.0, 18.0), (86.0, 50.0), (56.0, 58.0), (42.0, 86.0)];
const FLAG_STROKE: f32 = 22.0;
/// Face tilt in degrees (Direct2D: positive = clockwise in y-down space).
/// The tip points up-left, so the face is rotated counter-clockwise so its
/// "up" leans toward the tip and the eye line follows the body's diagonal.
const FACE_TILT_DEG: f32 = -22.0;
/// Pivot of the face cluster in viewBox space (between eyes and mouth).
const FACE_PIVOT: (f32, f32) = (48.0, 52.0);

/// Window creation, Direct2D/DirectWrite drawing, and the stdin-driven live
/// loop (Windows-only, used by `--spawn-cursor-overlay`). The same
/// `Renderer::render` is used by the live window and by the file-based
/// self-test so the two paths can never visually drift apart.
#[cfg(windows)]
pub mod win {
    use super::*;
    use std::mem::ManuallyDrop;
    use windows::core::{w, Interface, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
    use windows::Win32::Graphics::Direct2D::Common::{
        D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_BEZIER_SEGMENT, D2D1_COLOR_F, D2D1_FILL_MODE_ALTERNATE, D2D1_COMPOSITE_MODE_SOURCE_OVER,
        D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_BEGIN_HOLLOW, D2D1_FIGURE_END_CLOSED,
        D2D1_FIGURE_END_OPEN, D2D1_PIXEL_FORMAT, D2D_RECT_F, D2D_SIZE_F,
    };
    use windows::Win32::Graphics::Direct2D::{
        D2D1CreateFactory, ID2D1Brush, ID2D1DCRenderTarget, ID2D1DeviceContext, ID2D1Factory,
        ID2D1Layer, ID2D1PathGeometry, ID2D1RenderTarget, ID2D1StrokeStyle,
        CLSID_D2D1GaussianBlur, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1_CAP_STYLE_ROUND,
        D2D1_COMPATIBLE_RENDER_TARGET_OPTIONS_NONE, D2D1_DASH_STYLE_SOLID,
        D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_ELLIPSE, D2D1_FACTORY_TYPE_SINGLE_THREADED,
        D2D1_FEATURE_LEVEL_DEFAULT, D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION,
        D2D1_INTERPOLATION_MODE_LINEAR, D2D1_LAYER_OPTIONS_NONE, D2D1_LAYER_PARAMETERS,
        D2D1_LINE_JOIN_ROUND, D2D1_PROPERTY_TYPE_FLOAT, D2D1_QUADRATIC_BEZIER_SEGMENT,
        D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_DEFAULT,
        D2D1_RENDER_TARGET_USAGE_NONE, D2D1_ROUNDED_RECT, D2D1_STROKE_STYLE_PROPERTIES,
        D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE,
    };
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteTextFormat,
        IDWriteTextLayout, DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL,
        DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT, DWRITE_FONT_WEIGHT_NORMAL,
        DWRITE_FONT_WEIGHT_SEMI_BOLD,
        DWRITE_TEXT_METRICS,
        DWRITE_TRIMMING, DWRITE_TRIMMING_GRANULARITY_CHARACTER, DWRITE_WORD_WRAPPING_NO_WRAP,
    };
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, AC_SRC_ALPHA,
        AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, HBITMAP,
        HDC, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        GetSystemMetrics, PostQuitMessage, PostThreadMessageW, RegisterClassW, SetTimer, TranslateMessage,
        UpdateLayeredWindow, MSG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, ULW_ALPHA, WM_DESTROY, WM_QUIT, WM_TIMER, WNDCLASSW, WS_EX_LAYERED,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP, WS_VISIBLE,
        GetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOOWNERZORDER,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows_numerics::{Matrix3x2, Vector2};

    type R<T> = windows::core::Result<T>;

    fn protocol_line(output: &Arc<Mutex<std::io::Stdout>>, value: serde_json::Value) {
        let mut stdout = output.lock().unwrap_or_else(|poison| poison.into_inner());
        let _ = writeln!(stdout, "{value}");
        let _ = stdout.flush();
    }

    // Palette taken from the approved preview's CSS.
    const PANEL: Rgb = Rgb(0x1c, 0x20, 0x26);
    const WHITE: Rgb = Rgb(255, 255, 255);
    const BLACK: Rgb = Rgb(0, 0, 0);

    fn col(c: Rgb, a: f32) -> D2D1_COLOR_F {
        D2D1_COLOR_F { r: c.0 as f32 / 255.0, g: c.1 as f32 / 255.0, b: c.2 as f32 / 255.0, a }
    }
    fn v2(x: f32, y: f32) -> Vector2 {
        Vector2 { X: x, Y: y }
    }
    fn rect(x: f32, y: f32, w: f32, h: f32) -> D2D_RECT_F {
        D2D_RECT_F { left: x, top: y, right: x + w, bottom: y + h }
    }
    fn rrect(x: f32, y: f32, w: f32, h: f32, r: f32) -> D2D1_ROUNDED_RECT {
        D2D1_ROUNDED_RECT { rect: rect(x, y, w, h), radiusX: r, radiusY: r }
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    // Provider logos (pill/src/assets/providers/*.svg, viewBox 0 0 24 24, evenodd).
    #[allow(dead_code)]
    const LOGO_CLAUDE_D: &str = "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";
    #[allow(dead_code)]
    const LOGO_CODEX_D: &str = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
    #[allow(dead_code)]
    const LOGO_OPENCODE_D: &str = "M16 6H8v12h8V6zm4 16H4V2h16v20z";

    /// Minimal SVG path-data tokenizer (numbers, single-char arc flags).
    struct PathLexer<'a> {
        s: &'a [u8],
        i: usize,
    }
    impl<'a> PathLexer<'a> {
        fn skip_sep(&mut self) {
            while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b',' | b'\t' | b'\n' | b'\r') {
                self.i += 1;
            }
        }
        /// Next command letter, if one is next (after separators).
        fn peek_cmd(&mut self) -> Option<u8> {
            self.skip_sep();
            self.s.get(self.i).copied().filter(|c| c.is_ascii_alphabetic() && *c != b'e' && *c != b'E')
        }
        fn at_end(&mut self) -> bool {
            self.skip_sep();
            self.i >= self.s.len()
        }
        fn num(&mut self) -> Option<f32> {
            self.skip_sep();
            let start = self.i;
            let s = self.s;
            if self.i < s.len() && matches!(s[self.i], b'+' | b'-') {
                self.i += 1;
            }
            let mut digits = false;
            while self.i < s.len() && s[self.i].is_ascii_digit() {
                self.i += 1;
                digits = true;
            }
            if self.i < s.len() && s[self.i] == b'.' {
                self.i += 1;
                while self.i < s.len() && s[self.i].is_ascii_digit() {
                    self.i += 1;
                    digits = true;
                }
            }
            if !digits {
                self.i = start;
                return None;
            }
            if self.i < s.len() && matches!(s[self.i], b'e' | b'E') {
                let save = self.i;
                self.i += 1;
                if self.i < s.len() && matches!(s[self.i], b'+' | b'-') {
                    self.i += 1;
                }
                let ds = self.i;
                while self.i < s.len() && s[self.i].is_ascii_digit() {
                    self.i += 1;
                }
                if ds == self.i {
                    self.i = save;
                }
            }
            std::str::from_utf8(&s[start..self.i]).ok()?.parse().ok()
        }
        /// Arc flag: exactly one '0' or '1' character.
        fn flag(&mut self) -> Option<bool> {
            self.skip_sep();
            let c = *self.s.get(self.i)?;
            match c {
                b'0' | b'1' => {
                    self.i += 1;
                    Some(c == b'1')
                }
                _ => None,
            }
        }
    }

    /// Elliptical arc (SVG endpoint form) -> cubic Beziers, each <= 90 degrees.
    fn arc_to_beziers(p0: (f32, f32), rx: f32, ry: f32, phi_deg: f32, large: bool, sweep: bool, p1: (f32, f32), out: &mut Vec<[(f32, f32); 3]>) {
        let (x1, y1) = (p0.0 as f64, p0.1 as f64);
        let (x2, y2) = (p1.0 as f64, p1.1 as f64);
        let mut rx = (rx as f64).abs();
        let mut ry = (ry as f64).abs();
        if x1 == x2 && y1 == y2 {
            return;
        }
        if rx == 0.0 || ry == 0.0 {
            out.push([p0, p1, p1]);
            return;
        }
        let phi = (phi_deg as f64).to_radians();
        let (sp, cp) = phi.sin_cos();
        let dx = (x1 - x2) / 2.0;
        let dy = (y1 - y2) / 2.0;
        let x1p = cp * dx + sp * dy;
        let y1p = -sp * dx + cp * dy;
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if lambda > 1.0 {
            let s = lambda.sqrt();
            rx *= s;
            ry *= s;
        }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        let mut coef = if den == 0.0 { 0.0 } else { (num / den).max(0.0).sqrt() };
        if large == sweep {
            coef = -coef;
        }
        let cxp = coef * rx * y1p / ry;
        let cyp = -coef * ry * x1p / rx;
        let cx = cp * cxp - sp * cyp + (x1 + x2) / 2.0;
        let cy = sp * cxp + cp * cyp + (y1 + y2) / 2.0;
        let ang = |ux: f64, uy: f64, vx: f64, vy: f64| -> f64 {
            let a = (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
            a
        };
        let ux = (x1p - cxp) / rx;
        let uy = (y1p - cyp) / ry;
        let vx = (-x1p - cxp) / rx;
        let vy = (-y1p - cyp) / ry;
        let theta1 = ang(1.0, 0.0, ux, uy);
        let mut dtheta = ang(ux, uy, vx, vy);
        if !sweep && dtheta > 0.0 {
            dtheta -= std::f64::consts::TAU;
        } else if sweep && dtheta < 0.0 {
            dtheta += std::f64::consts::TAU;
        }
        let segs = (dtheta.abs() / std::f64::consts::FRAC_PI_2 - 1e-9).ceil().max(1.0) as usize;
        let delta = dtheta / segs as f64;
        let k = 4.0 / 3.0 * (delta / 4.0).tan();
        let pt = |t: f64| -> (f64, f64) {
            let (st, ct) = t.sin_cos();
            (cx + rx * ct * cp - ry * st * sp, cy + rx * ct * sp + ry * st * cp)
        };
        let deriv = |t: f64| -> (f64, f64) {
            let (st, ct) = t.sin_cos();
            (-rx * st * cp - ry * ct * sp, -rx * st * sp + ry * ct * cp)
        };
        let mut t = theta1;
        for n in 0..segs {
            let t2 = t + delta;
            let a = pt(t);
            let b = if n + 1 == segs { (x2, y2) } else { pt(t2) };
            let da = deriv(t);
            let db = deriv(t2);
            let c1 = (a.0 + k * da.0, a.1 + k * da.1);
            let c2 = (b.0 - k * db.0, b.1 - k * db.1);
            out.push([(c1.0 as f32, c1.1 as f32), (c2.0 as f32, c2.1 as f32), (b.0 as f32, b.1 as f32)]);
            t = t2;
        }
    }

    /// Build an evenodd-filled path geometry from SVG path data
    /// (supports M L H V C A Z, absolute and relative, implicit repeats).
    fn svg_path_geometry(factory: &ID2D1Factory, d: &str) -> R<ID2D1PathGeometry> {
        unsafe {
            let geom = factory.CreatePathGeometry()?;
            let sink = geom.Open()?;
            sink.SetFillMode(D2D1_FILL_MODE_ALTERNATE);
            let mut lx = PathLexer { s: d.as_bytes(), i: 0 };
            let (mut cur, mut start) = ((0.0f32, 0.0f32), (0.0f32, 0.0f32));
            let mut open = false;
            let mut cmd = 0u8;
            let mut arcs: Vec<[(f32, f32); 3]> = Vec::new();
            macro_rules! n {
                () => {
                    match lx.num() {
                        Some(v) => v,
                        None => break,
                    }
                };
            }
            while !lx.at_end() {
                if let Some(c) = lx.peek_cmd() {
                    cmd = c;
                    lx.i += 1;
                    if c == b'z' || c == b'Z' {
                        if open {
                            sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                            open = false;
                        }
                        cur = start;
                        continue;
                    }
                } else if cmd == 0 || cmd == b'z' || cmd == b'Z' {
                    break; // malformed: numbers without a command
                }
                let rel = cmd.is_ascii_lowercase();
                let (ox, oy) = if rel { cur } else { (0.0, 0.0) };
                match cmd.to_ascii_uppercase() {
                    b'M' => {
                        let x = n!() + ox;
                        let y = n!() + oy;
                        if open {
                            sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                        }
                        sink.BeginFigure(v2(x, y), D2D1_FIGURE_BEGIN_FILLED);
                        open = true;
                        cur = (x, y);
                        start = cur;
                        // Subsequent pairs are implicit lineto.
                        cmd = if rel { b'l' } else { b'L' };
                    }
                    b'L' => {
                        let x = n!() + ox;
                        let y = n!() + oy;
                        sink.AddLine(v2(x, y));
                        cur = (x, y);
                    }
                    b'H' => {
                        let x = n!() + ox;
                        sink.AddLine(v2(x, cur.1));
                        cur.0 = x;
                    }
                    b'V' => {
                        let y = n!() + oy;
                        sink.AddLine(v2(cur.0, y));
                        cur.1 = y;
                    }
                    b'C' => {
                        let (x1, y1, x2, y2, x, y) = (n!() + ox, n!() + oy, n!() + ox, n!() + oy, n!() + ox, n!() + oy);
                        sink.AddBezier(&D2D1_BEZIER_SEGMENT { point1: v2(x1, y1), point2: v2(x2, y2), point3: v2(x, y) });
                        cur = (x, y);
                    }
                    b'A' => {
                        let rx = n!();
                        let ry = n!();
                        let rot = n!();
                        let large = match lx.flag() { Some(f) => f, None => break };
                        let sweep = match lx.flag() { Some(f) => f, None => break };
                        let x = n!() + ox;
                        let y = n!() + oy;
                        arcs.clear();
                        arc_to_beziers(cur, rx, ry, rot, large, sweep, (x, y), &mut arcs);
                        for b in &arcs {
                            sink.AddBezier(&D2D1_BEZIER_SEGMENT { point1: v2(b[0].0, b[0].1), point2: v2(b[1].0, b[1].1), point3: v2(b[2].0, b[2].1) });
                        }
                        cur = (x, y);
                    }
                    _ => break, // unsupported command
                }
            }
            if open {
                sink.EndFigure(D2D1_FIGURE_END_CLOSED);
            }
            sink.Close()?;
            Ok(geom)
        }
    }

    struct TextBox {
        layout: IDWriteTextLayout,
        w: f32,
        h: f32,
    }

    /// Long-lived Direct2D/DirectWrite state. Geometry, stroke styles and
    /// text formats are device-independent and built once; brushes are
    /// cheap and created per draw against the bound DC render target.
    pub(crate) struct Renderer {
        dwrite: IDWriteFactory,
        rt: ID2D1DCRenderTarget,
        /// Same object as `rt`, queried for the Direct2D 1.1 effect API
        /// (Gaussian blur for soft drop shadows). None on pre-Win8.
        dc: Option<ID2D1DeviceContext>,
        flag: ID2D1PathGeometry,
        highlight: ID2D1PathGeometry,
        mouth: ID2D1PathGeometry,
        bubble_tail: ID2D1PathGeometry,
        round: ID2D1StrokeStyle,
        fmt_chip: IDWriteTextFormat,
        fmt_msg: IDWriteTextFormat,
    }

    impl Renderer {
        pub(crate) fn new() -> R<Self> {
            unsafe {
                let factory: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
                let dwrite: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
                let props = D2D1_RENDER_TARGET_PROPERTIES {
                    r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                    pixelFormat: D2D1_PIXEL_FORMAT {
                        format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                    },
                    dpiX: 96.0,
                    dpiY: 96.0,
                    usage: D2D1_RENDER_TARGET_USAGE_NONE,
                    minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
                };
                let rt = factory.CreateDCRenderTarget(&props)?;
                let dc = rt.cast::<ID2D1DeviceContext>().ok();

                // Marker body polygon.
                let flag = factory.CreatePathGeometry()?;
                {
                    let sink = flag.Open()?;
                    sink.BeginFigure(v2(FLAG_POINTS[0].0, FLAG_POINTS[0].1), D2D1_FIGURE_BEGIN_FILLED);
                    for p in &FLAG_POINTS[1..] {
                        sink.AddLine(v2(p.0, p.1));
                    }
                    sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                    sink.Close()?;
                }
                // Soft top highlight: "M17 22 Q20 12 30 16 L60 31".
                let highlight = factory.CreatePathGeometry()?;
                {
                    let sink = highlight.Open()?;
                    sink.BeginFigure(v2(17.0, 22.0), D2D1_FIGURE_BEGIN_HOLLOW);
                    sink.AddQuadraticBezier(&D2D1_QUADRATIC_BEZIER_SEGMENT { point1: v2(20.0, 12.0), point2: v2(30.0, 16.0) });
                    sink.AddLine(v2(60.0, 31.0));
                    sink.EndFigure(D2D1_FIGURE_END_OPEN);
                    sink.Close()?;
                }
                // Smile: "M40 58 Q48 68 56 58".
                let mouth = factory.CreatePathGeometry()?;
                {
                    let sink = mouth.Open()?;
                    sink.BeginFigure(v2(40.0, 58.0), D2D1_FIGURE_BEGIN_HOLLOW);
                    sink.AddQuadraticBezier(&D2D1_QUADRATIC_BEZIER_SEGMENT { point1: v2(48.0, 68.0), point2: v2(56.0, 58.0) });
                    sink.EndFigure(D2D1_FIGURE_END_OPEN);
                    sink.Close()?;
                }
                let round = factory.CreateStrokeStyle(
                    &D2D1_STROKE_STYLE_PROPERTIES {
                        startCap: D2D1_CAP_STYLE_ROUND,
                        endCap: D2D1_CAP_STYLE_ROUND,
                        dashCap: D2D1_CAP_STYLE_ROUND,
                        lineJoin: D2D1_LINE_JOIN_ROUND,
                        miterLimit: 10.0,
                        dashStyle: D2D1_DASH_STYLE_SOLID,
                        dashOffset: 0.0,
                    },
                    None,
                )?;

                let fmt = |weight: DWRITE_FONT_WEIGHT, size: f32| -> R<IDWriteTextFormat> {
                    dwrite.CreateTextFormat(
                        w!("Segoe UI"),
                        None::<&IDWriteFontCollection>,
                        weight,
                        DWRITE_FONT_STYLE_NORMAL,
                        DWRITE_FONT_STRETCH_NORMAL,
                        size,
                        w!("en-us"),
                    )
                };
                let fmt_chip = fmt(DWRITE_FONT_WEIGHT_SEMI_BOLD, 12.0)?;
                fmt_chip.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
                let fmt_msg = fmt(DWRITE_FONT_WEIGHT_NORMAL, 13.0)?;
                fmt_msg.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
                let bubble_tail = svg_path_geometry(&factory, "M 0 0 L 30 0 L 14 32 Z")?;

                Ok(Self { dwrite, rt, dc, flag, highlight, mouth, bubble_tail, round, fmt_chip, fmt_msg })
            }
        }

        fn text(&self, s: &str, fmt: &IDWriteTextFormat, max_w: f32, max_h: f32) -> R<TextBox> {
            unsafe {
                let layout = self.dwrite.CreateTextLayout(&wide(s), fmt, max_w, max_h)?;
                let mut m = DWRITE_TEXT_METRICS::default();
                layout.GetMetrics(&mut m)?;
                Ok(TextBox { layout, w: m.width, h: m.height })
            }
        }

        /// Render one complete frame of every agent into the DIB selected
        /// into `hdc` (premultiplied BGRA, `w` x `h`).
        pub(crate) fn render(&self, hdc: HDC, w: i32, h: i32, agents: &HashMap<String, AgentState>, now: Instant) -> R<()> {
            unsafe {
                self.rt.BindDC(hdc, &RECT { left: 0, top: 0, right: w, bottom: h })?;
                self.rt.BeginDraw();
                self.rt.SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
                // Grayscale text AA: ClearType cannot be composited onto a
                // transparent layered surface without color fringing.
                self.rt.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
                self.rt.SetTransform(&Matrix3x2::identity());
                self.rt.Clear(Some(&col(BLACK, 0.0)));
                // Stable z-order regardless of HashMap iteration order.
                let mut ids: Vec<&String> = agents.keys().collect();
                ids.sort();
                let mut result = Ok(());
                for id in ids {
                    if let Err(e) = self.draw_agent(&agents[id], now) {
                        result = Err(e);
                        break;
                    }
                }
                self.rt.SetTransform(&Matrix3x2::identity());
                let end = self.rt.EndDraw(None, None);
                result.and(end)
            }
        }

        /// Blurred silhouette shadow: draws `shape` in black into a small
        /// offscreen bitmap covering `bounds` (+3 sigma padding), runs the
        /// Direct2D Gaussian blur effect over it, and composites the result
        /// at `offset` under whatever is drawn next.
        fn shadow(&self, bounds: (f32, f32, f32, f32), sigma: f32, offset: (f32, f32), alpha: f32, shape: impl Fn(&ID2D1RenderTarget, Matrix3x2, &ID2D1Brush) -> R<()>) -> R<()> {
            let Some(dc) = &self.dc else { return Ok(()) };
            unsafe {
                let pad = (sigma * 3.0).ceil();
                let (bx, by) = (bounds.0.floor() - pad, bounds.1.floor() - pad);
                let size = D2D_SIZE_F { width: (bounds.2 + pad * 2.0 + 2.0).ceil(), height: (bounds.3 + pad * 2.0 + 2.0).ceil() };
                let bt = self.rt.CreateCompatibleRenderTarget(Some(&size), None, None, D2D1_COMPATIBLE_RENDER_TARGET_OPTIONS_NONE)?;
                bt.BeginDraw();
                bt.Clear(Some(&col(BLACK, 0.0)));
                let brush = bt.CreateSolidColorBrush(&col(BLACK, alpha), None)?;
                let target: &ID2D1RenderTarget = &bt;
                let drawn = shape(target, Matrix3x2::translation(-bx, -by), &brush.cast()?);
                bt.EndDraw(None, None)?;
                drawn?;
                let bitmap = bt.GetBitmap()?;
                let blur = dc.CreateEffect(&CLSID_D2D1GaussianBlur)?;
                blur.SetInput(0, &bitmap, true);
                blur.SetValue(D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION.0 as u32, D2D1_PROPERTY_TYPE_FLOAT, &sigma.to_le_bytes())?;
                let out = blur.GetOutput()?;
                self.rt.SetTransform(&Matrix3x2::identity());
                dc.DrawImage(&out, Some(&v2(bx + offset.0, by + offset.1)), None, D2D1_INTERPOLATION_MODE_LINEAR, D2D1_COMPOSITE_MODE_SOURCE_OVER);
                Ok(())
            }
        }

        fn fill_flag(&self, t: &ID2D1RenderTarget, m: Matrix3x2, brush: &ID2D1Brush) {
            unsafe {
                t.SetTransform(&m);
                t.FillGeometry(&self.flag, brush, None::<&ID2D1Brush>);
                t.DrawGeometry(&self.flag, brush, FLAG_STROKE, &self.round);
            }
        }

        fn draw_agent(&self, agent: &AgentState, now: Instant) -> R<()> {
            unsafe {
                let rt: &ID2D1RenderTarget = &self.rt;
                let (ox, oy) = (agent.x, agent.y);
                if let Some(start) = agent.action_cue_at.filter(|start| *start <= now) {
                    let t = (now.saturating_duration_since(start).as_secs_f32() * 1000.0 / ACTION_CUE_MS as f32).min(1.0);
                    if t < 1.0 {
                        rt.SetTransform(&Matrix3x2::identity());
                        let ink = rt.CreateSolidColorBrush(&col(agent.color, 0.65 * (1.0 - t)), None)?;
                        let radius = 5.0 + 13.0 * t;
                        rt.DrawEllipse(&D2D1_ELLIPSE { point: v2(ox, oy), radiusX: radius, radiusY: radius },
                            &ink, 2.0, None::<&ID2D1StrokeStyle>);
                    }
                }
                let s = MARKER_SIZE / 100.0;
                let base = Matrix3x2::scale(s, s) * Matrix3x2::translation(ox, oy);
                let under = Matrix3x2::translation(3.0, 6.0) * base;

                // --- marker -------------------------------------------------
                // drop-shadow(0 6px 10px rgba(0,0,0,.35)) of body + underside.
                self.shadow((ox, oy, MARKER_SIZE + 4.0, MARKER_SIZE + 6.0), 5.0, (0.0, 6.0), 0.35, |t, shift, b| {
                    self.fill_flag(t, under * shift, b);
                    self.fill_flag(t, base * shift, b);
                    Ok(())
                })?;
                let dark = rt.CreateSolidColorBrush(&col(agent.dark, 1.0), None)?;
                let body = rt.CreateSolidColorBrush(&col(agent.color, 1.0), None)?;
                self.fill_flag(rt, under, &dark.cast()?);
                self.fill_flag(rt, base, &body.cast()?);
                let hl = rt.CreateSolidColorBrush(&col(WHITE, 0.22), None)?;
                rt.SetTransform(&base);
                rt.DrawGeometry(&self.highlight, &hl, 5.0, &self.round);

                // --- face, tilted along the marker's diagonal ---------------
                let white = rt.CreateSolidColorBrush(&col(WHITE, 1.0), None)?;
                let tilt = Matrix3x2::rotation_around(FACE_TILT_DEG, v2(FACE_PIVOT.0, FACE_PIVOT.1)) * base;
                let blinking = agent.blink_until.map(|u| now < u).unwrap_or(false);
                let squash = if blinking { 0.1 } else { 1.0 };
                rt.SetTransform(&(Matrix3x2::scale_around(1.0, squash, v2(48.0, 45.0)) * tilt));
                for cx in [39.0, 57.0] {
                    rt.FillEllipse(&D2D1_ELLIPSE { point: v2(cx, 45.0), radiusX: 3.6, radiusY: 4.8 }, &white);
                }
                // Talking: while a bubble is visible, the smile's belly
                // drops open and snaps shut (~5.5x/sec), easing out with
                // the bubble's fade. Corners (y=58) stay anchored.
                let talk_scale = agent
                    .bubble
                    .as_ref()
                    .and_then(|b| {
                        let ms = now.saturating_duration_since(b.started_at).as_millis() as f32;
                        bubble_opacity(ms).map(|o| 1.0 + 0.6 * o * (ms * std::f32::consts::PI / 180.0).sin().abs())
                    })
                    .unwrap_or(1.0);
                rt.SetTransform(&(Matrix3x2::scale_around(1.0, talk_scale, v2(48.0, 58.0)) * tilt));
                rt.DrawGeometry(&self.mouth, &white, 4.0, &self.round);
                rt.SetTransform(&Matrix3x2::identity());

                // --- label chip ---------------------------------------------
                let chip_x = ox + 30.0 * CHIP_OFFSET_SCALE;
                let chip_y = oy + 44.0 * CHIP_OFFSET_SCALE;
                let label = self.text(&agent.label, &self.fmt_chip, 400.0, 40.0)?;
                let chip_w = (label.w + 20.0).ceil();
                let chip_h = (label.h + 9.0).round();
                let chip = rrect(chip_x, chip_y, chip_w, chip_h, chip_h / 2.0);
                self.shadow((chip_x, chip_y, chip_w, chip_h), 7.0, (0.0, 6.0), 0.25, |t, shift, b| {
                    t.SetTransform(&shift);
                    t.FillRoundedRectangle(&chip, b);
                    Ok(())
                })?;
                rt.SetTransform(&Matrix3x2::identity());
                // No backdrop blur is possible on a layered window (we never
                // see the desktop pixels), so a darker panel base under the
                // 30% agent tint stands in for the frosted look and keeps
                // white text legible on any background.
                let chip_base = rt.CreateSolidColorBrush(&col(PANEL, 0.55), None)?;
                let chip_tint = rt.CreateSolidColorBrush(&col(agent.color, 0.34), None)?;
                let chip_edge = rt.CreateSolidColorBrush(&col(agent.color, 0.75), None)?;
                rt.FillRoundedRectangle(&chip, &chip_base);
                rt.FillRoundedRectangle(&chip, &chip_tint);
                let edge = rrect(chip_x + 0.5, chip_y + 0.5, chip_w - 1.0, chip_h - 1.0, (chip_h - 1.0) / 2.0);
                rt.DrawRoundedRectangle(&edge, &chip_edge, 1.0, None::<&ID2D1StrokeStyle>);
                rt.DrawTextLayout(v2(chip_x + 10.0, chip_y + (chip_h - label.h) / 2.0), &label.layout, &white, D2D1_DRAW_TEXT_OPTIONS_NONE);

                // --- chatter bubble -----------------------------------------
                if let Some(bubble) = &agent.bubble {
                    let elapsed = now.saturating_duration_since(bubble.started_at).as_millis() as f32;
                    if let Some(opacity) = bubble_opacity(elapsed) {
                        self.draw_bubble(agent, bubble, opacity)?;
                    }
                }
                Ok(())
            }
        }

        fn draw_bubble(&self, agent: &AgentState, bubble: &Bubble, opacity: f32) -> R<()> {
            unsafe {
                let rt: &ID2D1RenderTarget = &self.rt;
                const PAD_X: f32 = 14.0;
                const PAD_Y: f32 = 10.0;
                const MAX_TEXT_W: f32 = 300.0;
                let msg = self.text(&bubble.text, &self.fmt_msg, MAX_TEXT_W, 40.0)?;
                let ellipsis = self.dwrite.CreateEllipsisTrimmingSign(&self.fmt_msg)?;
                msg.layout.SetTrimming(&DWRITE_TRIMMING {
                    granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                    delimiter: 0,
                    delimiterCount: 0,
                }, &ellipsis)?;
                let bw = (msg.w.min(MAX_TEXT_W) + PAD_X * 2.0).max(64.0).ceil();
                let bh = (msg.h.max(18.0) + PAD_Y * 2.0).ceil();
                let placement = bubble_placement(agent.x, agent.y, bh);
                let bx = placement.left;
                let by = placement.top;
                let card = rrect(bx, by, bw, bh, 12.0);

                // One layer carries the whole card's fade so overlapping
                // pieces (shadow, fill, accent, text) fade as a unit.
                let infinite = D2D_RECT_F { left: -f32::MAX, top: -f32::MAX, right: f32::MAX, bottom: f32::MAX };
                let fade = D2D1_LAYER_PARAMETERS {
                    contentBounds: infinite,
                    geometricMask: ManuallyDrop::new(None),
                    maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                    maskTransform: Matrix3x2::identity(),
                    opacity,
                    opacityBrush: ManuallyDrop::new(None),
                    layerOptions: D2D1_LAYER_OPTIONS_NONE,
                };
                rt.PushLayer(&fade, None::<&ID2D1Layer>);

                let body = (|| -> R<()> {
                    // The speaker's identity color fills both body and tail.
                    // The base is redrawn over the tail seam for one clean shape.
                    let fill = rt.CreateSolidColorBrush(&col(agent.color, 1.0), None)?;
                    rt.SetTransform(&(Matrix3x2::translation(placement.tail_tip_x - 14.0, placement.tail_tip_y - 32.0)));
                    rt.FillGeometry(&self.bubble_tail, &fill, None::<&ID2D1Brush>);
                    rt.SetTransform(&Matrix3x2::identity());
                    rt.FillRoundedRectangle(&card, &fill);
                    let ink = rt.CreateSolidColorBrush(&col(bubble_ink_color(agent.color), 1.0), None)?;
                    rt.DrawTextLayout(v2(bx + PAD_X, by + (bh - msg.h) / 2.0), &msg.layout, &ink, D2D1_DRAW_TEXT_OPTIONS_NONE);
                    Ok(())
                })();
                rt.PopLayer();
                body
            }
        }
    }

    pub(crate) struct DibBuffer {
        hbitmap: HBITMAP,
        hdc: HDC,
        bits: *mut u8,
        w: i32,
        h: i32,
    }

    impl DibBuffer {
        fn pixels(&self) -> &[u8] {
            unsafe { std::slice::from_raw_parts(self.bits, (self.w * self.h * 4) as usize) }
        }
    }

    fn create_dib(w: i32, h: i32) -> DibBuffer {
        unsafe {
            let hdc = CreateCompatibleDC(None);
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let hbitmap = CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
                .expect("creating the cursor-overlay DIB section");
            SelectObject(hdc, HGDIOBJ(hbitmap.0));
            DibBuffer { hbitmap, hdc, bits: bits as *mut u8, w, h }
        }
    }

    impl Drop for DibBuffer {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.hdc);
                let _ = DeleteObject(HGDIOBJ(self.hbitmap.0));
            }
        }
    }

    extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_DESTROY => unsafe {
                PostQuitMessage(0);
                LRESULT(0)
            },
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }

    /// Live, Windows-only overlay: one borderless layered window spanning the
    /// virtual screen, redrawn on a timer, driven entirely by stdin commands
    /// read on a background thread. Never receives input (WS_EX_TRANSPARENT
    /// + WS_EX_NOACTIVATE) and never focuses (WS_EX_NOACTIVATE) -- it cannot
    /// interfere with Cua's or anything else's real input dispatch.
    pub fn run() -> ! {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let output = Arc::new(Mutex::new(std::io::stdout()));
        let pending_acks = Arc::new(Mutex::new(Vec::<u64>::new()));

        unsafe {
            let class_name = w!("M9RCursorOverlay");
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), lpszClassName: class_name, ..Default::default() };
            RegisterClassW(&wc);

            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);

            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class_name,
                PCWSTR::null(),
                // UpdateLayeredWindow paints the backing bitmap but does not
                // make a hidden HWND visible. Keep the own-process marker
                // click-through and non-activating while making it render.
                WS_POPUP | WS_VISIBLE,
                x, y, w, h,
                None, None, None, None,
            )
            .expect("creating the cursor-overlay window");

            let dib = create_dib(w, h);
            let mut renderer = Renderer::new().ok();
            // 33ms (~30fps) under-sampled the 140ms ease-out-cubic move
            // animation (MOVE_ANIM_MS) -- only ~4 redraws across its whole
            // duration, visibly steppy rather than smooth. 16ms (~60fps)
            // matches standard display refresh and the sampling rate the
            // tween curve was designed to be seen at.
            SetTimer(Some(hwnd), 1, 16, None);

            // The reader owns only the presentation command pipe. EOF means
            // the broker has shut down; wake the UI thread so the layered
            // window and process are always reaped instead of orphaned.
            let ui_thread_id = GetCurrentThreadId();
            let reader_state = state.clone();
            let reader_output = output.clone();
            let reader_acks = pending_acks.clone();
            std::thread::spawn(move || {
                let stdin = stdin();
                for line in stdin.lock().lines() {
                    let line = match line { Ok(line) => line, Err(_) => break };
                    if line.trim().is_empty() { continue; }
                    let request_id = serde_json::from_str::<serde_json::Value>(&line).ok()
                        .and_then(|value| value.get("requestId").and_then(serde_json::Value::as_u64));
                    // Lock order matches the presentation thread: requests,
                    // then state. An ACK can only cover the snapshot it painted.
                    let mut requests = reader_acks.lock().unwrap_or_else(|p| p.into_inner());
                    let ok = requests.len() < 256 && apply_command(&reader_state, line.trim());
                    if let Some(request_id) = request_id {
                        if ok {
                            requests.push(request_id);
                        } else {
                            protocol_line(&reader_output, serde_json::json!({ "event": "ack", "requestId": request_id, "ok": false }));
                        }
                    }
                }
                let _ = PostThreadMessageW(ui_thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            });

            let mut message = MSG::default();
            let mut ready_sent = false;
            let mut pending_frame = PendingFrame(true);
            let mut last_presented = Instant::now();
            let mut last_foreground = HWND::default();
            loop {
                let got = GetMessageW(&mut message, None, 0, 0);
                if got.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
                if message.message == WM_TIMER {
                    let now = Instant::now();
                    let mut requests = pending_acks.lock().unwrap_or_else(|p| p.into_inner());
                    // Expire finished bubbles and advance blink timers without
                    // holding the lock across the (possibly slower) render.
                    // Consume commands under the same lock as their snapshot.
                    let mut snapshot = presentation_snapshot(&state, &mut pending_frame);
                    let foreground = GetForegroundWindow();
                    if !snapshot.is_empty() && foreground != last_foreground {
                        // Reassert z-order only on a focus transition. This never
                        // activates the overlay, moves it, or changes owner focus.
                        if SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0,
                            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER).is_ok() {
                            last_foreground = foreground;
                        }
                    }
                    if snapshot.is_empty() && !pending_frame.needed(false) {
                        // Idle only after the empty clearing frame was presented.
                        continue;
                    }
                    // `AgentState` stores physical screen coordinates. The
                    // layered window's backing DIB starts at the virtual
                    // desktop origin, which may be negative on multi-monitor
                    // layouts; translate only the render snapshot.
                    for agent in snapshot.values_mut() {
                        let (current_x, current_y) = animated_position(agent, now);
                        agent.x = current_x;
                        agent.y = current_y;
                        agent.x -= x as f32;
                        agent.y -= y as f32;
                    }
                    let mut blink_changed = false;
                    {
                        let mut guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
                        for agent in guard.values_mut() {
                            if now >= agent.next_blink_at && agent.blink_until.is_none() {
                                agent.blink_until = Some(now + Duration::from_millis(100));
                                agent.next_blink_at = now
                                    + Duration::from_millis(
                                        EYE_BLINK_MIN_MS
                                            + (rand_u64() % (EYE_BLINK_MAX_MS - EYE_BLINK_MIN_MS)),
                                    );
                                blink_changed = true;
                            } else if agent.blink_until.map(|u| now >= u).unwrap_or(false) {
                                agent.blink_until = None;
                                blink_changed = true;
                            }
                            if let Some(b) = &agent.bubble {
                                let elapsed = now.duration_since(b.started_at).as_millis() as f32;
                                if bubble_opacity(elapsed).is_none() {
                                    agent.bubble = None;
                                    blink_changed = true;
                                }
                            }
                        }
                    }
                    // Continuous conditions that need every tick redrawn while
                    // true: a position tween still in flight, or a chatter
                    // bubble whose opacity is changing. The static bubble
                    // hold needs no repeated full-screen redraw. Anything else
                    // (idle, blink not yet due, no bubble) only needs a repaint
                    // on the tick something actually changed (blink_changed
                    // above, or an external command via PRESENTATION_DIRTY).
                    let still_animating = snapshot.values().any(|agent| {
                        agent.anim_duration_ms > 0.0
                            && last_presented.saturating_duration_since(agent.anim_start).as_secs_f32() * 1000.0
                                < agent.anim_duration_ms
                    }) || snapshot.values().any(|agent| {
                        agent.bubble.as_ref().is_some_and(|bubble| bubble_animating(bubble, now, last_presented))
                            || agent.action_cue_at.is_some_and(|start|
                                last_presented.saturating_duration_since(start) < Duration::from_millis(ACTION_CUE_MS))
                    });
                    if !pending_frame.needed(blink_changed || still_animating) {
                        continue;
                    }
                    // Animation frames must also survive renderer/blit failure.
                    pending_frame.invalidate(true);
                    if renderer.is_none() {
                        renderer = Renderer::new().ok();
                    }
                    if let Some(r) = &renderer {
                        // Any failure (e.g. D2DERR_RECREATE_TARGET after a
                        // display change) drops the renderer. This previously
                        // just `continue`d silently and waited for the next
                        // tick to rebuild it -- but a tick only fires its
                        // render step when something is dirty/animating
                        // (see the empty-snapshot and !command_dirty &&
                        // !blink_changed && !still_animating skips above), so
                        // a renderer that fails while idle could stay broken
                        // indefinitely with zero visible symptom and zero log
                        // line: upstream upsert/say commands still ack
                        // successfully (that only proves the state map
                        // updated, not that a frame was painted). Log it and
                        // rebuild immediately, in the same tick, instead of
                        // hoping a future tick notices.
                        if r.render(dib.hdc, w, h, &snapshot, now).is_err() {
                            eprintln!("[cursor_overlay] render failed; rebuilding Direct2D target");
                            renderer = Renderer::new().ok();
                            match &renderer {
                                Some(r) if r.render(dib.hdc, w, h, &snapshot, now).is_ok() => {}
                                Some(_) => {
                                    eprintln!("[cursor_overlay] render failed again immediately after rebuild");
                                    renderer = None;
                                    continue;
                                }
                                None => {
                                    eprintln!("[cursor_overlay] failed to recreate Direct2D renderer");
                                    continue;
                                }
                            }
                        }
                    } else {
                        eprintln!("[cursor_overlay] no renderer available for this tick");
                        continue;
                    }

                    let size = SIZE { cx: w, cy: h };
                    let src_pt = POINT { x: 0, y: 0 };
                    let dst_pt = POINT { x, y };
                    let blend = BLENDFUNCTION {
                        BlendOp: AC_SRC_OVER as u8,
                        BlendFlags: 0,
                        SourceConstantAlpha: 255,
                        AlphaFormat: AC_SRC_ALPHA as u8,
                    };
                    let presented = UpdateLayeredWindow(
                        hwnd, None,
                        Some(&dst_pt as *const POINT),
                        Some(&size as *const SIZE),
                        Some(dib.hdc),
                        Some(&src_pt as *const POINT),
                        COLORREF(0),
                        Some(&blend as *const BLENDFUNCTION),
                        ULW_ALPHA,
                    ).is_ok();
                    if presented {
                        last_presented = now;
                        pending_frame.presented();
                        for request_id in requests.drain(..) {
                            protocol_line(&output, serde_json::json!({ "event": "ack", "requestId": request_id, "ok": true }));
                        }
                        if !ready_sent {
                            protocol_line(&output, serde_json::json!({ "event": "ready" }));
                            ready_sent = true;
                        }
                    }
                }
            }
            let _ = DestroyWindow(hwnd);
        }
        std::process::exit(0);
    }

    #[test]
    fn final_hidden_marker_renders_a_transparent_bitmap() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let mut frame = PendingFrame(true);
        let now = Instant::now();
        let dib = create_dib(320, 200);
        let renderer = Renderer::new().expect("Direct2D renderer");
        assert!(apply_command_at(&state,
            r#"{"cmd":"upsert","id":"a","label":"Codex","x":80,"y":80}"#, now));
        let snapshot = presentation_snapshot(&state, &mut frame);
        renderer.render(dib.hdc, 320, 200, &snapshot, now).unwrap();
        let pixels = || unsafe { std::slice::from_raw_parts(dib.bits, 320 * 200 * 4) };
        assert!(pixels().chunks_exact(4).any(|px| px[3] != 0));
        frame.presented();
        assert!(apply_command_at(&state, r#"{"cmd":"hide","id":"a"}"#, now));
        let snapshot = presentation_snapshot(&state, &mut frame);
        assert!(snapshot.is_empty() && frame.needed(false));
        renderer.render(dib.hdc, 320, 200, &snapshot, now).unwrap();
        assert!(pixels().chunks_exact(4).all(|px| px[3] == 0));
    }

    fn rand_u64() -> u64 {
        // No external RNG dependency for one bounded jitter value: seed from
        // the high-resolution clock, which is more than sufficient entropy
        // for "which second a blink happens on".
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos() as u64
    }

    /// Writes one deterministic demo frame to a PNG file -- no window, no
    /// real screen, no agent-context concerns. Exists so the rendering logic
    /// can be verified by reading the resulting image file directly, instead
    /// of requiring a live display. Writes the transparent overlay frame to
    /// `out_path`, plus `-on-dark` / `-on-light` composites next to it for
    /// visual inspection against representative desktop backgrounds.
    pub fn self_test(out_path: &str) {
        let w = 760;
        let h = 420;
        let dib = create_dib(w, h);
        let mut agents = HashMap::new();
        let now = Instant::now();
        let claude = Rgb(232, 121, 74);
        let codex = Rgb(62, 142, 240);
        let open = Rgb(52, 184, 106);
        agents.insert(
            "claude".to_string(),
            AgentState {
                x: 60.0, y: 40.0,
                target_x: 60.0, target_y: 40.0,
                anim_from_x: 60.0, anim_from_y: 40.0, anim_start: now,
                anim_control_x: 60.0, anim_control_y: 40.0, anim_duration_ms: 0.0,
                color: claude, dark: darken(claude, 0.62),
                label: "Claude Code".to_string(),
                next_blink_at: now + Duration::from_secs(5), blink_until: None,
                action_cue_at: None,
                bubble: None,
            },
        );
        agents.insert(
            "codex".to_string(),
            AgentState {
                x: 360.0, y: 50.0,
                target_x: 360.0, target_y: 50.0,
                anim_from_x: 360.0, anim_from_y: 50.0, anim_start: now,
                anim_control_x: 360.0, anim_control_y: 50.0, anim_duration_ms: 0.0,
                color: codex, dark: darken(codex, 0.62),
                label: "Codex".to_string(),
                next_blink_at: now + Duration::from_secs(5), blink_until: None,
                action_cue_at: None,
                bubble: Some(Bubble {
                    text: "Mind if I grab the sidebar? You've got the API.".to_string(),
                    started_at: now - Duration::from_millis(500),
                }),
            },
        );
        agents.insert(
            "open".to_string(),
            AgentState {
                x: 150.0, y: 220.0,
                target_x: 150.0, target_y: 220.0,
                anim_from_x: 150.0, anim_from_y: 220.0, anim_start: now,
                anim_control_x: 150.0, anim_control_y: 220.0, anim_duration_ms: 0.0,
                color: open, dark: darken(open, 0.62),
                label: "OpenCode".to_string(),
                next_blink_at: now + Duration::from_secs(5), blink_until: Some(now + Duration::from_secs(5)),
                action_cue_at: None,
                bubble: Some(Bubble {
                    text: "Heads up, I'm touching the config too.".to_string(),
                    started_at: now - Duration::from_millis(500),
                }),
            },
        );
        let renderer = Renderer::new().expect("initializing Direct2D/DirectWrite");
        renderer.render(dib.hdc, w, h, &agents, now).expect("rendering self-test frame");
        let px = dib.pixels();
        write_png(out_path, w, h, px, |_, _| None);
        let stem = out_path.strip_suffix(".png").unwrap_or(out_path);
        // The preview's stage: #14171b with a faint 22px dot grid.
        write_png(&format!("{stem}-on-dark.png"), w, h, px, |x, y| {
            let (dx, dy) = ((x % 22) as i32 - 11, (y % 22) as i32 - 11);
            let dot = dx * dx + dy * dy <= 1;
            Some(if dot { (0x1e, 0x21, 0x25) } else { (0x14, 0x17, 0x1b) })
        });
        write_png(&format!("{stem}-on-light.png"), w, h, px, |x, _| {
            let v = 236u8.saturating_sub((x / 40) as u8);
            Some((v, v, v.saturating_add(4)))
        });
    }

    /// Premultiplied BGRA -> PNG. With a backdrop, composites over it
    /// (opaque RGB); without, un-premultiplies to straight RGBA.
    fn write_png(path: &str, w: i32, h: i32, px: &[u8], backdrop: impl Fn(u32, u32) -> Option<(u8, u8, u8)>) {
        let file = std::fs::File::create(path).expect("creating self-test PNG output file");
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w as u32, h as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("writing PNG header");
        let mut rgba = vec![0u8; px.len()];
        for i in (0..px.len()).step_by(4) {
            let (b, g, r, a) = (px[i], px[i + 1], px[i + 2], px[i + 3]);
            let p = (i / 4) as u32;
            match backdrop(p % w as u32, p / w as u32) {
                Some((br, bg, bb)) => {
                    let over = |c: u8, d: u8| (c as u32 + (d as u32 * (255 - a as u32) + 127) / 255).min(255) as u8;
                    rgba[i] = over(r, br);
                    rgba[i + 1] = over(g, bg);
                    rgba[i + 2] = over(b, bb);
                    rgba[i + 3] = 255;
                }
                None => {
                    let unpremult = |c: u8| if a == 0 { 0 } else { ((c as u32 * 255) / a as u32).min(255) as u8 };
                    rgba[i] = unpremult(r);
                    rgba[i + 1] = unpremult(g);
                    rgba[i + 2] = unpremult(b);
                    rgba[i + 3] = a;
                }
            }
        }
        writer.write_image_data(&rgba).expect("writing PNG image data");
    }
}

#[cfg(test)]
mod movement_tests {
    use super::*;

    fn upsert(state: &SharedState, id: &str, x: f32, y: f32, now: Instant) {
        let line = format!(r#"{{"cmd":"upsert","id":"{id}","x":{x},"y":{y}}}"#);
        assert!(apply_command_at(state, &line, now));
    }

    #[test]
    fn chatter_text_is_one_line_and_truncated_with_an_ellipsis() {
        assert_eq!(normalize_bubble_text("  review\nthis\tfirst  "), "review this first");
        let long = normalize_bubble_text(&"word ".repeat(20));
        assert_eq!(long.chars().count(), BUBBLE_MAX_CHARS);
        assert!(long.ends_with('…'));
        assert!(!long.contains('\n'));
    }

    #[test]
    fn bubble_tail_anchor_tracks_the_live_cursor_position() {
        let first = bubble_placement(100.0, 80.0, 42.0);
        let moved = bubble_placement(260.0, 140.0, 42.0);
        assert_eq!(moved.tail_tip_x - first.tail_tip_x, 160.0);
        assert_eq!(moved.tail_tip_y - first.tail_tip_y, 60.0);
        assert_eq!(first.tail_tip_x, 117.0);
        assert_eq!(first.tail_tip_y, 98.0);
        assert_eq!(first.top + 42.0, 66.0, "bubble body stays just above the cursor while its tail points down to it");
        assert!(first.top < 80.0);
    }

    #[test]
    fn bubble_ink_contrasts_with_dark_and_light_agent_identity_fills() {
        assert_eq!(bubble_ink_color(Rgb(20, 40, 80)), Rgb(255, 255, 255));
        assert_eq!(bubble_ink_color(Rgb(240, 180, 70)), Rgb(22, 24, 28));
    }

    #[test]
    fn a_new_agent_message_replaces_the_prior_bubble_and_uses_the_supplied_clock() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let now = Instant::now();
        upsert(&state, "codex", 10.0, 20.0, now);
        assert!(apply_command_at(&state, r#"{"cmd":"say","id":"codex","to":"Claude","toColor":[1,2,3],"text":"first"}"#, now));
        let later = now + Duration::from_millis(500);
        assert!(apply_command_at(&state, r#"{"cmd":"say","id":"codex","to":"Claude","toColor":[1,2,3],"text":"second"}"#, later));
        let guard = state.lock().unwrap();
        let bubble = guard["codex"].bubble.as_ref().unwrap();
        assert_eq!(bubble.text, "second");
        assert_eq!(bubble.started_at, later);
        assert!(bubble_opacity(0.0).is_some());
    }

    #[test]
    fn first_placement_is_immediate() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let t0 = Instant::now();
        upsert(&state, "a", 100.0, 50.0, t0);
        let guard = state.lock().unwrap();
        assert_eq!(animated_position(&guard["a"], t0), (100.0, 50.0));
    }

    #[test]
    fn action_cue_waits_for_arrival_and_survives_same_target_updates() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let start = Instant::now();
        upsert(&state, "a", 0.0, 0.0, start);
        upsert(&state, "a", 300.0, 0.0, start);
        let cue = r#"{"cmd":"upsert","id":"a","x":300,"y":0,"cue":"click"}"#;
        let dispatched = start + Duration::from_millis(20);
        assert!(apply_command_at(&state, cue, dispatched));
        let arrival = state.lock().unwrap()["a"].action_cue_at.unwrap();
        assert!(arrival > dispatched);
        assert_eq!(animated_position(&state.lock().unwrap()["a"], arrival), (300.0, 0.0));

        assert!(apply_command_at(&state, r#"{"cmd":"upsert","id":"a","x":300,"y":0,"label":"New label"}"#, dispatched));
        let agent = state.lock().unwrap()["a"].clone();
        assert_eq!(agent.anim_start, start);
        assert_eq!(agent.action_cue_at, Some(arrival));

        upsert(&state, "a", 500.0, 0.0, dispatched);
        assert_eq!(state.lock().unwrap()["a"].action_cue_at, None);
    }

    #[test]
    fn movement_glides_to_the_new_position() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let t0 = Instant::now();
        upsert(&state, "a", 0.0, 0.0, t0);
        let t1 = t0 + Duration::from_millis(10);
        upsert(&state, "a", 100.0, 0.0, t1);

        let mid = t1 + Duration::from_millis(80);
        let guard = state.lock().unwrap();
        let (x, y) = animated_position(&guard["a"], mid);
        assert!(
            x > 0.0 && x < 100.0,
            "expected an in-flight x position, got {x}"
        );
        assert!(y.abs() > 0.0 && y.abs() < 5.5, "expected a shallow in-flight arc, got {y}");
        let (x, y) = animated_position(&guard["a"], t1 + Duration::from_millis(161));
        assert_eq!((x, y), (100.0, 0.0));
    }

    #[test]
    fn long_moves_get_a_longer_curved_path_and_still_land_on_target() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let t0 = Instant::now();
        upsert(&state, "a", 0.0, 0.0, t0);
        let t1 = t0 + Duration::from_millis(1);
        upsert(&state, "a", 1000.0, 0.0, t1);

        let guard = state.lock().unwrap();
        let agent = &guard["a"];
        assert_eq!(agent.anim_duration_ms, 340.0);
        assert!(
            agent.anim_control_y.abs() > 1.0,
            "long movement should use a shallow arc"
        );
        let middle = animated_position(agent, t1 + Duration::from_millis(170));
        assert!(middle.0 > 0.0 && middle.0 < 1000.0);
        assert!(
            middle.1.abs() > 0.0,
            "movement should follow an eased arc instead of teleporting"
        );
        assert_eq!(animated_position(agent, t1 + Duration::from_millis(341)), (1000.0, 0.0));
    }

    #[test]
    fn distance_scales_duration_without_exceeding_the_safety_cap() {
        let short = movement_profile(0.0, 0.0, 20.0, 0.0).2;
        let long = movement_profile(0.0, 0.0, 10_000.0, 0.0).2;
        assert!(short > MOVE_MIN_MS && short < MOVE_MIN_MS + 10.0);
        assert_eq!(long, MOVE_MAX_MS);
    }

    #[test]
    fn a_retarget_starts_at_the_current_animated_position() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let t0 = Instant::now();
        upsert(&state, "a", 0.0, 0.0, t0);
        let t1 = t0 + Duration::from_millis(10);
        upsert(&state, "a", 100.0, 0.0, t1);
        let retarget_at = t1 + Duration::from_millis(70);
        let current_x = animated_position(&state.lock().unwrap()["a"], retarget_at).0;
        upsert(&state, "a", 300.0, 0.0, retarget_at);

        let guard = state.lock().unwrap();
        let agent = &guard["a"];
        assert!((agent.anim_from_x - current_x).abs() < 0.001);
        assert_eq!(agent.target_x, 300.0);
        assert_ne!(agent.anim_from_x, 0.0);
        assert_ne!(agent.anim_from_x, 100.0);
    }

    #[test]
    fn one_agent_glide_does_not_move_another_agent() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let t0 = Instant::now();
        upsert(&state, "a", 0.0, 0.0, t0);
        upsert(&state, "b", 12.0, 24.0, t0);
        let t1 = t0 + Duration::from_millis(10);
        upsert(&state, "a", 200.0, 0.0, t1);

        let guard = state.lock().unwrap();
        let (ax, _) = animated_position(&guard["a"], t1 + Duration::from_millis(70));
        assert!(ax > 0.0 && ax < 200.0);
        assert_eq!(
            animated_position(&guard["b"], t1 + Duration::from_millis(70)),
            (12.0, 24.0)
        );
    }

    #[test]
    fn hide_clears_cursor_and_animation_state() {
        let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
        let now = Instant::now();
        upsert(&state, "a", 0.0, 0.0, now);
        assert!(apply_command_at(&state, r#"{"cmd":"hide","id":"a"}"#, now));
        assert!(!state.lock().unwrap().contains_key("a"));
    }

    #[test]
    fn final_hide_requires_a_clear_frame_in_both_completion_orders() {
        for order in [["a", "b"], ["b", "a"]] {
            let state: SharedState = Arc::new(Mutex::new(HashMap::new()));
            let now = Instant::now();
            let mut frame = PendingFrame(true);
            upsert(&state, "a", 10.0, 20.0, now);
            upsert(&state, "b", 30.0, 40.0, now);
            assert_eq!(presentation_snapshot(&state, &mut frame).len(), 2);
            frame.presented();
            for (index, id) in order.into_iter().enumerate() {
                assert!(apply_command_at(&state,
                    &serde_json::json!({"cmd": "hide", "id": id}).to_string(), now));
                assert_eq!(presentation_snapshot(&state, &mut frame).len(), 1 - index);
                assert!(frame.needed(false), "hide must submit a frame even with zero agents");
                // A failed render/presentation must remain pending on idle ticks.
                presentation_snapshot(&state, &mut frame);
                assert!(frame.needed(false));
                frame.presented();
                assert!(!frame.needed(false));
            }
            assert!(state.lock().unwrap().is_empty());
            // The next task wakes the renderer after the empty frame went idle.
            upsert(&state, "c", 50.0, 60.0, now);
            assert_eq!(presentation_snapshot(&state, &mut frame).len(), 1);
            assert!(frame.needed(false));
        }
    }

    #[test]
    fn failed_animation_frame_remains_pending_after_animation_ends() {
        let mut frame = PendingFrame(false);
        assert!(frame.needed(true));
        frame.invalidate(true);
        assert!(frame.needed(false));
        frame.presented();
        assert!(!frame.needed(false));
    }
}
