// The tray is a view of the server's session, not a second copy of it: every
// item posts a command, and every label comes back from the event feed. That
// is the same discipline that removed the stale playback flag — nothing here
// remembers whether audio is playing.

use crate::events::PlaybackState;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;

pub const SPEEDS: [f64; 5] = [0.75, 1.0, 1.25, 1.5, 2.0];

pub struct Handles {
    pub play: MenuItem<tauri::Wry>,
    pub prev: MenuItem<tauri::Wry>,
    pub next: MenuItem<tauri::Wry>,
    pub stop: MenuItem<tauri::Wry>,
    pub voices: Vec<(String, CheckMenuItem<tauri::Wry>)>,
    pub speeds: Vec<(f64, CheckMenuItem<tauri::Wry>)>,
}

#[derive(serde::Deserialize)]
struct Voice {
    id: String,
    name: String,
    grade: String,
    #[serde(default)]
    recommended: bool,
}

// Only the shortlist goes in the tray: a 28-item menu is a wall, and the full
// list is one click away in the window.
fn recommended_voices(base_url: &str) -> Vec<Voice> {
    let Ok(res) = ureq::get(format!("{base_url}/api/voices")).call() else {
        return Vec::new();
    };
    let Ok(all) = res.into_body().read_json::<Vec<Voice>>() else {
        return Vec::new();
    };
    all.into_iter().filter(|v| v.recommended).collect()
}

pub fn build(app: &tauri::AppHandle, base_url: &str) -> tauri::Result<Handles> {
    // Everything starts disabled: nothing is playing at launch, and a live
    // menu that lies is worse than one that greys out.
    let play = MenuItemBuilder::with_id("pb:play", "Play")
        .enabled(false)
        .build(app)?;
    let prev = MenuItemBuilder::with_id("pb:prev", "Previous")
        .enabled(false)
        .build(app)?;
    let next = MenuItemBuilder::with_id("pb:next", "Next")
        .enabled(false)
        .build(app)?;
    let stop = MenuItemBuilder::with_id("pb:stop", "Stop")
        .enabled(false)
        .build(app)?;

    let mut voices = Vec::new();
    let mut voice_menu = SubmenuBuilder::new(app, "Voice");
    for v in recommended_voices(base_url) {
        let item = CheckMenuItemBuilder::with_id(
            format!("voice:{}", v.id),
            format!("{}  ({})", v.name, v.grade),
        )
        .build(app)?;
        voice_menu = voice_menu.item(&item);
        voices.push((v.id, item));
    }

    let mut speeds = Vec::new();
    let mut speed_menu = SubmenuBuilder::new(app, "Speed");
    for s in SPEEDS {
        let item =
            CheckMenuItemBuilder::with_id(format!("speed:{s}"), format!("{s}\u{00d7}")).build(app)?;
        speed_menu = speed_menu.item(&item);
        speeds.push((s, item));
    }

    let show = MenuItemBuilder::with_id("show", "Show Chirp").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings\u{2026}").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&play, &prev, &next, &stop])
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&voice_menu.build()?)
        .item(&speed_menu.build()?)
        .item(&PredefinedMenuItem::separator(app)?)
        .items(&[&show, &settings, &quit])
        .build()?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("window icon").clone())
        .menu(&menu)
        .on_menu_event(crate::on_tray_event)
        .build(app)?;

    Ok(Handles {
        play,
        prev,
        next,
        stop,
        voices,
        speeds,
    })
}

/// Point the menu at the session's current state. Pure in spirit: it reads
/// the state and writes labels, and decides nothing.
pub fn apply(h: &Handles, s: &PlaybackState) {
    let speaking = s.state == "speaking";
    let active = speaking || s.state == "paused";

    let _ = h.play.set_text(play_label(&s.state));
    let _ = h.play.set_enabled(active);
    let _ = h.prev.set_enabled(active && s.index > 0);
    let _ = h.next.set_enabled(active && s.index + 1 < s.count);
    let _ = h.stop.set_enabled(active);

    for (id, item) in &h.voices {
        let _ = item.set_checked(*id == s.voice);
    }
    for (value, item) in &h.speeds {
        let _ = item.set_checked((*value - s.speed).abs() < 1e-9);
    }
}

/// Which label the play item should carry for a given state. Split out so the
/// three-way rule is testable without building a menu.
pub fn play_label(state: &str) -> &'static str {
    match state {
        "speaking" => "Pause",
        "paused" => "Resume",
        _ => "Play",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_play_item_says_what_pressing_it_will_do() {
        assert_eq!(play_label("speaking"), "Pause");
        assert_eq!(play_label("paused"), "Resume");
        assert_eq!(play_label("idle"), "Play");
        assert_eq!(play_label("anything else"), "Play");
    }

    #[test]
    fn speeds_match_the_web_ui_rate_button() {
        assert_eq!(SPEEDS, [0.75, 1.0, 1.25, 1.5, 2.0]);
    }
}
