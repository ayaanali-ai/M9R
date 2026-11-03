//! Native Windows window capture used by the M9R perception path.
//!
//! The capture is intentionally scoped to one already-validated HWND. It does
//! not enumerate or retarget windows and it never moves focus or the pointer.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    },
    Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
    UI::WindowsAndMessaging::GetClientRect,
    UI::WindowsAndMessaging::{GetSystemMetrics, SYSTEM_METRICS_INDEX},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeWindowCapture {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub origin_x: i32,
    pub origin_y: i32,
}

#[cfg(windows)]
fn png_data_url(width: u32, height: u32, bgra: &[u8]) -> Result<String, String> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for px in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer.write_image_data(&rgba).map_err(|error| error.to_string())?;
    }
    Ok(format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

#[cfg(windows)]
pub fn capture_window(window: usize) -> Result<NativeWindowCapture, String> {
    let hwnd = HWND(window as *mut core::ffi::c_void);
    if hwnd.0.is_null() {
        return Err("no window handle was supplied for capture".into());
    }
    let mut rect = RECT::default();
    unsafe { GetClientRect(hwnd, &mut rect) }.map_err(|error| error.to_string())?;
    let width = (rect.right - rect.left).max(1) as u32;
    let height = (rect.bottom - rect.top).max(1) as u32;
    let source = unsafe { GetDC(Some(hwnd)) };
    if source.0.is_null() {
        return Err("Windows returned no client device context".into());
    }
    let memory = unsafe { CreateCompatibleDC(Some(source)) };
    if memory.0.is_null() {
        unsafe { ReleaseDC(Some(hwnd), source) };
        return Err("Windows could not create a compatible capture context".into());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(source, width as i32, height as i32) };
    if bitmap.0.is_null() {
        unsafe {
            windows::Win32::Graphics::Gdi::DeleteDC(memory);
            ReleaseDC(Some(hwnd), source);
        }
        return Err("Windows could not allocate a capture bitmap".into());
    }
    let previous = unsafe { SelectObject(memory, HGDIOBJ(bitmap.0)) };
    let painted = unsafe { PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(0)).as_bool() };
    let copied = if painted {
        true
    } else {
        unsafe { BitBlt(memory, 0, 0, width as i32, height as i32, Some(source), 0, 0, SRCCOPY).is_ok() }
    };
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: core::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // A negative height asks GDI for top-down rows, matching screen order.
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let read = if copied {
        unsafe {
            GetDIBits(
                memory,
                bitmap,
                0,
                height,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        }
    } else {
        0
    };
    unsafe {
        if !previous.0.is_null() {
            SelectObject(memory, previous);
        }
        DeleteObject(HGDIOBJ(bitmap.0));
        windows::Win32::Graphics::Gdi::DeleteDC(memory);
        ReleaseDC(Some(hwnd), source);
    }
    if read != height as i32 {
        return Err("Windows could not read the captured pixels".into());
    }
    Ok(NativeWindowCapture { data_url: png_data_url(width, height, &pixels)?, width, height, origin_x: 0, origin_y: 0 })
}

/// Capture the complete virtual desktop without depending on the Cua runtime.
/// The origin may be negative on a multi-monitor layout; the returned image is
/// always top-left anchored at that virtual origin and uses real screen pixels.
#[cfg(windows)]
pub fn capture_desktop() -> Result<NativeWindowCapture, String> {
    let origin_x = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(76)) };
    let origin_y = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(77)) };
    let width = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(78)) };
    let height = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(79)) };
    if width <= 0 || height <= 0 || width > 16_384 || height > 16_384 {
        return Err("Windows returned no valid virtual desktop bounds".into());
    }
    let width_u = width as u32;
    let height_u = height as u32;
    let source = unsafe { GetDC(None) };
    if source.0.is_null() {
        return Err("Windows returned no virtual desktop device context".into());
    }
    let memory = unsafe { CreateCompatibleDC(Some(source)) };
    if memory.0.is_null() {
        unsafe { ReleaseDC(None, source); }
        return Err("Windows could not create a virtual desktop capture context".into());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(source, width, height) };
    if bitmap.0.is_null() {
        unsafe {
            windows::Win32::Graphics::Gdi::DeleteDC(memory);
            ReleaseDC(None, source);
        }
        return Err("Windows could not allocate a virtual desktop capture bitmap".into());
    }
    let previous = unsafe { SelectObject(memory, HGDIOBJ(bitmap.0)) };
    let copied = unsafe { BitBlt(memory, 0, 0, width, height, Some(source), origin_x, origin_y, SRCCOPY).is_ok() };
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: core::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; width_u as usize * height_u as usize * 4];
    let read = if copied {
        unsafe { GetDIBits(memory, bitmap, 0, height_u, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS) }
    } else { 0 };
    unsafe {
        if !previous.0.is_null() { SelectObject(memory, previous); }
        DeleteObject(HGDIOBJ(bitmap.0));
        windows::Win32::Graphics::Gdi::DeleteDC(memory);
        ReleaseDC(None, source);
    }
    if read != height {
        return Err("Windows could not read the virtual desktop capture".into());
    }
    Ok(NativeWindowCapture { data_url: png_data_url(width_u, height_u, &pixels)?, width: width_u, height: height_u, origin_x, origin_y })
}

#[cfg(not(windows))]
pub fn capture_window(_window: usize) -> Result<NativeWindowCapture, String> {
    Err("native window capture is available only on Windows".into())
}

#[cfg(not(windows))]
pub fn capture_desktop() -> Result<NativeWindowCapture, String> {
    Err("native desktop capture is available only on Windows".into())
}

