//! Disposable acceptance host, excluded from normal builds. Its only mutable
//! targets are marked forms created by this exact executable.
//! The production executable's agent-context gate is unchanged.

#[cfg(windows)]
mod fixture {
    use m9r_native_input_host::{handle_desktop_stage_request, read_frame, write_frame};
    use serde_json::{json, Value};
    use std::io::{stdin, stdout, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows::core::{w, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const CLASS: &str = "M9R_Disposable_Input_Stream_Form_v1";
    unsafe extern "system" fn form_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if message == WM_DESTROY { unsafe { PostQuitMessage(0); } return LRESULT(0); }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }
    static PHYSICAL_MOUSE: AtomicUsize = AtomicUsize::new(0);
    static INJECTED_MOUSE: AtomicUsize = AtomicUsize::new(0);
    static INJECTED_KEYBOARD: AtomicUsize = AtomicUsize::new(0);
    unsafe extern "system" fn mouse_observer(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            if event.flags & LLMHF_INJECTED != 0 { INJECTED_MOUSE.fetch_add(1, Ordering::Relaxed); }
            else { PHYSICAL_MOUSE.fetch_add(1, Ordering::Relaxed); }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
    unsafe extern "system" fn keyboard_observer(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) }.flags.contains(LLKHF_INJECTED) {
            INJECTED_KEYBOARD.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
    fn start_input_observer() -> Result<(u32, std::thread::JoinHandle<()>), String> {
        let (send, receive) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let installed = (|| -> Result<_, String> {
                let module = HINSTANCE(unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?.0);
                let mouse = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_observer), Some(module), 0) }.map_err(|e| e.to_string())?;
                let keyboard = match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_observer), Some(module), 0) } {
                    Ok(hook) => hook,
                    Err(error) => { unsafe { let _ = UnhookWindowsHookEx(mouse); } return Err(error.to_string()); }
                };
                Ok((mouse, keyboard))
            })();
            let (mouse, keyboard) = match installed { Ok(hooks) => hooks, Err(error) => { let _ = send.send(Err(error)); return; } };
            let _ = send.send(Ok(unsafe { GetCurrentThreadId() }));
            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
                unsafe { let _ = TranslateMessage(&message); DispatchMessageW(&message); }
            }
            unsafe { let _ = UnhookWindowsHookEx(mouse); let _ = UnhookWindowsHookEx(keyboard); }
        });
        let id = receive.recv_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())??;
        Ok((id, thread))
    }
    unsafe extern "system" fn slow_edit(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // A bounded fixture delay makes two native client calls observably overlap.
        // The app still processes its own UI thread serially, as real apps may.
        if message == WM_SETTEXT || message == 0x00c2 { std::thread::sleep(std::time::Duration::from_millis(180)); }
        let original = unsafe { GetPropW(hwnd, w!("M9R_Fixture_Original_Edit_Proc")) };
        let proc: WNDPROC = unsafe { std::mem::transmute(original.0 as isize) };
        unsafe { CallWindowProcW(proc, hwnd, message, wparam, lparam) }
    }
    fn text(hwnd: HWND) -> String {
        let mut buffer = vec![0u16; 6000];
        let count = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        String::from_utf16_lossy(&buffer[..count.max(0) as usize])
    }

    pub fn spawn_form() -> Result<(), String> {
        // Callbacks only count event classes on a dedicated thread; no keys,
        // text, pointer history, or application contents are recorded.
        let (observer_id, observer) = start_input_observer()?;
        let class: Vec<u16> = CLASS.encode_utf16().chain(Some(0)).collect();
        let instance = HINSTANCE(unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?.0);
        let wc = WNDCLASSW { lpfnWndProc: Some(form_proc), hInstance: instance, lpszClassName: windows::core::PCWSTR(class.as_ptr()), ..Default::default() };
        if unsafe { RegisterClassW(&wc) } == 0 { return Err("fixture class registration failed".into()); }
        let form = unsafe { CreateWindowExW(WS_EX_NOACTIVATE, windows::core::PCWSTR(class.as_ptr()), w!("Input stream acceptance form"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE, 80, 80, 520, 230, None, None, Some(instance), None) }.map_err(|e| e.to_string())?;
        unsafe { SetPropW(form, w!("M9R_Disposable_Input_Stream_Fixture_Only"), Some(HANDLE(1usize as *mut core::ffi::c_void))) }.map_err(|e| e.to_string())?;
        let field = |id: usize, y: i32, label: &'static str| -> Result<HWND, String> {
            let label: Vec<u16> = label.encode_utf16().chain(Some(0)).collect();
            unsafe { CreateWindowExW(Default::default(), w!("STATIC"), windows::core::PCWSTR(label.as_ptr()), WS_CHILD | WS_VISIBLE,
                20, y, 90, 28, Some(form), None, Some(instance), None) }.map_err(|e| e.to_string())?;
            let edit = unsafe { CreateWindowExW(Default::default(), w!("EDIT"), w!(""), WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                120, y, 330, 28, Some(form), Some(HMENU(id as *mut core::ffi::c_void)), Some(instance), None) }.map_err(|e| e.to_string())?;
            let original = unsafe { SetWindowLongPtrW(edit, GWLP_WNDPROC, slow_edit as *const () as isize) };
            unsafe { SetPropW(edit, w!("M9R_Fixture_Original_Edit_Proc"), Some(HANDLE(original as *mut core::ffi::c_void))) }.map_err(|e| e.to_string())?;
            Ok(edit)
        };
        let title = field(1001, 30, "Title")?;
        let caption = field(1002, 95, "Caption")?;
        // The test launcher hides its console with STARTUPINFO; explicitly show
        // the disposable form without activating it or changing the owner focus.
        unsafe { SetWindowPos(form, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW) }.map_err(|e| e.to_string())?;
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let state_path = std::env::temp_dir().join(format!("m9r-input-stream-fixture-{}-{nonce}.json", std::process::id()));
        std::fs::OpenOptions::new().write(true).create_new(true).open(&state_path).map_err(|e| e.to_string())?;
        println!("{}", json!({"pid":std::process::id(),"windowId":(form.0 as usize).to_string(),"statePath":state_path,"className":CLASS,
            "fields":[(title.0 as usize).to_string(),(caption.0 as usize).to_string()],
            "visible":[unsafe { IsWindowVisible(title) }.as_bool(),unsafe { IsWindowVisible(caption) }.as_bool()]}));
        stdout().flush().map_err(|e| e.to_string())?;
        unsafe { SetTimer(Some(form), 1, 25, None); }
        let mut previous = String::new();
        let mut became_foreground = false;
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
            unsafe { let _ = TranslateMessage(&message); DispatchMessageW(&message); }
            became_foreground |= unsafe { GetForegroundWindow() } == form;
            let current = json!({"title":text(title),"caption":text(caption),"becameForeground":became_foreground,
                "input":{"physicalMouse":PHYSICAL_MOUSE.load(Ordering::Relaxed),"injectedMouse":INJECTED_MOUSE.load(Ordering::Relaxed),"injectedKeyboard":INJECTED_KEYBOARD.load(Ordering::Relaxed)}}).to_string();
            if current != previous { std::fs::write(&state_path, current.as_bytes()).map_err(|e| e.to_string())?; previous = current; }
        }
        unsafe { let _ = PostThreadMessageW(observer_id, WM_QUIT, WPARAM(0), LPARAM(0)); }
        let _ = observer.join();
        Ok(())
    }

    fn scoped_target(value: &Value) -> bool {
        let Some(pid) = value["pid"].as_u64().filter(|pid| *pid > 0 && *pid <= u32::MAX as u64) else { return false; };
        let Some(raw) = value["windowId"].as_str().and_then(|raw| raw.parse::<usize>().ok()) else { return false; };
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        let mut window_pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut window_pid)); }
        if window_pid != pid as u32 || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd { return false; }
        let mut class = [0u16; 128];
        let count = unsafe { GetClassNameW(hwnd, &mut class) };
        if String::from_utf16_lossy(&class[..count.max(0) as usize]) != CLASS
            || unsafe { GetPropW(hwnd, w!("M9R_Disposable_Input_Stream_Fixture_Only")) }.0 as usize != 1 { return false; }
        let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) }) else { return false; };
        let mut image = [0u16; 32768];
        let mut count = image.len() as u32;
        let queried = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut count) };
        unsafe { let _ = CloseHandle(process); }
        queried.is_ok() && std::env::current_exe().ok().is_some_and(|own| own.to_string_lossy().eq_ignore_ascii_case(&String::from_utf16_lossy(&image[..count as usize])))
    }
    fn allowed(value: &Value) -> bool {
        let op = value["op"].as_str().unwrap_or("");
        if matches!(op, "ping" | "getCursorPosition" | "currentForegroundWindow") { return true; }
        if !scoped_target(value) { return false; }
        matches!(op, "inspect" | "inspectWindowStructure" | "captureWindow" | "windowRect" | "windowStatus" | "listChildWindowClasses")
            || (op == "invokeWindowElement" && matches!(value["action"].as_str(), Some("setValue" | "readValue")))
    }
    pub fn server() -> Result<(), String> {
        let mut input = stdin().lock(); let mut output = stdout().lock();
        while let Some(raw) = read_frame(&mut input).map_err(|e| e.to_string())? {
            let mut value: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            let id = value["requestId"].clone();
            write_frame(&mut output, &serde_json::to_vec(&json!({"type":"started","requestId":id})).unwrap()).map_err(|e| e.to_string())?;
            let mut response = if allowed(&value) {
                if value["op"] == "invokeWindowElement" && value["action"] == "setValue" {
                    value["fixtureDispatchBarrier"] = json!(true);
                }
                handle_desktop_stage_request(&value)
            }
                else { json!({"ok":false,"dispatchState":"not-dispatched","error":"fixture host refuses targets outside its own disposable form"}) };
            response["requestId"] = id;
            write_frame(&mut output, &serde_json::to_vec(&response).unwrap()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn main() {
    #[cfg(windows)]
    {
        let result = match std::env::args().nth(1).as_deref() {
            Some("--spawn-form") => fixture::spawn_form(),
            Some("--desktop-stage-server") => fixture::server(),
            _ => Err("disposable fixture mode required".into()),
        };
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
    }
    #[cfg(not(windows))]
    { eprintln!("Windows fixture only"); std::process::exit(1); }
}
