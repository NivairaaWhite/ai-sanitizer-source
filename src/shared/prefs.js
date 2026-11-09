/*
 * Preferences (NOT sensitive data).
 *
 * Only user settings live in chrome.storage.local: feature toggles, category
 * toggles and the user's own "always mask" watch-list. The token map -- the
 * thing that links MOCK_DB_01 back to the real value -- is never stored here.
 * It lives in a volatile Map inside the content script (see vault.js).
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  const STORAGE_KEY = 'lds_prefs';

  const DEFAULT_PREFS = Object.freeze({
    enabled: true, // master switch
    interceptPaste: true, // mask pasted text before it reaches the input
    liveRestore: true, // show original values on screen (false = keep tokens visible)
    restoreCopy: true, // "Copy" buttons / Ctrl+C give original values
    guardSend: true, // last-chance scan of typed text on Enter / Send
    showBadge: true, // floating status pill
    categories: Object.freeze({
      secrets: true, // API keys, tokens, passwords, private keys, JWTs, URL credentials
      databases: true, // database names, connection-string hosts / db paths
      emails: true,
      network: true, // IPv4 addresses, internal / cloud hostnames
      personal: true // phone numbers, cards, SSN, Aadhaar, PAN
    }),
    customTerms: '' // one per line: "Acme Corp" or "Acme Corp => COMPANY"
  });

  const BOOL_KEYS = ['enabled', 'interceptPaste', 'liveRestore', 'restoreCopy', 'guardSend', 'showBadge'];

  function merge(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const out = { categories: { ...DEFAULT_PREFS.categories }, customTerms: '' };
    for (const k of BOOL_KEYS) out[k] = typeof s[k] === 'boolean' ? s[k] : DEFAULT_PREFS[k];
    if (s.categories && typeof s.categories === 'object') {
      for (const k of Object.keys(DEFAULT_PREFS.categories)) {
        if (typeof s.categories[k] === 'boolean') out.categories[k] = s.categories[k];
      }
    }
    if (typeof s.customTerms === 'string') out.customTerms = s.customTerms.slice(0, 20000);
    return out;
  }

  function hasStorage() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
    } catch (_) {
      return false;
    }
  }

  function load() {
    return new Promise((resolve) => {
      if (!hasStorage()) return resolve(merge());
      try {
        chrome.storage.local.get(STORAGE_KEY, (r) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve(merge());
          resolve(merge(r && r[STORAGE_KEY]));
        });
      } catch (_) {
        resolve(merge());
      }
    });
  }

  function save(prefs) {
    return new Promise((resolve) => {
      if (!hasStorage()) return resolve(false);
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: merge(prefs) }, () => resolve(true));
      } catch (_) {
        resolve(false);
      }
    });
  }

  function onChange(cb) {
    if (!hasStorage()) return;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[STORAGE_KEY]) cb(merge(changes[STORAGE_KEY].newValue));
      });
    } catch (_) {
      /* extension context invalidated */
    }
  }

  /** "Acme Corp => COMPANY" -> { term: 'Acme Corp', label: 'COMPANY' } */
  function parseCustomTerms(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('=>');
      const term = parts[0].trim();
      if (term.length < 2 || term.length > 200 || seen.has(term.toLowerCase())) continue;
      let label = (parts[1] || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      if (!label) label = 'TERM';
      seen.add(term.toLowerCase());
      out.push({ term, label: label.slice(0, 24) });
    }
    return out;
  }

  LDS.prefs = { STORAGE_KEY, DEFAULT_PREFS, merge, load, save, onChange, parseCustomTerms };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.prefs;
})();
