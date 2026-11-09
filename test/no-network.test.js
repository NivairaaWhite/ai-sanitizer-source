'use strict';
// Static guarantees behind the privacy promise. If someone later adds a fetch(), a
// background worker or a storage write for the token map, these fail loudly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const files = walk(path.join(ROOT, 'src')).map((f) => ({ f, rel: path.relative(ROOT, f), code: stripComments(fs.readFileSync(f, 'utf8')) }));

test('no network or code-loading APIs anywhere in the extension', () => {
  const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/, /importScripts/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bWebAssembly\b/, /chrome\.runtime\.(sendMessage|connect)\b/, /chrome\.(webRequest|declarativeNetRequest|downloads|cookies|history|tabs\.(create|update|executeScript))/];
  const hits = [];
  for (const { rel, code } of files) for (const re of banned) if (re.test(code)) hits.push(`${rel}: ${re}`);
  assert.deepEqual(hits, []);
});

test('only prefs.js touches chrome.storage, and never the sync area', () => {
  const users = files.filter((x) => /chrome\.storage/.test(x.code)).map((x) => x.rel);
  assert.deepEqual(users, [path.join('src', 'shared', 'prefs.js')]);
  for (const { rel, code } of files) assert.ok(!/storage\.sync|storage\.session|storage\.managed/.test(code), rel);
});

test('no browser storage APIs in the content scripts or core (token map stays in memory)', () => {
  const hits = [];
  for (const { rel, code } of files.filter((x) => /src[\\/](content|core)/.test(x.rel))) {
    if (/localStorage|sessionStorage|indexedDB|caches\b|document\.cookie|openDatabase/.test(code)) hits.push(rel);
  }
  assert.deepEqual(hits, []);
});

test('the token vault holds data only in instance Maps (no globals, no persistence calls)', () => {
  const code = files.find((x) => x.rel.endsWith('vault.js')).code;
  assert.ok(!/chrome\./.test(code));
  assert.ok(!/window\.|globalThis\.(?!LDS)/.test(code.replace(/globalThis\.LDS/g, '')));
});

test('manifest asks for the minimum: three permissions, no host_permissions, no background', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.deepEqual([...m.permissions].sort(), ['clipboardRead', 'clipboardWrite', 'storage']);
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.background, undefined);
  assert.equal(m.web_accessible_resources, undefined);
  assert.equal(m.content_security_policy, undefined);
  const matches = m.content_scripts.flatMap((c) => c.matches);
  assert.ok(matches.every((x) => x.startsWith('https://')), matches.join(','));
  assert.deepEqual(matches.sort(), ['https://chat.openai.com/*', 'https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*']);
  assert.ok(m.content_scripts.every((c) => !c.world || c.world === 'ISOLATED'), 'content scripts must stay in the isolated world');
});

test('every file listed in the manifest exists', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const listed = [...m.content_scripts.flatMap((c) => c.js), m.action.default_popup, ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  for (const f of listed) assert.ok(fs.existsSync(path.join(ROOT, f)), `missing ${f}`);
});

test('popup has no inline scripts (MV3 CSP) and loads only local files', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/\son\w+\s*=/i.test(html), 'inline event handler');
  assert.ok(!/(?:src|href)\s*=\s*["']https?:/i.test(html), 'remote resource');
});

test('UI sets dynamic text with textContent, never innerHTML with variables', () => {
  const ui = files.find((x) => x.rel.endsWith('ui.js')).code;
  const uses = ui.match(/innerHTML\s*=\s*[^;]+;/g) || [];
  assert.deepEqual(uses, ['innerHTML = HTML;']);
});
