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

fn is_m9r_cursor_overlay_class(class_name: &str) -> bool {
    class_name.eq_ignore_ascii_case("M9RCursorOverlay")
}

fn valid_input_text(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= 5_000
        && !text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
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
        Some("captureForegroundContext") => match platform::capture_foreground_context() {
            Ok(context) => json!({"ok":true,"requestId":request_id,"foregroundContext":context}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("physicalInputEpoch") => match crate::win32::physical_input_epoch() {
            Ok(epoch) => json!({"ok":true,"requestId":request_id,"physicalInputEpoch":epoch}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("restoreForegroundContext") => match platform::restore_foreground_context(value) {
            Ok(restoration) => json!({"ok":true,"requestId":request_id,"restoration":restoration}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
        },
        #[cfg(windows)]
        Some("releaseForegroundContextMonitor") => match platform::release_foreground_context_monitor() {
            Ok(()) => json!({"ok":true,"requestId":request_id,"released":true}),
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
            Ok(()) => input_dispatch_success(
                request_id,
                "send-input-click",
                value,
                crate::InputDispatchState::Dispatched,
            ),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        // Target-window mouse messages are the non-physical pointer route.
        // They are delivered by this agent stream's helper to the exact HWND;
        // the owner pointer is never moved or restored. The app effect still
        // requires a separate observation after the message is queued.
        #[cfg(windows)]
        Some("postClickToWindow") => match platform::post_click_to_window(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id,"dispatchState":"dispatched","route":"PostMessageW","target":"exact-window"}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendDrag") => match platform::send_drag(value) {
            Ok(()) => input_dispatch_success(
                request_id,
                "send-input-drag",
                value,
                crate::InputDispatchState::Dispatched,
            ),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendScroll") => match platform::send_scroll(value) {
            Ok(()) => input_dispatch_success(
                request_id,
                "send-input-scroll",
                value,
                crate::InputDispatchState::Dispatched,
            ),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("postScrollToWindow") => match platform::post_scroll_to_window(value) {
            Ok(()) => json!({"ok":true,"requestId":request_id,"dispatchState":"dispatched","route":"PostMessageW","target":"exact-window"}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendKeyCombo") => match platform::send_key_combo(value) {
            Ok(()) => input_dispatch_success(
                request_id,
                "send-input-key-combo",
                value,
                crate::InputDispatchState::Dispatched,
            ),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        #[cfg(windows)]
        Some("sendText") => match platform::send_text(value) {
            Ok(()) => input_dispatch_success(
                request_id,
                "send-input-unicode-text",
                value,
                crate::InputDispatchState::Dispatched,
            ),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        // Background-safe text entry: posts WM_CHAR straight to the target
        // window's own message queue instead of going through SendInput, so
        // it never requires -- and never steals -- OS foreground. See
        // `platform::send_text_to_window` and `win32::post_text_to_window`.
        #[cfg(windows)]
        Some("sendTextToWindow") => match platform::send_text_to_window(value) {
            Ok(()) => input_dispatch_success(
                request_id,
                "wm-char-post-message",
                value,
                crate::InputDispatchState::Dispatched,
            ),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        // Test-only scaffolding for the Phase 0 T3 proof: provoke a real
        // app's own close/unsaved-changes dialog without SendInput or
        // foreground, the same way sendTextToWindow avoids them for text.
        #[cfg(windows)]
        Some("postCloseWindow") => match platform::post_close_window(value) {
            Ok(()) => input_dispatch_success(
                request_id,
                "wm-close-post-message",
                value,
                crate::InputDispatchState::Dispatched,
            ),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        // Resolves a window's descendant classic-Edit-class child, if any,
        // so background text delivery can target the real text surface
        // instead of a wrapping frame. See `win32::find_edit_child_window`.
        #[cfg(windows)]
        Some("findEditChildWindow") => match platform::find_edit_child_window(value) {
            Ok(child) => json!({"ok":true,"requestId":request_id,"childWindowId":child.map(|c| c.to_string())}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        // Diagnostic only: see `win32::list_child_window_classes`.
        #[cfg(windows)]
        Some("listChildWindowClasses") => match platform::list_child_window_classes(value) {
            Ok(classes) => json!({"ok":true,"requestId":request_id,"classes":classes}),
            Err(error) => input_dispatch_failure(request_id, error),
        },
        // Read-only ground-truth verification: the real text GetWindowTextW reports
        // for this window/control, never a UIA read and never an echo of input sent.
        #[cfg(windows)]
        Some("getWindowText") => match platform::get_window_text(value) {
            Ok(text) => json!({"ok":true,"requestId":request_id,"text":text}),
            Err(error) => json!({"ok":false,"requestId":request_id,"error":error}),
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

/// Success companion to `input_dispatch_failure`: reports which route
/// actually delivered the input and which window it was addressed to, so
/// callers never have to infer the route from the op name alone.
#[cfg(windows)]
fn input_dispatch_success(
    request_id: &str,
    route: &str,
    value: &Value,
    state: crate::InputDispatchState,
) -> Value {
    let (pid, window_id) = parse_window_identity(value)
        .map(|(pid, handle)| (Some(pid), Some(handle.to_string())))
        .unwrap_or((None, None));
    json!({
        "ok": true,
        "requestId": request_id,
        "dispatchState": state.as_str(),
        "route": route,
        "target": { "pid": pid, "windowId": window_id },
    })
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

    /// Reads a window's or control's actual text directly via `GetWindowTextW` --
    /// not a UIA tree read, not a trusted echo of what was sent. Exists so a
    /// caller can verify the real effect of a dispatched action against ground
    /// truth, the same discipline every input op above this one depends on.
    pub(super) fn get_window_text(value: &serde_json::Value) -> Result<String, &'static str> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        let mut buffer = [0u16; 8192];
        let written = unsafe { GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
        if written < 0 {
            return Err("Windows could not read the window's text");
        }
        Ok(String::from_utf16_lossy(&buffer[..written as usize]))
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
        let width = integer("width")?;
        let height = integer("height")?;
        if width <= 0 || height <= 0 {
            return Err("window frame width and height must be positive".into());
        }
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

    /// Captures the exact visible foreground HWND and physical-input epoch
    /// around the read. Hooks are limited to the approved foreground handoff;
    /// if the owner changes focus or inputs during capture, discard the sample.
    pub(super) fn capture_foreground_context() -> Result<serde_json::Value, &'static str> {
        crate::win32::start_physical_input_monitor()?;
        let captured = (|| {
        let before_input_epoch = crate::win32::physical_input_epoch()?;
        let foreground = current_foreground_window()?;
        let pid = foreground["pid"].as_u64().ok_or("foreground process identity is unavailable")? as u32;
        let window_id = foreground["windowId"].as_str().ok_or("foreground window identity is unavailable")?;
        let handle = window_id.parse::<usize>().map_err(|_| "foreground window identity is invalid")?;
        if unsafe { GetForegroundWindow() } != handle as Hwnd {
            return Err("foreground window changed while owner context was captured");
        }
        let generation = process_generation(pid)?;
        let after_input_epoch = crate::win32::physical_input_epoch()?;
        if before_input_epoch != after_input_epoch || unsafe { GetForegroundWindow() } != handle as Hwnd {
            return Err("owner input or foreground changed while context was captured");
        }
        Ok(serde_json::json!({
            "pid": pid,
            "windowId": window_id,
            "processGeneration": generation,
            "physicalInputEpoch": after_input_epoch,
            "visible": foreground["visible"],
            "minimized": foreground["minimized"],
        }))
        })();
        if captured.is_err() { let _ = crate::win32::stop_physical_input_monitor(); }
        captured
    }

    /// Returns a non-restored disposition rather than taking over after the
    /// owner has interacted, the expected agent HWND lost foreground, or the
    /// captured owner HWND/process is no longer the same visible window.
    pub(super) fn restore_foreground_context(value: &serde_json::Value) -> Result<serde_json::Value, String> {
        let owner_pid = value.get("ownerPid").and_then(serde_json::Value::as_u64)
            .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64).ok_or("invalid captured owner process id")? as u32;
        let owner_window_text = value.get("ownerWindowId").and_then(serde_json::Value::as_str)
            .ok_or("captured owner window id is missing")?;
        let owner_window = owner_window_text.parse::<usize>().map_err(|_| "captured owner window id is invalid")?;
        let owner_generation = value.get("ownerProcessGeneration").and_then(serde_json::Value::as_str)
            .ok_or("captured owner process generation is missing")?;
        let expected_input_epoch = value.get("physicalInputEpoch").and_then(serde_json::Value::as_u64)
            .ok_or("captured owner input epoch is invalid")?;
        let (expected_pid, expected_window) = super::parse_window_identity(&serde_json::json!({
            "pid": value.get("pid").and_then(serde_json::Value::as_u64),
            "windowId": value.get("windowId").and_then(serde_json::Value::as_str),
        })).map_err(str::to_owned)?;

        if crate::win32::physical_input_epoch().map_err(str::to_owned)? != expected_input_epoch {
            return Ok(serde_json::json!({"restored":false,"reason":"owner-input-changed"}));
        }
        let owner = validate_window(owner_pid, owner_window).map_err(str::to_owned)?;
        if process_generation(owner_pid).map_err(str::to_owned)? != owner_generation
            || unsafe { IsWindowVisible(owner) } == 0 || unsafe { IsIconic(owner) } != 0 {
            return Ok(serde_json::json!({"restored":false,"reason":"owner-window-no-longer-valid"}));
        }
        let expected = validate_window(expected_pid, expected_window).map_err(str::to_owned)?;
        if unsafe { GetForegroundWindow() } != expected {
            return Ok(serde_json::json!({"restored":false,"reason":"foreground-changed"}));
        }
        if owner == expected {
            return Ok(serde_json::json!({"restored":true,"reason":"already-owner-window"}));
        }
        if !crate::win32::restore_window_to_foreground(owner as usize) {
            return Ok(serde_json::json!({"restored":false,"reason":"windows-declined-restore"}));
        }
        Ok(serde_json::json!({
            "restored": unsafe { GetForegroundWindow() } == owner,
            "reason": if unsafe { GetForegroundWindow() } == owner { "restored" } else { "windows-declined-restore" },
        }))
    }

    pub(super) fn release_foreground_context_monitor() -> Result<(), &'static str> {
        crate::win32::stop_physical_input_monitor()
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
            // The full-screen M9R cursor renderer is presentation only. It
            // must not be offered as an app window or become a stage target.
            if super::is_m9r_cursor_overlay_class(&class_name) {
                return 1;
            }
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
            // The full-screen M9R cursor renderer is presentation only. It
            // must not be offered as an app window or become a stage target.
            if super::is_m9r_cursor_overlay_class(&class_name) {
                return 1;
            }
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

    /// Posts a one-click sequence through the exact target window's message
    /// queue. Unsupported click counts are refused before dispatch so they
    /// can use the owner-authorized foreground route without replay risk.
    pub(super) fn post_click_to_window(value: &serde_json::Value) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        let (x, y) = screen_point(value, "x", "y")?;
        let button = match value.get("button").and_then(serde_json::Value::as_str).unwrap_or("left") {
            "left" => crate::MouseButton::Left,
            "right" => crate::MouseButton::Right,
            "middle" => crate::MouseButton::Middle,
            other => return Err(crate::InputDispatchError::not_dispatched(format!("unsupported mouse button \"{other}\""))),
        };
        let count = match value.get("count") {
            None => 1,
            Some(raw) => raw.as_u64().ok_or_else(|| crate::InputDispatchError::not_dispatched("click count must be an integer"))?,
        };
        if count != 1 {
            return Err(crate::InputDispatchError::not_dispatched("window-message input supports one click; other click counts require the foreground route"));
        }
        crate::win32::post_click_to_window(window as usize, pid, x, y, button)
    }

    /// Posts a bounded wheel event to a same-process target control without
    /// moving the system pointer. The caller observes the app after dispatch.
    pub(super) fn post_scroll_to_window(value: &serde_json::Value) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        let (x, y) = screen_point(value, "x", "y")?;
        let amount = value.get("amount").and_then(serde_json::Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .filter(|value| *value != 0 && (-50..=50).contains(value))
            .ok_or_else(|| crate::InputDispatchError::not_dispatched("scroll amount must be between -50 and 50 notches"))?;
        let horizontal = match value.get("axis").and_then(serde_json::Value::as_str).unwrap_or("vertical") {
            "vertical" => false,
            "horizontal" => true,
            _ => return Err(crate::InputDispatchError::not_dispatched("scroll axis must be vertical or horizontal")),
        };
        crate::win32::post_scroll_to_window(window as usize, pid, x, y, amount, horizontal)
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
        let text = value
            .get("text")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| crate::InputDispatchError::not_dispatched("text must be a string"))?;
        if !super::valid_input_text(text) {
            return Err(crate::InputDispatchError::not_dispatched(
                "invalid input text",
            ));
        }
        // Validate the whole payload before any foreground check or other
        // window side effect, so malformed text cannot steal focus and then
        // fail without dispatching input.
        require_real_foreground(pid, handle)?;
        crate::win32::send_unicode_text(text)
    }

    /// Types literal text into one specific window via `WM_CHAR` messages
    /// posted straight to its own message queue -- the background-safe
    /// sibling of `send_text`. Deliberately does NOT call
    /// `require_real_foreground`: that is the entire point of this op. It
    /// still runs `validate_window` so a stale or reused window handle, or a
    /// handle that does not actually belong to the supplied process id,
    /// cannot be used to post text into an unrelated window.
    pub(super) fn send_text_to_window(
        value: &serde_json::Value,
    ) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        let text = value
            .get("text")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| crate::InputDispatchError::not_dispatched("text must be a string"))?;
        if !super::valid_input_text(text) {
            return Err(crate::InputDispatchError::not_dispatched(
                "invalid input text",
            ));
        }
        crate::win32::post_text_to_window(window as usize, text)
    }

    pub(super) fn post_close_window(
        value: &serde_json::Value,
    ) -> Result<(), crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        crate::win32::post_close_window(window as usize)
    }

    /// See `win32::find_edit_child_window` for why this exists.
    pub(super) fn find_edit_child_window(
        value: &serde_json::Value,
    ) -> Result<Option<usize>, crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        crate::win32::find_edit_child_window(window as usize)
    }

    /// Diagnostic only. See `win32::list_child_window_classes`.
    pub(super) fn list_child_window_classes(
        value: &serde_json::Value,
    ) -> Result<Vec<String>, crate::InputDispatchError> {
        let (pid, handle) = super::parse_window_identity(value)?;
        let window = validate_window(pid, handle)?;
        crate::win32::list_child_window_classes(window as usize)
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
    #[test]
    fn m9r_cursor_overlay_class_is_recognized_case_insensitively() {
        assert!(super::is_m9r_cursor_overlay_class("M9RCursorOverlay"));
        assert!(super::is_m9r_cursor_overlay_class("m9rcursoroverlay"));
        assert!(!super::is_m9r_cursor_overlay_class("Notepad"));
    }
    #[test]
    fn multiline_text_accepts_common_newline_forms_but_rejects_other_controls() {
        assert!(super::valid_input_text("first\r\nsecond\rthird\nfourth\tcolumn"));
        assert!(!super::valid_input_text("text\u{0001}control"));
        assert!(!super::valid_input_text(""));
        assert!(!super::valid_input_text(&"x".repeat(5_001)));
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

    #[cfg(windows)]
    #[test]
    fn input_dispatch_success_reports_route_and_target_for_every_dispatch_op() {
        // Every op that can actually send input builds its success response
        // through `input_dispatch_success`, each with its own route string.
        // Prove the helper reports them consistently rather than trusting
        // each call site separately, since this is the one place a route
        // name could silently drift from what Codex is told to expect.
        for (route, state) in [
            ("wm-char-post-message", crate::InputDispatchState::Dispatched),
            ("wm-close-post-message", crate::InputDispatchState::Dispatched),
            ("send-input-click", crate::InputDispatchState::Dispatched),
            ("send-input-drag", crate::InputDispatchState::Dispatched),
            ("send-input-scroll", crate::InputDispatchState::Dispatched),
            ("send-input-key-combo", crate::InputDispatchState::Dispatched),
            ("send-input-unicode-text", crate::InputDispatchState::Dispatched),
        ] {
            let response = super::input_dispatch_success(
                "request-1",
                route,
                &json!({ "pid": 4242, "windowId": "778899" }),
                state,
            );
            assert_eq!(response["ok"], true);
            assert_eq!(response["dispatchState"], "dispatched");
            assert_eq!(response["route"], route);
            assert_eq!(response["target"]["pid"], 4242);
            assert_eq!(response["target"]["windowId"], "778899");
        }
    }

    #[cfg(windows)]
    #[test]
    fn input_dispatch_success_omits_target_identity_it_cannot_resolve() {
        // A request with no (or invalid) pid/windowId still gets a
        // dispatchState/route back -- it just can't claim a target it
        // never actually parsed. Never fabricate pid/windowId here.
        let response = super::input_dispatch_success(
            "request-1",
            "send-input-click",
            &json!({}),
            crate::InputDispatchState::Dispatched,
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["route"], "send-input-click");
        assert!(response["target"]["pid"].is_null());
        assert!(response["target"]["windowId"].is_null());
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
    #[cfg(windows)]
    fn send_text_to_window_delivers_real_text_without_requiring_foreground() {
        // Prove the background-safe channel end to end against a real Win32
        // control, per the standard: never trust the dispatch return value --
        // read the control's own actual text back and also confirm the
        // target never had to become (and never was required to be) the OS
        // foreground window, which is the entire reason this op exists.
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, GetForegroundWindow, GetWindowTextW,
            GetWindowThreadProcessId, PeekMessageW, TranslateMessage, ES_AUTOHSCROLL,
            ES_AUTOVSCROLL, ES_MULTILINE, MSG, PM_REMOVE, WS_OVERLAPPED,
        };

        let window = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("Edit"),
                PCWSTR::null(),
                WS_OVERLAPPED
                    | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(
                        (ES_AUTOHSCROLL | ES_AUTOVSCROLL | ES_MULTILINE) as u32,
                    ),
                0,
                0,
                200,
                24,
                None,
                None,
                None,
                None,
            )
        }
        .expect("creating a plain EDIT control for the background-input test");
        let handle = window.0 as usize;

        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };

        // This window is never shown and never made foreground. If
        // `sendTextToWindow` worked by secretly requiring real foreground
        // (the exact thing it exists to avoid), it would fail closed here
        // instead of delivering the text.
        assert_ne!(unsafe { GetForegroundWindow() }, window);

        let request = json!({
            "op": "sendTextToWindow",
            "pid": pid,
            "windowId": format!("{handle}"),
            "text": "m9r background\nline two\r\nline three",
        });
        let response = handle_desktop_stage_request(&request);
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["dispatchState"], "dispatched");
        assert_eq!(response["route"], "wm-char-post-message");
        assert_eq!(response["target"]["pid"], pid);
        assert_eq!(response["target"]["windowId"], format!("{handle}"));

        // `PostMessageW` only queues the message; a real target app's own
        // message loop is what actually delivers it to the control's
        // `WndProc`. This test's window has no running loop of its own, so
        // pump its queue exactly the way a real app would, to prove the
        // posted WM_CHAR events are genuinely processed, not just queued.
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, Some(window), 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        let mut buffer = [0u16; 64];
        let written = unsafe { GetWindowTextW(window, &mut buffer) };
        let actual = String::from_utf16_lossy(&buffer[..written as usize]);

        // getWindowText is the same read-back primitive Phase 0's concurrency proof
        // uses to verify real effects; prove it agrees with the direct Win32 read
        // before the window is destroyed.
        let read_back = handle_desktop_stage_request(&json!({
            "op": "getWindowText",
            "pid": pid,
            "windowId": format!("{handle}"),
        }));
        assert_eq!(read_back["ok"], true, "{read_back}");
        assert_eq!(read_back["text"], "m9r background\r\nline two\r\nline three");

        unsafe { DestroyWindow(window) }.ok();

        assert_eq!(actual, "m9r background\r\nline two\r\nline three");
    }

    #[test]
    #[cfg(windows)]
    fn post_click_to_window_delivers_to_exact_win32_window_without_moving_system_cursor() {
        use std::cell::RefCell;
        use windows::core::w;
        use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
            GetForegroundWindow, GetWindowThreadProcessId, PeekMessageW, RegisterClassW,
            TranslateMessage, MSG, PM_REMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEHWHEEL,
            WM_MOUSEMOVE, WM_MOUSEWHEEL, WNDCLASSW, WS_OVERLAPPED,
        };

        thread_local! {
            static MOUSE_MESSAGES: RefCell<Vec<(u32, usize)>> = const { RefCell::new(Vec::new()) };
        }

        unsafe extern "system" fn wndproc(
            window: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            if matches!(
                message,
                WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_MOUSEWHEEL | WM_MOUSEHWHEEL
            ) {
                MOUSE_MESSAGES.with(|messages| messages.borrow_mut().push((message, wparam.0)));
                return LRESULT(0);
            }
            unsafe { DefWindowProcW(window, message, wparam, lparam) }
        }

        let class_name = w!("M9RPostClickWindowTest");
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            lpszClassName: class_name,
            ..Default::default()
        };
        assert_ne!(unsafe { RegisterClassW(&class) }, 0, "registering the click-test window class");
        let window = unsafe {
            CreateWindowExW(
                Default::default(),
                class_name,
                windows::core::PCWSTR::null(),
                WS_OVERLAPPED,
                20,
                20,
                300,
                200,
                None,
                None,
                None,
                None,
            )
        }
        .expect("creating a hidden Win32 window for the targeted click test");
        let handle = window.0 as usize;
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
        assert_ne!(unsafe { GetForegroundWindow() }, window, "the test target must remain out of foreground");

        let mut cursor_before = POINT::default();
        unsafe { GetCursorPos(&mut cursor_before) }.expect("reading the system cursor before posting input");
        let response = handle_desktop_stage_request(&json!({
            "op": "postClickToWindow",
            "pid": pid,
            "windowId": handle.to_string(),
            "x": 40,
            "y": 80,
            "button": "left",
            "count": 1,
        }));
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["dispatchState"], "dispatched", "{response}");
        assert_eq!(response["route"], "PostMessageW", "{response}");
        assert_eq!(response["target"], "exact-window", "{response}");
        let vertical = handle_desktop_stage_request(&json!({
            "op": "postScrollToWindow",
            "pid": pid,
            "windowId": handle.to_string(),
            "x": 40,
            "y": 80,
            "amount": 1,
            "axis": "vertical",
        }));
        assert_eq!(vertical["ok"], true, "{vertical}");
        assert_eq!(vertical["dispatchState"], "dispatched", "{vertical}");
        let horizontal = handle_desktop_stage_request(&json!({
            "op": "postScrollToWindow",
            "pid": pid,
            "windowId": handle.to_string(),
            "x": 40,
            "y": 80,
            "amount": -2,
            "axis": "horizontal",
        }));
        assert_eq!(horizontal["ok"], true, "{horizontal}");
        assert_eq!(horizontal["dispatchState"], "dispatched", "{horizontal}");

        // PostMessageW only queues the sequence. Pump this test window's own
        // queue just as its UI thread would, then inspect the exact messages.
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, Some(window), 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        MOUSE_MESSAGES.with(|messages| {
            assert_eq!(
                *messages.borrow(),
                vec![
                    (WM_MOUSEMOVE, 0),
                    (WM_LBUTTONDOWN, 1),
                    (WM_LBUTTONUP, 0),
                    (WM_MOUSEWHEEL, (120_i16 as u16 as usize) << 16),
                    (WM_MOUSEHWHEEL, ((-240_i16) as u16 as usize) << 16),
                ]
            );
        });

        let mut cursor_after = POINT::default();
        unsafe { GetCursorPos(&mut cursor_after) }.expect("reading the system cursor after dispatch");
        assert_eq!(cursor_after.x, cursor_before.x);
        assert_eq!(cursor_after.y, cursor_before.y);
        unsafe { DestroyWindow(window) }.expect("destroying the hidden test window");
    }

    #[test]
    #[cfg(windows)]
    fn send_text_to_window_preserves_lines_in_a_real_multiline_edit() {
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, GetWindowTextW,
            GetWindowThreadProcessId, PeekMessageW, TranslateMessage, ES_MULTILINE, MSG,
            PM_REMOVE, WS_OVERLAPPED,
        };

        let window = unsafe {
            CreateWindowExW(
                Default::default(),
                w!("Edit"),
                PCWSTR::null(),
                WS_OVERLAPPED
                    | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(
                        ES_MULTILINE as u32,
                    ),
                0,
                0,
                240,
                120,
                None,
                None,
                None,
                None,
            )
        }
        .expect("creating a multiline EDIT control for the line-break test");
        let handle = window.0 as usize;
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };

        let response = handle_desktop_stage_request(&json!({
            "op": "sendTextToWindow",
            "pid": pid,
            "windowId": format!("{handle}"),
            "text": "line one\r\nline two\rline three\nline four",
        }));
        assert_eq!(response["ok"], true, "{response}");

        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, Some(window), 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        let mut buffer = [0u16; 128];
        let written = unsafe { GetWindowTextW(window, &mut buffer) };
        let actual = String::from_utf16_lossy(&buffer[..written as usize]);
        let normalized = actual.replace("\r\n", "\n");
        unsafe { DestroyWindow(window) }.ok();

        assert_eq!(normalized, "line one\nline two\nline three\nline four");
    }

    #[test]
    #[cfg(windows)]
    fn post_close_window_delivers_wm_close_without_requiring_foreground() {
        // Phase 0 T3 needs a way to provoke a real app's own close/unsaved-
        // changes dialog without SendInput or foreground, the same property
        // sendTextToWindow proves for text. A custom window class observes
        // WM_CLOSE receipt directly (an Edit control would just destroy
        // itself via DefWindowProc, which proves nothing about *how* the
        // message arrived).
        use std::cell::Cell;
        use windows::core::w;
        use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow,
            GetWindowThreadProcessId, PeekMessageW, RegisterClassW, TranslateMessage, MSG,
            PM_REMOVE, WM_CLOSE, WNDCLASSW, WS_OVERLAPPED,
        };

        thread_local! {
            static CLOSE_RECEIVED: Cell<bool> = Cell::new(false);
        }

        unsafe extern "system" fn wndproc(
            window: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            if message == WM_CLOSE {
                CLOSE_RECEIVED.with(|flag| flag.set(true));
                return LRESULT(0);
            }
            unsafe { DefWindowProcW(window, message, wparam, lparam) }
        }

        let class_name = w!("M9RPostCloseWindowTest");
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            lpszClassName: class_name,
            ..Default::default()
        };
        unsafe { RegisterClassW(&class) };
        let window = unsafe {
            CreateWindowExW(
                Default::default(),
                class_name,
                windows::core::PCWSTR::null(),
                WS_OVERLAPPED,
                0,
                0,
                200,
                24,
                None,
                None,
                None,
                None,
            )
        }
        .expect("creating a plain top-level window for the WM_CLOSE test");
        let handle = window.0 as usize;

        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };

        // Never shown, never foreground -- if postCloseWindow secretly needed
        // real foreground, it would fail closed here instead of delivering.
        assert_ne!(unsafe { GetForegroundWindow() }, window);

        let response = handle_desktop_stage_request(&json!({
            "op": "postCloseWindow",
            "pid": pid,
            "windowId": format!("{handle}"),
        }));
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["dispatchState"], "dispatched");
        assert_eq!(response["route"], "wm-close-post-message");
        assert_eq!(response["target"]["pid"], pid);
        assert_eq!(response["target"]["windowId"], format!("{handle}"));

        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, Some(window), 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        assert!(
            CLOSE_RECEIVED.with(|flag| flag.get()),
            "the window's own WndProc must have received WM_CLOSE"
        );
    }

    #[test]
    #[cfg(windows)]
    fn send_text_to_window_rejects_a_window_handle_from_another_process() {
        let response = handle_desktop_stage_request(&json!({
            "op": "sendTextToWindow",
            "pid": 1,
            "windowId": "123",
            "text": "x",
        }));
        assert_ne!(response["ok"], true);
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
