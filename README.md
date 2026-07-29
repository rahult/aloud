# Chirp

Local neural text-to-speech as a tiny HTTP service. Runs the
[Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) model
fully on-device — no text or audio ever leaves the machine, no API keys, no
accounts.

Born as the narration engine inside [Margin](https://github.com/rahult/margin),
extracted so anything can speak.

## Quickstart

```sh
npm install
npm start          # → http://127.0.0.1:8789 (first TTS call downloads the ~90 MB model)
```

Open http://127.0.0.1:8789 for the built-in web UI: type text, pick a voice,
play it, download the WAV.

From the shell:

```sh
node say.mjs "The quick brown fox."              # plays it (macOS afplay)
node say.mjs "The quick brown fox." -o fox.wav   # writes a file
node say.mjs "Hullo." -v bm_george               # British voice
node say.mjs "Faster, please." -s 1.5            # speaking rate

echo "Piped from anywhere." | node say.mjs --system   # speaks a whole document
pbpaste | node say.mjs --system                       # read the clipboard aloud
node say.mjs --voices                                 # list all 28, graded
```

## API

Two ways to speak. `POST /api/tts` renders one complete WAV and hands it back —
simple, but it has to finish before you hear anything, so it is capped.
`POST /api/speak` starts a **playback session**: the text is split into
sentences, generated one at a time, and played through the system audio output.
Speech starts after the first sentence rather than the whole document, so there
is no length limit.

| Endpoint | Description |
| --- | --- |
| `POST /api/tts` | Body `{"text": "…", "voice": "af_heart", "speed": 1.25}` → `audio/wav`. Max 2000 chars. `voice` and `speed` (0.5–2) are optional and fall back to your saved settings. |
| `POST /api/speak` | Body `{"text": "…", "voice"?, "speed"?}` → `{ok, count}`. Starts a session and plays through the speakers. No length limit. |
| `GET /api/playback` | `{state, index, count, sentences, voice, speed, startedAt, durationMs}`. `state` is `idle`, `speaking`, or `paused`. |
| `POST /api/playback/toggle` | `{action}` — `stopped` if speaking, `resumed` if paused, `need_text` if idle. The hotkey's contract: fetch text only when the server asks for it. |
| `POST /api/playback/{pause,resume,next,prev,stop}` | Transport controls. `next`/`prev` move a sentence at a time. |
| `GET /api/playback/events` | Server-sent events: `state`, `sentences`, `model` (download progress), `error`. |
| `GET /api/voices` | All 28 voices: `[{id, name, label, lang, gender, grade, recommended}]`, best-graded first. |
| `GET /api/health` | `{ok, modelLoaded, audioOut}` — `audioOut` is false if no system audio player was found. |
| `GET /api/settings` | `{port, hotkey, voice, speed, activePort, …}` — current settings, defaults applied. |
| `POST /api/settings` | Body `{"port": 8800, "hotkey": "CmdOrCtrl+Shift+S", "voice": "bm_george", "speed": 1.25}` → persists to `~/.chirp/config.json`. Blank values restore defaults. Port binds on next start; the desktop app re-registers the hotkey live. |
| `GET /` | Web UI. |

Because a single session on the server is the source of truth, the hotkey, the
tray, the CLI, and every open browser tab all show and control the same
playback. Speak something from the shell and an open web UI will render the
transcript and follow along.

CORS is open (`Access-Control-Allow-Origin: *`) so any local web app can call
it directly. Port via `CHIRP_PORT` (default 8789); CLI target via `CHIRP_URL`.
Both fall back to the port saved in `~/.chirp/config.json`, which the web
UI's Settings panel edits — the same file the desktop app reads for its port
and global shortcut.

```js
const r = await fetch('http://127.0.0.1:8789/api/tts', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({text: 'Hello from my app'}),
});
const wav = await r.blob();
```

## Integrating with Margin

Margin's narrator already speaks this exact protocol. To run Margin against a
standalone Chirp instead of its embedded TTS, point its TTS base URL at this
server — same `POST /api/tts` contract, plus optional per-request `voice`.

## Notes

- The model is cached by transformers.js under `~/.cache/huggingface` after the
  first download.
- Requires Node.js ≥ 20.11. Everything runs on CPU. Speech starts once the
  first sentence is generated — usually under a second — and the rest is
  produced while it plays, so length barely affects how long you wait.
- `npm test` runs the suite (`node --test`, no extra dependencies). It uses
  fakes for the model and the audio device, so it passes without the ~90 MB
  download and without making a sound.
- The app offers **opt-in** anonymous usage analytics (Google Analytics) on
  first run — counts and voice ids only, never text. Decline and nothing is
  ever sent; change your mind anytime in Settings. The product site
  (chirp.rahultrikha.com) uses its own analytics tag.

## Desktop app

Chirp also ships as a menu-bar desktop app (macOS, Windows, Linux) built with
Tauri. It bundles its own Node runtime and this server, so there's nothing
else to install:

- Lives in the menu bar / system tray — no dock icon, no taskbar clutter.
- **Cmd/Ctrl+Shift+Space** speaks **whatever text you have selected**, in any
  app, in the voice and speed saved in Settings. Press it again to stop. Your
  clipboard is left exactly as it was — Chirp saves it, copies the selection,
  and puts the original back. With nothing selected it falls back to the
  clipboard.
  - On macOS this needs Accessibility permission (Settings shows a **Grant…**
    button when it is missing; without it the hotkey can only read the
    clipboard). On X11/Wayland the PRIMARY selection is read directly, so no
    permission and no keystroke are involved.
  - Prefer the old behaviour? **Settings ▸ Reads ▸ Clipboard**.
- The tray menu is a transport: **Play/Pause, Previous, Next, Stop**, plus
  **Voice** and **Speed** submenus. It always agrees with the web UI, because
  both are views of the same session on the server.
- The tray menu's **Show Chirp** opens the same web UI at
  `http://127.0.0.1:8789/` in a small window; closing the window just hides
  it. **Quit** exits the app.

- **Now Playing** shows the sentence being read and the voice, with transport
  controls, because the app plays audio in its own process.

### Known limitations

- **The "Speak with Chirp" Services menu entry never appears.** The
  `NSServices` declaration does reach the bundle and does register with the
  system (`pbs -dump_pboard` lists it), but the item shows up in no
  application's Services menu. The likely cause is that Chirp sets
  `ActivationPolicy::Accessory` at runtime to stay out of the Dock, and macOS
  does not surface Services from background-only apps. Fixing it probably
  means giving up the accessory policy, which is a worse trade.
- **Media-key control is unverified.** The Now Playing widget renders and its
  handlers are wired to `MPRemoteCommandCenter`, but nobody has confirmed that
  pressing a keyboard or headphone media key actually reaches Chirp.

**Pause depends on where audio is playing.** With the desktop app running,
audio plays inside the app and pause stops mid-word, resuming from that point.
Running `npm start` on its own falls back to the system player (`afplay`,
`aplay`, PowerShell), which cannot pause a running file — there, pausing stops
between sentences and resuming replays the current one.

Download the latest build for your platform from
[GitHub releases](https://github.com/rahult/chirp/releases). The first TTS
call still downloads the ~90 MB model, same as the standalone server.
