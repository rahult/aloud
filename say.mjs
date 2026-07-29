#!/usr/bin/env node
// say — CLI for a running Chirp server.
//   node say.mjs "Hello world"            → plays audio (macOS afplay)
//   node say.mjs "Hello" -o hello.wav     → writes a file
//   node say.mjs "Hello" -v bf_emma       → pick a voice
//   node say.mjs "Hello" -s 1.25          → pick a speed
//   cat notes.md | node say.mjs --system  → speak a whole document, no length limit
//   node say.mjs --voices                 → list every voice, graded
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';

// Match the server's configured port (~/.chirp/config.json) unless CHIRP_URL says otherwise.
let cfgPort;
try { cfgPort = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.chirp', 'config.json'), 'utf8')).port; } catch {}
const BASE = process.env.CHIRP_URL ?? `http://127.0.0.1:${cfgPort ?? 8789}`;

const usage = () => {
  console.error('usage: say "text" [-v voice] [-s speed] [-o out.wav] [--system] [--voices]');
  console.error('       cat file.txt | say --system');
};

async function listVoices() {
  const res = await fetch(`${BASE}/api/voices`);
  for (const v of await res.json())
    console.log(`${v.id.padEnd(13)} ${v.grade.padEnd(3)} ${v.label}${v.recommended ? '  *' : ''}`);
}

const args = process.argv.slice(2);
let text = null, voice, out, speed, useSystem = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-v') voice = args[++i];
  else if (args[i] === '-o') out = args[++i];
  else if (args[i] === '-s') speed = Number(args[++i]);
  else if (args[i] === '--system') useSystem = true;
  else if (args[i] === '--voices') { await listVoices(); process.exit(0); }
  else if (args[i] === '-h' || args[i] === '--help') { usage(); process.exit(0); }
  else if (text === null) text = args[i];
}

// Piping is the point: `pbpaste | say --system`, `cat notes.md | say --system`.
if (text === null && !process.stdin.isTTY) {
  text = await new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}

if (!text || !text.trim()) {
  usage();
  process.exit(2);
}

// --system routes through the playback session: no length limit, and it comes
// out of the speakers the same way the global hotkey does.
if (useSystem) {
  const res = await fetch(`${BASE}/api/speak`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text, voice, speed}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(data.error ?? `request failed (${res.status}) — is the server running? (npm start)`);
    process.exit(1);
  }
  console.log(`speaking ${data.count} sentence${data.count === 1 ? '' : 's'}`);
  process.exit(0);
}

const res = await fetch(`${BASE}/api/tts`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({text, voice, speed}),
});
if (!res.ok) {
  const data = await res.json().catch(() => ({}));
  console.error(data.error ?? `request failed (${res.status}) — is the server running? (npm start)`);
  process.exit(1);
}
const wav = Buffer.from(await res.arrayBuffer());

if (out) {
  fs.writeFileSync(out, wav);
  console.log(`wrote ${out} (${(wav.length / 1024).toFixed(0)} KB)`);
} else {
  const f = path.join(os.tmpdir(), `chirp-${process.pid}.wav`);
  fs.writeFileSync(f, wav);
  execFile('afplay', [f], e => {
    fs.unlinkSync(f);
    if (e) { console.error(`no afplay — file was at ${f}`); process.exit(1); }
  });
}
