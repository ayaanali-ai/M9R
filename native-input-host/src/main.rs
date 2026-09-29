use m9r_native_input_host::{
    error_response, parse_click_request, read_frame, write_arrival_and_wait_for_ack, write_frame,
};
use serde_json::{json, Value};
use std::io::{stdin, stdout, Read, Write};

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
