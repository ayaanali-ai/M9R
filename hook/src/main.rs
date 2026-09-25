// m9r-hook: the program an agent (Claude Code, Codex...) runs for every hook event, `m9r-hook <Event> <provider>` with the
// event JSON on stdin. It is deliberately tiny: it forwards the event to the resident M9R engine over a local pipe and
// prints what the engine answers. Why: the engine is a 92 MB program whose first start after a pause took 5.5 to 6 s, and
// Claude cancels a hook after 5 s. This program starts in milliseconds and gives up after 3.5 s, so it can never block a
// prompt. If the engine is not running it starts it in the background and answers with nothing for this one call.
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{exit, Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const GIVE_UP: Duration = Duration::from_millis(3500);
const RESTART_GUARD_SECS: u64 = 25;

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
    let dir = match env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Some(d) => d,
        None => return,
    };
    let name = if cfg!(windows) { "m9r-engine.exe" } else { "m9r-engine" };
    let engine = dir.join(name);
    if !engine.is_file() {
        return;
    }
    let guard = m9r_home().join("daemon.starting");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(text) = fs::read_to_string(&guard) {
        if let Ok(then) = text.trim().parse::<u64>() {
            if now.saturating_sub(then) < RESTART_GUARD_SECS {
                return;
            }
        }
    }
    let _ = fs::create_dir_all(m9r_home());
    let _ = fs::write(&guard, now.to_string());
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
    let _ = cmd.spawn();
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
        "{{\"event\":{},\"provider\":{},\"input\":{},\"env\":{{{}}}}}\n",
        json_str(&event),
        json_str(&provider),
        input,
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
