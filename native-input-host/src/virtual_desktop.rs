use serde_json::{json, Value};

const MAX_HANDLE: u64 = usize::MAX as u64;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

impl Guid {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim().trim_start_matches('{').trim_end_matches('}');
        let compact: String = value
            .chars()
            .filter(|character| *character != '-')
            .collect();
        if compact.len() != 32 || !compact.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        Some(Self {
            data1: u32::from_str_radix(&compact[0..8], 16).ok()?,
            data2: u16::from_str_radix(&compact[8..12], 16).ok()?,
            data3: u16::from_str_radix(&compact[12..16], 16).ok()?,
            data4: [
                u8::from_str_radix(&compact[16..18], 16).ok()?,
                u8::from_str_radix(&compact[18..20], 16).ok()?,
                u8::from_str_radix(&compact[20..22], 16).ok()?,
                u8::from_str_radix(&compact[22..24], 16).ok()?,
                u8::from_str_radix(&compact[24..26], 16).ok()?,
                u8::from_str_radix(&compact[26..28], 16).ok()?,
                u8::from_str_radix(&compact[28..30], 16).ok()?,
                u8::from_str_radix(&compact[30..32], 16).ok()?,
            ],
        })
    }

    fn as_string(self) -> String {
        format!(
            "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            self.data1,
            self.data2,
            self.data3,
            self.data4[0],
            self.data4[1],
            self.data4[2],
            self.data4[3],
            self.data4[4],
            self.data4[5],
            self.data4[6],
            self.data4[7]
        )
    }
}

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

/// Dispatches the deliberately narrow local stage API. It never creates or activates a desktop;
/// it only inspects an exact window or moves that exact window to a known desktop GUID.
pub fn handle_desktop_stage_request(value: &Value) -> Value {
    let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
    let response = match value.get("op").and_then(Value::as_str) {
        Some("inspect") => {
            parse_window_identity(value).and_then(|(pid, handle)| inspect_window(pid, handle))
        }
        Some("move") => {
            let identity = parse_window_identity(value);
            let desktop = value
                .get("desktopId")
                .and_then(Value::as_str)
                .and_then(Guid::parse)
                .ok_or("invalid desktopId");
            identity.and_then(|(pid, handle)| {
                desktop.and_then(|desktop| move_window(pid, handle, desktop))
            })
        }
        _ => {
            return json!({ "ok": false, "requestId": request_id, "error": "unsupported desktop stage operation" })
        }
    };

    match response {
        Ok(result) => json!({ "ok": true, "requestId": request_id, "window": to_json(result) }),
        Err(error) => json!({ "ok": false, "requestId": request_id, "error": error }),
    }
}

#[derive(Debug)]
struct WindowDesktop {
    pid: u32,
    window_id: String,
    desktop_id: String,
    on_current_desktop: bool,
}

#[cfg(windows)]
fn inspect_window(pid: u32, window: usize) -> Result<WindowDesktop, &'static str> {
    platform::inspect_window(pid, window)
}

#[cfg(not(windows))]
fn inspect_window(_pid: u32, _window: usize) -> Result<WindowDesktop, &'static str> {
    Err("Windows virtual desktop control is available only on Windows")
}

#[cfg(windows)]
fn move_window(pid: u32, window: usize, desktop: Guid) -> Result<WindowDesktop, &'static str> {
    platform::move_window(pid, window, desktop)
}

#[cfg(not(windows))]
fn move_window(_pid: u32, _window: usize, _desktop: Guid) -> Result<WindowDesktop, &'static str> {
    Err("Windows virtual desktop control is available only on Windows")
}

fn to_json(window: WindowDesktop) -> Value {
    json!({
        "pid": window.pid,
        "windowId": window.window_id,
        "desktopId": window.desktop_id,
        "onCurrentDesktop": window.on_current_desktop,
    })
}

#[cfg(windows)]
mod platform {
    use super::{Guid, WindowDesktop};
    use std::ffi::c_void;

    type HResult = i32;
    type Hwnd = *mut c_void;
    type Interface = *mut c_void;

    #[repr(C)]
    struct VirtualDesktopManagerVTable {
        query_interface:
            unsafe extern "system" fn(Interface, *const Guid, *mut Interface) -> HResult,
        add_ref: unsafe extern "system" fn(Interface) -> u32,
        release: unsafe extern "system" fn(Interface) -> u32,
        is_window_on_current_virtual_desktop:
            unsafe extern "system" fn(Interface, Hwnd, *mut i32) -> HResult,
        get_window_desktop_id: unsafe extern "system" fn(Interface, Hwnd, *mut Guid) -> HResult,
        move_window_to_desktop: unsafe extern "system" fn(Interface, Hwnd, *const Guid) -> HResult,
    }

    #[repr(C)]
    struct GuidRaw {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const CLSID_VIRTUAL_DESKTOP_MANAGER: GuidRaw = GuidRaw {
        data1: 0xaa509086,
        data2: 0x5ca9,
        data3: 0x4c25,
        data4: [0x8f, 0x95, 0x58, 0x9d, 0x3c, 0x07, 0xb4, 0x8a],
    };
    const IID_VIRTUAL_DESKTOP_MANAGER: GuidRaw = GuidRaw {
        data1: 0xa5cd92ff,
        data2: 0x29be,
        data3: 0x454c,
        data4: [0x8d, 0x04, 0xd8, 0x28, 0x79, 0xfb, 0x3f, 0x1b],
    };
    const CLSCTX_INPROC_SERVER: u32 = 0x1;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;

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

    #[link(name = "user32")]
    unsafe extern "system" {
        fn IsWindow(window: Hwnd) -> i32;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
    }

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, &'static str> {
            let result = unsafe { CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED) };
            if result < 0 {
                return Err("could not initialize the Windows COM apartment");
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct Manager(Interface);

    impl Manager {
        fn create() -> Result<Self, &'static str> {
            let mut result: Interface = std::ptr::null_mut();
            let status = unsafe {
                CoCreateInstance(
                    &CLSID_VIRTUAL_DESKTOP_MANAGER as *const _ as *const GuidRaw,
                    std::ptr::null_mut(),
                    CLSCTX_INPROC_SERVER,
                    &IID_VIRTUAL_DESKTOP_MANAGER as *const _ as *const GuidRaw,
                    &mut result,
                )
            };
            if status < 0 || result.is_null() {
                return Err("Windows virtual desktop manager is unavailable");
            }
            Ok(Self(result))
        }

        fn vtable(&self) -> &VirtualDesktopManagerVTable {
            unsafe {
                let pointer = *(self.0 as *mut *mut VirtualDesktopManagerVTable);
                &*pointer
            }
        }

        fn desktop_id(&self, window: Hwnd) -> Result<Guid, &'static str> {
            let mut desktop = Guid {
                data1: 0,
                data2: 0,
                data3: 0,
                data4: [0; 8],
            };
            let result =
                unsafe { (self.vtable().get_window_desktop_id)(self.0, window, &mut desktop) };
            if result < 0 {
                return Err("could not read the window's virtual desktop id");
            }
            Ok(desktop)
        }

        fn is_on_current_desktop(&self, window: Hwnd) -> Result<bool, &'static str> {
            let mut is_current = 0;
            let result = unsafe {
                (self.vtable().is_window_on_current_virtual_desktop)(
                    self.0,
                    window,
                    &mut is_current,
                )
            };
            if result < 0 {
                return Err("could not check the window's current virtual desktop");
            }
            Ok(is_current != 0)
        }

        fn move_to(&self, window: Hwnd, desktop: &Guid) -> Result<(), &'static str> {
            let result = unsafe { (self.vtable().move_window_to_desktop)(self.0, window, desktop) };
            if result < 0 {
                return Err("Windows refused to move the window to that virtual desktop");
            }
            Ok(())
        }
    }

    impl Drop for Manager {
        fn drop(&mut self) {
            unsafe { (self.vtable().release)(self.0) };
        }
    }

    fn validate_window(pid: u32, handle: usize) -> Result<Hwnd, &'static str> {
        let window = handle as Hwnd;
        if unsafe { IsWindow(window) } == 0 {
            return Err("window handle is no longer valid");
        }
        let mut actual_pid = 0;
        if unsafe { GetWindowThreadProcessId(window, &mut actual_pid) } == 0 || actual_pid != pid {
            return Err("window handle does not belong to the supplied process id");
        }
        Ok(window)
    }

    fn read_window(
        manager: &Manager,
        pid: u32,
        window: Hwnd,
    ) -> Result<WindowDesktop, &'static str> {
        let desktop_id = manager.desktop_id(window)?.as_string();
        let window_id = format!("{}", window as usize);
        Ok(WindowDesktop {
            pid,
            window_id,
            desktop_id,
            on_current_desktop: manager.is_on_current_desktop(window)?,
        })
    }

    pub(super) fn inspect_window(pid: u32, handle: usize) -> Result<WindowDesktop, &'static str> {
        let _apartment = ComApartment::initialize()?;
        let manager = Manager::create()?;
        let window = validate_window(pid, handle)?;
        read_window(&manager, pid, window)
    }

    pub(super) fn move_window(
        pid: u32,
        handle: usize,
        target: Guid,
    ) -> Result<WindowDesktop, &'static str> {
        let _apartment = ComApartment::initialize()?;
        let manager = Manager::create()?;
        let window = validate_window(pid, handle)?;
        manager.move_to(window, &target)?;
        let result = read_window(&manager, pid, window)?;
        if result.desktop_id != target.as_string() {
            return Err(
                "Windows accepted the move request but the window is not on the requested desktop",
            );
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::{handle_desktop_stage_request, Guid};
    use serde_json::json;

    #[test]
    fn parses_and_formats_virtual_desktop_guids() {
        let parsed = Guid::parse("{A5CD92FF-29BE-454C-8D04-D82879FB3F1B}").unwrap();
        assert_eq!(parsed.as_string(), "a5cd92ff-29be-454c-8d04-d82879fb3f1b");
    }

    #[test]
    fn rejects_malformed_guids_and_window_identities() {
        assert!(Guid::parse("not-a-guid").is_none());
        for bad in [
            json!({ "op":"inspect", "pid":0, "windowId":"123" }),
            json!({ "op":"inspect", "pid":1, "windowId":"0" }),
            json!({ "op":"inspect", "pid":1, "windowId":"-1" }),
            json!({ "op":"move", "pid":1, "windowId":"123", "desktopId":"bad" }),
        ] {
            assert_eq!(handle_desktop_stage_request(&bad)["ok"], false);
        }
    }

    #[test]
    fn refuses_unknown_operations_and_non_windows_execution_fails_closed() {
        assert_eq!(
            handle_desktop_stage_request(&json!({ "op":"create" }))["error"],
            "unsupported desktop stage operation"
        );
        #[cfg(not(windows))]
        assert_eq!(
            handle_desktop_stage_request(&json!({ "op":"inspect", "pid":1, "windowId":"123" }))
                ["error"],
            "Windows virtual desktop control is available only on Windows"
        );
    }
}
