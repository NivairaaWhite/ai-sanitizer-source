// A stand-in for an AI chat site, served at the real domains so the extension's
// content scripts inject exactly as they would in production.
//
//   kind "pm"          hand-written rich editor with its own paste handler
//   kind "plain"       bare contenteditable, no paste handler (exercises the execCommand fallback)
//   kind "textarea"    React-style controlled textarea: its "state" only updates on `input`
//   kind "prosemirror" the real ProseMirror (ChatGPT / Claude composers)
//   kind "quill"       the real Quill 2 (Gemini-style composer)
//
// window.__sent is what the "provider" would receive. It is the thing the tests inspect.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

let pmBundle = null;
function pmCode() {
  if (!pmBundle) {
    const out = buildSync({ entryPoints: [path.join(here, 'pm-entry.js')], bundle: true, format: 'iife', write: false, minify: true, logLevel: 'silent' });
    pmBundle = safe(out.outputFiles[0].text);
  }
  return pmBundle;
}
let quillAssets = null;
function quill() {
  if (!quillAssets) {
    const dist = path.dirname(require.resolve('quill/dist/quill.js'));
    quillAssets = { js: safe(fs.readFileSync(path.join(dist, 'quill.js'), 'utf8')), css: fs.readFileSync(path.join(dist, 'quill.core.css'), 'utf8') };
  }
  return quillAssets;
}

export const KINDS = ['pm', 'plain', 'textarea', 'prosemirror', 'quill'];

export function mockPage(kind) {
  const isTA = kind === 'textarea';
  const isLib = kind === 'prosemirror' || kind === 'quill';
  const composer = isTA
    ? '<textarea id="composer" placeholder="Message" rows="2"></textarea>'
    : isLib
      ? '<div id="mount" class="editor-wrap"></div>'
      : '<div id="composer" class="ProseMirror" contenteditable="true" role="textbox" aria-label="Message"></div>';
  const libs = kind === 'prosemirror' ? `<script>${pmCode()}</script>` : kind === 'quill' ? `<style>${quill().css}</style><script>${quill().js}</script>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock chat (${kind})</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #18181b; }
  main { padding: 16px 16px 120px; max-width: 720px; margin: 0 auto; }
  .msg { margin: 10px 0; padding: 8px 12px; border-radius: 10px; }
  .user { background: #e0e7ff; } .assistant { background: #f4f4f5; }
  .msg p { margin: 4px 0; white-space: pre-wrap; }
  pre { background: #1f2937; color: #e5e7eb; padding: 10px; border-radius: 6px; overflow: auto; }
  form { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px; background: #fff; border-top: 1px solid #ddd; display: flex; gap: 8px; align-items: flex-end; }
  .editor-wrap { flex: 1; }
  #composer { min-height: 44px; border: 1px solid #bbb; border-radius: 8px; padding: 8px; font: inherit; outline: none; white-space: pre-wrap; }
  div#composer:not(.ql-editor):not(.ProseMirror-focused) { flex: 1; }
  .ql-container { border: 0; font: inherit; }
</style></head>
<body>
<main id="chat" role="main"></main>
<form id="form" onsubmit="return false">
  ${composer}
  <button type="button" id="send" data-testid="send-button" aria-label="Send message">Send</button>
</form>
${libs}
<script>
  const KIND = ${JSON.stringify(kind)};
  const IS_TA = ${JSON.stringify(isTA)};
  const chat = document.getElementById('chat');
  const state = { text: '' };          // the "React state": what actually gets sent
  window.__sent = [];
  window.__streamDone = false;

  let readComposer, clearComposer;

  function send() {
    const t = readComposer();
    if (!t.trim()) return;
    window.__sent.push(t);
    const m = document.createElement('div'); m.className = 'msg user';
    const p = document.createElement('p'); p.textContent = t; m.appendChild(p); chat.appendChild(m);
    clearComposer();
  }

  if (KIND === 'prosemirror') {
    const ed = window.__mountPM(document.getElementById('mount'), send);
    readComposer = ed.read; clearComposer = ed.clear;
  } else if (KIND === 'quill') {
    const q = new Quill('#mount', { modules: { toolbar: false }, placeholder: 'Message' });
    q.root.id = 'composer';
    q.keyboard.addBinding({ key: 'Enter' }, () => { send(); return false; });
    const list = q.keyboard.bindings['Enter']; list.unshift(list.pop());   // run before Quill's own Enter handling
    readComposer = () => q.getText().replace(/\\n$/, '');
    clearComposer = () => q.setText('');
  } else {
    const comp = document.getElementById('composer');
    readComposer = () => (IS_TA ? state.text : comp.innerText);
    clearComposer = () => { if (IS_TA) { comp.value = ''; state.text = ''; } else { comp.innerHTML = ''; } };
    comp.addEventListener('input', () => { if (IS_TA) state.text = comp.value; });
    if (KIND === 'pm') {
      // rich editors take over paste and insert the plain text themselves
      comp.addEventListener('paste', (e) => {
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
      });
    }
    comp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }
  document.getElementById('send').addEventListener('click', send);

  // stream a reply char by char into one text node (characterData mutations),
  // then add a "highlighted" code block split into many spans, with a Copy button
  window.__streamReply = function (reply) {
    window.__streamDone = false;
    const m = document.createElement('div'); m.className = 'msg assistant';
    const p = document.createElement('p'); const tn = document.createTextNode(''); p.appendChild(tn); m.appendChild(p);
    chat.appendChild(m);
    let i = 0;
    const iv = setInterval(() => {
      tn.nodeValue = reply.para.slice(0, ++i);
      if (i < reply.para.length) return;
      clearInterval(iv);
      const pre = document.createElement('pre'); const code = document.createElement('code');
      for (let k = 0; k < reply.code.length; k += 5) {
        const s = document.createElement('span'); s.className = 'tok'; s.textContent = reply.code.slice(k, k + 5); code.appendChild(s);
      }
      pre.appendChild(code); m.appendChild(pre);
      const b = document.createElement('button'); b.className = 'copy-btn'; b.setAttribute('aria-label', 'Copy code'); b.textContent = 'Copy';
      // like the real sites: copies from JS state (which holds tokens), not from the DOM
      b.addEventListener('click', () => navigator.clipboard.writeText(reply.code));
      m.appendChild(b);
      window.__streamDone = true;
    }, 3);
  };
  window.__ready = true;
</script>
</body></html>`;
}
