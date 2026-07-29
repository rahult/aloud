// HTTP surface. Everything that speaks goes through the session; /api/tts is
// the one exception, kept as a plain request/response WAV because Margin and
// say.mjs depend on that contract.

import {serveStatic} from './static.mjs';

const MAX_TTS_CHARS = 2000;

export function createRoutes({
  session, tts, voices, config, player,
  configFile = config.CONFIG_PATH,
  activePort,
  audioOut = player.available(),
}) {
  const clients = new Set();
  let hotkeyOk = true;
  let accessibilityOk = null;

  // Commands the web UI may ask the desktop app to perform. An allowlist,
  // because this is a local HTTP surface with CORS wide open — any page in
  // the browser can post here.
  const APP_COMMANDS = new Set(['request-accessibility', 'open-accessibility-settings']);

  const settings = () => config.resolve(config.read(configFile));

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
    req.on('data', c => { raw += c; if (raw.length > 5_000_000) reject(new Error('Body too large.')); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON body.')); } });
    req.on('error', reject);
  });

  // --- SSE fan-out ---

  const push = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  session.on('state', s => push('state', s));
  session.on('sentences', s => push('sentences', s));
  session.on('fault', f => push('error', f));
  // Warm-up progress and load failures reach the UI the same way state does,
  // so the status dot can tell the truth during the first ~90 MB download.
  tts.events?.on('model', m => push('model', m));

  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15_000);
  heartbeat.unref();

  function events(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    clients.add(res);
    // Open with the current truth so a client that connects mid-session
    // renders correctly instead of waiting for the next transition.
    res.write(`event: sentences\ndata: ${JSON.stringify({
      sentences: session.getSentences(), ...session.getState(),
    })}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(session.getState())}\n\n`);
    res.write(`event: model\ndata: ${JSON.stringify({loaded: tts.isLoaded()})}\n\n`);
    req.on('close', () => clients.delete(res));
  }

  // --- speech ---

  const pickVoice = v => (voices.isVoice(v) ? v : settings().voice);
  const pickSpeed = s => {
    const n = Number(s ?? settings().speed);
    return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1;
  };

  function speak(req, res) {
    readBody(req).then(body => {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return send(res, 400, {error: 'Body must include text.'});
      const {count} = session.start(text, {voice: pickVoice(body.voice), speed: pickSpeed(body.speed)});
      if (!count) return send(res, 400, {error: 'Nothing speakable in that text.'});
      send(res, 200, {ok: true, count, chars: text.length});
    }).catch(e => send(res, 400, {error: e.message}));
  }

  function oneShot(req, res) {
    readBody(req).then(body => {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return send(res, 400, {error: 'Body must include text.'});
      if (text.length > MAX_TTS_CHARS)
        return send(res, 400, {error: `Text too long (max ${MAX_TTS_CHARS} chars). Use POST /api/speak for longer text.`});
      tts.generate(text, {voice: pickVoice(body.voice), speed: pickSpeed(body.speed)})
        .then(wav => send(res, 200, wav))
        .catch(e => send(res, 500, {error: `TTS failed: ${e.message}`}));
    }).catch(e => send(res, 400, {error: e.message}));
  }

  // --- settings ---

  function saveSettings(req, res) {
    readBody(req).then(body => {
      const result = config.applyPatch(config.read(configFile), body, voices.isVoice);
      if (result.error) return send(res, 400, {error: result.error});
      try { config.write(result.cfg, configFile); }
      catch (e) { return send(res, 500, {error: `Could not save settings: ${e.message}`}); }

      const now = config.resolve(result.cfg);
      // A live session should follow the settings change rather than finish
      // in the old voice.
      if ('voice' in body || 'speed' in body) {
        session.setOptions({voice: now.voice, speed: now.speed});
      }
      send(res, 200, {
        ok: true, ...now,
        restartRequired: now.port !== activePort,
        telemetry: result.cfg.telemetry ?? null,
      });
    }).catch(e => send(res, 400, {error: e.message}));
  }

  const TRANSPORT = {pause: 'pause', resume: 'resume', next: 'next', prev: 'prev', stop: 'stop'};

  return function route(req, res) {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const GET = req.method === 'GET';
    const POST = req.method === 'POST';

    if (GET && p === '/api/health')
      return send(res, 200, {ok: true, modelLoaded: tts.isLoaded(), audioOut});
    if (GET && p === '/api/voices') return send(res, 200, voices.VOICES);

    if (POST && p === '/api/tts') return oneShot(req, res);
    if (POST && p === '/api/speak') return speak(req, res);

    if (GET && p === '/api/playback')
      return send(res, 200, {...session.getState(), sentences: session.getSentences()});
    if (GET && p === '/api/playback/events') return events(req, res);
    if (POST && p === '/api/playback/toggle')
      return send(res, 200, {action: session.toggle(), ...session.getState()});
    if (POST && p.startsWith('/api/playback/')) {
      const action = TRANSPORT[p.slice('/api/playback/'.length)];
      if (action) { session[action](); return send(res, 200, session.getState()); }
    }
    // Retained: the previous API stopped playback here.
    if (POST && p === '/api/stop') { session.stop(); return send(res, 200, {stopped: true}); }

    if (GET && p === '/api/settings') {
      const stored = config.read(configFile);
      return send(res, 200, {
        ...config.resolve(stored),
        activePort,
        telemetry: stored.telemetry ?? null,
        hotkeyCustom: stored.hotkey != null,
        hotkeyOk,
        accessibilityOk,
      });
    }
    if (POST && p === '/api/settings') return saveSettings(req, res);

    // The desktop app reports whether the OS accepted its global shortcut, so
    // Settings can say "in use by another app" instead of failing silently.
    if (POST && p === '/api/hotkey-status') {
      return readBody(req).then(body => {
        hotkeyOk = body.ok !== false;
        send(res, 200, {ok: true});
      }).catch(e => send(res, 400, {error: e.message}));
    }

    // UI → server → SSE → desktop app. The window loads a remote origin, so
    // Tauri IPC is not available to it; the event feed is the way back.
    if (POST && p === '/api/app-command') {
      return readBody(req).then(body => {
        if (!APP_COMMANDS.has(body.name))
          return send(res, 400, {error: `Unknown command: ${body.name}`});
        push('command', {name: body.name});
        send(res, 200, {ok: true});
      }).catch(e => send(res, 400, {error: e.message}));
    }

    // What the native layer can and cannot do, so Settings can explain
    // itself rather than letting the hotkey fail silently.
    if (POST && p === '/api/native-status') {
      return readBody(req).then(body => {
        if ('accessibilityOk' in body) accessibilityOk = Boolean(body.accessibilityOk);
        if ('hotkeyOk' in body) hotkeyOk = Boolean(body.hotkeyOk);
        send(res, 200, {ok: true});
      }).catch(e => send(res, 400, {error: e.message}));
    }

    if (GET && serveStatic(req, res, p)) return;
    send(res, 404, {error: 'Not found.'});
  };
}
