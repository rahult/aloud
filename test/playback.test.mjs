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
