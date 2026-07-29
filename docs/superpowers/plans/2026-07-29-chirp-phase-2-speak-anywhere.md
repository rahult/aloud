# Chirp Phase 2 — Speak Anything, Anywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chirp speak the text you have selected in any application, controlled from the menu bar, without ever touching your clipboard.

**Architecture:** Phase 1 made the Node server the single owner of playback. Phase 2 adds a second channel in the other direction: the desktop app holds an SSE connection to the server, so the tray reflects playback live, and the web UI can ask the native layer to do things it cannot do itself (request Accessibility permission, open System Settings) by posting a command the server relays over that same feed. Selection capture and the platform integrations hang off this.

**Tech Stack:** Tauri v2 / Rust, `enigo` 0.6, `macos-accessibility-client` 0.0.2, `objc2` 0.6 / `objc2-media-player` 0.3, `ureq` 3, Node ≥ 20.11, `node --test`.

## Global Constraints

- **No new Node runtime dependencies.** `kokoro-js` stays the only entry in `dependencies`.
- **macOS-only crates stay target-gated** under `[target.'cfg(target_os = "macos")'.dependencies]` in `src-tauri/Cargo.toml`. The release workflow builds Windows and Linux too.
- **No Tauri IPC from the web UI.** The window loads `http://127.0.0.1:<port>`, a remote origin from Tauri's perspective. All UI→native communication goes UI → server → SSE → Rust. Do not add `remote` capability URLs.
- **Server binds `127.0.0.1` only.**
- **Visual design unchanged** — palette and type per `.impeccable.md`.
- **`npm test` must keep passing without the model or an audio device.**
- **Commit after every task.**

## Verified API signatures

These compiled in a spike on this exact dependency set. Use them as written.

```rust
// enigo 0.6
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
let mut enigo = Enigo::new(&Settings::default())?;
enigo.key(Key::Meta, Direction::Press)?;
enigo.key(Key::Unicode('c'), Direction::Click)?;
enigo.key(Key::Meta, Direction::Release)?;

// macos-accessibility-client 0.0.2
use macos_accessibility_client::accessibility;
accessibility::application_is_trusted();              // silent check
accessibility::application_is_trusted_with_prompt();  // shows the system prompt

// Tauri v2 dynamic menu
use tauri::menu::{CheckMenuItemBuilder, MenuItemBuilder, SubmenuBuilder};
let play = MenuItemBuilder::with_id("play", "Play").build(app)?;
play.set_text("Pause")?;  play.set_enabled(false)?;
let v = CheckMenuItemBuilder::with_id("voice:af_heart", "Heart").checked(true).build(app)?;
v.set_checked(false)?;
let sub = SubmenuBuilder::new(app, "Voice").item(&v).build()?;

// ureq 3 streaming (SSE)
use std::io::BufRead;
let res = ureq::get(url).call()?;
let reader = std::io::BufReader::new(res.into_body().into_reader());
for line in reader.lines() { /* line.strip_prefix("data: ") */ }

// objc2-media-player 0.3
use objc2_media_player::{MPNowPlayingInfoCenter, MPNowPlayingPlaybackState, MPRemoteCommandCenter,
                         MPMediaItemPropertyTitle, MPMediaItemPropertyArtist};
let center = MPNowPlayingInfoCenter::defaultCenter();
center.setNowPlayingInfo(Some(&info));
center.setPlaybackState(MPNowPlayingPlaybackState::Playing);
let commands = MPRemoteCommandCenter::sharedCommandCenter();
commands.playCommand().setEnabled(true);

// objc2 0.6 service provider — note AllocAnyThread must be in scope for alloc()
use objc2::{define_class, msg_send, AllocAnyThread};
```

---

### Task 1: Server-side command channel and input setting

Everything native in this plan needs two things from the server: a way for the
web UI to ask the native layer to act, and a persisted choice of what the
hotkey reads. Both land here, in JavaScript, with tests.

**Files:**
- Modify: `src/config.mjs`, `test/config.test.mjs`
- Modify: `src/routes.mjs`, `test/routes.test.mjs`

**Interfaces:**
- Consumes: Phase 1 modules
- Produces:
  - config key `input`: `'selection' | 'clipboard'`, default `'selection'`
  - config key `nowPlaying`: boolean, default `true`
  - `POST /api/app-command {name}` → relays `event: command` on the SSE feed
  - `GET /api/settings` gains `input`, `nowPlaying`, `accessibilityOk`
  - `POST /api/native-status {accessibilityOk?, hotkeyOk?}` — the app reports capability

- [ ] **Step 1: Write the failing config test**

Append to `test/config.test.mjs`:

```js
test('input selects what the hotkey reads, defaulting to the selection', () => {
  assert.equal(DEFAULTS.input, 'selection');
  assert.equal(ok(applyPatch({}, {input: 'clipboard'})).input, 'clipboard');
  assert.equal(ok(applyPatch({}, {input: 'selection'})).input, 'selection');
  assert.match(applyPatch({}, {input: 'telepathy'}).error, /selection.*clipboard/);
  assert.deepEqual(ok(applyPatch({input: 'clipboard'}, {input: ''})), {});
});

test('nowPlaying is a boolean that defaults on', () => {
  assert.equal(DEFAULTS.nowPlaying, true);
  assert.equal(ok(applyPatch({}, {nowPlaying: false})).nowPlaying, false);
  assert.deepEqual(ok(applyPatch({nowPlaying: false}, {nowPlaying: ''})), {});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `DEFAULTS.input` is undefined

- [ ] **Step 3: Implement the config keys**

In `src/config.mjs`, extend `DEFAULTS`:

```js
export const DEFAULTS = Object.freeze({
  port: 8789,
  hotkey: 'CmdOrCtrl+Shift+Space',
  voice: 'af_heart',
  speed: 1,
  input: 'selection',
  nowPlaying: true,
});
```

And in `applyPatch`, before the `telemetry` block:

```js
  if ('input' in patch) {
    if (blank(patch.input)) delete next.input;
    else if (patch.input !== 'selection' && patch.input !== 'clipboard')
      return {error: 'Input must be "selection" or "clipboard".'};
    else next.input = patch.input;
  }

  if ('nowPlaying' in patch) {
    if (blank(patch.nowPlaying)) delete next.nowPlaying;
    else next.nowPlaying = Boolean(patch.nowPlaying);
  }
```

- [ ] **Step 4: Write the failing routes test**

Append to `test/routes.test.mjs`:

```js
test('app-command relays to the SSE feed for the native layer', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/playback/events`);
  const reader = res.body.getReader();
  await reader.read();                                  // opening frames

  const posted = await call(port, 'POST', '/api/app-command', {name: 'request-accessibility'});
  assert.equal(posted.status, 200);

  let seen = '';
  for (let i = 0; i < 4 && !seen.includes('event: command'); i++)
    seen += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  assert.match(seen, /event: command/);
  assert.match(seen, /request-accessibility/);
  await reader.cancel();
});

test('app-command rejects an unknown command', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {status} = await call(port, 'POST', '/api/app-command', {name: 'rm -rf /'});
  assert.equal(status, 400);
});

test('native-status is reported back through settings', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  assert.equal((await call(port, 'GET', '/api/settings')).body.accessibilityOk, null);
  await call(port, 'POST', '/api/native-status', {accessibilityOk: false});
  assert.equal((await call(port, 'GET', '/api/settings')).body.accessibilityOk, false);
  await call(port, 'POST', '/api/native-status', {accessibilityOk: true});
  assert.equal((await call(port, 'GET', '/api/settings')).body.accessibilityOk, true);
});

test('settings expose the input mode', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  assert.equal((await call(port, 'GET', '/api/settings')).body.input, 'selection');
  await call(port, 'POST', '/api/settings', {input: 'clipboard'});
  assert.equal((await call(port, 'GET', '/api/settings')).body.input, 'clipboard');
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `node --test test/routes.test.mjs`
Expected: FAIL — `/api/app-command` 404s

- [ ] **Step 6: Implement the command channel**

In `src/routes.mjs`, after the `hotkeyOk` declaration:

```js
  let accessibilityOk = null;

  // Commands the web UI may ask the desktop app to perform. An allowlist,
  // because this is a local HTTP surface with CORS wide open — any page in
  // the browser can post here.
  const APP_COMMANDS = new Set(['request-accessibility', 'open-accessibility-settings']);
```

Add the routes, next to `/api/hotkey-status`:

```js
    // UI → server → SSE → desktop app. The window loads a remote origin, so
    // Tauri IPC is not available to it; the event feed is the way back.
    if (POST && p === '/api/app-command') {
      return readBody(req).then(body => {
        if (!APP_COMMANDS.has(body.name))
          return send(res, 400, {error: `Unknown command: ${body.name}`});
        push('command', {name: body.name});
        send(res, 200, {ok: true});
      }).catch(e => send(res, 400, {error: e.message}));
    }

    if (POST && p === '/api/native-status') {
      return readBody(req).then(body => {
        if ('accessibilityOk' in body) accessibilityOk = Boolean(body.accessibilityOk);
        if ('hotkeyOk' in body) hotkeyOk = Boolean(body.hotkeyOk);
        send(res, 200, {ok: true});
      }).catch(e => send(res, 400, {error: e.message}));
    }
```

And add `accessibilityOk` to the `GET /api/settings` response object.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — Phase 1's 75 plus the 6 new ones

- [ ] **Step 8: Commit**

```bash
git add src/config.mjs src/routes.mjs test/
git commit -m "Add app-command channel and input-mode setting"
```

---

### Task 2: The Rust SSE listener

The desktop app's nervous system: one thread holding the event feed open,
dispatching to whatever cares. Tasks 3, 4, 5 and 7 all hang off it. Built
first and alone so a reconnect bug does not get blamed on the tray.

**Files:**
- Create: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `GET /api/playback/events` (Phase 1), `POST /api/native-status` (Task 1)
- Produces:
  - `events::PlaybackState { state: String, index: usize, count: usize, voice: String, speed: f64 }`
  - `events::listen(app: tauri::AppHandle, on_event: impl Fn(&tauri::AppHandle, Event) + Send + 'static)`
  - `events::Event { Playback(PlaybackState), Command(String), Sentences(Vec<String>) }`

- [ ] **Step 1: Write the listener**

Create `src-tauri/src/events.rs`:

```rust
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

fn pump<F>(app: &tauri::AppHandle, base_url: &str, on_event: &F) -> Result<(), Box<dyn std::error::Error>>
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
            match event.as_str() {
                "state" => {
                    if let Ok(s) = serde_json::from_str::<PlaybackState>(payload) {
                        on_event(app, Event::Playback(s));
                    }
                }
                "sentences" => {
                    if let Ok(f) = serde_json::from_str::<SentencesFrame>(payload) {
                        on_event(app, Event::Sentences(f.sentences));
                    }
                }
                "command" => {
                    if let Ok(f) = serde_json::from_str::<CommandFrame>(payload) {
                        on_event(app, Event::Command(f.name));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 2: Wire it in and prove it receives**

In `lib.rs`, add `mod events;` at the top. In `setup`, after `wait_for_server()`:

```rust
            events::listen(app.handle().clone(), base_url(), |_app, event| {
                eprintln!("chirp: event {event:?}");
            });
```

- [ ] **Step 3: Compile**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 4: Verify it receives real events**

Terminal A: `npm start`
Terminal B: `cd src-tauri && cargo run 2>&1 | grep "chirp: event"`
Terminal C: `curl -s -XPOST localhost:8789/api/speak -H 'content-type: application/json' -d '{"text":"One. Two."}'`

Terminal B must print `Playback(PlaybackState { state: "speaking", ... })` frames with `index` advancing, then `state: "idle"`. Quit with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/events.rs src-tauri/src/lib.rs
git commit -m "Add the SSE event listener the native integrations hang off"
```

---

### Task 3: Capture the selection instead of the clipboard

The flagship. Select text in any app, press the hotkey, hear it — and find
your clipboard exactly as you left it.

**Files:**
- Create: `src-tauri/src/selection.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `enigo`, `tauri_plugin_clipboard_manager::ClipboardExt`, config `input` (Task 1)
- Produces: `selection::capture(app: &tauri::AppHandle, mode: &str) -> Option<String>`

- [ ] **Step 1: Write the capture module**

Create `src-tauri/src/selection.rs`:

```rust
// Reading the selection without destroying the clipboard.
//
// There is no portable "give me the selected text" call. The reliable trick
// is to copy it and put back what was there: save the clipboard, synthesise
// the platform's copy chord, wait for the clipboard to actually change, take
// the value, and restore the original.
//
// On X11 the PRIMARY selection holds the highlighted text already, so no
// keystroke is needed and the clipboard is never touched at all.

use tauri_plugin_clipboard_manager::ClipboardExt;

// How long to wait for the target app to service the copy. Slower apps
// (Electron, remote desktops) need more than a couple of frames; beyond this
// the user would rather it failed than hung.
const COPY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);
const POLL: std::time::Duration = std::time::Duration::from_millis(20);
// Give the target app a moment to see its own paste before we put the old
// clipboard back, or fast apps read the restored value instead.
const RESTORE_DELAY: std::time::Duration = std::time::Duration::from_millis(120);

pub fn capture(app: &tauri::AppHandle, mode: &str) -> Option<String> {
    let text = match mode {
        "clipboard" => app.clipboard().read_text().ok(),
        _ => capture_selection(app).or_else(|| app.clipboard().read_text().ok()),
    };
    let text = text?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(target_os = "linux")]
fn capture_selection(_app: &tauri::AppHandle) -> Option<String> {
    // PRIMARY is the selection on X11/Wayland — reading it is free of side
    // effects, so there is nothing to save or restore.
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
fn capture_selection(app: &tauri::AppHandle) -> Option<String> {
    let saved = app.clipboard().read_text().ok();

    // A sentinel makes "the copy did nothing" distinguishable from "the
    // selection happens to equal the clipboard" — without it, copying the
    // same text twice looks like a failure.
    let sentinel = "\u{0}chirp-capture\u{0}";
    let _ = app.clipboard().write_text(sentinel.to_string());

    if let Err(e) = send_copy() {
        eprintln!("chirp: could not synthesise copy: {e}");
        restore(app, saved);
        return None;
    }

    let deadline = std::time::Instant::now() + COPY_TIMEOUT;
    let mut captured = None;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(POLL);
        if let Ok(now) = app.clipboard().read_text() {
            if now != sentinel {
                captured = Some(now);
                break;
            }
        }
    }

    std::thread::sleep(RESTORE_DELAY);
    restore(app, saved);
    captured.filter(|s| !s.trim().is_empty())
}

#[cfg(not(target_os = "linux"))]
fn restore(app: &tauri::AppHandle, saved: Option<String>) {
    match saved {
        Some(prev) => {
            let _ = app.clipboard().write_text(prev);
        }
        // Nothing was there before; leave the sentinel out of the clipboard.
        None => {
            let _ = app.clipboard().write_text(String::new());
        }
    }
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
    let result = enigo.key(Key::Unicode('c'), Direction::Click);
    // Release the modifier even if the keypress failed, or the user is left
    // with a stuck Cmd key.
    enigo.key(modifier, Direction::Release)?;
    result?;
    Ok(())
}
```

- [ ] **Step 2: Read the input mode from config**

In `lib.rs`, alongside `configured_hotkey`:

```rust
fn configured_input(path: Option<&Path>) -> String {
    path.and_then(|p| config_value(p, "input"))
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| s == "clipboard" || s == "selection")
        .unwrap_or_else(|| "selection".to_string())
}
```

- [ ] **Step 3: Use it in the hotkey**

In `toggle_speak`, replace the clipboard read:

```rust
        let mode = app
            .path()
            .home_dir()
            .ok()
            .map(|h| h.join(".chirp").join("config.json"))
            .as_deref()
            .map(|p| configured_input(Some(p)))
            .unwrap_or_else(|| "selection".to_string());

        let Some(text) = selection::capture(&app, &mode) else {
            eprintln!("chirp: nothing selected and nothing on the clipboard");
            return;
        };
```

removing the old `app.clipboard().read_text()` block. Add `mod selection;` and
`use tauri::Manager;` if not already present.

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 5: Verify by hand — this needs Accessibility permission**

Synthetic keystrokes require Accessibility on macOS, and a **dev build gets a
new binary each rebuild**, so the grant is per-binary and will need redoing.
Grant it to the `cargo run` binary when prompted.

Run: `npm start` in one terminal, `npm run tauri dev` in another. Then:

1. Copy the word `SENTINEL` to your clipboard.
2. Select a sentence in **TextEdit**. Press the hotkey → it speaks the
   selection.
3. Paste somewhere → you get `SENTINEL`, not the sentence. **The clipboard
   survived.** This is the whole point of the task.
4. Repeat in **Chrome**, **VS Code**, and **Slack** — these are the apps most
   likely to be slow to service the synthetic copy.
5. Select nothing and press the hotkey → it falls back to the clipboard and
   speaks `SENTINEL`.
6. Set Input to Clipboard in Settings (Task 4 adds the control; until then
   edit `~/.chirp/config.json` to `"input": "clipboard"`) → the hotkey reads
   the clipboard and never synthesises a keystroke.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/selection.rs src-tauri/src/lib.rs
git commit -m "Speak the selection without clobbering the clipboard"
```

---

### Task 4: Accessibility permission and its onboarding

Without the grant, Task 3 silently does nothing — the worst possible failure
for a hotkey. This makes the state visible and gives the user one button.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `ui/index.html`, `ui/app.js`

**Interfaces:**
- Consumes: `events::Event::Command` (Task 2), `POST /api/native-status` (Task 1)
- Produces: nothing consumed later

- [ ] **Step 1: Report and act on permission from Rust**

In `lib.rs`:

```rust
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
```

Replace the placeholder handler from Task 2 Step 2 with:

```rust
Write this as a `match` on the event, not an `if let` — Tasks 5 and 7 add
further arms to this same handler.

```rust
            events::listen(app.handle().clone(), base_url(), |_app, event| match event {
                events::Event::Command(name) => {
                    match name.as_str() {
                        "request-accessibility" => {
                            #[cfg(target_os = "macos")]
                            {
                                // Shows the system prompt with the "Open
                                // System Settings" button.
                                let ok = macos_accessibility_client::accessibility::
                                    application_is_trusted_with_prompt();
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
                _ => {}
            });

            report_native_status(accessibility_ok());
            // The grant can be given while we run, so re-check periodically
            // rather than making the user restart the app.
            {
                let mut last = accessibility_ok();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let now = accessibility_ok();
                    if now != last {
                        last = now;
                        report_native_status(now);
                    }
                });
            }
```

- [ ] **Step 2: Compile**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 3: Add the Settings controls**

In `ui/index.html`, inside `.panel`, after the Hotkey row:

```html
   <div class="setting">
    <label for="input">Hotkey reads</label>
    <select id="input" class="text">
     <option value="selection">Selected text</option>
     <option value="clipboard">Clipboard</option>
    </select>
    <span class="note" id="inputNote"></span>
   </div>
   <div class="setting" id="accessRow" hidden>
    <label>Access</label>
    <span class="smsg" id="accessMsg">Chirp needs Accessibility permission to read the selection.</span>
    <button class="notebtn" id="accessBtn">Grant…</button>
   </div>
```

- [ ] **Step 4: Wire the controls in ui/app.js**

In the `/api/settings` handler, after the voice line:

```js
  $('input').value=s.input||'selection';
  applyAccess(s);
```

And near the other listeners:

```js
 // Reading the selection needs Accessibility on macOS. Without it the hotkey
 // silently does nothing, so say so plainly and offer the one button.
 function applyAccess(s){
  var needs=($('input').value==='selection')&&s.accessibilityOk===false;
  $('accessRow').hidden=!needs;
  $('inputNote').textContent=needs?'needs permission':'';
 }
 $('input').addEventListener('change',function(){
  post('/api/settings',{input:$('input').value})
   .then(function(s){applyAccess(s);flash('Saved.')})
   .catch(function(e){flash(e.message,true)});
 });
 $('accessBtn').addEventListener('click',function(){
  post('/api/app-command',{name:'request-accessibility'})
   .then(function(){flash('Approve Chirp in System Settings, then come back.')})
   .catch(function(e){flash(e.message,true)});
 });
 es.addEventListener('state',function(){});   // no-op guard; state is handled above
```

Also re-fetch settings when the feed reconnects so the row disappears the
moment permission is granted:

```js
 setInterval(function(){
  fetch('/api/settings').then(function(r){return r.json()}).then(applyAccess);
 },3000);
```

- [ ] **Step 5: Verify by hand**

1. `npm start` + `npm run tauri dev`, open Settings.
2. With Accessibility **not** granted for the dev binary, the Access row shows
   and "Hotkey reads" says `needs permission`.
3. Click **Grant…** → the macOS prompt appears.
4. Approve it in System Settings → within ~3 s the row disappears by itself.
5. Switch Input to Clipboard → the row hides regardless of permission, because
   the clipboard path needs none.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs ui/
git commit -m "Surface and request Accessibility permission"
```

---

### Task 5: Tray playback controls

Turns the menu bar icon from a launcher into a transport.

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `events::Event::Playback` (Task 2), `GET /api/voices`, `POST /api/playback/*`
- Produces: `tray::build(app) -> tauri::Result<tray::Handles>`, `tray::apply(&Handles, &PlaybackState)`

- [ ] **Step 1: Build the menu**

Create `src-tauri/src/tray.rs`:

```rust
// The tray is a view of the server's session, not a second copy of it: every
// item posts a command and every label comes back from the event feed.

use crate::events::PlaybackState;
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder,
                  PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

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
    let play = MenuItemBuilder::with_id("pb:play", "Play").enabled(false).build(app)?;
    let prev = MenuItemBuilder::with_id("pb:prev", "Previous").enabled(false).build(app)?;
    let next = MenuItemBuilder::with_id("pb:next", "Next").enabled(false).build(app)?;
    let stop = MenuItemBuilder::with_id("pb:stop", "Stop").enabled(false).build(app)?;

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
        let item = CheckMenuItemBuilder::with_id(format!("speed:{s}"), format!("{s}x")).build(app)?;
        speed_menu = speed_menu.item(&item);
        speeds.push((s, item));
    }

    let show = MenuItemBuilder::with_id("show", "Show Chirp").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…").build(app)?;
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

    Ok(Handles { play, prev, next, stop, voices, speeds })
}

pub fn apply(h: &Handles, s: &PlaybackState) {
    let speaking = s.state == "speaking";
    let active = speaking || s.state == "paused";

    let _ = h.play.set_text(if speaking { "Pause" } else if active { "Resume" } else { "Play" });
    let _ = h.play.set_enabled(active);
    let _ = h.prev.set_enabled(active && s.index > 0);
    let _ = h.next.set_enabled(active && s.index + 1 < s.count);
    let _ = h.stop.set_enabled(active);

    for (id, item) in &h.voices {
        let _ = item.set_checked(*id == s.voice);
    }
    for (value, item) in &h.speeds {
        let _ = item.set_checked((*value - s.speed).abs() < f64::EPSILON);
    }
}
```

- [ ] **Step 2: Route the menu events**

In `lib.rs`, replace the existing `TrayIconBuilder` block with `tray::build(...)`,
store the handles with `app.manage(...)`, and add:

```rust
fn post(path: String, body: serde_json::Value) {
    std::thread::spawn(move || {
        let _ = ureq::post(format!("{}{}", base_url(), path)).send_json(body);
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
        "pb:play" => post("/api/playback/toggle-pause".into(), serde_json::json!({})),
        "pb:prev" => post("/api/playback/prev".into(), serde_json::json!({})),
        "pb:next" => post("/api/playback/next".into(), serde_json::json!({})),
        "pb:stop" => post("/api/playback/stop".into(), serde_json::json!({})),
        _ => {
            if let Some(v) = id.strip_prefix("voice:") {
                post("/api/settings".into(), serde_json::json!({"voice": v}));
            } else if let Some(s) = id.strip_prefix("speed:") {
                if let Ok(n) = s.parse::<f64>() {
                    post("/api/settings".into(), serde_json::json!({"speed": n}));
                }
            }
        }
    }
}
```

- [ ] **Step 3: Add the pause/resume toggle the tray button needs**

The tray's Play button means "pause if speaking, resume if paused" — distinct
from the hotkey's stop-or-speak `toggle`. Add to `src/playback.mjs`:

```js
  // The tray's play/pause button: never starts a new session, only suspends
  // and resumes the current one.
  function togglePause() {
    if (state === 'speaking') { pause(); return 'paused'; }
    if (state === 'paused') { resume(); return 'resumed'; }
    return 'idle';
  }
```

Export it, and add to the `TRANSPORT` map in `src/routes.mjs`:
`'toggle-pause': 'togglePause'`.

Add to `test/playback.test.mjs`:

```js
test('togglePause suspends and resumes but never starts a session', async () => {
  const {session} = build();
  assert.equal(session.togglePause(), 'idle', 'nothing to pause when idle');
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(session.togglePause(), 'paused');
  assert.equal(session.getState().state, 'paused');
  assert.equal(session.togglePause(), 'resumed');
  assert.equal(session.getState().state, 'speaking');
});
```

- [ ] **Step 4: Drive the labels from the feed**

In the `events::listen` handler in `lib.rs`, add a `Playback` arm:

```rust
                    events::Event::Playback(state) => {
                        if let Some(h) = app.try_state::<tray::Handles>() {
                            tray::apply(&h, &state);
                        }
                    }
```

`Handles` must be `Send + Sync` to be managed; if the compiler objects, wrap
it in a `Mutex` and lock inside the arm.

- [ ] **Step 5: Test and compile**

Run: `npm test` — the new `togglePause` test must pass.
Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 6: Verify by hand**

`npm start` + `npm run tauri dev`, then:

1. Idle: Play/Previous/Next/Stop are all greyed out.
2. Speak something long → Play becomes **Pause**, Stop enables, Next enables.
3. Click Pause → label becomes **Resume**, audio stops. Click it → resumes.
4. Click Next repeatedly → at the last sentence Next greys out.
5. Voice submenu: the current voice is ticked; pick another → the tick moves
   and the current sentence re-speaks in it.
6. Speed submenu behaves the same.
7. Open the web UI too — it and the tray agree at all times.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/lib.rs src/playback.mjs src/routes.mjs test/
git commit -m "Tray becomes a transport for the playback session"
```

---

### Task 6: macOS Services entry

"Speak with Chirp" in every app's Services menu — reaching apps no hotkey
can, with no combination to configure.

**Files:**
- Create: `src-tauri/Info.plist`
- Create: `src-tauri/src/services.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `POST /api/speak`
- Produces: `services::register(app: &tauri::AppHandle)`

- [ ] **Step 1: Declare the service**

Create `src-tauri/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict><key>default</key><string>Speak with Chirp</string></dict>
      <key>NSMessage</key>
      <string>speakWithChirp</string>
      <key>NSPortName</key>
      <string>Chirp</string>
      <key>NSSendTypes</key>
      <array><string>NSStringPboardType</string></array>
    </dict>
  </array>
</dict>
</plist>
```

- [ ] **Step 2: Confirm Tauri merges it — do this before writing more code**

Run: `npm run tauri build -- --bundles app`
Run: `plutil -extract NSServices xml1 -o - "src-tauri/target/release/bundle/macos/Chirp.app/Contents/Info.plist"`

Expected: the array above.

**If the key is absent, Tauri is not merging `Info.plist`.** Stop and report
it rather than working around it; the fallback (a post-build script patching
the bundle) defeats the purpose and would silently break the updater's
signature. Task 7 does not depend on this task.

- [ ] **Step 3: Register the provider**

Create `src-tauri/src/services.rs`:

```rust
// The Services menu reaches apps a global hotkey cannot, and needs no
// combination to configure. macOS hands us the pasteboard directly, so
// unlike the hotkey path there is no clipboard to protect.

#![cfg(target_os = "macos")]

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_app_kit::{NSApplication, NSPasteboard, NSPasteboardTypeString};
use objc2_foundation::{MainThreadMarker, NSArray, NSObject, NSObjectProtocol, NSString};

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ChirpServiceProvider"]
    pub struct ServiceProvider;

    unsafe impl NSObjectProtocol for ServiceProvider {}

    impl ServiceProvider {
        // Signature is fixed by NSServices: the NSMessage value with
        // ":userData:error:" appended.
        #[unsafe(method(speakWithChirp:userData:error:))]
        fn speak_with_chirp(
            &self,
            pboard: &NSPasteboard,
            _user_data: *mut NSString,
            _error: *mut *mut NSString,
        ) {
            let text = unsafe { pboard.stringForType(NSPasteboardTypeString) };
            let Some(text) = text else { return };
            let text = text.to_string();
            if text.trim().is_empty() {
                return;
            }
            std::thread::spawn(move || {
                let _ = ureq::post(format!("{}/api/speak", crate::base_url()))
                    .send_json(serde_json::json!({"text": text}));
            });
        }
    }
);

pub fn register() {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("chirp: services must be registered on the main thread");
        return;
    };
    let provider: Retained<ServiceProvider> = unsafe { msg_send![ServiceProvider::alloc(), init] };
    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        app.setServicesProvider(Some(&*provider as &AnyObject));
        NSApplication::registerServicesMenuSendTypes_returnTypes(
            &app,
            &NSArray::from_slice(&[NSPasteboardTypeString]),
            &NSArray::new(),
        );
    }
    // Leak the provider: macOS holds only a weak reference to the services
    // provider, and it must outlive this function for the app's lifetime.
    std::mem::forget(provider);
}
```

In `lib.rs`, add `#[cfg(target_os = "macos")] mod services;` and call
`services::register();` at the end of `setup`. Make `base_url` `pub(crate)`.

- [ ] **Step 4: Compile and build**

Run: `cd src-tauri && cargo check`
Run: `npm run tauri build -- --bundles app`

- [ ] **Step 5: Verify by hand**

Services are discovered from installed apps, so the dev binary will not do:

1. `cp -r src-tauri/target/release/bundle/macos/Chirp.app /Applications/ChirpTest.app`
2. `/System/Library/CoreServices/pbs -flush` then open `/Applications/ChirpTest.app`
3. In TextEdit, select a sentence → menu **TextEdit ▸ Services** → look for
   **Speak with Chirp**. Click it; the text should be spoken.
4. If the item never appears after a flush and a re-login, record the finding
   and move on — this is the item flagged as possibly unreachable. Remove
   `/Applications/ChirpTest.app` afterwards.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Info.plist src-tauri/src/services.rs src-tauri/src/lib.rs
git commit -m "Add a 'Speak with Chirp' Services menu entry"
```

---

### Task 7: Now Playing and media keys

**Read this before starting.** macOS attributes Now Playing to the process
that owns the audio session. Chirp's audio comes from `afplay`, a *separate
process* the Node server spawns, so the system may bind the media keys to
`afplay` rather than to Chirp. Wiring this up correctly is not sufficient for
it to work. Build it, verify empirically at Step 4, and if it does not bind,
**stop and report** — do not restructure playback to chase it. Moving audio
in-process is a Phase 3 decision with its own trade-offs.

**Files:**
- Create: `src-tauri/src/nowplaying.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `events::Event::{Playback, Sentences}` (Task 2), config `nowPlaying` (Task 1)
- Produces: `nowplaying::update(state: &PlaybackState, title: Option<&str>)`, `nowplaying::install_handlers()`

- [ ] **Step 1: Write the module**

Create `src-tauri/src/nowplaying.rs`:

```rust
#![cfg(target_os = "macos")]

// Puts Chirp in the Now Playing widget so headphone and keyboard media keys
// control it. Whether the system actually routes those keys here depends on
// which process owns the audio session — see the note in the plan.

use crate::events::PlaybackState;
use objc2_foundation::{NSDictionary, NSString};
use objc2_media_player::{
    MPMediaItemPropertyArtist, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingPlaybackState, MPRemoteCommandCenter,
};

pub fn update(state: &PlaybackState, title: Option<&str>) {
    unsafe {
        let center = MPNowPlayingInfoCenter::defaultCenter();
        let heading = title.unwrap_or("Chirp");
        let subtitle = if state.count > 0 {
            format!("{} — sentence {} of {}", state.voice, state.index + 1, state.count)
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
    use objc2_media_player::MPRemoteCommandHandlerStatus;

    unsafe {
        let commands = MPRemoteCommandCenter::sharedCommandCenter();

        let route = |path: &'static str| {
            RcBlock::new(move |_event: *mut objc2::runtime::AnyObject| {
                let _ = ureq::post(format!("{}{}", crate::base_url(), path)).send_empty();
                MPRemoteCommandHandlerStatus::Success
            })
        };

        let play = commands.playCommand();
        play.setEnabled(true);
        play.addTargetWithHandler(&route("/api/playback/resume"));

        let pause = commands.pauseCommand();
        pause.setEnabled(true);
        pause.addTargetWithHandler(&route("/api/playback/pause"));

        let toggle = commands.togglePlayPauseCommand();
        toggle.setEnabled(true);
        toggle.addTargetWithHandler(&route("/api/playback/toggle-pause"));

        let next = commands.nextTrackCommand();
        next.setEnabled(true);
        next.addTargetWithHandler(&route("/api/playback/next"));

        let prev = commands.previousTrackCommand();
        prev.setEnabled(true);
        prev.addTargetWithHandler(&route("/api/playback/prev"));
    }
}
```

- [ ] **Step 2: Feed it from the event listener**

In `lib.rs`, keep the first sentence of the current session so the widget has
a real title:

```rust
static CURRENT_TITLE: Mutex<Option<String>> = Mutex::new(None);
```

In the `events::listen` handler, add to the `Sentences` arm:

```rust
                    events::Event::Sentences(sentences) => {
                        *CURRENT_TITLE.lock().unwrap() = sentences.first().cloned();
                    }
```

and to the `Playback` arm, after `tray::apply`:

```rust
                        #[cfg(target_os = "macos")]
                        {
                            let title = CURRENT_TITLE.lock().unwrap().clone();
                            nowplaying::update(&state, title.as_deref());
                        }
```

Call `nowplaying::install_handlers();` once in `setup`, gated on the
`nowPlaying` config value being true.

`nowplaying.rs` calls `crate::base_url()`, so that function must be
`pub(crate)`. Task 6 also makes this change; if Task 6 was skipped or failed
verification, make it here.

- [ ] **Step 3: Compile**

Run: `cd src-tauri && cargo check`
Expected: no errors. If `addTargetWithHandler` rejects the block's argument
type, print the expected signature with `cargo check --message-format=short`
and match it exactly — do not add a dependency to work around it.

- [ ] **Step 4: Verify — and accept a negative result**

Run `npm start` + `npm run tauri dev`, speak something long, then:

1. Open Control Centre → is there a Now Playing tile showing **Chirp** and the
   sentence count?
2. Press the keyboard's play/pause key → does playback pause?
3. Pause from AirPods → same question.

**If the tile shows `afplay` or nothing, record exactly what appeared and
stop.** That is the predicted failure and it is information, not a defect to
grind against. Note it in the commit message and in the plan's outcome
section.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/nowplaying.rs src-tauri/src/lib.rs
git commit -m "Add Now Playing and media-key control"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the desktop app section**

Describe: the hotkey speaks the **selection** by default and leaves the
clipboard untouched, falling back to the clipboard when nothing is selected;
the Input setting switches between them; macOS needs Accessibility permission
and Settings offers a Grant button; the tray now has transport controls with
voice and speed submenus. Mention the Services entry and Now Playing **only
if Tasks 6 and 7 verified successfully** — describing a feature that did not
bind would be worse than omitting it.

- [ ] **Step 2: Record what did not work**

Add a short "Known limitations" list covering any of Tasks 6 or 7 that failed
verification, with the observed behaviour. Future readers need the negative
result as much as the positive ones.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document selection capture, tray controls, and platform integrations"
```

---

## Verification against the spec

- [ ] Selecting text in Chrome, VS Code, Notes, and Slack and pressing the hotkey speaks it, **and the clipboard afterwards holds what it held before** (Task 3 Step 5).
- [ ] With Accessibility denied, Settings says so and offers a working Grant button (Task 4 Step 5).
- [ ] Tray transport controls reflect and drive playback; the tray and web UI never disagree (Task 5 Step 6).
- [ ] `npm test` still passes without the model or an audio device.
- [ ] `cargo check` is clean, and the macOS-only crates stay behind the target gate so Windows and Linux still build.

## Risks

| Risk | Handling |
|---|---|
| Now Playing binds to `afplay`, not Chirp | Predicted. Task 7 Step 4 accepts a negative result and stops. |
| Tauri may not merge `src-tauri/Info.plist` | Task 6 Step 2 checks this first and stops if absent, before any provider code is written. |
| Accessibility grant is per-binary and resets on every dev rebuild | Expected during development; grant it again when prompted. Only signed release builds keep it. |
| Synthetic copy is slow or blocked in some apps | 400 ms timeout with a sentinel, then fall back to the clipboard. Tested against the four apps most likely to be slow. |
| A stuck modifier key if the synthetic keypress fails | `send_copy` releases the modifier before propagating the error. |
