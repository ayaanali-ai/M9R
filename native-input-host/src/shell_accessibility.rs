//! Exact Windows shell control inspection and invocation. Never synthesizes mouse input.
use serde_json::{json, Value};
use windows::core::Interface;
use windows::Win32::{
    Foundation::POINT,
    System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED, CLSCTX_INPROC_SERVER},
    UI::Accessibility::{
        CUIAutomation8, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        IUIAutomationLegacyIAccessiblePattern, IUIAutomationSelectionItemPattern,
        IUIAutomationTogglePattern, IUIAutomationTreeWalker, UIA_InvokePatternId,
        UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId, UIA_EditControlTypeId,
        UIA_HyperlinkControlTypeId, UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId,
        UIA_RadioButtonControlTypeId, UIA_TabItemControlTypeId, UIA_TreeItemControlTypeId,
        UIA_LegacyIAccessiblePatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId,
    },
    UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN},
};

const MAX_DESKTOP_STRUCTURE_ELEMENTS: usize = 4096;
const MAX_DESKTOP_STRUCTURE_DEPTH: usize = 64;

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn control_at_point(value: &Value, invoke: bool) -> Result<Value, String> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().map_err(|e| e.to_string())?;
    let _apartment = ComApartment;
    let coordinate = |key| value.get(key).and_then(Value::as_i64)
        .filter(|n| (-32768..=32767).contains(n)).map(|n| n as i32).ok_or_else(|| format!("invalid {key} coordinate"));
    let point = POINT { x: coordinate("x")?, y: coordinate("y")? };
    use windows::Win32::UI::WindowsAndMessaging::{WindowFromPoint, GetAncestor, GA_ROOT, GetWindowThreadProcessId};
    let root = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
    if root.0.is_null() { return Err("The exact input window disappeared".into()); }
    let mut root_pid = 0;
    unsafe { GetWindowThreadProcessId(root, Some(&mut root_pid)) };
    let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    let hit = unsafe { automation.ElementFromPoint(point) }.map_err(|e| e.to_string())?;
    // A decorative, unnamed icon/glyph child is a common hit target for a
    // normal toolbar/taskbar button (the visible, accessible control is its
    // parent). Walk up a few ancestors for one that is named, enabled, and
    // whose bounds still contain the point, rather than failing the whole
    // activation because the exact leaf happened to be unnamed.
    let walker: IUIAutomationTreeWalker = unsafe { automation.ControlViewWalker() }.map_err(|e| e.to_string())?;
    let mut element = hit;
    for _ in 0..4 {
        let label = unsafe { element.CurrentName() }.ok().map(|v| v.to_string()).unwrap_or_default();
        let enabled = unsafe { element.CurrentIsEnabled() }.ok().map(|v| v.as_bool()).unwrap_or(false);
        let pid = unsafe { element.CurrentProcessId() }.unwrap_or(0);
        let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
        let contains = rect.is_some_and(|r| point.x >= r.left && point.y >= r.top && point.x < r.right && point.y < r.bottom);
        if pid > 0 && enabled && contains && !label.trim().is_empty() { break; }
        let Ok(parent) = (unsafe { walker.GetParentElement(&element) }) else { break; };
        element = parent;
    }
    let label = unsafe { element.CurrentName() }.map_err(|e| e.to_string())?.to_string();
    let class = unsafe { element.CurrentClassName() }.map_err(|e| e.to_string())?.to_string();
    let pid = unsafe { element.CurrentProcessId() }.map_err(|e| e.to_string())?;
    let rect = unsafe { element.CurrentBoundingRectangle() }.map_err(|e| e.to_string())?;
    let enabled = unsafe { element.CurrentIsEnabled() }.map_err(|e| e.to_string())?.as_bool();
    if pid <= 0 || !enabled || label.trim().is_empty() || point.x < rect.left || point.y < rect.top || point.x >= rect.right || point.y >= rect.bottom {
        return Err("No named enabled accessibility control at the exact point".into());
    }
    let mut confirmed = false;
    if invoke {
        // Reinspection binds invocation to the previously inspected label and PID;
        // a changing taskbar cannot silently redirect the authorized action.
        if value.get("label").and_then(Value::as_str) != Some(&label) || value.get("pid").and_then(Value::as_i64) != Some(pid as i64)
            || value.get("windowId").and_then(Value::as_str).and_then(|s| s.parse::<u64>().ok()) != Some(root.0 as u64)
            || value.get("windowPid").and_then(Value::as_u64) != Some(root_pid as u64) {
            return Err("The accessibility control changed before invocation; no input was sent".into());
        }
        if let Ok(pattern) = unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }.and_then(|p| p.cast::<IUIAutomationInvokePattern>()) {
            unsafe { pattern.Invoke() }.map_err(|e| e.to_string())?;
        } else if let Ok(pattern) = unsafe { element.GetCurrentPattern(UIA_TogglePatternId) }.and_then(|p| p.cast::<IUIAutomationTogglePattern>()) {
            let before = unsafe { pattern.CurrentToggleState() }.map_err(|e| e.to_string())?;
            unsafe { pattern.Toggle() }.map_err(|e| e.to_string())?;
            confirmed = unsafe { pattern.CurrentToggleState() }.map_err(|e| e.to_string())? != before;
        } else if let Ok(pattern) = unsafe { element.GetCurrentPattern(UIA_SelectionItemPatternId) }.and_then(|p| p.cast::<IUIAutomationSelectionItemPattern>()) {
            unsafe { pattern.Select() }.map_err(|e| e.to_string())?;
        } else {
            // Windows taskbar buttons expose the older accessibility default
            // action rather than InvokePattern. Both are semantic operations;
            // neither requires cursor warping or simulated foreground input.
            let pattern: IUIAutomationLegacyIAccessiblePattern = unsafe { element.GetCurrentPattern(UIA_LegacyIAccessiblePatternId) }.and_then(|p| p.cast())
                .map_err(|e| format!("Control has no independent accessibility activation: {e}"))?;
            unsafe { pattern.DoDefaultAction() }.map_err(|e| e.to_string())?;
        }
    }
    let supports_invoke = unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }.and_then(|p| p.cast::<IUIAutomationInvokePattern>()).is_ok();
    let supports_select = unsafe { element.GetCurrentPattern(UIA_SelectionItemPatternId) }.and_then(|p| p.cast::<IUIAutomationSelectionItemPattern>()).is_ok();
    let legacy = unsafe { element.GetCurrentPattern(UIA_LegacyIAccessiblePatternId) }.and_then(|p| p.cast::<IUIAutomationLegacyIAccessiblePattern>());
    let default_action = legacy.as_ref().ok().and_then(|p| unsafe { p.CurrentDefaultAction() }.ok()).map(|name| name.to_string());
    let focused = unsafe { element.CurrentHasKeyboardFocus() }.map_err(|e| e.to_string())?.as_bool();
    Ok(json!({"label":label,"class":class,"pid":pid,"windowId":(root.0 as u64).to_string(),"windowPid":root_pid,"supportsInvoke":supports_invoke,"supportsSelect":supports_select,"defaultAction":default_action,"focused":focused,"rect":{"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top},"invoked":invoke,"confirmed":confirmed}))
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

    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().map_err(|e| e.to_string())?;
    let _apartment = ComApartment;
    let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| e.to_string())?;
    let root = unsafe { automation.GetRootElement() }.map_err(|e| e.to_string())?;
    let walker: IUIAutomationTreeWalker = unsafe { automation.ControlViewWalker() }
        .map_err(|e| e.to_string())?;

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

    let control = unsafe { element.CurrentIsControlElement() }.map(|value| value.as_bool()).unwrap_or(false);
    let offscreen = unsafe { element.CurrentIsOffscreen() }.map(|value| value.as_bool()).unwrap_or(true);
    let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
    let rect_is_visible = rect.as_ref().is_some_and(|value| value.right > value.left && value.bottom > value.top);
    let label = unsafe { element.CurrentName() }.ok().map(|value| value.to_string()).unwrap_or_default();
    // CurrentLocalizedControlType returns the OS display language's name
    // (e.g. French "bouton" instead of "button"), but role-based reasoning
    // elsewhere in the stack (role === "textbox", etc.) assumes English.
    // CurrentControlType is a locale-independent numeric UIA constant; map
    // the common ones to the same canonical English names so role matching
    // keeps working on a non-English Windows install. Fall back to the
    // localized string for the long tail of control types.
    let role = unsafe { element.CurrentControlType() }.ok()
        .and_then(canonical_control_type_name)
        .map(|value| value.to_string())
        .or_else(|| unsafe { element.CurrentLocalizedControlType() }.ok().map(|value| value.to_string()))
        .unwrap_or_default();
    let class_name = unsafe { element.CurrentClassName() }.ok().map(|value| value.to_string()).unwrap_or_default();
    let enabled = unsafe { element.CurrentIsEnabled() }.map(|value| value.as_bool()).unwrap_or(false);
    let focused = unsafe { element.CurrentHasKeyboardFocus() }.map(|value| value.as_bool()).unwrap_or(false);

    if control && !offscreen && rect_is_visible && (!label.trim().is_empty() || !role.trim().is_empty()) {
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

    let Ok(mut child) = (unsafe { walker.GetFirstChildElement(element) }) else { return };
    loop {
        if elements.len() >= max_elements {
            *truncated = true;
            return;
        }
        walk_desktop_elements(walker, &child, depth + 1, max_depth, max_elements, elements, next_ref, truncated);
        if *truncated && elements.len() >= max_elements {
            return;
        }
        let Ok(next) = (unsafe { walker.GetNextSiblingElement(&child) }) else { return };
        child = next;
    }
}

fn truncate_text(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn canonical_control_type_name(control_type: windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID) -> Option<&'static str> {
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
