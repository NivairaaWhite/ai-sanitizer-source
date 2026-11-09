/*
 * Vault: the volatile token map.
 *
 * original value  <->  structurally-similar mock token
 *
 * This object lives only in the content script's JS heap. It is never written
 * to chrome.storage, localStorage, IndexedDB, the clipboard or the network.
 * Reloading the tab (or closing it) destroys the map -- by design.
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  const TLD_KEEP_RE = /\.(internal|corp|lan|intranet|private)$/i;
  const TEST_NET = ['192.0.2.', '198.51.100.', '203.0.113.']; // RFC 5737 documentation ranges
  const TOKEN_LIKE_RE = /(?<![A-Za-z0-9])MOCK_[A-Z0-9_]*?_\d{2,}(?![A-Za-z0-9])/g;

  const pad = (n) => String(n).padStart(2, '0');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Structure-preserving token formats. Default: MOCK_<LABEL>_<NN> (e.g. MOCK_DB_01). */
  function formatToken(label, n, original) {
    switch (label) {
      case 'EMAIL':
        return `mock.user.${pad(n)}@example.com`;
      case 'IP': {
        const i = n - 1;
        if (i < TEST_NET.length * 254) return TEST_NET[Math.floor(i / 254)] + ((i % 254) + 1);
        return `MOCK_IP_${pad(n)}`;
      }
      case 'HOST': {
        const m = TLD_KEEP_RE.exec(original || '');
        return `mock-host-${pad(n)}.${m ? m[1].toLowerCase() : 'example.net'}`;
      }
      case 'PHONE':
        return n < 100 ? `+1-555-01${pad(n)}` : `MOCK_PHONE_${pad(n)}`;
      default:
        return `MOCK_${label}_${pad(n)}`;
    }
  }

  class Vault {
    constructor() {
      this._t2o = new Map(); // token -> original
      this._lower = new Map(); // token.toLowerCase() -> original
      this._o2t = new Map(); // original -> token
      this._labels = new Map(); // token -> label
      this._counters = new Map(); // label -> last number used
      this._rx = { restore: null, mask: null };
      this.version = 0;
    }

    get size() {
      return this._t2o.size;
    }

    clear() {
      this._t2o.clear();
      this._lower.clear();
      this._o2t.clear();
      this._labels.clear();
      this._counters.clear();
      this._rx = { restore: null, mask: null };
      this.version++;
    }

    tokenOf(original) {
      return this._o2t.get(original);
    }

    labelOf(token) {
      return this._labels.get(token);
    }

    /** Return the token for `original`, minting a new one when needed. */
    tokenFor(label, original, context) {
      const existing = this._o2t.get(original);
      if (existing) return existing;
      if (context && this._ctxRaw !== context) {
        this._ctxRaw = context;
        this._ctxLower = context.toLowerCase();
      }
      let token;
      for (let guard = 0; guard < 100000; guard++) {
        const n = (this._counters.get(label) || 0) + 1;
        this._counters.set(label, n);
        token = formatToken(label, n, original);
        const lt = token.toLowerCase();
        if (this._lower.has(lt)) continue;
        if (context && this._ctxLower.includes(lt)) continue; // never collide with text being masked
        break;
      }
      this._t2o.set(token, original);
      this._lower.set(token.toLowerCase(), original);
      this._o2t.set(original, token);
      this._labels.set(token, label);
      this._rx = { restore: null, mask: null };
      this.version++;
      return token;
    }

    /** exact token we minted (case-insensitive: LLMs sometimes change case) */
    isToken(s) {
      return this._lower.has(String(s).toLowerCase());
    }

    /** one of ours, or shaped like one (from an earlier page session) */
    isTokenLike(s) {
      if (this.isToken(s)) return true;
      TOKEN_LIKE_RE.lastIndex = 0;
      return TOKEN_LIKE_RE.test(s) && s.replace(TOKEN_LIKE_RE, '').length === 0;
    }

    /** does `s` contain (not just equal) one of our tokens or something token-shaped? */
    containsToken(s) {
      if (this.test('restore', s)) return true;
      TOKEN_LIKE_RE.lastIndex = 0;
      return TOKEN_LIKE_RE.test(s);
    }

    entries() {
      const out = [];
      for (const [token, original] of this._t2o) {
        out.push({ token, label: this._labels.get(token), length: original.length });
      }
      return out;
    }

    /** cached alternation regex; boundaries stop MOCK_DB_01 matching inside MOCK_DB_011 */
    regex(direction) {
      if (!this.size) return null;
      if (this._rx[direction]) return this._rx[direction];
      const keys = [...(direction === 'restore' ? this._t2o.keys() : this._o2t.keys())];
      keys.sort((a, b) => b.length - a.length);
      const alt = keys.map(escapeRe).join('|');
      const re = new RegExp('(?<![A-Za-z0-9])(?:' + alt + ')(?![A-Za-z0-9])', direction === 'restore' ? 'gi' : 'g');
      this._rx[direction] = re;
      return re;
    }

    /** does `text` contain anything to transform in this direction? */
    test(direction, text) {
      const re = this.regex(direction);
      if (!re || !text) return false;
      re.lastIndex = 0;
      return re.test(text);
    }

    /** MOCK_DB_01 -> acme_prod_db */
    restore(text) {
      const re = this.regex('restore');
      if (!re || !text) return text;
      re.lastIndex = 0;
      return text.replace(re, (m) => {
        const v = this._lower.get(m.toLowerCase());
        return v === undefined ? m : v;
      });
    }

    /** acme_prod_db -> MOCK_DB_01 (exact-match only) */
    mask(text) {
      const re = this.regex('mask');
      if (!re || !text) return text;
      re.lastIndex = 0;
      return text.replace(re, (m) => {
        const t = this._o2t.get(m);
        return t === undefined ? m : t;
      });
    }

    /** replacement for a single matched string in a given direction */
    replacementFor(direction, matched) {
      if (direction === 'restore') {
        const v = this._lower.get(matched.toLowerCase());
        return v === undefined ? matched : v;
      }
      const t = this._o2t.get(matched);
      return t === undefined ? matched : t;
    }

    /** tokens that look like ours but are not in this vault (e.g. invented by the AI) */
    unresolved(text) {
      const out = [];
      TOKEN_LIKE_RE.lastIndex = 0;
      let m;
      while ((m = TOKEN_LIKE_RE.exec(text)) !== null) if (!this.isToken(m[0])) out.push(m[0]);
      return out;
    }
  }

  LDS.vault = { Vault, formatToken, TOKEN_LIKE_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.vault;
})();
