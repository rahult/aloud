// Reading the selection without destroying the clipboard.
//
// There is no portable "give me the selected text" call. The reliable trick
// is to copy it and put back what was there: save the clipboard, synthesise
// the platform's copy chord, wait for the clipboard to actually change, take
// the value, and restore the original.
//
// On X11/Wayland the PRIMARY selection already holds the highlighted text, so
// no keystroke is needed and the clipboard is never touched at all.
//
// The save/restore dance is the part that can go wrong in ways the user would
// hate — losing what they had copied — so it lives in `capture_via_copy`,
// which takes the clipboard and the copy action as parameters and is unit
// tested without a GUI, a keystroke, or an Accessibility grant.

use tauri_plugin_clipboard_manager::ClipboardExt;

// How long to wait for the target app to service the copy. Slower apps
// (Electron, remote desktops) need more than a couple of frames; beyond this
// the user would rather it failed than hung.
const POLL: std::time::Duration = std::time::Duration::from_millis(20);
const ATTEMPTS: usize = 20; // 20 x 20ms = 400ms
// Give the target app a moment to finish its copy before we put the old
// clipboard back, or a slow writer lands after our restore.
const RESTORE_DELAY: std::time::Duration = std::time::Duration::from_millis(120);

// A sentinel makes "the copy did nothing" distinguishable from "the selection
// happens to equal the clipboard" — without it, speaking the same text twice
// looks like a failure.
const SENTINEL: &str = "\u{0}chirp-capture\u{0}";

/// The clipboard operations `capture_via_copy` needs, so tests can supply a
/// fake instead of the real system pasteboard.
pub trait Clipboard {
    fn read(&self) -> Option<String>;
    fn write(&self, text: String) -> bool;
}

struct SystemClipboard<'a>(&'a tauri::AppHandle);

impl Clipboard for SystemClipboard<'_> {
    fn read(&self) -> Option<String> {
        self.0.clipboard().read_text().ok()
    }
    fn write(&self, text: String) -> bool {
        self.0.clipboard().write_text(text).is_ok()
    }
}

pub fn capture(app: &tauri::AppHandle, mode: &str) -> Option<String> {
    let clip = SystemClipboard(app);
    let text = match mode {
        "clipboard" => clip.read(),
        // Fall back to the clipboard when nothing is selected, so the hotkey
        // still does something useful rather than nothing.
        _ => capture_selection(app, &clip).or_else(|| clip.read()),
    };
    let text = text?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(target_os = "linux")]
fn capture_selection<C: Clipboard>(_app: &tauri::AppHandle, _clip: &C) -> Option<String> {
    // PRIMARY is the selection — reading it has no side effects, so there is
    // nothing to save or restore.
    for (cmd, args) in [
        ("wl-paste", vec!["-p", "-n"]),
        ("xclip", vec!["-o", "-selection", "primary"]),
        ("xsel", vec!["-o", "-p"]),
    ] {
        if let Ok(out) = std::process::Command::new(cmd).args(&args).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn capture_selection<C: Clipboard>(_app: &tauri::AppHandle, clip: &C) -> Option<String> {
    capture_via_copy(
        clip,
        &mut || send_copy().is_ok(),
        ATTEMPTS,
        &|| std::thread::sleep(POLL),
        &|| std::thread::sleep(RESTORE_DELAY),
    )
}

/// Save the clipboard, trigger a copy, wait for it to land, take the value,
/// and put the original back. Returns the captured selection, or None if the
/// copy produced nothing. **The clipboard is always restored**, on every path.
pub fn capture_via_copy<C: Clipboard>(
    clip: &C,
    do_copy: &mut dyn FnMut() -> bool,
    attempts: usize,
    poll: &dyn Fn(),
    settle: &dyn Fn(),
) -> Option<String> {
    let saved = clip.read();

    if !clip.write(SENTINEL.to_string()) {
        return None;
    }

    if !do_copy() {
        restore(clip, saved);
        return None;
    }

    let mut captured = None;
    for _ in 0..attempts {
        poll();
        if let Some(now) = clip.read() {
            if now != SENTINEL {
                captured = Some(now);
                break;
            }
        }
    }

    settle();
    restore(clip, saved);
    captured.filter(|s| !s.trim().is_empty())
}

fn restore<C: Clipboard>(clip: &C, saved: Option<String>) {
    // Whatever happens, the sentinel must not be left behind.
    clip.write(saved.unwrap_or_default());
}

#[cfg(not(target_os = "linux"))]
fn send_copy() -> Result<(), Box<dyn std::error::Error>> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default())?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press)?;
    let pressed = enigo.key(Key::Unicode('c'), Direction::Click);
    // Release the modifier even if the keypress failed, or the user is left
    // with a stuck Cmd key.
    let released = enigo.key(modifier, Direction::Release);
    pressed?;
    released?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A clipboard that records every write, so tests can assert on what was
    /// left behind as well as what came back.
    struct FakeClipboard {
        value: RefCell<Option<String>>,
        writes: RefCell<Vec<String>>,
        // What the "copy" puts on the clipboard, if anything.
        copies: RefCell<Option<String>>,
        writable: bool,
    }

    impl FakeClipboard {
        fn new(initial: Option<&str>, copies: Option<&str>) -> Self {
            Self {
                value: RefCell::new(initial.map(str::to_string)),
                writes: RefCell::new(Vec::new()),
                copies: RefCell::new(copies.map(str::to_string)),
                writable: true,
            }
        }
        fn now(&self) -> Option<String> {
            self.value.borrow().clone()
        }
    }

    impl Clipboard for FakeClipboard {
        fn read(&self) -> Option<String> {
            self.value.borrow().clone()
        }
        fn write(&self, text: String) -> bool {
            if !self.writable {
                return false;
            }
            self.writes.borrow_mut().push(text.clone());
            *self.value.borrow_mut() = Some(text);
            true
        }
    }

    // Simulates the target app servicing the copy.
    fn copier(clip: &FakeClipboard) -> impl FnMut() -> bool + '_ {
        move || {
            if let Some(text) = clip.copies.borrow().clone() {
                *clip.value.borrow_mut() = Some(text);
            }
            true
        }
    }

    const NOOP: &dyn Fn() = &|| {};

    #[test]
    fn captures_the_selection_and_restores_the_clipboard() {
        let clip = FakeClipboard::new(Some("PRIOR"), Some("the selected sentence"));
        let got = capture_via_copy(&clip, &mut copier(&clip), 5, NOOP, NOOP);
        assert_eq!(got.as_deref(), Some("the selected sentence"));
        assert_eq!(clip.now().as_deref(), Some("PRIOR"), "clipboard must survive");
    }

    // Without the sentinel this case is indistinguishable from a failed copy.
    #[test]
    fn detects_a_selection_identical_to_the_clipboard() {
        let clip = FakeClipboard::new(Some("same text"), Some("same text"));
        let got = capture_via_copy(&clip, &mut copier(&clip), 5, NOOP, NOOP);
        assert_eq!(got.as_deref(), Some("same text"));
        assert_eq!(clip.now().as_deref(), Some("same text"));
    }

    #[test]
    fn nothing_selected_yields_none_and_still_restores() {
        let clip = FakeClipboard::new(Some("PRIOR"), None); // copy does nothing
        let got = capture_via_copy(&clip, &mut copier(&clip), 3, NOOP, NOOP);
        assert_eq!(got, None);
        assert_eq!(clip.now().as_deref(), Some("PRIOR"));
    }

    #[test]
    fn a_failed_copy_restores_the_clipboard() {
        let clip = FakeClipboard::new(Some("PRIOR"), Some("unused"));
        let got = capture_via_copy(&clip, &mut || false, 3, NOOP, NOOP);
        assert_eq!(got, None);
        assert_eq!(clip.now().as_deref(), Some("PRIOR"));
    }

    // The sentinel is our own marker; leaking it into the user's clipboard
    // would be worse than failing to capture.
    #[test]
    fn never_leaves_the_sentinel_behind() {
        for copies in [None, Some("something")] {
            let clip = FakeClipboard::new(None, copies);
            let _ = capture_via_copy(&clip, &mut copier(&clip), 3, NOOP, NOOP);
            assert_ne!(clip.now().as_deref(), Some(SENTINEL));
            assert!(!clip.writes.borrow().last().unwrap().contains("chirp-capture"));
        }
    }

    #[test]
    fn whitespace_only_selection_counts_as_nothing() {
        let clip = FakeClipboard::new(Some("PRIOR"), Some("   \n  "));
        let got = capture_via_copy(&clip, &mut copier(&clip), 3, NOOP, NOOP);
        assert_eq!(got, None);
        assert_eq!(clip.now().as_deref(), Some("PRIOR"));
    }

    #[test]
    fn an_unwritable_clipboard_bails_without_pressing_keys() {
        let mut clip = FakeClipboard::new(Some("PRIOR"), Some("sel"));
        clip.writable = false;
        let mut pressed = false;
        let got = capture_via_copy(
            &clip,
            &mut || {
                pressed = true;
                true
            },
            3,
            NOOP,
            NOOP,
        );
        assert_eq!(got, None);
        assert!(!pressed, "must not synthesise a copy it cannot undo");
    }
}
