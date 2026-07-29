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
