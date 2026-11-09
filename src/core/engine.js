/*
 * Engine: detectors + vault = sanitize / restore / mask.
 * Pure logic, no DOM. Everything the content scripts need to transform text.
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  const LABEL_NAMES = {
    API_KEY: ['API key', 'API keys'],
    SECRET: ['secret', 'secrets'],
    PASSWORD: ['password', 'passwords'],
    USER: ['username', 'usernames'],
    PRIVATE_KEY: ['private key', 'private keys'],
    JWT: ['JWT', 'JWTs'],
    DB: ['database name', 'database names'],
    HOST: ['hostname', 'hostnames'],
    EMAIL: ['email', 'emails'],
    IP: ['IP address', 'IP addresses'],
    PHONE: ['phone number', 'phone numbers'],
    CARD: ['card number', 'card numbers'],
    SSN: ['SSN', 'SSNs'],
    PAN: ['PAN', 'PANs'],
    AADHAAR: ['Aadhaar number', 'Aadhaar numbers']
  };

  function nameFor(label, n) {
    const names = LABEL_NAMES[label];
    if (names) return n === 1 ? names[0] : names[1];
    const base = label.toLowerCase().replace(/_/g, ' ');
    return n === 1 ? base : base + 's';
  }

  /** [{label}] -> "2 emails, 1 API key" */
  function summarize(items) {
    const counts = new Map();
    for (const it of items) counts.set(it.label, (counts.get(it.label) || 0) + 1);
    return [...counts].map(([label, n]) => `${n} ${nameFor(label, n)}`).join(', ');
  }

  /** Spans for values we already minted tokens for, so later mentions are masked too. */
  function knownSpans(text, vault) {
    const re = vault.regex('mask');
    if (!re) return [];
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const token = vault.tokenOf(m[0]);
      out.push({ type: 'known', start: m.index, end: m.index + m[0].length, value: m[0], tier: 1, label: vault.labelOf(token) });
    }
    return out;
  }

  /** What would be masked in `text`? (no vault mutation) */
  function plan(text, vault, prefs) {
    const D = LDS.detectors;
    prefs = prefs || LDS.prefs.DEFAULT_PREFS;
    return D.detect(text, {
      categories: prefs.categories,
      customTerms: LDS.prefs.parseCustomTerms(prefs.customTerms),
      // a detection that already contains a token is (partly) masked: leave it alone
      skip: (v) => vault.containsToken(v),
      extra: (t) => knownSpans(t, vault)
    });
  }

  /** Mask sensitive spans. Returns { text, count, items, summary }. */
  function sanitize(text, vault, prefs) {
    let spans = plan(text, vault, prefs);
    if (!spans.length) return { text, count: 0, items: [], summary: '' };
    const D = LDS.detectors;

    // Mint tokens for everything found, then plan again: a value discovered on one line
    // (say a DB name inside a connection string) is now "known", so every other mention
    // of it in the same text is masked consistently too.
    const before = vault.size;
    for (const s of spans) vault.tokenFor(s.label || D.TYPES[s.type].label, s.value, text);
    if (vault.size !== before) spans = plan(text, vault, prefs);

    let out = '';
    let pos = 0;
    const items = [];
    for (const s of spans) {
      const label = s.label || D.TYPES[s.type].label;
      const token = vault.tokenFor(label, s.value, text);
      out += text.slice(pos, s.start) + token;
      pos = s.end;
      items.push({ token, label, type: s.type });
    }
    out += text.slice(pos);
    return { text: out, count: items.length, items, summary: summarize(items) };
  }

  LDS.engine = { sanitize, plan, summarize, nameFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.engine;
})();
