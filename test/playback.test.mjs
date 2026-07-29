import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../src/playback.mjs';

// Let queued promise callbacks run. Generation is faked as instant, but it
// still resolves through the microtask queue.
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};

function fakeEngine({failOn = () => false} = {}) {
  const calls = [];
  return {
    calls,
    split: text => text.split('|').map(s => s.trim()).filter(Boolean),
    async generate(text, opts) {
      calls.push({text, ...opts});
      if (failOn(text)) throw new Error(`cannot say ${text}`);
      return Buffer.from(text);
    },
  };
}

function fakePlayer() {
  const p = {current: null, stops: 0, played: []};
  p.play = (wav, onEnd) => {
    p.current = {wav, onEnd};
    p.played.push(wav.toString());
    return {stop() { p.stops++; if (p.current?.wav === wav) p.current = null; }};
  };
  p.wavDurationMs = () => 1000;
  // Simulate the audio running to its natural end.
  p.finish = () => { const c = p.current; p.current = null; c.onEnd(); };
  return p;
}

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

const build = engineOpts => {
  const engine = fakeEngine(engineOpts);
  const player = fakePlayer();
  return {engine, player, session: createSession({engine, player})};
};

test('a new session is idle', () => {
  const {session} = build();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.getState().count, 0);
});

test('start splits the text and plays the first sentence', async () => {
  const {session, player} = build();
  assert.equal(session.start('one|two|three', {voice: 'af_heart', speed: 1}).count, 3);
  await settle();
  assert.equal(session.getState().state, 'speaking');
  assert.equal(session.getState().index, 0);
  assert.deepEqual(player.played, ['one']);
});

test('sentences advance on their own as each finishes', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  player.finish();
  await settle();
  assert.equal(session.getState().index, 1);
  assert.deepEqual(player.played, ['one', 'two']);
});

test('generation runs ahead of playback', async () => {
  const {session, engine} = build();
  session.start('a|b|c|d|e|f|g', {voice: 'af_heart', speed: 1});
  await settle();
  // Sentence 0 plus a bounded lookahead — not the whole document.
  assert.ok(engine.calls.length >= 2, `generated ${engine.calls.length}`);
  assert.ok(engine.calls.length < 7, `generated ${engine.calls.length}, expected a bounded lookahead`);
});

test('generate is called with the session voice and speed', async () => {
  const {session, engine} = build();
  session.start('one', {voice: 'bm_george', speed: 1.5});
  await settle();
  assert.equal(engine.calls[0].voice, 'bm_george');
  assert.equal(engine.calls[0].speed, 1.5);
});

test('pause stops the player and holds the index', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  assert.equal(session.getState().state, 'paused');
  assert.equal(session.getState().index, 0);
  assert.equal(player.stops, 1);
});

test('resume replays the sentence it paused on', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  session.resume();
  await settle();
  assert.equal(session.getState().state, 'speaking');
  assert.deepEqual(player.played, ['one', 'one']);
});

test('next skips forward', async () => {
  const {session, player} = build();
  session.start('one|two|three', {voice: 'af_heart', speed: 1});
  await settle();
  session.next();
  await settle();
  assert.equal(session.getState().index, 1);
  assert.deepEqual(player.played, ['one', 'two']);
});

test('prev goes back and does not run off the start', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.prev();
  await settle();
  assert.equal(session.getState().index, 0);
});

test('next past the last sentence finishes the session', async () => {
  const {session} = build();
  session.start('one', {voice: 'af_heart', speed: 1});
  await settle();
  session.next();
  await settle();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.getState().index, 1, 'index rests at count so the transcript reads as fully spoken');
});

test('stop clears the session', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.stop();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.getState().index, 0);
  assert.equal(session.getState().count, 0);
});

test('a sentence that will not generate is skipped, not fatal', async () => {
  const {session, player} = build({failOn: t => t === 'two'});
  const faults = [];
  session.on('fault', f => faults.push(f));
  session.start('one|two|three', {voice: 'af_heart', speed: 1});
  await settle();
  player.finish();
  await settle(16);
  assert.equal(faults.length, 1);
  assert.equal(faults[0].index, 1);
  assert.deepEqual(player.played, ['one', 'three']);
});

test('three consecutive failures stop the session', async () => {
  const {session} = build({failOn: () => true});
  session.start('a|b|c|d|e', {voice: 'af_heart', speed: 1});
  await settle(24);
  assert.equal(session.getState().state, 'idle');
});

test('changing voice mid-session restarts the current sentence with it', async () => {
  const {session, engine, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.setOptions({voice: 'bf_emma'});
  await settle();
  assert.equal(session.getState().voice, 'bf_emma');
  assert.equal(session.getState().index, 0, 'position is preserved');
  assert.equal(engine.calls.at(-1).voice, 'bf_emma');
  assert.deepEqual(player.played.slice(-1), ['one']);
});

test('starting a new session while speaking replaces the old one', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.start('alpha', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(session.getState().count, 1);
  assert.equal(session.getState().index, 0);
  assert.deepEqual(player.played.at(-1), 'alpha');
});

test('start with no speakable text stays idle', async () => {
  const {session} = build();
  assert.equal(session.start('   |  ', {voice: 'af_heart', speed: 1}).count, 0);
  await settle();
  assert.equal(session.getState().state, 'idle');
});

test('state events carry timing for the progress bar', async () => {
  const {session} = build();
  const seen = [];
  session.on('state', s => seen.push(s));
  session.start('one', {voice: 'af_heart', speed: 1});
  await settle();
  const last = seen.at(-1);
  assert.equal(last.durationMs, 1000);
  assert.ok(last.startedAt > 0);
});

test('a sentences event fires once per start', async () => {
  const {session} = build();
  const seen = [];
  session.on('sentences', s => seen.push(s));
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].sentences, ['one', 'two']);
});

// --- toggle: the hotkey contract ---

test('toggle on an idle session asks for text', () => {
  const {session} = build();
  assert.equal(session.toggle(), 'need_text');
});

test('toggle while speaking stops', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(session.toggle(), 'stopped');
  assert.equal(session.getState().state, 'idle');
});

test('toggle while paused resumes', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  assert.equal(session.toggle(), 'resumed');
  assert.equal(session.getState().state, 'speaking');
});

// REGRESSION: on main, Rust's PLAYING flag stayed true after audio ended on
// its own, so the next hotkey press POSTed /api/stop against a server with
// nothing to stop and returned early — swallowing the press. With the server
// owning the state, a session that ended naturally is idle, and toggle asks
// for text rather than reporting a stop.
test('after playing to its natural end, toggle asks for text (not "stopped")', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  player.finish();          // sentence one ends
  await settle();
  player.finish();          // sentence two ends — session is over
  await settle();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.toggle(), 'need_text', 'the next hotkey press must speak, not be swallowed');
});

test('togglePause suspends and resumes but never starts a session', async () => {
  const {session} = build();
  assert.equal(session.togglePause(), 'idle', 'nothing to pause when idle');
  assert.equal(session.getState().state, 'idle', 'and it must not start speaking');
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(session.togglePause(), 'paused');
  assert.equal(session.getState().state, 'paused');
  assert.equal(session.togglePause(), 'resumed');
  assert.equal(session.getState().state, 'speaking');
});

// --- Phase 3: a player that can really pause ---

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
  const {session, player} = build();
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
  player.current.onEnd('device went away');
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
