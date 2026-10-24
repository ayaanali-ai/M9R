// m9r-hook: the program an agent (Claude Code, Codex...) runs for every hook event, `m9r-hook <Event> <provider>` with the
// event JSON on stdin. It is deliberately tiny: it forwards the event to the resident M9R engine over a local pipe and
// prints what the engine answers. Why: the engine is a 92 MB program whose first start after a pause took 5.5 to 6 s, and
// Claude cancels a hook after 5 s. This program starts in milliseconds and gives up after 3.5 s, so it can never block a
// prompt. If the engine is not running it starts it in the background and answers with nothing for this one call.
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    mem::size_of,
    path::PathBuf,
    process::{exit, Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; 260],
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(
        attributes: *mut std::ffi::c_void,
        initial_owner: i32,
        name: *const u16,
    ) -> isize;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn ReleaseMutex(handle: isize) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> isize;
    fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
    fn CloseHandle(handle: isize) -> i32;
    fn GetCurrentProcessId() -> u32;
}

#[cfg(windows)]
fn provider_process_id() -> Option<u32> {
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const INVALID_HANDLE_VALUE: isize = -1;
    let current = unsafe { GetCurrentProcessId() };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE { return None; }
    let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
    entry.dw_size = size_of::<ProcessEntry32W>() as u32;
    let mut found = None;
    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            if entry.th32_process_id == current {
                found = (entry.th32_parent_process_id > 0).then_some(entry.th32_parent_process_id);
                break;
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 { break; }
        }
    }
    unsafe { CloseHandle(snapshot); }
    found
}

#[cfg(windows)]
fn process_id_is_running(pid: u32) -> Option<bool> {
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const INVALID_HANDLE_VALUE: isize = -1;
    if pid == 0 {
        return Some(false);
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
    entry.dw_size = size_of::<ProcessEntry32W>() as u32;
    let mut result = None;
    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        result = Some(false);
        loop {
            if entry.th32_process_id == pid {
                result = Some(true);
                break;
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe {
        CloseHandle(snapshot);
    }
    result
}

#[cfg(not(windows))]
fn provider_process_id() -> Option<u32> { None }

#[cfg(unix)]
fn process_id_is_running(pid: u32) -> Option<bool> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    if unsafe { kill(pid as i32, 0) } == 0 {
        return Some(true);
    }
    match std::io::Error::last_os_error().kind() {
        std::io::ErrorKind::NotFound => Some(false),
        std::io::ErrorKind::PermissionDenied => Some(true),
        _ => None,
    }
}

#[cfg(not(any(windows, unix)))]
fn process_id_is_running(_pid: u32) -> Option<bool> {
    None
}

const GIVE_UP: Duration = Duration::from_millis(3500);
const RESTART_GUARD_SECS: u64 = 25;

#[cfg(windows)]
struct EngineStartLock(isize);

#[cfg(windows)]
impl Drop for EngineStartLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn acquire_engine_start_lock() -> Option<EngineStartLock> {
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_ABANDONED: u32 = 0x80;
    let name = format!("Local\\M9R-Engine-Start-{}", root_tag());
    let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
    if handle == 0 {
        return None;
    }
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_OBJECT_0 | WAIT_ABANDONED => Some(EngineStartLock(handle)),
        _ => {
            unsafe {
                CloseHandle(handle);
            }
            None
        }
    }
}

#[cfg(unix)]
struct EngineStartLock(std::fs::File);

#[cfg(unix)]
impl Drop for EngineStartLock {
    fn drop(&mut self) {
        use std::os::unix::io::AsRawFd;
        unsafe {
            flock(self.0.as_raw_fd(), 8);
        } // LOCK_UN
    }
}

#[cfg(unix)]
fn acquire_engine_start_lock() -> Option<EngineStartLock> {
    use std::os::unix::io::AsRawFd;
    let path = m9r_home().join("daemon.start.lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .ok()?;
    if unsafe { flock(file.as_raw_fd(), 6) } == 0 {
        // LOCK_EX | LOCK_NB
        Some(EngineStartLock(file))
    } else {
        None
    }
}

#[cfg(not(any(windows, unix)))]
struct EngineStartLock;

#[cfg(not(any(windows, unix)))]
fn acquire_engine_start_lock() -> Option<EngineStartLock> {
    Some(EngineStartLock)
}

#[cfg(unix)]
#[link(name = "c")]
extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
}

fn restart_guard_is_fresh(
    contents: &str,
    now: u64,
    process_is_running: impl FnOnce(u32) -> Option<bool>,
) -> bool {
    let mut fields = contents.split_whitespace();
    let Some(then) = fields.next().and_then(|value| value.parse::<u64>().ok()) else {
        return false;
    };
    if now.saturating_sub(then) >= RESTART_GUARD_SECS {
        return false;
    }
    match fields.next() {
        // Timestamp-only markers were written by earlier M9R versions. Honor
        // their short cooldown so an update does not cause duplicate starts.
        None => true,
        Some(pid) => match pid.parse::<u32>() {
            Ok(0) => true, // The child has not returned its PID yet.
            Ok(pid) => process_is_running(pid).unwrap_or(true), // Unknown means preserve the cooldown.
            Err(_) => false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::restart_guard_is_fresh;

    #[cfg(windows)]
    #[test]
    fn provider_process_id_is_available_to_a_normal_hook_process() {
        assert!(super::provider_process_id().is_some(), "a hook must be able to identify its provider parent");
    }

    #[test]
    fn restart_guard_respects_age_and_spawned_process_liveness() {
        assert!(restart_guard_is_fresh("100", 124, |_| None));
        assert!(!restart_guard_is_fresh("100", 125, |_| None));
        assert!(!restart_guard_is_fresh("not-a-timestamp", 124, |_| None));
        assert!(restart_guard_is_fresh(
            "125",
            124,
            |_| None,
        ), "clock rollback must fail closed");
        assert!(!restart_guard_is_fresh(
            "100 42",
            124,
            |_| Some(false),
        ), "a dead engine must not suppress restart");
        assert!(restart_guard_is_fresh("100 42", 124, |_| Some(true)));
        assert!(restart_guard_is_fresh(
            "100 42",
            124,
            |_| None,
        ), "unknown process state must fail closed");
    }
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn home() -> PathBuf {
    PathBuf::from(env::var("USERPROFILE").or_else(|_| env::var("HOME")).unwrap_or_default())
}

fn m9r_home() -> PathBuf {
    env::var("M9R_HOME").map(PathBuf::from).unwrap_or_else(|_| home().join(".m9r"))
}

/// FNV-1a over the lower-cased M9R folder, identical to rootTag() in hook-server.ts, so each M9R home has its own pipe.
#[cfg(windows)]
fn root_tag() -> String {
    let mut norm = m9r_home().to_string_lossy().replace('/', "\\").to_lowercase();
    while norm.ends_with('\\') {
        norm.pop();
    }
    let mut h: u32 = 0x811c9dc5;
    for b in norm.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

#[cfg(windows)]
fn pipe_path() -> String {
    let user: String = env::var("USERNAME")
        .unwrap_or_else(|_| "user".into())
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    format!("\\\\.\\pipe\\m9r-hook-{user}-{}", root_tag())
}

#[cfg(not(windows))]
fn pipe_path() -> String {
    m9r_home().join("hook.sock").to_string_lossy().into_owned()
}

/// Starts the engine in the background (at most once every 25 s), so the next hook call finds it running.
fn start_engine() {
    let home = m9r_home();
    if fs::create_dir_all(&home).is_err() { return; }
    // Hooks are separate short-lived processes. The OS lock serializes the
    // check/write/spawn sequence across them, preventing a burst of provider
    // events from launching several competing feed engines at once.
    let _start_lock = match acquire_engine_start_lock() {
        Some(lock) => lock,
        None => return,
    };
    let dir = match env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Some(d) => d,
        None => return,
    };
    let name = if cfg!(windows) { "m9r-engine.exe" } else { "m9r-engine" };
    let engine = dir.join(name);
    if !engine.is_file() {
        return;
    }
    let guard = home.join("daemon.starting");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if fs::read_to_string(&guard)
        .map(|text| restart_guard_is_fresh(&text, now, process_id_is_running))
        .unwrap_or(false) { return; }
    if fs::write(&guard, now.to_string()).is_err() { return; }
    let mut cmd = Command::new(engine);
    cmd.args(["feed", "--watch", "--serve-hooks"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The agent that ran us waits for its pipes to close. A child that inherited our own stdin/stdout/stderr would keep
        // them open for as long as it lives (hours), and the agent would think the hook never finished. Make them
        // non-inheritable before starting the engine.
        extern "system" {
            fn GetStdHandle(which: u32) -> isize;
            fn SetHandleInformation(handle: isize, mask: u32, flags: u32) -> i32;
        }
        unsafe {
            for which in [-10i32 as u32, -11i32 as u32, -12i32 as u32] {
                let h = GetStdHandle(which);
                if h != 0 && h != -1 {
                    SetHandleInformation(h, 1, 0); // HANDLE_FLAG_INHERIT off
                }
            }
        }
        cmd.creation_flags(0x0000_0008 | 0x0800_0000 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    }
    match cmd.spawn() {
        Ok(child) => {
            // If the detached engine exits during its startup window, the next
            // hook may retry immediately instead of honoring a false 25-second
            // cooldown. Keep the timestamp-only value if this diagnostic write
            // fails; it remains a short, conservative compatibility guard.
            let _ = fs::write(&guard, format!("{now} {}", child.id()));
        }
        Err(_) => {
            // Do not leave a false cooldown behind after a failed spawn. The
            // OS lock ensures no competing hook can replace this marker before
            // it is removed.
            let _ = fs::remove_file(&guard);
        }
    }
}

/// Provider MCP configurations use this stable native shim instead of the
/// replaceable engine executable. It preserves the provider's stdio session
/// while launching the current engine from the same installed directory, and
/// makes the real provider parent PID explicit so binding never has to infer
/// identity from an intermediate M9R process.
fn run_mcp() -> i32 {
    let dir = match env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Some(d) => d,
        None => {
            eprintln!("M9R MCP launcher could not resolve its installed directory.");
            return 1;
        }
    };
    let engine = dir.join(if cfg!(windows) { "m9r-engine.exe" } else { "m9r-engine" });
    if !engine.is_file() {
        eprintln!("M9R MCP launcher could not find the active engine at {}.", engine.display());
        return 1;
    }
    let mut command = Command::new(engine);
    command.arg("mcp").stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    if env::var_os("M9R_CONNECTION_PROCESS_ID").is_none() {
        if let Some(pid) = provider_process_id() {
            command.env("M9R_CONNECTION_PROCESS_ID", pid.to_string());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    }
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("M9R MCP launcher could not start the active engine: {error}");
            1
        }
    }
}

#[cfg(windows)]
fn ask(request: &str) -> Option<Vec<u8>> {
    let mut pipe = OpenOptions::new().read(true).write(true).open(pipe_path()).ok()?;
    pipe.write_all(request.as_bytes()).ok()?;
    let mut answer = Vec::new();
    pipe.read_to_end(&mut answer).ok()?;
    Some(answer)
}

#[cfg(unix)]
fn ask(request: &str) -> Option<Vec<u8>> {
    let mut stream = std::os::unix::net::UnixStream::connect(pipe_path()).ok()?;
    stream.write_all(request.as_bytes()).ok()?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).ok()?;
    Some(answer)
}

fn main() {
    // This branch must run before the hook timeout thread: MCP is a long-lived
    // stdio protocol, unlike per-event hooks.
    if env::args().nth(1).as_deref() == Some("mcp") {
        exit(run_mcp());
    }
    // `m9r-hook --warm`: setup runs this once so the first real call is not the first time the program is ever started.
    if env::args().nth(1).as_deref() == Some("--warm") {
        exit(0);
    }
    // A hook must never hold up an agent: after 3.5 s, leave quietly.
    thread::spawn(|| {
        thread::sleep(GIVE_UP);
        exit(0);
    });

    let args: Vec<String> = env::args().skip(1).collect();
    let event = args.first().cloned().unwrap_or_default();
    let provider = args.get(1).cloned().unwrap_or_else(|| "claude-code".into());

    let mut stdin_text = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin_text);
    let trimmed = stdin_text.trim();
    let input = if trimmed.starts_with('{') && trimmed.ends_with('}') { trimmed } else { "null" };

    let mut env_part = Vec::new();
    for key in ["M9R_HOME", "CODEX_HOME"] {
        if let Ok(v) = env::var(key) {
            env_part.push(format!("{}:{}", json_str(key), json_str(&v)));
        }
    }
    let request = format!(
        "{{\"event\":{},\"provider\":{},\"input\":{},\"providerProcessId\":{},\"env\":{{{}}}}}\n",
        json_str(&event),
        json_str(&provider),
        input,
        provider_process_id().map(|pid| pid.to_string()).unwrap_or_else(|| "null".into()),
        env_part.join(",")
    );

    match ask(&request) {
        Some(answer) => {
            let _ = std::io::stdout().write_all(&answer);
        }
        None => start_engine(),
    }
    exit(0);
}
