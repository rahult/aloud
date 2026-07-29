# Chirp — Streaming Playback Session & "Speak Anything, Anywhere"

Date: 2026-07-29
Status: Design approved, ready for planning

## Context

Chirp today is a local Kokoro-82M TTS server with three thin clients: a web UI
served as an inlined string, a `say.mjs` CLI, and a Tauri menu-bar app whose
global hotkey speaks the clipboard. It does that one job well.

It is not yet useful to someone who wants to *interact with text as voice*,
for four structural reasons:

1. **Playback state lives in three places and they disagree.** `PLAYING` in
   Rust (`src-tauri/src/lib.rs:30`), the `player` child handle in Node
   (`server.mjs:113`), and `audio`/`cur`/`chunks` in the browser
   (`server.mjs:495`). Nothing reconciles them.
2. **Your settings do not reach the feature you use most.** Voice and speed
   live in `localStorage` (`server.mjs:483-484`), so `/api/speak` — the path
   the global hotkey uses (`lib.rs:90`) — always falls back to `af_heart` at
   1×.
3. **Generation is one-shot and capped at 2000 characters** (`MAX_CHARS`,
   `server.mjs:37`). Time-to-first-audio scales with the whole input.
4. **The hotkey reads the clipboard, not the selection**, so using it means
   destroying whatever you had copied.

### The bug that proves point 1

Reproducible on `main` today:

1. Press the hotkey → speaks → Rust sets `PLAYING = true` (`lib.rs:94`).
2. Audio finishes naturally → Node clears `player` (`server.mjs:131`).
   Nothing informs Rust.
3. Press the hotkey → Rust sees `PLAYING == true`, POSTs `/api/stop`, and
   returns early (`lib.rs:76-81`). The server has nothing to stop. No speech.
4. Press a third time → works.

After every completed utterance, the next hotkey press is silently swallowed.
This is a symptom of distributed state, not a patchable defect.

### What the model already supports and we do not use

Verified against `node_modules/kokoro-js@1.2.1`:

- **`KokoroTTS.stream(text, {voice, speed, split_pattern})`** returns an
  `AsyncGenerator` yielding `{text, phonemes, audio}` per sentence. Chirp only
  calls `generate()` (`server.mjs:75`).
- **`split()` and `TextSplitterStream`** are exported. Chirp reimplements a
  weaker sentence splitter in browser JS (`server.mjs:501`).
- **28 voices**, each with an `overallGrade` from A to D. Chirp hardcodes 11
  and discards the grades (`server.mjs:43-55`).
- **`from_pretrained` accepts a `progress_callback`** — usable for honest
  first-run download progress.

### What the model does *not* support

All 28 voices are `en-us` or `en-gb`, and `_validate_voice()` returns only
`"a" | "b"`. The multilingual Kokoro voices exist in the Hugging Face repo but
this package's phonemizer cannot reach them. **Adding languages means
replacing the phonemizer**, not adding config entries. Out of scope.

## Goals

- One source of truth for playback, shared by hotkey, tray, web UI, and CLI.
- First audio within roughly a second, independent of input length.
- Arbitrarily long text.
- Settings that apply everywhere.
- Speak the current selection in any application without clobbering the
  clipboard.

## Non-goals

- **Multilingual voices.** Blocked by the phonemizer (see above).
- **MP3/M4B export.** Needs either a JS encoder (`lamejs`) or an `ffmpeg`
  shell-out; both fight the project's one-dependency, nothing-to-install
  ethos, and a system-utility user rarely exports files. Revisit if the
  document/audiobook direction is taken later. WAV download stays.
- **Document import (PDF/EPUB/docx), a library, resume-across-sessions.**
  A different product direction; deliberately deferred.
- **Pronunciation lexicon, word-level timestamps, OpenAI-compatible API.**
  Developer-platform direction; deferred.

## Architecture

A single `Session` object in the Node server is the source of truth:

```
Session {
  sentences: string[]
  index:     number
  state:     'idle' | 'speaking' | 'paused' | 'error'
  voice:     string
  speed:     number
}
```

Every surface becomes a client of it:

```
  hotkey ─┐
  tray    ─┼─► Session (server) ─► OS player (afplay / aplay / PowerShell)
  web UI  ─┤
  CLI     ─┘
```

Rust's `PLAYING: AtomicBool` is deleted. Only the process that spawns the
player tracks whether it is playing, which makes the swallowed-hotkey bug
unrepresentable rather than fixed.

The web UI becomes a remote control and transcript view. Its in-browser
`<audio>` path, blob-URL cache, and per-chunk `fetch` bookkeeping
(`server.mjs:494-572`) are removed — roughly 80 lines. The server binds
`127.0.0.1` only, so browser and OS audio are always the same machine; two
audio paths bought nothing but a sync burden.

### Consequence: pause is sentence-granular

`afplay` cannot pause, only be killed. Because `stream()` delivers audio one
sentence at a time, the session pauses *between* sentences and resumes by
replaying the current one. For a reading tool this is defensible and arguably
preferable to resuming mid-word. It is a deliberate accepted trade-off, not an
oversight.

### Module layout

`server.mjs` is 640 lines, of which 435 are an HTML template string. It cannot
absorb a session, streaming, SSE, and a voice catalog. Split first, before any
feature lands:

| File | Responsibility | Depends on |
|---|---|---|
| `src/config.mjs` | Load/save/validate `~/.chirp/config.json`; defaults | node:fs |
| `src/voices.mjs` | Voice catalog from kokoro-js, grades, curation | kokoro-js |
| `src/tts.mjs` | Model load, `generate()`, `stream()`, serialization | kokoro-js |
| `src/playback.mjs` | `Session` state machine | injected engine + player |
| `src/player.mjs` | OS audio process spawn/kill, availability probe | node:child_process |
| `src/routes.mjs` | HTTP routing, SSE | all of the above |
| `server.mjs` | Entry point: read config, wire modules, listen | src/* |
| `ui/index.html`, `ui/app.js`, `ui/style.css` | Served as static files | — |
| `test/*.test.mjs` | `node --test`, zero new dependencies | — |

`src-tauri/tauri.conf.json` `resources` gains `"../src": "src"` and
`"../ui": "ui"`. It is already a map, so this is additive.

**`playback.mjs` takes its engine and player by injection:**

```js
createSession({engine, player})
// engine.stream(text, {voice, speed}) → AsyncGenerator<{text, audio}>
// player.play(wav, onEnd)             → {stop()}
```

This is the crux of the testing story: the state machine is exercised with a
fake engine that yields instantly and a fake player that ends on command. No
90 MB model download, no audio device, no timing flakiness in CI.

## Data flow

Starting a session:

1. Client POSTs `/api/speak {text, voice?, speed?}`. Unspecified fields fall
   back to `~/.chirp/config.json`, not to hardcoded constants.
2. `tts.split(text)` produces sentences. Session sets `index = 0`,
   `state = 'speaking'`, emits a `sentences` SSE event.
3. A producer loop drains `engine.stream()` into a `Map<index, wavBuffer>`,
   staying at most **3 sentences ahead** of `index` to bound memory.
4. The player plays `buffers[index]`, awaiting it if generation has not caught
   up. On end, `index++` and repeat. At `index === count`, `finish()`.
5. Each transition emits a `state` SSE event.

Kokoro outputs 24 kHz mono 16-bit — about 48 KB/s of WAV. The buffer cache is
capped at **50 sentences (~15 MB)**, evicting oldest-first; evicted sentences
regenerate if the user skips back to them.

### State machine

| Transition | From | To | Effect |
|---|---|---|---|
| `start(text, voice, speed)` | any | speaking | split, index = 0, begin generation |
| `pause()` | speaking | paused | kill player; index unchanged |
| `resume()` | paused | speaking | replay `sentences[index]` from its start |
| `next()` | speaking, paused | speaking | kill; `index++`; finish if past end |
| `prev()` | speaking, paused | speaking | kill; `index = max(0, index - 1)` |
| `stop()` | any | idle | kill; index = 0; clear sentences |
| sentence ends | speaking | speaking / idle | `index++`, or `finish()` |

`finish()` sets `state = 'idle'` and `index = count`, so the transcript
renders fully read rather than snapping back to the top.

Changing voice or speed mid-session discards the buffer cache and restarts
generation from the current `index`; playback position is preserved.

## HTTP API

Unchanged and still supported: `POST /api/tts`, `GET /api/voices`,
`GET /api/health`, `GET|POST /api/settings`, `GET /`. `POST /api/tts` keeps
its character cap because it buffers a complete WAV; Margin and `say.mjs`
depend on this contract.

| Endpoint | Behaviour |
|---|---|
| `POST /api/speak` | `{text, voice?, speed?}` → starts a session, returns `{ok, count}`. No character cap. |
| `GET /api/playback` | Current session state |
| `POST /api/playback/toggle` | Returns `{action}` — see below |
| `POST /api/playback/{pause,resume,next,prev,stop}` | Explicit transitions |
| `GET /api/playback/events` | SSE: `state`, `sentences`, `model`, `error` |
| `POST /api/stop` | Retained as an alias for `/api/playback/stop` |

### Why `toggle` returns `need_text`

The hotkey must mean "stop if speaking, else speak the selection." Capturing a
selection on macOS has side effects (synthetic Cmd+C, clipboard save/restore),
so it must not happen speculatively.

`POST /api/playback/toggle` takes no body and returns exactly one of:

| Session state | Action taken | Response |
|---|---|---|
| `speaking` | stop | `{action: "stopped"}` |
| `paused` | resume | `{action: "resumed"}` |
| `idle` or `error` | none | `{action: "need_text"}` |

Rust captures the selection **only** on `need_text`, then POSTs `/api/speak`.
One round trip in the stop case, two in the speak case, and the server remains
the decider. Note that `toggle` stops rather than pauses when speaking — this
preserves today's documented hotkey behaviour ("press it again to stop"). The
tray's Play·Pause button calls `/api/playback/pause` and `/resume` instead.

### SSE events

```
event: sentences
data: {"sentences":["First.","Second."],"voice":"af_heart","speed":1}

event: state
data: {"state":"speaking","index":3,"count":12}

event: model
data: {"loaded":false,"progress":0.42}

event: error
data: {"scope":"generate","index":4,"message":"…"}
```

The `model` event turns the existing "Warms up on first speak" status dot into
honest download progress via `from_pretrained`'s `progress_callback`.

## Error handling

| Failure | Behaviour |
|---|---|
| Model download fails on first run | `state = 'error'`; distinguish offline ("needs a one-time ~90 MB download; you appear to be offline") from other errors. UI offers retry. |
| Generation fails for one sentence | Emit `error` event, skip it, continue. Three consecutive failures stop the session. A bad sentence must not end a long read. |
| No OS audio player (e.g. Linux without `aplay`) | Probed at startup; `GET /api/health` reports `audioOut: false`; UI warns instead of failing silently, which is the current behaviour. |
| Hotkey already registered by another app | Rust already tolerates this (`lib.rs:245`) but the UI cannot see it. Rust POSTs `/api/hotkey-status {ok:false, hotkey}`; Settings shows "in use by another app." |
| Accessibility permission denied (macOS) | Selection capture returns empty; Settings shows a "Grant access" button opening `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`. |

Consistent with design principle 3 in `.impeccable.md`: state is surfaced
inline in plain language, never in a blocking alert.

## Testing

`node --test`, no new dependencies.

| Suite | Covers |
|---|---|
| `config.test.mjs` | Defaults, validation bounds, blank-restores-default, round-trip |
| `voices.test.mjs` | Catalog built from kokoro-js, grade sort, curated grouping, unknown-id fallback |
| `playback.test.mjs` | Every transition in the table above, against fake engine + player |
| `routes.test.mjs` | Status codes, `toggle` → `need_text`, SSE framing, CORS preflight |

`playback.test.mjs` is the valuable one and must cover the regression
explicitly: **play a session to natural completion, then assert `toggle`
returns `need_text` rather than `stopped`.** That is the bug from the Context
section, encoded as a test.

Generation and model loading are not unit-tested; they are a dependency, not
our logic. One manual smoke check per release covers them.

## Phasing

The two phases are separate implementation plans. **Phase 1 is the scope of
the first plan**; Phase 2 should be re-planned once Phase 1 has shipped and
the session API has met real use. Phase 2 depends on Phase 1 (items 11 and 13
drive the session API) but Phase 1 stands alone and is shippable by itself.

### Phase 1 — Foundation

1. Module split + `ui/` static files + `tauri.conf.json` resources. No
   behaviour change; establishes the seams.
2. `src/playback.mjs` session with tests, against fakes.
3. Wire `tts.stream()` into the session; server-side splitting via kokoro's
   `split()`.
4. `voice` and `speed` move into `~/.chirp/config.json`; `/api/speak` and
   `/api/tts` default from it. **Fixes settings not reaching hotkey and CLI.**
5. Rust: delete `PLAYING`, hotkey POSTs `/api/playback/toggle`.
   **Fixes the swallowed hotkey press.**
6. Remove the character cap on session paths; keep it on `/api/tts`.
7. All 28 voices with grades; curated 11 as a "Recommended" group.
8. Rebuild the web UI player as an SSE-driven remote control.

### Phase 2 — Speak anything, anywhere

9. **Read the selection, not the clipboard.** macOS: `AXSelectedText`, falling
   back to synthetic Cmd+C with clipboard save and restore. Windows: Ctrl+C
   synth with the same save/restore. Linux: X11 PRIMARY via `xclip -o
   -selection primary`, Wayland via `wl-paste -p`. New crate: `enigo` for key
   synthesis. Setting: "Hotkey reads: Selection (default) / Clipboard."
10. **Accessibility permission onboarding** (macOS) — required by item 9, and
    the point where most users will otherwise silently fail.
11. **Tray playback controls**: Play·Pause, Next, Prev, Stop, plus Voice and
    Speed submenus, with labels driven by the SSE stream read from a Rust
    thread (polling `/api/playback` at 500 ms as fallback).
12. **macOS Services entry** ("Speak with Chirp") via `NSServices` in
    `Info.plist` — reaches every app with no hotkey conflict.
13. **Media keys / Now Playing** via `MPNowPlayingInfoCenter` and
    `MPRemoteCommandCenter`, so playback is controllable from AirPods.

## Risks

| Risk | Mitigation |
|---|---|
| `AXSelectedText` is unimplemented in many Electron and Java apps | The synthetic-copy fallback is the real path; treat AX as the fast path, not the contract. Test against Chrome, VS Code, Notes, Slack, Preview. |
| Clipboard save/restore races with slow apps | Poll `changeCount` for up to 150 ms; restore after a short delay; never restore if the user copied something new meanwhile. |
| macOS Services registration needs `NSApplication` service-provider wiring that Tauri does not expose directly | Highest-risk Phase 2 item. Spike it before committing; it is independently droppable without affecting items 9-11 and 13. |
| Sentence-granular pause feels wrong to some users | Accepted and documented. Revisit only if feedback demands it; the alternative is a native audio dependency. |
| Removing browser `<audio>` breaks a server-only workflow | The server binds `127.0.0.1`; browser and OS audio are necessarily the same machine. `POST /api/tts` remains for programmatic consumers. |

## Success criteria

- Pressing the hotkey twice in a row speaks twice. No swallowed press.
- First audio begins within ~1 s for a 5000-word input.
- A voice chosen in Settings is the voice the hotkey and CLI use.
- Selecting text in Chrome, VS Code, Notes, and Slack and pressing the hotkey
  speaks it, and the clipboard afterwards holds what it held before.
- `node --test` passes without downloading the model.
