//! Exact Windows shell control inspection and invocation. Never synthesizes mouse input.
use serde_json::{json, Value};
use windows::core::Interface;
use windows::Win32::{
    Foundation::{HWND, POINT},
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
    UI::Accessibility::{
        CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement,
        IUIAutomationInvokePattern, IUIAutomationLegacyIAccessiblePattern,
        IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern,
        IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_ButtonControlTypeId,
        UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId, UIA_EditControlTypeId,
        UIA_HyperlinkControlTypeId, UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId,
        UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId,
        UIA_RadioButtonControlTypeId, UIA_ScrollPatternId, UIA_SelectionItemPatternId,
        UIA_TabItemControlTypeId, UIA_TogglePatternId, UIA_TreeItemControlTypeId,
        UIA_ValuePatternId,
    },
    UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    },
};

const MAX_DESKTOP_STRUCTURE_ELEMENTS: usize = 4096;
const MAX_DESKTOP_STRUCTURE_DEPTH: usize = 64;

/// Create one UI Automation client with implicit target focusing disabled.
/// Explicitly foregrounded input remains in its separate dispatch path; this
/// setting only prevents UIA patterns from activating a background target as
/// a side effect before invoking the requested semantic action.
fn create_non_focusing_automation() -> windows::core::Result<IUIAutomation> {
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }?;
    let automation2: IUIAutomation2 = automation.cast()?;
    unsafe {
        automation2.SetAutoSetFocus(false)?;
    }
    Ok(automation)
}

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// UIA's live runtime identity is shared across observers and does not depend on
/// a snapshot's generated ref or the control's current tree position.
fn element_runtime_id(element: &IUIAutomationElement) -> Option<Vec<i32>> {
    use windows::Win32::System::Com::SAFEARRAY;
    use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetDim,
        SafeArrayGetElemsize, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData};
    struct OwnedArray(*mut SAFEARRAY);
    impl Drop for OwnedArray {
        fn drop(&mut self) { unsafe { let _ = SafeArrayDestroy(self.0); } }
    }
    let array = unsafe { element.GetRuntimeId() }.ok()?;
    if array.is_null() { return None; }
    let owned = OwnedArray(array);
    if unsafe { SafeArrayGetDim(owned.0) } != 1 || unsafe { SafeArrayGetElemsize(owned.0) } != 4 { return None; }
    let lower = unsafe { SafeArrayGetLBound(owned.0, 1) }.ok()?;
    let upper = unsafe { SafeArrayGetUBound(owned.0, 1) }.ok()?;
    let length = upper.checked_sub(lower)?.checked_add(1)?;
    if !(1..=128).contains(&length) { return None; }
    let mut data = core::ptr::null_mut();
    unsafe { SafeArrayAccessData(owned.0, &mut data) }.ok()?;
    let result = if data.is_null() { None } else {
        Some(unsafe { core::slice::from_raw_parts(data.cast::<i32>(), length as usize) }.to_vec())
    };
    unsafe { let _ = SafeArrayUnaccessData(owned.0); }
    result
}

fn unix_nanos() -> String {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos().to_string()
}

#[cfg(feature = "test-fixtures")]
fn fixture_dispatch_barrier(value: &Value) -> Result<(), crate::InputDispatchError> {
    if value.get("fixtureDispatchBarrier").and_then(Value::as_bool) != Some(true) { return Ok(()); }
    let requested = std::env::var_os("M9R_NATIVE_TEST_BARRIER_DIR").ok_or_else(|| crate::InputDispatchError::not_dispatched("fixture barrier directory missing"))?;
    let directory = std::fs::canonicalize(requested).map_err(|e| crate::InputDispatchError::not_dispatched(e.to_string()))?;
    let temporary = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| crate::InputDispatchError::not_dispatched(e.to_string()))?;
    if !directory.starts_with(&temporary) || !directory.file_name().is_some_and(|name| name.to_string_lossy().starts_with("m9r-native-stream-barrier-")) {
        return Err(crate::InputDispatchError::not_dispatched("fixture barrier must be a disposable test directory"));
    }
    let released = directory.join("released");
    if released.exists() { return Ok(()); }
    let ready = directory.join(format!("ready-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(ready) {
        Ok(_) => (), Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(crate::InputDispatchError::not_dispatched(error.to_string())),
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let count = std::fs::read_dir(&directory).map_err(|e| crate::InputDispatchError::not_dispatched(e.to_string()))?
            .filter_map(Result::ok).filter(|entry| entry.file_name().to_string_lossy().starts_with("ready-")).count();
        if count >= 2 || released.exists() {
            let _ = std::fs::OpenOptions::new().write(true).create_new(true).open(&released);
            return Ok(());
        }
        if std::time::Instant::now() >= deadline { return Err(crate::InputDispatchError::not_dispatched("fixture dispatch barrier did not receive two independent native helpers")); }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

pub fn control_at_point(value: &Value, invoke: bool) -> Result<Value, crate::InputDispatchError> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let _apartment = ComApartment;
    let coordinate = |key| {
        value
            .get(key)
            .and_then(Value::as_i64)
            .filter(|n| (-32768..=32767).contains(n))
            .map(|n| n as i32)
            .ok_or_else(|| format!("invalid {key} coordinate"))
    };
    let point = POINT {
        x: coordinate("x")?,
        y: coordinate("y")?,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
    };
    let root = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
    if root.0.is_null() {
        return Err("The exact input window disappeared".into());
    }
    let mut root_pid = 0;
    unsafe { GetWindowThreadProcessId(root, Some(&mut root_pid)) };
    let automation = create_non_focusing_automation().map_err(|error| {
        crate::InputDispatchError::not_dispatched(format!(
            "UI Automation could not disable implicit target focus; no control action was sent: {error}"
        ))
    })?;
    let hit = unsafe { automation.ElementFromPoint(point) }.map_err(|e| e.to_string())?;
    // A decorative, unnamed icon/glyph child is a common hit target for a
    // normal toolbar/taskbar button (the visible, accessible control is its
    // parent). Walk up a few ancestors for one that is named, enabled, and
    // whose bounds still contain the point, rather than failing the whole
    // activation because the exact leaf happened to be unnamed.
    let walker: IUIAutomationTreeWalker =
        unsafe { automation.ControlViewWalker() }.map_err(|e| e.to_string())?;
    let mut element = hit;
    for _ in 0..4 {
        let label = unsafe { element.CurrentName() }
            .ok()
            .map(|v| v.to_string())
            .unwrap_or_default();
        let enabled = unsafe { element.CurrentIsEnabled() }
            .ok()
            .map(|v| v.as_bool())
            .unwrap_or(false);
        let pid = unsafe { element.CurrentProcessId() }.unwrap_or(0);
        let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
        let contains = rect.is_some_and(|r| {
            point.x >= r.left && point.y >= r.top && point.x < r.right && point.y < r.bottom
        });
        if pid > 0 && enabled && contains && !label.trim().is_empty() {
            break;
        }
        let Ok(parent) = (unsafe { walker.GetParentElement(&element) }) else {
            break;
        };
        element = parent;
    }
    let label = unsafe { element.CurrentName() }
        .map_err(|e| e.to_string())?
        .to_string();
    let class = unsafe { element.CurrentClassName() }
        .map_err(|e| e.to_string())?
        .to_string();
    let pid = unsafe { element.CurrentProcessId() }.map_err(|e| e.to_string())?;
    let rect = unsafe { element.CurrentBoundingRectangle() }.map_err(|e| e.to_string())?;
    let enabled = unsafe { element.CurrentIsEnabled() }
        .map_err(|e| e.to_string())?
        .as_bool();
    if pid <= 0
        || !enabled
        || label.trim().is_empty()
        || point.x < rect.left
        || point.y < rect.top
        || point.x >= rect.right
        || point.y >= rect.bottom
    {
        return Err("No named enabled accessibility control at the exact point".into());
    }
    let mut confirmed = false;
    let mut dispatch_accepted = false;
    if invoke {
        // Reinspection binds invocation to the previously inspected label and PID;
        // a changing taskbar cannot silently redirect the authorized action.
        if value.get("label").and_then(Value::as_str) != Some(&label)
            || value.get("pid").and_then(Value::as_i64) != Some(pid as i64)
            || value
                .get("windowId")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<u64>().ok())
                != Some(root.0 as u64)
            || value.get("windowPid").and_then(Value::as_u64) != Some(root_pid as u64)
        {
            return Err(
                "The accessibility control changed before invocation; no input was sent".into(),
            );
        }
        if let Ok(pattern) = unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }
            .and_then(|p| p.cast::<IUIAutomationInvokePattern>())
        {
            unsafe { pattern.Invoke() }
                .map_err(|e| crate::InputDispatchError::uncertain(e.to_string()))?;
            dispatch_accepted = true;
        } else if let Ok(pattern) = unsafe { element.GetCurrentPattern(UIA_TogglePatternId) }
            .and_then(|p| p.cast::<IUIAutomationTogglePattern>())
        {
            let before = unsafe { pattern.CurrentToggleState() }.map_err(|e| e.to_string())?;
            unsafe { pattern.Toggle() }
                .map_err(|e| crate::InputDispatchError::uncertain(e.to_string()))?;
            dispatch_accepted = true;
            confirmed = unsafe { pattern.CurrentToggleState() }
                .map_err(|e| crate::InputDispatchError::uncertain(e.to_string()))?
                != before;
        } else if let Ok(pattern) = unsafe { element.GetCurrentPattern(UIA_SelectionItemPatternId) }
            .and_then(|p| p.cast::<IUIAutomationSelectionItemPattern>())
        {
            unsafe { pattern.Select() }
                .map_err(|e| crate::InputDispatchError::uncertain(e.to_string()))?;
            dispatch_accepted = true;
        } else {
            // Windows taskbar buttons expose the older accessibility default
            // action rather than InvokePattern. Both are semantic operations;
            // neither requires cursor warping or simulated foreground input.
            let pattern: IUIAutomationLegacyIAccessiblePattern =
                unsafe { element.GetCurrentPattern(UIA_LegacyIAccessiblePatternId) }
                    .and_then(|p| p.cast())
                    .map_err(|e| {
                        format!("Control has no independent accessibility activation: {e}")
                    })?;
            unsafe { pattern.DoDefaultAction() }
                .map_err(|e| crate::InputDispatchError::uncertain(e.to_string()))?;
            dispatch_accepted = true;
        }
    }
    let supports_invoke = unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }
        .and_then(|p| p.cast::<IUIAutomationInvokePattern>())
        .is_ok();
    let supports_select = unsafe { element.GetCurrentPattern(UIA_SelectionItemPatternId) }
        .and_then(|p| p.cast::<IUIAutomationSelectionItemPattern>())
        .is_ok();
    let legacy = unsafe { element.GetCurrentPattern(UIA_LegacyIAccessiblePatternId) }
        .and_then(|p| p.cast::<IUIAutomationLegacyIAccessiblePattern>());
    let default_action = legacy
        .as_ref()
        .ok()
        .and_then(|p| unsafe { p.CurrentDefaultAction() }.ok())
        .map(|name| name.to_string());
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map_err(|e| {
            if dispatch_accepted {
                crate::InputDispatchError::uncertain(e.to_string())
            } else {
                crate::InputDispatchError::not_dispatched(e.to_string())
            }
        })?
        .as_bool();
    Ok(
        json!({"label":label,"class":class,"pid":pid,"windowId":(root.0 as u64).to_string(),"windowPid":root_pid,"supportsInvoke":supports_invoke,"supportsSelect":supports_select,"defaultAction":default_action,"focused":focused,"rect":{"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top},"invoked":invoke,"confirmed":confirmed}),
    )
}

/// Captures a bounded control-view UI Automation tree rooted at the Windows desktop.
///
/// This is deliberately a semantic snapshot only. Private process IDs, HWNDs, and
/// provider-specific COM handles stay inside the native boundary; the TypeScript
/// stage maps these screen-space rectangles into the exact desktop capture used by
/// the provider. An incomplete tree is still useful, so depth/element limits and
/// individual UIA read failures degrade to `partial` instead of making the whole
/// desktop observation unavailable.
pub fn desktop_structure(value: &Value) -> Result<Value, String> {
    let max_elements = value
        .get("maxElements")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_DESKTOP_STRUCTURE_ELEMENTS as u64)
        .clamp(1, MAX_DESKTOP_STRUCTURE_ELEMENTS as u64) as usize;
    let max_depth = value
        .get("maxDepth")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_DESKTOP_STRUCTURE_DEPTH as u64)
        .clamp(0, MAX_DESKTOP_STRUCTURE_DEPTH as u64) as usize;

    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let _apartment = ComApartment;
    let automation = create_non_focusing_automation().map_err(|error| {
        format!("UI Automation could not disable implicit target focus: {error}")
    })?;
    let root = unsafe { automation.GetRootElement() }.map_err(|e| e.to_string())?;
    let walker: IUIAutomationTreeWalker =
        unsafe { automation.ControlViewWalker() }.map_err(|e| e.to_string())?;

    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 {
        return Err("Windows returned an invalid virtual-screen rectangle".into());
    }

    let mut elements = Vec::with_capacity(max_elements);
    let mut truncated = false;
    let mut next_ref = 0usize;
    let first = unsafe { walker.GetFirstChildElement(&root) };
    if let Ok(child) = first {
        walk_desktop_elements(
            &walker,
            &child,
            0,
            max_depth,
            max_elements,
            &mut elements,
            &mut next_ref,
            &mut truncated,
        );
    }

    Ok(json!({
        "scope": "desktop",
        "status": if truncated { "partial" } else { "complete" },
        "screen": { "x": origin_x, "y": origin_y, "width": width, "height": height },
        "elements": elements,
        "truncated": truncated,
    }))
}

/// Reads a control-view tree rooted at one already validated HWND.  Unlike the
/// desktop snapshot this never walks sibling application windows, so a stage
/// observation cannot spend its budget on unrelated surfaces.
pub fn window_structure(value: &Value) -> Result<Value, String> {
    let handle = value
        .get("windowId")
        .and_then(Value::as_str)
        .and_then(|raw| {
            raw.strip_prefix("0x")
                .or_else(|| raw.strip_prefix("0X"))
                .and_then(|hex| usize::from_str_radix(hex, 16).ok())
                .or_else(|| raw.parse::<u64>().ok().map(|n| n as usize))
        })
        .filter(|handle| *handle != 0)
        .ok_or_else(|| "invalid window handle".to_string())?;
    let max_elements = value
        .get("maxElements")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_DESKTOP_STRUCTURE_ELEMENTS as u64)
        .clamp(1, MAX_DESKTOP_STRUCTURE_ELEMENTS as u64) as usize;
    let max_depth = value
        .get("maxDepth")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_DESKTOP_STRUCTURE_DEPTH as u64)
        .clamp(0, MAX_DESKTOP_STRUCTURE_DEPTH as u64) as usize;
    let snapshot_id = value
        .get("snapshotId")
        .and_then(Value::as_str)
        .unwrap_or("native");
    if snapshot_id.is_empty()
        || snapshot_id.len() > 64
        || !snapshot_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid native observation identity".into());
    }
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let _apartment = ComApartment;
    let automation = create_non_focusing_automation().map_err(|error| {
        format!("UI Automation could not disable implicit target focus: {error}")
    })?;
    let hwnd = HWND(handle as *mut core::ffi::c_void);
    let root = unsafe { automation.ElementFromHandle(hwnd) }.map_err(|e| e.to_string())?;
    let walker: IUIAutomationTreeWalker =
        unsafe { automation.ControlViewWalker() }.map_err(|e| e.to_string())?;
    let mut elements = Vec::with_capacity(max_elements);
    let mut truncated = false;
    let mut next_ref = 0usize;
    walk_window_element(
        &walker,
        &root,
        0,
        max_depth,
        max_elements,
        &mut elements,
        &mut next_ref,
        &mut truncated,
        &mut Vec::new(),
        snapshot_id,
    );
    Ok(json!({
        "scope": "window",
        "windowId": handle.to_string(),
        "status": if truncated { "partial" } else { "complete" },
        "elements": elements,
        "truncated": truncated,
    }))
}

fn walk_window_element(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    depth: usize,
    max_depth: usize,
    max_elements: usize,
    elements: &mut Vec<Value>,
    next_ref: &mut usize,
    truncated: &mut bool,
    path: &mut Vec<usize>,
    snapshot_id: &str,
) {
    if elements.len() >= max_elements {
        *truncated = true;
        return;
    }
    let control = unsafe { element.CurrentIsControlElement() }
        .map(|v| v.as_bool())
        .unwrap_or(false);
    let offscreen = unsafe { element.CurrentIsOffscreen() }
        .map(|v| v.as_bool())
        .unwrap_or(true);
    let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
    let visible = rect
        .as_ref()
        .is_some_and(|r| r.right > r.left && r.bottom > r.top);
    let label = unsafe { element.CurrentName() }
        .ok()
        .map(|v| v.to_string())
        .unwrap_or_default();
    let role = unsafe { element.CurrentControlType() }
        .ok()
        .and_then(canonical_control_type_name)
        .map(str::to_owned)
        .or_else(|| {
            unsafe { element.CurrentLocalizedControlType() }
                .ok()
                .map(|v| v.to_string())
        })
        .unwrap_or_default();
    let class_name = unsafe { element.CurrentClassName() }
        .ok()
        .map(|v| v.to_string())
        .unwrap_or_default();
    let automation_id = unsafe { element.CurrentAutomationId() }
        .ok()
        .map(|v| v.to_string())
        .unwrap_or_default();
    let enabled = unsafe { element.CurrentIsEnabled() }
        .map(|v| v.as_bool())
        .unwrap_or(false);
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map(|v| v.as_bool())
        .unwrap_or(false);
    if control && !offscreen && visible && (!label.trim().is_empty() || !role.trim().is_empty()) {
        *next_ref += 1;
        let bounds = rect.expect("visible UIA element must have bounds");
        let supports_invoke = unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }
            .and_then(|p| p.cast::<IUIAutomationInvokePattern>())
            .is_ok();
        let supports_select = unsafe { element.GetCurrentPattern(UIA_SelectionItemPatternId) }
            .and_then(|p| p.cast::<IUIAutomationSelectionItemPattern>())
            .is_ok();
        let supports_toggle = unsafe { element.GetCurrentPattern(UIA_TogglePatternId) }
            .and_then(|p| p.cast::<IUIAutomationTogglePattern>())
            .is_ok();
        let supports_legacy = unsafe { element.GetCurrentPattern(UIA_LegacyIAccessiblePatternId) }
            .and_then(|p| p.cast::<IUIAutomationLegacyIAccessiblePattern>())
            .ok()
            .and_then(|pattern| unsafe { pattern.CurrentDefaultAction() }.ok())
            .is_some_and(|action| !action.to_string().trim().is_empty());
        let value_pattern = unsafe { element.GetCurrentPattern(UIA_ValuePatternId) }
            .and_then(|p| p.cast::<IUIAutomationValuePattern>())
            .ok();
        let supports_value = value_pattern.as_ref().is_some_and(|pattern| {
            unsafe { pattern.CurrentIsReadOnly() }
                .map(|read_only| !read_only.as_bool())
                .unwrap_or(false)
        });
        // Readability is advertised separately from editability. Password
        // controls are never exposed to the targeted read path.
        let supports_read_value = value_pattern.is_some()
            && unsafe { element.CurrentIsPassword() }
                .map(|password| !password.as_bool())
                .unwrap_or(false);
        let scroll_state = current_scroll_state(element);
        let supports_scroll = scroll_state.as_ref().is_some_and(|state| {
            state["horizontal"]["scrollable"].as_bool().unwrap_or(false)
                || state["vertical"]["scrollable"].as_bool().unwrap_or(false)
        });
        elements.push(json!({
            "ref": format!("window-ui-element-{}-{}", snapshot_id, next_ref),
            "path": path,
            "label": truncate_text(&label, 160),
            "role": truncate_text(&role, 80),
            "className": truncate_text(&class_name, 120),
            "automationId": truncate_text(&automation_id, 256),
            "runtimeId": element_runtime_id(element),
            "rect": { "x": bounds.left, "y": bounds.top, "width": bounds.right - bounds.left, "height": bounds.bottom - bounds.top },
            "depth": depth, "enabled": enabled, "focused": focused,
            "actions": { "invoke": supports_invoke, "select": supports_select, "toggle": supports_toggle, "legacy": supports_legacy, "setValue": supports_value, "readValue": supports_read_value, "scroll": supports_scroll },
            "scroll": scroll_state,
        }));
    }
    if depth >= max_depth {
        if unsafe { walker.GetFirstChildElement(element) }.is_ok() {
            *truncated = true;
        }
        return;
    }
    let Ok(mut child) = (unsafe { walker.GetFirstChildElement(element) }) else {
        return;
    };
    let mut child_index = 0usize;
    loop {
        if elements.len() >= max_elements {
            *truncated = true;
            return;
        }
        path.push(child_index);
        walk_window_element(
            walker,
            &child,
            depth + 1,
            max_depth,
            max_elements,
            elements,
            next_ref,
            truncated,
            path,
            snapshot_id,
        );
        path.pop();
        child_index += 1;
        if *truncated && elements.len() >= max_elements {
            return;
        }
        let Ok(next) = (unsafe { walker.GetNextSiblingElement(&child) }) else {
            return;
        };
        child = next;
    }
}

/// Re-resolves a window-scoped UIA ref immediately before using a semantic
/// pattern. The ref is a Control View child-index path from the exact HWND;
/// role, name, class, and AutomationId are checked again so a changed tree can
/// never silently redirect an old ref to a different control.
pub fn invoke_window_element(value: &Value) -> Result<Value, crate::InputDispatchError> {
    use windows::core::BSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{
        IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationLegacyIAccessiblePattern,
        IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern,
        IUIAutomationTreeWalker, IUIAutomationValuePattern, ScrollAmount_LargeDecrement,
        ScrollAmount_LargeIncrement, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement,
        ScrollAmount_SmallIncrement, UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId,
        UIA_ScrollPatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .ok_or_else(|| {
            crate::InputDispatchError::not_dispatched(
                "invalid process id; no semantic input was sent",
            )
        })? as u32;
    let raw_handle = value
        .get("windowId")
        .and_then(Value::as_str)
        .and_then(|raw| {
            if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
                usize::from_str_radix(hex, 16).ok()
            } else {
                raw.parse::<u64>().ok().map(|n| n as usize)
            }
        })
        .filter(|handle| *handle != 0)
        .ok_or_else(|| {
            crate::InputDispatchError::not_dispatched(
                "invalid window handle; no semantic input was sent",
            )
        })?;
    let hwnd = HWND(raw_handle as *mut core::ffi::c_void);
    if unsafe { IsWindow(Some(hwnd)) }.0 == 0 {
        return Err(crate::InputDispatchError::not_dispatched(
            "The target window no longer exists; no semantic input was sent",
        ));
    }
    let mut actual_pid = 0u32;
    if unsafe { GetWindowThreadProcessId(hwnd, Some(&mut actual_pid)) } == 0 || actual_pid != pid {
        return Err(crate::InputDispatchError::not_dispatched(
            "The target window process changed; no semantic input was sent",
        ));
    }
    let action = value.get("action").and_then(Value::as_str).ok_or_else(|| {
        crate::InputDispatchError::not_dispatched(
            "semantic action is required; no semantic input was sent",
        )
    })?;
    let path = value.get("path").and_then(Value::as_array).ok_or_else(|| {
        crate::InputDispatchError::not_dispatched(
            "native element path is required; no semantic input was sent",
        )
    })?;
    if path.len() > MAX_DESKTOP_STRUCTURE_DEPTH {
        return Err(crate::InputDispatchError::not_dispatched(
            "native element path exceeds the observed tree depth; no semantic input was sent",
        ));
    }
    let mut path = path
        .iter()
        .map(|index| {
            index
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| {
                    crate::InputDispatchError::not_dispatched(
                        "native element path contains an invalid index; no semantic input was sent",
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let expected_role = value
        .get("expectedRole")
        .and_then(Value::as_str)
        .unwrap_or("");
    let expected_label = value
        .get("expectedLabel")
        .and_then(Value::as_str)
        .unwrap_or("");
    let expected_class = value
        .get("expectedClassName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let expected_automation_id = value
        .get("expectedAutomationId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if expected_role.is_empty() || (expected_label.is_empty() && expected_automation_id.is_empty() && value.get("expectedRuntimeId").is_none())
    {
        return Err(crate::InputDispatchError::not_dispatched(
            "The observed native element has insufficient identity to revalidate; no semantic input was sent",
        ));
    }

    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|e| crate::InputDispatchError::not_dispatched(e.to_string()))?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _apartment = Apartment;
    let automation = create_non_focusing_automation().map_err(|error| {
        crate::InputDispatchError::not_dispatched(format!(
            "UI Automation could not disable implicit target focus; no semantic input was sent: {error}"
        ))
    })?;
    let walker: IUIAutomationTreeWalker = unsafe { automation.ControlViewWalker() }
        .map_err(|e| crate::InputDispatchError::not_dispatched(e.to_string()))?;
    let mut element: IUIAutomationElement = unsafe { automation.ElementFromHandle(hwnd) }
        .map_err(|e| crate::InputDispatchError::not_dispatched(e.to_string()))?;
    for child_index in path.drain(..) {
        let mut child = unsafe { walker.GetFirstChildElement(&element) }.map_err(|_| {
            crate::InputDispatchError::not_dispatched(
                "The native element path became stale; no semantic input was sent",
            )
        })?;
        for _ in 0..child_index {
            child = unsafe { walker.GetNextSiblingElement(&child) }.map_err(|_| {
                crate::InputDispatchError::not_dispatched(
                    "The native element path became stale; no semantic input was sent",
                )
            })?;
        }
        element = child;
    }
    let role = unsafe { element.CurrentControlType() }
        .ok()
        .and_then(canonical_control_type_name)
        .unwrap_or_default();
    let label = unsafe { element.CurrentName() }
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let class_name = unsafe { element.CurrentClassName() }
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let automation_id = unsafe { element.CurrentAutomationId() }
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_default();
    if role != expected_role
        || truncate_text(&label, 160) != expected_label
        || (!expected_class.is_empty() && truncate_text(&class_name, 120) != expected_class)
        || (!expected_automation_id.is_empty()
            && truncate_text(&automation_id, 256) != expected_automation_id)
    {
        return Err(crate::InputDispatchError::not_dispatched(
            "The observed native element changed before dispatch; no semantic input was sent",
        ));
    }
    if let Some(expected) = value.get("expectedRuntimeId") {
        let expected = expected.as_array().filter(|items| !items.is_empty() && items.len() <= 128)
            .and_then(|items| items.iter().map(|item| item.as_i64().and_then(|n| i32::try_from(n).ok())).collect::<Option<Vec<_>>>())
            .ok_or_else(|| crate::InputDispatchError::not_dispatched("invalid observed UIA runtime identity; no semantic input was sent"))?;
        if element_runtime_id(&element).as_ref() != Some(&expected) {
            return Err(crate::InputDispatchError::not_dispatched("The observed UIA runtime identity changed; no semantic input was sent"));
        }
    }

    if action == "scroll" {
        let direction = value
            .get("direction")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::InputDispatchError::not_dispatched("scroll direction is required")
            })?;
        let granularity = value
            .get("granularity")
            .and_then(Value::as_str)
            .unwrap_or("small");
        let increment = match (direction, granularity) {
            ("up", "small") | ("left", "small") => ScrollAmount_SmallDecrement,
            ("down", "small") | ("right", "small") => ScrollAmount_SmallIncrement,
            ("up", "large") | ("left", "large") => ScrollAmount_LargeDecrement,
            ("down", "large") | ("right", "large") => ScrollAmount_LargeIncrement,
            _ => {
                return Err(crate::InputDispatchError::not_dispatched(
                    "unsupported scroll direction or granularity",
                ))
            }
        };
        let (horizontal, vertical) = if direction == "left" || direction == "right" {
            (increment, ScrollAmount_NoAmount)
        } else {
            (ScrollAmount_NoAmount, increment)
        };
        let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_ScrollPatternId) })
            .and_then(|pattern| pattern.cast::<IUIAutomationScrollPattern>())
        else {
            return Ok(json!({"dispatched":false,"reason":"scroll-pattern-unavailable"}));
        };
        let before = scroll_pattern_position(&pattern);
        unsafe { pattern.Scroll(horizontal, vertical) }
            .map_err(|error| crate::InputDispatchError::uncertain(error.to_string()))?;
        let after = scroll_pattern_position(&pattern);
        let axis = if direction == "left" || direction == "right" {
            "horizontal"
        } else {
            "vertical"
        };
        let moved = scroll_position_changed(Some(&before), Some(&after), axis);
        return Ok(
            json!({"dispatched":true,"mechanism":"scroll-pattern","scrollBefore":before,"scrollAfter":after,"moved":moved}),
        );
    }
    if action == "setValue" {
        let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_ValuePatternId) })
            .and_then(|pattern| pattern.cast::<IUIAutomationValuePattern>())
        else {
            return Ok(json!({"dispatched":false,"reason":"value-pattern-unavailable"}));
        };
        if unsafe { pattern.CurrentIsReadOnly() }
            .map_err(|error| crate::InputDispatchError::not_dispatched(error.to_string()))?
            .as_bool()
        {
            return Ok(json!({"dispatched":false,"reason":"value-pattern-read-only"}));
        }
        let text = value.get("text").and_then(Value::as_str).ok_or_else(|| {
            crate::InputDispatchError::not_dispatched("replacement text is required")
        })?;
        // Only the optional, executable-scoped acceptance host enables this
        // stress barrier. Ordinary release builds compile this call out.
        #[cfg(feature = "test-fixtures")]
        fixture_dispatch_barrier(value)?;
        let dispatch_started = unix_nanos();
        unsafe { pattern.SetValue(&BSTR::from(text)) }
            .map_err(|error| crate::InputDispatchError::uncertain(error.to_string()))?;
        let dispatch_ended = unix_nanos();
        // A successful SetValue call is only dispatch evidence. Re-read the
        // same live UIA value before reporting that the field accepted it; do
        // not return the field contents because it may contain user data.
        let value_confirmed = unsafe { pattern.CurrentValue() }
            .map(|current| current.to_string() == text)
            .unwrap_or(false);
        return Ok(
            json!({"dispatched":true,"mechanism":"value-pattern","valueConfirmed":value_confirmed,
                "nativeDispatch": { "helperPid": std::process::id(), "startedUnixNanos": dispatch_started, "endedUnixNanos": dispatch_ended }}),
        );
    }
    if action == "readValue" {
        let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_ValuePatternId) })
            .and_then(|pattern| pattern.cast::<IUIAutomationValuePattern>())
        else {
            return Ok(
                json!({"dispatched":false,"read":false,"reason":"value-pattern-unavailable"}),
            );
        };
        let is_password = unsafe { element.CurrentIsPassword() }
            .map_err(|error| crate::InputDispatchError::not_dispatched(error.to_string()))?
            .as_bool();
        if is_password {
            return Ok(
                json!({"dispatched":false,"read":false,"redacted":true,"reason":"password-control"}),
            );
        }
        let max_chars = value
            .get("maxChars")
            .and_then(Value::as_u64)
            .filter(|value| (1..=4096).contains(value))
            .unwrap_or(512) as usize;
        let current = unsafe { pattern.CurrentValue() }
            .map_err(|error| crate::InputDispatchError::not_dispatched(error.to_string()))?
            .to_string();
        let mut characters = current.chars();
        let value: String = characters.by_ref().take(max_chars).collect();
        let truncated = characters.next().is_some();
        return Ok(json!({"dispatched":false,"read":true,"value":value,"truncated":truncated}));
    }
    if action != "activate" {
        return Err(crate::InputDispatchError::not_dispatched(
            "unsupported native semantic action",
        ));
    }
    if let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_InvokePatternId) })
        .and_then(|pattern| pattern.cast::<IUIAutomationInvokePattern>())
    {
        unsafe { pattern.Invoke() }
            .map_err(|error| crate::InputDispatchError::uncertain(error.to_string()))?;
        return Ok(json!({"dispatched":true,"mechanism":"invoke-pattern"}));
    }
    if let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_SelectionItemPatternId) })
        .and_then(|pattern| pattern.cast::<IUIAutomationSelectionItemPattern>())
    {
        unsafe { pattern.Select() }
            .map_err(|error| crate::InputDispatchError::uncertain(error.to_string()))?;
        return Ok(json!({"dispatched":true,"mechanism":"selection-pattern"}));
    }
    if let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_TogglePatternId) })
        .and_then(|pattern| pattern.cast::<IUIAutomationTogglePattern>())
    {
        unsafe { pattern.Toggle() }
            .map_err(|error| crate::InputDispatchError::uncertain(error.to_string()))?;
        return Ok(json!({"dispatched":true,"mechanism":"toggle-pattern"}));
    }
    if let Ok(pattern) = (unsafe { element.GetCurrentPattern(UIA_LegacyIAccessiblePatternId) })
        .and_then(|pattern| pattern.cast::<IUIAutomationLegacyIAccessiblePattern>())
    {
        if unsafe { pattern.CurrentDefaultAction() }
            .ok()
            .is_some_and(|value| !value.to_string().trim().is_empty())
        {
            unsafe { pattern.DoDefaultAction() }
                .map_err(|error| crate::InputDispatchError::uncertain(error.to_string()))?;
            return Ok(json!({"dispatched":true,"mechanism":"legacy-default-action"}));
        }
    }
    Ok(json!({"dispatched":false,"reason":"activation-pattern-unavailable"}))
}

fn finite_scroll_percent(value: windows::core::Result<f64>) -> Option<f64> {
    value
        .ok()
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}

fn current_scroll_state(element: &IUIAutomationElement) -> Option<Value> {
    let pattern: IUIAutomationScrollPattern =
        unsafe { element.GetCurrentPattern(UIA_ScrollPatternId) }
            .ok()?
            .cast()
            .ok()?;
    Some(scroll_pattern_state(&pattern))
}

fn scroll_pattern_state(pattern: &IUIAutomationScrollPattern) -> Value {
    let horizontal_scrollable = unsafe { pattern.CurrentHorizontallyScrollable() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let vertical_scrollable = unsafe { pattern.CurrentVerticallyScrollable() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    json!({
        "horizontal": {
            "scrollable": horizontal_scrollable,
            "percent": finite_scroll_percent(unsafe { pattern.CurrentHorizontalScrollPercent() }),
            "viewSize": finite_scroll_percent(unsafe { pattern.CurrentHorizontalViewSize() }),
        },
        "vertical": {
            "scrollable": vertical_scrollable,
            "percent": finite_scroll_percent(unsafe { pattern.CurrentVerticalScrollPercent() }),
            "viewSize": finite_scroll_percent(unsafe { pattern.CurrentVerticalViewSize() }),
        },
    })
}

fn scroll_pattern_position(pattern: &IUIAutomationScrollPattern) -> Value {
    let state = scroll_pattern_state(pattern);
    json!({"horizontal": state["horizontal"]["percent"], "vertical": state["vertical"]["percent"]})
}

fn scroll_position_changed(
    before: Option<&Value>,
    after: Option<&Value>,
    axis: &str,
) -> Option<bool> {
    let (Some(before), Some(after)) = (before, after) else {
        return None;
    };
    let old = before[axis].as_f64()?;
    let new = after[axis].as_f64()?;
    Some((old - new).abs() > f64::EPSILON)
}

fn walk_desktop_elements(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    depth: usize,
    max_depth: usize,
    max_elements: usize,
    elements: &mut Vec<Value>,
    next_ref: &mut usize,
    truncated: &mut bool,
) {
    if elements.len() >= max_elements {
        *truncated = true;
        return;
    }

    let control = unsafe { element.CurrentIsControlElement() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let offscreen = unsafe { element.CurrentIsOffscreen() }
        .map(|value| value.as_bool())
        .unwrap_or(true);
    let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
    let rect_is_visible = rect
        .as_ref()
        .is_some_and(|value| value.right > value.left && value.bottom > value.top);
    let label = unsafe { element.CurrentName() }
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_default();
    // CurrentLocalizedControlType returns the OS display language's name
    // (e.g. French "bouton" instead of "button"), but role-based reasoning
    // elsewhere in the stack (role === "textbox", etc.) assumes English.
    // CurrentControlType is a locale-independent numeric UIA constant; map
    // the common ones to the same canonical English names so role matching
    // keeps working on a non-English Windows install. Fall back to the
    // localized string for the long tail of control types.
    let role = unsafe { element.CurrentControlType() }
        .ok()
        .and_then(canonical_control_type_name)
        .map(|value| value.to_string())
        .or_else(|| {
            unsafe { element.CurrentLocalizedControlType() }
                .ok()
                .map(|value| value.to_string())
        })
        .unwrap_or_default();
    let class_name = unsafe { element.CurrentClassName() }
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let enabled = unsafe { element.CurrentIsEnabled() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map(|value| value.as_bool())
        .unwrap_or(false);

    if control
        && !offscreen
        && rect_is_visible
        && (!label.trim().is_empty() || !role.trim().is_empty())
    {
        *next_ref += 1;
        let bounds = rect.expect("visible UIA element must have bounds");
        elements.push(json!({
            "ref": format!("desktop-ui-element-{}", next_ref),
            "label": truncate_text(&label, 160),
            "role": truncate_text(&role, 80),
            "className": truncate_text(&class_name, 120),
            "rect": { "x": bounds.left, "y": bounds.top, "width": bounds.right - bounds.left, "height": bounds.bottom - bounds.top },
            "depth": depth,
            "enabled": enabled,
            "focused": focused,
        }));
    }

    if depth >= max_depth {
        if unsafe { walker.GetFirstChildElement(element) }.is_ok() {
            *truncated = true;
        }
        return;
    }

    let Ok(mut child) = (unsafe { walker.GetFirstChildElement(element) }) else {
        return;
    };
    loop {
        if elements.len() >= max_elements {
            *truncated = true;
            return;
        }
        walk_desktop_elements(
            walker,
            &child,
            depth + 1,
            max_depth,
            max_elements,
            elements,
            next_ref,
            truncated,
        );
        if *truncated && elements.len() >= max_elements {
            return;
        }
        let Ok(next) = (unsafe { walker.GetNextSiblingElement(&child) }) else {
            return;
        };
        child = next;
    }
}

fn truncate_text(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_ui_automation_client_disables_automatic_target_focus() {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .expect("initialize COM for the UI Automation setting check");
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let _apartment = Apartment;

        let automation = create_non_focusing_automation().expect("create configured UIA client");
        let automation2: IUIAutomation2 = automation.cast().expect("IUIAutomation2 interface");
        assert!(
            !unsafe { automation2.AutoSetFocus() }
                .expect("read the configured AutoSetFocus value")
                .as_bool(),
            "semantic UIA calls must not automatically focus their target"
        );
    }

    #[test]
    fn scroll_progress_uses_only_the_requested_axis_and_preserves_unknown_state() {
        let before = json!({ "horizontal": 30.0, "vertical": 40.0 });
        let after = json!({ "horizontal": 30.0, "vertical": 41.0 });
        assert_eq!(
            scroll_position_changed(Some(&before), Some(&after), "vertical"),
            Some(true)
        );
        assert_eq!(
            scroll_position_changed(Some(&before), Some(&after), "horizontal"),
            Some(false)
        );
        let tiny_move = json!({ "horizontal": 30.0, "vertical": 40.000_001 });
        assert_eq!(
            scroll_position_changed(Some(&before), Some(&tiny_move), "vertical"),
            Some(true)
        );
        let unavailable = json!({ "horizontal": null, "vertical": null });
        assert_eq!(
            scroll_position_changed(Some(&unavailable), Some(&after), "vertical"),
            None
        );
    }
}

#[allow(non_upper_case_globals)]
fn canonical_control_type_name(
    control_type: windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID,
) -> Option<&'static str> {
    match control_type {
        UIA_ButtonControlTypeId => Some("button"),
        UIA_CheckBoxControlTypeId => Some("checkbox"),
        UIA_ComboBoxControlTypeId => Some("combo box"),
        UIA_EditControlTypeId => Some("edit"),
        UIA_HyperlinkControlTypeId => Some("hyperlink"),
        UIA_ListControlTypeId => Some("list"),
        UIA_ListItemControlTypeId => Some("list item"),
        UIA_MenuItemControlTypeId => Some("menu item"),
        UIA_RadioButtonControlTypeId => Some("radio button"),
        UIA_TabItemControlTypeId => Some("tab item"),
        UIA_TreeItemControlTypeId => Some("tree item"),
        _ => None,
    }
}
