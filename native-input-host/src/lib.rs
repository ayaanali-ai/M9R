use std::io::{self, Read, Write};

/// Broker requests contain only compact operation arguments; keep their read
/// allocation aligned with the broker's 16 KiB request limit.
pub const MAX_REQUEST_FRAME_BYTES: usize = 16 * 1024;
/// Native observations can contain a full PNG or a large UIA tree. This must
/// match the broker's response parser limit in windows-desktop-stage.ts.
pub const MAX_RESPONSE_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Native dispatch can fail before any target input is sent, or after SendInput
/// accepted part of a multi-event sequence. Keep those outcomes distinct so
/// callers never retry a partially delivered click, key chord, drag, or text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputDispatchState {
    NotDispatched,
    Uncertain,
    Dispatched,
}

impl InputDispatchState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotDispatched => "not-dispatched",
            Self::Uncertain => "uncertain",
            Self::Dispatched => "dispatched",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputDispatchError {
    pub message: String,
    pub state: InputDispatchState,
}

impl InputDispatchError {
    pub fn not_dispatched(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            state: InputDispatchState::NotDispatched,
        }
    }

    pub fn uncertain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            state: InputDispatchState::Uncertain,
        }
    }
}

impl From<&str> for InputDispatchError {
    fn from(message: &str) -> Self {
        Self::not_dispatched(message)
    }
}

impl From<String> for InputDispatchError {
    fn from(message: String) -> Self {
        Self::not_dispatched(message)
    }
}

#[cfg(test)]
mod stage_regressions {
    #[test]
    fn lifecycle_and_popup_ops_validate_identity_before_native_work() {
        for op in ["windowStatus", "setWindowState", "listOwnedPopups"] {
            let result = super::handle_desktop_stage_request(
                &serde_json::json!({"op":op,"pid":0,"windowId":"0","state":"maximized"}),
            );
            assert_eq!(result["ok"], false);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[cfg(windows)]
mod win32;

#[cfg(windows)]
mod native_screenshot;
#[cfg(windows)]
mod shell_accessibility;
mod system_controls;
mod windows_stage;

pub use windows_stage::handle_desktop_stage_request;

/// Reads one length-prefixed request from the broker-owned persistent helper.
/// Clean EOF between frames returns `None`; partial headers/bodies fail closed.
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
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_REQUEST_FRAME_BYTES {
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
    if body.is_empty() || body.len() > MAX_RESPONSE_FRAME_BYTES || body.len() > u32::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "native response size is invalid",
        ));
    }
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn native_message_frames_are_little_endian_bounded_and_detect_truncation() {
        let payload = br#"{"requestId":"broker-request"}"#;
        let mut bytes = (payload.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(payload);
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap(), payload);
        assert_eq!(read_frame(&mut cursor).unwrap(), None);

        let mut truncated = Cursor::new([5u32.to_le_bytes().as_slice(), b"{}"].concat());
        assert_eq!(
            read_frame(&mut truncated).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut oversized = Cursor::new(((MAX_REQUEST_FRAME_BYTES + 1) as u32).to_le_bytes());
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
            u32::from_le_bytes(output[..4].try_into().unwrap()) as usize,
            output.len() - 4
        );
        assert_eq!(&output[4..], br#"{"ok":true}"#);
    }

    #[test]
    fn large_native_observation_responses_fit_the_broker_response_frame_limit() {
        let payload = vec![b'x'; 128 * 1024];
        let mut framed = Vec::new();
        write_frame(&mut framed, &payload).unwrap();
        assert_eq!(
            u32::from_le_bytes(framed[..4].try_into().unwrap()) as usize,
            payload.len()
        );
        assert_eq!(&framed[4..], payload.as_slice());

        let oversized = vec![b'x'; MAX_RESPONSE_FRAME_BYTES + 1];
        assert_eq!(
            write_frame(&mut Vec::new(), &oversized).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
