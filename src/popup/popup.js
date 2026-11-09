(function () {
  'use strict';
  const LDS = globalThis.LDS;
  const $ = (id) => document.getElementById(id);

  let prefs = LDS.prefs.merge();
  let saveTimer = null;

  // ------------------------------------------------------------- prefs UI
  function paint() {
    $('enabled').checked = prefs.enabled;
    for (const k of ['interceptPaste', 'liveRestore', 'restoreCopy', 'guardSend', 'showBadge']) $(k).checked = prefs[k];
    for (const cb of document.querySelectorAll('[data-cat]')) cb.checked = !!prefs.categories[cb.dataset.cat];
    if (document.activeElement !== $('customTerms')) $('customTerms').value = prefs.customTerms;
    document.body.style.opacity = prefs.enabled ? '' : '0.92';
  }

  function persist(msg) {
    LDS.prefs.save(prefs).then(() => {
      const el = $('saved');
      el.textContent = msg || '';
      if (msg) setTimeout(() => (el.textContent = ''), 1400);
    });
  }

  function bind() {
    $('enabled').addEventListener('change', (e) => {
      prefs.enabled = e.target.checked;
      persist();
      refreshTab();
    });
    for (const k of ['interceptPaste', 'liveRestore', 'restoreCopy', 'guardSend', 'showBadge']) {
      $(k).addEventListener('change', (e) => {
        prefs[k] = e.target.checked;
        persist();
      });
    }
    for (const cb of document.querySelectorAll('[data-cat]')) {
      cb.addEventListener('change', (e) => {
        prefs.categories[e.target.dataset.cat] = e.target.checked;
        persist();
      });
    }
    $('customTerms').addEventListener('input', (e) => {
      prefs.customTerms = e.target.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persist('Saved'), 350);
    });
  }

  // ------------------------------------------------------- active tab link
  function sendToTab(message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs && tabs[0];
          if (!tab || tab.id == null) return resolve(null);
          chrome.tabs.sendMessage(tab.id, message, (res) => {
            if (chrome.runtime.lastError) return resolve(null); // no content script here
            resolve(res || null);
          });
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function paintTab(res) {
    const chip = $('tab-state');
    const msg = $('tab-msg');
    const actions = $('tab-actions');
    if (!res) {
      chip.textContent = 'not active here';
      chip.className = 'chip idle';
      msg.textContent = 'Open ChatGPT, Claude or Gemini (and reload the tab once after installing) to use these controls.';
      actions.hidden = true;
      return;
    }
    actions.hidden = false;
    chip.textContent = !res.enabled ? 'off' : res.reveal ? 'showing originals' : 'showing tokens';
    chip.className = 'chip' + (!res.enabled ? ' idle' : res.reveal ? '' : ' masked');
    msg.textContent = res.count
      ? `${res.count} value${res.count === 1 ? '' : 's'} masked in this tab. Held in memory only.`
      : 'Nothing masked yet. Paste something sensitive into the chat.';
    $('btn-reveal').textContent = res.reveal ? 'Show tokens' : 'Show originals';
    for (const id of ['btn-reveal', 'btn-mask', 'btn-clear']) $(id).disabled = !res.enabled;
  }

  async function refreshTab() {
    paintTab(await sendToTab({ type: 'lds:status' }));
  }

  function bindTab() {
    $('btn-reveal').addEventListener('click', async () => paintTab(await sendToTab({ type: 'lds:toggleReveal' })));
    $('btn-mask').addEventListener('click', async () => paintTab(await sendToTab({ type: 'lds:sanitizeComposer' })));
    $('btn-clear').addEventListener('click', async () => paintTab(await sendToTab({ type: 'lds:clear' })));
  }

  // ------------------------------------------------------------------ init
  bind();
  bindTab();
  LDS.prefs.load().then((p) => {
    prefs = p;
    paint();
  });
  refreshTab();
})();
