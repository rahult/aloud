// Aloud — local neural text-to-speech as a tiny HTTP service.
// Kokoro-82M runs fully on-device; no text or audio ever leaves the machine.
//
//   npm install && npm start        → http://127.0.0.1:8789
//
// API:
//   POST /api/tts    {text, voice?} → audio/wav
//   GET  /api/voices                → [{id, label, lang}]
//   GET  /api/health                → {ok, modelLoaded}
//   GET  /                          → built-in web UI

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const PORT = Number(process.env.ALOUD_PORT ?? 8789);
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MAX_CHARS = 2000;

// Curated Kokoro v1.0 voices. id is what /api/tts accepts.
const VOICES = [
  {id: 'af_heart', label: 'Heart (American, F)', lang: 'en-US'},
  {id: 'af_bella', label: 'Bella (American, F)', lang: 'en-US'},
  {id: 'af_nicole', label: 'Nicole (American, F)', lang: 'en-US'},
  {id: 'af_sarah', label: 'Sarah (American, F)', lang: 'en-US'},
  {id: 'af_sky', label: 'Sky (American, F)', lang: 'en-US'},
  {id: 'am_adam', label: 'Adam (American, M)', lang: 'en-US'},
  {id: 'am_michael', label: 'Michael (American, M)', lang: 'en-US'},
  {id: 'bf_emma', label: 'Emma (British, F)', lang: 'en-GB'},
  {id: 'bf_isabella', label: 'Isabella (British, F)', lang: 'en-GB'},
  {id: 'bm_george', label: 'George (British, M)', lang: 'en-GB'},
  {id: 'bm_lewis', label: 'Lewis (British, M)', lang: 'en-GB'},
];
const DEFAULT_VOICE = 'af_heart';

// Model loads lazily on first request; generation is serialized so latency
// stays predictable under concurrent calls.
let model = null;
let queue = Promise.resolve();

async function generateSpeech(text, voice) {
  if (!model) {
    const {KokoroTTS} = await import('kokoro-js');
    model = await KokoroTTS.from_pretrained(MODEL_ID, {dtype: 'q8'});
    console.log(`aloud: kokoro model loaded (${MODEL_ID}, q8)`);
  }
  const audio = await model.generate(text, {voice});
  return Buffer.from(audio.toWav());
}

const send = (res, status, data, headers = {}) => {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': Buffer.isBuffer(data) ? 'audio/wav' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
};

const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 64_000) reject(new Error('Body too large.')); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON body.')); } });
  req.on('error', reject);
});

function handleTts(req, res) {
  readBody(req).then(body => {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return send(res, 400, {error: 'Body must include text.'});
    if (text.length > MAX_CHARS) return send(res, 400, {error: `Text too long (max ${MAX_CHARS} chars).`});
    const voice = VOICES.some(v => v.id === body.voice) ? body.voice : DEFAULT_VOICE;
    queue = queue.then(() => generateSpeech(text, voice))
      .then(wav => send(res, 200, wav))
      .catch(e => send(res, 500, {error: `TTS failed: ${e.message}`}));
  }).catch(e => send(res, 400, {error: e.message}));
}

// Local playback for /api/speak: one utterance at a time through the system
// player; starting a new one (or POST /api/stop) replaces the current one.
let player = null;

function stopPlayback() {
  if (!player) return false;
  player.kill('SIGTERM');
  player = null;
  return true;
}

function playWav(wav) {
  stopPlayback();
  const f = path.join(os.tmpdir(), `aloud-${Date.now()}.wav`);
  fs.writeFileSync(f, wav);
  const [cmd, args] = process.platform === 'darwin' ? ['afplay', [f]]
    : process.platform === 'win32' ? ['powershell', ['-NoProfile', '-c', `(New-Object Media.SoundPlayer '${f.replaceAll("'", "''")}').PlaySync()`]]
    : ['aplay', [f]];
  const child = spawn(cmd, args, {stdio: 'ignore'});
  player = child;
  child.on('exit', () => { fs.unlink(f, () => {}); if (player === child) player = null; });
}

function handleSpeak(req, res) {
  readBody(req).then(body => {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return send(res, 400, {error: 'Body must include text.'});
    if (text.length > MAX_CHARS) return send(res, 400, {error: `Text too long (max ${MAX_CHARS} chars).`});
    const voice = VOICES.some(v => v.id === body.voice) ? body.voice : DEFAULT_VOICE;
    queue = queue.then(() => generateSpeech(text, voice))
      .then(wav => { playWav(wav); send(res, 200, {ok: true, chars: text.length, voice}); })
      .catch(e => send(res, 500, {error: `TTS failed: ${e.message}`}));
  }).catch(e => send(res, 400, {error: e.message}));
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aloud — local text-to-speech</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141311;color:#e8e4dc;font:16px/1.5 ui-serif,Georgia,serif}
 main{width:min(560px,90vw)}
 h1{font-size:1.6rem;margin:0 0 .25rem} h1 span{color:#c9a86a}
 p.sub{margin:0 0 1.25rem;color:#9a948a;font-size:.9rem}
 textarea{width:100%;height:9rem;box-sizing:border-box;background:#1e1c19;color:inherit;border:1px solid #3a362f;border-radius:8px;padding:.75rem;font:inherit;resize:vertical}
 .row{display:flex;gap:.5rem;margin-top:.75rem;align-items:center}
 select,button{background:#1e1c19;color:inherit;border:1px solid #3a362f;border-radius:8px;padding:.5rem .9rem;font:inherit;cursor:pointer}
 button.primary{background:#c9a86a;border-color:#c9a86a;color:#141311;font-weight:600}
 button:disabled{opacity:.5;cursor:default}
 .hint{margin-top:1rem;font-size:.8rem;color:#6f6a61}
 code{background:#1e1c19;padding:.1rem .35rem;border-radius:4px}
</style></head><body><main>
<h1>Aloud<span>.</span></h1>
<p class="sub">Local neural text-to-speech. Kokoro-82M, on-device — nothing leaves this machine.</p>
<textarea id="t" placeholder="Type something worth hearing…">The quick brown fox jumps over the lazy dog.</textarea>
<div class="row">
 <select id="v"></select>
 <button class="primary" id="speak">Speak</button>
 <button id="dl" disabled>Download WAV</button>
</div>
<p class="hint">API: <code>POST /api/tts {"{text, voice?}"}</code> → <code>audio/wav</code> · port <code>${PORT}</code></p>
<script>
 const sel=document.getElementById('v'), speak=document.getElementById('speak'), dl=document.getElementById('dl');
 let lastUrl=null, lastBlob=null;
 fetch('/api/voices').then(r=>r.json()).then(vs=>{sel.innerHTML=vs.map(v=>'<option value="'+v.id+'">'+v.label+'</option>').join('')});
 speak.onclick=async()=>{
  speak.disabled=true; speak.textContent='Speaking…';
  try{
   const r=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:document.getElementById('t').value,voice:sel.value})});
   if(!r.ok) throw new Error((await r.json()).error||r.status);
   lastBlob=await r.blob(); if(lastUrl) URL.revokeObjectURL(lastUrl);
   lastUrl=URL.createObjectURL(lastBlob);
   const a=new Audio(lastUrl); a.onended=()=>{speak.disabled=false;speak.textContent='Speak'}; a.play();
   dl.disabled=false;
  }catch(e){alert(e.message);speak.disabled=false;speak.textContent='Speak'}
 };
 dl.onclick=()=>{const a=document.createElement('a');a.href=lastUrl;a.download='aloud.wav';a.click()};
</script></main></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {ok: true, modelLoaded: Boolean(model)});
  if (req.method === 'GET' && url.pathname === '/api/voices') return send(res, 200, VOICES);
  if (req.method === 'POST' && url.pathname === '/api/tts') return handleTts(req, res);
  if (req.method === 'POST' && url.pathname === '/api/speak') return handleSpeak(req, res);
  if (req.method === 'POST' && url.pathname === '/api/stop') return send(res, 200, {stopped: stopPlayback()});
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, {'Content-Type': 'text/html; charset=utf-8'});
  send(res, 404, {error: 'Not found.'});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`aloud listening on http://127.0.0.1:${PORT} (model loads on first /api/tts call)`);
});
