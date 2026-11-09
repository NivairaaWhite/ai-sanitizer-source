// End-to-end test in a real Chromium with the unpacked extension loaded.
//   xvfb-run -a node test/e2e/e2e.mjs
// Env: CHROME_PATH (default: /opt/pw-browsers/chromium-1194/chrome-linux/chrome), E2E_OUT (screenshots)
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mockPage } from './mock-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.resolve(here, '../..'); // EXT_DIR: test an unzipped build instead of the working tree
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'lds-e2e');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// every supported site x every kind of composer we want to prove works
const SCENARIOS = [
  ['https://claude.ai', 'pm'],
  ['https://chatgpt.com', 'textarea'],
  ['https://gemini.google.com', 'plain'],
  ['https://claude.ai', 'prosemirror'],
  ['https://chatgpt.com', 'prosemirror'],
  ['https://gemini.google.com', 'quill']
];

// fake secrets, assembled at runtime
const SECRET_KEY = 'sk-' + 'proj-' + 'Qa7Lm2'.repeat(7);
const SECRET_EMAIL = 'jane.doe@acme-corp.io';
const SECRET_DB = 'acme_prod_db';
const SECOND_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const THIRD_KEY = 'ghp_' + 'a1B2c3D4e5'.repeat(4);
const ORIGINALS = [SECRET_KEY, SECRET_EMAIL, SECRET_DB, SECOND_KEY, THIRD_KEY];
const PASTE_TEXT = `# deploy
export OPENAI_API_KEY="${SECRET_KEY}"
psql -d ${SECRET_DB} -c "select 1"
Ping ${SECRET_EMAIL} when done`;

const results = [];
function ok(cond, name, detail = '') {
  results.push({ pass: !!cond, name, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : detail ? '\n        ' + String(detail).slice(0, 700) : ''}`);
}
const leaks = (s) => ORIGINALS.filter((o) => String(s).includes(o));

// Chrome derives an unpacked extension's id from its path
function extensionId(p) {
  const h = crypto.createHash('sha256').update(p).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const requests = [];
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'lds-profile-')), {
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  headless: false,
  viewport: { width: 1100, height: 760 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check']
});

context.on('request', (r) => requests.push({ url: r.url(), method: r.method(), body: r.postData() || '' }));
await context.route(/^https:\/\/(claude\.ai|chatgpt\.com|gemini\.google\.com)\//, (route) => {
  const url = new URL(route.request().url());
  if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
  return route.fulfill({ status: 200, contentType: 'text/html', body: mockPage(url.searchParams.get('editor') || 'pm') });
});
for (const origin of new Set(SCENARIOS.map((s) => s[0]))) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });

const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
const composerText = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('composer');
    return c.value !== undefined ? c.value : c.innerText;
  });
const sentList = (page) => page.evaluate(() => window.__sent);
const setClipboard = (page, t) => page.evaluate((x) => navigator.clipboard.writeText(x), t);
const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const tokenMatches = (s, re) => (s.match(re) || []).filter(Boolean);
const clearComposer = async (page) => {
  await page.click('#composer');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
};

async function open(origin, kind) {
  const page = await context.newPage();
  await page.goto(`${origin}/?editor=${kind}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true);
  await page.waitForTimeout(500); // let the content script load prefs
  return page;
}

async function coreFlow(origin, kind) {
  const tag = `[${new URL(origin).hostname} / ${kind}]`;
  const page = await open(origin, kind);

  // 1. paste: the composer must receive tokens, never the originals
  await setClipboard(page, PASTE_TEXT);
  await page.click('#composer');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(500);
  const composed = await composerText(page);
  ok(leaks(composed).length === 0, `${tag} paste: composer holds no original values`, composed);
  ok(/MOCK_API_KEY_\d+/.test(composed) && /MOCK_DB_\d+/.test(composed) && /mock\.user\.\d+@example\.com/.test(composed), `${tag} paste: composer shows tokens`, composed);
  ok(composed.includes('psql -d MOCK_DB_') && composed.includes('# deploy'), `${tag} paste: surrounding text and line structure preserved`, composed);

  // 2. send: the provider must see only tokens
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const sent = await sentList(page);
  ok(sent.length === 1 && leaks(sent[0]).length === 0, `${tag} send: provider received no original values`, JSON.stringify(sent));

  const apiTok = tokenMatches(sent[0] || '', /MOCK_API_KEY_\d+/)[0];
  const dbTok = tokenMatches(sent[0] || '', /MOCK_DB_\d+/)[0];
  const mailTok = tokenMatches(sent[0] || '', /mock\.user\.\d+@example\.com/)[0];

  // 3. your own sent bubble is restored on screen
  const bubble = await text(page, '.msg.user p');
  ok(bubble.includes(SECRET_DB) && bubble.includes(SECRET_EMAIL) && bubble.includes(SECRET_KEY), `${tag} rehydrate: your sent message shows the originals`, bubble);

  // 4. the AI streams a reply that uses the tokens
  const reply = {
    para: `Run it against ${dbTok} and email ${mailTok}. The key ${apiTok} should be rotated.`,
    code: `psql -d ${dbTok} -c "select 1" # contact ${mailTok}`
  };
  await page.evaluate((r) => window.__streamReply(r), reply);
  await page.waitForFunction(() => window.__streamDone === true, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const para = await text(page, '.msg.assistant p');
  const code = await text(page, '.msg.assistant pre');
  ok(para.includes(SECRET_DB) && para.includes(SECRET_EMAIL) && para.includes(SECRET_KEY) && !/MOCK_|mock\.user/.test(para), `${tag} rehydrate: streamed reply text restored live`, para);
  ok(code.includes(`psql -d ${SECRET_DB}`) && code.includes(SECRET_EMAIL) && !/MOCK_|mock\.user/.test(code), `${tag} rehydrate: tokens split across highlight spans restored`, code);

  // 5. "Copy code" button: the page copies tokens from its state; we must fix the clipboard
  await setClipboard(page, 'sentinel');
  await page.click('.copy-btn');
  await page.waitForTimeout(2000);
  const copied = await readClipboard(page);
  ok(copied === `psql -d ${SECRET_DB} -c "select 1" # contact ${SECRET_EMAIL}`, `${tag} copy button: clipboard holds the restored code`, copied);

  // 6. typed (not pasted) secrets: the pre-send safety net
  const before = (await sentList(page)).length;
  await page.click('#composer');
  await page.keyboard.type(`use key ${SECOND_KEY} please`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  let now = await sentList(page);
  const typed = await composerText(page);
  ok(now.length === before, `${tag} send guard: Enter with a typed secret is blocked`, JSON.stringify(now.slice(before)));
  ok(!typed.includes(SECOND_KEY) && /MOCK_API_KEY_\d+/.test(typed) && typed.includes('use key') && typed.includes('please'), `${tag} send guard: typed secret masked in place, rest of the text intact`, typed);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  now = await sentList(page);
  ok(now.length === before + 1 && leaks(now[before]).length === 0, `${tag} send guard: second Enter sends the masked text`, JSON.stringify(now.slice(before)));

  await page.click('#composer');
  await page.keyboard.type(`token ${THIRD_KEY}`);
  await page.click('#send');
  await page.waitForTimeout(500);
  now = await sentList(page);
  ok(now.length === before + 1, `${tag} send guard: clicking Send with a typed secret is blocked`, JSON.stringify(now.slice(before + 1)));
  await page.click('#composer');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  now = await sentList(page);
  ok(now.length === before + 2 && now.every((s) => leaks(s).length === 0), `${tag} send guard: nothing sensitive ever reached the provider`, JSON.stringify(now));

  return page;
}

// ---------------------------------------------------------------- scenarios
const pages = {};
for (const [origin, kind] of SCENARIOS) pages[`${origin}|${kind}`] = await coreFlow(origin, kind);

// ---------- extra checks on the claude.ai (rich editor) page
{
  const page = pages['https://claude.ai|pm'];
  await page.bringToFront();

  // mask toggle + selection copy
  await page.keyboard.press('Alt+Shift+R');
  await page.waitForTimeout(300);
  let para = await text(page, '.msg.assistant p');
  ok(/MOCK_DB_\d+/.test(para) && !para.includes(SECRET_DB), 'hotkey Alt+Shift+R: switches the page back to tokens', para);
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector('.msg.assistant p'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await setClipboard(page, 'sentinel');
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(500);
  const sel = await readClipboard(page);
  ok(sel.includes(SECRET_DB) && sel.includes(SECRET_EMAIL) && !/MOCK_/.test(sel), 'Ctrl+C on masked text: clipboard gets the originals', sel);
  await page.keyboard.press('Alt+Shift+R');
  await page.waitForTimeout(300);
  para = await text(page, '.msg.assistant p');
  ok(para.includes(SECRET_DB) && !/MOCK_/.test(para), 'hotkey Alt+Shift+R: restores originals again', para);

  // same value later: consistent token (known-value propagation)
  await setClipboard(page, `again: ${SECRET_DB} is slow`);
  await page.click('#composer');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(300);
  const again = await composerText(page);
  const firstDbTok = tokenMatches((await sentList(page))[0], /MOCK_DB_\d+/)[0];
  ok(again.includes(firstDbTok) && !again.includes(SECRET_DB), 'paste: same value gets the same token across messages', again);
  await clearComposer(page);

  // paste with nothing sensitive must be left completely alone
  await setClipboard(page, 'just a normal sentence, nothing secret');
  await page.click('#composer');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(300);
  ok((await composerText(page)).trim() === 'just a normal sentence, nothing secret', 'paste: non-sensitive text passes through untouched');
  await clearComposer(page);

  // the shield pill + panel render (screenshot for human inspection)
  await page.mouse.click(1100 - 12 - 28, Math.round(760 * 0.45) + 15); // closed shadow root: click by position
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'claude-panel.png') });
  await page.keyboard.press('Escape');
}

// ---------- privacy invariants across everything that happened
{
  const page = pages['https://claude.ai|pm'];
  const mainWorld = await page.evaluate(async () => ({
    lds: typeof window.LDS,
    ls: JSON.stringify({ ...localStorage }),
    ss: JSON.stringify({ ...sessionStorage }),
    idb: JSON.stringify(await (indexedDB.databases ? indexedDB.databases() : []))
  }));
  ok(mainWorld.lds === 'undefined', 'isolation: the page world cannot see the extension (window.LDS is undefined)');
  ok(leaks(mainWorld.ls + mainWorld.ss + mainWorld.idb).length === 0, 'storage: no originals in the page localStorage / sessionStorage / IndexedDB');

  const cdp = await context.newCDPSession(page);
  const ctxs = [];
  cdp.on('Runtime.executionContextCreated', (e) => ctxs.push(e.context));
  await cdp.send('Runtime.enable');
  await page.waitForTimeout(300);
  const iso = ctxs.find((c) => c.auxData && c.auxData.type === 'isolated' && /Sanitizer/i.test(c.name));
  ok(!!iso, 'extension: isolated-world content script is running on the page');
  if (iso) {
    const ev = (expression) => cdp.send('Runtime.evaluate', { expression, contextId: iso.id, awaitPromise: true, returnByValue: true });
    const store = await ev(`new Promise(r => chrome.storage.local.get(null, r))`);
    const dump = JSON.stringify(store.result.value);
    ok(leaks(dump).length === 0 && !/MOCK_/.test(dump), 'storage: chrome.storage.local holds no originals or tokens', dump);
    const keys = Object.keys(store.result.value || {});
    ok(keys.every((k) => k === 'lds_prefs'), 'storage: chrome.storage.local contains only preferences', keys.join(','));
  }

  const external = requests.filter((r) => !/^https:\/\/(claude\.ai|chatgpt\.com|gemini\.google\.com)\//.test(r.url) && !r.url.startsWith('chrome-extension://') && !r.url.startsWith('data:'));
  ok(external.length === 0, 'network: the extension made no outbound requests', external.map((r) => r.url).join('\n'));
  ok(requests.every((r) => leaks(r.body + r.url).length === 0), 'network: no request carried an original value');
}

// ---------- popup: renders, saves prefs, and the content script reacts live
{
  const id = extensionId(EXT);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 900 });
  let navError = null;
  await popup.goto(`chrome-extension://${id}/src/popup/popup.html`).catch((e) => (navError = e)); // response is null for extension pages
  const loaded = !navError && (await popup.title()) === 'AI Sanitizer';
  ok(loaded, 'popup: loads from the extension', String(navError));
  if (loaded) {
    await popup.waitForTimeout(500);
    await popup.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
    ok(await popup.isChecked('#interceptPaste'), 'popup: defaults loaded (mask on paste is on)');
    ok((await popup.textContent('#tab-state')).includes('not active'), 'popup: reports "not active here" outside a chat tab');

    // turn paste interception off in the popup; the chat tab must react without a reload
    await popup.uncheck('#interceptPaste');
    await popup.fill('#customTerms', 'Project Orion => CODENAME');
    await popup.waitForTimeout(700);

    const page = pages['https://claude.ai|pm'];
    await page.bringToFront();
    await setClipboard(page, `raw ${SECRET_EMAIL}`);
    await page.click('#composer');
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(400);
    ok((await composerText(page)).includes(SECRET_EMAIL), 'prefs: with "mask on paste" off, paste is untouched (live pref update)', await composerText(page));
    await clearComposer(page);

    await popup.bringToFront();
    await popup.check('#interceptPaste');
    await popup.waitForTimeout(500);
    await page.bringToFront();
    await setClipboard(page, 'The Project Orion launch is on Friday');
    await page.click('#composer');
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(400);
    const custom = await composerText(page);
    ok(/MOCK_CODENAME_\d+/.test(custom) && !custom.includes('Orion'), 'prefs: custom "always mask" term applied with its label', custom);
    await clearComposer(page);
  }
}

await context.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
