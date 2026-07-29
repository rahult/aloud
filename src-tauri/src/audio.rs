// Audio output inside the app's own process.
//
// This is why Phase 3 exists: afplay could not pause a running file, and
// macOS attributes the Now Playing session to whichever process owns the
// audio — which was afplay, not us. rodio moves both into this process.
//
// This module decides nothing. The server tells it what to play and when to
// pause; it reports back when a track drains.

use std::io::Cursor;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Play(u64),
    Pause,
    Resume,
    Stop,
}

pub fn parse_command(v: &serde_json::Value) -> Option<Command> {
    match v.get("action")?.as_str()? {
        "play" => Some(Command::Play(v.get("id")?.as_u64()?)),
        "pause" => Some(Command::Pause),
        "resume" => Some(Command::Resume),
        "stop" => Some(Command::Stop),
        _ => None,
    }
}

pub struct Audio {
    // The device sink must outlive playback; dropping it silences everything.
    _device: rodio::stream::MixerDeviceSink,
    player: Mutex<rodio::Player>,
}

impl Audio {
    pub fn new() -> Result<Self, String> {
        let device = rodio::stream::DeviceSinkBuilder::open_default_sink()
            .map_err(|e| format!("no audio output: {e}"))?;
        let player = rodio::Player::connect_new(device.mixer());
        Ok(Self {
            _device: device,
            player: Mutex::new(player),
        })
    }

    pub fn play_bytes(&self, wav: Vec<u8>) -> Result<(), String> {
        let decoded = rodio::Decoder::new(Cursor::new(wav))
            .map_err(|e| format!("could not decode audio: {e}"))?;
        let player = self.player.lock().map_err(|_| "audio lock poisoned")?;
        player.stop();
        player.append(decoded);
        player.play();
        Ok(())
    }

    pub fn pause(&self) {
        if let Ok(p) = self.player.lock() {
            p.pause();
        }
    }

    pub fn resume(&self) {
        if let Ok(p) = self.player.lock() {
            p.play();
        }
    }

    pub fn stop(&self) {
        if let Ok(p) = self.player.lock() {
            p.stop();
        }
    }

    /// True once the queued track has drained. Polled rather than
    /// callback-driven because rodio has no end-of-track signal.
    pub fn finished(&self) -> bool {
        self.player.lock().map(|p| p.empty()).unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_command() {
        let p = |s: &str| parse_command(&serde_json::from_str(s).unwrap());
        assert!(matches!(p(r#"{"action":"play","id":7}"#), Some(Command::Play(7))));
        assert!(matches!(p(r#"{"action":"pause"}"#), Some(Command::Pause)));
        assert!(matches!(p(r#"{"action":"resume"}"#), Some(Command::Resume)));
        assert!(matches!(p(r#"{"action":"stop"}"#), Some(Command::Stop)));
    }

    #[test]
    fn rejects_nonsense() {
        let p = |s: &str| parse_command(&serde_json::from_str(s).unwrap());
        assert!(p(r#"{"action":"explode"}"#).is_none());
        assert!(p(r#"{"action":"play"}"#).is_none(), "play needs an id");
        assert!(p(r#"{}"#).is_none());
    }
}
