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
```

## API

| Endpoint | Description |
| --- | --- |
| `POST /api/tts` | Body `{"text": "…", "voice": "af_heart", "speed": 1.25}` → `audio/wav`. Max 2000 chars, generation is serialized. `voice` and `speed` (0.5–2, default 1) are optional. |
| `GET /api/voices` | List of voices: `[{id, label, lang}]`. |
| `GET /api/health` | `{ok, modelLoaded}` — model loads lazily on first TTS call. |
| `GET /` | Web UI. |

CORS is open (`Access-Control-Allow-Origin: *`) so any local web app can call
it directly. Port via `CHIRP_PORT` (default 8789); CLI target via `CHIRP_URL`.

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
- Requires Node.js ≥ 20.11. Everything runs on CPU; a request takes a second or
  two for a sentence.

## Desktop app

Chirp also ships as a menu-bar desktop app (macOS, Windows, Linux) built with
Tauri. It bundles its own Node runtime and this server, so there's nothing
else to install:

- Lives in the menu bar / system tray — no dock icon, no taskbar clutter.
- **Cmd/Ctrl+Shift+Space** speaks whatever is on the clipboard through the OS
  audio output. Press it again to stop.
- The tray menu's **Show Chirp** opens the same web UI at
  `http://127.0.0.1:8789/` in a small window; closing the window just hides
  it. **Quit** exits the app.

Download the latest build for your platform from
[GitHub releases](https://github.com/rahult/chirp/releases). The first TTS
call still downloads the ~90 MB model, same as the standalone server.
