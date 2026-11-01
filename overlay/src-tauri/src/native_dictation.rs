// Native Windows dictation. WebView2 cannot run the Web Speech API's cloud recognizer -- confirmed live
// 2026-10-10: `new webkitSpeechRecognition().start()` fires onstart then immediately onerror "network", every
// time, regardless of microphone permission. This used WinRT's Windows.Media.SpeechRecognition at first, but
// that API requires MSIX package identity -- confirmed live 2026-10-31: this app ships unpackaged (NSIS only,
// see tauri.conf.json's bundle.targets), so CompileConstraintsAsync() silently hung forever on the recognizer
// thread instead of erroring, and the mic was never actually touched (zero entries ever appeared in the
// Windows mic-consent registry for this exe across an entire investigation). Classic SAPI5 -- the COM
// ISpRecognizer/ISpRecoContext/ISpRecoGrammar interfaces, not the Automation-friendly ISpeech* ones -- has
// always supported unpackaged Win32 processes, so this now drives that instead. It owns a single background
// thread for the lifetime of the app; the recognizer, context, and dictation grammar are created once and
// reused across every Ctrl+Alt press, since recreating them on every hold would add latency.
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpRecoContext, ISpRecoGrammar, ISpRecoResult, ISpRecognizer,
    SpInprocRecognizer, SpMMAudioIn, SpObjectToken, SPEVENT,
    SPEI_RECOGNITION, SPET_LPARAM_IS_OBJECT, SPLO_STATIC, SPRS_ACTIVE, SPRS_INACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};

const SP_GETWHOLEPHRASE: u32 = u32::MAX;


enum Command {
    Start(Sender<Result<(), String>>),
    Stop(Sender<Result<(), String>>),
}

static COMMANDS: OnceLock<Sender<Command>> = OnceLock::new();

/// Starts the dedicated recognizer thread. Call once, at app setup.
pub fn init(app: AppHandle) {
    let (tx, rx) = channel::<Command>();
    if COMMANDS.set(tx).is_err() {
        eprintln!("M9R: native dictation thread already started");
        return;
    }
    thread::spawn(move || {
        if let Err(e) = run(app.clone(), rx) {
            eprintln!("M9R: native dictation thread ended ({e:?})");
            let _ = app.emit("dictation-unavailable", format!("{e}"));
        }
    });
}

pub fn start() -> Result<(), String> {
    let tx = COMMANDS.get().ok_or("Windows dictation is not initialized")?;
    let (reply, receive) = channel();
    tx.send(Command::Start(reply)).map_err(|_| "Windows dictation stopped".to_string())?;
    receive.recv_timeout(Duration::from_secs(4)).map_err(|_| "Windows dictation did not start in time".to_string())?
}

pub fn stop() -> Result<(), String> {
    let tx = COMMANDS.get().ok_or("Windows dictation is not initialized")?;
    let (reply, receive) = channel();
    tx.send(Command::Stop(reply)).map_err(|_| "Windows dictation stopped".to_string())?;
    receive.recv_timeout(Duration::from_secs(4)).map_err(|_| "Windows dictation did not stop in time".to_string())?
}

fn run(app: AppHandle, rx: std::sync::mpsc::Receiver<Command>) -> windows::core::Result<()> {
    // SAFETY: called once on a thread this module owns for its entire lifetime; never re-initialized.
    let debug = std::env::var("M9R_DEBUG").as_deref() == Ok("1");
    macro_rules! step {
        ($label:literal, $expr:expr) => {{
            if debug { eprintln!("M9R: native dictation setup: {}...", $label); }
            match $expr {
                Ok(v) => { if debug { eprintln!("M9R: native dictation setup: {} ok", $label); } v }
                Err(e) => { eprintln!("M9R: native dictation setup FAILED at {}: {e:?}", $label); return Err(e); }
            }
        }};
    }

    // SAPI's recognition-context event plumbing (SetInterest/SetNotifyWin32Event) is documented to
    // expect this thread to be a single-threaded apartment -- MTA produced E_INVALIDARG on SetInterest
    // even though SetNotifyWin32Event (called right before it) succeeded. Confirmed live 2026-10-31.
    step!("CoInitializeEx", unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() });

    let recognizer: ISpRecognizer = step!("CoCreateInstance(SpInprocRecognizer)", unsafe {
        // The in-process recognizer (private to this app), not the shared/system-wide one -- the
        // shared recognizer is the same engine behind Windows' own Win+Ctrl+S speech recognition and
        // triggers its one-time OS setup wizard ("Set up Speech Recognition") on first use, which is
        // the wrong UX for a feature inside our app. Confirmed live 2026-10-31.
        CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL).map_err(|e| {
            let _ = app.emit("dictation-unavailable", "No speech recognizer is installed for the current language.");
            e
        })
    });
    // Unlike the shared recognizer, the in-process one has no engine or audio source bound until given
    // one explicitly. The shared recognizer auto-selects the engine the OS "Set up Speech Recognition"
    // wizard configures; without an explicit SetRecognizer call here, the in-process recognizer has no
    // bound engine at all, which left SetInterest (and everything after it) failing with E_INVALIDARG
    // regardless of its own arguments. Confirmed live 2026-10-31.
    // No "Default" value exists under HKLM\SOFTWARE\Microsoft\Speech\Recognizers on this machine (the
    // classic OS speech-setup wizard that used to write it was removed starting with recent Windows 11
    // builds, replaced by the unrelated Voice Access feature -- there is no user-facing way left to set
    // it at all). GetDefaultTokenId() still reports success but SetInterest then fails regardless of
    // every other setup variable tried. Bind directly to the known-installed en-US desktop engine token
    // instead of trusting GetDefaultTokenId -- confirmed present via direct registry read 2026-10-31
    // (HKLM\SOFTWARE\Microsoft\Speech\Recognizers\Tokens\MS-1033-80-DESK), no OS config dependency.
    let token_id = windows::core::w!("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Recognizers\\Tokens\\MS-1033-80-DESK");
    let token: ISpObjectToken = step!("CoCreateInstance(SpObjectToken)", unsafe { CoCreateInstance(&SpObjectToken, None, CLSCTX_ALL) });
    step!("token.SetId", unsafe { token.SetId(PCWSTR::null(), token_id, false) });
    step!("SetRecognizer", unsafe { recognizer.SetRecognizer(&token) });
    // The default multimedia audio-in object picks the system's current default microphone.
    let audio_in: windows::core::IUnknown = step!("CoCreateInstance(SpMMAudioIn)", unsafe { CoCreateInstance(&SpMMAudioIn, None, CLSCTX_ALL) });
    step!("SetInput", unsafe { recognizer.SetInput(&audio_in, true) });
    let context: ISpRecoContext = step!("CreateRecoContext", unsafe { recognizer.CreateRecoContext() });
    step!("SetNotifyWin32Event", unsafe { context.SetNotifyWin32Event() });
    // Deliberately not calling SetInterest: it returned E_INVALIDARG here on every combination of
    // apartment model, notify mechanism, and engine-token source tried (confirmed live 2026-10-31,
    // all logged, root cause never isolated). Per Microsoft's own docs for ISpEventSource::SetInterest,
    // "If SetInterest is never called, the SR engine defaults to SPEI_RECOGNITION as the only event and
    // queued interest" -- exactly the one event this needs, so the call is simply unnecessary.

    let grammar: ISpRecoGrammar = step!("CreateGrammar", unsafe { context.CreateGrammar(1) });
    step!("LoadDictation", unsafe { grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC) });
    step!("SetDictationState(INACTIVE)", unsafe { grammar.SetDictationState(SPRS_INACTIVE) });
    if debug { eprintln!("M9R: native dictation setup complete, entering command loop"); }

    let mut listening = false;
    loop {
        // This thread is a single-threaded apartment (SAPI requires it; see the CoInitializeEx call
        // above), and STA threads are expected to pump Windows messages so COM can deliver calls
        // marshaled onto this apartment -- without this, SAPI's internal machinery can stall.
        unsafe {
            let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
            while windows::Win32::UI::WindowsAndMessaging::PeekMessageW(&mut msg, None, 0, 0, windows::Win32::UI::WindowsAndMessaging::PM_REMOVE).as_bool() {
                let _ = windows::Win32::UI::WindowsAndMessaging::TranslateMessage(&msg);
                windows::Win32::UI::WindowsAndMessaging::DispatchMessageW(&msg);
            }
        }
        // A short, bounded poll instead of blocking forever on the command channel: the recognizer's
        // own events (SPEI_RECOGNITION) need pumping on this same thread via GetEvents, and SAPI has
        // no cross-platform async story to merge the two waits, so this just interleaves them.
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Command::Start(reply)) => {
                if listening {
                    let _ = reply.send(Ok(()));
                } else {
                    match unsafe { grammar.SetDictationState(SPRS_ACTIVE) } {
                        Ok(()) => { listening = true; let _ = reply.send(Ok(())); }
                        Err(e) => {
                            eprintln!("M9R: native dictation could not start ({e})");
                            let _ = reply.send(Err(e.to_string()));
                        }
                    }
                }
            }
            Ok(Command::Stop(reply)) => {
                if !listening {
                    let _ = reply.send(Ok(()));
                } else {
                    listening = false;
                    match unsafe { grammar.SetDictationState(SPRS_INACTIVE) } {
                        Ok(()) => {
                            let _ = reply.send(Ok(()));
                            let _ = app.emit("dictation-ended", ());
                        }
                        Err(e) => {
                            eprintln!("M9R: native dictation did not stop cleanly ({e})");
                            let _ = reply.send(Err(e.to_string()));
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        pump_events(&context, &app);
    }
    Ok(())
}

/// Drains whatever SAPI recognition events are ready right now (non-blocking) and emits the recognized
/// text to the frontend. SAPI only reports whole recognized phrases, not interim hypotheses, through this
/// event path, so only `dictation-final` is emitted here.
fn pump_events(context: &ISpRecoContext, app: &AppHandle) {
    loop {
        let mut event = SPEVENT::default();
        let mut fetched: u32 = 0;
        if unsafe { context.GetEvents(1, &mut event, &mut fetched) }.is_err() || fetched == 0 {
            break;
        }
        // SPEVENT packs eEventId (low 16 bits) and elParamType (high 16 bits) into one field.
        let event_id = (event._bitfield & 0xFFFF) as i32;
        let param_type = ((event._bitfield >> 16) & 0xFFFF) as i32;
        if event_id != SPEI_RECOGNITION.0 || param_type != SPET_LPARAM_IS_OBJECT.0 {
            continue;
        }
        // SAPI hands over an already-AddRef'd IUnknown* in lParam for an object-typed event; from_raw
        // takes ownership of that reference instead of adding another one.
        let unknown = unsafe { windows::core::IUnknown::from_raw(event.lParam.0 as *mut core::ffi::c_void) };
        let Ok(result): windows::core::Result<ISpRecoResult> = unknown.cast() else { continue };
        let mut text_ptr = windows::core::PWSTR::null();
        let got_text = unsafe { result.GetText(0, SP_GETWHOLEPHRASE, true, &mut text_ptr, None) };
        if got_text.is_ok() && !text_ptr.is_null() {
            let text = unsafe { text_ptr.to_string() }.unwrap_or_default();
            unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(text_ptr.0 as *const core::ffi::c_void)) };
            if !text.trim().is_empty() {
                let _ = app.emit("dictation-final", text);
            }
        }
    }
}
