/*
 * Detectors: pure functions that find sensitive spans in a string.
 *
 * Everything here is local regex + checksum logic (no network, no storage).
 * A span is { start, end, type, value, label?, tier }.
 *
 * Overlap rules (see resolve()):
 *   tier 0  structural / credential spans (PEM, JWT, API keys, secret values,
 *           URL credentials) always beat tier 1
 *   tier 1  everything else; within a tier the longer span wins
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  // ------------------------------------------------------------------ types
  const TYPES = {
    private_key: { label: 'PRIVATE_KEY', cat: 'secrets', tier: 0 },
    jwt: { label: 'JWT', cat: 'secrets', tier: 0 },
    api_key: { label: 'API_KEY', cat: 'secrets', tier: 0 },
    secret: { label: 'SECRET', cat: 'secrets', tier: 0 },
    conn_user: { label: 'USER', cat: 'secrets', tier: 0 },
    conn_pass: { label: 'PASSWORD', cat: 'secrets', tier: 0 },
    conn_host: { label: 'HOST', cat: 'databases', tier: 0 },
    conn_db: { label: 'DB', cat: 'databases', tier: 0 },
    db_name: { label: 'DB', cat: 'databases', tier: 1 },
    email: { label: 'EMAIL', cat: 'emails', tier: 1 },
    host: { label: 'HOST', cat: 'network', tier: 1 },
    ip: { label: 'IP', cat: 'network', tier: 1 },
    phone: { label: 'PHONE', cat: 'personal', tier: 1 },
    card: { label: 'CARD', cat: 'personal', tier: 1 },
    ssn: { label: 'SSN', cat: 'personal', tier: 1 },
    pan: { label: 'PAN', cat: 'personal', tier: 1 },
    aadhaar: { label: 'AADHAAR', cat: 'personal', tier: 1 },
    custom: { label: 'TERM', cat: '*', tier: 1 },
    known: { label: 'KNOWN', cat: '*', tier: 1 }
  };

  const DEFAULT_CATEGORIES = { secrets: true, databases: true, emails: true, network: true, personal: true };

  // --------------------------------------------------------------- helpers
  function* matchAll(re, text) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      yield m;
    }
  }

  const isAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const isKeyChar = (c) => isAlnum(c) || c === 95 /* _ */ || c === 46 /* . */ || c === 45; /* - */

  function mk(type, start, end, text, extra) {
    return Object.assign({ type, start, end, value: text.slice(start, end), tier: TYPES[type].tier }, extra);
  }

  // ----------------------------------------------------------- private keys
  // Quantifiers are bounded throughout this file so no input can make a scan quadratic.
  const PEM_RE = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]{0,16000}?-----END \1-----/g;
  const PEM_PARTIAL_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s]{40,}/g;

  function detectPem(text, out) {
    if (!text.includes('-----BEGIN')) return;
    for (const m of matchAll(PEM_RE, text)) out.push(mk('private_key', m.index, m.index + m[0].length, text));
    for (const m of matchAll(PEM_PARTIAL_RE, text)) {
      out.push(mk('private_key', m.index, m.index + m[0].replace(/\s+$/, '').length, text));
    }
  }

  // -------------------------------------------------------------------- JWT
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,4000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}(?![A-Za-z0-9_-])/g;
  function detectJwt(text, out) {
    if (!text.includes('eyJ')) return;
    for (const m of matchAll(JWT_RE, text)) out.push(mk('jwt', m.index, m.index + m[0].length, text));
  }

  // --------------------------------------------------------------- API keys
  const API_KEY_RES = [
    /\bsk-ant-[A-Za-z0-9_-]{20,400}/g, // Anthropic
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,400}/g, // OpenAI
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, // AWS access key id
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{22,255}/g, // GitHub fine-grained
    /\bglpat-[A-Za-z0-9_-]{20,100}/g, // GitLab
    /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
    /\bya29\.[0-9A-Za-z_-]{20,600}/g, // Google OAuth access token
    /\bxox[abprs]-[A-Za-z0-9-]{10,200}/g, // Slack
    /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,200}/g, // Stripe secret / restricted
    /\bSG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}/g, // SendGrid
    /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
    /\bhf_[A-Za-z0-9]{30,200}\b/g, // Hugging Face
    /\bdop_v1_[a-f0-9]{64}\b/g, // DigitalOcean
    /\bSK[0-9a-fA-F]{32}\b/g // Twilio API key
  ];
  const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/-]{20,2000}=*)/gd;
  const BASIC_RE = /\bBasic\s+([A-Za-z0-9+/]{16,500}={0,2})/gd;

  function detectApiKeys(text, out) {
    for (const re of API_KEY_RES) {
      for (const m of matchAll(re, text)) out.push(mk('api_key', m.index, m.index + m[0].length, text));
    }
    for (const re of [BEARER_RE, BASIC_RE]) {
      for (const m of matchAll(re, text)) {
        const [s, e] = m.indices[1];
        out.push(mk('api_key', s, e, text));
      }
    }
  }

  // ------------------------------------------------- key = value secrets
  const KEYWORD_RE = /api[_-]?key|apikey|secret|token|passwd|password|pwd|passphrase|credential|private[_-]?key|access[_-]?key|auth/gi;
  // The key must END in a secret word, optionally followed by a version / environment suffix
  // (API_TOKEN_2, SECRET_KEY_PROD, password_v2). `token_count` and `authorName` are not secrets.
  const KEY_ENDS_RE = /(?:api[_-]?key|apikey|secret(?:[_-]?key)?|tokens?|passwd|password|pwd|passphrase|credentials?|private[_-]?key|access[_-]?key|auth|authorization)(?:[_-]?(?:v?\d{1,3}|prod|production|dev|staging|stage|test|live|old|new|bak|backup|primary|secondary))*$/i;
  const PLACEHOLDER_RE = /^(?:x+|\*+|\.+|-+|_+|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_]+%|\{\{[^}]*\}\}|\[[^\]]*\]|your[_\- ].*|my[_-]?(?:secret|password|token|key).*|changeme|change[_-]?me|example.*|placeholder.*|null|none|nil|undefined|true|false|string|redacted|todo|secret|password|passwd|token|bearer|basic|required|optional|enter.*|insert.*|replace.*)$/i;
  const REFERENCE_RE = /^(?:process\.env|os\.environ|os\.getenv|env\.|env\[|ENV\[|config\.|settings\.|self\.|this\.|System\.getenv|getenv\(|args\.|params\.|req\.|request\.|input\(|prompt\()/;

  function looksLikeSecretValue(value, quoted) {
    if (value.length < 6 || value.length > 300) return false;
    if (PLACEHOLDER_RE.test(value) || REFERENCE_RE.test(value)) return false;
    if (/^[A-Za-z_][A-Za-z0-9_.]*\(/.test(value)) return false; // function call
    if (quoted) return !/\s{2,}/.test(value);
    // unquoted: demand some entropy so `token = getTokenFromStorage` is ignored
    if (value.length < 8 || /[(){}<>]/.test(value)) return false;
    return /\d/.test(value) || /[!@#$%^&*+=/~]/.test(value);
  }

  function detectSecretAssignments(text, out) {
    const lower = text.toLowerCase();
    if (!/(?:key|secret|token|pass|pwd|credential|auth)/.test(lower)) return;
    for (const m of matchAll(KEYWORD_RE, text)) {
      // expand to the whole key name
      let ks = m.index;
      while (ks > 0 && m.index - ks < 80 && isKeyChar(text.charCodeAt(ks - 1))) ks--;
      let ke = m.index + m[0].length;
      while (ke < text.length && ke - ks < 120 && isKeyChar(text.charCodeAt(ke))) ke++;
      KEYWORD_RE.lastIndex = Math.max(KEYWORD_RE.lastIndex, ke);
      if (!KEY_ENDS_RE.test(text.slice(ks, ke))) continue;

      let i = ke;
      if (text[i] === '"' || text[i] === "'") i++;
      while (text[i] === ' ' || text[i] === '\t') i++;
      if (text[i] !== ':' && text[i] !== '=') continue;
      i++;
      if (text[i] === '=' || text[i] === '>') continue; // == and =>
      while (text[i] === ' ' || text[i] === '\t') i++;
      if (i >= text.length) continue;

      const q = text[i];
      let vs;
      let ve;
      let quoted = false;
      if (q === '"' || q === "'" || q === '`') {
        quoted = true;
        vs = i + 1;
        ve = vs;
        while (ve < text.length && text[ve] !== q && text[ve] !== '\n' && ve - vs <= 300) ve++;
        if (text[ve] !== q) continue;
      } else {
        vs = i;
        ve = i;
        while (ve < text.length && ve - vs <= 300 && !/[\s"'`,;)]/.test(text[ve])) ve++;
        while (ve > vs && /[.:]/.test(text[ve - 1])) ve--;
      }
      if (ve <= vs) continue;
      if (!looksLikeSecretValue(text.slice(vs, ve), quoted)) continue;
      out.push(mk('secret', vs, ve, text));
    }
  }

  // ---------------------------------- URLs with credentials / DB strings
  const DB_SCHEMES = new Set(['postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'mongodb+srv', 'mssql', 'sqlserver', 'cockroachdb', 'clickhouse', 'redshift', 'jdbc']);
  // The password class allows raw "@" (greedy up to the last "@" before the host), because
  // people paste unencoded passwords like  postgres://admin:P@ss@host/db  all the time.
  const URL_RE = /\b([a-z][a-z0-9+.-]{1,20}):\/\/(?:([^\s:@/?#'"<>]+)(?::([^\s/?#'"<>]*))?@)?([^\s/:?#'"<>@]+)(?::(\d{1,5}))?(\/[^\s?#'"<>]*)?/gd;
  const GENERIC_USERS = new Set(['admin', 'administrator', 'root', 'user', 'username', 'test', 'guest', 'postgres', 'mysql', 'mongo', 'app', 'dbuser', 'sa', 'git', 'ubuntu', 'ec2-user']);
  const LOCAL_HOST_RE = /^(?:localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|host\.docker\.internal|\[?::1\]?)$/i;
  const IPV4_ONLY_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

  function detectUrlCredentials(text, out) {
    if (!text.includes('://')) return;
    for (const m of matchAll(URL_RE, text)) {
      const scheme = m[1].toLowerCase();
      const isDb = DB_SCHEMES.has(scheme);
      const hasPass = m[3] !== undefined && m[3] !== '';
      const hasCreds = m[2] !== undefined;
      if (!isDb && !hasPass) continue;
      const ind = m.indices;

      if (m[2] !== undefined && (hasPass || isDb) && !GENERIC_USERS.has(m[2].toLowerCase())) {
        out.push(mk('conn_user', ind[2][0], ind[2][1], text));
      }
      if (hasPass) out.push(mk('conn_pass', ind[3][0], ind[3][1], text));

      const host = m[4];
      if ((isDb || hasPass) && host.includes('.') && !LOCAL_HOST_RE.test(host) && !IPV4_ONLY_RE.test(host)) {
        out.push(mk('conn_host', ind[4][0], ind[4][1], text));
      }
      if (isDb && m[6]) {
        const seg = m[6].slice(1).split('/')[0];
        if (seg && !/^\d+$/.test(seg) && /^[A-Za-z_][\w.$-]{1,62}$/.test(seg)) {
          const s = ind[6][0] + 1;
          out.push(mk('conn_db', s, s + seg.length, text));
        }
      }
      void hasCreds;
    }
  }

  // ---------------------------------------------------------- database names
  const DB_STOP = new Set(['null', 'none', 'nil', 'true', 'false', 'undefined', 'default', 'public', 'postgres', 'mysql', 'mongodb', 'mongo', 'sqlite', 'sqlite3', 'test', 'tests', 'db', 'database', 'admin', 'root', 'new', 'self', 'this', 'env', 'process', 'os', 'config', 'conf', 'cfg', 'settings', 'options', 'opts', 'props', 'params', 'args', 'kwargs', 'ctx', 'context', 'req', 'request', 'data', 'connect', 'require', 'import', 'string', 'str', 'name', 'if', 'not', 'exists', 'table', 'schema', 'the', 'a', 'an', 'your', 'my', 'example', 'dbname', 'information_schema', 'master', 'tempdb', 'model', 'msdb', 'local', 'memory', 'localhost']);

  const DB_SQL_RE = /\b(?:CREATE|DROP|ALTER)\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[`"[]?([A-Za-z_][\w$-]*)/gid;
  const DB_USE_RE = /\bUSE\s+[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s*;/gid;
  const DB_PSQL_C_RE = /(?:^|\s)\\c(?:onnect)?\s+([A-Za-z_][\w$-]*)/gid;
  const DB_CLI_RE = /\b(?:psql|pg_dump|pg_dumpall|pg_restore|mysql|mysqldump|mongosh?|mongodump|mongorestore|sqlcmd|sqlite3)\b[^\n]{0,300}?\s(?:-d|-D|--dbname|--database|--db)(?:=|\s+)["']?([A-Za-z_][\w.-]*)/gid;
  const DB_CREATEDB_RE = /\b(?:createdb|dropdb)\s+([A-Za-z_][\w.-]*)(?=\s|$)/gid;
  // keyword anchors for `db_name = x`, `POSTGRES_DB=x`, `database: "x"`; scanned by hand (see detectDbKeyValues)
  const DB_KEY_RE = /db[_-]?name|database[_-]?name|dbname|database|db/gi;
  const DB_ENV_RE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:db|database)\b/gi;
  const DB_ENV_WORDS = new Set(['prod', 'production', 'staging', 'stage', 'stg', 'dev', 'qa', 'uat', 'live', 'primary', 'replica', 'analytics', 'warehouse', 'reporting']);

  function plausibleDb(name, text, end) {
    if (!name || name.length < 3 || name.length > 63) return false;
    if (DB_STOP.has(name.toLowerCase())) return false;
    // `config.database = settings.DB_NAME`, `db = connect(...)`, `database = names[0]`:
    // a reference or call, not a literal database name. `db: POSTGRES_DB=x` -> the value is itself a key.
    if (text[end] === '(' || text[end] === '.' || text[end] === '[' || text[end] === '=' || text[end] === ':') return false;
    return true;
  }

  function detectDbKeyValues(text, out) {
    for (const m of matchAll(DB_KEY_RE, text)) {
      let ke = m.index + m[0].length;
      if (/^[_-]name/i.test(text.slice(ke, ke + 5)) && !/name$/i.test(m[0])) ke += 5;
      // the keyword must be a whole key segment, not glued to letters/digits
      if ((m.index > 0 && isAlnum(text.charCodeAt(m.index - 1))) || (ke < text.length && isAlnum(text.charCodeAt(ke)))) continue;
      // whole key, for the prose check ("Database: PostgreSQL" is a sentence, not config)
      let ks = m.index;
      while (ks > 0 && m.index - ks < 60 && isKeyChar(text.charCodeAt(ks - 1))) ks--;
      if (/^[A-Z][a-z]/.test(text.slice(ks, ke))) continue;

      let i = ke;
      if (text[i] === '"' || text[i] === "'") i++;
      while (text[i] === ' ' || text[i] === '\t') i++;
      if (text[i] !== ':' && text[i] !== '=') continue;
      i++;
      if (text[i] === '=' || text[i] === '>') continue; // == and =>
      while (text[i] === ' ' || text[i] === '\t') i++;
      let quoted = false;
      if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
        quoted = true;
        i++;
      }
      const vs = i;
      const c0 = text.charCodeAt(vs);
      if (!(isAlnum(c0) && !(c0 >= 48 && c0 <= 57)) && c0 !== 95) continue; // must start with a letter or _
      let ve = vs;
      while (ve < text.length && ve - vs < 64 && (isAlnum(text.charCodeAt(ve)) || text[ve] === '_' || text[ve] === '$' || text[ve] === '-')) ve++;
      const value = text.slice(vs, ve);
      if (!quoted && /[a-z][A-Z]/.test(value)) continue; // camelCase variable, e.g. `database = databaseName`
      if (plausibleDb(value, text, ve)) out.push(mk('db_name', vs, ve, text));
    }
  }

  function detectDbNames(text, out) {
    const probe = text.toLowerCase();
    const hasHint = /(database|schema|\bdb|_db|dbname|psql|mysql|mongo|createdb|dropdb|pg_|\buse\b|\\c\b|sqlcmd|sqlite)/.test(probe);
    if (!hasHint) return;

    const groupRes = [DB_SQL_RE, DB_USE_RE, DB_PSQL_C_RE, DB_CLI_RE, DB_CREATEDB_RE];
    for (const re of groupRes) {
      for (const m of matchAll(re, text)) {
        const [s, e] = m.indices[1];
        if (plausibleDb(m[1], text, e)) out.push(mk('db_name', s, e, text));
      }
    }
    detectDbKeyValues(text, out);
    for (const m of matchAll(DB_ENV_RE, text)) {
      const parts = m[0].toLowerCase().split('_');
      if (parts.length < 3) continue;
      if (!parts.slice(0, -1).some((p) => DB_ENV_WORDS.has(p))) continue;
      out.push(mk('db_name', m.index, m.index + m[0].length, text));
    }
  }

  // ------------------------------------------------------------------ email
  const EMAIL_FULL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
  const PLACEHOLDER_EMAIL_RE = /@(?:example\.(?:com|org|net)|test|invalid|localhost)$/i;
  const isLocalChar = (c) => isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45; // . _ % + -
  const isDomainChar = (c) => isAlnum(c) || c === 46 || c === 45;

  // Anchored on each "@" and expanded by hand (bounded), so a long run of local-part
  // characters can never cause quadratic backtracking.
  function detectEmails(text, out) {
    let at = text.indexOf('@');
    while (at !== -1) {
      let s = at;
      while (s > 0 && at - s < 64 && isLocalChar(text.charCodeAt(s - 1))) s--;
      while (s < at && (text[s] === '.' || text[s] === '-' || text[s] === '+' || text[s] === '%')) s++;
      let e = at + 1;
      while (e < text.length && e - at < 256 && isDomainChar(text.charCodeAt(e))) e++;
      while (e > at + 1 && (text[e - 1] === '.' || text[e - 1] === '-')) e--;
      if (s < at && e > at + 1) {
        const cand = text.slice(s, e);
        if (EMAIL_FULL_RE.test(cand) && !PLACEHOLDER_EMAIL_RE.test(cand)) out.push(mk('email', s, e, text));
      }
      at = text.indexOf('@', at + 1);
    }
  }

  // ------------------------------------------------------------------ hosts
  const HOST_SUFFIX_RE = /\.(?:(?:internal|corp|lan|intranet|private)\b|(?:[a-z0-9-]+\.)?(?:rds|elb|elasticache|redshift|cache)\.amazonaws\.com\b|(?:database\.azure\.com|mongodb\.net|supabase\.co|neon\.tech|planetscale\.com|redis-cloud\.com|cache\.windows\.net)\b)/gi;
  function detectHosts(text, out) {
    if (!text.includes('.')) return;
    for (const m of matchAll(HOST_SUFFIX_RE, text)) {
      let s = m.index;
      while (s > 0 && m.index - s < 120 && (isAlnum(text.charCodeAt(s - 1)) || text[s - 1] === '-' || text[s - 1] === '.')) s--;
      while (s < m.index && (text[s] === '.' || text[s] === '-')) s++;
      if (s >= m.index) continue; // needs at least one label before the suffix
      out.push(mk('host', s, m.index + m[0].length, text));
    }
  }

  // --------------------------------------------------------------------- IPs
  const IPV4_RE = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w])(?!\.\d)/g;
  const IP_ALLOW = new Set(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '255.255.255.255', '0.0.0.0']);
  function isDocOrLocalIp(ip) {
    return /^127\./.test(ip) || /^192\.0\.2\./.test(ip) || /^198\.51\.100\./.test(ip) || /^203\.0\.113\./.test(ip) || /^255\./.test(ip);
  }
  function detectIps(text, out) {
    for (const m of matchAll(IPV4_RE, text)) {
      const ip = m[1];
      if (IP_ALLOW.has(ip) || isDocOrLocalIp(ip)) continue;
      if (ip.split('.').some((o) => Number(o) > 255 || (o.length > 1 && o[0] === '0'))) continue;
      out.push(mk('ip', m.index, m.index + ip.length, text));
    }
  }

  // ------------------------------------------------ phone / cards / gov IDs
  const PHONE_RES = [
    /(?<![\w+.-])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?![\w-])/g, // +CC ...
    /(?<![\w+.-])\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?![\w-])/g, // (555) 123-4567
    /(?<![\w+.-])\d{3}[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g, // 555-123-4567
    /(?<![\w+.-])[6-9]\d{4}[\s-]\d{5}(?![\w-])/g // 98765 43210
  ];
  function detectPhones(text, out) {
    if (!/\d{3}/.test(text)) return;
    for (const re of PHONE_RES) {
      for (const m of matchAll(re, text)) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 15) continue;
        out.push(mk('phone', m.index, m.index + m[0].length, text));
      }
    }
  }

  function luhn(digits) {
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }
  const CARD_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
  const CARD_IIN_RE = /^(?:4\d{12}(?:\d{3}){0,2}|5[1-5]\d{14}|2[2-7]\d{14}|3[47]\d{13}|6(?:011|5\d\d)\d{12}|35\d{14}|3(?:0[0-5]|[68]\d)\d{11})$/;
  function detectCards(text, out) {
    if (!/\d{4}/.test(text)) return;
    for (const m of matchAll(CARD_RE, text)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) continue;
      if (!CARD_IIN_RE.test(digits) || !luhn(digits)) continue;
      out.push(mk('card', m.index, m.index + m[0].length, text));
    }
  }

  const SSN_RE = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;
  const PAN_RE = /(?<![A-Za-z0-9])[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z](?![A-Za-z0-9])/g;
  const AADHAAR_RE = /(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g;

  const V_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const V_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  function verhoeff(digits) {
    let c = 0;
    const rev = digits.split('').reverse();
    for (let i = 0; i < rev.length; i++) c = V_D[c][V_P[i % 8][rev[i].charCodeAt(0) - 48]];
    return c === 0;
  }

  function detectGovIds(text, out) {
    if (/\d{3}-\d{2}-\d{4}/.test(text)) {
      for (const m of matchAll(SSN_RE, text)) out.push(mk('ssn', m.index, m.index + m[0].length, text));
    }
    if (/[A-Z]{5}\d{4}[A-Z]/.test(text)) {
      for (const m of matchAll(PAN_RE, text)) out.push(mk('pan', m.index, m.index + m[0].length, text));
    }
    if (/\d{4}[ -]?\d{4}[ -]?\d{4}/.test(text)) {
      for (const m of matchAll(AADHAAR_RE, text)) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length === 12 && verhoeff(digits)) out.push(mk('aadhaar', m.index, m.index + m[0].length, text));
      }
    }
  }

  // ----------------------------------------------------------- custom terms
  const customCache = { key: '', re: null, labels: null };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function customRegex(terms) {
    const key = terms.map((t) => t.term + '\u0000' + t.label).join('\u0001');
    if (customCache.key === key) return customCache;
    customCache.key = key;
    customCache.labels = new Map(terms.map((t) => [t.term.toLowerCase(), t.label]));
    const alt = terms
      .map((t) => t.term)
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join('|');
    customCache.re = alt ? new RegExp('(?<![A-Za-z0-9])(?:' + alt + ')(?![A-Za-z0-9])', 'gi') : null;
    return customCache;
  }

  function detectCustom(text, terms, out) {
    if (!terms || !terms.length) return;
    const c = customRegex(terms);
    if (!c.re) return;
    for (const m of matchAll(c.re, text)) {
      out.push(mk('custom', m.index, m.index + m[0].length, text, { label: c.labels.get(m[0].toLowerCase()) || 'TERM' }));
    }
  }

  // --------------------------------------------------------------- resolver
  function resolve(spans, textLength) {
    spans.sort((a, b) => a.tier - b.tier || b.end - b.start - (a.end - a.start) || a.start - b.start);
    const covered = new Uint8Array(textLength);
    const kept = [];
    for (const s of spans) {
      let clash = false;
      for (let i = s.start; i < s.end; i++) {
        if (covered[i]) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      covered.fill(1, s.start, s.end);
      kept.push(s);
    }
    kept.sort((a, b) => a.start - b.start);
    return kept;
  }

  /**
   * detect(text, opts)
   *   opts.categories  {secrets, databases, emails, network, personal} booleans
   *   opts.customTerms [{term, label}]
   *   opts.skip        (value) => bool, drop spans whose value is already a token
   *   opts.extra       (text) => span[], extra spans (vault "known value" propagation)
   */
  function detect(text, opts) {
    opts = opts || {};
    if (typeof text !== 'string' || text.length < 3) return [];
    const cats = Object.assign({}, DEFAULT_CATEGORIES, opts.categories || {});
    const raw = [];

    if (cats.secrets) {
      detectPem(text, raw);
      detectJwt(text, raw);
      detectApiKeys(text, raw);
      detectSecretAssignments(text, raw);
    }
    if (cats.secrets || cats.databases) detectUrlCredentials(text, raw);
    if (cats.databases) detectDbNames(text, raw);
    if (cats.emails) detectEmails(text, raw);
    if (cats.network) {
      detectHosts(text, raw);
      detectIps(text, raw);
    }
    if (cats.personal) {
      detectPhones(text, raw);
      detectCards(text, raw);
      detectGovIds(text, raw);
    }
    detectCustom(text, opts.customTerms, raw);

    let spans = raw.filter((s) => {
      const t = TYPES[s.type];
      return t.cat === '*' || cats[t.cat];
    });
    if (opts.skip) spans = spans.filter((s) => !opts.skip(s.value));
    if (opts.extra) spans = spans.concat(opts.extra(text) || []);
    // No cap on span count: silently leaving later matches unmasked would defeat the purpose.
    return resolve(spans, text.length);
  }

  LDS.detectors = { TYPES, DEFAULT_CATEGORIES, detect, luhn, verhoeff };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.detectors;
})();
