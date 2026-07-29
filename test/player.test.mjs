import test from 'node:test';
import assert from 'node:assert/strict';
import {playerCommand, available, wavDurationMs} from '../src/player.mjs';

test('each platform gets its own player command', () => {
  assert.deepEqual(playerCommand('darwin', '/tmp/a.wav'), ['afplay', ['/tmp/a.wav']]);
  assert.equal(playerCommand('linux', '/tmp/a.wav')[0], 'aplay');
  assert.equal(playerCommand('win32', 'C:\\a.wav')[0], 'powershell');
});

test('the PowerShell command escapes single quotes in the path', () => {
  const [, args] = playerCommand('win32', "C:\\o'brien.wav");
  assert.ok(args.at(-1).includes("o''brien.wav"), args.at(-1));
});

test('available finds the player on PATH', () => {
  assert.equal(available('linux', {PATH: '/nonexistent'}), false);
  assert.equal(available('win32', {PATH: ''}), true, 'PowerShell ships with Windows');
});

// 24 kHz mono 16-bit: one second is 48000 bytes of data.
const wavHeader = dataBytes => {
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);      // fmt chunk size
  b.writeUInt16LE(1, 20);       // PCM
  b.writeUInt16LE(1, 22);       // channels
  b.writeUInt32LE(24000, 24);   // sample rate
  b.writeUInt16LE(16, 34);      // bits per sample
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
};

test('wavDurationMs reads the header rather than assuming', () => {
  assert.equal(wavDurationMs(wavHeader(48000)), 1000);
  assert.equal(wavDurationMs(wavHeader(24000)), 500);
  assert.equal(wavDurationMs(wavHeader(0)), 0);
});

test('wavDurationMs returns 0 for a buffer too short to be a WAV', () => {
  assert.equal(wavDurationMs(Buffer.alloc(10)), 0);
});
