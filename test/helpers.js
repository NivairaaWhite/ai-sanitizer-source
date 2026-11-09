'use strict';
// Loads the extension's content-script modules into a Node global, in manifest order,
// exactly as Chrome shares one isolated-world global between content scripts.
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

function loadLDS(extra = []) {
  globalThis.LDS = {};
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = manifest.content_scripts[0].js.filter((f) => /prefs|core\//.test(f));
  for (const f of [...files, ...extra]) {
    const full = path.join(ROOT, f);
    delete require.cache[require.resolve(full)];
    require(full);
  }
  return globalThis.LDS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, loadLDS, sleep };
