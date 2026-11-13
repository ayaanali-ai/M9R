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
        GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HBITMAP, HDC, HGDIOBJ, SRCCOPY,
    },
    Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
    UI::WindowsAndMessaging::GetWindowRect,
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
    let mut rgba = Vec::new();
    rgba.try_reserve_exact(bgra.len())
        .map_err(|error| format!("Windows could not allocate PNG pixels: {error}"))?;
    for px in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&rgba)
            .map_err(|error| error.to_string())?;
    }
    Ok(format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

#[cfg(windows)]
fn invalid_gdi_object(object: HGDIOBJ) -> bool {
    object.0.is_null() || object.0 as isize == -1
}

/// Restore the memory DC's prior bitmap before GetDIBits. Win32 requires the
/// bitmap passed to GetDIBits to be deselected from every DC.
#[cfg(windows)]
fn deselect_capture_bitmap(memory: HDC, bitmap: HBITMAP, previous: HGDIOBJ) -> Result<(), String> {
    if invalid_gdi_object(previous) {
        return Err("Windows could not select the capture bitmap into its memory context".into());
    }
    let displaced = unsafe { SelectObject(memory, previous) };
    if displaced.0 != bitmap.0 {
        return Err("Windows could not deselect the capture bitmap before reading pixels".into());
    }
    Ok(())
}

#[cfg(windows)]
fn window_capture_dimensions(rect: &RECT) -> Result<(i32, i32), String> {
    let width = rect
        .right
        .checked_sub(rect.left)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Windows returned no valid full-window capture width".to_owned())?;
    let height = rect
        .bottom
        .checked_sub(rect.top)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Windows returned no valid full-window capture height".to_owned())?;
    Ok((width, height))
}

#[cfg(windows)]
pub fn capture_window(window: usize) -> Result<NativeWindowCapture, String> {
    let hwnd = HWND(window as *mut core::ffi::c_void);
    if hwnd.0.is_null() {
        return Err("no window handle was supplied for capture".into());
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|error| error.to_string())?;
    let (width, height) = window_capture_dimensions(&rect)?;
    let pixel_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Windows returned full-window bounds too large to capture".to_owned())?;
    let mut pixels = Vec::new();
    pixels.try_reserve_exact(pixel_bytes).map_err(|error| {
        format!("Windows could not allocate the full-window capture buffer: {error}")
    })?;
    pixels.resize(pixel_bytes, 0);
    // The screenshot and windowRect contract both describe the full HWND
    // bounds, including its non-client frame. GetDC(hwnd) is client-only and
    // made PrintWindow's full-window output clip into a client-sized bitmap.
    let source = unsafe { GetWindowDC(Some(hwnd)) };
    if source.0.is_null() {
        return Err("Windows returned no full-window device context".into());
    }
    let memory = unsafe { CreateCompatibleDC(Some(source)) };
    if memory.0.is_null() {
        unsafe { ReleaseDC(Some(hwnd), source) };
        return Err("Windows could not create a compatible capture context".into());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(source, width, height) };
    if bitmap.0.is_null() {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
            ReleaseDC(Some(hwnd), source);
        }
        return Err("Windows could not allocate a capture bitmap".into());
    }
    let previous = unsafe { SelectObject(memory, HGDIOBJ(bitmap.0)) };
    if invalid_gdi_object(previous) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            ReleaseDC(Some(hwnd), source);
        }
        return Err("Windows could not select the capture bitmap into its memory context".into());
    }
    // PW_RENDERFULLCONTENT (2, not yet in the windows crate's own binding) asks DWM to render the
    // window's real composited content into our DC. Without it, PrintWindow reports success (`painted`
    // true) for a DirectComposition/hardware-accelerated window -- the modern Paint app among them --
    // while actually painting nothing, so the fallback BitBlt below never runs and the capture comes
    // back solid black. Confirmed live on 2026-11-13: M9R's own mid-task observation captures of Paint's
    // canvas were black while a plain OS-level screenshot of the same window was not, because only the
    // observation path went through this PrintWindow call.
    const PW_RENDERFULLCONTENT: u32 = 0x00000002;
    let painted = unsafe { PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool() };
    let copied = if painted {
        true
    } else {
        unsafe { BitBlt(memory, 0, 0, width, height, Some(source), 0, 0, SRCCOPY).is_ok() }
    };
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: core::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // A negative height asks GDI for top-down rows, matching screen order.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    if let Err(error) = deselect_capture_bitmap(memory, bitmap, previous) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            ReleaseDC(Some(hwnd), source);
        }
        return Err(error);
    }
    let read = if copied {
        unsafe {
            GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        }
    } else {
        0
    };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
        ReleaseDC(Some(hwnd), source);
    }
    if read != height {
        return Err("Windows could not read the captured pixels".into());
    }
    Ok(NativeWindowCapture {
        data_url: png_data_url(width as u32, height as u32, &pixels)?,
        width: width as u32,
        height: height as u32,
        origin_x: rect.left,
        origin_y: rect.top,
    })
}

#[cfg(windows)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_capture_uses_the_full_frame_rectangle_and_origin() {
        let rect = RECT {
            left: -1200,
            top: 40,
            right: 400,
            bottom: 940,
        };
        assert_eq!(window_capture_dimensions(&rect).unwrap(), (1600, 900));
        assert_eq!((rect.left, rect.top), (-1200, 40));
    }

    #[test]
    fn window_capture_rejects_empty_bounds_without_clamping_them_into_fake_pixels() {
        let rect = RECT {
            left: 10,
            top: 40,
            right: 10,
            bottom: 30,
        };
        assert!(window_capture_dimensions(&rect).is_err());
    }
}

/// Capture the full virtual screen (the union of connected monitor bounds)
/// without depending on the Cua runtime. This does not refer to Windows Task
/// View desktops or switch the active desktop.
/// The origin may be negative on a multi-monitor layout; the returned image is
/// always top-left anchored at that virtual origin and uses real screen pixels.
#[cfg(windows)]
pub fn capture_desktop() -> Result<NativeWindowCapture, String> {
    let origin_x = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(76)) };
    let origin_y = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(77)) };
    let width = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(78)) };
    let height = unsafe { GetSystemMetrics(SYSTEM_METRICS_INDEX(79)) };
    if width <= 0 || height <= 0 || width > 16_384 || height > 16_384 {
        return Err("Windows returned no valid virtual-screen bounds".into());
    }
    let width_u = width as u32;
    let height_u = height as u32;
    let pixel_bytes = (width_u as usize)
        .checked_mul(height_u as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Windows returned virtual-screen bounds too large to capture".to_owned())?;
    let mut pixels = Vec::new();
    pixels.try_reserve_exact(pixel_bytes).map_err(|error| {
        format!("Windows could not allocate the virtual-screen capture buffer: {error}")
    })?;
    pixels.resize(pixel_bytes, 0);
    let source = unsafe { GetDC(None) };
    if source.0.is_null() {
        return Err("Windows returned no virtual-screen device context".into());
    }
    let memory = unsafe { CreateCompatibleDC(Some(source)) };
    if memory.0.is_null() {
        unsafe {
            ReleaseDC(None, source);
        }
        return Err("Windows could not create a virtual-screen capture context".into());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(source, width, height) };
    if bitmap.0.is_null() {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
            ReleaseDC(None, source);
        }
        return Err("Windows could not allocate a virtual-screen capture bitmap".into());
    }
    let previous = unsafe { SelectObject(memory, HGDIOBJ(bitmap.0)) };
    if invalid_gdi_object(previous) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            ReleaseDC(None, source);
        }
        return Err(
            "Windows could not select the virtual-screen bitmap into its memory context".into(),
        );
    }
    let copied = unsafe {
        BitBlt(
            memory,
            0,
            0,
            width,
            height,
            Some(source),
            origin_x,
            origin_y,
            SRCCOPY,
        )
        .is_ok()
    };
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
    if let Err(error) = deselect_capture_bitmap(memory, bitmap, previous) {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            ReleaseDC(None, source);
        }
        return Err(error);
    }
    let read = if copied {
        unsafe {
            GetDIBits(
                memory,
                bitmap,
                0,
                height_u,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        }
    } else {
        0
    };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = windows::Win32::Graphics::Gdi::DeleteDC(memory);
        ReleaseDC(None, source);
    }
    if read != height {
        return Err("Windows could not read the virtual-screen capture".into());
    }
    Ok(NativeWindowCapture {
        data_url: png_data_url(width_u, height_u, &pixels)?,
        width: width_u,
        height: height_u,
        origin_x,
        origin_y,
    })
}

#[cfg(not(windows))]
pub fn capture_window(_window: usize) -> Result<NativeWindowCapture, String> {
    Err("native window capture is available only on Windows".into())
}

#[cfg(not(windows))]
pub fn capture_desktop() -> Result<NativeWindowCapture, String> {
    Err("native desktop capture is available only on Windows".into())
}
