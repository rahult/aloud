import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS, resolve, applyPatch} from '../src/config.mjs';

const ok = r => { assert.equal(r.error, undefined, r.error); return r.cfg; };

test('resolve layers stored values over defaults', () => {
  assert.deepEqual(resolve({}), DEFAULTS);
  assert.equal(resolve({voice: 'bm_george'}).voice, 'bm_george');
  assert.equal(resolve({voice: 'bm_george'}).speed, 1);
});

test('applyPatch stores a valid port', () => {
  assert.equal(ok(applyPatch({}, {port: 9000})).port, 9000);
});

test('applyPatch rejects ports outside 1024-65535', () => {
  assert.match(applyPatch({}, {port: 80}).error, /between 1024 and 65535/);
  assert.match(applyPatch({}, {port: 70000}).error, /between 1024 and 65535/);
  assert.match(applyPatch({}, {port: 1.5}).error, /whole number/);
});

test('a blank value removes the override so the default returns', () => {
  assert.deepEqual(ok(applyPatch({port: 9000}, {port: ''})), {});
  assert.deepEqual(ok(applyPatch({voice: 'bf_emma'}, {voice: null})), {});
  assert.deepEqual(ok(applyPatch({speed: 1.5}, {speed: ''})), {});
});

test('applyPatch validates hotkey shape', () => {
  assert.equal(ok(applyPatch({}, {hotkey: 'CmdOrCtrl+Shift+S'})).hotkey, 'CmdOrCtrl+Shift+S');
  assert.match(applyPatch({}, {hotkey: 'JustS'}).error, /CmdOrCtrl\+Shift\+Space/);
});

test('applyPatch rejects an unknown voice', () => {
  const isVoice = id => id === 'af_heart';
  assert.equal(ok(applyPatch({}, {voice: 'af_heart'}, isVoice)).voice, 'af_heart');
  assert.match(applyPatch({}, {voice: 'nope'}, isVoice).error, /Unknown voice/);
});

test('applyPatch clamps speed to the range Kokoro handles', () => {
  assert.equal(ok(applyPatch({}, {speed: 1.5})).speed, 1.5);
  assert.match(applyPatch({}, {speed: 3}).error, /between 0.5 and 2/);
  assert.match(applyPatch({}, {speed: 0.1}).error, /between 0.5 and 2/);
});

test('applyPatch does not mutate the input config', () => {
  const before = {port: 9000};
  applyPatch(before, {port: 9001});
  assert.equal(before.port, 9000);
});

test('input selects what the hotkey reads, defaulting to the selection', () => {
  assert.equal(DEFAULTS.input, 'selection');
  assert.equal(ok(applyPatch({}, {input: 'clipboard'})).input, 'clipboard');
  assert.equal(ok(applyPatch({}, {input: 'selection'})).input, 'selection');
  assert.match(applyPatch({}, {input: 'telepathy'}).error, /selection.*clipboard/);
  assert.deepEqual(ok(applyPatch({input: 'clipboard'}, {input: ''})), {});
});

test('nowPlaying is a boolean that defaults on', () => {
  assert.equal(DEFAULTS.nowPlaying, true);
  assert.equal(ok(applyPatch({}, {nowPlaying: false})).nowPlaying, false);
  assert.deepEqual(ok(applyPatch({nowPlaying: false}, {nowPlaying: ''})), {});
});

test('telemetry is tri-state: absent, true, or false', () => {
  assert.equal('telemetry' in ok(applyPatch({}, {})), false);
  assert.equal(ok(applyPatch({}, {telemetry: true})).telemetry, true);
  assert.equal(ok(applyPatch({}, {telemetry: false})).telemetry, false);
  assert.equal('telemetry' in ok(applyPatch({telemetry: true}, {telemetry: null})), false);
});
