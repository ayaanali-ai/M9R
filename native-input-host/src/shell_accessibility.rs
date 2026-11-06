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
        IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationTreeWalker,
        IUIAutomationValuePattern, UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId,
        UIA_ComboBoxControlTypeId, UIA_EditControlTypeId, UIA_HyperlinkControlTypeId,
        UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId, UIA_ListControlTypeId,
        UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId, UIA_RadioButtonControlTypeId,
        UIA_SelectionItemPatternId, UIA_TabItemControlTypeId, UIA_TogglePatternId,
        UIA_TreeItemControlTypeId, UIA_ValuePatternId,
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
        let supports_value = unsafe { element.GetCurrentPattern(UIA_ValuePatternId) }
            .and_then(|p| p.cast::<IUIAutomationValuePattern>())
            .ok()
            .is_some_and(|pattern| {
                unsafe { pattern.CurrentIsReadOnly() }
                    .map(|read_only| !read_only.as_bool())
                    .unwrap_or(false)
            });
        elements.push(json!({
            "ref": format!("window-ui-element-{}-{}", snapshot_id, next_ref),
            "path": path,
            "label": truncate_text(&label, 160),
            "role": truncate_text(&role, 80),
            "className": truncate_text(&class_name, 120),
            "automationId": truncate_text(&automation_id, 256),
            "rect": { "x": bounds.left, "y": bounds.top, "width": bounds.right - bounds.left, "height": bounds.bottom - bounds.top },
            "depth": depth, "enabled": enabled, "focused": focused,
            "actions": { "invoke": supports_invoke, "select": supports_select, "toggle": supports_toggle, "legacy": supports_legacy, "setValue": supports_value },
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
        IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationTreeWalker,
        IUIAutomationValuePattern, UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId,
        UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
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
    if expected_role.is_empty() || (expected_label.is_empty() && expected_automation_id.is_empty())
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
        unsafe { pattern.SetValue(&BSTR::from(text)) }
            .map_err(|error| crate::InputDispatchError::uncertain(error.to_string()))?;
        // A successful SetValue call is only dispatch evidence. Re-read the
        // same live UIA value before reporting that the field accepted it; do
        // not return the field contents because it may contain user data.
        let value_confirmed = unsafe { pattern.CurrentValue() }
            .map(|current| current.to_string() == text)
            .unwrap_or(false);
        return Ok(
            json!({"dispatched":true,"mechanism":"value-pattern","valueConfirmed":value_confirmed}),
        );
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
