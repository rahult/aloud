// Chirp — local neural text-to-speech as a tiny HTTP service.
// Kokoro-82M runs fully on-device; no text or audio ever leaves the machine.
//
//   npm install && npm start        → http://127.0.0.1:8789
//
// API:
//   POST /api/tts               {text, voice?, speed?} → audio/wav
//   POST /api/speak             {text, voice?, speed?} → start a spoken session
//   GET  /api/playback                                 → session state
//   POST /api/playback/toggle                          → stop | resume | need_text
//   POST /api/playback/{pause,resume,next,prev,stop}
//   GET  /api/playback/events                          → SSE state feed
//   GET  /api/voices                                   → [{id, label, lang, grade}]
//   GET  /api/health                                   → {ok, modelLoaded, audioOut}
//   GET  /api/settings                                 → saved settings
//   POST /api/settings          {port?, hotkey?, voice?, speed?}
//   GET  /                                             → web UI

import http from 'node:http';
import {EventEmitter} from 'node:events';
import * as config from './src/config.mjs';
import * as voices from './src/voices.mjs';
import * as tts from './src/tts.mjs';
import * as player from './src/player.mjs';
import {createSession} from './src/playback.mjs';
import {createRemotePlayer, createPlayerRouter} from './src/remote-player.mjs';
import {createRoutes} from './src/routes.mjs';

const stored = config.read();
const PORT = Number(process.env.CHIRP_PORT ?? stored.port ?? config.DEFAULTS.port);

// Audio output can live in this process (afplay and friends) or inside the
// desktop app (rodio, which can really pause and owns the audio session).
// The session neither knows nor cares which it is talking to.
const sseBus = new EventEmitter();
const remote = createRemotePlayer({
  send: cmd => sseBus.emit('audio', cmd),
  wavDurationMs: player.wavDurationMs,
});
const appClients = {count: 0};
const routedPlayer = createPlayerRouter({
  local: player,
  remote,
  isAppConnected: () => appClients.count > 0,
});

const session = createSession({engine: tts, player: routedPlayer});
const audioOut = player.available();
if (!audioOut) console.warn('chirp: no system audio player found — /api/speak needs the desktop app to be audible');

const server = http.createServer(createRoutes({
  session, tts, voices, config, player, remote, appClients, sseBus,
  activePort: PORT, audioOut,
}));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chirp listening on http://127.0.0.1:${PORT} (model loads on first speak)`);
});
