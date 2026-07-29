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
