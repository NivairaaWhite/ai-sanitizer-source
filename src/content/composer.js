/*
 * Composer helpers: finding the chat input, reading it, inserting text into it
 * (so React / ProseMirror / Quill all notice), and masking text that was typed
 * rather than pasted.
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  const UI_ATTR = 'data-lds-ui';
  const EDITABLE = 'textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';

  // Per-site hints. Detection of editable elements is generic (EDITABLE above) so a site
  // redesign does not break paste interception; these only help locate the active composer
  // and the send button when nothing has focus.
  const SITES = [
    {
      id: 'chatgpt',
      host: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
      composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea'],
      send: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]']
    },
    {
      id: 'claude',
      host: /(^|\.)claude\.ai$/,
      composer: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'fieldset div[contenteditable="true"]'],
      send: ['button[aria-label*="Send" i]']
    },
    {
      id: 'gemini',
      host: /(^|\.)gemini\.google\.com$/,
      composer: ['rich-textarea .ql-editor', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
      send: ['button.send-button', 'button[aria-label*="Send" i]']
    }
  ];

  function currentSite(hostname) {
    const h = hostname || (typeof location !== 'undefined' ? location.hostname : '');
    return SITES.find((s) => s.host.test(h)) || { id: 'generic', composer: ['textarea', 'div[contenteditable="true"]'], send: ['button[type="submit"]'] };
  }

  // ------------------------------------------------------------ editables
  let injecting = 0;
  const isInjecting = () => injecting > 0;

  function inUi(el) {
    return !!(el && el.closest && el.closest('[' + UI_ATTR + ']'));
  }

  function editableFrom(el) {
    if (!el || el.nodeType !== 1 || inUi(el)) return null;
    return el.closest(EDITABLE);
  }

  /** shadow-DOM aware: first editable in the event's composed path */
  function editableFromEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    for (const n of path) {
      if (!n || n.nodeType !== 1) continue;
      if (n.hasAttribute && n.hasAttribute(UI_ATTR)) return null;
      if (n.matches && n.matches(EDITABLE)) return n;
    }
    return null;
  }

  const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');

  function getText(el) {
    if (!el) return '';
    if (isTextField(el)) return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function visible(el) {
    if (!el.getClientRects) return true;
    return el.getClientRects().length > 0;
  }

  function findComposer(doc) {
    doc = doc || document;
    const active = editableFrom(doc.activeElement);
    if (active) return active;
    const site = currentSite();
    for (const sel of site.composer) {
      let el = null;
      try {
        el = [...doc.querySelectorAll(sel)].find(visible) || doc.querySelector(sel);
      } catch (_) {
        /* bad selector for this engine */
      }
      if (el && !inUi(el)) return el;
    }
    return null;
  }

  function isSendButton(target) {
    const btn = target && target.closest ? target.closest('button, [role="button"]') : null;
    if (!btn || inUi(btn)) return false;
    const site = currentSite();
    for (const sel of site.send) {
      try {
        if (btn.matches(sel)) return true;
      } catch (_) {
        /* ignore */
      }
    }
    const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('data-testid') || '')).toLowerCase();
    return /\bsend\b|send-button|submit-button/.test(label);
  }

  // -------------------------------------------------------------- inserting
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    // Using the prototype setter bypasses React's per-instance value tracker, so the
    // following `input` event is seen as a real change.
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInput(el, data, inputType) {
    let ev;
    try {
      ev = new InputEvent('input', { bubbles: true, cancelable: false, inputType, data });
    } catch (_) {
      ev = new Event('input', { bubbles: true });
    }
    el.dispatchEvent(ev);
  }

  /**
   * Insert plain text at the caret of `el`, the way a native paste would.
   * Order of strategies for rich editors:
   *   1. a synthetic `paste` event: ProseMirror / Quill / Lexical handle it natively
   *   2. document.execCommand('insertText')
   *   3. manual Range insertion + input event
   */
  function insertText(el, text) {
    injecting++;
    try {
      if (el.focus) el.focus({ preventScroll: true });

      if (isTextField(el)) {
        const v = el.value || '';
        const start = el.selectionStart == null ? v.length : el.selectionStart;
        const end = el.selectionEnd == null ? start : el.selectionEnd;
        setNativeValue(el, v.slice(0, start) + text + v.slice(end));
        const caret = start + text.length;
        try {
          el.setSelectionRange(caret, caret);
        } catch (_) {
          /* some input types have no selection */
        }
        fireInput(el, text, 'insertFromPaste');
        return true;
      }

      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
        const notCanceled = el.dispatchEvent(ev);
        if (!notCanceled) return true; // the editor took it
      } catch (_) {
        /* DataTransfer / ClipboardEvent constructor unavailable */
      }

      try {
        if (document.execCommand('insertText', false, text)) return true;
      } catch (_) {
        /* fall through */
      }

      const sel = document.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (range && el.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(document.createTextNode(text));
      }
      fireInput(el, text, 'insertFromPaste');
      return true;
    } finally {
      injecting--;
    }
  }

  // --------------------------------------------- masking typed text in place
  function firstHit(el, ctx) {
    const tw = document.createTreeWalker(el, 4 /* SHOW_TEXT */);
    while (tw.nextNode()) {
      const n = tw.currentNode;
      const v = n.nodeValue;
      if (!v || v.length < 3) continue;
      const spans = LDS.engine.plan(v, ctx.vault, ctx.prefs);
      if (spans.length) return { node: n, span: spans[0] };
    }
    return null;
  }

  /** would sanitizeEditable() find something to mask? */
  function hasSensitive(el, ctx) {
    if (isTextField(el)) return LDS.engine.plan(el.value || '', ctx.vault, ctx.prefs).length > 0;
    return !!firstHit(el, ctx);
  }

  function replaceInNode(node, start, end, text) {
    const sel = document.getSelection();
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      const v = node.nodeValue;
      node.nodeValue = v.slice(0, start) + text + v.slice(end);
      const host = node.parentElement && node.parentElement.closest(EDITABLE);
      if (host) fireInput(host, text, 'insertReplacementText');
    }
  }

  /**
   * Mask sensitive text already sitting in the composer (typed, or pasted before the
   * extension was active). Textareas are rewritten wholesale; rich editors are edited
   * span-by-span through execCommand so their own state stays consistent.
   * Returns { count, items, summary }.
   */
  function sanitizeEditable(el, ctx) {
    const D = LDS.detectors;
    injecting++;
    try {
      if (isTextField(el)) {
        const res = LDS.engine.sanitize(el.value || '', ctx.vault, ctx.prefs);
        if (res.count) {
          setNativeValue(el, res.text);
          try {
            el.setSelectionRange(res.text.length, res.text.length);
          } catch (_) {
            /* ignore */
          }
          fireInput(el, null, 'insertReplacementText');
        }
        return { count: res.count, items: res.items, summary: res.summary };
      }

      if (el.focus) el.focus({ preventScroll: true });
      const items = [];
      for (let i = 0; i < 100; i++) {
        const hit = firstHit(el, ctx);
        if (!hit) break;
        const { node, span } = hit;
        const label = span.label || D.TYPES[span.type].label;
        const token = ctx.vault.tokenFor(label, span.value, node.nodeValue);
        replaceInNode(node, span.start, span.end, token);
        items.push({ token, label, type: span.type });
      }
      if (items.length) {
        const sel = document.getSelection();
        sel.selectAllChildren(el);
        sel.collapseToEnd();
      }
      return { count: items.length, items, summary: LDS.engine.summarize(items) };
    } finally {
      injecting--;
    }
  }

  LDS.composer = {
    UI_ATTR,
    EDITABLE,
    SITES,
    currentSite,
    isInjecting,
    inUi,
    editableFrom,
    editableFromEvent,
    isTextField,
    getText,
    findComposer,
    isSendButton,
    insertText,
    hasSensitive,
    sanitizeEditable,
    setNativeValue
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.composer;
})();
