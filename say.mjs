#!/usr/bin/env node
// say — CLI for a running Chirp server.
//   node say.mjs "Hello world"            → plays audio (macOS afplay)
//   node say.mjs "Hello" -o hello.wav     → writes a file
//   node say.mjs "Hello" -v bf_emma       → pick a voice
import fs from 'node:fs';
import {execFile} from 'node:child_process';

const BASE = process.env.CHIRP_URL ?? 'http://127.0.0.1:8789';

const args = process.argv.slice(2);
let text = null, voice, out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-v') voice = args[++i];
  else if (args[i] === '-o') out = args[++i];
  else if (text === null) text = args[i];
}
if (!text) {
  console.error('usage: say "text" [-v voice] [-o out.wav]');
  process.exit(2);
}

const res = await fetch(`${BASE}/api/tts`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({text, voice}),
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
  const f = `/tmp/chirp-${Date.now()}.wav`;
  fs.writeFileSync(f, wav);
  execFile('afplay', [f], e => {
    fs.unlinkSync(f);
    if (e) { console.error(`no afplay — file was at ${f}`); process.exit(1); }
  });
}
