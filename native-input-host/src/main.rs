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
                | "postCloseWindow"
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
    use windows::core::w;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, GetWindowTextW, GetWindowThreadProcessId,
        SendMessageW, TranslateMessage, CW_USEDEFAULT, ES_AUTOHSCROLL, MSG, WINDOW_STYLE,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };
    // EM_SETSEL/EM_GETMODIFY (there is no typed constant for either in this crate version).
    const EM_SETSEL: u32 = 0x00B1;
    const EM_GETMODIFY: u32 = 0x00B8;
    const WM_CHAR: u32 = 0x0102;

    // Each field is its own real, standalone top-level Edit control -- never a
    // WS_CHILD of a wrapper window. Production window discovery (the same
    // enumeration `launch()` uses) only surfaces top-level windows, so a
    // control that is merely a child of one is invisible to it and can never
    // be selected as the app's window. Making the Edit control itself the
    // top-level window (exactly as the lower-level send_text_to_window_*
    // Rust tests already do) keeps this harness consistent with what the
    // real dispatch/readback path actually resolves and operates on.
    //
    // Window discovery also requires GetWindowTextW to return a nonzero
    // length (a real app's top-level caption is never blank); for an Edit
    // window that text *is* its content, so starting genuinely empty would
    // make this window invisible to the same discovery `launch()` relies on.
    // A one-character placeholder, selected immediately after creation,
    // satisfies discovery while leaving the field exactly as empty from the
    // dispatcher's point of view: the first posted WM_CHAR replaces the
    // selection, same as a user typing over selected text, so the final
    // content is exactly what was typed -- never the placeholder plus it.
    let spawn_field = |x: i32| unsafe {
        let field = CreateWindowExW(
            Default::default(),
            w_edit(),
            w!("_"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
            x,
            CW_USEDEFAULT,
            // Production window discovery filters out anything smaller than
            // 80x60; stay comfortably above that floor.
            220,
            80,
            None,
            None,
            None,
            None,
        )
        .expect("creating a standalone top-level Edit test window");
        SendMessageW(field, EM_SETSEL, Some(WPARAM(0)), Some(LPARAM(-1)));
        field
    };

    let field1 = spawn_field(CW_USEDEFAULT);
    let field2 = if dual { Some(spawn_field(260)) } else { None };

    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(field1, Some(&mut pid)) };
    let payload = match field2 {
        Some(field2) => json!({
            "pid": pid,
            "windowId": format!("{}", field1.0 as usize),
            "fields": [format!("{}", field1.0 as usize), format!("{}", field2.0 as usize)],
        }),
        None => json!({ "pid": pid, "windowId": format!("{}", field1.0 as usize) }),
    };
    println!("{payload}");
    use std::io::Write;
    let _ = stdout().flush();

    // No custom WM_DESTROY handling: this process is test-only and is always
    // torn down by the owning test killing it directly, never by a window
    // close. The message loop just needs to keep running so PostMessageW'd
    // WM_CHAR input is actually delivered.
    //
    // GetWindowTextW is documented to only retrieve a WINDOW'S OWN CACHED
    // CAPTION when called from a different process than the one that owns
    // it -- it cannot read a control's live content cross-process, by OS
    // design, regardless of how correctly WM_CHAR was delivered and
    // processed. There is no raw-HWND way around this; the only correct
    // cross-process reads are UI Automation (what the rest of this codebase
    // already uses for real semantic targets) or, for this disposable
    // test-only harness with no real UIA label/AutomationId to address, the
    // window reporting its own live content itself. Write it to a small,
    // predictable file keyed by this window's own HWND every time it
    // changes, so the test can read real, current content directly instead
    // of relying on a Win32 API that cannot do this across processes.
    let content_path_for = |hwnd: isize| std::env::temp_dir().join(format!("m9r-test-window-content-{hwnd}.txt"));
    // T3's isolating control: does a classic Win32 Edit control's OWN internal
    // modified flag (EM_GETMODIFY, the exact mechanism Notepad itself would
    // consult to decide whether to prompt on close) actually get set by a
    // posted WM_CHAR, as it would for real typed input? This answers whether
    // the WM_CHAR delivery mechanism itself is sound for a classic control,
    // independent of whatever Notepad's own modern (non-classic) text host
    // does or does not do with it.
    let modified_path_for = |hwnd: isize| std::env::temp_dir().join(format!("m9r-test-window-modified-{hwnd}.txt"));
    let mut message = MSG::default();
    loop {
        unsafe {
            let _ = GetMessageW(&mut message, None, 0, 0);
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
            if message.message == WM_CHAR {
                let mut buffer = [0u16; 512];
                let written = GetWindowTextW(message.hwnd, &mut buffer);
                let text = String::from_utf16_lossy(&buffer[..written.max(0) as usize]);
                let _ = std::fs::write(content_path_for(message.hwnd.0 as isize), text.as_bytes());
                let modified = SendMessageW(message.hwnd, EM_GETMODIFY, None, None).0 != 0;
                let _ = std::fs::write(modified_path_for(message.hwnd.0 as isize), if modified { "1" } else { "0" });
            }
        }
    }
}

#[cfg(windows)]
fn w_edit() -> windows::core::PCWSTR {
    windows::core::w!("Edit")
}

/// Phase 0 T3 test-only scaffolding: simulates the real owner continuously
/// typing into a real foreground window of their own, via real `SendInput`
/// (the same hardware-level channel a human's keyboard uses), while an
/// M9R agent does real background work elsewhere. This is the control that
/// proves the background channel never disturbs real foreground input: it
/// never talks to M9R at all, and reports its own ground truth -- what it
/// intended to type, what the control actually ended up containing, whether
/// it ever lost real OS foreground, and whether the real cursor ever moved
/// -- to a small file the test reads directly. Never reached by any
/// production action path.
#[cfg(windows)]
fn run_spawn_foreground_typer() -> ! {
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, CreateWindowExW, GetCursorPos, GetForegroundWindow, GetWindowTextW,
        GetWindowThreadProcessId, SetForegroundWindow, ShowWindow, CW_USEDEFAULT, ES_AUTOHSCROLL,
        SW_MINIMIZE, SW_RESTORE, WINDOW_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    // Minimal, self-contained SendInput plumbing (this binary's test-only
    // code does not reach into the library crate's private win32 module;
    // --spawn-test-window already establishes this precedent for other
    // Win32 calls this harness needs).
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeyboardInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra_info: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    union InputData {
        keyboard: KeyboardInput,
        alignment: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Input {
        kind: u32,
        data: InputData,
    }
    #[link(name = "user32")]
    extern "system" {
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
        fn Sleep(milliseconds: u32);
        fn AttachThreadInput(attach_from: u32, attach_to: u32, attach: i32) -> i32;
        fn GetCurrentThreadId() -> u32;
    }
    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_UNICODE: u32 = 0x0004;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    let send_unicode_char = |unit: u16| -> bool {
        let down = Input {
            kind: INPUT_KEYBOARD,
            data: InputData {
                keyboard: KeyboardInput { vk: 0, scan: unit, flags: KEYEVENTF_UNICODE, time: 0, extra_info: 0 },
            },
        };
        let mut up = down;
        up.data.keyboard.flags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        unsafe {
            SendInput(1, &down, size_of::<Input>() as i32) == 1
                && SendInput(1, &up, size_of::<Input>() as i32) == 1
        }
    };
    const VK_MENU: u16 = 0x12;
    let send_vk_key = |vk: u16, key_up: bool| {
        let input = Input {
            kind: INPUT_KEYBOARD,
            data: InputData {
                keyboard: KeyboardInput { vk, scan: 0, flags: if key_up { KEYEVENTF_KEYUP } else { 0 }, time: 0, extra_info: 0 },
            },
        };
        unsafe { SendInput(1, &input, size_of::<Input>() as i32) };
    };
    let window = unsafe {
        CreateWindowExW(
            Default::default(),
            w_edit(),
            PCWSTR::null(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            220,
            80,
            None,
            None,
            None,
            None,
        )
    }
    .expect("creating the real foreground-typer window");

    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };

    // This test-only window competes for real OS foreground against whatever
    // app was just activated moments earlier (e.g. the real app under test,
    // launched right before this spawns) -- a single unguarded
    // SetForegroundWindow can silently lose that race under Windows'
    // foreground-activation lock, which would make this harness falsely
    // report "foreground lost" from its own flaky startup, not from
    // anything the test actually disturbed. Retry with the same escalation
    // M9R's own production foreground lease uses (AttachThreadInput, an
    // Alt-key tap to reset the "last input" lock, then minimize/restore as
    // a last resort), and verify with GetForegroundWindow() before trusting
    // it.
    let try_raise_typer_window = || -> bool {
        unsafe {
            let foreground = GetForegroundWindow();
            let current_thread = GetCurrentThreadId();
            let mut foreground_thread = 0u32;
            if !foreground.0.is_null() {
                GetWindowThreadProcessId(foreground, Some(&mut foreground_thread));
            }
            let attached = foreground_thread != 0 && foreground_thread != current_thread
                && AttachThreadInput(current_thread, foreground_thread, 1) != 0;
            let _ = BringWindowToTop(window);
            let _ = SetForegroundWindow(window);
            if attached {
                AttachThreadInput(current_thread, foreground_thread, 0);
            }
            GetForegroundWindow() == window
        }
    };

    if !try_raise_typer_window() {
        send_vk_key(VK_MENU, false);
        send_vk_key(VK_MENU, true);
        if !try_raise_typer_window() {
            unsafe {
                let _ = ShowWindow(window, SW_MINIMIZE);
                let _ = ShowWindow(window, SW_RESTORE);
            }
            try_raise_typer_window();
        }
    }

    let mut cursor_start = POINT::default();
    unsafe { let _ = GetCursorPos(&mut cursor_start); }

    let report_path = std::env::temp_dir().join(format!("m9r-foreground-typer-{}.json", std::process::id()));
    let mut foreground_ever_lost = false;
    let mut cursor_ever_moved = false;
    let mut intended = String::new();
    let cycle = "0123456789";

    loop {
        for ch in cycle.chars() {
            let unit = ch as u16;
            let _ = send_unicode_char(unit);
            intended.push(ch);
            unsafe { Sleep(60) };

            if unsafe { GetForegroundWindow() } != window {
                foreground_ever_lost = true;
            }
            let mut cursor_now = POINT::default();
            unsafe { let _ = GetCursorPos(&mut cursor_now); }
            if (cursor_now.x - cursor_start.x).abs() >= 1 || (cursor_now.y - cursor_start.y).abs() >= 1 {
                cursor_ever_moved = true;
            }

            let mut buffer = [0u16; 8192];
            let written = unsafe { GetWindowTextW(window, &mut buffer) };
            let actual = String::from_utf16_lossy(&buffer[..written.max(0) as usize]);

            let report = serde_json::json!({
                "pid": pid,
                "intended": intended,
                "actual": actual,
                "foregroundEverLost": foreground_ever_lost,
                "cursorEverMoved": cursor_ever_moved,
            });
            let _ = std::fs::write(&report_path, report.to_string());
        }
    }
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
    if std::env::args().nth(1).as_deref() == Some("--spawn-foreground-typer") {
        #[cfg(windows)]
        run_spawn_foreground_typer();
        #[cfg(not(windows))]
        {
            eprintln!("--spawn-foreground-typer is available only on Windows");
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
