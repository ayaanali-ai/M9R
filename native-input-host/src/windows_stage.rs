use serde_json::{json, Value};

const MAX_HANDLE: u64 = usize::MAX as u64;

fn popup_candidate_is_owned(
    root: usize,
    window: usize,
    owner: usize,
    pid: u32,
    candidate_pid: u32,
    visible: bool,
) -> bool {
    root != 0 && window != root && owner == root && pid == candidate_pid && visible
}

/// The real pointer position and explicit restore primitive used by the broker
/// when a task elects to return the user's pointer after native input.
#[cfg(windows)]
pub(crate) mod owner_pointer {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
        fn SetCursorPos(x: i32, y: i32) -> i32;
    }

    pub fn get_cursor_position() -> Result<(i32, i32), &'static str> {
        let mut point = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return Err("could not read the owner's pointer position");
        }
        Ok((point.x, point.y))
    }

    pub fn restore_cursor_position(x: i32, y: i32) -> Result<(), &'static str> {
        if unsafe { SetCursorPos(x, y) } == 0 {
            return Err("could not restore the owner's pointer position");
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) mod owner_pointer {
    pub fn get_cursor_position() -> Result<(i32, i32), &'static str> {
        Err("owner pointer position is available only on Windows")
    }
    pub fn restore_cursor_position(_x: i32, _y: i32) -> Result<(), &'static str> {
        Err("owner pointer position is available only on Windows")
    }
}

// A stage is a broker-owned mapping to a real HWND. M9R does not create or
// manage Windows virtual desktops.

fn parse_window_identity(value: &Value) -> Result<(u32, usize), &'static str> {
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .ok_or("invalid process id")? as u32;
    let handle_text = value
        .get("windowId")
        .and_then(Value::as_str)
        .ok_or("windowId must be a decimal or 0x-prefixed handle string")?;
    let handle = if let Some(hex) = handle_text
        .strip_prefix("0x")
        .or_else(|| handle_text.strip_prefix("0X"))
    {
        usize::from_str_radix(hex, 16).ok()
    } else {
        handle_text
            .parse::<u64>()
            .ok()
            .filter(|handle| *handle <= MAX_HANDLE)
            .map(|handle| handle as usize)
    }
    .filter(|handle| *handle != 0)
    .ok_or("invalid window handle")?;
    Ok((pid, handle))
}

/// Dispatches the local desktop-stage API. Stages bind to the owner's visible
/// Windows desktop; no request can create, inspect, activate, or move desktops.
pub fn handle_desktop_stage_request(value: &Value) -> Value {
    let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
    match value.get("op").and_then(Value::as_str) {
        Some("ping") => json!({"ok":true,"requestId":request_id}),
        #[cfg(windows)]
        Some("processGeneration") => {
            let result = value
                .get("pid")
                .and_then(Value::as_u64)
                .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
                .ok_or("invalid process id")
                .and_then(|pid| platform::process_generation(pid as u32));
            match result {
                Ok(generation) => json!({ "ok": true, "processGeneration": generation }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        Some("inspect") => {
            let result =
                parse_window_identity(value).and_then(|(pid, handle)| inspect_window(pid, handle));
            match result {
                Ok(window) => {
                    json!({ "ok": true, "requestId": request_id, "window": to_json(window) })
                }
                Err(error) => json!({ "ok": false, "requestId": request_id, "error": error }),
            }
        }
        #[cfg(windows)]
        Some("listOwnedWindows") => match platform::list_owned_windows(value) {
            Ok(windows) => json!({"ok":true,"requestId":request_id,"windows":windows}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("listVisibleWindows") => match platform::list_visible_windows() {
            Ok(windows) => json!({"ok":true,"requestId":request_id,"windows":windows}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("presentOwnerWindow") => match platform::present_owner_window(value) {
            Ok(window) => json!({"ok":true,"requestId":request_id,"window":to_json(window)}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("inspectPointControl" | "invokePointControl") => {
            let invoke = value["op"] == "invokePointControl";
            match crate::shell_accessibility::control_at_point(value, invoke) {
                Ok(control) => json!({"ok":true,"requestId":request_id,"control":control}),
                Err(error) => input_dispatch_failure(&request_id, error),
            }
        }
        #[cfg(windows)]
        Some("inspectDesktopStructure") => {
            match crate::shell_accessibility::desktop_structure(value) {
                Ok(structure) => {
                    json!({"ok":true,"requestId":request_id,"desktopStructure":structure})
                }
                Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
            }
        }
        #[cfg(windows)]
        Some("inspectWindowStructure") => {
            let result = parse_window_identity(value)
                .map_err(|error| error.to_string())
                .and_then(|(_, _)| crate::shell_accessibility::window_structure(value));
            match result {
                Ok(structure) => {
                    json!({"ok":true,"requestId":request_id,"windowStructure":structure})
                }
                Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
            }
        }
        #[cfg(windows)]
        Some("invokeWindowElement") => {
            let result = parse_window_identity(value)
                .map_err(crate::InputDispatchError::not_dispatched)
                .and_then(|(_, _)| crate::shell_accessibility::invoke_window_element(value));
            match result {
                Ok(semantic_action) => {
                    json!({"ok":true,"requestId":request_id,"semanticAction":semantic_action})
                }
                Err(error) => input_dispatch_failure(&request_id, error),
            }
        }
        #[cfg(windows)]
        Some("captureWindow") => {
            let result = parse_window_identity(value)
                .map_err(|error| error.to_string())
                .and_then(|(_, handle)| crate::native_screenshot::capture_window(handle));
            match result {
                Ok(capture) => json!({"ok":true,"requestId":request_id,"capture":{
                    "dataUrl":capture.data_url,"width":capture.width,"height":capture.height,
                    "originX":capture.origin_x,"originY":capture.origin_y
                }}),
                Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
            }
        }
        #[cfg(windows)]
        Some("captureDesktop") => match crate::native_screenshot::capture_desktop() {
            Ok(capture) => json!({"ok":true,"requestId":request_id,"capture":{
                "dataUrl":capture.data_url,"width":capture.width,"height":capture.height,
                "originX":capture.origin_x,"originY":capture.origin_y
            }}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("windowStatus") => match platform::window_status(value) {
            Ok(state) => json!({"ok":true,"requestId":request_id,"windowState":state}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        Some("systemControl") => match crate::system_controls::handle(value) {
            Ok(result) => json!({"ok":true,"requestId":request_id,"result":result}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("clipboardRead") => match platform::clipboard_read() {
            Ok(text) => {
                json!({"ok":true,"requestId":request_id,"result":{"text":text,"available":true}})
            }
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("clipboardWrite") => match value
            .get("text")
            .and_then(Value::as_str)
            .ok_or("clipboard text is required".to_string())
            .and_then(platform::clipboard_write)
        {
            Ok(()) => json!({"ok":true,"requestId":request_id,"result":{"written":true}}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("foregroundWindow") => match parse_window_identity(value).and_then(|(pid, handle)| {
            platform::verify_foreground_window(
                pid,
                handle,
                value.get("timeoutMs").and_then(Value::as_u64).unwrap_or(0),
            )
        }) {
            Ok(window) => json!({"ok":true,"requestId":request_id,"foregroundWindow":window}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("currentForegroundWindow") => match platform::current_foreground_window() {
            Ok(window) => json!({"ok":true,"requestId":request_id,"foregroundWindow":window}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("setWindowState") => match platform::set_window_state(value) {
            Ok(state) => json!({"ok":true,"requestId":request_id,"state":state}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("setWindowFrame") => match platform::set_window_frame(value) {
            Ok(rect) => json!({"ok":true,"requestId":request_id,"rect":rect}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("listOwnedPopups") => match platform::list_owned_popups(value) {
            Ok(windows) => json!({"ok":true,"requestId":request_id,"windows":windows}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("windowAtPoint") => match platform::window_at_point(value) {
            Ok((pid, hwnd, shell, keyboard_window, origin_x, origin_y)) => {
                json!({"ok":true,"requestId":request_id,"pointWindow":{"pid":pid,"windowId":hwnd.to_string(),"shell":shell,"keyboardWindow":keyboard_window,"screenOrigin":{"x":origin_x,"y":origin_y}}})
            }
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("windowRect") => match platform::window_rect(value) {
            Ok(rect) => json!({"ok":true,"requestId":request_id,"rect":rect}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("workArea") => match platform::work_area(value) {
            Ok(rect) => json!({"ok":true,"requestId":request_id,"rect":rect}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("bringToForeground") => match platform::bring_to_real_foreground(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("sendClick") => match platform::send_click(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendDrag") => match platform::send_drag(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendScroll") => match platform::send_scroll(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendKeyCombo") => match platform::send_key_combo(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendText") => match platform::send_text(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        Some("getCursorPosition") => match owner_pointer::get_cursor_position() {
            Ok((x, y)) => {
                json!({ "ok": true, "requestId": request_id, "position": { "x": x, "y": y } })
            }
            Err(error) => json!({ "ok": false, "requestId": request_id, "error": error }),
        },
        Some("restoreCursorPosition") => {
            let point = value
                .get("x")
                .and_then(Value::as_i64)
                .zip(value.get("y").and_then(Value::as_i64));
            match point {
                Some((x, y))
                    if (i32::MIN as i64..=i32::MAX as i64).contains(&x)
                        && (i32::MIN as i64..=i32::MAX as i64).contains(&y) =>
                {
                    match owner_pointer::restore_cursor_position(x as i32, y as i32) {
                        Ok(()) => json!({ "ok": true, "requestId": request_id }),
                        Err(error) => {
                            json!({ "ok": false, "requestId": request_id, "error": error })
                        }
                    }
                }
                _ => {
                    json!({ "ok": false, "requestId": request_id, "error": "invalid cursor restore coordinates" })
                }
            }
        }
        _ => {
            json!({ "ok": false, "requestId": request_id, "error": "unsupported desktop stage operation" })
        }
    }
}

fn input_dispatch_failure(request_id: &str, error: crate::InputDispatchError) -> Value {
    json!({
        "ok": false,
        "requestId": request_id,
        "dispatchState": error.state.as_str(),
        "error": error.message,
    })
}

#[derive(Debug)]
struct WindowIdentity {
    pid: u32,
    window_id: String,
    process_generation: String,
}

#[cfg(windows)]
fn inspect_window(pid: u32, window: usize) -> Result<WindowIdentity, &'static str> {
    platform::inspect_window(pid, window)
}

#[cfg(not(windows))]
fn inspect_window(_pid: u32, _window: usize) -> Result<WindowIdentity, &'static str> {
    Err("Windows desktop-stage inspection is available only on Windows")
}

fn to_json(window: WindowIdentity) -> Value {
    json!({
        "pid": window.pid,
        "windowId": window.window_id,
        "processGeneration": window.process_generation,
    })
}

#[cfg(windows)]
mod platform {
    #[repr(C)]
    #[derive(Default)]
    struct ProcessFileTime {
        low: u32,
        high: u32,
    }

    #[derive(Clone)]
    struct ProcessImageIdentity {
        name: String,
        path: String,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn QueryFullProcessImageNameW(
            handle: *mut std::ffi::c_void,
            flags: u32,
            image_name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn GetProcessTimes(
            process: *mut std::ffi::c_void,
            created: *mut ProcessFileTime,
            exited: *mut ProcessFileTime,
            kernel: *mut ProcessFileTime,
            user: *mut ProcessFileTime,
        ) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut std::ffi::c_void;
        fn GlobalLock(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn GlobalUnlock(memory: *mut std::ffi::c_void) -> i32;
        fn GlobalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }

    pub(super) fn process_generation(pid: u32) -> Result<String, &'static str> {
        let handle = unsafe { OpenProcess(0x1000, 0, pid) }; // PROCESS_QUERY_LIMITED_INFORMATION
        if handle.is_null() {
            return Err("process generation is unavailable");
        }
        let mut created = ProcessFileTime::default();
        let mut exited = ProcessFileTime::default();
        let mut kernel = ProcessFileTime::default();
        let mut user = ProcessFileTime::default();
        let ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        unsafe {
            CloseHandle(handle);
        }
        if ok == 0 || (created.high == 0 && created.low == 0) {
            return Err("process generation is unavailable");
        }
        Ok(format!("{:08x}{:08x}", created.high, created.low))
    }

    fn process_image_identity(pid: u32) -> Option<ProcessImageIdentity> {
        let handle = unsafe { OpenProcess(0x1000, 0, pid) }; // PROCESS_QUERY_LIMITED_INFORMATION
        if handle.is_null() {
            return None;
        }
        let mut image = vec![0u16; 32_768];
        let mut size = image.len() as u32;
        let ok =
            unsafe { QueryFullProcessImageNameW(handle, 0, image.as_mut_ptr(), &mut size) } != 0;
        unsafe {
            CloseHandle(handle);
        }
        if !ok || size == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&image[..size as usize]);
        let name = std::path::Path::new(&path)
            .file_name()?
            .to_string_lossy()
            .into_owned();
        Some(ProcessImageIdentity { name, path })
    }

    fn window_app_user_model_id(window: Hwnd) -> Option<String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::System::Com::StructuredStorage::{
            PropVariantClear, PropVariantToStringAlloc,
        };
        use windows::Win32::UI::Shell::PropertiesSystem::{
            IPropertyStore, SHGetPropertyStoreForWindow,
        };

        let store: IPropertyStore = unsafe { SHGetPropertyStoreForWindow(HWND(window)) }.ok()?;
        let mut value = unsafe { store.GetValue(&PKEY_AppUserModel_ID) }.ok()?;
        let allocated = unsafe { PropVariantToStringAlloc(&value) }.ok()?;
        let result = unsafe { allocated.to_string() }.ok();
        unsafe {
            CoTaskMemFree(Some(allocated.0.cast()));
            let _ = PropVariantClear(&mut value);
        }
        result.filter(|id| !id.trim().is_empty())
    }

    fn shell_application_view_collection() -> Option<OwnedInterface> {
        let mut shell = std::ptr::null_mut();
        let status = unsafe {
            CoCreateInstance(
                &CLSID_IMMERSIVE_SHELL,
                std::ptr::null_mut(),
                CLSCTX_ALL,
                &IID_SERVICE_PROVIDER,
                &mut shell,
            )
        };
        if status < 0 || shell.is_null() {
            return None;
        }
        let shell = OwnedInterface(shell);
        let provider = unsafe { &**(shell.value() as *mut *mut IServiceProviderVTable) };
        let mut collection = std::ptr::null_mut();
        let status = unsafe {
            (provider.query_service)(
                shell.value(),
                &IID_APPLICATION_VIEW_COLLECTION,
                &IID_APPLICATION_VIEW_COLLECTION,
                &mut collection,
            )
        };
        if status < 0 || collection.is_null() {
            return None;
        }
        OwnedInterface::new(collection).ok()
    }

    fn application_view_user_model_id(collection: Interface, window: Hwnd) -> Option<String> {
        let views = unsafe { &**(collection as *mut *mut ApplicationViewCollectionVTable) };
        let mut view = std::ptr::null_mut();
        let status = unsafe { (views.get_view_for_hwnd)(collection, window, &mut view) };
        if status < 0 || view.is_null() {
            return None;
        }
        let view = OwnedInterface(view);
        let vtable = unsafe { &**(view.value() as *mut *mut ApplicationViewVTable) };
        let mut allocated = std::ptr::null_mut();
        let status = unsafe { (vtable.get_app_user_model_id)(view.value(), &mut allocated) };
        if status < 0 || allocated.is_null() {
            return None;
        }
        let mut length = 0usize;
        unsafe {
            while length < 512 && *allocated.add(length) != 0 {
                length += 1;
            }
        }
        let result = if length == 0 || length == 512 {
            None
        } else {
            Some(String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(allocated, length)
            }))
        };
        unsafe {
            windows::Win32::System::Com::CoTaskMemFree(Some(allocated.cast()));
        }
        result.filter(|id| !id.trim().is_empty())
    }

    fn is_dwm_cloaked(window: Hwnd) -> bool {
        let mut cloak_state = 0u32;
        let status = unsafe {
            DwmGetWindowAttribute(
                window,
                DWMWA_CLOAKED,
                &mut cloak_state as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        status >= 0 && cloak_state != 0
    }
    use super::WindowIdentity;
    use std::ffi::c_void;

    type HResult = i32;
    type Hwnd = *mut c_void;
    type Interface = *mut c_void;

    const SW_SHOWNA: i32 = 8;
    const SW_SHOWNOACTIVATE: i32 = 4;
    const SWP_NOSIZE_NOMOVE_NOACTIVATE_SHOWWINDOW: u32 = 0x53;
    const SWP_NOZORDER: u32 = 0x04;

    #[repr(C)]
    struct GuidRaw {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const CLSID_IMMERSIVE_SHELL: GuidRaw = GuidRaw {
        data1: 0xc2f03a33,
        data2: 0x21f5,
        data3: 0x47fa,
        data4: [0xb4, 0xbb, 0x15, 0x63, 0x62, 0xa2, 0xf2, 0x39],
    };
    const IID_SERVICE_PROVIDER: GuidRaw = GuidRaw {
        data1: 0x6d5140c1,
        data2: 0x7436,
        data3: 0x11ce,
        data4: [0x80, 0x34, 0x00, 0xaa, 0x00, 0x60, 0x09, 0xfa],
    };
    const IID_APPLICATION_VIEW_COLLECTION: GuidRaw = GuidRaw {
        data1: 0x1841c6d7,
        data2: 0x4f9d,
        data3: 0x42c0,
        data4: [0xaf, 0x41, 0x87, 0x47, 0x53, 0x8f, 0x10, 0xe5],
    };
    const CLSCTX_ALL: u32 = 0x17;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;

    type QueryInterfaceFn =
        unsafe extern "system" fn(Interface, *const GuidRaw, *mut Interface) -> HResult;
    type AddRefFn = unsafe extern "system" fn(Interface) -> u32;
    type ReleaseFn = unsafe extern "system" fn(Interface) -> u32;

    #[repr(C)]
    struct IServiceProviderVTable {
        query_interface: QueryInterfaceFn,
        add_ref: AddRefFn,
        release: ReleaseFn,
        query_service: unsafe extern "system" fn(
            Interface,
            *const GuidRaw,
            *const GuidRaw,
            *mut Interface,
        ) -> HResult,
    }

    // Only the prefix through GetViewForHwnd is needed. Never resolve a different
    // process/main window when the owner's exact HWND cannot be represented.
    #[repr(C)]
    struct ApplicationViewCollectionVTable {
        query_interface: QueryInterfaceFn,
        add_ref: AddRefFn,
        release: ReleaseFn,
        get_views: unsafe extern "system" fn(Interface, *mut Interface) -> HResult,
        get_views_by_z_order: unsafe extern "system" fn(Interface, *mut Interface) -> HResult,
        get_views_by_app_user_model_id:
            unsafe extern "system" fn(Interface, *const u16, *mut Interface) -> HResult,
        get_view_for_hwnd: unsafe extern "system" fn(Interface, Hwnd, *mut Interface) -> HResult,
    }

    // IApplicationView::GetAppUserModelId identifies the packaged app hosted
    // inside a generic ApplicationFrameWindow. The outer HWND's property
    // store often has no app ID of its own.
    #[repr(C)]
    struct ApplicationViewVTable {
        query_interface: QueryInterfaceFn,
        add_ref: AddRefFn,
        release: ReleaseFn,
        // IApplicationView is an IInspectable interface. These three slots
        // are part of its ABI and must precede the application-view methods;
        // omitting them shifts every call and can invoke a method with the
        // wrong signature (which crashed window enumeration for packaged apps).
        get_iids: unsafe extern "system" fn(Interface, *mut u32, *mut *mut GuidRaw) -> HResult,
        get_runtime_class_name: unsafe extern "system" fn(Interface, *mut *mut c_void) -> HResult,
        get_trust_level: unsafe extern "system" fn(Interface, *mut i32) -> HResult,
        set_focus: unsafe extern "system" fn(Interface) -> HResult,
        switch_to: unsafe extern "system" fn(Interface) -> HResult,
        try_invoke_back: unsafe extern "system" fn(Interface, Interface) -> HResult,
        get_thumbnail_window: unsafe extern "system" fn(Interface, *mut Hwnd) -> HResult,
        get_monitor: unsafe extern "system" fn(Interface, *mut Interface) -> HResult,
        get_visibility: unsafe extern "system" fn(Interface, *mut i32) -> HResult,
        set_cloak: unsafe extern "system" fn(Interface, i32, i32) -> HResult,
        get_position:
            unsafe extern "system" fn(Interface, *const GuidRaw, *mut Interface) -> HResult,
        set_position: unsafe extern "system" fn(Interface, Interface) -> HResult,
        insert_after_window: unsafe extern "system" fn(Interface, Hwnd) -> HResult,
        get_extended_frame_position: unsafe extern "system" fn(Interface, *mut Rect) -> HResult,
        get_app_user_model_id: unsafe extern "system" fn(Interface, *mut *mut u16) -> HResult,
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> HResult;
        fn CoUninitialize();
        fn CoCreateInstance(
            class_id: *const GuidRaw,
            outer: Interface,
            context: u32,
            interface_id: *const GuidRaw,
            result: *mut Interface,
        ) -> HResult;
    }

    /// A COM apartment for the UIA/AppUserModelId lookups below. If this
    /// thread was already initialized in a different apartment model, COM is
    /// still usable; in that case we must not balance somebody else's init.
    struct ComApartment {
        uninitialize: bool,
    }

    impl ComApartment {
        fn initialize() -> Result<Self, &'static str> {
            const S_OK: HResult = 0;
            const S_FALSE: HResult = 1;
            const RPC_E_CHANGED_MODE: HResult = 0x8001_0106u32 as i32;
            let result = unsafe { CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED) };
            match result {
                S_OK | S_FALSE => Ok(Self { uninitialize: true }),
                RPC_E_CHANGED_MODE => Ok(Self {
                    uninitialize: false,
                }),
                _ => Err("Windows COM initialization failed"),
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.uninitialize {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    struct OwnedInterface(Interface);

    impl OwnedInterface {
        fn new(value: Interface) -> Result<Self, &'static str> {
            if value.is_null() {
                Err("Windows returned an empty COM interface")
            } else {
                Ok(Self(value))
            }
        }

        fn value(&self) -> Interface {
            self.0
        }
    }

    impl Drop for OwnedInterface {
        fn drop(&mut self) {
            if !self.0.is_null() {
                let vtable = unsafe { &**(self.0 as *mut *mut IServiceProviderVTable) };
                unsafe {
                    (vtable.release)(self.0);
                }
            }
        }
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn IsWindow(window: Hwnd) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn ShowWindow(window: Hwnd, command: i32) -> i32;
        fn ShowWindowAsync(window: Hwnd, command: i32) -> i32;
        fn IsIconic(window: Hwnd) -> i32;
        fn IsZoomed(window: Hwnd) -> i32;
        fn IsWindowVisible(window: Hwnd) -> i32;
        fn SetWindowPos(
            window: Hwnd,
            after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
        fn FlashWindowEx(info: *const FlashWindowInfo) -> i32;
        fn EnumWindows(
            callback: unsafe extern "system" fn(Hwnd, isize) -> i32,
            parameter: isize,
        ) -> i32;
        fn GetWindowTextW(window: Hwnd, buffer: *mut u16, count: i32) -> i32;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
        fn GetWindowRect(window: Hwnd, rect: *mut Rect) -> i32;
        fn MonitorFromWindow(window: Hwnd, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
        fn WindowFromPoint(point: Point) -> Hwnd;
        fn GetAncestor(window: Hwnd, flags: u32) -> Hwnd;
        fn GetClassNameW(window: Hwnd, buffer: *mut u16, count: i32) -> i32;
        fn OpenClipboard(window: Hwnd) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> Hwnd;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, memory: Hwnd) -> Hwnd;
    }

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmGetWindowAttribute(
            window: Hwnd,
            attribute: u32,
            value: *mut c_void,
            size: u32,
        ) -> HResult;
    }

    const DWMWA_CLOAKED: u32 = 14;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    fn validate_window(pid: u32, handle: usize) -> Result<Hwnd, &'static str> {
        let window = handle as Hwnd;
        if window.is_null() || unsafe { IsWindow(window) } == 0 {
            return Err("window handle is no longer valid");
        }
        let mut actual_pid = 0;
        if unsafe { GetWindowThreadProcessId(window, &mut actual_pid) } == 0 || actual_pid != pid {
            return Err("window handle does not belong to the supplied process id");
        }
        Ok(window)
    }

    pub(super) fn inspect_window(pid: u32, handle: usize) -> Result<WindowIdentity, &'static str> {
        let window = validate_window(pid, handle)?;
        Ok(WindowIdentity {
            pid,
            window_id: (window as usize).to_string(),
            process_generation: process_generation(pid)?,
        })
    }

    pub(super) fn list_owned_popups(
        value: &serde_json::Value,
    ) -> Result<Vec<serde_json::Value>, &'static str> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let root = validate_window(pid, handle)?;
        struct Search {
            root: Hwnd,
            pid: u32,
            windows: Vec<serde_json::Value>,
        }
        unsafe extern "system" fn visit(window: Hwnd, parameter: isize) -> i32 {
            let search = &mut *(parameter as *mut Search);
            let mut pid = 0;
            GetWindowThreadProcessId(window, &mut pid);
            if !super::popup_candidate_is_owned(
                search.root as usize,
                window as usize,
                GetAncestor(window, 3) as usize,
                search.pid,
                pid,
                IsWindowVisible(window) != 0,
            ) {
                return 1;
            }
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(window, &mut rect) == 0 {
                return 1;
            }
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width <= 0 || height <= 0 {
                return 1;
            }
            search.windows.push(serde_json::json!({"pid":pid,"windowId":(window as usize).to_string(),"title":"Owned popup","width":width,"height":height}));
            if search.windows.len() >= 8 {
                0
            } else {
                1
            }
        }
        let mut search = Search {
            root,
            pid,
            windows: Vec::new(),
        };
        let ok = unsafe { EnumWindows(visit, &mut search as *mut Search as isize) };
        if ok == 0 && search.windows.len() < 8 {
            return Err("owned popup enumeration failed");
        }
        Ok(search.windows)
    }

    pub(super) fn clipboard_read() -> Result<String, String> {
        const CF_UNICODETEXT: u32 = 13;
        if unsafe { OpenClipboard(std::ptr::null_mut()) } == 0 {
            return Err("Windows could not open the shared clipboard".into());
        }
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
        if handle.is_null() {
            unsafe {
                CloseClipboard();
            }
            return Ok(String::new());
        }
        let pointer = unsafe { GlobalLock(handle) } as *const u16;
        if pointer.is_null() {
            unsafe {
                CloseClipboard();
            }
            return Err("Windows could not read the shared clipboard".into());
        }
        let mut length = 0usize;
        while length < 1_048_576 && unsafe { *pointer.add(length) } != 0 {
            length += 1;
        }
        let text = unsafe { std::slice::from_raw_parts(pointer, length) };
        let value = String::from_utf16_lossy(text);
        unsafe {
            GlobalUnlock(handle);
            CloseClipboard();
        }
        Ok(value)
    }

    pub(super) fn clipboard_write(text: &str) -> Result<(), String> {
        const CF_UNICODETEXT: u32 = 13;
        const GMEM_MOVEABLE: u32 = 0x0002;
        let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let memory =
            unsafe { GlobalAlloc(GMEM_MOVEABLE, units.len() * std::mem::size_of::<u16>()) };
        if memory.is_null() {
            return Err("Windows could not allocate clipboard storage".into());
        }
        let pointer = unsafe { GlobalLock(memory) } as *mut u16;
        if pointer.is_null() {
            unsafe {
                GlobalFree(memory);
            }
            return Err("Windows could not lock clipboard storage".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len());
            GlobalUnlock(memory);
        }
        if unsafe { OpenClipboard(std::ptr::null_mut()) } == 0 {
            unsafe {
                GlobalFree(memory);
            }
            return Err("Windows could not open the shared clipboard".into());
        }
        if unsafe { EmptyClipboard() } == 0
            || unsafe { SetClipboardData(CF_UNICODETEXT, memory).is_null() }
        {
            unsafe {
                CloseClipboard();
                GlobalFree(memory);
            }
            return Err("Windows could not write the shared clipboard".into());
        }
        unsafe {
            CloseClipboard();
        }
        Ok(())
    }

    pub(super) fn set_window_state(
        value: &serde_json::Value,
    ) -> Result<&'static str, &'static str> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        let (command, state) = match value["state"].as_str() {
            Some("minimized") => (6, "minimized"),
            Some("maximized") => (3, "maximized"),
            Some("restored") => (9, "restored"),
            _ => return Err("invalid window state"),
        };
        unsafe {
            ShowWindow(window, command);
        }
        let verified = match state {
            "minimized" => unsafe { IsIconic(window) != 0 },
            "maximized" => unsafe { IsZoomed(window) != 0 },
            _ => unsafe { IsIconic(window) == 0 && IsZoomed(window) == 0 },
        };
        if !verified {
            return Err("requested window state was not verified");
        }
        Ok(state)
    }

    pub(super) fn set_window_frame(value: &serde_json::Value) -> Result<serde_json::Value, String> {
        let (pid, handle) = super::parse_window_identity(value).map_err(str::to_owned)?;
        let window = validate_window(pid, handle).map_err(str::to_owned)?;
        let integer = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_i64)
                .filter(|n| *n >= -32_768 && *n <= 32_768)
                .map(|n| n as i32)
                .ok_or_else(|| format!("invalid window frame {key}"))
        };
        let x = integer("x")?;
        let y = integer("y")?;
        let width = integer("width")?.max(80);
        let height = integer("height")?.max(60);
        const SWP_NOACTIVATE: u32 = 0x0010;
        const SWP_SHOWWINDOW: u32 = 0x0040;
        if unsafe {
            SetWindowPos(
                window,
                std::ptr::null_mut(),
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        } == 0
        {
            return Err("Windows declined to set the requested window frame".into());
        }
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(window, &mut rect) } == 0 {
            return Err("Windows did not return the updated window frame".into());
        }
        Ok(
            serde_json::json!({"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top}),
        )
    }

    pub(super) fn window_status(value: &serde_json::Value) -> Result<&'static str, &'static str> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = handle as Hwnd;
        if unsafe { IsWindow(window) } == 0 {
            return Ok("closed");
        }
        let window = validate_window(pid, handle)?;
        if unsafe { IsIconic(window) } != 0 {
            return Ok("minimized");
        }
        if unsafe { IsWindowVisible(window) } == 0 {
            return Ok("hidden");
        }
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(window, &mut rect) } == 0 {
            return Err("could not read window bounds");
        }
        let center = Point {
            x: rect.left + (rect.right - rect.left) / 2,
            y: rect.top + (rect.bottom - rect.top) / 2,
        };
        let top = unsafe { GetAncestor(WindowFromPoint(center), 2) };
        Ok(if top != window { "occluded" } else { "visible" })
    }

    pub(super) fn verify_foreground_window(
        pid: u32,
        expected: usize,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, &'static str> {
        if timeout_ms > 1_000 {
            return Err("foreground verification timeout exceeds its limit");
        }
        let expected_window = validate_window(pid, expected)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let window = unsafe { GetForegroundWindow() };
            let mut actual_pid = 0;
            if !window.is_null()
                && unsafe { GetWindowThreadProcessId(window, &mut actual_pid) } != 0
                && window == expected_window
                && actual_pid == pid
            {
                return Ok(
                    serde_json::json!({ "pid": actual_pid, "windowId": (window as usize).to_string() }),
                );
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Err("Windows did not confirm the selected application as the foreground window")
    }

    /// Reads the actual foreground HWND without activating or moving anything.
    /// This is the binding primitive for vague requests such as "look at my
    /// screen" or "I'm on Chrome"; the caller may then attach this exact
    /// window to an owner-preview stage before observing it.
    pub(super) fn current_foreground_window() -> Result<serde_json::Value, &'static str> {
        let window = unsafe { GetForegroundWindow() };
        if window.is_null() {
            return Err("Windows returned no foreground window");
        }
        let mut pid = 0;
        if unsafe { GetWindowThreadProcessId(window, &mut pid) } == 0 || pid == 0 {
            return Err("Windows returned no foreground process identity");
        }
        super::inspect_window(pid, window as usize)?;
        let mut title = [0u16; 512];
        let title_len = unsafe { GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32) }
            .max(0) as usize;
        let mut class_name = [0u16; 256];
        let class_len =
            unsafe { GetClassNameW(window, class_name.as_mut_ptr(), class_name.len() as i32) }
                .max(0) as usize;
        Ok(serde_json::json!({
            "pid": pid,
            "windowId": (window as usize).to_string(),
            "title": String::from_utf16_lossy(&title[..title_len.min(title.len())]),
            "className": String::from_utf16_lossy(&class_name[..class_len.min(class_name.len())]),
            "visible": unsafe { IsWindowVisible(window) != 0 },
            "minimized": unsafe { IsIconic(window) != 0 },
        }))
    }

    pub(super) fn window_at_point(
        value: &serde_json::Value,
    ) -> Result<(u32, usize, bool, bool, i32, i32), &'static str> {
        let coordinate = |key| {
            value
                .get(key)
                .and_then(serde_json::Value::as_i64)
                .and_then(|number| i32::try_from(number).ok())
                .filter(|number| (-32768..=32767).contains(number))
        };
        let point = Point {
            x: coordinate("x").ok_or("invalid screen x coordinate")?,
            y: coordinate("y").ok_or("invalid screen y coordinate")?,
        };
        // Native hit testing respects the actual shell/control hit-test regions;
        // overlapping bounding rectangles include transparent input/overlay windows.
        let child = unsafe { WindowFromPoint(point) };
        if child.is_null() {
            return Err("No input window exists at that screen point");
        }
        let root = unsafe { GetAncestor(child, 2) }; // GA_ROOT, preserving the exact window hierarchy.
        if root.is_null() || unsafe { IsWindow(root) } == 0 {
            return Err("The hit-tested window disappeared");
        }
        let mut bounds = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(root, &mut bounds) } == 0
            || bounds.right <= bounds.left
            || bounds.bottom <= bounds.top
        {
            return Err("Windows could not read the hit-tested window bounds");
        }
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(root, &mut pid);
        }
        if pid == 0 {
            return Err("The hit-tested window has no process identity");
        }
        let mut class_buffer = [0u16; 256];
        let length = unsafe { GetClassNameW(root, class_buffer.as_mut_ptr(), 256) };
        let class = String::from_utf16_lossy(&class_buffer[..length.max(0) as usize]);
        Ok((
            pid,
            root as usize,
            matches!(
                class.as_str(),
                "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow"
            ),
            class == "Windows.UI.Core.CoreWindow",
            bounds.left,
            bounds.top,
        ))
    }
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfo {
        size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
    }

    #[repr(C)]
    struct FlashWindowInfo {
        size: u32,
        window: Hwnd,
        flags: u32,
        count: u32,
        timeout_ms: u32,
    }

    /// Launch discovery must include hidden top-level windows. Cua's user-facing
    /// window inventory is not an ownership handshake for a hidden new process.
    pub(super) fn list_owned_windows(
        value: &serde_json::Value,
    ) -> Result<Vec<serde_json::Value>, String> {
        let pid = value
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
            .ok_or("invalid owned process id")? as u32;
        let _apartment = ComApartment::initialize().ok();
        let application_views = _apartment
            .as_ref()
            .and_then(|_| shell_application_view_collection());
        struct Search {
            pid: u32,
            windows: Vec<serde_json::Value>,
            process_image: Option<ProcessImageIdentity>,
            application_views: Option<Interface>,
            com_initialized: bool,
        }
        unsafe extern "system" fn visit(window: Hwnd, parameter: isize) -> i32 {
            let search = unsafe { &mut *(parameter as *mut Search) };
            let mut actual_pid = 0;
            unsafe {
                GetWindowThreadProcessId(window, &mut actual_pid);
            }
            if actual_pid != search.pid {
                return 1;
            }
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mut title = [0u16; 256];
            let length = unsafe { GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32) };
            if length <= 0 || unsafe { GetWindowRect(window, &mut rect) } == 0 {
                return 1;
            }
            let width = rect.right.saturating_sub(rect.left);
            let height = rect.bottom.saturating_sub(rect.top);
            if width < 80 || height < 60 {
                return 1;
            }
            let mut class_name = [0u16; 256];
            let class_len =
                unsafe { GetClassNameW(window, class_name.as_mut_ptr(), class_name.len() as i32) }
                    .max(0) as usize;
            let class_name = String::from_utf16_lossy(&class_name[..class_len]);
            let app_user_model_id = if search.com_initialized
                && matches!(
                    class_name.as_str(),
                    "ApplicationFrameWindow" | "ApplicationFrameHost"
                ) {
                search
                    .application_views
                    .and_then(|collection| application_view_user_model_id(collection, window))
                    .or_else(|| window_app_user_model_id(window))
            } else {
                window_app_user_model_id(window)
            };
            let z_order = search.windows.len();
            search.windows.push(serde_json::json!({"pid":actual_pid,"windowId":(window as usize).to_string(),
                "title":String::from_utf16_lossy(&title[..length as usize]),"width":width,"height":height,
                "className":class_name,"processName":search.process_image.as_ref().map(|image| image.name.as_str()),
                "processPath":search.process_image.as_ref().map(|image| image.path.as_str()),
                "appUserModelId":app_user_model_id,"zOrder":z_order}));
            1
        }
        let mut search = Search {
            pid,
            windows: Vec::new(),
            process_image: process_image_identity(pid),
            application_views: application_views.as_ref().map(OwnedInterface::value),
            com_initialized: _apartment.is_some(),
        };
        let enumerated = unsafe { EnumWindows(visit, &mut search as *mut Search as isize) };
        if enumerated == 0 {
            return Err("Windows owned-window enumeration failed".into());
        }
        Ok(search.windows)
    }

    /// Enumerate visible top-level app windows from the public Win32 API. This
    /// is intentionally independent of the Cua window inventory so packaged
    /// UWP launchers (which hand off to ApplicationFrameHost) are observable
    /// even when the launcher PID exits immediately.
    pub(super) fn list_visible_windows() -> Result<Vec<serde_json::Value>, String> {
        // Windows can keep ApplicationFrameHost shells visible to Win32 while
        // DWM has cloaked them. Exclude those OS-hidden surfaces before they
        // enter the app inventory, otherwise every packaged-app launch can
        // appear ambiguous even when the user has no such app open.
        let _apartment = ComApartment::initialize().ok();
        let application_views = _apartment
            .as_ref()
            .and_then(|_| shell_application_view_collection());
        struct Search {
            windows: Vec<serde_json::Value>,
            application_views: Option<Interface>,
            process_images: std::collections::HashMap<u32, Option<ProcessImageIdentity>>,
            com_initialized: bool,
        }
        unsafe extern "system" fn visit(window: Hwnd, parameter: isize) -> i32 {
            let search = unsafe { &mut *(parameter as *mut Search) };
            if unsafe { IsWindowVisible(window) } == 0
                || unsafe { IsIconic(window) } != 0
                || is_dwm_cloaked(window)
            {
                return 1;
            }
            let mut rect = Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if unsafe { GetWindowRect(window, &mut rect) } == 0 {
                return 1;
            }
            let width = rect.right.saturating_sub(rect.left);
            let height = rect.bottom.saturating_sub(rect.top);
            if width < 80 || height < 60 {
                return 1;
            }
            let mut pid = 0;
            unsafe {
                GetWindowThreadProcessId(window, &mut pid);
            }
            if pid == 0 {
                return 1;
            }
            let mut title = [0u16; 512];
            let title_len =
                unsafe { GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32) }.max(0)
                    as usize;
            let mut class_name = [0u16; 256];
            let class_len =
                unsafe { GetClassNameW(window, class_name.as_mut_ptr(), class_name.len() as i32) }
                    .max(0) as usize;
            let class_name = String::from_utf16_lossy(&class_name[..class_len]);
            let app_user_model_id = if search.com_initialized
                && matches!(
                    class_name.as_str(),
                    "ApplicationFrameWindow" | "ApplicationFrameHost"
                ) {
                search
                    .application_views
                    .and_then(|collection| application_view_user_model_id(collection, window))
                    .or_else(|| window_app_user_model_id(window))
            } else {
                None
            };
            let process_image = search
                .process_images
                .entry(pid)
                .or_insert_with(|| process_image_identity(pid))
                .clone();
            let z_order = search.windows.len();
            search.windows.push(serde_json::json!({
                "pid": pid,
                "windowId": (window as usize).to_string(),
                "zOrder": z_order,
                "title": String::from_utf16_lossy(&title[..title_len]),
                "className": class_name,
                "processName": process_image.as_ref().map(|image| image.name.as_str()),
                "processPath": process_image.as_ref().map(|image| image.path.as_str()),
                "appUserModelId": app_user_model_id,
                "x": rect.left,
                "y": rect.top,
                "width": width,
                "height": height,
                "visible": true,
            }));
            1
        }
        let mut search = Search {
            windows: Vec::new(),
            application_views: application_views.as_ref().map(OwnedInterface::value),
            process_images: std::collections::HashMap::new(),
            com_initialized: _apartment.is_some(),
        };
        if unsafe { EnumWindows(visit, &mut search as *mut Search as isize) } == 0 {
            return Err("Windows visible-window enumeration failed".into());
        }
        Ok(search.windows)
    }

    /// Present an exact application requested on the owner's current desktop.
    /// Show above ordinary windows without stealing keyboard focus or moving
    /// the hardware pointer. Actual input remains bound to the exact control.
    pub(super) fn present_owner_window(
        value: &serde_json::Value,
    ) -> Result<WindowIdentity, String> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        // This path only shows the exact owner-visible HWND. It deliberately
        // does not query, switch, or move Windows virtual desktops.
        // Keep an existing window's size and restore minimized windows without
        // activation. Never use SW_SHOWMAXIMIZED here; it activates the app.
        let command = if unsafe { IsIconic(window) } != 0 {
            SW_SHOWNOACTIVATE
        } else {
            SW_SHOWNA
        };
        unsafe {
            ShowWindowAsync(window, command);
        }
        // Keep the current app above the requested app. Do not pass HWND_TOP:
        // that was the regression which shoved owner-preview windows over the
        // user's active app despite SWP_NOACTIVATE. If this app is already
        // foreground, preserve its existing order instead of self-inserting.
        let foreground = unsafe { GetForegroundWindow() };
        let (after, flags) = if !foreground.is_null() && foreground != window {
            (foreground, SWP_NOSIZE_NOMOVE_NOACTIVATE_SHOWWINDOW)
        } else {
            (
                std::ptr::null_mut(),
                SWP_NOSIZE_NOMOVE_NOACTIVATE_SHOWWINDOW | SWP_NOZORDER,
            )
        };
        if unsafe { SetWindowPos(window, after, 0, 0, 0, 0, flags) } == 0 {
            return Err("Windows did not present the requested application window".into());
        }
        let flash = FlashWindowInfo {
            size: std::mem::size_of::<FlashWindowInfo>() as u32,
            window,
            flags: 0x2,
            count: 3,
            timeout_ms: 0,
        }; // FLASHW_TRAY; signal the user without activation.
        unsafe {
            FlashWindowEx(&flash);
        }
        validate_window(pid, handle)?;
        if unsafe { IsWindowVisible(window) } == 0 {
            return Err("Windows did not show the requested application window".into());
        }
        Ok(WindowIdentity {
            pid,
            window_id: handle.to_string(),
            process_generation: process_generation(pid)?,
        })
    }

    /// Reads a window's real screen bounds (including its title bar and
    /// borders, the same frame Cua Driver's own window-state bounds describe)
    /// directly, with no dependency on Cua Driver for it.
    pub(super) fn window_rect(value: &serde_json::Value) -> Result<serde_json::Value, String> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(window, &mut rect) } == 0
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return Err("Windows returned no valid window bounds".into());
        }
        Ok(
            serde_json::json!({ "x": rect.left, "y": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top }),
        )
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    /// Reads the real usable work area of whichever monitor the window is
    /// currently on -- the screen bounds with the taskbar (and any other
    /// registered app-bar) already subtracted, on whichever edge it is
    /// docked to, for that specific monitor in a multi-monitor setup. A
    /// snap/dock computed from this can never cover the taskbar, unlike one
    /// computed from the full screen or monitor bounds.
    pub(super) fn work_area(value: &serde_json::Value) -> Result<serde_json::Value, String> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
        if monitor == 0 {
            return Err("Windows could not resolve a monitor for the target window".into());
        }
        let mut info = MonitorInfo {
            size: std::mem::size_of::<MonitorInfo>() as u32,
            monitor: Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            work: Rect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            flags: 0,
        };
        if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
            return Err("Windows returned no monitor information".into());
        }
        let work = info.work;
        if work.right <= work.left || work.bottom <= work.top {
            return Err("Windows returned no valid monitor work area".into());
        }
        Ok(
            serde_json::json!({ "x": work.left, "y": work.top, "width": work.right - work.left, "height": work.bottom - work.top }),
        )
    }

    /// Raises the given owned window to the real OS foreground -- the one
    /// `SendInput` keyboard events actually reach -- not merely to the front
    /// of the Z-order. Every raw-input dispatch op below requires this to
    /// have been confirmed first; none of them raise a window themselves.
    pub(super) fn bring_to_real_foreground(value: &serde_json::Value) -> Result<(), String> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        crate::win32::bring_window_to_real_foreground(window as usize).map_err(str::to_owned)
    }

    fn require_real_foreground(pid: u32, handle: usize) -> Result<Hwnd, crate::InputDispatchError> {
        let window = validate_window(pid, handle)?;
        if unsafe { GetForegroundWindow() } != window {
            return Err(crate::InputDispatchError::not_dispatched("the target window is not the real OS foreground window; bring it to the foreground before sending raw input"));
        }
        Ok(window)
    }

    fn screen_point(
        value: &serde_json::Value,
        x_key: &str,
        y_key: &str,
    ) -> Result<(i32, i32), crate::InputDispatchError> {
        let x = value
            .get(x_key)
            .and_then(serde_json::Value::as_i64)
            .filter(|n| (-32_768..=32_767).contains(n))
            .ok_or_else(|| crate::InputDispatchError::not_dispatched(format!("invalid {x_key}")))?
            as i32;
        let y = value
            .get(y_key)
            .and_then(serde_json::Value::as_i64)
            .filter(|n| (-32_768..=32_767).contains(n))
            .ok_or_else(|| crate::InputDispatchError::not_dispatched(format!("invalid {y_key}")))?
            as i32;
        Ok((x, y))
    }

    /// Sends a real click at an absolute screen point via `SendInput`, after
    /// confirming the target is the real foreground window. The caller
    /// supplies final screen coordinates already resolved from whatever
    /// local/window space it observed -- this does no coordinate mapping.
    pub(super) fn send_click(value: &serde_json::Value) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        require_real_foreground(pid, handle)?;
        let (x, y) = screen_point(value, "x", "y")?;
        let button = match value
            .get("button")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("left")
        {
            "left" => crate::MouseButton::Left,
            "right" => crate::MouseButton::Right,
            "middle" => crate::MouseButton::Middle,
            other => {
                return Err(crate::InputDispatchError::not_dispatched(format!(
                    "unsupported mouse button \"{other}\""
                )))
            }
        };
        let count = value
            .get("count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 3) as u32;
        crate::win32::send_click_at_screen_point(x, y, button, count)
    }

    /// Presses and releases a left-button drag between two absolute screen
    /// points, after confirming the target is the real foreground window.
    pub(super) fn send_drag(value: &serde_json::Value) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        require_real_foreground(pid, handle)?;
        let (from_x, from_y) = screen_point(value, "fromX", "fromY")?;
        let (to_x, to_y) = screen_point(value, "toX", "toY")?;
        let duration_ms = value
            .get("durationMs")
            .and_then(serde_json::Value::as_u64)
            .map(|ms| ms.clamp(1, 10_000) as u32)
            .unwrap_or(250);
        crate::win32::send_drag(from_x, from_y, to_x, to_y, duration_ms)
    }

    /// Scrolls the mouse wheel at an absolute screen point, after confirming
    /// the target is the real foreground window. `amount` is in wheel clicks;
    /// negative scrolls down/left. The axis is explicit so horizontal wheel
    /// input does not fall back to the retired semantic driver.
    pub(super) fn send_scroll(value: &serde_json::Value) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        require_real_foreground(pid, handle)?;
        let (x, y) = screen_point(value, "x", "y")?;
        let amount = value
            .get("amount")
            .and_then(serde_json::Value::as_i64)
            .filter(|n| (-100..=100).contains(n))
            .ok_or_else(|| crate::InputDispatchError::not_dispatched("invalid scroll amount"))?
            as i32;
        if amount == 0 {
            return Err(crate::InputDispatchError::not_dispatched(
                "scroll amount must not be zero",
            ));
        }
        let horizontal = value
            .get("axis")
            .and_then(serde_json::Value::as_str)
            .map(|axis| match axis {
                "horizontal" => Ok(true),
                "vertical" | "" => Ok(false),
                _ => Err(crate::InputDispatchError::not_dispatched(
                    "invalid scroll axis",
                )),
            })
            .transpose()?
            .unwrap_or(false);
        crate::win32::send_scroll_at_screen_point_axis(x, y, amount, horizontal)
    }

    /// Presses one key or a modifier-combination hotkey (1-4 names, pressed in
    /// order and released in reverse), after confirming the target is the
    /// real foreground window. Each name is resolved the same way
    /// `task-stage-actions.ts`'s key-name validation already accepts them.
    pub(super) fn send_key_combo(
        value: &serde_json::Value,
    ) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        require_real_foreground(pid, handle)?;
        let names = value
            .get("keys")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                crate::InputDispatchError::not_dispatched(
                    "keys must be a non-empty array of 1-4 key names",
                )
            })?;
        if names.is_empty() || names.len() > 4 {
            return Err(crate::InputDispatchError::not_dispatched(
                "keys must contain 1-4 key names",
            ));
        }
        let mut keys = Vec::with_capacity(names.len());
        for name in names {
            let name = name.as_str().ok_or_else(|| {
                crate::InputDispatchError::not_dispatched("each key name must be a string")
            })?;
            let (vk, extended) = crate::win32::vk_for_key_name(name).ok_or_else(|| {
                crate::InputDispatchError::not_dispatched(format!(
                    "unsupported key name \"{name}\""
                ))
            })?;
            keys.push(crate::win32::KeySpec::Virtual { vk, extended });
        }
        crate::win32::send_key_combo(&keys)
    }

    /// Types literal text as a sequence of Unicode key events, after
    /// confirming the target is the real foreground window.
    pub(super) fn send_text(value: &serde_json::Value) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        require_real_foreground(pid, handle)?;
        let text = value
            .get("text")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| crate::InputDispatchError::not_dispatched("text must be a string"))?;
        if text.is_empty()
            || text.chars().count() > 5_000
            || text
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err(crate::InputDispatchError::not_dispatched(
                "invalid input text",
            ));
        }
        crate::win32::send_unicode_text(text)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn process_generation_is_stable_for_the_same_live_process() {
        let request = serde_json::json!({ "op": "processGeneration", "pid": std::process::id() });
        let first = super::handle_desktop_stage_request(&request);
        let second = super::handle_desktop_stage_request(&request);
        assert_eq!(first["ok"], true);
        assert_eq!(first["processGeneration"], second["processGeneration"]);
        assert_eq!(first["processGeneration"].as_str().unwrap().len(), 16);
    }
    #[test]
    fn popup_scope_requires_exact_root_owner_pid_and_visibility() {
        assert!(super::popup_candidate_is_owned(1, 2, 1, 100, 100, true));
        assert!(!super::popup_candidate_is_owned(1, 1, 1, 100, 100, true));
        assert!(!super::popup_candidate_is_owned(1, 2, 3, 100, 100, true));
        assert!(!super::popup_candidate_is_owned(1, 2, 1, 100, 200, true));
        assert!(!super::popup_candidate_is_owned(1, 2, 1, 100, 100, false));
    }
    use super::handle_desktop_stage_request;
    use serde_json::json;

    #[test]
    fn input_error_response_exposes_dispatch_certainty() {
        let not_sent = super::input_dispatch_failure(
            "request-1",
            crate::InputDispatchError::not_dispatched("foreground validation failed"),
        );
        assert_eq!(not_sent["dispatchState"], "not-dispatched");
        assert_eq!(not_sent["ok"], false);

        let partial = super::input_dispatch_failure(
            "request-2",
            crate::InputDispatchError::uncertain("key down was sent before key up failed"),
        );
        assert_eq!(partial["dispatchState"], "uncertain");
        assert_eq!(partial["ok"], false);
    }

    #[test]
    fn removed_virtual_desktop_operations_are_not_exposed() {
        for op in [
            "currentDesktop",
            "createDesktop",
            "inspectDesktop",
            "activateDesktop",
            "move",
            "showOwnedWindow",
            "showAndMoveOwnedWindow",
            "input",
        ] {
            assert_eq!(
                handle_desktop_stage_request(&json!({ "op": op }))["error"],
                "unsupported desktop stage operation",
                "{op} must remain unavailable"
            );
        }
    }

    #[test]
    fn rejects_malformed_window_identities() {
        for bad in [
            json!({ "op":"inspect", "pid":0, "windowId":"123" }),
            json!({ "op":"inspect", "pid":1, "windowId":"0" }),
            json!({ "op":"inspect", "pid":1, "windowId":"-1" }),
        ] {
            assert_ne!(handle_desktop_stage_request(&bad)["ok"], true);
        }
    }

    #[test]
    fn refuses_unknown_operations_and_non_windows_execution_fails_closed() {
        assert_eq!(
            handle_desktop_stage_request(&json!({ "op":"deleteDesktop" }))["error"],
            "unsupported desktop stage operation"
        );
        #[cfg(not(windows))]
        assert_eq!(
            handle_desktop_stage_request(&json!({ "op":"inspect", "pid":1, "windowId":"123" }))
                ["error"],
            "Windows desktop-stage inspection is available only on Windows"
        );
    }

    #[test]
    #[cfg(windows)]
    fn owner_cursor_position_round_trips_through_get_and_restore() {
        // Real system-call round trip, not a mock: read the owner's actual current pointer
        // position, ask to restore it to a nearby point, confirm getCursorPosition reports that
        // exact point, then restore it back to where it started so the test leaves no trace.
        let original = handle_desktop_stage_request(&json!({ "op": "getCursorPosition" }));
        // CI and service sessions can be attached to a non-interactive desktop where
        // GetCursorPos is unavailable. That is an environment limitation, not a
        // production dispatch regression; the request must still fail closed with
        // the typed host error rather than returning a fabricated position.
        if original["ok"] != true {
            assert_eq!(
                original["error"],
                "could not read the owner's pointer position"
            );
            return;
        }
        let original_x = original["position"]["x"].as_i64().unwrap();
        let original_y = original["position"]["y"].as_i64().unwrap();

        let moved = handle_desktop_stage_request(
            &json!({ "op": "restoreCursorPosition", "x": original_x + 3, "y": original_y + 3 }),
        );
        if moved["ok"] != true {
            assert_eq!(
                moved["error"],
                "could not restore the owner's pointer position"
            );
            return;
        }

        let after = handle_desktop_stage_request(&json!({ "op": "getCursorPosition" }));
        assert_eq!(after["position"]["x"], original_x + 3);
        assert_eq!(after["position"]["y"], original_y + 3);

        let restored = handle_desktop_stage_request(
            &json!({ "op": "restoreCursorPosition", "x": original_x, "y": original_y }),
        );
        assert_eq!(restored["ok"], true);
    }

    #[test]
    fn restore_cursor_position_refuses_missing_or_out_of_range_coordinates() {
        for request in [
            json!({ "op": "restoreCursorPosition" }),
            json!({ "op": "restoreCursorPosition", "x": 10 }),
            json!({ "op": "restoreCursorPosition", "x": 10, "y": "not a number" }),
            json!({ "op": "restoreCursorPosition", "x": (i32::MAX as i64) + 1, "y": 10 }),
        ] {
            assert_eq!(
                handle_desktop_stage_request(&request)["error"],
                "invalid cursor restore coordinates"
            );
        }
    }
}
