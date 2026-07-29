// The playback session: the single source of truth for what is being spoken
// and where we are in it.
//
// Before this existed, playback state lived in three places at once — an
// AtomicBool in Rust, a child-process handle in Node, and audio element
// bookkeeping in the browser — with nothing reconciling them. The hotkey and
// the tray now ask this object, and it is the only thing that knows.
//
// Audio is produced one sentence at a time, which gives three things at once:
// audio starts after the first sentence rather than the whole document,
// skip/prev have somewhere to land, and pause has a boundary.
//
// How pause behaves depends on the player. The OS players (afplay, aplay,
// PowerShell) cannot pause a running file, so with them pausing stops between
// sentences and resuming replays the current one. A player that reports
// `supportsPause` — the desktop app's in-process one — is paused where it
// stands and resumes from there.

import {EventEmitter} from 'node:events';

export function createSession({engine, player, lookahead = 3, cacheLimit = 50}) {
  const bus = new EventEmitter();

  let sentences = [];
  let index = 0;
  let state = 'idle';
  let voice;
  let speed;
  let startedAt = 0;
  let durationMs = 0;
  let failures = 0;
  let pausedAt = 0;
  let audioFailures = 0;

  let cache = new Map();    // index → WAV buffer
  let pending = new Map();  // index → Promise<Buffer>
  let handle = null;        // live player handle
  // Bumped by every control action. Async work captures it and bails if it
  // changed, so a generation in flight can never resurrect a stale sentence.
  let epoch = 0;

  const getState = () => ({
    state, index, count: sentences.length, voice, speed, startedAt, durationMs,
  });
  const getSentences = () => [...sentences];
  const emit = () => bus.emit('state', getState());

  function trim() {
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }

  function ensure(i) {
    if (i < 0 || i >= sentences.length) return null;
    if (cache.has(i)) return Promise.resolve(cache.get(i));
    if (pending.has(i)) return pending.get(i);
    const p = engine.generate(sentences[i], {voice, speed})
      .then(wav => { pending.delete(i); cache.set(i, wav); trim(); return wav; })
      .catch(e => { pending.delete(i); throw e; });
    pending.set(i, p);
    return p;
  }

  function prefetch() {
    for (let i = index + 1; i <= index + lookahead && i < sentences.length; i++) {
      ensure(i)?.catch(() => {});   // failures surface when we reach the sentence
    }
  }

  function kill() {
    epoch++;
    if (handle) { handle.stop(); handle = null; }
  }

  function finish() {
    kill();
    state = 'idle';
    index = sentences.length;   // transcript reads as fully spoken
    startedAt = 0;
    durationMs = 0;
    emit();
  }

  async function playCurrent() {
    const mine = epoch;
    if (index >= sentences.length) return finish();

    state = 'speaking';
    emit();

    let wav;
    try {
      wav = await ensure(index);
    } catch (e) {
      if (mine !== epoch) return;
      bus.emit('fault', {scope: 'generate', index, message: e.message});
      failures++;
      // One unspeakable sentence must not end a long read; a run of them means
      // something is actually broken.
      if (failures >= 3) { stop(); return; }
      index++;
      return playCurrent();
    }
    if (mine !== epoch) return;

    failures = 0;
    prefetch();

    startedAt = Date.now();
    durationMs = player.wavDurationMs(wav);
    emit();

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
  }

  function start(text, options = {}) {
    kill();
    sentences = engine.split(text);
    voice = options.voice ?? voice;
    speed = options.speed ?? speed;
    cache = new Map();
    pending = new Map();
    index = 0;
    failures = 0;
    audioFailures = 0;
    pausedAt = 0;
    startedAt = 0;
    durationMs = 0;

    if (sentences.length === 0) {
      state = 'idle';
      emit();
      return {count: 0};
    }
    bus.emit('sentences', {sentences: getSentences(), voice, speed});
    playCurrent();
    return {count: sentences.length};
  }

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

  function next() {
    if (state === 'idle') return;
    kill();
    index++;
    if (index >= sentences.length) finish();
    else playCurrent();
  }

  function prev() {
    if (state === 'idle') return;
    kill();
    index = Math.max(0, index - 1);
    playCurrent();
  }

  function stop() {
    kill();
    sentences = [];
    cache = new Map();
    pending = new Map();
    index = 0;
    failures = 0;
    audioFailures = 0;
    pausedAt = 0;
    state = 'idle';
    startedAt = 0;
    durationMs = 0;
    emit();
  }

  // The hotkey's whole contract. 'need_text' tells the caller to go capture
  // something to say — it must not pay that cost speculatively, because
  // capturing a selection has side effects.
  function toggle() {
    if (state === 'speaking') { stop(); return 'stopped'; }
    if (state === 'paused') { resume(); return 'resumed'; }
    return 'need_text';
  }

  // The tray's play/pause button. Distinct from toggle(): it never starts a
  // new session, only suspends and resumes the current one — a menu item
  // labelled "Pause" must not start speaking your clipboard.
  function togglePause() {
    if (state === 'speaking') { pause(); return 'paused'; }
    if (state === 'paused') { resume(); return 'resumed'; }
    return 'idle';
  }

  // Voice or speed changed under a live session: everything cached was made
  // with the old settings, so drop it and re-speak from where we are.
  function setOptions({voice: nextVoice, speed: nextSpeed} = {}) {
    if (nextVoice !== undefined) voice = nextVoice;
    if (nextSpeed !== undefined) speed = nextSpeed;
    cache = new Map();
    pending = new Map();
    if (state === 'speaking') { kill(); playCurrent(); }
    else if (state === 'paused') { kill(); emit(); }
    else emit();
  }

  return {
    start, pause, resume, next, prev, stop, toggle, togglePause, restartCurrent, setOptions,
    getState, getSentences,
    on: (e, fn) => bus.on(e, fn),
    off: (e, fn) => bus.off(e, fn),
  };
}
