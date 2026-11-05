use m9r_native_input_host::{read_frame, write_frame};
use serde_json::{json, Value};
use std::io::{stdin, stdout, Read};

const MAX_DESKTOP_STAGE_REQUEST_BYTES: u64 = 16 * 1024;

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
        if raw.len() as u64 > MAX_DESKTOP_STAGE_REQUEST_BYTES {
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
        let bytes = match serde_json::to_vec(&response) {
            Ok(bytes) => bytes,
            Err(error) => return Err(format!("could not encode desktop-stage response: {error}")),
        };
        write_frame(&mut output, &bytes)
            .map_err(|error| format!("could not write desktop-stage response: {error}"))?;
    }
}

fn main() {
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
            .take(MAX_DESKTOP_STAGE_REQUEST_BYTES + 1)
            .read_to_end(&mut request)
            .is_err()
            || request.len() as u64 > MAX_DESKTOP_STAGE_REQUEST_BYTES
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
