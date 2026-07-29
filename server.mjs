// Chirp — local neural text-to-speech as a tiny HTTP service.
// Kokoro-82M runs fully on-device; no text or audio ever leaves the machine.
//
//   npm install && npm start        → http://127.0.0.1:8789
//
// API:
//   POST /api/tts      {text, voice?, speed?} → audio/wav
//   GET  /api/voices                          → [{id, label, lang}]
//   GET  /api/health                          → {ok, modelLoaded}
//   GET  /api/settings                        → {port, hotkey, activePort}
//   POST /api/settings {port?, hotkey?}       → persist to ~/.chirp/config.json
//   GET  /                                    → built-in web UI

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {serveStatic} from './src/static.mjs';

// User settings live in ~/.chirp/config.json ({port, hotkey}); the desktop
// app reads the same file for its global shortcut and window URL. A blank
// value in POST /api/settings removes the override and restores the default.
const CONFIG_PATH = path.join(os.homedir(), '.chirp', 'config.json');
const DEFAULT_PORT = 8789;
const DEFAULT_HOTKEY = 'CmdOrCtrl+Shift+Space';

const loadConfig = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
};
const saveConfig = cfg => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), {recursive: true});
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
};

const PORT = Number(process.env.CHIRP_PORT ?? loadConfig().port ?? DEFAULT_PORT);
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MAX_CHARS = 2000;

// Accelerator-style hotkey: modifiers then one key, e.g. CmdOrCtrl+Shift+Space.
const HOTKEY_RE = /^(?:(?:CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta)\+)+(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Return|Escape|Esc|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Minus|Equal|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote)$/i;

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

// Optional speaking rate; clamped to the range Kokoro handles well.
const parseSpeed = v => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1;
};

// Model loads lazily on first request; generation is serialized so latency
// stays predictable under concurrent calls.
let model = null;
let queue = Promise.resolve();

async function generateSpeech(text, voice, speed) {
  if (!model) {
    const {KokoroTTS} = await import('kokoro-js');
    model = await KokoroTTS.from_pretrained(MODEL_ID, {dtype: 'q8'});
    console.log(`chirp: kokoro model loaded (${MODEL_ID}, q8)`);
  }
  const audio = await model.generate(text, {voice, speed});
  return Buffer.from(audio.toWav());
}

const send = (res, status, data, headers = {}) => {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': Buffer.isBuffer(data) ? 'audio/wav' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    const speed = parseSpeed(body.speed);
    queue = queue.then(() => generateSpeech(text, voice, speed))
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
  const f = path.join(os.tmpdir(), `chirp-${Date.now()}.wav`);
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
    const speed = parseSpeed(body.speed);
    queue = queue.then(() => generateSpeech(text, voice, speed))
      .then(wav => { playWav(wav); send(res, 200, {ok: true, chars: text.length, voice}); })
      .catch(e => send(res, 500, {error: `TTS failed: ${e.message}`}));
  }).catch(e => send(res, 400, {error: e.message}));
}

// Port changes are persisted but only bind on the next server start; the
// response's restartRequired lets the UI say so. The desktop app watches the
// config file and re-registers the hotkey live.
function handleSettings(req, res) {
  readBody(req).then(body => {
    const cfg = loadConfig();
    if ('port' in body) {
      if (body.port == null || body.port === '') delete cfg.port;
      else {
        const p = Number(body.port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535)
          return send(res, 400, {error: 'Port must be a whole number between 1024 and 65535.'});
        cfg.port = p;
      }
    }
    if ('hotkey' in body) {
      const h = typeof body.hotkey === 'string' ? body.hotkey.trim() : '';
      if (!h) delete cfg.hotkey;
      else {
        if (!HOTKEY_RE.test(h))
          return send(res, 400, {error: 'Hotkey should look like CmdOrCtrl+Shift+Space.'});
        cfg.hotkey = h;
      }
    }
    // Analytics consent: true/false, absent until the user chooses (opt-in).
    if ('telemetry' in body) {
      if (body.telemetry == null || body.telemetry === '') delete cfg.telemetry;
      else cfg.telemetry = Boolean(body.telemetry);
    }
    try { saveConfig(cfg); } catch (e) { return send(res, 500, {error: `Could not save settings: ${e.message}`}); }
    const port = cfg.port ?? DEFAULT_PORT;
    send(res, 200, {ok: true, port, hotkey: cfg.hotkey ?? DEFAULT_HOTKEY, restartRequired: port !== PORT, telemetry: cfg.telemetry ?? null});
  }).catch(e => send(res, 400, {error: e.message}));
}


const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {ok: true, modelLoaded: Boolean(model)});
  if (req.method === 'GET' && url.pathname === '/api/voices') return send(res, 200, VOICES);
  if (req.method === 'POST' && url.pathname === '/api/tts') return handleTts(req, res);
  if (req.method === 'POST' && url.pathname === '/api/speak') return handleSpeak(req, res);
  if (req.method === 'POST' && url.pathname === '/api/stop') return send(res, 200, {stopped: stopPlayback()});
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const cfg = loadConfig();
    return send(res, 200, {port: cfg.port ?? DEFAULT_PORT, hotkey: cfg.hotkey ?? DEFAULT_HOTKEY, activePort: PORT, telemetry: cfg.telemetry ?? null, hotkeyCustom: cfg.hotkey != null});
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') return handleSettings(req, res);
  if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
  send(res, 404, {error: 'Not found.'});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chirp listening on http://127.0.0.1:${PORT} (model loads on first /api/tts call)`);
});
