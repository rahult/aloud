import test from 'node:test';
import assert from 'node:assert/strict';
import {split, isLoaded, describeLoadError} from '../src/tts.mjs';

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
  assert.deepEqual(split('First one.\n\n\n  \n Second one.'), ['First one.', 'Second one.']);
});

// The regex this replaced (in browser JS) split on every ". ", so initials
// were read as four separate sentences with a pause between each.
test('split keeps initials and abbreviations in one sentence', () => {
  assert.deepEqual(
    split('Written by J. R. R. Tolkien in 1937.'),
    ['Written by J. R. R. Tolkien in 1937.'],
  );
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
