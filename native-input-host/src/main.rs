use m9r_native_input_host::{
    read_frame, write_frame, MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES,
};
use serde_json::{json, Value};
use std::io::{stdin, stdout, Read};

fn bounded_response_bytes(response: &Value, operation: Option<&str>) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(response)
        .map_err(|error| format!("could not encode desktop-stage response: {error}"))?;
    if bytes.len() <= MAX_RESPONSE_FRAME_BYTES {
        return Ok(bytes);
    }

    // A large observation must produce an explicit operation error, not kill
    // the persistent helper and turn every following desktop action into an
    // unexplained transport failure. For an input operation, preserve the
    // fact that its result can no longer be established from this response.
    let mut fallback = json!({
        "ok": false,
        "error": "native desktop-stage response exceeded the broker response limit"
    });
    if let Some(request_id) = response.get("requestId") {
        fallback["requestId"] = request_id.clone();
    }
    if matches!(
        operation,
        Some(
            "sendClick"
                | "sendDrag"
                | "sendScroll"
                | "sendKeyCombo"
                | "sendText"
                | "sendTextToWindow"
        )
    ) {
        fallback["dispatchState"] = json!("uncertain");
    }
    serde_json::to_vec(&fallback)
        .map_err(|error| format!("could not encode oversized-response error: {error}"))
}

fn has_agent_context(mut lookup: impl FnMut(&str) -> Option<std::ffi::OsString>) -> bool {
    const MARKERS: &[&str] = &[
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CODEX_CI",
        "CODEX_THREAD_ID",
        "CODEX_SESSION_ID",
        "OPENCODE",
        "OPENCODE_SESSION_ID",
    ];
    MARKERS
        .iter()
        .any(|name| lookup(name).is_some_and(|value| !value.to_string_lossy().trim().is_empty()))
}

#[cfg(test)]
mod stage_cli_tests {
    use super::has_agent_context;
    use std::ffi::OsString;

    #[test]
    fn desktop_stage_command_refuses_agent_context_markers() {
        assert!(!has_agent_context(|_| None));
        assert!(has_agent_context(|name| {
            (name == "CODEX_THREAD_ID").then(|| OsString::from("thread-1"))
        }));
        assert!(!has_agent_context(|name| {
            (name == "OPENCODE").then(|| OsString::from("  "))
        }));
    }
}

/// Keep one native helper alive for the lifetime of the broker.  The old
/// `--desktop-stage-json` mode intentionally exits after one request, which
/// makes every UIA read and every native action pay a process-start cost.  The
/// persistent mode uses the same bounded binary framing as the input host and
/// returns one JSON response per request without changing the operation
/// contract.
fn run_desktop_stage_server() -> Result<(), String> {
    let mut input = stdin().lock();
    let mut output = stdout().lock();
    loop {
        let raw = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            // The persistent stage host is stopped by its owner with an
            // explicit process kill. EOF before that is an unexpected pipe
            // closure; returning success hid helper loss as exit code 0 and
            // made an in-flight desktop request look like an unexplained
            // no-op.
            Ok(None) => return Err("persistent desktop-stage input closed unexpectedly".into()),
            Err(error) => return Err(format!("desktop-stage request framing failed: {error}")),
        };
        if raw.len() > MAX_REQUEST_FRAME_BYTES {
            let response =
                json!({"ok":false,"error":"desktop stage request is invalid or too large"});
            let bytes = serde_json::to_vec(&response).expect("static response serializes");
            write_frame(&mut output, &bytes)
                .map_err(|error| format!("could not write invalid-request response: {error}"))?;
            continue;
        }
        let request_id = serde_json::from_slice::<Value>(&raw)
            .ok()
            .and_then(|parsed| {
                parsed
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let operation = serde_json::from_slice::<Value>(&raw)
            .ok()
            .and_then(|parsed| parsed.get("op").and_then(Value::as_str).map(str::to_owned));
        if let Some(request_id) = request_id.as_deref() {
            let started = serde_json::to_vec(&json!({ "type":"started", "requestId":request_id }))
                .map_err(|error| {
                    format!("could not encode desktop-stage start acknowledgement: {error}")
                })?;
            write_frame(&mut output, &started).map_err(|error| {
                format!("could not write desktop-stage start acknowledgement: {error}")
            })?;
        }
        let mut response = if has_agent_context(|name| std::env::var_os(name)) {
            json!({"ok":false,"error":"agent context cannot change owner desktop stages"})
        } else {
            match serde_json::from_slice::<Value>(&raw) {
                Ok(parsed) => m9r_native_input_host::handle_desktop_stage_request(&parsed),
                Err(_) => json!({"ok":false,"error":"invalid desktop stage request JSON"}),
            }
        };
        // The persistent host multiplexes requests over one process.  Echo
        // the caller's id on every frame so a concurrent response can never
        // be delivered to the wrong stage operation.
        if let Some(request_id) = request_id {
            if let Some(object) = response.as_object_mut() {
                object.insert("requestId".to_owned(), Value::String(request_id));
            }
        }
        let bytes = bounded_response_bytes(&response, operation.as_deref())?;
        write_frame(&mut output, &bytes)
            .map_err(|error| format!("could not write desktop-stage response: {error}"))?;
    }
}

/// Test-only fixture: creates one real, visible top-level window hosting one
/// (`--spawn-test-window`) or two (`--spawn-test-window-dual`) plain Win32
/// EDIT controls, prints their identity as a single JSON line, then runs a
/// real Win32 message loop until the process is killed. Exists so
/// concurrency/serialization proofs can drive the real native-input-host
/// server against real OS windows instead of mocking window existence --
/// the window this spawns is exactly the kind of plain control
/// `sendTextToWindow` exists for. Never reached by any production action
/// path; only ever invoked directly by test code.
#[cfg(windows)]
fn run_spawn_test_window(dual: bool) -> ! {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowThreadProcessId,
        PostQuitMessage, RegisterClassW, TranslateMessage, CW_USEDEFAULT, ES_AUTOHSCROLL, MSG,
        WINDOW_STYLE, WM_DESTROY, WNDCLASSW, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    unsafe extern "system" fn wndproc(
        window: windows::Win32::Foundation::HWND,
        message: u32,
        wparam: windows::Win32::Foundation::WPARAM,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        if message == WM_DESTROY {
            unsafe { PostQuitMessage(0) };
            return windows::Win32::Foundation::LRESULT(0);
        }
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }

    let (top, field1, field2) = unsafe {
        let class_name = w!("M9RTestHarnessWindow");
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            lpszClassName: class_name,
            ..Default::default()
        };
        RegisterClassW(&class);
        let top = CreateWindowExW(
            Default::default(),
            class_name,
            w!("M9R Test Window"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            if dual { 420 } else { 220 },
            120,
            None,
            None,
            None,
            None,
        )
        .expect("creating the top-level test harness window");
        let field1 = CreateWindowExW(
            Default::default(),
            w!("Edit"),
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
            10,
            10,
            190,
            24,
            Some(top),
            None,
            None,
            None,
        )
        .expect("creating test harness field 1");
        let field2 = if dual {
            Some(
                CreateWindowExW(
                    Default::default(),
                    w!("Edit"),
                    PCWSTR::null(),
                    WS_CHILD | WS_VISIBLE | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                    210,
                    10,
                    190,
                    24,
                    Some(top),
                    None,
                    None,
                    None,
                )
                .expect("creating test harness field 2"),
            )
        } else {
            None
        };
        (top, field1, field2)
    };

    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(top, Some(&mut pid)) };
    let payload = match field2 {
        Some(field2) => json!({
            "pid": pid,
            "windowId": format!("{}", top.0 as usize),
            "fields": [format!("{}", field1.0 as usize), format!("{}", field2.0 as usize)],
        }),
        None => json!({ "pid": pid, "windowId": format!("{}", field1.0 as usize) }),
    };
    println!("{payload}");
    use std::io::Write;
    let _ = stdout().flush();

    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    std::process::exit(0);
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--spawn-test-window") {
        #[cfg(windows)]
        run_spawn_test_window(false);
        #[cfg(not(windows))]
        {
            eprintln!("--spawn-test-window is available only on Windows");
            std::process::exit(2);
        }
    }
    if std::env::args().nth(1).as_deref() == Some("--spawn-test-window-dual") {
        #[cfg(windows)]
        run_spawn_test_window(true);
        #[cfg(not(windows))]
        {
            eprintln!("--spawn-test-window-dual is available only on Windows");
            std::process::exit(2);
        }
    }
    if std::env::args().nth(1).as_deref() == Some("--desktop-stage-server") {
        if let Err(error) = run_desktop_stage_server() {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--desktop-stage-json") {
        if has_agent_context(|name| std::env::var_os(name)) {
            println!(
                "{{\"ok\":false,\"error\":\"agent context cannot change owner desktop stages\"}}"
            );
            std::process::exit(1);
        }
        let mut request = Vec::new();
        if stdin()
            .lock()
            .take(MAX_REQUEST_FRAME_BYTES as u64 + 1)
            .read_to_end(&mut request)
            .is_err()
            || request.len() > MAX_REQUEST_FRAME_BYTES
        {
            println!(
                "{{\"ok\":false,\"error\":\"desktop stage request is invalid or too large\"}}"
            );
            std::process::exit(2);
        }
        let parsed = match serde_json::from_slice::<Value>(&request) {
            Ok(value) => value,
            Err(_) => {
                println!("{{\"ok\":false,\"error\":\"invalid desktop stage request JSON\"}}");
                std::process::exit(2);
            }
        };
        let response = m9r_native_input_host::handle_desktop_stage_request(&parsed);
        let ok = response.get("ok").and_then(Value::as_bool).unwrap_or(false);
        println!("{}", response);
        if !ok {
            std::process::exit(1);
        }
        return;
    }

    eprintln!("m9r-native-input-host requires --desktop-stage-server or --desktop-stage-json; the browser native-messaging route is retired");
    std::process::exit(2);
}

#[cfg(test)]
mod response_frame_tests {
    use super::bounded_response_bytes;
    use m9r_native_input_host::MAX_RESPONSE_FRAME_BYTES;
    use serde_json::json;

    #[test]
    fn oversized_observations_return_an_error_frame_without_terminating_the_host() {
        let response = json!({ "ok": true, "requestId": "capture-1", "image": "x".repeat(MAX_RESPONSE_FRAME_BYTES + 1) });
        let encoded = bounded_response_bytes(&response, Some("captureWindow")).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["requestId"], "capture-1");
        assert_eq!(parsed["dispatchState"], serde_json::Value::Null);
    }

    #[test]
    fn oversized_input_result_is_reported_as_uncertain_not_not_dispatched() {
        let response = json!({ "ok": true, "requestId": "click-1", "detail": "x".repeat(MAX_RESPONSE_FRAME_BYTES + 1) });
        let encoded = bounded_response_bytes(&response, Some("sendClick")).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["requestId"], "click-1");
        assert_eq!(parsed["dispatchState"], "uncertain");
    }
}
