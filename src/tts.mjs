// Kokoro-82M, loaded lazily and driven one sentence at a time.
//
// Generation is serialized behind a single promise chain: one utterance at a
// time keeps latency predictable, and because the unit of work is a sentence
// rather than a whole document, a long read shares the model fairly with
// one-shot /api/tts callers instead of blocking them for minutes.

import {EventEmitter} from 'node:events';
import {TextSplitterStream} from 'kokoro-js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let model = null;
let loading = null;
let queue = Promise.resolve();

// 'model' → {loaded, progress?, error?}. The first speak on a fresh machine
// pulls ~90 MB, and silence for a minute reads as a hang.
export const events = new EventEmitter();

// kokoro-js's own sentence splitter — the same one KokoroTTS.stream() uses.
export function split(text) {
  const stream = new TextSplitterStream();
  stream.push(text ?? '');
  stream.close();
  return [...stream].map(s => s.trim()).filter(Boolean);
}

export const isLoaded = () => model !== null;

// A failed download and a corrupt model are very different problems for the
// person waiting, and only one of them is fixed by reconnecting.
const OFFLINE = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i;

export const describeLoadError = e =>
  OFFLINE.test(e.message)
    ? 'Chirp needs a one-time ~90 MB model download and cannot reach the network. Reconnect and try again — after this it works fully offline.'
    : `Could not load the speech model: ${e.message}`;

export function load() {
  if (model) return Promise.resolve(model);
  if (!loading) {
    loading = import('kokoro-js')
      .then(({KokoroTTS}) => KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        progress_callback: p => {
          if (p?.status === 'progress' && Number.isFinite(p.progress))
            events.emit('model', {loaded: false, progress: Math.round(p.progress) / 100});
        },
      }))
      .then(m => {
        model = m;
        loading = null;
        console.log(`chirp: kokoro model loaded (${MODEL_ID}, q8)`);
        events.emit('model', {loaded: true});
        return m;
      })
      .catch(e => {
        loading = null;
        events.emit('model', {loaded: false, error: describeLoadError(e)});
        throw new Error(describeLoadError(e));
      });
  }
  return loading;
}

export function generate(text, {voice, speed} = {}) {
  const run = queue
    .then(() => load())
    .then(m => m.generate(text, {voice, speed}))
    .then(audio => Buffer.from(audio.toWav()));
  // Swallow failures on the chain itself so one bad sentence cannot poison
  // every request that follows it.
  queue = run.then(() => {}, () => {});
  return run;
}
