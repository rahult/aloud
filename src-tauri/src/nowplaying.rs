// Puts Chirp in the Now Playing widget so headphone and keyboard media keys
// control it.
//
// CAVEAT: macOS attributes Now Playing to the process that owns the audio
// session, and Chirp's audio comes from `afplay`, a separate process the Node
// server spawns. Wiring this up correctly may therefore not be sufficient for
// the system to route media keys here. Playing audio in-process would fix it
// — and would also allow true mid-sentence pause — but that is a larger
// change to where playback lives, not something to force from this file.

#![cfg(target_os = "macos")]

use crate::events::PlaybackState;
use objc2_foundation::{NSDictionary, NSString};
use objc2_media_player::{
    MPMediaItemPropertyArtist, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingPlaybackState, MPRemoteCommandCenter,
};

pub fn update(state: &PlaybackState, title: Option<&str>) {
    unsafe {
        let center = MPNowPlayingInfoCenter::defaultCenter();

        // The first sentence is the most useful thing to show — it is what
        // the widget will be sitting next to on screen.
        let heading = title.unwrap_or("Chirp");
        let subtitle = if state.count > 0 {
            format!(
                "{} · sentence {} of {}",
                state.voice,
                state.index + 1,
                state.count
            )
        } else {
            state.voice.clone()
        };

        let info = NSDictionary::from_slices(
            &[MPMediaItemPropertyTitle, MPMediaItemPropertyArtist],
            &[
                &*NSString::from_str(heading) as &objc2::runtime::AnyObject,
                &*NSString::from_str(&subtitle) as &objc2::runtime::AnyObject,
            ],
        );
        center.setNowPlayingInfo(Some(&info));
        center.setPlaybackState(match state.state.as_str() {
            "speaking" => MPNowPlayingPlaybackState::Playing,
            "paused" => MPNowPlayingPlaybackState::Paused,
            _ => MPNowPlayingPlaybackState::Stopped,
        });
    }
}

pub fn install_handlers() {
    use block2::RcBlock;
    use objc2_media_player::{MPRemoteCommandEvent, MPRemoteCommandHandlerStatus};

    unsafe {
        let commands = MPRemoteCommandCenter::sharedCommandCenter();

        // Every media key becomes an ordinary HTTP call: the server decides,
        // exactly as the tray and the hotkey do.
        macro_rules! route {
            ($cmd:expr, $path:literal) => {{
                let cmd = $cmd;
                cmd.setEnabled(true);
                let handler = RcBlock::new(move |_e: core::ptr::NonNull<MPRemoteCommandEvent>| {
                    std::thread::spawn(|| {
                        let _ = ureq::post(format!("{}{}", crate::base_url(), $path)).send_empty();
                    });
                    MPRemoteCommandHandlerStatus::Success
                });
                cmd.addTargetWithHandler(&handler);
            }};
        }

        route!(commands.playCommand(), "/api/playback/resume");
        route!(commands.pauseCommand(), "/api/playback/pause");
        route!(
            commands.togglePlayPauseCommand(),
            "/api/playback/toggle-pause"
        );
        route!(commands.nextTrackCommand(), "/api/playback/next");
        route!(commands.previousTrackCommand(), "/api/playback/prev");
    }
}
