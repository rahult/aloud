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
