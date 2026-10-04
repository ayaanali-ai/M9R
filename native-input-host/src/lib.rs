use serde_json::{json, Value};
use std::io::{self, Read, Write};

pub const MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ClickRequest {
    pub request_id: String,
    pub x: f64,
    pub y: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub button: MouseButton,
    pub click_count: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[cfg(windows)]
mod win32;

mod virtual_desktop;

#[cfg(windows)]
pub use win32::click_visible_chrome_tab;

pub use virtual_desktop::handle_desktop_stage_request;

#[cfg(not(windows))]
pub fn click_visible_chrome_tab<F: FnMut(f64, f64, bool) -> bool>(
    _request: &ClickRequest,
    _progress: &mut F,
) -> Result<(), &'static str> {
    Err("native input is available only on Windows")
}

fn bounded_number(value: &Value, field: &str, max: f64) -> Result<f64, &'static str> {
    let number = value
        .get(field)
        .and_then(Value::as_f64)
        .ok_or("invalid click request")?;
    if !number.is_finite() || number < 0.0 || number > max {
        return Err("invalid click request");
    }
    Ok(number)
}

pub fn parse_click_request(value: &Value) -> Result<ClickRequest, &'static str> {
    if value.get("type").and_then(Value::as_str) != Some("click") {
        return Err("unsupported native input request");
    }
    let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid click request");
    }

    let viewport_width = bounded_number(value, "viewportWidth", 16_384.0)?;
    let viewport_height = bounded_number(value, "viewportHeight", 16_384.0)?;
    if viewport_width < 1.0 || viewport_height < 1.0 {
        return Err("invalid click request");
    }
    let x = bounded_number(value, "x", viewport_width)?;
    let y = bounded_number(value, "y", viewport_height)?;
    if x >= viewport_width || y >= viewport_height {
        return Err("click point is outside the visible page");
    }

    let button = match value.get("button").and_then(Value::as_str) {
        Some("left") => MouseButton::Left,
        Some("right") => MouseButton::Right,
        Some("middle") => MouseButton::Middle,
        _ => return Err("unsupported mouse button"),
    };
    let click_count = value.get("clickCount").and_then(Value::as_u64).unwrap_or(0);
    if !(1..=2).contains(&click_count) || (button != MouseButton::Left && click_count != 1) {
        return Err("unsupported click count");
    }

    Ok(ClickRequest {
        request_id: request_id.to_owned(),
        x,
        y,
        viewport_width,
        viewport_height,
        button,
        click_count: click_count as u8,
    })
}

/// Reads one Chrome Native Messaging frame. Clean EOF between frames returns `None`; partial headers/bodies fail closed.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    let mut read = 0;
    while read < header.len() {
        match reader.read(&mut header[read..]) {
            Ok(0) if read == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "partial native message header",
                ))
            }
            Ok(count) => read += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native message size is invalid",
        ));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    if body.is_empty() || body.len() > MAX_FRAME_BYTES || body.len() > u32::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "native response size is invalid",
        ));
    }
    writer.write_all(&(body.len() as u32).to_ne_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}

/// Writes the final pointer position and waits for the extension to confirm that its visible cursor has settled there.
pub fn write_arrival_and_wait_for_ack<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    request_id: &str,
    sequence: u64,
    x: f64,
    y: f64,
) -> bool {
    let progress = json!({
        "type": "progress",
        "requestId": request_id,
        "sequence": sequence,
        "phase": "arrived",
        "x": x,
        "y": y,
    });
    let Ok(bytes) = serde_json::to_vec(&progress) else {
        return false;
    };
    if write_frame(writer, &bytes).is_err() {
        return false;
    }
    let Some(frame) = read_frame(reader).ok().flatten() else {
        return false;
    };
    let Ok(ack) = serde_json::from_slice::<Value>(&frame) else {
        return false;
    };
    ack.get("type").and_then(Value::as_str) == Some("progressAck")
        && ack.get("requestId").and_then(Value::as_str) == Some(request_id)
        && ack.get("sequence").and_then(Value::as_u64) == Some(sequence)
}

pub fn error_response(request_id: Option<&str>, error: &'static str) -> Value {
    json!({ "type": "result", "requestId": request_id.unwrap_or(""), "ok": false, "error": error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn accepts_bounded_left_right_and_middle_click_requests() {
        for button in ["left", "right", "middle"] {
            let value = json!({ "type":"click", "requestId":"req_1", "x":100.5, "y":40,
                "viewportWidth":1280, "viewportHeight":720, "button":button, "clickCount":1 });
            let parsed = parse_click_request(&value).unwrap();
            assert_eq!(parsed.request_id, "req_1");
            assert_eq!(
                parsed.button,
                match button {
                    "left" => MouseButton::Left,
                    "right" => MouseButton::Right,
                    _ => MouseButton::Middle,
                }
            );
        }
        let double =
            parse_click_request(&json!({ "type":"click", "requestId":"double", "x":1, "y":1,
            "viewportWidth":2, "viewportHeight":2, "button":"left", "clickCount":2 }))
            .unwrap();
        assert_eq!(double.click_count, 2);
    }

    #[test]
    fn refuses_non_clicks_malformed_identity_unbounded_or_outside_coordinates() {
        let base = json!({ "type":"click", "requestId":"req_1", "x":1, "y":1,
            "viewportWidth":2, "viewportHeight":2, "button":"left", "clickCount":1 });
        let mut value = base.clone();
        value["type"] = json!("run-command");
        assert!(parse_click_request(&value).is_err());
        let mut value = base.clone();
        value["requestId"] = json!("../bad");
        assert!(parse_click_request(&value).is_err());
        let mut value = base.clone();
        value["x"] = json!(2);
        assert!(parse_click_request(&value).is_err());
        let mut value = base.clone();
        value["viewportWidth"] = json!(16_385);
        assert!(parse_click_request(&value).is_err());
        let mut value = base.clone();
        value["clickCount"] = json!(2);
        value["button"] = json!("right");
        assert!(parse_click_request(&value).is_err());
    }

    #[test]
    fn native_message_frames_are_little_endian_bounded_and_detect_truncation() {
        let payload = br#"{"type":"click"}"#;
        let mut bytes = (payload.len() as u32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(payload);
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), payload);
        assert_eq!(read_frame(&mut cursor).unwrap(), None);

        let mut truncated = Cursor::new([5u32.to_ne_bytes().as_slice(), b"{}"].concat());
        assert_eq!(
            read_frame(&mut truncated).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut oversized = Cursor::new(((MAX_FRAME_BYTES + 1) as u32).to_ne_bytes());
        assert_eq!(
            read_frame(&mut oversized).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn response_writer_emits_length_prefix_and_json_bytes() {
        let mut output = Vec::new();
        write_frame(&mut output, br#"{"ok":true}"#).unwrap();
        assert_eq!(
            u32::from_ne_bytes(output[..4].try_into().unwrap()) as usize,
            output.len() - 4
        );
        assert_eq!(&output[4..], br#"{"ok":true}"#);
    }

    fn framed_json(value: &Value) -> Vec<u8> {
        let body = serde_json::to_vec(value).unwrap();
        let mut frame = (body.len() as u32).to_ne_bytes().to_vec();
        frame.extend_from_slice(&body);
        frame
    }

    #[test]
    fn arrival_progress_waits_for_the_matching_extension_ack() {
        let ack = json!({ "type":"progressAck", "requestId":"req_1", "sequence":7 });
        let mut input = Cursor::new(framed_json(&ack));
        let mut output = Vec::new();

        assert!(write_arrival_and_wait_for_ack(
            &mut input,
            &mut output,
            "req_1",
            7,
            12.5,
            19.0
        ));
        let length = u32::from_ne_bytes(output[..4].try_into().unwrap()) as usize;
        let progress: Value = serde_json::from_slice(&output[4..4 + length]).unwrap();
        assert_eq!(progress["phase"], "arrived");
        assert_eq!(progress["requestId"], "req_1");
        assert_eq!(progress["sequence"], 7);
        assert_eq!(progress["x"], 12.5);
        assert_eq!(progress["y"], 19.0);
    }

    #[test]
    fn arrival_progress_fails_closed_on_mismatched_or_missing_ack() {
        for ack in [
            json!({ "type":"progressAck", "requestId":"other", "sequence":7 }),
            json!({ "type":"progressAck", "requestId":"req_1", "sequence":8 }),
            json!({ "type":"click", "requestId":"req_1", "sequence":7 }),
        ] {
            let mut input = Cursor::new(framed_json(&ack));
            let mut output = Vec::new();
            assert!(!write_arrival_and_wait_for_ack(
                &mut input,
                &mut output,
                "req_1",
                7,
                12.5,
                19.0
            ));
        }

        let mut input = Cursor::new(Vec::<u8>::new());
        let mut output = Vec::new();
        assert!(!write_arrival_and_wait_for_ack(
            &mut input,
            &mut output,
            "req_1",
            7,
            12.5,
            19.0
        ));
    }
}
