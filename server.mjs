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

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chirp — local text-to-speech</title>
<style>
 :root{
  --bg:#141311;--raised:#1e1c19;--ink:#e8e4dc;--soft:#9a948a;--faint:#6f6a61;
  --hairline:#3a362f;--amber:#c9a86a;--amber-deep:#b08d4e;--err:#d08a6f;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --serif:ui-serif,Georgia,"Times New Roman",serif;
  --ease:cubic-bezier(.22,1,.36,1)
 }
 *{box-sizing:border-box;margin:0}
 [hidden]{display:none!important}
 body{background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);min-height:100vh;display:flex}
 aside{width:148px;flex:none;min-height:100vh;position:sticky;top:0;align-self:flex-start;display:flex;flex-direction:column;padding:22px 0 16px;border-right:1px solid var(--hairline)}
 .wordmark{padding:0 20px;font:400 1.35rem/1 var(--serif)}
 .wordmark i{color:var(--amber);font-style:normal}
 nav{margin-top:32px;display:flex;flex-direction:column;gap:2px}
 .nav{background:none;border:none;border-radius:0;text-align:left;padding:8px 20px;font:13.5px var(--sans);color:var(--soft);cursor:pointer;transition:color .15s,background .15s}
 .nav:hover{color:var(--ink)}
 .nav.active{color:var(--amber);background:var(--raised)}
 .status{margin-top:auto;padding:14px 20px 0;border-top:1px solid var(--hairline);display:flex;align-items:flex-start;gap:8px;font-size:11.5px;color:var(--soft)}
 .dot{width:7px;height:7px;border-radius:50%;background:var(--faint);transition:background .5s;flex:none;margin-top:4px}
 .status.ready .dot{background:var(--amber)}
 main{flex:1;min-width:0;padding:clamp(32px,6vh,56px) clamp(20px,4vw,40px) 64px}
 section{max-width:560px}
 h1{font:400 clamp(1.6rem,3.6vw,2.1rem)/1.25 var(--serif);letter-spacing:.005em}
 h1 em{color:var(--amber)}
 .sub{color:var(--soft);font-size:14px;margin:10px 0 34px;max-width:46ch}
 .field{position:relative}
 textarea{width:100%;min-height:180px;background:var(--raised);color:var(--ink);border:1px solid var(--hairline);border-radius:12px;padding:18px 20px 36px;font:400 1.08rem/1.65 var(--serif);resize:vertical;transition:border-color .2s}
 textarea::placeholder{color:var(--faint);font-style:italic}
 textarea:focus{outline:none;border-color:var(--amber-deep)}
 .count{position:absolute;right:14px;bottom:11px;font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;pointer-events:none}
 .count.warn{color:var(--amber)}
 .controls{display:flex;gap:10px;margin-top:14px;align-items:stretch;flex-wrap:wrap}
 select{appearance:none;-webkit-appearance:none;flex:1;min-width:190px;background:var(--raised) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239a948a' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 12px center;color:var(--ink);border:1px solid var(--hairline);border-radius:9px;padding:10px 36px 10px 14px;font:14px var(--sans);cursor:pointer}
 button{font:14px var(--sans);border-radius:9px;padding:10px 20px;cursor:pointer;border:1px solid var(--hairline);background:var(--raised);color:var(--ink);transition:background .15s,border-color .15s}
 button:hover:not(:disabled){border-color:var(--faint)}
 button.primary{background:var(--amber);border-color:var(--amber);color:var(--bg);font-weight:600;min-width:116px}
 button.primary:hover:not(:disabled){background:var(--amber-deep);border-color:var(--amber-deep)}
 button:disabled{opacity:.45;cursor:default}
 :is(select,button,input[type=range]):focus-visible{outline:2px solid var(--amber);outline-offset:2px}
 .error{margin:14px 0 0;color:var(--err);font-size:13.5px;display:none}
 .panel{display:grid;gap:22px;margin-top:6px}
 .setting{display:grid;grid-template-columns:52px 1fr 48px;align-items:center;gap:16px}
 .setting label{font-size:14px}
 .val{font-size:14px;font-variant-numeric:tabular-nums;text-align:right}
 .ticks{grid-column:2;display:flex;justify-content:space-between;font-size:11px;color:var(--faint);margin-top:2px}
 .text{background:var(--bg);border:1px solid var(--hairline);border-radius:8px;color:var(--ink);padding:7px 10px;font:13.5px var(--sans);width:100%;max-width:220px;transition:border-color .2s}
 .text:focus{outline:none;border-color:var(--amber-deep)}
 .note{font-size:11.5px;color:var(--amber);text-align:right;white-space:nowrap}
 .smsg{font-size:12.5px;color:var(--faint);min-height:1.2em}
 .smsg.err{color:var(--err)}
 input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;width:100%;height:24px;cursor:pointer}
 input[type=range]::-webkit-slider-runnable-track{height:2px;background:var(--hairline);border-radius:1px}
 input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--amber);margin-top:-6px;transition:transform .15s}
 input[type=range]:hover::-webkit-slider-thumb{transform:scale(1.2)}
 input[type=range]::-moz-range-track{height:2px;background:var(--hairline);border-radius:1px}
 input[type=range]::-moz-range-thumb{width:14px;height:14px;border:none;border-radius:50%;background:var(--amber)}
 .reset{background:none;border:none;padding:0;color:var(--faint);font-size:13px;text-decoration:underline;text-underline-offset:3px;justify-self:start}
 .reset:hover{color:var(--ink)}
 .hint{margin-top:34px;padding-top:16px;border-top:1px solid var(--hairline);color:var(--faint);font-size:12.5px;display:flex;justify-content:space-between;gap:10px 24px;flex-wrap:wrap}
 .consent{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid var(--hairline);border-radius:12px;background:var(--raised);padding:14px 16px;margin-bottom:28px}
 .consent p{font-size:13.5px;color:var(--soft);max-width:56ch}
 .consent-actions{display:flex;gap:8px;flex:none}
 .consent button{padding:7px 14px;font-size:13px}
 .consent .primary{min-width:0}
 .setting input[type=checkbox]{accent-color:var(--amber);width:15px;height:15px;justify-self:start;cursor:pointer}
 .player{margin-top:22px;border-top:1px solid var(--hairline);padding-top:16px}
 .pcontrols{display:flex;align-items:center;gap:8px}
 .iconbtn{width:34px;height:34px;padding:0;display:grid;place-items:center;flex:none}
 .iconbtn.primary{min-width:34px}
 .iconbtn svg{width:14px;height:14px;fill:currentColor}
 .track{flex:1;display:flex;gap:2px;height:34px;align-items:center;cursor:pointer;min-width:60px}
 .seg{position:relative;height:3px;background:var(--hairline);border-radius:2px;flex:none}
 .seg i{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--amber)}
 .rate{flex:none;min-width:54px;padding:8px 10px;font-variant-numeric:tabular-nums;text-align:center}
 .transcript{margin-top:14px;font:400 1.02rem/1.75 var(--serif);color:var(--faint);max-height:200px;overflow-y:auto}
 .transcript span{cursor:pointer;transition:color .15s}
 .transcript span:hover{color:var(--soft)}
 .transcript span.done{color:var(--soft)}
 .transcript span.active{color:var(--amber)}
 kbd{border:1px solid var(--hairline);border-bottom-width:2px;border-radius:5px;background:var(--raised);padding:1px 6px;font:11.5px var(--sans);color:var(--soft)}
 code{font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--raised);padding:1px 5px;border-radius:4px}
 @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
 aside,section>*{animation:rise .55s var(--ease) both}
 section>*:nth-child(2){animation-delay:.05s}
 section>*:nth-child(3){animation-delay:.1s}
 section>*:nth-child(4){animation-delay:.15s}
 section>*:nth-child(5){animation-delay:.2s}
 section>*:nth-child(6){animation-delay:.25s}
 @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
 @media(max-width:640px){aside{width:112px}.wordmark,.nav,.status{padding-left:14px;padding-right:14px}}
 @media(max-width:520px){.controls{flex-direction:column}.controls>*{width:100%}}
</style></head><body>
<aside>
 <div class="wordmark">Chirp<i>.</i></div>
 <nav>
  <button class="nav active" data-view="voice">Voice</button>
  <button class="nav" data-view="settings">Settings</button>
 </nav>
 <div class="status" id="status"><span class="dot"></span><span id="statusText">Warms up on first speak</span></div>
</aside>
<main>
 <div class="consent" id="consent" hidden>
  <p>Share anonymous usage analytics? Your text never leaves this machine — only counts like “spoke 120 characters”.</p>
  <div class="consent-actions">
   <button class="primary" id="consentYes">Allow</button>
   <button id="consentNo">No thanks</button>
  </div>
 </div>
 <section id="view-voice">
  <h1>Type it. <em>Hear it.</em></h1>
  <p class="sub">Neural text-to-speech on this machine — Kokoro-82M, fully on-device. Your text never leaves.</p>
  <div class="field">
   <textarea id="t" maxlength="${MAX_CHARS}" placeholder="Something worth hearing…" spellcheck="false">The quick brown fox jumps over the lazy dog.</textarea>
   <span class="count" id="count"></span>
  </div>
  <div class="controls">
   <select id="v" aria-label="Voice"></select>
   <button class="primary" id="speak">Speak</button>
   <button id="dl" disabled>Download</button>
  </div>
  <p class="error" id="err" role="alert"></p>
  <div class="player" id="player" hidden>
   <div class="pcontrols">
    <button class="iconbtn" id="prev" aria-label="Previous sentence"><svg viewBox="0 0 16 16"><path d="M3 3h2v10H3zM13 3v10L6 8z"/></svg></button>
    <button class="iconbtn primary" id="play" aria-label="Play"><svg viewBox="0 0 16 16"><path d="M5 3v10l8-5z"/></svg></button>
    <button class="iconbtn" id="next" aria-label="Next sentence"><svg viewBox="0 0 16 16"><path d="M11 3h2v10h-2zM3 3v10l7-5z"/></svg></button>
    <div class="track" id="track" aria-hidden="true"></div>
    <button class="rate" id="rate">1×</button>
   </div>
   <div class="transcript" id="transcript"></div>
  </div>
  <div class="hint">
   <span><kbd>⌘</kbd> <kbd>↵</kbd> to speak</span>
   <span><code>POST /api/tts</code> · port ${PORT} · local only</span>
  </div>
 </section>
 <section id="view-settings" hidden>
  <h1>Settings</h1>
  <p class="sub">Saved on this machine — shared by the app, the server, and the CLI.</p>
  <div class="panel">
   <div class="setting">
    <label for="speed">Speed</label>
    <input type="range" id="speed" min="0.5" max="2" step="0.05" value="1">
    <span class="val" id="speedVal">1×</span>
    <span class="ticks" aria-hidden="true"><span>0.5×</span><span>2×</span></span>
   </div>
   <div class="setting">
    <label for="port">Port</label>
    <input type="text" class="text" id="port" inputmode="numeric" autocomplete="off" spellcheck="false">
    <span class="note" id="portNote"></span>
   </div>
   <div class="setting">
    <label for="hotkey">Hotkey</label>
    <input type="text" class="text" id="hotkey" autocomplete="off" spellcheck="false">
    <span class="note"></span>
   </div>
   <div class="setting">
    <label for="analytics">Analytics</label>
    <input type="checkbox" id="analytics">
    <span class="note" id="analyticsNote">anonymous</span>
   </div>
   <p class="smsg" id="smsg"></p>
   <button class="reset" id="reset">Reset to defaults</button>
  </div>
 </section>
</main>
<script>
 var $=function(id){return document.getElementById(id)};
 var t=$('t'),sel=$('v'),speak=$('speak'),dl=$('dl'),err=$('err'),count=$('count'),
  speed=$('speed'),speedVal=$('speedVal'),status=$('status'),statusText=$('statusText'),
  portIn=$('port'),hotkeyIn=$('hotkey'),portNote=$('portNote'),smsg=$('smsg'),smsgTimer=null,
  consent=$('consent'),analyticsBox=$('analytics');
 var MAX=${MAX_CHARS},DEF_VOICE='af_heart',DEF_SPEED=1;
 var audio=null;

 var navs=document.querySelectorAll('.nav');
 function showView(name){
  navs.forEach(function(b){b.classList.toggle('active',b.getAttribute('data-view')===name)});
  $('view-voice').hidden=name!=='voice';
  $('view-settings').hidden=name!=='settings';
  if(location.hash!=='#'+name)history.replaceState(null,'','#'+name);
 }
 navs.forEach(function(b){b.addEventListener('click',function(){showView(b.getAttribute('data-view'))})});
 showView(location.hash==='#settings'?'settings':'voice');

 function fmtSpeed(n){n=Math.round(n*100)/100;return (n%1?n.toFixed(2).replace(/0$/,''):String(n))+'\\u00d7'}
 function showSpeed(){speedVal.textContent=fmtSpeed(+speed.value)}
 function setReady(){status.classList.add('ready');statusText.textContent='Ready'}
 function fail(msg){err.textContent=msg;err.style.display='block'}
 function updateCount(){var n=t.value.length;count.textContent=n+' / '+MAX;count.classList.toggle('warn',n>MAX*.9)}

 fetch('/api/voices').then(function(r){return r.json()}).then(function(vs){
  var langs={'en-US':'American','en-GB':'British'},groups={},order=[];
  vs.forEach(function(v){if(!groups[v.lang]){groups[v.lang]=[];order.push(v.lang)}groups[v.lang].push(v)});
  sel.innerHTML=order.map(function(lang){
   return '<optgroup label="'+(langs[lang]||lang)+'">'+groups[lang].map(function(v){
    var short=v.label.replace(/\\s*\\((?:American|British),\\s*(F|M)\\)/,' \\u00b7 $1');
    return '<option value="'+v.id+'">'+short+'</option>'}).join('')+'</optgroup>'}).join('');
  sel.value=localStorage.getItem('chirp.voice')||DEF_VOICE;
 });
 fetch('/api/health').then(function(r){return r.json()}).then(function(h){if(h.modelLoaded)setReady()});

 function flash(msg,isErr){
  smsg.textContent=msg;smsg.classList.toggle('err',!!isErr);
  clearTimeout(smsgTimer);
  if(msg)smsgTimer=setTimeout(function(){smsg.textContent=''},4000);
 }
 // Analytics (opt-in): gtag loads only after consent, and events carry
 // counts and ids — never text. Offline, the script simply never arrives.
 var GA_ID='G-M72NFQRWXN',analyticsOn=false,gaLoaded=false;
 function loadAnalytics(){
  if(gaLoaded)return;gaLoaded=true;analyticsOn=true;
  var s=document.createElement('script');s.async=true;
  s.src='https://www.googletagmanager.com/gtag/js?id='+GA_ID;
  document.head.appendChild(s);
  window.dataLayer=window.dataLayer||[];
  window.gtag=function(){dataLayer.push(arguments)};
  gtag('js',new Date());
  gtag('config',GA_ID);
 }
 function track(ev,params){if(analyticsOn&&window.gtag)gtag('event',ev,params)}

 fetch('/api/settings').then(function(r){return r.json()}).then(function(s){
  portIn.value=s.port;hotkeyIn.value=s.hotkey;
  analyticsBox.checked=!!s.telemetry;
  if(s.telemetry===null||s.telemetry===undefined)consent.hidden=false;
  if(s.telemetry)loadAnalytics();
 });
 function saveTelemetry(on){
  analyticsBox.checked=on;
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({telemetry:on})})
  .then(function(){if(on)loadAnalytics();else analyticsOn=false})
  .catch(function(e){flash(e.message,true)});
 }
 $('consentYes').addEventListener('click',function(){consent.hidden=true;saveTelemetry(true);track('consent',{granted:true})});
 $('consentNo').addEventListener('click',function(){consent.hidden=true;saveTelemetry(false)});
 analyticsBox.addEventListener('change',function(){saveTelemetry(analyticsBox.checked)});
 function saveSettings(){
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({port:portIn.value.trim(),hotkey:hotkeyIn.value.trim()})})
  .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d})})
  .then(function(s){
   portIn.value=s.port;hotkeyIn.value=s.hotkey;
   portNote.textContent=s.restartRequired?'after restart':'';
   flash(s.restartRequired?'Saved — restart Chirp to use the new port.':'Saved.');
  })
  .catch(function(e){flash(e.message,true)});
 }
 portIn.addEventListener('change',saveSettings);
 hotkeyIn.addEventListener('change',saveSettings);

 speed.value=localStorage.getItem('chirp.speed')||DEF_SPEED;
 showSpeed();updateCount();

 sel.addEventListener('change',function(){localStorage.setItem('chirp.voice',sel.value)});
 speed.addEventListener('input',function(){showSpeed();localStorage.setItem('chirp.speed',speed.value)});
 t.addEventListener('input',function(){updateCount();session++;stopAudio();player.hidden=true;chunks=[];cur=-1});
 $('reset').addEventListener('click',function(){
  sel.value=DEF_VOICE;speed.value=DEF_SPEED;showSpeed();
  localStorage.removeItem('chirp.voice');localStorage.removeItem('chirp.speed');
  portIn.value='';hotkeyIn.value='';saveSettings();
 });

 // Player: the text is the album, each sentence a track. Chunks are
 // generated on demand (next one prefetched) and cached for the session.
 var RATES=[0.75,1,1.25,1.5,2],rateIdx=1;
 var chunks=[],urls={},promises={},cur=-1,playing=false,raf=0,session=0;
 var player=$('player'),track=$('track'),transcript=$('transcript'),playBtn=$('play'),rateBtn=$('rate'),
  playSvg=playBtn.querySelector('svg'),
  PLAY='<path d="M5 3v10l8-5z"/>',PAUSE='<path d="M4 3h3v10H4zM9 3h3v10H9z"/>';

 function splitText(s){
  var out=[],re=/[^.!?\\n]+[.!?]*(?:\\u201d|["')\\]])*\\s*|\\n+/g,m;
  while((m=re.exec(s))){var c=m[0].replace(/\\s+/g,' ').trim();if(c)out.push(c)}
  return out;
 }

 function fetchChunk(i){
  if(urls[i])return Promise.resolve(urls[i]);
  if(!promises[i]){
   promises[i]=fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:chunks[i],voice:sel.value,speed:+speed.value})})
   .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error||('HTTP '+r.status))});return r.blob()})
   .then(function(b){urls[i]=URL.createObjectURL(b);return urls[i]});
  }
  return promises[i];
 }

 function paint(){
  var segs=track.children;
  for(var i=0;i<segs.length;i++){
   var f=0;
   if(i<cur)f=100;
   else if(i===cur&&audio&&audio.duration)f=Math.min(100,audio.currentTime/audio.duration*100);
   segs[i].firstChild.style.width=f+'%';
  }
  var spans=transcript.children;
  for(var j=0;j<spans.length;j++)spans[j].className=j<cur?'done':j===cur?'active':'';
 }

 function tick(){paint();raf=requestAnimationFrame(tick)}

 function setPlayIcon(){playSvg.innerHTML=playing?PAUSE:PLAY;playBtn.setAttribute('aria-label',playing?'Pause':'Play')}

 function stopAudio(){
  if(audio){audio.pause();audio=null}
  playing=false;cancelAnimationFrame(raf);setPlayIcon();
 }

 function playChunk(i){
  if(i<0||i>=chunks.length)return;
  var s=session;
  cur=i;
  if(audio){audio.pause();audio=null}
  playing=false;cancelAnimationFrame(raf);paint();
  playBtn.disabled=true;
  fetchChunk(i).then(function(u){
   if(s!==session||cur!==i)return;
   audio=new Audio(u);audio.playbackRate=RATES[rateIdx];
   audio.onended=function(){
    if(s!==session)return;
    if(cur<chunks.length-1)playChunk(cur+1);
    else{cur=chunks.length;stopAudio();paint()}
   };
   playBtn.disabled=false;playing=true;setPlayIcon();setReady();
   tick();
   audio.play().catch(function(){});
   var active=transcript.children[i];if(active)active.scrollIntoView({block:'nearest'});
   if(i+1<chunks.length)fetchChunk(i+1);
  }).catch(function(e){if(s===session){playBtn.disabled=false;fail(e.message)}});
 }

 playBtn.addEventListener('click',function(){
  if(!chunks.length)return;
  if(audio&&playing){audio.pause();playing=false;cancelAnimationFrame(raf);setPlayIcon()}
  else if(audio){playing=true;setPlayIcon();tick();audio.play().catch(function(){})}
  else playChunk(cur>=0&&cur<chunks.length?cur:0);
 });
 $('prev').addEventListener('click',function(){playChunk(cur>0?cur-1:0)});
 $('next').addEventListener('click',function(){playChunk(cur+1)});
 rateBtn.addEventListener('click',function(){
  rateIdx=(rateIdx+1)%RATES.length;rateBtn.textContent=fmtSpeed(RATES[rateIdx]);
  if(audio)audio.playbackRate=RATES[rateIdx];
 });

 speak.addEventListener('click',function(){
  err.style.display='none';
  var text=t.value.trim();
  if(!text)return fail('Type something first.');
  session++;stopAudio();
  chunks=splitText(text);
  track('speak',{chars:text.length,voice:sel.value,sentences:chunks.length});
  for(var u in urls)URL.revokeObjectURL(urls[u]);
  urls={};promises={};cur=-1;
  track.innerHTML='';transcript.innerHTML='';
  var total=chunks.reduce(function(a,c){return a+c.length},0)||1;
  chunks.forEach(function(c,i){
   var seg=document.createElement('div');seg.className='seg';seg.style.width=(c.length/total*100)+'%';
   seg.appendChild(document.createElement('i'));
   seg.addEventListener('click',function(){playChunk(i)});
   track.appendChild(seg);
   var span=document.createElement('span');span.textContent=c+' ';
   span.addEventListener('click',function(){playChunk(i)});
   transcript.appendChild(span);
  });
  player.hidden=false;
  speak.disabled=true;speak.textContent='Generating\\u2026';dl.disabled=true;
  fetchChunk(0)
   .then(function(){speak.disabled=false;speak.textContent='Speak';dl.disabled=false;playChunk(0)})
   .catch(function(e){speak.disabled=false;speak.textContent='Speak';fail(e.message)});
 });
 dl.addEventListener('click',function(){
  var text=t.value.trim();if(!text)return;
  track('download',{chars:text.length});
  dl.disabled=true;
  fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({text:text,voice:sel.value,speed:+speed.value})})
  .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error||('HTTP '+r.status))});return r.blob()})
  .then(function(b){
   var u=URL.createObjectURL(b),a=document.createElement('a');
   a.href=u;a.download='chirp.wav';a.click();
   setTimeout(function(){URL.revokeObjectURL(u)},5000);dl.disabled=false;
  })
  .catch(function(e){dl.disabled=false;fail(e.message)});
 });
 document.addEventListener('keydown',function(e){
  if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();speak.click()}
 });
</script></body></html>`;

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
    return send(res, 200, {port: cfg.port ?? DEFAULT_PORT, hotkey: cfg.hotkey ?? DEFAULT_HOTKEY, activePort: PORT, telemetry: cfg.telemetry ?? null});
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') return handleSettings(req, res);
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, {'Content-Type': 'text/html; charset=utf-8'});
  send(res, 404, {error: 'Not found.'});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chirp listening on http://127.0.0.1:${PORT} (model loads on first /api/tts call)`);
});
