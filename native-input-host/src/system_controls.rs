//! Narrow Windows system controls exposed to the owner broker.
//!
//! Requests are strict allowlisted operations. No caller-supplied program,
//! script, device identifier, or command line reaches this module.

use serde_json::{json, Value};

fn parse_level(value: &Value) -> Result<u8, &'static str> {
    value.get("value").and_then(Value::as_u64)
        .filter(|level| *level <= 100)
        .map(|level| level as u8)
        .ok_or("system-control value must be an integer from 0 to 100")
}

fn parse_step(value: &Value) -> Result<u8, &'static str> {
    match value.get("step") {
        None => Ok(10),
        Some(step) => step.as_u64().filter(|step| (1..=50).contains(step))
            .map(|step| step as u8).ok_or("system-control step must be from 1 to 50"),
    }
}

fn requested_level(action: &str, current: u8, request: &Value) -> Result<u8, &'static str> {
    match action {
        "set" => parse_level(request),
        "increase" => Ok(current.saturating_add(parse_step(request)?).min(100)),
        "decrease" => Ok(current.saturating_sub(parse_step(request)?)),
        _ => Err("invalid system-control level action"),
    }
}

fn unsupported_extra_fields(request: &Value, allowed: &[&str]) -> bool {
    request.as_object().is_some_and(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
}

#[cfg(windows)]
mod windows_impl {
    use super::{json, requested_level, unsupported_extra_fields, Value};
    use std::{os::windows::process::CommandExt, path::PathBuf, process::{Command, Stdio}, thread, time::{Duration, Instant}};
    use windows::{
        core::GUID,
        Win32::{
            Media::Audio::{eCapture, eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator},
            Media::Audio::Endpoints::IAudioEndpointVolume,
            System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED},
        },
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) { unsafe { CoUninitialize(); } }
    }

    fn with_default_endpoint<T>(capture: bool, operation: impl FnOnce(&IAudioEndpointVolume) -> Result<T, &'static str>) -> Result<T, &'static str> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|_| "Windows audio COM could not initialize")?; }
        let _apartment = ComApartment;
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|_| "Windows audio device service is unavailable")?
        };
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(if capture { eCapture } else { eRender }, eMultimedia) }
            .map_err(|_| if capture { "Windows has no default microphone" } else { "Windows has no default output device" })?;
        let volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|_| "Windows could not access the default audio endpoint")?;
        operation(&volume)
    }

    fn endpoint_level(volume: &IAudioEndpointVolume) -> Result<u8, &'static str> {
        let scalar = unsafe { volume.GetMasterVolumeLevelScalar() }
            .map_err(|_| "Windows could not read the audio endpoint level")?;
        if !scalar.is_finite() { return Err("Windows returned an invalid audio endpoint level"); }
        Ok((scalar.clamp(0.0, 1.0) * 100.0).round() as u8)
    }

    fn endpoint_muted(volume: &IAudioEndpointVolume) -> Result<bool, &'static str> {
        unsafe { volume.GetMute() }
            .map(|muted| muted.as_bool())
            .map_err(|_| "Windows could not read the audio endpoint mute state")
    }

    fn set_endpoint_level(volume: &IAudioEndpointVolume, level: u8) -> Result<u8, &'static str> {
        let requested = level as f32 / 100.0;
        unsafe { volume.SetMasterVolumeLevelScalar(requested, &GUID::zeroed()) }
            .map_err(|_| "Windows could not set the audio endpoint level")?;
        let actual = endpoint_level(volume)?;
        if actual.abs_diff(level) > 1 { return Err("Windows did not confirm the requested audio level"); }
        Ok(actual)
    }

    fn set_endpoint_mute(volume: &IAudioEndpointVolume, muted: bool) -> Result<bool, &'static str> {
        unsafe { volume.SetMute(muted, &GUID::zeroed()) }
            .map_err(|_| "Windows could not change the audio endpoint mute state")?;
        let actual = endpoint_muted(volume)?;
        if actual != muted { return Err("Windows did not confirm the requested mute state"); }
        Ok(actual)
    }

    fn powershell(script: &str) -> Result<(i32, String), &'static str> {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let executable = PathBuf::from(root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        let mut child = Command::new(executable)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|_| "Windows brightness management could not start")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("Windows brightness control timed out"); }
                Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("Windows brightness control could not be queried"); }
            }
        }
        let output = child.wait_with_output().map_err(|_| "Windows brightness control returned no result")?;
        if output.stdout.len() > 128 { return Err("Windows returned an invalid brightness result"); }
        let text = String::from_utf8(output.stdout).map_err(|_| "Windows returned an invalid brightness result")?;
        let code = output.status.code().unwrap_or(-1);
        Ok((code, text.trim().to_string()))
    }

    fn brightness_read() -> Result<u8, &'static str> {
        const SCRIPT: &str = "$ErrorActionPreference='Stop'; $m=@(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness); if($m.Count -eq 0){exit 31}; $a=($m | Measure-Object -Property CurrentBrightness -Average).Average; [Math]::Round($a)";
        let (code, output) = powershell(SCRIPT)?;
        if code == 31 { return Err("No Windows-managed display brightness control is available"); }
        if code != 0 { return Err("Windows could not read display brightness"); }
        output.parse::<u8>().ok().filter(|level| *level <= 100).ok_or("Windows returned an invalid brightness level")
    }

    fn brightness_set(level: u8) -> Result<u8, &'static str> {
        // Only the previously range-checked integer is interpolated into this fixed WMI call.
        let script = format!("$ErrorActionPreference='Stop'; $m=@(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods); if($m.Count -eq 0){{exit 31}}; foreach($d in $m){{$r=Invoke-CimMethod -InputObject $d -MethodName WmiSetBrightness -Arguments @{{Timeout=0;Brightness={level}}}; if($r.ReturnValue -ne 0){{exit 32}}}}; Write-Output {level}");
        let (code, _) = powershell(&script)?;
        if code == 31 { return Err("No Windows-managed display brightness control is available"); }
        if code != 0 { return Err("Windows could not set display brightness"); }
        let actual = brightness_read()?;
        if actual.abs_diff(level) > 2 { return Err("Windows did not confirm the requested display brightness"); }
        Ok(actual)
    }

    fn brightness(action: &str, request: &Value) -> Result<Value, &'static str> {
        if unsupported_extra_fields(request, &["op", "control", "action", "value", "step"]) { return Err("invalid display-brightness fields"); }
        match action {
            "get" => Ok(json!({"control":"display_brightness","level":brightness_read()?})),
            "set" | "increase" | "decrease" => {
                let current = brightness_read()?;
                let level = requested_level(action, current, request)?;
                let actual = brightness_set(level)?;
                Ok(json!({"control":"display_brightness","level":actual,"confirmed":true}))
            }
            _ => Err("display brightness supports get, set, increase, and decrease"),
        }
    }

    fn audio(control: &str, action: &str, request: &Value) -> Result<Value, &'static str> {
        if unsupported_extra_fields(request, &["op", "control", "action", "value", "step"]) { return Err("invalid audio-control fields"); }
        let capture = control == "microphone";
        with_default_endpoint(capture, |endpoint| match action {
            "get" => Ok(json!({"control":control,"level":endpoint_level(endpoint)?,"muted":endpoint_muted(endpoint)?})),
            "set" | "increase" | "decrease" => {
                let current = endpoint_level(endpoint)?;
                let level = requested_level(action, current, request)?;
                Ok(json!({"control":control,"level":set_endpoint_level(endpoint, level)?,"muted":endpoint_muted(endpoint)?,"confirmed":true}))
            }
            "mute" | "unmute" => {
                let muted = set_endpoint_mute(endpoint, action == "mute")?;
                Ok(json!({"control":control,"level":endpoint_level(endpoint)?,"muted":muted,"confirmed":true}))
            }
            _ => Err("audio controls support get, set, increase, decrease, mute, and unmute"),
        })
    }

    fn media(action: &str, request: &Value) -> Result<Value, &'static str> {
        if unsupported_extra_fields(request, &["op", "control", "action"]) { return Err("invalid media-control fields"); }
        let key = match action { "play_pause" => 0xB3, "next" => 0xB0, "previous" => 0xB1, _ => return Err("media supports play_pause, next, and previous") };
        #[link(name = "user32")]
        unsafe extern "system" { fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize); }
        unsafe { keybd_event(key, 0, 0, 0); keybd_event(key, 0, 0x0002, 0); }
        Ok(json!({"control":"media","action":action,"dispatched":true,"effect":"Windows received the media key; the active player may ignore it"}))
    }

    pub(super) fn handle(request: &Value) -> Result<Value, &'static str> {
        let control = request.get("control").and_then(Value::as_str).ok_or("system-control category is required")?;
        let action = request.get("action").and_then(Value::as_str).ok_or("system-control action is required")?;
        match control {
            "display_brightness" => brightness(action, request),
            "output_audio" | "microphone" => audio(control, action, request),
            "media" => media(action, request),
            _ => Err("unsupported system-control category"),
        }
    }

}

#[cfg(windows)]
pub fn handle(request: &Value) -> Result<Value, &'static str> {
    if unsupported_extra_fields(request, &["op", "control", "action", "value", "step"]) { return Err("invalid system-control fields"); }
    windows_impl::handle(request)
}

#[cfg(not(windows))]
pub fn handle(_request: &Value) -> Result<Value, &'static str> {
    Err("Windows system controls are available only on Windows")
}
