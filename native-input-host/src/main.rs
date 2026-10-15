use m9r_native_input_host::{
    error_response, parse_click_request, read_frame, write_arrival_and_wait_for_ack, write_frame,
};
use serde_json::{json, Value};
use std::io::{stdin, stdout, Read, Write};

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

fn process_message<R: Read, W: Write>(raw: &[u8], input: &mut R, output: &mut W) -> Value {
    let parsed = match serde_json::from_slice::<Value>(raw) {
        Ok(value) => value,
        Err(_) => return error_response(None, "invalid native input message"),
    };
    let request_id = parsed.get("requestId").and_then(Value::as_str);
    let request = match parse_click_request(&parsed) {
        Ok(request) => request,
        Err(error) => return error_response(request_id, error),
    };
    let mut sequence = 0u64;
    let mut report_progress = |x: f64, y: f64, arrived: bool| {
        sequence = sequence.saturating_add(1);
        if arrived {
            return write_arrival_and_wait_for_ack(
                input,
                output,
                &request.request_id,
                sequence,
                x,
                y,
            );
        }
        let bytes = match serde_json::to_vec(&json!({
            "type":"progress", "requestId":request.request_id, "sequence":sequence,
            "phase":"moving", "x":x, "y":y
        })) {
            Ok(bytes) => bytes,
            Err(_) => return false,
        };
        write_frame(output, &bytes).is_ok()
    };
    let click_result =
        m9r_native_input_host::click_visible_chrome_tab(&request, &mut report_progress);
    drop(report_progress);
    match click_result {
        Ok(()) => {
            json!({ "type":"result", "requestId":request.request_id, "ok":true, "arrivalSequence":sequence })
        }
        Err(error) => error_response(Some(&request.request_id), error),
    }
}

fn main() {
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

    let mut input = stdin().lock();
    let mut output = stdout().lock();
    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => return,
            Err(_) => return,
        };
        let response = process_message(&frame, &mut input, &mut output);
        let bytes = match serde_json::to_vec(&response) {
            Ok(bytes) => bytes,
            Err(_) => return,
        };
        if write_frame(&mut output, &bytes).is_err() {
            return;
        }
    }
}
