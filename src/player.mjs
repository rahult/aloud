// System audio output. One utterance at a time; the caller holds the handle
// and stops it. `onEnd` distinguishes "the audio finished" from "we killed
// it", which is the distinction the playback session is built on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

let counter = 0;

export function playerCommand(platform, file) {
  if (platform === 'darwin') return ['afplay', [file]];
  if (platform === 'win32') {
    const escaped = file.replaceAll("'", "''");
    return ['powershell', ['-NoProfile', '-c', `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`]];
  }
  return ['aplay', ['-q', file]];
}

// PowerShell ships with Windows; elsewhere the binary has to be on PATH.
export function available(platform = process.platform, env = process.env) {
  if (platform === 'win32') return true;
  const [cmd] = playerCommand(platform, 'probe.wav');
  return (env.PATH ?? '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; }
    catch { return false; }
  });
}

// Duration from the WAV header, so the UI can interpolate a progress bar
// without the server streaming playback position.
export function wavDurationMs(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) return 0;
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  const dataBytes = wav.readUInt32LE(40);
  const bytesPerSecond = sampleRate * channels * (bits / 8);
  if (!bytesPerSecond) return 0;
  return Math.round((dataBytes / bytesPerSecond) * 1000);
}

export function play(wav, onEnd) {
  const file = path.join(os.tmpdir(), `chirp-${process.pid}-${counter++}.wav`);
  fs.writeFileSync(file, wav);

  const [cmd, args] = playerCommand(process.platform, file);
  const child = spawn(cmd, args, {stdio: 'ignore'});

  let settled = false;
  let killed = false;
  const done = () => {
    if (settled) return;
    settled = true;
    fs.unlink(file, () => {});
    if (!killed) onEnd();
  };
  child.on('exit', done);
  child.on('error', done);

  return {
    stop() {
      killed = true;
      child.kill('SIGTERM');
      done();
    },
  };
}
