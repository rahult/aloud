# Chirp Phase 3 — In-Process Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play audio inside the desktop app's own process so pause stops mid-word, Chirp owns the audio session, and no temp files are written.

**Architecture:** The session keeps owning the queue, index and state. It gains a second player implementation that hands WAV buffers to the Tauri app over the existing SSE feed; the app plays them with `rodio` and reports back when a track ends. A router picks the remote player while a desktop app is connected and the existing `afplay` player otherwise, so `npm start` alone is unaffected.

**Tech Stack:** Node ≥ 20.11 (ESM), `rodio` 0.22 (`--no-default-features --features playback,wav`), Tauri v2 / Rust, `ureq` 3, `node --test`, `cargo test`.

## Global Constraints

- **No new Node runtime dependencies.** `kokoro-js` stays the only entry in `dependencies`.
- **`rodio` is added with `--no-default-features --features playback,wav`** — no mp3/flac/vorbis decoders.
- **Session state stays in the server.** Rust is a speaker, not a decision-maker. Do not move the queue, index, or state into Rust.
- **Do not use `rodio`'s `set_speed` for speed changes.** It resamples and shifts pitch; Kokoro re-synthesises at the same pitch. Speed keeps going through the model.
- **`npm start` with no desktop app must keep working** exactly as it does today.
- **`npm test` and `cargo test` must keep passing without the model and without an audio device.**
- **Server binds `127.0.0.1` only.**
- **Commit after every task.**

## Verified API (compiled against rodio 0.22.2)

`rodio 0.22` renamed `Sink` to `Player` and moved the device builder. These are the real paths:

```rust
let device = rodio::stream::DeviceSinkBuilder::open_default_sink()?;  // MixerDeviceSink
let player = rodio::Player::connect_new(device.mixer());
player.append(rodio::Decoder::new(std::io::Cursor::new(wav))?);
player.pause(); player.play(); player.stop();
let _: bool = player.is_paused();
let _: bool = player.empty();
let _: std::time::Duration = player.get_pos();
let _ = player.try_seek(std::time::Duration::from_millis(500));
```

`DeviceSinkBuilder::open_default_sink()` is an associated function on the
**builder**, not on `MixerDeviceSink`. The device sink must be kept alive for
as long as playback runs; dropping it silences the player.

---

### Task 1: Teach the session to really pause

The player interface grows a pause capability, and the session uses it when
present. With the `afplay` player nothing changes.

**Files:**
- Modify: `src/player.mjs`
- Modify: `src/playback.mjs`
- Modify: `test/playback.test.mjs`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `player.supportsPause: boolean` — `false` in `src/player.mjs`
  - handle shape `{stop(), pause(), resume()}`
  - `session.restartCurrent() → void` — kill and replay the current sentence
  - `onEnd(error?: string)` — the play callback may now report a failure

- [ ] **Step 1: Write the failing tests**

Add to `test/playback.test.mjs`, after the existing `fakePlayer` definition:

```js
// A player that can really pause, like rodio — as opposed to afplay, which
// can only be killed.
function fakePausingPlayer() {
  const p = fakePlayer();
  p.supportsPause = true;
  p.pauses = 0;
  p.resumes = 0;
  const basePlay = p.play;
  p.play = (wav, onEnd) => {
    const h = basePlay(wav, onEnd);
    return {
      stop: h.stop,
      pause() { p.pauses++; },
      resume() { p.resumes++; },
    };
  };
  return p;
}

const buildPausing = () => {
  const engine = fakeEngine();
  const player = fakePausingPlayer();
  return {engine, player, session: createSession({engine, player})};
};
```

Then the tests:

```js
test('a pausing player is paused, not killed', async () => {
  const {session, player} = buildPausing();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  assert.equal(session.getState().state, 'paused');
  assert.equal(player.pauses, 1);
  assert.equal(player.stops, 0, 'must not kill audio it can pause');
});

test('resuming a pausing player does not replay the sentence', async () => {
  const {session, player} = buildPausing();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  session.resume();
  await settle();
  assert.equal(session.getState().state, 'speaking');
  assert.equal(player.resumes, 1);
  assert.deepEqual(player.played, ['one'], 'sentence must not start over');
});

// The UI derives progress from startedAt, so a real pause has to move it.
test('startedAt is rebased across a pause so progress stays correct', async () => {
  const {session} = buildPausing();
  session.start('one', {voice: 'af_heart', speed: 1});
  await settle();
  const before = session.getState().startedAt;
  session.pause();
  await new Promise(r => setTimeout(r, 40));
  session.resume();
  await settle();
  const after = session.getState().startedAt;
  assert.ok(after >= before + 30, `startedAt moved forward by the paused time (${before} -> ${after})`);
});

test('a non-pausing player keeps the kill-and-replay behaviour', async () => {
  const {session, player} = build();       // the original fakePlayer
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  assert.equal(player.stops, 1);
  session.resume();
  await settle();
  assert.deepEqual(player.played, ['one', 'one'], 'replays, as afplay must');
});

test('restartCurrent replays the current sentence without moving the index', async () => {
  const {session, player} = build();
  session.start('one|two|three', {voice: 'af_heart', speed: 1});
  await settle();
  session.next();
  await settle();
  session.restartCurrent();
  await settle();
  assert.equal(session.getState().index, 1);
  assert.deepEqual(player.played, ['one', 'two', 'two']);
});

test('restartCurrent does nothing when idle', async () => {
  const {session, player} = build();
  session.restartCurrent();
  await settle();
  assert.deepEqual(player.played, []);
});

test('an audio failure is reported and skipped', async () => {
  const {session, player} = build();
  const faults = [];
  session.on('fault', f => faults.push(f));
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  player.current.onEnd('device went away');       // report a failure, not a clean end
  await settle();
  assert.equal(faults.length, 1);
  assert.equal(faults[0].scope, 'audio');
  assert.equal(session.getState().index, 1, 'still advances past the bad sentence');
});

test('three consecutive audio failures stop the session', async () => {
  const {session, player} = build();
  session.start('a|b|c|d', {voice: 'af_heart', speed: 1});
  await settle();
  for (let i = 0; i < 3 && player.current; i++) {
    player.current.onEnd('boom');
    await settle();
  }
  assert.equal(session.getState().state, 'idle');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test --test-timeout=15000 test/playback.test.mjs`
Expected: FAIL — `player.pauses` is 0 and `session.restartCurrent` is not a function

- [ ] **Step 3: Give the local player the new shape**

In `src/player.mjs`, add above `play`:

```js
// afplay, aplay and PowerShell cannot pause a running file — only be killed.
// The session checks this before reaching for pause().
export const supportsPause = false;
```

and in the object `play` returns, alongside `stop`:

```js
    // Present so both players share one shape; never called while
    // supportsPause is false.
    pause() {},
    resume() {},
```

- [ ] **Step 4: Use it in the session**

In `src/playback.mjs`, add to the state declarations:

```js
  let pausedAt = 0;
  let audioFailures = 0;
```

Replace `pause` and `resume` with:

```js
  function pause() {
    if (state !== 'speaking') return;
    // A player that can really pause keeps its position; one that cannot has
    // to be killed and will replay the sentence on resume.
    if (player.supportsPause && handle) {
      handle.pause();
      pausedAt = Date.now();
    } else {
      kill();
    }
    state = 'paused';
    emit();
  }

  function resume() {
    if (state !== 'paused') return;
    if (player.supportsPause && handle) {
      // The UI interpolates progress from startedAt, so move it forward by
      // however long we were paused.
      if (pausedAt) startedAt += Date.now() - pausedAt;
      pausedAt = 0;
      handle.resume();
      state = 'speaking';
      emit();
    } else {
      kill();
      playCurrent();
    }
  }

  // Replay the current sentence from its start, leaving the index alone.
  // Used when the player changes underneath a live session.
  function restartCurrent() {
    if (state === 'idle') return;
    kill();
    playCurrent();
  }
```

Change the play callback in `playCurrent` to accept a failure:

```js
    handle = player.play(wav, err => {
      if (mine !== epoch) return;
      handle = null;
      if (err) {
        bus.emit('fault', {scope: 'audio', index, message: String(err)});
        audioFailures++;
        // Generation failures have their own counter; a run of audio errors
        // means the output device is gone, not that one sentence is bad.
        if (audioFailures >= 3) { stop(); return; }
      } else {
        audioFailures = 0;
      }
      index++;
      if (index >= sentences.length) finish();
      else playCurrent();
    });
```

Reset `pausedAt` and `audioFailures` in `start()` and `stop()` alongside the
other counters, and add `restartCurrent` to the returned object:

```js
    start, pause, resume, next, prev, stop, toggle, togglePause, restartCurrent, setOptions,
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — the Phase 1 and 2 tests plus 7 new ones

- [ ] **Step 6: Commit**

```bash
git add src/player.mjs src/playback.mjs test/playback.test.mjs
git commit -m "Let the session really pause when its player can"
```

---

### Task 2: The remote player

Parks WAV buffers under ids, pushes commands at the desktop app, and resolves
`onEnd` when the app reports back.

**Files:**
- Create: `src/remote-player.mjs`
- Create: `test/remote-player.test.mjs`

**Interfaces:**
- Consumes: the handle shape from Task 1
- Produces:
  - `createRemotePlayer({send, wavDurationMs}) → player` where `send(cmd)` takes `{action, id?}` and `player` has `supportsPause: true`, `play`, `wavDurationMs`, `take(id) → Buffer|null`, `reportEnded(id, error?) → boolean`
  - `createPlayerRouter({local, remote, isAppConnected}) → player`

- [ ] **Step 1: Write the failing test**

Create `test/remote-player.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemotePlayer, createPlayerRouter} from '../src/remote-player.mjs';

const build = () => {
  const sent = [];
  const player = createRemotePlayer({send: c => sent.push(c), wavDurationMs: () => 1000});
  return {sent, player};
};

test('play parks the buffer and asks the app to play it', () => {
  const {sent, player} = build();
  player.play(Buffer.from('hello'), () => {});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'play');
  assert.equal(player.take(sent[0].id).toString(), 'hello');
});

test('reportEnded resolves the right handle exactly once', () => {
  const {sent, player} = build();
  let ended = 0;
  player.play(Buffer.from('a'), () => { ended++; });
  const id = sent[0].id;
  assert.equal(player.reportEnded(id), true);
  assert.equal(ended, 1);
  assert.equal(player.reportEnded(id), false, 'a repeat report is ignored');
  assert.equal(ended, 1);
});

test('an unknown id is ignored', () => {
  const {player} = build();
  assert.equal(player.reportEnded(999), false);
});

// The app may report a sentence finishing just after we moved on; acting on
// it would advance the session twice.
test('a stale report from a superseded sentence is ignored', () => {
  const {sent, player} = build();
  let first = 0, second = 0;
  player.play(Buffer.from('a'), () => { first++; });
  const firstId = sent[0].id;
  player.play(Buffer.from('b'), () => { second++; });
  assert.equal(player.reportEnded(firstId), false);
  assert.equal(first, 0);
  assert.equal(player.reportEnded(sent[1].id), true);
  assert.equal(second, 1);
});

test('the error from a failed track reaches onEnd', () => {
  const {sent, player} = build();
  let got = null;
  player.play(Buffer.from('a'), e => { got = e; });
  player.reportEnded(sent[0].id, 'decode failed');
  assert.equal(got, 'decode failed');
});

test('stop, pause and resume send commands and free the buffer', () => {
  const {sent, player} = build();
  const h = player.play(Buffer.from('a'), () => {});
  const id = sent[0].id;
  h.pause();
  h.resume();
  h.stop();
  assert.deepEqual(sent.slice(1).map(c => c.action), ['pause', 'resume', 'stop']);
  assert.equal(player.take(id), null, 'buffer released on stop');
});

test('a stopped handle goes quiet', () => {
  const {sent, player} = build();
  const h = player.play(Buffer.from('a'), () => {});
  h.stop();
  const after = sent.length;
  h.pause();
  h.resume();
  assert.equal(sent.length, after, 'a dead handle sends nothing');
});

test('the remote player can pause', () => {
  const {player} = build();
  assert.equal(player.supportsPause, true);
});

// --- router ---

const routerParts = () => {
  const calls = [];
  const fake = name => ({
    supportsPause: name === 'remote',
    wavDurationMs: () => 42,
    play(wav, onEnd) { calls.push(name); return {stop() {}, pause() {}, resume() {}}; },
  });
  return {calls, local: fake('local'), remote: fake('remote')};
};

test('the router uses the remote player only while an app is connected', () => {
  const {calls, local, remote} = routerParts();
  let connected = false;
  const router = createPlayerRouter({local, remote, isAppConnected: () => connected});

  router.play(Buffer.from('x'), () => {});
  assert.deepEqual(calls, ['local']);
  assert.equal(router.supportsPause, false);

  connected = true;
  router.play(Buffer.from('x'), () => {});
  assert.deepEqual(calls, ['local', 'remote']);
  assert.equal(router.supportsPause, true, 'read live, not captured at construction');
});

test('the router exposes a duration function', () => {
  const {local, remote} = routerParts();
  const router = createPlayerRouter({local, remote, isAppConnected: () => false});
  assert.equal(router.wavDurationMs(Buffer.alloc(0)), 42);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --test-timeout=15000 test/remote-player.test.mjs`
Expected: FAIL — `Cannot find module '.../src/remote-player.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/remote-player.mjs`:

```js
// Playing audio in the desktop app's process instead of a spawned afplay.
//
// The server still owns the queue, the index and the state — this is only an
// output device that happens to live in another process. It parks a WAV under
// an id, asks the app to play that id, and resolves the session's callback
// when the app reports the track finished.
//
// Ids matter: the app can report a sentence finishing just after the session
// moved on, and acting on that would advance the session twice.

export function createRemotePlayer({send, wavDurationMs}) {
  let nextId = 1;
  const parked = new Map(); // id -> {wav, onEnd}
  let current = null;       // the only id whose report we will act on

  function play(wav, onEnd) {
    const id = nextId++;
    parked.set(id, {wav, onEnd});
    current = id;
    send({action: 'play', id});

    const alive = () => current === id;
    return {
      stop() {
        parked.delete(id);
        if (!alive()) return;
        current = null;
        send({action: 'stop'});
      },
      pause() { if (alive()) send({action: 'pause'}); },
      resume() { if (alive()) send({action: 'resume'}); },
    };
  }

  // The app fetches the audio it was asked to play.
  const take = id => parked.get(id)?.wav ?? null;

  // Returns whether the report was acted on, so the route can 404 a report
  // for something we are no longer waiting on.
  function reportEnded(id, error) {
    const entry = parked.get(Number(id));
    parked.delete(Number(id));
    if (!entry || current !== Number(id)) return false;
    current = null;
    entry.onEnd(error);
    return true;
  }

  return {supportsPause: true, play, wavDurationMs, take, reportEnded};
}

// Picks a player per utterance. `supportsPause` is a getter rather than a
// value because the desktop app can come and go while a session is running.
export function createPlayerRouter({local, remote, isAppConnected}) {
  const active = () => (isAppConnected() ? remote : local);
  return {
    get supportsPause() { return active().supportsPause; },
    wavDurationMs: wav => local.wavDurationMs(wav),
    play: (wav, onEnd) => active().play(wav, onEnd),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/remote-player.mjs test/remote-player.test.mjs
git commit -m "Add a remote player that hands audio to the desktop app"
```

---

### Task 3: Audio endpoints and player selection

Wires the remote player into the HTTP surface and tracks whether a desktop
app is attached.

**Files:**
- Modify: `src/routes.mjs`
- Modify: `server.mjs`
- Modify: `test/routes.test.mjs`

**Interfaces:**
- Consumes: `createRemotePlayer`, `createPlayerRouter` (Task 2), `session.restartCurrent` (Task 1)
- Produces:
  - `GET /api/audio/:id` → `audio/wav`, or 404
  - `POST /api/audio/:id/ended` with optional `{error}` → `{ok}` or 404
  - SSE `event: audio` carrying `{action, id?}`
  - `GET /api/playback/events?client=app` registers a desktop client
  - `createRoutes` gains `remote` and `appClients` parameters

- [ ] **Step 1: Write the failing test**

Add to `test/routes.test.mjs`. Replace the `harness()` body's session line and
add the remote wiring — the whole harness becomes:

```js
function harness() {
  const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-test-')), 'config.json');
  const engine = {
    split: t => t.split('|').map(s => s.trim()).filter(Boolean),
    generate: async t => Buffer.from(t),
  };
  const player = {
    current: null,
    supportsPause: false,
    wavDurationMs: () => 1000,
    play(wav, onEnd) { player.current = {wav, onEnd}; return {stop() { player.current = null; }, pause() {}, resume() {}}; },
    finish() { const c = player.current; player.current = null; c.onEnd(); },
    available: () => true,
  };
  const sseBus = new EventEmitter();
  const remote = createRemotePlayer({send: c => sseBus.emit('audio', c), wavDurationMs: player.wavDurationMs});
  const appClients = {count: 0};
  const routed = createPlayerRouter({local: player, remote, isAppConnected: () => appClients.count > 0});
  const session = createSession({engine, player: routed});
  const tts = {
    split: engine.split,
    generate: engine.generate,
    isLoaded: () => true,
    load: async () => {},
    events: new EventEmitter(),
  };
  const server = http.createServer(createRoutes({
    session, tts, voices, config, player, remote, appClients, sseBus,
    configFile: cfgFile,
    activePort: 8789,
    audioOut: true,
  }));
  return {server, session, player, remote, appClients, cfgFile};
}
```

Add `import {createRemotePlayer, createPlayerRouter} from '../src/remote-player.mjs';`
to the top of the file, then these tests:

```js
test('audio parked by the remote player is served, then gone', async t => {
  const {server, remote} = harness();
  const port = await listen(server);
  t.after(() => stop(server));

  // Each harness gets a fresh remote player, so the first id is 1.
  remote.play(Buffer.from('RIFFfake'), () => {});
  const res = await fetch(`http://127.0.0.1:${port}/api/audio/1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /audio\/wav/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'RIFFfake');
});

test('an unknown audio id is a 404', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  assert.equal((await call(port, 'GET', '/api/audio/999')).status, 404);
});

test('reporting a track ended advances the session', async t => {
  const {server, session, appClients} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  appClients.count = 1;                       // pretend the desktop app is attached
  await call(port, 'POST', '/api/speak', {text: 'one|two'});
  await settle();
  assert.equal(session.getState().index, 0);
  const ended = await call(port, 'POST', '/api/audio/1/ended', {});
  assert.equal(ended.status, 200);
  await settle();
  assert.equal(session.getState().index, 1);
});

test('a report for a track we are not waiting on is a 404', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  assert.equal((await call(port, 'POST', '/api/audio/42/ended', {})).status, 404);
});

test('an app client is counted while its feed is open', async t => {
  const {server, appClients} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  assert.equal(appClients.count, 0);
  const res = await fetch(`http://127.0.0.1:${port}/api/playback/events?client=app`);
  const reader = res.body.getReader();
  await readFrame(reader);
  assert.equal(appClients.count, 1);
  await reader.cancel();
});

test('a browser client is not counted as an app', async t => {
  const {server, appClients} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const res = await fetch(`http://127.0.0.1:${port}/api/playback/events`);
  const reader = res.body.getReader();
  await readFrame(reader);
  assert.equal(appClients.count, 0);
  await reader.cancel();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --test-timeout=15000 test/routes.test.mjs`
Expected: FAIL — `/api/audio/1` 404s and `appClients.count` stays 0

- [ ] **Step 3: Implement the routes**

In `src/routes.mjs`, extend the signature:

```js
export function createRoutes({
  session, tts, voices, config, player,
  remote, appClients = {count: 0}, sseBus,
  configFile = config.CONFIG_PATH,
  activePort,
  audioOut = player.available(),
}) {
```

After the existing `tts.events?.on(...)` line, forward audio commands:

```js
  // Audio commands ride the same feed as everything else; a browser client
  // simply has no listener for them.
  sseBus?.on('audio', cmd => push('audio', cmd));
```

In `events(req, res)`, register app clients. Change the signature to take the
parsed URL and add, right after `clients.add(res)`:

```js
    const isApp = url.searchParams.get('client') === 'app';
    if (isApp) appClients.count++;
```

and in the close handler:

```js
    req.on('close', () => {
      clients.delete(res);
      if (!isApp) return;
      appClients.count = Math.max(0, appClients.count - 1);
      // The app was the output device; without it the current sentence has
      // nowhere to go, so restart it on the local player.
      if (appClients.count === 0) session.restartCurrent();
    });
```

Update the call site to pass the URL: `if (GET && p === '/api/playback/events') return events(req, res, url);`
and the definition to `function events(req, res, url) {`.

Add the audio routes next to the playback ones:

```js
    if (GET && p.startsWith('/api/audio/')) {
      const id = Number(p.slice('/api/audio/'.length));
      const wav = remote?.take(id);
      if (!wav) return send(res, 404, {error: 'No such audio.'});
      return send(res, 200, wav);
    }
    if (POST && /^\/api\/audio\/\d+\/ended$/.test(p)) {
      const id = Number(p.split('/')[3]);
      return readBody(req).then(body => {
        const acted = remote?.reportEnded(id, body.error);
        send(res, acted ? 200 : 404, acted ? {ok: true} : {error: 'Not waiting on that audio.'});
      }).catch(e => send(res, 400, {error: e.message}));
    }
```

- [ ] **Step 4: Wire it up in server.mjs**

Replace the session construction block in `server.mjs` with:

```js
import {EventEmitter} from 'node:events';
import {createRemotePlayer, createPlayerRouter} from './src/remote-player.mjs';

// ...

// Audio output can live in this process (afplay) or in the desktop app
// (rodio). The session neither knows nor cares which.
const sseBus = new EventEmitter();
const remote = createRemotePlayer({
  send: cmd => sseBus.emit('audio', cmd),
  wavDurationMs: player.wavDurationMs,
});
const appClients = {count: 0};
const routedPlayer = createPlayerRouter({
  local: player,
  remote,
  isAppConnected: () => appClients.count > 0,
});

const session = createSession({engine: tts, player: routedPlayer});
const audioOut = player.available();
if (!audioOut) console.warn('chirp: no system audio player found — /api/speak needs the desktop app to be audible');

const server = http.createServer(createRoutes({
  session, tts, voices, config, player, remote, appClients, sseBus,
  activePort: PORT, audioOut,
}));
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — all suites

- [ ] **Step 6: Check it by hand**

```bash
npm start &
curl -s -XPOST localhost:8789/api/speak -H 'content-type: application/json' -d '{"text":"Still audible with no desktop app."}'
```

Audio must still come out of the speakers through `afplay` — no desktop app
is connected, so the router chose the local player.

- [ ] **Step 7: Commit**

```bash
git add src/routes.mjs server.mjs test/routes.test.mjs
git commit -m "Serve audio to the desktop app and route between players"
```

---

### Task 4: The rodio audio module

**Files:**
- Create: `src-tauri/src/audio.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `audio::Command` enum with `Play(u64)`, `Pause`, `Resume`, `Stop`
  - `audio::parse_command(&serde_json::Value) → Option<Command>`
  - `audio::Audio::new() → Result<Audio, String>`
  - `Audio::{play_bytes(Vec<u8>) → Result<(), String>, pause(), resume(), stop(), finished() → bool}`

- [ ] **Step 1: Add the dependency**

```bash
cd src-tauri && cargo add rodio@0.22 --no-default-features --features playback,wav
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/audio.rs` containing only the command type and its
tests for now:

```rust
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
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd src-tauri && cargo test --lib audio`
Expected: FAIL — `Command` and `parse_command` do not exist

- [ ] **Step 4: Write the implementation**

Put this above the test module in `src-tauri/src/audio.rs`:

```rust
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
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS — the Phase 2 tests plus 2 new ones

Note: `Audio::new()` is not unit-tested; it needs a real output device.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/audio.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Add a rodio audio module for in-process playback"
```

---

### Task 5: Connect the app as the output device

**Files:**
- Modify: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `audio::{Audio, Command, parse_command}` (Task 4), `GET /api/audio/:id` and `POST /api/audio/:id/ended` (Task 3)
- Produces: nothing consumed later

- [ ] **Step 1: Parse the audio event**

In `src-tauri/src/events.rs`, add to the `Event` enum:

```rust
    Audio(serde_json::Value),
```

and to `parse_frame`:

```rust
        "audio" => serde_json::from_str::<serde_json::Value>(payload)
            .ok()
            .map(Event::Audio),
```

Add a test to that file's test module:

```rust
    #[test]
    fn parses_an_audio_frame() {
        let f = parse_frame("audio", r#"{"action":"play","id":3}"#);
        let Some(Event::Audio(v)) = f else {
            panic!("expected an audio event")
        };
        assert_eq!(v.get("action").unwrap(), "play");
    }
```

- [ ] **Step 2: Connect as an app client**

In `src-tauri/src/events.rs`, change the feed URL in `pump`:

```rust
    let res = ureq::get(format!("{base_url}/api/playback/events?client=app")).call()?;
```

This is what makes the server route audio to us rather than to `afplay`.

- [ ] **Step 3: Handle the commands**

In `src-tauri/src/lib.rs` add `mod audio;` and:

```rust
// The audio device, opened once. None if the machine has no output device,
// in which case the server keeps using its own player.
static AUDIO: OnceLock<Option<audio::Audio>> = OnceLock::new();

fn audio() -> Option<&'static audio::Audio> {
    AUDIO
        .get_or_init(|| match audio::Audio::new() {
            Ok(a) => Some(a),
            Err(e) => {
                eprintln!("chirp: {e}; falling back to the server's player");
                None
            }
        })
        .as_ref()
}

// rodio has no end-of-track callback, so a track's completion is polled and
// reported back. The id is carried so the server can ignore a report that
// arrives after it has already moved on.
fn play_and_report(id: u64) {
    std::thread::spawn(move || {
        let Some(a) = audio() else { return };
        let outcome = ureq::get(format!("{}/api/audio/{}", base_url(), id))
            .call()
            .map_err(|e| format!("could not fetch audio: {e}"))
            .and_then(|res| {
                res.into_body()
                    .read_to_vec()
                    .map_err(|e| format!("could not read audio: {e}"))
            })
            .and_then(|bytes| a.play_bytes(bytes));

        if let Err(e) = outcome {
            report_ended(id, Some(e));
            return;
        }
        // Poll until it drains. 50ms is inaudible at a sentence boundary and
        // costs nothing.
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if a.finished() {
                report_ended(id, None);
                return;
            }
        }
    });
}

fn report_ended(id: u64, error: Option<String>) {
    let body = match error {
        Some(e) => serde_json::json!({"error": e}),
        None => serde_json::json!({}),
    };
    let _ = ureq::post(format!("{}/api/audio/{}/ended", base_url(), id)).send_json(body);
}

fn handle_audio(value: &serde_json::Value) {
    let Some(cmd) = audio::parse_command(value) else {
        return;
    };
    match cmd {
        audio::Command::Play(id) => play_and_report(id),
        audio::Command::Pause => {
            if let Some(a) = audio() {
                a.pause()
            }
        }
        audio::Command::Resume => {
            if let Some(a) = audio() {
                a.resume()
            }
        }
        audio::Command::Stop => {
            if let Some(a) = audio() {
                a.stop()
            }
        }
    }
}
```

There is a subtlety in `play_and_report`: a `Stop` followed by a new `Play`
leaves the old polling thread running, and it will see `finished()` become
true and report an end for a superseded id. That is exactly what the remote
player's id check exists for — the stale report is ignored. Do not add
cancellation machinery for it.

Add the dispatch arm to the `events::listen` handler:

```rust
                events::Event::Audio(value) => handle_audio(&value),
```

- [ ] **Step 4: Compile and test**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS, no warnings about unused variants

- [ ] **Step 5: Verify by hand — this is the payoff**

Build and run: `npm run tauri build -- --bundles app && open src-tauri/target/release/bundle/macos/Chirp.app`

1. `curl -s -XPOST localhost:8789/api/speak -H 'content-type: application/json' -d '{"text":"A reasonably long first sentence to pause inside. A second sentence follows it. And a third."}'`
2. Mid-way through the first sentence: `curl -s -XPOST localhost:8789/api/playback/pause`
3. `curl -s -XPOST localhost:8789/api/playback/resume` → **the audio continues from where it stopped**, not from the start of the sentence. This is the headline result.
4. `ls /tmp/chirp-*.wav` → no files while the desktop app is running.
5. Quit Chirp from the tray mid-read → the read continues through `afplay`.
6. Open Control Centre during playback → does it show **Chirp**? Press the keyboard play/pause key → does it pause? **If not, record what appeared and stop.**

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/audio.rs src-tauri/src/events.rs src-tauri/src/lib.rs
git commit -m "Play audio in the app's own process"
```

---

### Task 6: Linux CI and documentation

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`

- [ ] **Step 1: Add the ALSA headers**

`rodio` pulls `alsa-sys`, which needs ALSA development headers at build time.
In `.github/workflows/release.yml`, add `libasound2-dev` to the existing
`apt-get install` line for `ubuntu-22.04`:

```yaml
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev
```

- [ ] **Step 2: Update the README**

In the Notes section, replace the sentence about sentence-granular pause with
a description of the real behaviour: with the desktop app running, pause stops
mid-word and resume continues from that point; running the server alone still
uses the system player, where pause replays the current sentence.

In "Known limitations", delete the Now Playing entry **only if Task 5 Step 5
verified it working**. If it did not bind, replace the explanation with what
was actually observed — the audio-ownership theory will have been disproved
and that is worth recording. Leave the Services entry as it is.

- [ ] **Step 3: Run everything**

Run: `npm test` — all suites pass
Run: `cd src-tauri && cargo test --lib` — all suites pass

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "Add ALSA headers to the Linux build; document real pause"
```

---

## Verification against the spec

- [ ] Pause mid-sentence, then resume: audio continues from where it stopped (Task 5 Step 5).
- [ ] No `chirp-*.wav` files appear in the temp directory while the desktop app is running.
- [ ] `npm start` with the desktop app quit still speaks through `/api/speak` (Task 3 Step 6).
- [ ] Quitting the desktop app mid-read continues the read through `afplay`.
- [ ] Control Centre shows Chirp, and the media key controls it — or a recorded negative result.
- [ ] `npm test` and `cargo test` pass without the model or an audio device.
