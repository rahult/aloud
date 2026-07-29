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
