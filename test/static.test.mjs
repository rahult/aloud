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
