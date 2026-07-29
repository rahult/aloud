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
