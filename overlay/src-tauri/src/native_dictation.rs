// Native Windows dictation. WebView2 cannot run the Web Speech API's cloud recognizer -- confirmed live
// 2026-10-10: `new webkitSpeechRecognition().start()` fires onstart then immediately onerror "network", every
// time, regardless of microphone permission. This uses Windows' own on-device speech recognizer instead
// (Windows.Media.SpeechRecognition), which runs locally and has no per-use cost. It owns a single background
// thread for the lifetime of the app; the recognizer and its continuous session are created once and reused
// across every Alt+M press, since recompiling the recognition grammar on every hold would add latency.
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;

use tauri::{AppHandle, Emitter};
use windows::Foundation::TypedEventHandler;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognizer,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

enum Command {
    Start,
    Stop,
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

pub fn start() {
    if let Some(tx) = COMMANDS.get() {
        let _ = tx.send(Command::Start);
    }
}

pub fn stop() {
    if let Some(tx) = COMMANDS.get() {
        let _ = tx.send(Command::Stop);
    }
}

fn run(app: AppHandle, rx: std::sync::mpsc::Receiver<Command>) -> windows::core::Result<()> {
    // SAFETY: called once on a thread this module owns for its entire lifetime; never re-initialized.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };

    let recognizer = SpeechRecognizer::new().map_err(|e| {
        let _ = app.emit("dictation-unavailable", "No speech recognizer is installed for the current language.");
        e
    })?;
    recognizer.CompileConstraintsAsync()?.get()?;
    let session = recognizer.ContinuousRecognitionSession()?;

    {
        let app = app.clone();
        recognizer.HypothesisGenerated(&TypedEventHandler::new(move |_sender, args: windows::core::Ref<'_, SpeechRecognitionHypothesisGeneratedEventArgs>| {
            if let Some(args) = args.as_ref() {
                if let Ok(text) = args.Hypothesis().and_then(|h| h.Text()) {
                    let _ = app.emit("dictation-interim", text.to_string_lossy());
                }
            }
            Ok(())
        }))?;
    }
    {
        let app = app.clone();
        session.ResultGenerated(&TypedEventHandler::new(move |_sender, args: windows::core::Ref<'_, SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            if let Some(args) = args.as_ref() {
                if let Ok(text) = args.Result().and_then(|r| r.Text()) {
                    let text = text.to_string_lossy();
                    if !text.trim().is_empty() {
                        let _ = app.emit("dictation-final", text);
                    }
                }
            }
            Ok(())
        }))?;
    }
    {
        let app = app.clone();
        session.Completed(&TypedEventHandler::new(move |_sender, _args: windows::core::Ref<'_, SpeechContinuousRecognitionCompletedEventArgs>| {
            let _ = app.emit("dictation-ended", ());
            Ok(())
        }))?;
    }

    let mut listening = false;
    for command in rx {
        match command {
            Command::Start => {
                if listening {
                    continue;
                }
                match session.StartAsync().and_then(|op| op.get()) {
                    Ok(()) => listening = true,
                    Err(e) => {
                        eprintln!("M9R: native dictation could not start ({e})");
                        let _ = app.emit("dictation-error", e.message());
                    }
                }
            }
            Command::Stop => {
                if !listening {
                    continue;
                }
                listening = false;
                if let Err(e) = session.StopAsync().and_then(|op| op.get()) {
                    eprintln!("M9R: native dictation did not stop cleanly ({e})");
                }
            }
        }
    }
    Ok(())
}
