use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 8789;
const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Space";

// Resolved once at startup from ~/.chirp/config.json — the same file the
// server and the `say` CLI read. Port changes require an app restart to
// bind; the hotkey is re-registered live by watch_config().
static PORT: OnceLock<u16> = OnceLock::new();

fn base_url() -> String {
    format!(
        "http://127.0.0.1:{}",
        PORT.get().copied().unwrap_or(DEFAULT_PORT)
    )
}

// Best-effort playback state: set once /api/speak accepts an utterance,
// cleared on /api/stop. Drives the hotkey's speak/stop toggle.
static PLAYING: AtomicBool = AtomicBool::new(false);

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

// Hotkey: stop playback if speaking, else speak the clipboard.
fn toggle_speak(app: &tauri::AppHandle) {
    if PLAYING.swap(false, Ordering::SeqCst) {
        std::thread::spawn(|| {
            let _ = ureq::post(format!("{}/api/stop", base_url())).send_empty();
        });
        return;
    }
    let Ok(text) = app.clipboard().read_text() else {
        return;
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        if let Ok(res) = ureq::post(format!("{}/api/speak", base_url()))
            .send_json(serde_json::json!({"text": text}))
        {
            if res.status().is_success() {
                PLAYING.store(true, Ordering::SeqCst);
            }
        }
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
                println!("chirp: hotkey updated to {hotkey}");
                current = new;
            } else {
                let _ = register_hotkey(&app, current);
            }
        }
    });
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
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

            let show = MenuItemBuilder::with_id("show", "Show Chirp").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("window icon").clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let hotkey = cfg_path
                .as_deref()
                .map(configured_hotkey)
                .unwrap_or_else(|| DEFAULT_HOTKEY.to_string());
            let shortcut: Shortcut = hotkey
                .parse()
                .unwrap_or_else(|_| DEFAULT_HOTKEY.parse().expect("valid default shortcut"));
            register_hotkey(app.handle(), shortcut)?;
            if let Some(path) = cfg_path {
                watch_config(app.handle().clone(), path, shortcut);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Chirp");
}
