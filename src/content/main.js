/*
 * Content-script entry point. Wires the pieces together:
 *
 *   paste / drop  -> engine.sanitize -> composer.insertText        (redaction)
 *   MutationObserver -> vault.restore on text nodes                (rehydration)
 *   copy / copy-button -> restored clipboard                       (export)
 *   Enter / Send  -> last-chance scan of typed text                (safety net)
 *
 * No network access, no background service worker, no persistent storage of data.
 */
(function () {
  'use strict';
  const LDS = globalThis.LDS;
  if (!LDS || !LDS.engine || !LDS.composer || !LDS.rehydrate) return;
  if (window.top !== window) return; // top frame only
  if (globalThis.__LDS_STARTED__) return;
  globalThis.__LDS_STARTED__ = true;

  const vault = new LDS.vault.Vault(); // volatile token map: lives and dies with this tab
  const state = { prefs: LDS.prefs.merge(), reveal: true, lastBlocked: 0 };

  const ui = LDS.ui.create({
    onToggleReveal: () => toggleReveal(),
    onSanitizeComposer: () => maskComposerNow(),
    onClear: () => clearVault()
  });

  const rehydrator = LDS.rehydrate.create({ vault, document });
  const copy = LDS.copy.create({ vault, getPrefs: () => state.prefs, ui, document });

  // ------------------------------------------------------------- status
  function status() {
    return {
      ok: true,
      site: LDS.composer.currentSite().id,
      enabled: state.prefs.enabled,
      count: vault.size,
      reveal: state.reveal,
      restoredNodes: rehydrator.stats.restored
    };
  }

  function refreshUi() {
    ui.update({
      enabled: state.prefs.enabled,
      show: state.prefs.showBadge,
      count: vault.size,
      reveal: state.reveal,
      entries: vault.entries()
    });
  }

  function syncMode() {
    // off when disabled; otherwise show originals (reveal) or tokens (masked)
    rehydrator.setMode(!state.prefs.enabled ? 'off' : state.reveal ? 'restore' : 'mask');
    refreshUi();
  }

  function applyPrefs(next) {
    const prevLive = state.prefs.liveRestore;
    state.prefs = next;
    if (next.liveRestore !== prevLive) state.reveal = next.liveRestore;
    syncMode();
  }

  // ---------------------------------------------------------- actions
  function toggleReveal() {
    state.reveal = !state.reveal;
    syncMode();
    ui.toast(state.reveal ? 'Showing original values.' : 'Showing masked tokens.');
  }

  function clearVault() {
    vault.clear();
    refreshUi();
    ui.toast('Vault cleared. Earlier tokens can no longer be restored.');
  }

  function announce(res) {
    refreshUi();
    ui.toast(`Masked ${res.summary}. Originals reappear in the reply.`);
  }

  function maskComposerNow() {
    const el = LDS.composer.findComposer(document);
    if (!el) {
      ui.toast('Click into the message box first.', 'warn');
      return { count: 0 };
    }
    const res = LDS.composer.sanitizeEditable(el, { vault, prefs: state.prefs });
    if (res.count) announce(res);
    else ui.toast('Nothing sensitive found in the message box.');
    return { count: res.count, summary: res.summary };
  }

  // --------------------------------------------------- paste / drop
  function onPaste(e) {
    if (copy.isBusy()) {
      e.stopImmediatePropagation(); // our own clipboard read: hide it from the page
      return;
    }
    const p = state.prefs;
    if (!p.enabled || !p.interceptPaste || LDS.composer.isInjecting()) return;
    const el = LDS.composer.editableFromEvent(e);
    if (!el) return;
    const cd = e.clipboardData;
    if (!cd || (cd.files && cd.files.length)) return; // images / files: leave alone
    let text = '';
    try {
      text = cd.getData('text/plain');
    } catch (_) {
      return;
    }
    if (!text) return;

    const res = LDS.engine.sanitize(text, vault, p);
    if (!res.count) return; // nothing sensitive: native paste proceeds untouched

    e.preventDefault();
    e.stopImmediatePropagation();
    LDS.composer.insertText(el, res.text);
    announce(res);
  }

  function onDrop(e) {
    const p = state.prefs;
    if (!p.enabled || !p.interceptPaste || LDS.composer.isInjecting()) return;
    const el = LDS.composer.editableFromEvent(e);
    const dt = e.dataTransfer;
    if (!el || !dt || (dt.files && dt.files.length)) return;
    const text = dt.getData('text/plain');
    if (!text) return;
    const res = LDS.engine.sanitize(text, vault, p);
    if (!res.count) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      const pos = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
      if (pos && el.contains(pos.startContainer)) {
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(pos);
      }
    } catch (_) {
      /* insert at the current caret instead */
    }
    LDS.composer.insertText(el, res.text);
    announce(res);
  }

  // ------------------------------------------------ pre-send safety net
  function guard(e, el) {
    const ctx = { vault, prefs: state.prefs };
    if (!LDS.composer.hasSensitive(el, ctx)) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    const res = LDS.composer.sanitizeEditable(el, ctx);
    if (res.count) {
      refreshUi();
      ui.toast(`Masked ${res.summary} before sending. Review it, then send again.`);
    } else {
      ui.toast('Sensitive text is still in the message box and could not be masked automatically. Remove it or paste it again.', 'warn');
    }
    return true;
  }

  function onKeydown(e) {
    const p = state.prefs;
    // hotkeys (code, not key: Alt changes `key` on macOS)
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (e.code === 'KeyR') {
        e.preventDefault();
        toggleReveal();
        return;
      }
      if (e.code === 'KeyS') {
        e.preventDefault();
        maskComposerNow();
        return;
      }
    }
    if (!p.enabled || !p.guardSend) return;
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || LDS.composer.isInjecting()) return;
    const el = LDS.composer.editableFromEvent(e);
    if (el) guard(e, el);
  }

  function onClick(e) {
    const p = state.prefs;
    if (!p.enabled || !p.guardSend || LDS.composer.isInjecting()) return;
    if (!LDS.composer.isSendButton(e.target)) return;
    const el = LDS.composer.findComposer(document);
    if (el) guard(e, el);
  }

  // ---------------------------------------------------------- wiring
  window.addEventListener('paste', onPaste, true);
  window.addEventListener('drop', onDrop, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('click', onClick, true);
  copy.install();
  rehydrator.start();

  LDS.prefs.load().then(applyPrefs);
  LDS.prefs.onChange(applyPrefs);
  syncMode();

  // popup <-> content script (no background worker needed)
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, send) => {
        switch (msg && msg.type) {
          case 'lds:status':
            send(status());
            break;
          case 'lds:toggleReveal':
            toggleReveal();
            send(status());
            break;
          case 'lds:sanitizeComposer':
            send(Object.assign(status(), { result: maskComposerNow() }));
            break;
          case 'lds:clear':
            clearVault();
            send(status());
            break;
          default:
            return false;
        }
        return false;
      });
    }
  } catch (_) {
    /* extension context invalidated (extension reloaded): this stale script goes quiet */
  }
})();
