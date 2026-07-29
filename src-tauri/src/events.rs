// One long-lived connection to the server's event feed. The server is the
// only thing that knows what is playing, so the tray, Now Playing, and the
// permission prompts all learn about it here rather than keeping their own
// idea of the truth.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PlaybackState {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub count: usize,
    #[serde(default)]
    pub voice: String,
    #[serde(default)]
    pub speed: f64,
}

#[derive(Debug, Clone)]
pub enum Event {
    Playback(PlaybackState),
    Sentences(Vec<String>),
    Command(String),
}

#[derive(Deserialize)]
struct SentencesFrame {
    #[serde(default)]
    sentences: Vec<String>,
}

#[derive(Deserialize)]
struct CommandFrame {
    #[serde(default)]
    name: String,
}

// Pure: turn one SSE frame into an Event. Separated from the socket so the
// wire format can be tested without a server or a Tauri app handle.
pub fn parse_frame(event: &str, payload: &str) -> Option<Event> {
    match event {
        "state" => serde_json::from_str::<PlaybackState>(payload)
            .ok()
            .map(Event::Playback),
        "sentences" => serde_json::from_str::<SentencesFrame>(payload)
            .ok()
            .map(|f| Event::Sentences(f.sentences)),
        "command" => serde_json::from_str::<CommandFrame>(payload)
            .ok()
            .filter(|f| !f.name.is_empty())
            .map(|f| Event::Command(f.name)),
        _ => None,
    }
}

// Reconnects forever: the sidecar can restart under us, and a menu bar app
// that silently stops following playback is worse than one that retries.
pub fn listen<F>(app: tauri::AppHandle, base_url: String, on_event: F)
where
    F: Fn(&tauri::AppHandle, Event) + Send + 'static,
{
    std::thread::spawn(move || loop {
        if let Err(e) = pump(&app, &base_url, &on_event) {
            eprintln!("chirp: event feed dropped ({e}); retrying");
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    });
}

fn pump<F>(
    app: &tauri::AppHandle,
    base_url: &str,
    on_event: &F,
) -> Result<(), Box<dyn std::error::Error>>
where
    F: Fn(&tauri::AppHandle, Event),
{
    use std::io::BufRead;
    let res = ureq::get(format!("{base_url}/api/playback/events")).call()?;
    let reader = std::io::BufReader::new(res.into_body().into_reader());

    let mut event = String::new();
    for line in reader.lines() {
        let line = line?;
        if let Some(name) = line.strip_prefix("event: ") {
            event = name.trim().to_string();
        } else if let Some(payload) = line.strip_prefix("data: ") {
            if let Some(parsed) = parse_frame(&event, payload) {
                on_event(app, parsed);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_state_frame() {
        let f = parse_frame(
            "state",
            r#"{"state":"speaking","index":2,"count":5,"voice":"bm_george","speed":1.25}"#,
        );
        let Some(Event::Playback(s)) = f else {
            panic!("expected a playback event, got {f:?}")
        };
        assert_eq!(s.state, "speaking");
        assert_eq!(s.index, 2);
        assert_eq!(s.count, 5);
        assert_eq!(s.voice, "bm_george");
        assert_eq!(s.speed, 1.25);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let f = parse_frame("state", r#"{"state":"idle"}"#);
        let Some(Event::Playback(s)) = f else {
            panic!("expected a playback event")
        };
        assert_eq!(s.count, 0);
        assert_eq!(s.voice, "");
    }

    #[test]
    fn parses_sentences_and_commands() {
        let f = parse_frame("sentences", r#"{"sentences":["One.","Two."]}"#);
        let Some(Event::Sentences(s)) = f else {
            panic!("expected sentences")
        };
        assert_eq!(s, vec!["One.".to_string(), "Two.".to_string()]);

        let f = parse_frame("command", r#"{"name":"request-accessibility"}"#);
        let Some(Event::Command(name)) = f else {
            panic!("expected a command")
        };
        assert_eq!(name, "request-accessibility");
    }

    #[test]
    fn ignores_frames_we_do_not_handle() {
        assert!(parse_frame("model", r#"{"loaded":true}"#).is_none());
        assert!(parse_frame("ping", "").is_none());
        // Malformed JSON must not take the connection down.
        assert!(parse_frame("state", "not json").is_none());
        // An empty command name is not a command.
        assert!(parse_frame("command", r#"{"name":""}"#).is_none());
    }
}
