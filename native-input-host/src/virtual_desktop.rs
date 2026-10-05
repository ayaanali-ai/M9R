use serde_json::{json, Value};

const MAX_HANDLE: u64 = usize::MAX as u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DesktopInfo {
    desktop_id: Guid,
    is_current: bool,
    return_desktop_id: Option<Guid>,
}

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

fn parse_desktop_id(value: &Value) -> Result<Guid, &'static str> {
    value
        .get("desktopId")
        .and_then(Value::as_str)
        .and_then(Guid::parse)
        .ok_or("invalid desktopId")
}

#[cfg(any(windows, test))]
fn supports_internal_desktop_api(major: u32, minor: u32, build: u32) -> bool {
    // Windows 11 22H2+ changed this private COM interface's GUIDs and vtable layout.
    // This adapter is only validated against the 24H2/25H2 interface family.
    major == 10 && minor == 0 && matches!(build, 26100 | 26200)
}

/// Dispatches the deliberately narrow local stage API. Desktop creation and activation use the
/// version-gated Windows shell interface; window inspection and movement stay on the public API.
pub fn handle_desktop_stage_request(value: &Value) -> Value {
    let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
    match value.get("op").and_then(Value::as_str) {
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
        Some("move") => {
            let identity = parse_window_identity(value);
            let desktop = parse_desktop_id(value);
            let result = identity.and_then(|(pid, handle)| {
                desktop.and_then(|desktop| move_window(pid, handle, desktop))
            });
            match result {
                Ok(window) => {
                    json!({ "ok": true, "requestId": request_id, "window": to_json(window) })
                }
                Err(error) => json!({ "ok": false, "requestId": request_id, "error": error }),
            }
        }
        Some("createDesktop") => match create_desktop() {
            Ok(desktop) => {
                json!({ "ok": true, "requestId": request_id, "desktop": desktop_to_json(desktop) })
            }
            Err(error) => json!({ "ok": false, "requestId": request_id, "error": error }),
        },
        Some("inspectDesktop") => {
            let result = parse_desktop_id(value).and_then(inspect_desktop);
            match result {
                Ok(Some(desktop)) => {
                    json!({ "ok": true, "requestId": request_id, "desktop": desktop_to_json(desktop) })
                }
                Ok(None) => {
                    json!({ "ok": false, "requestId": request_id, "error": "virtual desktop no longer exists" })
                }
                Err(error) => json!({ "ok": false, "requestId": request_id, "error": error }),
            }
        }
        Some("activateDesktop") => {
            let result = parse_desktop_id(value).and_then(activate_desktop);
            match result {
                Ok(desktop) => {
                    json!({ "ok": true, "requestId": request_id, "desktop": desktop_to_json(desktop) })
                }
                Err(error) => json!({ "ok": false, "requestId": request_id, "error": error }),
            }
        }
        _ => {
            json!({ "ok": false, "requestId": request_id, "error": "unsupported desktop stage operation" })
        }
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

fn desktop_to_json(desktop: DesktopInfo) -> Value {
    json!({
        "desktopId": desktop.desktop_id.as_string(),
        "isCurrent": desktop.is_current,
        "returnDesktopId": desktop.return_desktop_id.map(Guid::as_string),
    })
}

#[cfg(windows)]
fn create_desktop() -> Result<DesktopInfo, &'static str> {
    platform::create_desktop()
}

#[cfg(not(windows))]
fn create_desktop() -> Result<DesktopInfo, &'static str> {
    Err("Windows virtual desktop control is available only on Windows")
}

#[cfg(windows)]
fn inspect_desktop(desktop: Guid) -> Result<Option<DesktopInfo>, &'static str> {
    platform::inspect_desktop(desktop)
}

#[cfg(not(windows))]
fn inspect_desktop(_desktop: Guid) -> Result<Option<DesktopInfo>, &'static str> {
    Err("Windows virtual desktop control is available only on Windows")
}

#[cfg(windows)]
fn activate_desktop(desktop: Guid) -> Result<DesktopInfo, &'static str> {
    platform::activate_desktop(desktop)
}

#[cfg(not(windows))]
fn activate_desktop(_desktop: Guid) -> Result<DesktopInfo, &'static str> {
    Err("Windows virtual desktop control is available only on Windows")
}

#[cfg(windows)]
mod platform {
    use super::{DesktopInfo, Guid, WindowDesktop};
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

    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
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
    const CLSID_IMMERSIVE_SHELL: GuidRaw = GuidRaw {
        data1: 0xc2f03a33,
        data2: 0x21f5,
        data3: 0x47fa,
        data4: [0xb4, 0xbb, 0x15, 0x63, 0x62, 0xa2, 0xf2, 0x39],
    };
    const CLSID_VIRTUAL_DESKTOP_MANAGER_INTERNAL: GuidRaw = GuidRaw {
        data1: 0xc5e0cdca,
        data2: 0x7b6e,
        data3: 0x41b2,
        data4: [0x9f, 0xc4, 0xd9, 0x39, 0x75, 0xcc, 0x46, 0x7b],
    };
    const IID_VIRTUAL_DESKTOP_MANAGER_INTERNAL: GuidRaw = GuidRaw {
        data1: 0x53f5ca0b,
        data2: 0x158f,
        data3: 0x4124,
        data4: [0x90, 0x0c, 0x05, 0x71, 0x58, 0x06, 0x0b, 0x27],
    };
    const IID_SERVICE_PROVIDER: GuidRaw = GuidRaw {
        data1: 0x6d5140c1,
        data2: 0x7436,
        data3: 0x11ce,
        data4: [0x80, 0x34, 0x00, 0xaa, 0x00, 0x60, 0x09, 0xfa],
    };
    const IID_VIRTUAL_DESKTOP: GuidRaw = GuidRaw {
        data1: 0x3f07f4be,
        data2: 0xb107,
        data3: 0x441a,
        data4: [0xaf, 0x0f, 0x39, 0xd8, 0x25, 0x29, 0x07, 0x2c],
    };
    const CLSCTX_INPROC_SERVER: u32 = 0x1;
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

    #[repr(C)]
    struct VirtualDesktopManagerInternalVTable {
        query_interface: QueryInterfaceFn,
        add_ref: AddRefFn,
        release: ReleaseFn,
        get_count: unsafe extern "system" fn(Interface, *mut i32) -> HResult,
        move_view_to_desktop: unsafe extern "system" fn(Interface, Interface, Interface) -> HResult,
        can_view_move_desktops:
            unsafe extern "system" fn(Interface, Interface, *mut i32) -> HResult,
        get_current_desktop: unsafe extern "system" fn(Interface, *mut Interface) -> HResult,
        get_desktops: unsafe extern "system" fn(Interface, *mut Interface) -> HResult,
        get_adjacent_desktop:
            unsafe extern "system" fn(Interface, Interface, i32, *mut Interface) -> HResult,
        switch_desktop: unsafe extern "system" fn(Interface, Interface) -> HResult,
        // Present in the Windows 11 22H2+ interface before CreateDesktop. Keep the slot
        // even though M9R intentionally never uses the foreground-moving variant.
        switch_desktop_and_move_foreground_view:
            unsafe extern "system" fn(Interface, Interface) -> HResult,
        create_desktop: unsafe extern "system" fn(Interface, *mut Interface) -> HResult,
    }

    #[repr(C)]
    struct ObjectArrayVTable {
        query_interface: QueryInterfaceFn,
        add_ref: AddRefFn,
        release: ReleaseFn,
        get_count: unsafe extern "system" fn(Interface, *mut u32) -> HResult,
        get_at:
            unsafe extern "system" fn(Interface, u32, *const GuidRaw, *mut Interface) -> HResult,
    }

    #[repr(C)]
    struct VirtualDesktopVTable {
        query_interface: QueryInterfaceFn,
        add_ref: AddRefFn,
        release: ReleaseFn,
        is_view_visible: unsafe extern "system" fn(Interface, Interface, *mut i32) -> HResult,
        get_id: unsafe extern "system" fn(Interface, *mut Guid) -> HResult,
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

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(version: *mut OsVersionInfoW) -> HResult;
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

    struct OwnedInterface(Interface);

    impl OwnedInterface {
        fn new(value: Interface) -> Result<Self, &'static str> {
            if value.is_null() {
                Err("Windows returned an empty virtual desktop interface")
            } else {
                Ok(Self(value))
            }
        }

        fn value(&self) -> Interface {
            self.0
        }

        fn release(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let vtable = *(self.0 as *mut *mut IUnknownVTable);
                    ((*vtable).release)(self.0);
                }
                self.0 = std::ptr::null_mut();
            }
        }
    }

    #[repr(C)]
    struct IUnknownVTable {
        query_interface: QueryInterfaceFn,
        add_ref: AddRefFn,
        release: ReleaseFn,
    }

    impl Drop for OwnedInterface {
        fn drop(&mut self) {
            self.release();
        }
    }

    struct InternalManager(OwnedInterface);

    impl InternalManager {
        fn create() -> Result<Self, &'static str> {
            ensure_supported_build()?;
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
                return Err("Windows immersive shell service is unavailable");
            }
            let shell = OwnedInterface(shell);
            let vtable = unsafe { &**(shell.value() as *mut *mut IServiceProviderVTable) };
            let mut manager = std::ptr::null_mut();
            let status = unsafe {
                (vtable.query_service)(
                    shell.value(),
                    &CLSID_VIRTUAL_DESKTOP_MANAGER_INTERNAL,
                    &IID_VIRTUAL_DESKTOP_MANAGER_INTERNAL,
                    &mut manager,
                )
            };
            if status < 0 || manager.is_null() {
                return Err("Windows virtual desktop stage API is unavailable on this build");
            }
            Ok(Self(OwnedInterface(manager)))
        }

        fn vtable(&self) -> &VirtualDesktopManagerInternalVTable {
            unsafe { &**(self.0.value() as *mut *mut VirtualDesktopManagerInternalVTable) }
        }

        fn current_id(&self) -> Result<Guid, &'static str> {
            let mut desktop = std::ptr::null_mut();
            let status =
                unsafe { (self.vtable().get_current_desktop)(self.0.value(), &mut desktop) };
            if status < 0 || desktop.is_null() {
                return Err("Windows could not identify the active virtual desktop");
            }
            let desktop = OwnedInterface(desktop);
            desktop_id(desktop.value())
        }

        fn get_desktops(&self) -> Result<OwnedInterface, &'static str> {
            let mut desktops = std::ptr::null_mut();
            let status = unsafe { (self.vtable().get_desktops)(self.0.value(), &mut desktops) };
            if status < 0 || desktops.is_null() {
                return Err("Windows could not list virtual desktops");
            }
            OwnedInterface::new(desktops)
        }

        fn find_desktop(&self, target: Guid) -> Result<Option<OwnedInterface>, &'static str> {
            let desktops = self.get_desktops()?;
            let array = unsafe { &**(desktops.value() as *mut *mut ObjectArrayVTable) };
            let mut count = 0u32;
            let status = unsafe { (array.get_count)(desktops.value(), &mut count) };
            if status < 0 || count == 0 || count > 64 {
                return Err("Windows returned an invalid virtual desktop count");
            }
            for index in 0..count {
                let mut desktop = std::ptr::null_mut();
                let status = unsafe {
                    (array.get_at)(desktops.value(), index, &IID_VIRTUAL_DESKTOP, &mut desktop)
                };
                if status < 0 || desktop.is_null() {
                    return Err("Windows could not inspect a virtual desktop");
                }
                let desktop = OwnedInterface(desktop);
                if desktop_id(desktop.value())? == target {
                    return Ok(Some(desktop));
                }
            }
            Ok(None)
        }

        fn create_desktop(&self) -> Result<OwnedInterface, &'static str> {
            let mut desktop = std::ptr::null_mut();
            let status = unsafe { (self.vtable().create_desktop)(self.0.value(), &mut desktop) };
            if status < 0 || desktop.is_null() {
                return Err("Windows refused to create a virtual desktop");
            }
            OwnedInterface::new(desktop)
        }

        fn switch_desktop(&self, desktop: Interface) -> Result<(), &'static str> {
            let status = unsafe { (self.vtable().switch_desktop)(self.0.value(), desktop) };
            if status < 0 {
                return Err("Windows refused to activate the requested virtual desktop");
            }
            Ok(())
        }
    }

    fn ensure_supported_build() -> Result<(), &'static str> {
        let mut version = OsVersionInfoW {
            size: std::mem::size_of::<OsVersionInfoW>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        let status = unsafe { RtlGetVersion(&mut version) };
        if status < 0 {
            return Err(
                "Windows could not report its build number; virtual desktop creation is disabled",
            );
        }
        if super::supports_internal_desktop_api(version.major, version.minor, version.build) {
            return Ok(());
        }
        Err("virtual desktop creation is experimental and disabled on this unvalidated Windows build")
    }

    fn desktop_id(desktop: Interface) -> Result<Guid, &'static str> {
        let vtable = unsafe { &**(desktop as *mut *mut VirtualDesktopVTable) };
        let mut id = Guid {
            data1: 0,
            data2: 0,
            data3: 0,
            data4: [0; 8],
        };
        let status = unsafe { (vtable.get_id)(desktop, &mut id) };
        if status < 0 {
            return Err("Windows could not read a virtual desktop id");
        }
        Ok(id)
    }

    pub(super) fn create_desktop() -> Result<DesktopInfo, &'static str> {
        let _apartment = ComApartment::initialize()?;
        let manager = InternalManager::create()?;
        let original = manager.current_id()?;
        let created = manager.create_desktop()?;
        let created_id = desktop_id(created.value())?;
        if created_id == original {
            return Err("Windows returned the active desktop instead of a new virtual desktop");
        }
        let current = manager.current_id()?;
        if current != original {
            if let Some(original_desktop) = manager.find_desktop(original)? {
                manager.switch_desktop(original_desktop.value())?;
            }
            if manager.current_id()? != original {
                return Err("Windows switched desktops during creation and M9R could not restore the original desktop");
            }
            return Err("Windows switched desktops during creation; M9R restored the original desktop and did not register the stage");
        }
        Ok(DesktopInfo {
            desktop_id: created_id,
            is_current: false,
            return_desktop_id: Some(original),
        })
    }

    pub(super) fn inspect_desktop(target: Guid) -> Result<Option<DesktopInfo>, &'static str> {
        let _apartment = ComApartment::initialize()?;
        let manager = InternalManager::create()?;
        let Some(_desktop) = manager.find_desktop(target)? else {
            return Ok(None);
        };
        let current = manager.current_id()?;
        Ok(Some(DesktopInfo {
            desktop_id: target,
            is_current: target == current,
            return_desktop_id: None,
        }))
    }

    pub(super) fn activate_desktop(target: Guid) -> Result<DesktopInfo, &'static str> {
        let _apartment = ComApartment::initialize()?;
        let manager = InternalManager::create()?;
        let Some(desktop) = manager.find_desktop(target)? else {
            return Err("the requested virtual desktop no longer exists");
        };
        if manager.current_id()? != target {
            manager.switch_desktop(desktop.value())?;
        }
        let current = manager.current_id()?;
        if current != target {
            return Err("Windows did not confirm the requested desktop activation");
        }
        Ok(DesktopInfo {
            desktop_id: current,
            is_current: true,
            return_desktop_id: None,
        })
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
    use super::{handle_desktop_stage_request, supports_internal_desktop_api, Guid};
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
            handle_desktop_stage_request(&json!({ "op":"deleteDesktop" }))["error"],
            "unsupported desktop stage operation"
        );
        #[cfg(not(windows))]
        assert_eq!(
            handle_desktop_stage_request(&json!({ "op":"inspect", "pid":1, "windowId":"123" }))
                ["error"],
            "Windows virtual desktop control is available only on Windows"
        );
        #[cfg(not(windows))]
        assert_eq!(
            handle_desktop_stage_request(&json!({ "op":"createDesktop" }))["error"],
            "Windows virtual desktop control is available only on Windows"
        );
    }

    #[test]
    fn internal_shell_api_is_enabled_only_for_validated_windows_builds() {
        for build in [26100, 26200] {
            assert!(supports_internal_desktop_api(10, 0, build));
        }
        for (major, minor, build) in [
            (10, 0, 22000),
            (10, 0, 22621),
            (10, 0, 22631),
            (10, 0, 26201),
            (11, 0, 26200),
            (10, 1, 26200),
        ] {
            assert!(!supports_internal_desktop_api(major, minor, build));
        }
    }

    #[test]
    fn desktop_id_is_validated_before_any_native_desktop_operation() {
        for op in ["inspectDesktop", "activateDesktop"] {
            assert_eq!(
                handle_desktop_stage_request(&json!({ "op":op, "desktopId":"bad" }))["error"],
                "invalid desktopId"
            );
        }
    }
}
