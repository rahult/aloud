mod audio;
mod events;
mod selection;
mod tray;
#[cfg(target_os = "macos")]
mod nowplaying;
#[cfg(target_os = "macos")]
mod services;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_PORT: u16 = 8789;
const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Space";

// Resolved once at startup from ~/.chirp/config.json — the same file the
// server and the `say` CLI read. Port changes require an app restart to
// bind; the hotkey is re-registered live by watch_config().
static PORT: OnceLock<u16> = OnceLock::new();

// The first sentence of the current session, for the Now Playing widget.
static CURRENT_TITLE: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn base_url() -> String {
    format!(
        "http://127.0.0.1:{}",
        PORT.get().copied().unwrap_or(DEFAULT_PORT)
    )
}

// Keep the node sidecar alive for the app's lifetime; dropping it on exit
// terminates the TTS server.
struct Backend(Mutex<Option<CommandChild>>);

fn config_value(path: &Path, key: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get(key)
        .cloned()
}

fn configured_port(path: Option<&Path>) -> u16 {
    path.and_then(|p| config_value(p, "port"))
        .and_then(|v| v.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(DEFAULT_PORT)
}

fn configured_hotkey(path: &Path) -> String {
    config_value(path, "hotkey")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| s.parse::<Shortcut>().is_ok())
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

// Read fresh on every press rather than cached at startup, so switching the
// mode in Settings takes effect immediately.
fn configured_input(path: Option<&Path>) -> String {
    path.and_then(|p| config_value(p, "input"))
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| s == "clipboard" || s == "selection")
        .unwrap_or_else(|| "selection".to_string())
}

fn configured_now_playing(path: Option<&Path>) -> bool {
    path.and_then(|p| config_value(p, "nowPlaying"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .home_dir()
        .ok()
        .map(|h| h.join(".chirp").join("config.json"))
}

// Synthesising the copy that captures the selection needs Accessibility on
// macOS. Without it the hotkey silently does nothing, which is the worst way
// for a hotkey to fail — so the state is reported to the server and Settings
// says so out loud.
#[cfg(target_os = "macos")]
fn accessibility_ok() -> bool {
    macos_accessibility_client::accessibility::application_is_trusted()
}
#[cfg(not(target_os = "macos"))]
fn accessibility_ok() -> bool {
    true
}

fn report_native_status(ok: bool) {
    std::thread::spawn(move || {
        let _ = ureq::post(format!("{}/api/native-status", base_url()))
            .send_json(serde_json::json!({"accessibilityOk": ok}));
    });
}

fn handle_command(name: &str) {
    match name {
        "request-accessibility" => {
            #[cfg(target_os = "macos")]
            {
                // Shows the system prompt with its "Open System Settings"
                // button. Returns the state at the moment of asking, so the
                // watcher below is what actually notices the grant.
                let ok =
                    macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
                report_native_status(ok);
            }
        }
        "open-accessibility-settings" => {
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                    .spawn();
            }
        }
        _ => {}
    }
}

// The grant can be given while we are running, so notice it rather than
// making the user restart the app to pick it up.
fn watch_accessibility() {
    std::thread::spawn(|| {
        let mut last = accessibility_ok();
        report_native_status(last);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let now = accessibility_ok();
            if now != last {
                last = now;
                eprintln!("chirp: accessibility permission is now {now}");
                report_native_status(now);
            }
        }
    });
}

// The audio device, opened once. None if the machine has no output device,
// in which case the server keeps using its own player.
static AUDIO: OnceLock<Option<audio::Audio>> = OnceLock::new();

fn audio() -> Option<&'static audio::Audio> {
    AUDIO
        .get_or_init(|| match audio::Audio::new() {
            Ok(a) => Some(a),
            Err(e) => {
                eprintln!("chirp: {e}; falling back to the server's player");
                None
            }
        })
        .as_ref()
}

// rodio has no end-of-track callback, so completion is polled and reported
// back. The id travels with the report so the server can ignore one that
// arrives after it has already moved on — which is exactly what happens when
// a Stop is followed by a new Play and this thread is still running.
fn play_and_report(id: u64) {
    std::thread::spawn(move || {
        let Some(a) = audio() else { return };
        let outcome = ureq::get(format!("{}/api/audio/{}", base_url(), id))
            .call()
            .map_err(|e| format!("could not fetch audio: {e}"))
            .and_then(|res| {
                res.into_body()
                    .read_to_vec()
                    .map_err(|e| format!("could not read audio: {e}"))
            })
            .and_then(|bytes| a.play_bytes(bytes));

        if let Err(e) = outcome {
            report_ended(id, Some(e));
            return;
        }
        loop {
            // 50ms is inaudible at a sentence boundary and costs nothing.
            std::thread::sleep(std::time::Duration::from_millis(50));
            if a.finished() {
                report_ended(id, None);
                return;
            }
        }
    });
}

fn report_ended(id: u64, error: Option<String>) {
    let body = match error {
        Some(e) => serde_json::json!({ "error": e }),
        None => serde_json::json!({}),
    };
    let _ = ureq::post(format!("{}/api/audio/{}/ended", base_url(), id)).send_json(body);
}

fn handle_audio(value: &serde_json::Value) {
    let Some(cmd) = audio::parse_command(value) else {
        return;
    };
    match cmd {
        audio::Command::Play(id) => play_and_report(id),
        audio::Command::Pause => {
            if let Some(a) = audio() {
                a.pause();
            }
        }
        audio::Command::Resume => {
            if let Some(a) = audio() {
                a.resume();
            }
        }
        audio::Command::Stop => {
            if let Some(a) = audio() {
                a.stop();
            }
        }
    }
}

// Block until the TTS server answers (or ~10s elapse) so the window never
// loads before the server listens.
fn wait_for_server() {
    for _ in 0..50 {
        if ureq::get(format!("{}/api/health", base_url()))
            .call()
            .is_ok()
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

// Hotkey: ask the server what to do. It is the only thing that knows whether
// audio is playing, so it decides — and only tells us to fetch text when it
// actually needs some. That round trip matters: capturing the selection has
// side effects (a synthesised copy), so it must not happen speculatively.
//
// This replaces a local AtomicBool that went stale whenever audio finished on
// its own, which spent the next hotkey press on a no-op stop.
fn toggle_speak(app: &tauri::AppHandle) {
    eprintln!("chirp: hotkey pressed");
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(res) = ureq::post(format!("{}/api/playback/toggle", base_url())).send_empty() else {
            eprintln!("chirp: toggle failed — is the server running?");
            return;
        };
        let Ok(body) = res.into_body().read_json::<serde_json::Value>() else {
            return;
        };
        if body.get("action").and_then(|v| v.as_str()) != Some("need_text") {
            return;
        }
        let mode = configured_input(config_path(&app).as_deref());
        let Some(text) = selection::capture(&app, &mode) else {
            eprintln!("chirp: nothing selected and nothing on the clipboard");
            return;
        };
        let _ = ureq::post(format!("{}/api/speak", base_url()))
            .send_json(serde_json::json!({"text": text}));
    });
}

fn register_hotkey(
    app: &tauri::AppHandle,
    shortcut: Shortcut,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_speak(app);
            }
        })
}

// Poll the config file so hotkey edits from the web UI apply without an app
// restart. Port changes still need one — the server binds at startup.
fn watch_config(app: tauri::AppHandle, path: PathBuf, mut current: Shortcut) {
    std::thread::spawn(move || {
        let mut last_mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            if mtime == last_mtime {
                continue;
            }
            last_mtime = mtime;
            let hotkey = configured_hotkey(&path);
            let Ok(new) = hotkey.parse::<Shortcut>() else {
                continue;
            };
            if new == current {
                continue;
            }
            let _ = app.global_shortcut().unregister(current);
            if register_hotkey(&app, new).is_ok() {
                eprintln!("chirp: hotkey updated to {hotkey}");
                current = new;
            } else {
                let _ = register_hotkey(&app, current);
            }
        }
    });
}

// Fire-and-forget POST: menu clicks must never block the UI thread waiting
// on the server.
fn post(path: &'static str) {
    std::thread::spawn(move || {
        let _ = ureq::post(format!("{}{}", base_url(), path)).send_empty();
    });
}

fn post_settings(body: serde_json::Value) {
    std::thread::spawn(move || {
        let _ = ureq::post(format!("{}/api/settings", base_url())).send_json(body);
    });
}

pub fn on_tray_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "show" => show_main_window(app),
        "settings" => {
            show_main_window(app);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("document.querySelector('[data-view=settings]')?.click()");
            }
        }
        "quit" => app.exit(0),
        // toggle-pause, not toggle: a menu item labelled "Pause" must never
        // start speaking the clipboard.
        "pb:play" => post("/api/playback/toggle-pause"),
        "pb:prev" => post("/api/playback/prev"),
        "pb:next" => post("/api/playback/next"),
        "pb:stop" => post("/api/playback/stop"),
        _ => {
            if let Some(v) = id.strip_prefix("voice:") {
                post_settings(serde_json::json!({"voice": v}));
            } else if let Some(s) = id.strip_prefix("speed:") {
                if let Ok(n) = s.parse::<f64>() {
                    post_settings(serde_json::json!({"speed": n}));
                }
            }
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Silent auto-update: check GitHub Releases in the background, and if a
// newer signed build exists, download, install, and restart into it.
fn check_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else {
            return;
        };
        let Ok(Some(update)) = updater.check().await else {
            return;
        };
        println!("chirp: updating to {}", update.version);
        if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
            app.restart();
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let cfg_path = app
                .path()
                .home_dir()
                .ok()
                .map(|h| h.join(".chirp").join("config.json"));
            let port = configured_port(cfg_path.as_deref());
            let _ = PORT.set(port);

            let server = app.path().resource_dir()?.join("server.mjs");
            let (_rx, child) = app
                .shell()
                .sidecar("node")?
                .args([server.to_string_lossy().to_string()])
                .env("CHIRP_PORT", port.to_string())
                .spawn()?;
            app.manage(Backend(Mutex::new(Some(child))));

            wait_for_server();

            events::listen(app.handle().clone(), base_url(), |app, event| match event {
                events::Event::Command(name) => handle_command(&name),
                events::Event::Playback(state) => {
                    if let Some(handles) = app.try_state::<Mutex<tray::Handles>>() {
                        if let Ok(h) = handles.lock() {
                            tray::apply(&h, &state);
                        }
                    }
                    #[cfg(target_os = "macos")]
                    {
                        let title = CURRENT_TITLE.lock().unwrap().clone();
                        nowplaying::update(&state, title.as_deref());
                    }
                }
                events::Event::Sentences(sentences) => {
                    *CURRENT_TITLE.lock().unwrap() = sentences.into_iter().next();
                }
                events::Event::Audio(value) => handle_audio(&value),
            });
            watch_accessibility();

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(base_url().parse().expect("valid base url")),
            )
            .title("Chirp")
            .inner_size(560.0, 640.0)
            .build()?;
            // Closing the window hides it; the app lives in the tray.
            let w = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = w.hide();
                }
            });

            let handles = tray::build(app.handle(), &base_url())?;
            app.manage(Mutex::new(handles));

            let hotkey = cfg_path
                .as_deref()
                .map(configured_hotkey)
                .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());
            let shortcut: Shortcut = hotkey
                .parse()
                .unwrap_or_else(|_| DEFAULT_HOTKEY.parse().expect("valid default shortcut"));
            // A conflicting registration (e.g. another app holds the combo)
            // must not take down the whole app — the user can pick another
            // combo in Settings and the watcher applies it live.
            let registered = register_hotkey(app.handle(), shortcut);
            match &registered {
                Err(e) => eprintln!("chirp: could not register hotkey {hotkey}: {e}"),
                Ok(()) => eprintln!("chirp: hotkey registered: {hotkey}"),
            }
            // Let Settings say "in use by another app" instead of the hotkey
            // silently doing nothing.
            let ok = registered.is_ok();
            let reported = hotkey.clone();
            std::thread::spawn(move || {
                let _ = ureq::post(format!("{}/api/hotkey-status", base_url()))
                    .send_json(serde_json::json!({"ok": ok, "hotkey": reported}));
            });
            #[cfg(target_os = "macos")]
            {
                if configured_now_playing(cfg_path.as_deref()) {
                    nowplaying::install_handlers();
                }
                services::register();
            }

            // Consumes cfg_path, so it goes last.
            if let Some(path) = cfg_path {
                watch_config(app.handle().clone(), path, shortcut);
            }

            check_for_updates(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Chirp")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Reap the node sidecar so it never outlives the app.
                if let Some(backend) = app.try_state::<Backend>() {
                    if let Some(child) = backend.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
