'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { loadLDS, sleep } = require('./helpers');

function setup(html = '<!doctype html><html><body><main id="chat"></main></body></html>') {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const LDS = loadLDS(['src/content/dom-rehydrate.js']);
  const vault = new LDS.vault.Vault();
  const doc = dom.window.document;
  const rh = LDS.rehydrate.create({ vault, document: doc });
  rh.start();
  return { dom, doc, vault, rh, LDS, chat: doc.getElementById('chat') };
}

test('restores a token that streams in character by character', async () => {
  const { doc, vault, rh, chat } = setup();
  vault.tokenFor('DB', 'acme_prod_db'); // MOCK_DB_01
  const p = doc.createElement('p');
  const node = doc.createTextNode('Connect to ');
  p.appendChild(node);
  chat.appendChild(p);

  for (const chunk of ['Connect to MOCK_', 'Connect to MOCK_DB', 'Connect to MOCK_DB_0', 'Connect to MOCK_DB_01 now']) {
    node.nodeValue = chunk;
    await sleep(5);
  }
  await sleep(100);
  assert.equal(p.textContent, 'Connect to acme_prod_db now');
  rh.stop();
});

test('restores tokens inside a freshly added subtree (message re-render)', async () => {
  const { doc, vault, rh, chat } = setup();
  const t = vault.tokenFor('EMAIL', 'jane@acme-corp.io');
  const div = doc.createElement('div');
  div.innerHTML = `<p>Mail <strong>${t}</strong> today</p><pre><code>to = "${t}"</code></pre>`;
  chat.appendChild(div);
  await sleep(100);
  assert.equal(div.querySelector('strong').textContent, 'jane@acme-corp.io');
  assert.equal(div.querySelector('code').textContent, 'to = "jane@acme-corp.io"');
  rh.stop();
});

test('stitches a token split across syntax-highlight spans', async () => {
  const { doc, vault, rh, chat } = setup();
  vault.tokenFor('DB', 'acme_prod_db');
  const pre = doc.createElement('pre');
  pre.innerHTML = '<code><span class="k">USE</span> <span class="i">MOCK_</span><span class="i">DB_</span><span class="i">01</span>;</code>';
  chat.appendChild(pre);
  await sleep(150);
  assert.equal(pre.textContent, 'USE acme_prod_db;');
  rh.stop();
});

test('never touches textareas or contenteditable composers', async () => {
  const { doc, vault, rh, chat } = setup();
  const tok = vault.tokenFor('API_KEY', 'sk-live-supersecretvalue1234567890');
  const ta = doc.createElement('textarea');
  ta.textContent = `key ${tok}`;
  const ce = doc.createElement('div');
  ce.setAttribute('contenteditable', 'true');
  ce.innerHTML = `<p>key ${tok}</p>`;
  const msg = doc.createElement('p');
  msg.textContent = `key ${tok}`;
  chat.append(ta, ce, msg);
  await sleep(100);
  assert.ok(ce.textContent.includes(tok), 'contenteditable must keep the token');
  assert.ok(ta.textContent.includes(tok), 'textarea must keep the token');
  assert.ok(msg.textContent.includes('sk-live-supersecret'), 'normal message is restored');
  rh.stop();
});

test('mask mode shows tokens again and restore mode brings originals back', async () => {
  const { doc, vault, rh, chat } = setup();
  const tok = vault.tokenFor('DB', 'acme_prod_db');
  const p = doc.createElement('p');
  p.textContent = `use ${tok} and ${tok}`;
  chat.appendChild(p);
  await sleep(100);
  assert.equal(p.textContent, 'use acme_prod_db and acme_prod_db');

  rh.setMode('mask');
  assert.equal(p.textContent, `use ${tok} and ${tok}`);

  rh.setMode('restore');
  assert.equal(p.textContent, 'use acme_prod_db and acme_prod_db');
  rh.stop();
});

test('matching is case-insensitive for tokens the model re-cased', async () => {
  const { doc, vault, rh, chat } = setup();
  vault.tokenFor('DB', 'AcmeProdDB');
  const p = doc.createElement('p');
  p.textContent = 'run on mock_db_01 now';
  chat.appendChild(p);
  await sleep(100);
  assert.equal(p.textContent, 'run on AcmeProdDB now');
  rh.stop();
});

test('does not extend MOCK_DB_01 into MOCK_DB_011', async () => {
  const { doc, vault, rh, chat } = setup();
  vault.tokenFor('DB', 'acme_prod_db');
  const p = doc.createElement('p');
  p.textContent = 'MOCK_DB_011 stays, MOCK_DB_01 does not';
  chat.appendChild(p);
  await sleep(100);
  assert.equal(p.textContent, 'MOCK_DB_011 stays, acme_prod_db does not');
  rh.stop();
});

test('zero work while the vault is empty', async () => {
  const { doc, rh, chat } = setup();
  const p = doc.createElement('p');
  p.textContent = 'MOCK_DB_01 is just text here';
  chat.appendChild(p);
  await sleep(100);
  assert.equal(p.textContent, 'MOCK_DB_01 is just text here');
  assert.equal(rh.stats.restored, 0);
  rh.stop();
});

test('mode "off" leaves the page untouched', async () => {
  const { doc, vault, rh, chat } = setup();
  const tok = vault.tokenFor('DB', 'acme_prod_db');
  rh.setMode('off');
  const p = doc.createElement('p');
  p.textContent = `x ${tok}`;
  chat.appendChild(p);
  await sleep(100);
  assert.equal(p.textContent, `x ${tok}`);
  rh.stop();
});

test('does not stitch a token across two different paragraphs', async () => {
  const { doc, vault, rh, chat } = setup();
  vault.tokenFor('DB', 'acme_prod_db');
  const wrap = doc.createElement('div');
  wrap.innerHTML = '<p>ends with MOCK_</p><p>DB_01 starts here</p>';
  chat.appendChild(wrap);
  await sleep(150);
  assert.equal(wrap.textContent, 'ends with MOCK_DB_01 starts here');
  rh.stop();
});
