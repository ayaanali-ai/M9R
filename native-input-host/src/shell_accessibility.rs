//! Exact Windows shell control inspection and invocation. Never synthesizes mouse input.
use serde_json::{json, Value};
use windows::core::Interface;
use windows::Win32::{Foundation::POINT, System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER}, UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomationInvokePattern, IUIAutomationTogglePattern, IUIAutomationSelectionItemPattern, IUIAutomationLegacyIAccessiblePattern, UIA_InvokePatternId, UIA_TogglePatternId, UIA_SelectionItemPatternId, UIA_LegacyIAccessiblePatternId}};

pub fn control_at_point(value: &Value, invoke: bool) -> Result<Value, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    struct Apartment;
    impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize() }; } }
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().map_err(|e| e.to_string())?;
    let _apartment = Apartment;
    let coordinate = |key| value.get(key).and_then(Value::as_i64)
        .filter(|n| (-32768..=32767).contains(n)).map(|n| n as i32).ok_or_else(|| format!("invalid {key} coordinate"));
    let point = POINT { x: coordinate("x")?, y: coordinate("y")? };
    use windows::Win32::UI::WindowsAndMessaging::{WindowFromPoint, GetAncestor, GA_ROOT, GetWindowThreadProcessId};
    let root = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
    if root.0.is_null() { return Err("The exact input window disappeared".into()); }
    let mut root_pid = 0;
    unsafe { GetWindowThreadProcessId(root, Some(&mut root_pid)) };
    let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    let element = unsafe { automation.ElementFromPoint(point) }.map_err(|e| e.to_string())?;
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
