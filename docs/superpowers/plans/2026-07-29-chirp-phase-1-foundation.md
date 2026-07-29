# Chirp Phase 1 — Streaming Playback Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Node server the single owner of playback state, generate speech one sentence at a time, and make saved settings apply to every surface — fixing the swallowed-hotkey bug and the ignored-voice bug in the process.

**Architecture:** `server.mjs` splits into focused modules under `src/`, with the web UI extracted to static files under `ui/`. A `Session` state machine in `src/playback.mjs` owns the sentence queue, the current index, and the OS player handle; the hotkey, tray, web UI, and CLI all become clients of it over HTTP. The session takes its engine and player by injection so the entire state machine is unit-testable without downloading the 90 MB model or touching an audio device.

**Tech Stack:** Node.js ≥ 20.11 (ESM), `kokoro-js@1.2`, `node:test` + `node:assert` (no new dependencies), Tauri v2 / Rust with `ureq` 3.

## Global Constraints

- **No new runtime dependencies.** `kokoro-js` remains the only entry in `dependencies`. Tests use `node --test`, built in.
- **Node floor is 20.11** (`package.json` `engines`). `import.meta.dirname` is available exactly at this floor — use it for resolving `ui/` paths.
- **Server binds `127.0.0.1` only.** Never bind `0.0.0.0`.
- **No external network requests from the UI** except the opt-in analytics script that already exists. No webfonts, no CDNs.
- **Preserve the existing public API contract**: `POST /api/tts`, `GET /api/voices`, `GET /api/health`, `GET|POST /api/settings`, `GET /`. Margin and `say.mjs` depend on `POST /api/tts` returning a complete `audio/wav` body.
- **Visual design is unchanged.** CSS moves verbatim; palette and type stay as specified in `.impeccable.md` (`--bg:#141311`, `--ink:#e8e4dc`, `--amber:#c9a86a`, `--hairline:#3a362f`, serif headings, system sans UI).
- **Audio format is 24 kHz mono 16-bit** — Kokoro's output. Duration maths depends on it.
- **Commit after every task.** Do not batch.

---

### Task 1: Test harness and config module

Extracts settings handling out of `server.mjs` into a pure, testable module, and adds `voice` and `speed` to the persisted config. This is the fix for "settings never reach the hotkey or CLI" — nothing consumes it yet, but the storage lands here.

**Files:**
- Create: `src/config.mjs`
- Create: `test/config.test.mjs`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CONFIG_PATH: string`
  - `DEFAULTS: {port: 8789, hotkey: 'CmdOrCtrl+Shift+Space', voice: 'af_heart', speed: 1}`
  - `HOTKEY_RE: RegExp`
  - `read(file?: string) → object`
  - `write(cfg: object, file?: string) → void`
  - `resolve(cfg: object) → object` (defaults merged under stored values)
  - `applyPatch(cfg: object, patch: object, isVoice?: (id: string) => boolean) → {cfg: object} | {error: string}`

- [ ] **Step 1: Write the failing test**

Create `test/config.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS, resolve, applyPatch} from '../src/config.mjs';

const ok = r => { assert.equal(r.error, undefined, r.error); return r.cfg; };

test('resolve layers stored values over defaults', () => {
  assert.deepEqual(resolve({}), DEFAULTS);
  assert.equal(resolve({voice: 'bm_george'}).voice, 'bm_george');
  assert.equal(resolve({voice: 'bm_george'}).speed, 1);
});

test('applyPatch stores a valid port', () => {
  assert.equal(ok(applyPatch({}, {port: 9000})).port, 9000);
});

test('applyPatch rejects ports outside 1024-65535', () => {
  assert.match(applyPatch({}, {port: 80}).error, /between 1024 and 65535/);
  assert.match(applyPatch({}, {port: 70000}).error, /between 1024 and 65535/);
  assert.match(applyPatch({}, {port: 1.5}).error, /whole number/);
});

test('a blank value removes the override so the default returns', () => {
  assert.deepEqual(ok(applyPatch({port: 9000}, {port: ''})), {});
  assert.deepEqual(ok(applyPatch({voice: 'bf_emma'}, {voice: null})), {});
  assert.deepEqual(ok(applyPatch({speed: 1.5}, {speed: ''})), {});
});

test('applyPatch validates hotkey shape', () => {
  assert.equal(ok(applyPatch({}, {hotkey: 'CmdOrCtrl+Shift+S'})).hotkey, 'CmdOrCtrl+Shift+S');
  assert.match(applyPatch({}, {hotkey: 'JustS'}).error, /CmdOrCtrl\+Shift\+Space/);
});

test('applyPatch rejects an unknown voice', () => {
  const isVoice = id => id === 'af_heart';
  assert.equal(ok(applyPatch({}, {voice: 'af_heart'}, isVoice)).voice, 'af_heart');
  assert.match(applyPatch({}, {voice: 'nope'}, isVoice).error, /Unknown voice/);
});

test('applyPatch clamps speed to the range Kokoro handles', () => {
  assert.equal(ok(applyPatch({}, {speed: 1.5})).speed, 1.5);
  assert.match(applyPatch({}, {speed: 3}).error, /between 0.5 and 2/);
  assert.match(applyPatch({}, {speed: 0.1}).error, /between 0.5 and 2/);
});

test('applyPatch does not mutate the input config', () => {
  const before = {port: 9000};
  applyPatch(before, {port: 9001});
  assert.equal(before.port, 9000);
});

test('telemetry is tri-state: absent, true, or false', () => {
  assert.equal('telemetry' in ok(applyPatch({}, {})), false);
  assert.equal(ok(applyPatch({}, {telemetry: true})).telemetry, true);
  assert.equal(ok(applyPatch({}, {telemetry: false})).telemetry, false);
  assert.equal('telemetry' in ok(applyPatch({telemetry: true}, {telemetry: null})), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `Cannot find module '.../src/config.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/config.mjs`:

```js
// User settings live in ~/.chirp/config.json. The server, the CLI, and the
// desktop app all read this one file — which is the point: a voice picked in
// the UI is the voice the global hotkey uses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = path.join(os.homedir(), '.chirp', 'config.json');

export const DEFAULTS = Object.freeze({
  port: 8789,
  hotkey: 'CmdOrCtrl+Shift+Space',
  voice: 'af_heart',
  speed: 1,
});

// Accelerator-style hotkey: modifiers then one key, e.g. CmdOrCtrl+Shift+Space.
export const HOTKEY_RE = /^(?:(?:CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta)\+)+(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Return|Escape|Esc|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Minus|Equal|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote)$/i;

export const read = (file = CONFIG_PATH) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};

export const write = (cfg, file = CONFIG_PATH) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
};

export const resolve = cfg => ({...DEFAULTS, ...cfg});

const blank = v => v == null || v === '';

// Pure: returns {cfg} with the patch applied, or {error} describing the first
// invalid field. A blank value removes the override, restoring the default.
export function applyPatch(cfg, patch, isVoice = () => true) {
  const next = {...cfg};

  if ('port' in patch) {
    if (blank(patch.port)) delete next.port;
    else {
      const p = Number(patch.port);
      if (!Number.isInteger(p)) return {error: 'Port must be a whole number between 1024 and 65535.'};
      if (p < 1024 || p > 65535) return {error: 'Port must be a whole number between 1024 and 65535.'};
      next.port = p;
    }
  }

  if ('hotkey' in patch) {
    const h = typeof patch.hotkey === 'string' ? patch.hotkey.trim() : '';
    if (!h) delete next.hotkey;
    else if (!HOTKEY_RE.test(h)) return {error: 'Hotkey should look like CmdOrCtrl+Shift+Space.'};
    else next.hotkey = h;
  }

  if ('voice' in patch) {
    if (blank(patch.voice)) delete next.voice;
    else if (!isVoice(patch.voice)) return {error: `Unknown voice: ${patch.voice}`};
    else next.voice = patch.voice;
  }

  if ('speed' in patch) {
    if (blank(patch.speed)) delete next.speed;
    else {
      const s = Number(patch.speed);
      if (!Number.isFinite(s) || s < 0.5 || s > 2) return {error: 'Speed must be between 0.5 and 2.'};
      next.speed = s;
    }
  }

  if ('telemetry' in patch) {
    if (blank(patch.telemetry)) delete next.telemetry;
    else next.telemetry = Boolean(patch.telemetry);
  }

  return {cfg: next};
}
```

- [ ] **Step 4: Add the test script**

In `package.json`, add to `scripts`:

```json
"test": "node --test test/"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 9 tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add src/config.mjs test/config.test.mjs package.json
git commit -m "Extract config module; add voice and speed to settings"
```

---

### Task 2: Voice catalog

Replaces the hardcoded 11-voice list with the full 28-voice catalog, carrying each voice's quality grade. `kokoro-js` keeps its `VOICES` map private — it is only reachable through a loaded model instance — so the catalog is mirrored here to keep `GET /api/voices` answerable before the model has been downloaded.

Note while implementing: `am_adam` is currently in Chirp's curated list and grades **F+**, the worst voice in the set. `am_fenrir` and `am_puck` grade `C+` and were not exposed. The `recommended` flag below corrects this.

**Files:**
- Create: `src/voices.mjs`
- Create: `test/voices.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `VOICES: Array<{id, name, label, lang, gender, grade, recommended}>` sorted best-graded first
  - `DEFAULT_VOICE = 'af_heart'`
  - `isVoice(id: string) → boolean`
  - `gradeRank(grade: string) → number` (higher is better)

- [ ] **Step 1: Write the failing test**

Create `test/voices.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {VOICES, DEFAULT_VOICE, isVoice, gradeRank} from '../src/voices.mjs';

test('the catalog holds all 28 Kokoro v1.0 English voices', () => {
  assert.equal(VOICES.length, 28);
  assert.equal(new Set(VOICES.map(v => v.id)).size, 28);
});

test('every voice is American or British', () => {
  for (const v of VOICES) assert.ok(['en-us', 'en-gb'].includes(v.lang), v.id);
});

test('gradeRank orders letter grades and their modifiers', () => {
  assert.ok(gradeRank('A') > gradeRank('A-'));
  assert.ok(gradeRank('A-') > gradeRank('B-'));
  assert.ok(gradeRank('C+') > gradeRank('C'));
  assert.ok(gradeRank('C') > gradeRank('C-'));
  assert.ok(gradeRank('D-') > gradeRank('F+'));
});

test('the catalog is sorted best first', () => {
  const ranks = VOICES.map(v => gradeRank(v.grade));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
  assert.equal(VOICES[0].id, DEFAULT_VOICE);
});

test('the default voice exists and is the top-graded one', () => {
  assert.ok(isVoice(DEFAULT_VOICE));
  assert.equal(VOICES.find(v => v.id === DEFAULT_VOICE).grade, 'A');
});

test('isVoice rejects unknown and malicious ids', () => {
  assert.equal(isVoice('af_heart'), true);
  assert.equal(isVoice('nope'), false);
  assert.equal(isVoice('../../etc/passwd'), false);
  assert.equal(isVoice(undefined), false);
});

test('labels stay in the format the UI already parses', () => {
  const heart = VOICES.find(v => v.id === 'af_heart');
  assert.equal(heart.label, 'Heart (American, F)');
  const george = VOICES.find(v => v.id === 'bm_george');
  assert.equal(george.label, 'George (British, M)');
});

test('recommended voices exclude the F+ graded am_adam', () => {
  const adam = VOICES.find(v => v.id === 'am_adam');
  assert.equal(adam.grade, 'F+');
  assert.equal(adam.recommended, false);
});

test('every recommended voice grades C or better', () => {
  for (const v of VOICES.filter(v => v.recommended))
    assert.ok(gradeRank(v.grade) >= gradeRank('C'), `${v.id} is ${v.grade}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/voices.test.mjs`
Expected: FAIL — `Cannot find module '.../src/voices.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/voices.mjs`:

```js
// Voice catalog for onnx-community/Kokoro-82M-v1.0-ONNX as shipped in
// kokoro-js@1.2. The library keeps its VOICES map private — it is reachable
// only through a loaded model instance — so it is mirrored here, letting
// GET /api/voices answer before the ~90 MB model has been downloaded.
//
// Grades are the model author's own quality ratings. `recommended` is our
// shortlist: C or better, spread across accent and gender.

// id, name, lang, gender, grade, recommended
const RAW = [
  ['af_heart',    'Heart',    'en-us', 'F', 'A',  true],
  ['af_bella',    'Bella',    'en-us', 'F', 'A-', true],
  ['af_nicole',   'Nicole',   'en-us', 'F', 'B-', true],
  ['bf_emma',     'Emma',     'en-gb', 'F', 'B-', true],
  ['af_aoede',    'Aoede',    'en-us', 'F', 'C+', false],
  ['af_kore',     'Kore',     'en-us', 'F', 'C+', false],
  ['af_sarah',    'Sarah',    'en-us', 'F', 'C+', true],
  ['am_fenrir',   'Fenrir',   'en-us', 'M', 'C+', true],
  ['am_michael',  'Michael',  'en-us', 'M', 'C+', true],
  ['am_puck',     'Puck',     'en-us', 'M', 'C+', true],
  ['af_alloy',    'Alloy',    'en-us', 'F', 'C',  false],
  ['af_nova',     'Nova',     'en-us', 'F', 'C',  false],
  ['bf_isabella', 'Isabella', 'en-gb', 'F', 'C',  true],
  ['bm_george',   'George',   'en-gb', 'M', 'C',  true],
  ['bm_fable',    'Fable',    'en-gb', 'M', 'C',  true],
  ['af_sky',      'Sky',      'en-us', 'F', 'C-', false],
  ['bm_lewis',    'Lewis',    'en-gb', 'M', 'D+', false],
  ['af_jessica',  'Jessica',  'en-us', 'F', 'D',  false],
  ['af_river',    'River',    'en-us', 'F', 'D',  false],
  ['am_echo',     'Echo',     'en-us', 'M', 'D',  false],
  ['am_eric',     'Eric',     'en-us', 'M', 'D',  false],
  ['am_liam',     'Liam',     'en-us', 'M', 'D',  false],
  ['am_onyx',     'Onyx',     'en-us', 'M', 'D',  false],
  ['bf_alice',    'Alice',    'en-gb', 'F', 'D',  false],
  ['bf_lily',     'Lily',     'en-gb', 'F', 'D',  false],
  ['bm_daniel',   'Daniel',   'en-gb', 'M', 'D',  false],
  ['am_santa',    'Santa',    'en-us', 'M', 'D-', false],
  ['am_adam',     'Adam',     'en-us', 'M', 'F+', false],
];

const LETTER = {A: 5, B: 4, C: 3, D: 2, F: 1};
const MODIFIER = {'+': 1, '': 0, '-': -1};

// Higher is better. 'A' beats 'A-' beats 'B+'.
export const gradeRank = grade =>
  (LETTER[grade[0]] ?? 0) * 10 + (MODIFIER[grade.slice(1)] ?? 0);

const ACCENT = {'en-us': 'American', 'en-gb': 'British'};

export const VOICES = RAW
  .map(([id, name, lang, gender, grade, recommended]) => ({
    id, name, lang, gender, grade, recommended,
    label: `${name} (${ACCENT[lang]}, ${gender})`,
  }))
  .sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade));

export const DEFAULT_VOICE = 'af_heart';

const IDS = new Set(VOICES.map(v => v.id));
export const isVoice = id => IDS.has(id);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all config and voices tests

Note: the sort is not stable across equal grades in a way the test depends on, except that `af_heart` must sort first — it is the only `A`.

- [ ] **Step 5: Commit**

```bash
git add src/voices.mjs test/voices.test.mjs
git commit -m "Add full 28-voice catalog with quality grades"
```

---

### Task 3: TTS engine module

Wraps model loading and per-sentence generation. Sentence splitting uses `kokoro-js`'s own `TextSplitterStream` rather than the regex currently living in browser JS.

**Design note — a deliberate deviation from the spec.** The spec says "wire `tts.stream()` into the session". Using `KokoroTTS.stream()` directly would give sequential-only access, but the session needs to *regenerate an arbitrary sentence* after a skip-back or a cache eviction. So this module exposes `split()` plus a per-sentence `generate()` instead. `KokoroTTS.stream()` internally does exactly split-then-generate-per-sentence, so the audio is identical — and per-sentence calls additionally let a long document share the model fairly with one-shot `/api/tts` requests instead of monopolising it.

**Files:**
- Create: `src/tts.mjs`
- Create: `test/tts.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `split(text: string) → string[]`
  - `load() → Promise<KokoroTTS>`
  - `isLoaded() → boolean`
  - `generate(text: string, {voice, speed}) → Promise<Buffer>` (a complete WAV, serialized against other calls)
  - `events: EventEmitter` emitting `'model'` with `{loaded, progress?, error?}`

- [ ] **Step 1: Write the failing test**

Only `split` is unit-tested; `load` and `generate` require a 90 MB download and are covered by the release smoke check instead.

Create `test/tts.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {split, isLoaded} from '../src/tts.mjs';

test('split breaks text on sentence boundaries', () => {
  assert.deepEqual(
    split('Hello there. This is two! And a third?'),
    ['Hello there.', 'This is two!', 'And a third?'],
  );
});

test('split treats newlines as boundaries', () => {
  assert.deepEqual(split('One line\nAnother line'), ['One line', 'Another line']);
});

test('split drops empty and whitespace-only fragments', () => {
  assert.deepEqual(split('A.\n\n\n  \n B.'), ['A.', 'B.']);
});

test('split returns an empty array for empty input', () => {
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('   \n  '), []);
});

test('split keeps a lone unterminated sentence', () => {
  assert.deepEqual(split('no terminator here'), ['no terminator here']);
});

test('the model is not loaded just by importing the module', () => {
  assert.equal(isLoaded(), false);
});

test('a network failure during load is reported as an offline download', () => {
  assert.match(describeLoadError(new Error('getaddrinfo ENOTFOUND huggingface.co')), /offline/i);
  assert.match(describeLoadError(new Error('fetch failed')), /offline/i);
  assert.match(describeLoadError(new Error('Unexpected token')), /Unexpected token/);
  assert.doesNotMatch(describeLoadError(new Error('Unexpected token')), /offline/i);
});
```

Add `describeLoadError` to the import at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/tts.test.mjs`
Expected: FAIL — `Cannot find module '.../src/tts.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/tts.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tts.mjs test/tts.test.mjs
git commit -m "Extract TTS engine; use kokoro's own sentence splitter"
```

---

### Task 4: OS audio player

Owns the platform audio subprocess, distinguishes a natural end from a kill, and reports whether an audio player exists at all — which today fails silently on a Linux box without `aplay`.

**Files:**
- Create: `src/player.mjs`
- Create: `test/player.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `playerCommand(platform: string, file: string) → [cmd: string, args: string[]]`
  - `available(platform?: string, env?: object) → boolean`
  - `play(wav: Buffer, onEnd: () => void) → {stop(): void}` — `onEnd` fires exactly once, and never after `stop()`
  - `wavDurationMs(wav: Buffer) → number`

- [ ] **Step 1: Write the failing test**

Create `test/player.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/player.test.mjs`
Expected: FAIL — `Cannot find module '.../src/player.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/player.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/player.mjs test/player.test.mjs
git commit -m "Extract OS audio player; detect a missing player up front"
```

---

### Task 5: Playback session state machine

The heart of the change. One object owns the sentence queue, the index, and the player handle. Engine and player are injected, so every transition is tested without a model or an audio device.

**This task contains the regression test for the swallowed-hotkey bug.**

**Files:**
- Create: `src/playback.mjs`
- Create: `test/playback.test.mjs`

**Interfaces:**
- Consumes:
  - an `engine` shaped like `{split(text) → string[], generate(text, {voice, speed}) → Promise<Buffer>}` (satisfied by `src/tts.mjs`)
  - a `player` shaped like `{play(wav, onEnd) → {stop()}, wavDurationMs(wav) → number}` (satisfied by `src/player.mjs`)
- Produces: `createSession({engine, player, lookahead?, cacheLimit?}) → Session` where `Session` has
  - `start(text, {voice, speed}) → {count: number}`
  - `pause() → void`, `resume() → void`, `next() → void`, `prev() → void`, `stop() → void`
  - `toggle() → 'stopped' | 'resumed' | 'need_text'`
  - `setOptions({voice?, speed?}) → void`
  - `getState() → {state, index, count, voice, speed, startedAt, durationMs}`
  - `getSentences() → string[]`
  - `on(event, handler)` / `off(event, handler)` for `'state'`, `'sentences'`, `'fault'`

- [ ] **Step 1: Write the failing test**

Create `test/playback.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../src/playback.mjs';

// Let queued promise callbacks run. Generation is faked as instant, but it
// still resolves through the microtask queue.
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};

function fakeEngine({failOn = () => false} = {}) {
  const calls = [];
  return {
    calls,
    split: text => text.split('|').map(s => s.trim()).filter(Boolean),
    async generate(text, opts) {
      calls.push({text, ...opts});
      if (failOn(text)) throw new Error(`cannot say ${text}`);
      return Buffer.from(text);
    },
  };
}

function fakePlayer() {
  const p = {current: null, stops: 0, played: []};
  p.play = (wav, onEnd) => {
    p.current = {wav, onEnd};
    p.played.push(wav.toString());
    return {stop() { p.stops++; if (p.current?.wav === wav) p.current = null; }};
  };
  p.wavDurationMs = () => 1000;
  // Simulate the audio running to its natural end.
  p.finish = () => { const c = p.current; p.current = null; c.onEnd(); };
  return p;
}

const build = engineOpts => {
  const engine = fakeEngine(engineOpts);
  const player = fakePlayer();
  return {engine, player, session: createSession({engine, player})};
};

test('a new session is idle', () => {
  const {session} = build();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.getState().count, 0);
});

test('start splits the text and plays the first sentence', async () => {
  const {session, player} = build();
  assert.equal(session.start('one|two|three', {voice: 'af_heart', speed: 1}).count, 3);
  await settle();
  assert.equal(session.getState().state, 'speaking');
  assert.equal(session.getState().index, 0);
  assert.deepEqual(player.played, ['one']);
});

test('sentences advance on their own as each finishes', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  player.finish();
  await settle();
  assert.equal(session.getState().index, 1);
  assert.deepEqual(player.played, ['one', 'two']);
});

test('generation runs ahead of playback', async () => {
  const {session, engine} = build();
  session.start('a|b|c|d|e|f|g', {voice: 'af_heart', speed: 1});
  await settle();
  // Sentence 0 plus a bounded lookahead — not the whole document.
  assert.ok(engine.calls.length >= 2, `generated ${engine.calls.length}`);
  assert.ok(engine.calls.length < 7, `generated ${engine.calls.length}, expected a bounded lookahead`);
});

test('generate is called with the session voice and speed', async () => {
  const {session, engine} = build();
  session.start('one', {voice: 'bm_george', speed: 1.5});
  await settle();
  assert.equal(engine.calls[0].voice, 'bm_george');
  assert.equal(engine.calls[0].speed, 1.5);
});

test('pause stops the player and holds the index', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  assert.equal(session.getState().state, 'paused');
  assert.equal(session.getState().index, 0);
  assert.equal(player.stops, 1);
});

test('resume replays the sentence it paused on', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  session.resume();
  await settle();
  assert.equal(session.getState().state, 'speaking');
  assert.deepEqual(player.played, ['one', 'one']);
});

test('next skips forward', async () => {
  const {session, player} = build();
  session.start('one|two|three', {voice: 'af_heart', speed: 1});
  await settle();
  session.next();
  await settle();
  assert.equal(session.getState().index, 1);
  assert.deepEqual(player.played, ['one', 'two']);
});

test('prev goes back and does not run off the start', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.prev();
  await settle();
  assert.equal(session.getState().index, 0);
});

test('next past the last sentence finishes the session', async () => {
  const {session} = build();
  session.start('one', {voice: 'af_heart', speed: 1});
  await settle();
  session.next();
  await settle();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.getState().index, 1, 'index rests at count so the transcript reads as fully spoken');
});

test('stop clears the session', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.stop();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.getState().index, 0);
  assert.equal(session.getState().count, 0);
});

test('a sentence that will not generate is skipped, not fatal', async () => {
  const {session, player} = build({failOn: t => t === 'two'});
  const faults = [];
  session.on('fault', f => faults.push(f));
  session.start('one|two|three', {voice: 'af_heart', speed: 1});
  await settle();
  player.finish();
  await settle(16);
  assert.equal(faults.length, 1);
  assert.equal(faults[0].index, 1);
  assert.deepEqual(player.played, ['one', 'three']);
});

test('three consecutive failures stop the session', async () => {
  const {session} = build({failOn: () => true});
  session.start('a|b|c|d|e', {voice: 'af_heart', speed: 1});
  await settle(24);
  assert.equal(session.getState().state, 'idle');
});

test('changing voice mid-session restarts the current sentence with it', async () => {
  const {session, engine, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.setOptions({voice: 'bf_emma'});
  await settle();
  assert.equal(session.getState().voice, 'bf_emma');
  assert.equal(session.getState().index, 0, 'position is preserved');
  assert.equal(engine.calls.at(-1).voice, 'bf_emma');
  assert.deepEqual(player.played.slice(-1), ['one']);
});

test('starting a new session while speaking replaces the old one', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.start('alpha', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(session.getState().count, 1);
  assert.equal(session.getState().index, 0);
  assert.deepEqual(player.played.at(-1), 'alpha');
});

test('start with no speakable text stays idle', async () => {
  const {session} = build();
  assert.equal(session.start('   |  ', {voice: 'af_heart', speed: 1}).count, 0);
  await settle();
  assert.equal(session.getState().state, 'idle');
});

test('state events carry timing for the progress bar', async () => {
  const {session} = build();
  const seen = [];
  session.on('state', s => seen.push(s));
  session.start('one', {voice: 'af_heart', speed: 1});
  await settle();
  const last = seen.at(-1);
  assert.equal(last.durationMs, 1000);
  assert.ok(last.startedAt > 0);
});

test('a sentences event fires once per start', async () => {
  const {session} = build();
  const seen = [];
  session.on('sentences', s => seen.push(s));
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].sentences, ['one', 'two']);
});

// --- toggle: the hotkey contract ---

test('toggle on an idle session asks for text', () => {
  const {session} = build();
  assert.equal(session.toggle(), 'need_text');
});

test('toggle while speaking stops', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  assert.equal(session.toggle(), 'stopped');
  assert.equal(session.getState().state, 'idle');
});

test('toggle while paused resumes', async () => {
  const {session} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  session.pause();
  assert.equal(session.toggle(), 'resumed');
  assert.equal(session.getState().state, 'speaking');
});

// REGRESSION: on main, Rust's PLAYING flag stayed true after audio ended on
// its own, so the next hotkey press POSTed /api/stop against a server with
// nothing to stop and returned early — swallowing the press. With the server
// owning the state, a session that ended naturally is idle, and toggle asks
// for text rather than reporting a stop.
test('after playing to its natural end, toggle asks for text (not "stopped")', async () => {
  const {session, player} = build();
  session.start('one|two', {voice: 'af_heart', speed: 1});
  await settle();
  player.finish();          // sentence one ends
  await settle();
  player.finish();          // sentence two ends — session is over
  await settle();
  assert.equal(session.getState().state, 'idle');
  assert.equal(session.toggle(), 'need_text', 'the next hotkey press must speak, not be swallowed');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/playback.test.mjs`
Expected: FAIL — `Cannot find module '.../src/playback.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/playback.mjs`:

```js
// The playback session: the single source of truth for what is being spoken
// and where we are in it.
//
// Before this existed, playback state lived in three places at once — an
// AtomicBool in Rust, a child-process handle in Node, and audio element
// bookkeeping in the browser — with nothing reconciling them. The hotkey and
// the tray now ask this object, and it is the only thing that knows.
//
// Audio is produced one sentence at a time, which gives three things at once:
// audio starts after the first sentence rather than the whole document,
// skip/prev have somewhere to land, and pause has a boundary. The OS players
// (afplay, aplay, PowerShell) cannot pause a running file, so pausing stops
// between sentences and resuming replays the current one.

import {EventEmitter} from 'node:events';

export function createSession({engine, player, lookahead = 3, cacheLimit = 50}) {
  const bus = new EventEmitter();

  let sentences = [];
  let index = 0;
  let state = 'idle';
  let voice;
  let speed;
  let startedAt = 0;
  let durationMs = 0;
  let failures = 0;

  let cache = new Map();    // index → WAV buffer
  let pending = new Map();  // index → Promise<Buffer>
  let handle = null;        // live player handle
  // Bumped by every control action. Async work captures it and bails if it
  // changed, so a generation in flight can never resurrect a stale sentence.
  let epoch = 0;

  const getState = () => ({
    state, index, count: sentences.length, voice, speed, startedAt, durationMs,
  });
  const getSentences = () => [...sentences];
  const emit = () => bus.emit('state', getState());

  function trim() {
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }

  function ensure(i) {
    if (i < 0 || i >= sentences.length) return null;
    if (cache.has(i)) return Promise.resolve(cache.get(i));
    if (pending.has(i)) return pending.get(i);
    const p = engine.generate(sentences[i], {voice, speed})
      .then(wav => { pending.delete(i); cache.set(i, wav); trim(); return wav; })
      .catch(e => { pending.delete(i); throw e; });
    pending.set(i, p);
    return p;
  }

  function prefetch() {
    for (let i = index + 1; i <= index + lookahead && i < sentences.length; i++) {
      ensure(i)?.catch(() => {});   // failures surface when we reach the sentence
    }
  }

  function kill() {
    epoch++;
    if (handle) { handle.stop(); handle = null; }
  }

  function finish() {
    kill();
    state = 'idle';
    index = sentences.length;   // transcript reads as fully spoken
    startedAt = 0;
    durationMs = 0;
    emit();
  }

  async function playCurrent() {
    const mine = epoch;
    if (index >= sentences.length) return finish();

    state = 'speaking';
    emit();

    let wav;
    try {
      wav = await ensure(index);
    } catch (e) {
      if (mine !== epoch) return;
      bus.emit('fault', {scope: 'generate', index, message: e.message});
      failures++;
      // One unspeakable sentence must not end a long read; a run of them means
      // something is actually broken.
      if (failures >= 3) { stop(); return; }
      index++;
      return playCurrent();
    }
    if (mine !== epoch) return;

    failures = 0;
    prefetch();

    startedAt = Date.now();
    durationMs = player.wavDurationMs(wav);
    emit();

    handle = player.play(wav, () => {
      if (mine !== epoch) return;
      handle = null;
      index++;
      if (index >= sentences.length) finish();
      else playCurrent();
    });
  }

  function start(text, options = {}) {
    kill();
    sentences = engine.split(text);
    voice = options.voice ?? voice;
    speed = options.speed ?? speed;
    cache = new Map();
    pending = new Map();
    index = 0;
    failures = 0;
    startedAt = 0;
    durationMs = 0;

    if (sentences.length === 0) {
      state = 'idle';
      emit();
      return {count: 0};
    }
    bus.emit('sentences', {sentences: getSentences(), voice, speed});
    playCurrent();
    return {count: sentences.length};
  }

  function pause() {
    if (state !== 'speaking') return;
    kill();
    state = 'paused';
    emit();
  }

  function resume() {
    if (state !== 'paused') return;
    kill();
    playCurrent();
  }

  function next() {
    if (state === 'idle') return;
    kill();
    index++;
    if (index >= sentences.length) finish();
    else playCurrent();
  }

  function prev() {
    if (state === 'idle') return;
    kill();
    index = Math.max(0, index - 1);
    playCurrent();
  }

  function stop() {
    kill();
    sentences = [];
    cache = new Map();
    pending = new Map();
    index = 0;
    failures = 0;
    state = 'idle';
    startedAt = 0;
    durationMs = 0;
    emit();
  }

  // The hotkey's whole contract. 'need_text' tells the caller to go capture
  // something to say — it must not pay that cost speculatively, because
  // capturing a selection has side effects.
  function toggle() {
    if (state === 'speaking') { stop(); return 'stopped'; }
    if (state === 'paused') { resume(); return 'resumed'; }
    return 'need_text';
  }

  // Voice or speed changed under a live session: everything cached was made
  // with the old settings, so drop it and re-speak from where we are.
  function setOptions({voice: nextVoice, speed: nextSpeed} = {}) {
    if (nextVoice !== undefined) voice = nextVoice;
    if (nextSpeed !== undefined) speed = nextSpeed;
    cache = new Map();
    pending = new Map();
    if (state === 'speaking') { kill(); playCurrent(); }
    else if (state === 'paused') { kill(); emit(); }
    else emit();
  }

  return {
    start, pause, resume, next, prev, stop, toggle, setOptions,
    getState, getSentences,
    on: (e, fn) => bus.on(e, fn),
    off: (e, fn) => bus.off(e, fn),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — including `after playing to its natural end, toggle asks for text (not "stopped")`

If the three-consecutive-failures test hangs, increase the `settle()` count in that test rather than adding timers to the implementation.

- [ ] **Step 5: Commit**

```bash
git add src/playback.mjs test/playback.test.mjs
git commit -m "Add playback session: one owner for sentence queue and position

Regression-tests the swallowed hotkey press: a session that ends on its
own is idle, so the next toggle speaks instead of reporting a stop."
```

---

### Task 6: Extract the web UI to static files

Pure extraction, no behaviour change. `server.mjs` is 640 lines of which 435 are an HTML template string; the remaining tasks cannot land in that.

**Files:**
- Create: `ui/index.html`, `ui/style.css`, `ui/app.js`
- Create: `src/static.mjs`
- Create: `test/static.test.mjs`
- Modify: `server.mjs` (remove the `PAGE` constant, serve from disk)

**Interfaces:**
- Consumes: nothing
- Produces: `serveStatic(req, res, urlPath) → boolean` — returns `true` if it handled the request

- [ ] **Step 1: Split the page into three files**

Copy from `server.mjs` verbatim, changing nothing but the packaging:
- Everything inside `<style>…</style>` → `ui/style.css`
- Everything inside `<script>…</script>` → `ui/app.js`
- The remaining markup → `ui/index.html`, with `<link rel="stylesheet" href="/style.css">` in the head and `<script src="/app.js"></script>` before `</body>`

Two template interpolations must be replaced, because the file is no longer a JS template string:
- `maxlength="${MAX_CHARS}"` → `maxlength="2000"`
- `port ${PORT}` → `port <span id="portLabel">…</span>`, filled by `app.js` from `GET /api/settings`
- In `app.js`, `var MAX=${MAX_CHARS}` → `var MAX=2000`

Escaped sequences in the old template string (`\\u00d7`, `\\n`, `\\(`) become their plain forms (`\u00d7`, `\n`, `\(`) now that JS is no longer nested inside a template literal.

- [ ] **Step 2: Write the failing test**

Create `test/static.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {contentType, resolveAsset} from '../src/static.mjs';

const UI = path.join(import.meta.dirname, '..', 'ui');

test('the three UI files exist', () => {
  for (const f of ['index.html', 'style.css', 'app.js'])
    assert.ok(fs.existsSync(path.join(UI, f)), f);
});

test('index.html links the extracted assets', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.match(html, /href="\/style\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /\$\{/, 'no leftover template interpolation');
});

test('app.js carries no leftover template interpolation', () => {
  const js = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.doesNotMatch(js, /\$\{MAX_CHARS\}/);
});

test('contentType maps the extensions we serve', () => {
  assert.match(contentType('/index.html'), /^text\/html/);
  assert.match(contentType('/style.css'), /^text\/css/);
  assert.match(contentType('/app.js'), /javascript/);
});

test('resolveAsset maps / to index.html', () => {
  assert.equal(path.basename(resolveAsset('/')), 'index.html');
});

test('resolveAsset refuses to escape the ui directory', () => {
  assert.equal(resolveAsset('/../server.mjs'), null);
  assert.equal(resolveAsset('/../../etc/passwd'), null);
  assert.equal(resolveAsset('/%2e%2e/server.mjs'), null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/static.test.mjs`
Expected: FAIL — `Cannot find module '.../src/static.mjs'`

- [ ] **Step 4: Write the implementation**

Create `src/static.mjs`:

```js
// Serves the web UI from ui/. Path traversal is refused rather than
// sanitised — there is nothing under ui/ worth guessing at, and the server
// binds 127.0.0.1, but a local HTTP surface with CORS wide open should still
// never hand out arbitrary files.

import fs from 'node:fs';
import path from 'node:path';

const UI_DIR = path.join(import.meta.dirname, '..', 'ui');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export const contentType = urlPath =>
  TYPES[path.extname(urlPath).toLowerCase()] ?? 'application/octet-stream';

export function resolveAsset(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(UI_DIR, rel);
  if (full !== UI_DIR && !full.startsWith(UI_DIR + path.sep)) return null;
  return full;
}

export function serveStatic(req, res, urlPath) {
  const file = resolveAsset(urlPath);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Cache-Control': 'no-cache',
  });
  res.end(fs.readFileSync(file));
  return true;
}
```

- [ ] **Step 5: Wire it into server.mjs**

Delete the `PAGE` constant entirely. Replace the `GET /` route with, before the 404:

```js
if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
```

Add `import {serveStatic} from './src/static.mjs';` at the top.

- [ ] **Step 6: Run the tests and check the page by hand**

Run: `npm test`
Expected: PASS

Run: `npm start`, open `http://127.0.0.1:8789`, and confirm the page renders identically — sidebar, amber accent, textarea, Speak button. Type a sentence and press Speak; audio should play as before. Then `Ctrl-C`.

- [ ] **Step 7: Commit**

```bash
git add ui/ src/static.mjs test/static.test.mjs server.mjs
git commit -m "Extract the web UI into ui/ static files"
```

---

### Task 7: Routes module with the playback API

Moves routing out of `server.mjs`, wires the session in, and adds the playback endpoints and the SSE feed. `POST /api/tts` keeps its character cap and complete-WAV contract; the session paths have no cap.

**Files:**
- Create: `src/routes.mjs`
- Create: `test/routes.test.mjs`
- Modify: `server.mjs` (becomes a thin entry point)

**Interfaces:**
- Consumes: `createSession` (Task 5), `config` (Task 1), `voices` (Task 2), `tts` (Task 3), `player` (Task 4), `serveStatic` (Task 6)
- Produces: `createRoutes({session, tts, voices, config, player, activePort}) → (req, res) => void`

- [ ] **Step 1: Write the failing test**

Create `test/routes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createRoutes} from '../src/routes.mjs';
import {createSession} from '../src/playback.mjs';
import * as voices from '../src/voices.mjs';
import * as config from '../src/config.mjs';

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function harness() {
  const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-test-')), 'config.json');
  const engine = {
    split: t => t.split('|').map(s => s.trim()).filter(Boolean),
    generate: async t => Buffer.from(t),
  };
  const player = {
    current: null,
    wavDurationMs: () => 1000,
    play(wav, onEnd) { player.current = {wav, onEnd}; return {stop() { player.current = null; }}; },
    finish() { const c = player.current; player.current = null; c.onEnd(); },
  };
  const session = createSession({engine, player});
  const tts = {
    split: engine.split,
    generate: engine.generate,
    isLoaded: () => true,
    load: async () => {},
    events: new EventEmitter(),
  };
  const server = http.createServer(createRoutes({
    session, tts, voices, config, player,
    configFile: cfgFile,
    activePort: 8789,
    audioOut: true,
  }));
  return {server, session, player, cfgFile};
}

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? {'Content-Type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return {status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer()};
}

test('GET /api/voices lists all 28 with grades', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {status, body} = await call(port, 'GET', '/api/voices');
  assert.equal(status, 200);
  assert.equal(body.length, 28);
  assert.ok('grade' in body[0] && 'recommended' in body[0]);
});

test('GET /api/health reports model and audio availability', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {body} = await call(port, 'GET', '/api/health');
  assert.equal(body.ok, true);
  assert.equal(body.modelLoaded, true);
  assert.equal(body.audioOut, true);
});

test('POST /api/speak starts a session', async t => {
  const {server, session} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {status, body} = await call(port, 'POST', '/api/speak', {text: 'one|two'});
  assert.equal(status, 200);
  assert.equal(body.count, 2);
  await settle();
  assert.equal(session.getState().state, 'speaking');
});

test('POST /api/speak has no character cap', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {status} = await call(port, 'POST', '/api/speak', {text: 'x.'.repeat(5000)});
  assert.equal(status, 200);
});

test('POST /api/tts keeps its cap so the WAV stays bounded', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {status, body} = await call(port, 'POST', '/api/tts', {text: 'x'.repeat(2001)});
  assert.equal(status, 400);
  assert.match(body.error, /too long/);
});

test('POST /api/speak rejects empty text', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {status} = await call(port, 'POST', '/api/speak', {text: '   '});
  assert.equal(status, 400);
});

test('toggle reports need_text when idle and stopped when speaking', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  assert.equal((await call(port, 'POST', '/api/playback/toggle')).body.action, 'need_text');
  await call(port, 'POST', '/api/speak', {text: 'one|two'});
  await settle();
  assert.equal((await call(port, 'POST', '/api/playback/toggle')).body.action, 'stopped');
});

// REGRESSION, over HTTP this time: the hotkey path must not be swallowed
// after a session ends on its own.
test('toggle asks for text after the session ends naturally', async t => {
  const {server, player} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  await call(port, 'POST', '/api/speak', {text: 'only one'});
  await settle();
  player.finish();
  await settle();
  assert.equal((await call(port, 'POST', '/api/playback/toggle')).body.action, 'need_text');
});

test('GET /api/playback reports the live state', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  await call(port, 'POST', '/api/speak', {text: 'one|two'});
  await settle();
  const {body} = await call(port, 'GET', '/api/playback');
  assert.equal(body.state, 'speaking');
  assert.equal(body.count, 2);
  assert.deepEqual(body.sentences, ['one', 'two']);
});

test('the playback transport endpoints move the index', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  await call(port, 'POST', '/api/speak', {text: 'one|two|three'});
  await settle();
  await call(port, 'POST', '/api/playback/next');
  await settle();
  assert.equal((await call(port, 'GET', '/api/playback')).body.index, 1);
  await call(port, 'POST', '/api/playback/prev');
  await settle();
  assert.equal((await call(port, 'GET', '/api/playback')).body.index, 0);
  await call(port, 'POST', '/api/playback/pause');
  assert.equal((await call(port, 'GET', '/api/playback')).body.state, 'paused');
});

test('settings round-trip voice and speed', async t => {
  const {server, cfgFile} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const saved = await call(port, 'POST', '/api/settings', {voice: 'bm_george', speed: 1.5});
  assert.equal(saved.status, 200);
  const got = await call(port, 'GET', '/api/settings');
  assert.equal(got.body.voice, 'bm_george');
  assert.equal(got.body.speed, 1.5);
  assert.match(fs.readFileSync(cfgFile, 'utf8'), /bm_george/);
});

test('settings reject an unknown voice', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const {status, body} = await call(port, 'POST', '/api/settings', {voice: 'nope'});
  assert.equal(status, 400);
  assert.match(body.error, /Unknown voice/);
});

// This is the second bug: the hotkey path used to hardcode af_heart at 1x,
// ignoring whatever the user had chosen.
test('speak with no voice uses the saved voice, not a hardcoded default', async t => {
  const {server, session} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  await call(port, 'POST', '/api/settings', {voice: 'bm_george', speed: 1.25});
  await call(port, 'POST', '/api/speak', {text: 'hello'});
  await settle();
  assert.equal(session.getState().voice, 'bm_george');
  assert.equal(session.getState().speed, 1.25);
});

test('CORS preflight is answered', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/api/tts`, {method: 'OPTIONS'});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('the SSE feed opens and pushes a state frame', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/api/playback/events`);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/);
  await reader.cancel();
});

test('unknown paths 404', async t => {
  const {server} = harness();
  const port = await listen(server);
  t.after(() => server.close());
  assert.equal((await call(port, 'GET', '/api/nope')).status, 404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/routes.test.mjs`
Expected: FAIL — `Cannot find module '.../src/routes.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/routes.mjs`:

```js
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

      // A live session should follow the settings change rather than finish
      // in the old voice.
      if ('voice' in body || 'speed' in body) {
        const now = config.resolve(result.cfg);
        session.setOptions({voice: now.voice, speed: now.speed});
      }
      const now = config.resolve(result.cfg);
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

    if (GET && serveStatic(req, res, p)) return;
    send(res, 404, {error: 'Not found.'});
  };
}
```

- [ ] **Step 4: Rewrite server.mjs as a thin entry point**

Replace the whole of `server.mjs` with:

```js
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
import * as config from './src/config.mjs';
import * as voices from './src/voices.mjs';
import * as tts from './src/tts.mjs';
import * as player from './src/player.mjs';
import {createSession} from './src/playback.mjs';
import {createRoutes} from './src/routes.mjs';

const stored = config.read();
const PORT = Number(process.env.CHIRP_PORT ?? stored.port ?? config.DEFAULTS.port);

const session = createSession({engine: tts, player});
const audioOut = player.available();
if (!audioOut) console.warn('chirp: no system audio player found — /api/speak will not be audible');

const server = http.createServer(createRoutes({
  session, tts, voices, config, player, activePort: PORT, audioOut,
}));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chirp listening on http://127.0.0.1:${PORT} (model loads on first speak)`);
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites

- [ ] **Step 6: Check it by hand**

Run `npm start`, then:

```bash
curl -s localhost:8789/api/health
curl -s -XPOST localhost:8789/api/playback/toggle          # → {"action":"need_text",...}
curl -s -XPOST localhost:8789/api/speak -H 'content-type: application/json' \
  -d '{"text":"First sentence. Second sentence. Third one."}'
curl -s localhost:8789/api/playback                        # → speaking, index advancing
curl -s -XPOST localhost:8789/api/playback/toggle          # → {"action":"stopped"}
```

Audio should begin within about a second of the `speak` call — noticeably sooner than before, because only the first sentence has to be generated.

- [ ] **Step 7: Commit**

```bash
git add src/routes.mjs test/routes.test.mjs server.mjs
git commit -m "Add playback HTTP API; settings now drive every speech path

Fixes /api/speak hardcoding af_heart at 1x regardless of saved settings."
```

---

### Task 8: Web UI as a remote control

Replaces the browser's own `<audio>` playback with the server session. The transcript then highlights for clipboard and hotkey playback too, not just for text typed into the page.

**Files:**
- Modify: `ui/app.js`, `ui/index.html`

**Interfaces:**
- Consumes: `GET /api/playback/events`, `POST /api/speak`, `POST /api/playback/*`, `GET|POST /api/settings`
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Replace the player section of ui/app.js**

Delete the whole player block — `RATES`, `chunks`, `urls`, `promises`, `cur`, `playing`, `raf`, `session`, `splitText`, `fetchChunk`, `paint`, `tick`, `stopAudio`, `playChunk`, and the `speak` click handler's chunking. Replace with:

```js
 // The server owns playback; this is a remote control and a transcript view.
 // Position within the current sentence is interpolated locally from
 // startedAt/durationMs so the progress bar stays smooth without a chatty feed.
 var state={state:'idle',index:0,count:0,startedAt:0,durationMs:0},sentences=[],raf=0;
 var player=$('player'),track=$('track'),transcript=$('transcript'),playBtn=$('play'),rateBtn=$('rate'),
  playSvg=playBtn.querySelector('svg'),
  PLAY='<path d="M5 3v10l8-5z"/>',PAUSE='<path d="M4 3h3v10H4zM9 3h3v10H9z"/>';

 function renderTranscript(){
  track.innerHTML='';transcript.innerHTML='';
  var total=sentences.reduce(function(a,c){return a+c.length},0)||1;
  sentences.forEach(function(c,i){
   var seg=document.createElement('div');seg.className='seg';
   seg.style.width=(c.length/total*100)+'%';
   seg.appendChild(document.createElement('i'));
   seg.addEventListener('click',function(){seek(i)});
   track.appendChild(seg);
   var span=document.createElement('span');span.textContent=c+' ';
   span.addEventListener('click',function(){seek(i)});
   transcript.appendChild(span);
  });
  player.hidden=sentences.length===0;
 }

 function paint(){
  var segs=track.children;
  var frac=0;
  if(state.state==='speaking'&&state.durationMs)
   frac=Math.min(1,(Date.now()-state.startedAt)/state.durationMs);
  for(var i=0;i<segs.length;i++){
   var f=i<state.index?100:i===state.index?frac*100:0;
   segs[i].firstChild.style.width=f+'%';
  }
  var spans=transcript.children;
  for(var j=0;j<spans.length;j++)
   spans[j].className=j<state.index?'done':j===state.index?'active':'';
  playSvg.innerHTML=state.state==='speaking'?PAUSE:PLAY;
  playBtn.setAttribute('aria-label',state.state==='speaking'?'Pause':'Play');
 }

 function tick(){paint();raf=requestAnimationFrame(tick)}
 function startTicking(){if(!raf)tick()}
 function stopTicking(){cancelAnimationFrame(raf);raf=0;paint()}

 function post(path,body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},
   body:body?JSON.stringify(body):undefined})
   .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d})});
 }

 // No per-sentence seek endpoint: step from where we are. Sessions are short
 // enough that this is instant, and it keeps the API to one concept.
 function seek(i){
  var steps=i-state.index,fn=steps<0?'prev':'next',n=Math.abs(steps);
  var chain=Promise.resolve();
  for(var k=0;k<n;k++)chain=chain.then(function(){return post('/api/playback/'+fn)});
  chain.catch(function(e){fail(e.message)});
 }

 var es=new EventSource('/api/playback/events');
 es.addEventListener('sentences',function(e){
  var d=JSON.parse(e.data);
  sentences=d.sentences||[];
  renderTranscript();
 });
 es.addEventListener('state',function(e){
  state=JSON.parse(e.data);
  if(state.count!==sentences.length&&state.count===0){sentences=[];renderTranscript()}
  if(state.state==='speaking')startTicking();else stopTicking();
  if(state.state!=='idle')setReady();
  var active=transcript.children[state.index];
  if(active&&state.state==='speaking')active.scrollIntoView({block:'nearest'});
 });
 // EventSource fires a native 'error' (with no .data) when the connection
 // drops, and the browser reconnects on its own. Only our server-sent frames
 // carry data, so parsing defensively keeps a reconnect from showing as a
 // speech failure.
 es.addEventListener('error',function(e){
  try{fail(JSON.parse(e.data).message)}catch(_){}
 });
 es.addEventListener('model',function(e){
  var m=JSON.parse(e.data);
  if(m.error)return fail(m.error);
  if(m.loaded)return setReady();
  statusText.textContent=m.progress!=null
   ? 'Downloading model — '+Math.round(m.progress*100)+'%'
   : 'Warming up…';
 });

 playBtn.addEventListener('click',function(){
  if(state.state==='speaking')post('/api/playback/pause').catch(function(e){fail(e.message)});
  else if(state.state==='paused')post('/api/playback/resume').catch(function(e){fail(e.message)});
  else speak.click();
 });
 $('prev').addEventListener('click',function(){post('/api/playback/prev').catch(function(e){fail(e.message)})});
 $('next').addEventListener('click',function(){post('/api/playback/next').catch(function(e){fail(e.message)})});

 // Rate now changes the generated speech, not just the playback rate of an
 // already-rendered clip, so it re-speaks the current sentence.
 var RATES=[0.75,1,1.25,1.5,2];
 rateBtn.addEventListener('click',function(){
  var i=(RATES.indexOf(+speed.value)+1)%RATES.length;
  speed.value=RATES[i];showSpeed();rateBtn.textContent=fmtSpeed(RATES[i]);
  post('/api/settings',{speed:RATES[i]}).catch(function(e){fail(e.message)});
 });

 speak.addEventListener('click',function(){
  err.style.display='none';
  var text=t.value.trim();
  if(!text)return fail('Type something first.');
  track_('speak',{chars:text.length,voice:sel.value});
  speak.disabled=true;speak.textContent='Generating\u2026';
  post('/api/speak',{text:text,voice:sel.value,speed:+speed.value})
   .then(function(){speak.disabled=false;speak.textContent='Speak';dl.disabled=false})
   .catch(function(e){speak.disabled=false;speak.textContent='Speak';fail(e.message)});
 });
```

- [ ] **Step 2: Fix the collisions the rewrite introduces**

`track` is now both a DOM element and the old analytics function name. Rename the analytics helper to `track_` at its definition and both remaining call sites (`download`, `consent`).

Also change:
- delete `var audio=null;` from the top of the file — nothing in the browser
  holds audio any more
- the textarea `input` handler — it no longer needs to reset chunks:
  `t.addEventListener('input',function(){updateCount()});`
- voice `change` should persist to the server, not just `localStorage`:
  ```js
  sel.addEventListener('change',function(){
   localStorage.setItem('chirp.voice',sel.value);
   post('/api/settings',{voice:sel.value}).catch(function(e){flash(e.message,true)});
  });
  ```
- the settings fetch should seed voice and speed from the server, since the
  config file is now authoritative:
  ```js
  speed.value=s.speed;showSpeed();rateBtn.textContent=fmtSpeed(s.speed);
  if(s.voice)sel.value=s.voice;
  $('portLabel').textContent=s.activePort;
  if(s.hotkeyOk===false)flash('That hotkey is in use by another app.',true);
  ```
  Move the `sel.value` assignment so it runs after `/api/voices` has populated
  the `<select>` — chain it, or re-apply inside the voices `.then()`.
- the voice `<select>` should group by recommendation, using the new fields:
  ```js
  var rec=vs.filter(function(v){return v.recommended}),rest=vs.filter(function(v){return !v.recommended});
  var group=function(label,list){
   return list.length?'<optgroup label="'+label+'">'+list.map(function(v){
    return '<option value="'+v.id+'">'+v.name+' \u00b7 '+(v.lang==='en-gb'?'GB':'US')+' '+v.gender+'</option>'
   }).join('')+'</optgroup>':''};
  sel.innerHTML=group('Recommended',rec)+group('All voices',rest);
  ```

- [ ] **Step 3: Add the port label span to ui/index.html**

Replace the hint line's port text with:

```html
<span><code>POST /api/tts</code> · port <span id="portLabel">…</span> · local only</span>
```

- [ ] **Step 4: Verify by hand**

Run `npm start` and open the page.

1. Type three sentences, press Speak. Audio comes out of the **system**, and the transcript highlights sentence by sentence.
2. Press Pause mid-read, then Play — it resumes from the start of that sentence.
3. Press Next and Prev — the highlight and audio jump.
4. Click a sentence in the transcript — playback moves to it.
5. Change the voice — the current sentence re-speaks in the new voice.
6. In a **second browser tab**, open the same page: it shows the same live state. This is the proof that the server owns the truth.
7. `curl -s -XPOST localhost:8789/api/speak -H 'content-type: application/json' -d '{"text":"Typed nowhere near the browser."}'` — the open tab renders the transcript and follows along.

- [ ] **Step 5: Commit**

```bash
git add ui/
git commit -m "Web UI becomes a remote control for the server session"
```

---

### Task 9: Rust — delete the duplicated playback flag

Removes the `PLAYING` `AtomicBool` that caused the swallowed hotkey press, and points the hotkey at the toggle endpoint.

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `POST /api/playback/toggle` → `{action}` (Task 7), `POST /api/speak` (Task 7), `POST /api/hotkey-status` (Task 7)
- Produces: nothing

- [ ] **Step 1: Delete the PLAYING static**

Remove these lines (currently `lib.rs:28-30`):

```rust
// Best-effort playback state: set once /api/speak accepts an utterance,
// cleared on /api/stop. Drives the hotkey's speak/stop toggle.
static PLAYING: AtomicBool = AtomicBool::new(false);
```

And drop the now-unused import: `use std::sync::atomic::{AtomicBool, Ordering};`

- [ ] **Step 2: Rewrite toggle_speak**

Replace the whole function (currently `lib.rs:73-98`) with:

```rust
// Hotkey: ask the server what to do. It is the only thing that knows whether
// audio is playing, so it decides — and only tells us to fetch text when it
// actually needs some. Reading the clipboard is cheap, but capturing a
// selection (Phase 2) will not be, so the "need_text" round trip stays.
fn toggle_speak(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(res) = ureq::post(format!("{}/api/playback/toggle", base_url())).send_empty() else {
            eprintln!("chirp: toggle failed — is the server running?");
            return;
        };
        let Ok(body) = res.into_body().read_json::<serde_json::Value>() else {
            return;
        };
        if body.get("action").and_then(|v| v.as_str()) != Some("need_text") {
            return;
        }
        let Ok(text) = app.clipboard().read_text() else {
            return;
        };
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let _ = ureq::post(format!("{}/api/speak", base_url()))
            .send_json(serde_json::json!({"text": text}));
    });
}
```

Note: `res.into_body().read_json::<T>()` is the ureq 3 API (`ureq = { version = "3", features = ["json"] }` is already in `Cargo.toml`). If `cargo check` disagrees on the exact shape, use `res.body_mut().read_json::<serde_json::Value>()` instead — do not add a dependency to work around it.

- [ ] **Step 3: Report hotkey registration failures to the server**

In `run()`, replace the registration block (currently `lib.rs:245-249`) with:

```rust
            let registered = register_hotkey(app.handle(), shortcut);
            if let Err(e) = &registered {
                eprintln!("chirp: could not register hotkey {hotkey}: {e}");
            } else {
                eprintln!("chirp: hotkey registered: {hotkey}");
            }
            // Let Settings say "in use by another app" instead of the hotkey
            // silently doing nothing.
            let ok = registered.is_ok();
            std::thread::spawn(move || {
                let _ = ureq::post(format!("{}/api/hotkey-status", base_url()))
                    .send_json(serde_json::json!({"ok": ok, "hotkey": hotkey}));
            });
```

`hotkey` is moved into the thread, so read it before this block if it is needed later. It is not.

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo check`
Expected: no errors, no warnings about unused imports. Fix any `Ordering`/`AtomicBool` leftovers.

- [ ] **Step 5: Verify the bug is gone, by hand**

This is the acceptance test for the whole plan. Build and run the desktop app:

Run: `npm run tauri dev`

1. Copy a sentence. Press the hotkey → it speaks.
2. **Let it finish on its own.**
3. Press the hotkey again → **it speaks immediately.** On `main` this press was swallowed and you had to press a third time.
4. Copy a longer paragraph, press the hotkey, and press it again mid-sentence → it stops.
5. Set a non-default voice in Settings, then press the hotkey → **it speaks in that voice.** On `main` it always used Heart.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "Delete the duplicated playback flag; hotkey asks the server

The AtomicBool in the desktop app went stale whenever audio finished on
its own, so the next hotkey press was spent on a no-op stop. The server
owns playback state now, so there is nothing to go stale."
```

---

### Task 10: Packaging, CLI, and docs

Ships the new module layout inside the desktop bundle, teaches `say.mjs` the new capabilities, and updates the README.

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `say.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Bundle the new directories**

In `src-tauri/tauri.conf.json`, extend `bundle.resources`:

```json
    "resources": {
      "../server.mjs": "server.mjs",
      "../src": "src",
      "../ui": "ui",
      "../node_modules": "node_modules"
    },
```

The sidecar already launches `resource_dir/server.mjs`, and `./src/…` and `./ui/…` resolve relative to it, so no Rust change is needed.

- [ ] **Step 2: Teach say.mjs stdin, speed, and the session**

Replace the argument parsing and request in `say.mjs` with:

```js
const args = process.argv.slice(2);
let text = null, voice, out, speed, useSystem = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-v') voice = args[++i];
  else if (args[i] === '-o') out = args[++i];
  else if (args[i] === '-s') speed = Number(args[++i]);
  else if (args[i] === '--system') useSystem = true;
  else if (args[i] === '--voices') { await listVoices(); process.exit(0); }
  else if (text === null) text = args[i];
}

// Piping is the point: `pbpaste | say` and `cat notes.md | say --system`.
if (text === null && !process.stdin.isTTY) {
  text = await new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}

if (!text || !text.trim()) {
  console.error('usage: say "text" [-v voice] [-s speed] [-o out.wav] [--system] [--voices]');
  console.error('       cat file.txt | say --system');
  process.exit(2);
}

async function listVoices() {
  const r = await fetch(`${BASE}/api/voices`);
  for (const v of await r.json())
    console.log(`${v.id.padEnd(14)} ${v.grade.padEnd(3)} ${v.label}${v.recommended ? '  ★' : ''}`);
}
```

Then branch on `useSystem`, which routes through the session and so has no length limit:

```js
if (useSystem) {
  const res = await fetch(`${BASE}/api/speak`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text, voice, speed}),
  });
  const data = await res.json();
  if (!res.ok) { console.error(data.error); process.exit(1); }
  console.log(`speaking ${data.count} sentence${data.count === 1 ? '' : 's'}`);
  process.exit(0);
}
```

Leave the existing one-shot WAV path below it for `-o` and default playback, adding `speed` to its request body.

- [ ] **Step 3: Verify the CLI**

```bash
npm start &
node say.mjs --voices | head -5
echo "Piped straight from the shell. Second sentence here." | node say.mjs --system
node say.mjs "Saved to a file." -o /tmp/out.wav && ls -la /tmp/out.wav
```

- [ ] **Step 4: Update the README**

In the API table, add rows for `POST /api/speak`, `GET /api/playback`, `POST /api/playback/toggle`, the transport endpoints, and `GET /api/playback/events`. Note that `/api/tts` keeps the 2000-character cap while `/api/speak` has none.

Under **Notes**, replace the sentence about requests taking "a second or two" with an honest description: speech starts after the first sentence is generated, typically under a second, and the rest is produced while it plays.

Under **Desktop app**, correct the hotkey description to say it speaks the clipboard **in the voice and speed saved in Settings**.

In the shell examples, add:

```sh
echo "Piped from anywhere." | node say.mjs --system   # speaks a whole document
node say.mjs --voices                                 # list all 28, graded
```

- [ ] **Step 5: Run the full suite one more time**

Run: `npm test`
Expected: PASS, every suite

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tauri.conf.json say.mjs README.md
git commit -m "Bundle src/ and ui/; add stdin, speed, and --system to the CLI"
```

---

## Verification against the spec's success criteria

Run these before calling Phase 1 done:

- [ ] **Pressing the hotkey twice in a row speaks twice.** Task 9 Step 5.
- [ ] **First audio within ~1 s for a long input.** `time curl -s -XPOST localhost:8789/api/speak -d @long.json -H 'content-type: application/json'` on a 5000-word file; audio should start while the request is still being served.
- [ ] **A voice chosen in Settings is the voice the hotkey and CLI use.** Set `bm_george` in Settings, then press the hotkey and run `echo "test" | node say.mjs --system`.
- [ ] **`npm test` passes without downloading the model.** `rm -rf ~/.cache/huggingface && npm test` — should pass in seconds.
- [ ] **`POST /api/tts` still returns a complete WAV** so Margin keeps working: `curl -s -XPOST localhost:8789/api/tts -H 'content-type: application/json' -d '{"text":"hi"}' -o /tmp/t.wav && file /tmp/t.wav`

## Deferred to Phase 2

Not in this plan, by design: reading the selection instead of the clipboard, tray playback controls, the macOS Services entry, and media-key/Now Playing integration. The session API built here is what they will drive.
