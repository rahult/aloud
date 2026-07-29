import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createRoutes} from '../src/routes.mjs';
import {createRemotePlayer, createPlayerRouter} from '../src/remote-player.mjs';
import {createSession} from '../src/playback.mjs';
import * as voices from '../src/voices.mjs';
import * as config from '../src/config.mjs';

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

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

const stop = server => { server.closeAllConnections(); server.close(); };
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? {'Content-Type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return {status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer()};
}

test('GET /api/voices lists all 28 with grades', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {status, body} = await call(port, 'GET', '/api/voices');
  assert.equal(status, 200);
  assert.equal(body.length, 28);
  assert.ok('grade' in body[0] && 'recommended' in body[0]);
});

test('GET /api/health reports model and audio availability', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {body} = await call(port, 'GET', '/api/health');
  assert.equal(body.ok, true);
  assert.equal(body.modelLoaded, true);
  assert.equal(body.audioOut, true);
});

test('POST /api/speak starts a session', async t => {
  const {server, session} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {status, body} = await call(port, 'POST', '/api/speak', {text: 'one|two'});
  assert.equal(status, 200);
  assert.equal(body.count, 2);
  await settle();
  assert.equal(session.getState().state, 'speaking');
});

test('POST /api/speak has no character cap', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {status} = await call(port, 'POST', '/api/speak', {text: 'x.'.repeat(5000)});
  assert.equal(status, 200);
});

test('POST /api/tts keeps its cap so the WAV stays bounded', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {status, body} = await call(port, 'POST', '/api/tts', {text: 'x'.repeat(2001)});
  assert.equal(status, 400);
  assert.match(body.error, /too long/);
});

test('POST /api/speak rejects empty text', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {status} = await call(port, 'POST', '/api/speak', {text: '   '});
  assert.equal(status, 400);
});

test('toggle reports need_text when idle and stopped when speaking', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  assert.equal((await call(port, 'POST', '/api/playback/toggle')).body.action, 'need_text');
  await call(port, 'POST', '/api/speak', {text: 'one|two'});
  await settle();
  assert.equal((await call(port, 'POST', '/api/playback/toggle')).body.action, 'stopped');
});

// REGRESSION, over HTTP this time: the hotkey path must not be swallowed
// after a session ends on its own.
test('toggle asks for text after the session ends naturally', async t => {
  const {server, player} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  await call(port, 'POST', '/api/speak', {text: 'only one'});
  await settle();
  player.finish();
  await settle();
  assert.equal((await call(port, 'POST', '/api/playback/toggle')).body.action, 'need_text');
});

test('GET /api/playback reports the live state', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  await call(port, 'POST', '/api/speak', {text: 'one|two'});
  await settle();
  const {body} = await call(port, 'GET', '/api/playback');
  assert.equal(body.state, 'speaking');
  assert.equal(body.count, 2);
  assert.deepEqual(body.sentences, ['one', 'two']);
});

test('the playback transport endpoints move the index', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  await call(port, 'POST', '/api/speak', {text: 'one|two|three'});
  await settle();
  await call(port, 'POST', '/api/playback/next');
  await settle();
  assert.equal((await call(port, 'GET', '/api/playback')).body.index, 1);
  await call(port, 'POST', '/api/playback/prev');
  await settle();
  assert.equal((await call(port, 'GET', '/api/playback')).body.index, 0);
  await call(port, 'POST', '/api/playback/pause');
  assert.equal((await call(port, 'GET', '/api/playback')).body.state, 'paused');
});

test('settings round-trip voice and speed', async t => {
  const {server, cfgFile} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const saved = await call(port, 'POST', '/api/settings', {voice: 'bm_george', speed: 1.5});
  assert.equal(saved.status, 200);
  const got = await call(port, 'GET', '/api/settings');
  assert.equal(got.body.voice, 'bm_george');
  assert.equal(got.body.speed, 1.5);
  assert.match(fs.readFileSync(cfgFile, 'utf8'), /bm_george/);
});

test('settings reject an unknown voice', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {status, body} = await call(port, 'POST', '/api/settings', {voice: 'nope'});
  assert.equal(status, 400);
  assert.match(body.error, /Unknown voice/);
});

// This is the second bug: the hotkey path used to hardcode af_heart at 1x,
// ignoring whatever the user had chosen.
test('speak with no voice uses the saved voice, not a hardcoded default', async t => {
  const {server, session} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  await call(port, 'POST', '/api/settings', {voice: 'bm_george', speed: 1.25});
  await call(port, 'POST', '/api/speak', {text: 'hello'});
  await settle();
  assert.equal(session.getState().voice, 'bm_george');
  assert.equal(session.getState().speed, 1.25);
});

test('CORS preflight is answered', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const res = await fetch(`http://127.0.0.1:${port}/api/tts`, {method: 'OPTIONS'});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('the SSE feed opens and pushes a state frame', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const res = await fetch(`http://127.0.0.1:${port}/api/playback/events`);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/);
  await reader.cancel();
});

test('unknown paths 404', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  assert.equal((await call(port, 'GET', '/api/nope')).status, 404);
});

// Reading an SSE stream blocks until a frame arrives, so every read is raced
// against a timer — otherwise a missing event hangs the whole suite instead
// of failing it.
const readFrame = async (reader, ms = 1500) => {
  let id;
  const timer = new Promise(r => { id = setTimeout(() => r({timeout: true}), ms); });
  const got = await Promise.race([reader.read(), timer]);
  clearTimeout(id);
  if (got.timeout || got.done) return '';
  return new TextDecoder().decode(got.value);
};

test('app-command relays to the SSE feed for the native layer', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));

  const res = await fetch(`http://127.0.0.1:${port}/api/playback/events`);
  const reader = res.body.getReader();
  await readFrame(reader);                              // opening frames

  const posted = await call(port, 'POST', '/api/app-command', {name: 'request-accessibility'});
  assert.equal(posted.status, 200);

  let seen = '';
  for (let i = 0; i < 4 && !seen.includes('event: command'); i++) seen += await readFrame(reader);
  assert.match(seen, /event: command/);
  assert.match(seen, /request-accessibility/);
  await reader.cancel();
});

test('app-command rejects an unknown command', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  const {status} = await call(port, 'POST', '/api/app-command', {name: 'rm -rf /'});
  assert.equal(status, 400);
});

test('native-status is reported back through settings', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  assert.equal((await call(port, 'GET', '/api/settings')).body.accessibilityOk, null);
  await call(port, 'POST', '/api/native-status', {accessibilityOk: false});
  assert.equal((await call(port, 'GET', '/api/settings')).body.accessibilityOk, false);
  await call(port, 'POST', '/api/native-status', {accessibilityOk: true});
  assert.equal((await call(port, 'GET', '/api/settings')).body.accessibilityOk, true);
});

test('settings expose the input mode', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => stop(server));
  assert.equal((await call(port, 'GET', '/api/settings')).body.input, 'selection');
  await call(port, 'POST', '/api/settings', {input: 'clipboard'});
  assert.equal((await call(port, 'GET', '/api/settings')).body.input, 'clipboard');
});

// --- Phase 3: audio handed to the desktop app ---

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
