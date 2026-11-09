/*
 * Copy hooks: whatever the user copies out of the chat must contain the real values.
 *
 * Two paths:
 *  1. Selection copy (Ctrl/Cmd+C): if the selected text still contains tokens, rewrite
 *     the clipboard payload (text/plain and text/html) with originals.
 *  2. "Copy" / "Copy code" buttons: those sites write to the clipboard from their own
 *     JS state (which holds tokens), not from the DOM. After the click we poll the
 *     clipboard for a short while, and if it holds our tokens we replace it with the
 *     restored text via navigator.clipboard.writeText().
 *
 * Reading the clipboard uses a hidden textarea + execCommand('paste'), which the
 * `clipboardRead` permission allows without a per-site prompt. navigator.clipboard.readText()
 * is only used as a fallback when that permission is already granted, so the user never
 * sees a clipboard permission dialog.
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  const POLL_MS = [80, 250, 600, 1200];

  function create(opts) {
    const vault = opts.vault;
    const getPrefs = opts.getPrefs;
    const ui = opts.ui || { toast() {} };
    const doc = opts.document || document;
    let busy = false;
    let timers = [];
    let attempting = false;
    let fixed = false;

    const active = () => {
      const p = getPrefs();
      return !!(p.enabled && p.restoreCopy && vault.size > 0);
    };

    function hiddenTextarea() {
      const ta = doc.createElement('textarea');
      ta.setAttribute(LDS.composer ? LDS.composer.UI_ATTR : 'data-lds-ui', '');
      ta.setAttribute('aria-hidden', 'true');
      ta.tabIndex = -1;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      return ta;
    }

    function saveFocus() {
      const sel = doc.getSelection && doc.getSelection();
      const ranges = [];
      if (sel) for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
      return { prev: doc.activeElement, ranges, sel };
    }

    function restoreFocus(s) {
      try {
        if (s.prev && s.prev !== doc.body && typeof s.prev.focus === 'function') s.prev.focus({ preventScroll: true });
        if (s.sel) {
          s.sel.removeAllRanges();
          for (const r of s.ranges) s.sel.addRange(r);
        }
      } catch (_) {
        /* best effort */
      }
    }

    async function canUseAsyncRead() {
      try {
        if (!navigator.permissions || !navigator.permissions.query) return false;
        const st = await navigator.permissions.query({ name: 'clipboard-read' });
        return st.state === 'granted';
      } catch (_) {
        return false;
      }
    }

    async function readClipboard() {
      busy = true;
      let text = '';
      const saved = saveFocus();
      const ta = hiddenTextarea();
      try {
        (doc.body || doc.documentElement).appendChild(ta);
        ta.focus({ preventScroll: true });
        if (doc.execCommand('paste')) text = ta.value || '';
      } catch (_) {
        text = '';
      } finally {
        ta.remove();
        restoreFocus(saved);
        busy = false;
      }
      if (text) return text;
      if (navigator.clipboard && navigator.clipboard.readText && (await canUseAsyncRead())) {
        try {
          return await navigator.clipboard.readText();
        } catch (_) {
          return '';
        }
      }
      return '';
    }

    async function writeClipboard(text) {
      busy = true;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            return true;
          } catch (_) {
            /* no user activation left: use the clipboardWrite fallback */
          }
        }
        const saved = saveFocus();
        const ta = hiddenTextarea();
        try {
          (doc.body || doc.documentElement).appendChild(ta);
          ta.value = text;
          ta.focus({ preventScroll: true });
          ta.select();
          return !!doc.execCommand('copy');
        } catch (_) {
          return false;
        } finally {
          ta.remove();
          restoreFocus(saved);
        }
      } finally {
        busy = false;
      }
    }

    // ---- 1. selection copy
    function onCopy(e) {
      if (busy) {
        e.stopImmediatePropagation(); // our own hidden-textarea copy: keep it from the page
        return;
      }
      if (!active()) return;
      const sel = doc.getSelection && doc.getSelection();
      if (!sel || sel.isCollapsed) return;
      const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      if (anchor && anchor.closest && anchor.closest(LDS.composer ? LDS.composer.EDITABLE : 'textarea')) return;

      const text = sel.toString();
      if (!vault.test('restore', text)) return;
      if (!e.clipboardData) return;

      e.clipboardData.setData('text/plain', vault.restore(text));
      try {
        const wrap = doc.createElement('div');
        for (let i = 0; i < sel.rangeCount; i++) wrap.appendChild(sel.getRangeAt(i).cloneContents());
        const tw = doc.createTreeWalker(wrap, 4);
        const nodes = [];
        while (tw.nextNode()) nodes.push(tw.currentNode);
        for (const n of nodes) n.nodeValue = vault.restore(n.nodeValue);
        e.clipboardData.setData('text/html', wrap.innerHTML);
      } catch (_) {
        /* plain text is already set */
      }
      e.preventDefault();
      ui.toast('Copied with original values restored.');
    }

    // ---- 2. copy buttons
    function looksLikeCopyButton(btn) {
      const text = btn.textContent && btn.textContent.length < 40 ? btn.textContent : '';
      const bits = [btn.getAttribute('aria-label'), btn.getAttribute('data-testid'), btn.getAttribute('title'), btn.getAttribute('data-tooltip'), text].join(' ').toLowerCase();
      return bits.includes('copy');
    }

    function clearTimers() {
      for (const t of timers) clearTimeout(t);
      timers = [];
    }

    async function attempt() {
      if (fixed || attempting || !active()) return;
      attempting = true;
      try {
        const text = await readClipboard();
        if (!text || !vault.test('restore', text)) return;
        const restored = vault.restore(text);
        if (await writeClipboard(restored)) {
          fixed = true;
          clearTimers();
          const left = vault.unresolved(restored);
          if (left.length) ui.toast(`Copied, but ${left.length} placeholder${left.length > 1 ? 's' : ''} could not be restored (not from this session).`, 'warn');
          else ui.toast('Copied with original values restored.');
        }
      } finally {
        attempting = false;
      }
    }

    function onClick(e) {
      if (!active()) return;
      const t = e.target;
      const btn = t && t.closest ? t.closest('button, [role="button"], a, [data-testid]') : null;
      if (!btn || !looksLikeCopyButton(btn)) return;
      clearTimers();
      fixed = false;
      timers = POLL_MS.map((ms) => setTimeout(attempt, ms));
    }

    function install() {
      doc.addEventListener('copy', onCopy, true);
      doc.addEventListener('click', onClick, true);
    }

    function uninstall() {
      doc.removeEventListener('copy', onCopy, true);
      doc.removeEventListener('click', onClick, true);
      clearTimers();
    }

    return { install, uninstall, isBusy: () => busy, attempt, readClipboard, writeClipboard };
  }

  LDS.copy = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.copy;
})();
