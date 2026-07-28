use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const BASE_URL: &str = "http://127.0.0.1:8789";

// Best-effort playback state: set once /api/speak accepts an utterance,
// cleared on /api/stop. Drives the hotkey's speak/stop toggle.
static PLAYING: AtomicBool = AtomicBool::new(false);

// Keep the node sidecar alive for the app's lifetime; dropping it on exit
// terminates the TTS server.
struct Backend(Mutex<Option<CommandChild>>);

// Block until the TTS server answers (or ~10s elapse) so the window never
// loads before the server listens.
fn wait_for_server() {
    for _ in 0..50 {
        if ureq::get(format!("{BASE_URL}/api/health")).call().is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

// CmdOrCtrl+Shift+Space: stop playback if speaking, else speak the clipboard.
fn toggle_speak(app: &tauri::AppHandle) {
    if PLAYING.swap(false, Ordering::SeqCst) {
        std::thread::spawn(|| {
            let _ = ureq::post(format!("{BASE_URL}/api/stop")).send_empty();
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
        if let Ok(res) =
            ureq::post(format!("{BASE_URL}/api/speak")).send_json(serde_json::json!({"text": text}))
        {
            if res.status().is_success() {
                PLAYING.store(true, Ordering::SeqCst);
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

            let server = app.path().resource_dir()?.join("server.mjs");
            let (_rx, child) = app
                .shell()
                .sidecar("node")?
                .args([server.to_string_lossy().to_string()])
                .env("CHIRP_PORT", "8789")
                .spawn()?;
            app.manage(Backend(Mutex::new(Some(child))));

            wait_for_server();

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(BASE_URL.parse().expect("valid base url")),
            )
            .title("Chirp")
            .inner_size(420.0, 560.0)
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

            let shortcut: Shortcut = "CmdOrCtrl+Shift+Space".parse().expect("valid shortcut");
            app.global_shortcut()
                .on_shortcut(shortcut, |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_speak(app);
                    }
                })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Chirp");
}
