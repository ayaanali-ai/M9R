use crate::{ClickRequest, MouseButton};
use std::ffi::c_void;
use std::mem::size_of;

type Hwnd = *mut c_void;
type Handle = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: i32,
    y: i32,
}

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
union InputData {
    mouse: MouseInput,
    alignment: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Input {
    kind: u32,
    data: InputData,
}

#[derive(Clone, Copy)]
struct RendererCandidate {
    window: Hwnd,
    rect: Rect,
}

struct PageViewport {
    renderer: Hwnd,
    rect: Rect,
    scale_x: f64,
    scale_y: f64,
}

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> Hwnd;
    fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
    fn EnumChildWindows(
        parent: Hwnd,
        callback: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>,
        data: isize,
    ) -> i32;
    fn GetClassNameW(window: Hwnd, class_name: *mut u16, max_count: i32) -> i32;
    fn GetParent(window: Hwnd) -> Hwnd;
    fn IsWindowVisible(window: Hwnd) -> i32;
    fn GetWindowRect(window: Hwnd, rect: *mut Rect) -> i32;
    fn WindowFromPoint(point: Point) -> Hwnd;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    fn Sleep(milliseconds: u32);
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        image_name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
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

#[cfg(test)]
mod pointer_path_tests {
    use super::{
        is_renderer_or_child, is_supported_browser_image_path, pointer_path_point, Hwnd, Point,
    };

    #[test]
    fn native_input_accepts_only_chrome_and_edge_process_images() {
        assert!(is_supported_browser_image_path(
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        ));
        assert!(is_supported_browser_image_path(
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        ));
        assert!(!is_supported_browser_image_path(
            r"C:\Program Files\Mozilla Firefox\firefox.exe"
        ));
        assert!(!is_supported_browser_image_path(
            r"C:\tools\fake-chrome.exe"
        ));
    }

    #[test]
    fn click_window_must_still_belong_to_the_measured_page_renderer() {
        let renderer = 1usize as Hwnd;
        let child = 2usize as Hwnd;
        let other_page = 3usize as Hwnd;
        assert!(is_renderer_or_child(child, renderer, |window| {
            if window == child {
                renderer
            } else {
                std::ptr::null_mut()
            }
        }));
        assert!(!is_renderer_or_child(other_page, renderer, |_| {
            std::ptr::null_mut()
        }));
    }

    #[test]
    fn agent_pointer_path_is_deterministic_bounded_and_reaches_the_exact_target() {
        let start = Point { x: 18, y: 420 };
        let end = Point { x: 1174, y: 53 };
        let mut previous = start;
        for step in 0..=100 {
            let progress = step as f64 / 100.0;
            let point = pointer_path_point(start, end, progress);
            let repeated = pointer_path_point(start, end, progress);
            assert_eq!((point.x, point.y), (repeated.x, repeated.y));
            assert!(point.x >= previous.x);
            assert!(point.y <= previous.y);
            assert!((start.x..=end.x).contains(&point.x));
            assert!((end.y..=start.y).contains(&point.y));
            previous = point;
        }
        assert_eq!((previous.x, previous.y), (end.x, end.y));
        assert_eq!(pointer_path_point(start, end, 0.0).x, start.x);
        assert_eq!(pointer_path_point(start, end, 0.0).y, start.y);
    }
}

fn is_supported_browser_image_path(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    path.ends_with(r"\chrome.exe") || path.ends_with(r"\msedge.exe")
}

fn foreground_is_supported_browser(window: Hwnd) -> bool {
    if window.is_null() {
        return false;
    }
    let mut process_id = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut process_id);
    }
    if process_id == 0 {
        return false;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return false;
    }
    let mut image = vec![0u16; 32_768];
    let mut size = image.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut size) } != 0;
    unsafe {
        CloseHandle(process);
    }
    if !ok {
        return false;
    }
    is_supported_browser_image_path(&String::from_utf16_lossy(&image[..size as usize]))
}

unsafe extern "system" fn collect_renderer(window: Hwnd, data: isize) -> i32 {
    let mut name = [0u16; 128];
    let count = GetClassNameW(window, name.as_mut_ptr(), name.len() as i32);
    if count <= 0
        || String::from_utf16_lossy(&name[..count as usize]) != "Chrome_RenderWidgetHostHWND"
        || IsWindowVisible(window) == 0
    {
        return 1;
    }
    let mut rect = Rect {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if GetWindowRect(window, &mut rect) == 0 || rect.right <= rect.left || rect.bottom <= rect.top {
        return 1;
    }
    let candidates = &mut *(data as *mut Vec<RendererCandidate>);
    candidates.push(RendererCandidate { window, rect });
    1
}

fn page_renderer_rect(window: Hwnd, request: &ClickRequest) -> Option<PageViewport> {
    let mut candidates = Vec::<RendererCandidate>::new();
    unsafe {
        EnumChildWindows(
            window,
            Some(collect_renderer),
            &mut candidates as *mut _ as isize,
        );
    }
    candidates
        .into_iter()
        .filter_map(|candidate| {
            let rect = candidate.rect;
            let width = (rect.right - rect.left) as f64;
            let height = (rect.bottom - rect.top) as f64;
            let scale_x = width / request.viewport_width;
            let scale_y = height / request.viewport_height;
            if !(0.4..=8.0).contains(&scale_x) || !(0.4..=8.0).contains(&scale_y) {
                return None;
            }
            let mismatch = (scale_x - scale_y).abs() / scale_x.max(scale_y);
            if mismatch > 0.18 {
                return None;
            }
            Some((candidate, scale_x, scale_y, mismatch, width * height))
        })
        .min_by(|a, b| a.3.total_cmp(&b.3).then_with(|| b.4.total_cmp(&a.4)))
        .map(|(candidate, scale_x, scale_y, _, _)| PageViewport {
            renderer: candidate.window,
            rect: candidate.rect,
            scale_x,
            scale_y,
        })
}

fn is_renderer_or_child(
    mut window: Hwnd,
    renderer: Hwnd,
    mut get_parent: impl FnMut(Hwnd) -> Hwnd,
) -> bool {
    while !window.is_null() {
        if window == renderer {
            return true;
        }
        window = get_parent(window);
    }
    false
}

fn point_belongs_to_renderer(point: Point, renderer: Hwnd) -> bool {
    is_renderer_or_child(
        unsafe { WindowFromPoint(point) },
        renderer,
        |window| unsafe { GetParent(window) },
    )
}

fn pointer_path_point(start: Point, end: Point, progress: f64) -> Point {
    let t = progress.clamp(0.0, 1.0);
    let eased = t * t * t * (10.0 + t * (-15.0 + 6.0 * t));
    Point {
        x: (start.x as f64 + (end.x - start.x) as f64 * eased).round() as i32,
        y: (start.y as f64 + (end.y - start.y) as f64 * eased).round() as i32,
    }
}

fn absolute_axis(value: i32, origin: i32, extent: i32) -> i32 {
    if extent <= 1 {
        return 0;
    }
    (((value - origin) as f64 * 65_535.0 / (extent - 1) as f64).round() as i32).clamp(0, 65_535)
}

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

fn move_pointer_smoothly(
    window: Hwnd,
    start: Point,
    end: Point,
    renderer: Rect,
    scale_x: f64,
    scale_y: f64,
    progress: &mut impl FnMut(f64, f64, bool) -> bool,
) -> Result<(), &'static str> {
    let distance = ((end.x - start.x) as f64).hypot((end.y - start.y) as f64);
    if distance < 1.0 {
        return Ok(());
    }
    // Smooth, deterministic motion keeps the drawn cursor aligned with the
    // actual OS pointer. It is attributed agent automation, not human
    // simulation or an attempt to evade site automation controls.
    let duration_ms = (120.0 + distance / 2.2).clamp(120.0, 650.0);
    let steps = ((duration_ms / 16.0).round() as usize).clamp(8, 40);
    let interval_ms = (duration_ms / steps as f64).round().clamp(1.0, 80.0) as u32;
    for step in 1..=steps {
        if unsafe { GetForegroundWindow() } != window {
            return Err("Chrome lost foreground focus before the click");
        }
        let t = step as f64 / steps as f64;
        let point = pointer_path_point(start, end, t);
        if !send_mouse(point.x, point.y, MOUSEEVENTF_MOVE) {
            return Err("Windows declined trusted mouse movement");
        }
        if point.x >= renderer.left
            && point.x < renderer.right
            && point.y >= renderer.top
            && point.y < renderer.bottom
        {
            if !progress(
                (point.x - renderer.left) as f64 / scale_x,
                (point.y - renderer.top) as f64 / scale_y,
                false,
            ) {
                return Err("native input client disconnected during pointer movement");
            }
        }
        unsafe {
            Sleep(interval_ms);
        }
    }
    Ok(())
}

/// Performs an owner-visible, agent-attributed OS click in the foreground Chrome tab.
/// This path does not disguise automation or bypass a site's automation restrictions.
pub fn click_visible_chrome_tab(
    request: &ClickRequest,
    progress: &mut impl FnMut(f64, f64, bool) -> bool,
) -> Result<(), &'static str> {
    let window = unsafe { GetForegroundWindow() };
    if !foreground_is_supported_browser(window) {
        return Err("the visible foreground window is not Chrome or Edge");
    }
    let page = page_renderer_rect(window, request)
        .ok_or("could not identify the visible Chrome page viewport")?;
    let renderer = page.rect;
    let x = renderer.left + (request.x * page.scale_x).round() as i32;
    let y = renderer.top + (request.y * page.scale_y).round() as i32;
    if x < renderer.left || x >= renderer.right || y < renderer.top || y >= renderer.bottom {
        return Err("click point is outside the visible Chrome page viewport");
    }

    let mut cursor = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut cursor) } == 0 {
        return Err("could not read the system pointer position");
    }
    move_pointer_smoothly(
        window,
        cursor,
        Point { x, y },
        renderer,
        page.scale_x,
        page.scale_y,
        progress,
    )?;
    if unsafe { GetForegroundWindow() } != window {
        return Err("Chrome lost foreground focus before the click");
    }
    let mut arrived = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut arrived) } == 0
        || (arrived.x - x).abs() > 3
        || (arrived.y - y).abs() > 3
    {
        return Err("system pointer did not reach the approved page target");
    }
    if !point_belongs_to_renderer(Point { x, y }, page.renderer) {
        return Err("visible Chrome page changed before the click");
    }
    let page_x = (x - renderer.left) as f64 / page.scale_x;
    let page_y = (y - renderer.top) as f64 / page.scale_y;
    if !progress(page_x, page_y, true) {
        return Err("visible pointer arrival was not acknowledged; click cancelled");
    }
    if unsafe { GetForegroundWindow() } != window {
        return Err("Chrome lost foreground focus before the click");
    }
    let mut arrived = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut arrived) } == 0
        || (arrived.x - x).abs() > 3
        || (arrived.y - y).abs() > 3
        || !point_belongs_to_renderer(Point { x, y }, page.renderer)
    {
        return Err("system pointer or visible page changed before the click");
    }

    let (down, up) = match request.button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    for click in 0..request.click_count {
        if unsafe { GetForegroundWindow() } != window {
            return Err("Chrome lost foreground focus before the click");
        }
        let mut current = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut current) } == 0
            || (current.x - x).abs() > 3
            || (current.y - y).abs() > 3
            || !point_belongs_to_renderer(Point { x, y }, page.renderer)
        {
            return Err("system pointer or visible page changed before the click");
        }
        if !send_mouse(x, y, down) {
            return Err("Windows declined the trusted mouse click");
        }
        unsafe {
            Sleep(80);
        }
        if !send_mouse(x, y, up) {
            let _ = send_mouse(x, y, up);
            return Err("Windows declined the trusted mouse release");
        }
        if click + 1 < request.click_count {
            unsafe {
                Sleep(100);
            }
        }
    }
    Ok(())
}
