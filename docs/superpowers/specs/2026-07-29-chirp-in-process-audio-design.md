# Chirp Phase 3 — In-Process Audio

Date: 2026-07-29
Status: Design approved, ready for planning

## Context

Phases 1 and 2 left three compromises, all traceable to one decision: audio
is played by shelling out to `afplay` (or `aplay`, or PowerShell) once per
sentence.

1. **Pause is sentence-granular.** The OS players cannot pause a running
   file, only be killed, so `session.pause()` kills the audio and
   `session.resume()` replays the sentence from its start
   (`src/playback.mjs`).
2. **Now Playing does not bind.** macOS attributes the Now Playing session to
   the process that owns the audio. That process is `afplay`, not Chirp, so
   the `MPNowPlayingInfoCenter` work in `src-tauri/src/nowplaying.rs` has
   nothing to attach to and the media keys do not reach us.
3. **Every sentence writes a temp file.** `src/player.mjs` writes a WAV to
   `os.tmpdir()` for the player process to read, then unlinks it.

Phase 3 removes all three by playing audio inside the desktop app's own
process.

## The constraint that decides the design

Now Playing can only be fixed by the process that *sets* the metadata also
*owning* the audio. That process is the Tauri app, in Rust. Playing audio
in-process on the Node side — with a native module such as `speaker` — would
fix pause and the temp files but leave Now Playing exactly as broken, because
the Node sidecar is still a different process from the one calling
`MPNowPlayingInfoCenter`.

So audio moves to Rust. Session state does not.

## Goals

- Pause stops mid-word and resumes from that point.
- Chirp owns the audio session, so Now Playing and the media keys have a
  chance of binding.
- No temp files.
- `npm start` with no desktop app keeps working exactly as it does today.

## Non-goals

- **Moving session state into Rust.** The server keeps owning the queue, the
  index, and the state. Phase 1 removed distributed playback state; this must
  not reintroduce it.
- **Using rodio's `set_speed` for speed changes.** rodio resamples, which
  shifts pitch. Kokoro's `speed` re-synthesises at the same pitch. Speed
  changes keep going through the model, as they do now.
- **Reporting playback position over the wire.** The UI already interpolates
  from `startedAt` and `durationMs`; that keeps working (see Data flow).
- **Replacing `src/player.mjs`.** It stays as the no-desktop-app fallback.

## Architecture

Phase 1 made the session take its player by injection:

```js
createSession({engine, player})
```

That is the seam Phase 3 uses. The state machine does not change; it gets a
second player implementation.

```
                     ┌─ remote player ──SSE──> Tauri app ──> rodio ──> speakers
session (Node) ──────┤
   queue, index,     └─ local player  ────────────────────> afplay
   state, decisions
```

The server still decides everything. Rust is a speaker, not a
decision-maker — the same discipline that removed the stale playback flag in
Phase 1.

### The player interface grows

Today:

```js
player.play(wav, onEnd) → {stop()}
player.wavDurationMs(wav) → number
```

After:

```js
player.supportsPause: boolean
player.play(wav, onEnd) → {stop(), pause(), resume()}
player.wavDurationMs(wav) → number
```

`pause()` and `resume()` are only called when `supportsPause` is true.
`src/player.mjs` sets it `false` and keeps today's behaviour; the remote
player sets it `true`.

### Which player is in use

The desktop app connects to the event feed as
`GET /api/playback/events?client=app`. While at least one such client is
connected, the session uses the remote player; otherwise the local one. The
server already tracks SSE clients, so this is a property of the existing
connection set rather than new state.

If the desktop app disconnects mid-sentence, the session stops the dead
remote handle, switches to the local player, and restarts the current
sentence. Restarting one sentence is the honest behaviour: the remote handle
cannot report where it got to once its transport is gone.

## Components

| File | Change |
|---|---|
| `src/player.mjs` | Add `supportsPause = false`; add no-op `pause`/`resume` to the handle so both players share a shape |
| `src/remote-player.mjs` | **New.** Parks WAV buffers under ids, pushes audio commands, resolves `onEnd` when the app reports back |
| `src/playback.mjs` | `pause`/`resume` use the handle when `supportsPause`; `startedAt` is rebased on resume |
| `src/routes.mjs` | `GET /api/audio/:id`, `POST /api/audio/:id/ended`, `audio` SSE event, app-client tracking, player selection |
| `src-tauri/src/audio.rs` | **New.** rodio wrapper: play from bytes, pause, resume, stop, report end |
| `src-tauri/src/events.rs` | Parse the `audio` event |
| `src-tauri/src/lib.rs` | Connect the feed as `client=app`; dispatch audio commands |
| `.github/workflows/release.yml` | Add `libasound2-dev` to the Linux step |

## Data flow

Playing one sentence:

1. `session.playCurrent()` calls `player.play(wav, onEnd)`.
2. The remote player stores the buffer under a monotonic id and pushes
   `event: audio` / `{"action":"play","id":7}`.
3. Rust `GET /api/audio/7`, receives `audio/wav`, decodes it from an
   in-memory cursor and appends it to a `rodio::Player`.
4. When the track drains, Rust `POST /api/audio/7/ended`.
5. The remote player resolves that id's `onEnd`, and the session advances.

Pause and resume push `{"action":"pause"}` and `{"action":"resume"}`; stop
pushes `{"action":"stop"}`. Ids let a late `ended` from a superseded sentence
be ignored — the remote player only honours the id it is currently waiting
on.

Buffers are dropped as soon as their sentence is superseded or reported
ended, so the parked set holds at most one entry per live handle.

### Progress stays interpolated

The UI computes progress from `startedAt` and `durationMs` and needs no
position feed. True pause breaks that arithmetic, so on resume the session
rebases:

```
startedAt = Date.now() - elapsedBeforePause
```

which keeps the existing smooth progress bar correct across a real pause.

## Error handling

| Failure | Behaviour |
|---|---|
| Rust cannot open an audio device | Reports it; the server uses the local player and `GET /api/health` reports `audioOut` from whichever player is active |
| `GET /api/audio/:id` fails or the WAV will not decode | Rust posts `/api/audio/:id/ended` with `{"error":"…"}`; the session treats it like a generation fault — emit `fault`, skip the sentence, stop after three consecutive failures |
| Desktop app disconnects mid-sentence | Switch to the local player and restart the current sentence |
| A stale `ended` arrives for a superseded id | Ignored |
| No audio device anywhere | Unchanged from Phase 1: `audioOut: false`, and the UI warns |

## Testing

`node --test` and `cargo test`, both still without the model or a sound card.

| Suite | Covers |
|---|---|
| `test/playback.test.mjs` | New: with a pausing player, `pause` does **not** kill and `resume` does **not** replay; `startedAt` is rebased so progress stays correct; with a non-pausing player the Phase 1 replay behaviour is unchanged |
| `test/remote-player.test.mjs` | **New.** Id lifecycle: `onEnd` fires for the right id; a stale id is ignored; superseding a handle drops its buffer; stop/pause/resume emit the right commands |
| `test/routes.test.mjs` | `GET /api/audio/:id` returns the parked WAV and 404s for unknown ids; the session picks the remote player only while an app client is connected |
| `src-tauri/src/audio.rs` | Command parsing and state transitions, with the rodio call sites behind a trait so tests need no device |

The rodio calls themselves are not unit-tested — a real device is a
dependency, not our logic. One manual check per release covers it.

## Verification

- Pause mid-sentence and resume: the audio continues **from where it
  stopped**, not from the start of the sentence.
- No files matching `chirp-*.wav` appear in `os.tmpdir()` while the desktop
  app is running.
- `npm start` with the desktop app quit still speaks through `/api/speak`.
- Quitting the desktop app mid-read continues the read through `afplay`.
- Control Centre shows **Chirp** as the Now Playing app, and the keyboard
  play/pause key controls it. **If this still fails, record what appeared and
  stop** — it would mean the cause was something other than audio ownership,
  and that is worth knowing rather than grinding against.
- `npm test` and `cargo test` pass; the Linux release build still succeeds
  with `libasound2-dev` added.

## Risks

| Risk | Handling |
|---|---|
| Now Playing still does not bind after all this | The verification step accepts a negative result. Audio ownership is the best-supported explanation, not a guarantee. |
| Cross-process round trip adds a gap between sentences | The next sentence is already generated ahead of time; the added latency is one localhost request. Measure it; if audible, prefetch the next buffer to Rust before the current one ends. |
| Two player implementations drift | They share one interface and one set of session tests, and the local path stays exercised by every `npm test` run and by server-only use. |
| `rodio` pulls `alsa-sys`, breaking the Linux CI build | Known: add `libasound2-dev` to `.github/workflows/release.yml`. Verified absent today. |
| Larger binary and 552-crate dependency graph | Accepted. `rodio` is added with `--no-default-features --features playback,wav` so no mp3/flac/vorbis decoders come along. |
