'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadLDS } = require('./helpers');

const LDS = loadLDS();
const { Vault } = LDS.vault;
const E = LDS.engine;
const D = LDS.detectors;

function san(text, prefs) {
  const vault = new Vault();
  const res = E.sanitize(text, vault, prefs);
  return { vault, res, out: res.text };
}

// Secret-looking fixtures are assembled at runtime so no literal in this repo looks like a real credential.
const rep = (c, n) => c.repeat(n);
const FX = {
  openai: 'sk-' + 'proj-' + rep('Ab1', 14),
  anthropic: 'sk-ant-' + rep('xY9_', 12),
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  ghp: 'ghp_' + rep('a1B2', 10),
  google: 'AIza' + rep('Sy-9', 8) + 'abc',
  slack: 'xox' + 'b-' + '1234567890-abcdefghij',
  stripe: 'sk_' + 'live_' + rep('a1', 14),
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'
};

// ----------------------------------------------------------- secrets
test('API keys and tokens are masked and restored exactly', () => {
  for (const [name, key] of Object.entries(FX)) {
    const text = `before ${key} after`;
    const { vault, out } = san(text);
    assert.ok(!out.includes(key), `${name} leaked: ${out}`);
    assert.ok(/MOCK_(API_KEY|JWT)_\d+/.test(out), `${name} not tokenised: ${out}`);
    assert.equal(vault.restore(out), text, `${name} round trip`);
  }
});

test('PEM private keys (complete and truncated) are masked whole', () => {
  const body = rep('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 6);
  const full = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  let r = san(`key:\n${full}\nend`);
  assert.equal(r.out, 'key:\nMOCK_PRIVATE_KEY_01\nend');
  const partial = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}`;
  r = san(`k ${partial}`);
  assert.ok(!r.out.includes('MIIEvQ'), r.out);
  assert.equal(r.vault.restore(r.out), `k ${partial}`);
});

test('key = value secrets: masks the value only, keeps the key', () => {
  const cases = [
    ['export DB_PASSWORD=hunter2hunter2', 'export DB_PASSWORD=MOCK_SECRET_01'],
    ['password: "correct horse battery"', 'password: "MOCK_SECRET_01"'],
    ['{"api_key": "abcd1234efgh5678"}', '{"api_key": "MOCK_SECRET_01"}'],
    ["client_secret = 'Zx9!kLm2#pQr'", "client_secret = 'MOCK_SECRET_01'"],
    ['X-Api-Key: 9f8e7d6c5b4a3f2e1d0c', 'X-Api-Key: MOCK_SECRET_01'],
    ['aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'aws_secret_access_key=MOCK_SECRET_01']
  ];
  for (const [input, expected] of cases) {
    const { out, vault } = san(input);
    assert.equal(out, expected, input);
    assert.equal(vault.restore(out), input);
  }
});

test('Bearer and Basic auth headers', () => {
  const t = 'Authorization: Bearer ' + rep('abcDEF123', 4);
  const { out, vault } = san(t);
  assert.equal(out, 'Authorization: Bearer MOCK_API_KEY_01');
  assert.equal(vault.restore(out), t);
});

test('URL credentials: user, password (even with a raw @), host and db are masked, structure kept', () => {
  const t = 'DATABASE_URL=postgres://appsvc:S3cr3tP@ss!@acme-prod.abc123.us-east-1.rds.amazonaws.com:5432/acme_prod_db?sslmode=require';
  const { out, vault } = san(t);
  assert.equal(out, 'DATABASE_URL=postgres://MOCK_USER_01:MOCK_PASSWORD_01@mock-host-01.example.net:5432/MOCK_DB_01?sslmode=require');
  assert.equal(vault.restore(out), t);
});

test('generic usernames (admin/root/postgres) are not treated as sensitive', () => {
  const t = 'mysql://root:Tr0ub4dor&3xyz@10.1.2.3:3306/shop';
  const { out } = san(t);
  assert.ok(out.includes('mysql://root:MOCK_PASSWORD_01@'), out);
});

// --------------------------------------------------------- databases
test('database names from SQL, CLI flags, env/config and naming convention', () => {
  const t = [
    'CREATE DATABASE IF NOT EXISTS billing_core;',
    'USE billing_core;',
    'psql -h localhost -U app -d customer_vault -c "select 1"',
    'mongodump --db orders_eu --out /tmp/x',
    'POSTGRES_DB=ledger_main',
    'database: "inventory_2024"',
    'restore acme_prod_db from backup'
  ].join('\n');
  const { out, vault } = san(t);
  for (const name of ['billing_core', 'customer_vault', 'orders_eu', 'ledger_main', 'inventory_2024', 'acme_prod_db']) {
    assert.ok(!out.includes(name), `${name} leaked:\n${out}`);
  }
  assert.equal(vault.restore(out), t);
  // the same database gets one token everywhere
  assert.equal(out.match(/MOCK_DB_\d+/g).filter((x) => x === vault.tokenOf('billing_core')).length, 2);
});

// ------------------------------------------------- email, network, IDs
test('emails, IPs and internal hosts', () => {
  const t = 'Mail jane.doe+x@acme-corp.io from 10.20.30.40 via db1.prod.corp and 192.168.1.50.';
  const { out, vault } = san(t);
  assert.equal(out, 'Mail mock.user.01@example.com from 192.0.2.1 via mock-host-01.corp and 192.0.2.2.');
  assert.equal(vault.restore(out), t);
});

test('placeholder / documentation values are left alone', () => {
  const t = 'user@example.com 127.0.0.1 0.0.0.0 8.8.8.8 192.0.2.7 localhost:3000';
  assert.equal(san(t).res.count, 0);
});

test('phone numbers, cards, SSN, PAN and Aadhaar (checksum-validated)', () => {
  let base = '23456789012';
  let aadhaar = null;
  for (let d = 0; d < 10; d++) if (D.verhoeff(base + d)) aadhaar = base + d;
  assert.ok(aadhaar);
  const spaced = `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`;

  const t = `call +91 98765 43210 or (415) 555-2671; card 4111 1111 1111 1111; ssn 123-45-6789; PAN ABCPE1234F; aadhaar ${spaced}`;
  const { out, vault } = san(t);
  for (const leaked of ['98765 43210', '555-2671', '4111 1111', '123-45-6789', 'ABCPE1234F', spaced]) {
    assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
  }
  assert.equal(vault.restore(out), t);

  // checksum failures are not masked
  const bad = san('card 4111 1111 1111 1112 aadhaar 2345 6789 0123').res.count;
  assert.equal(bad, 0);
});

test('Luhn and Verhoeff helpers', () => {
  assert.ok(D.luhn('4111111111111111'));
  assert.ok(!D.luhn('4111111111111112'));
  assert.ok(D.verhoeff('2363')); // textbook example
  assert.ok(!D.verhoeff('2364'));
});

// -------------------------------------------------- false positives
test('ordinary code and prose produce no detections', () => {
  const code = `
function getToken() { return localStorage.getItem('token'); }
const password = req.body.password;
const token = getTokenFromStorage();
config.database = process.env.DB_NAME;
this.database = databaseName;
db = sqlite3.connect("app.db")
const db = new Database();
if (user.password === input) {}
const API_KEY = process.env.OPENAI_API_KEY;
let secret = "your_secret_here";
password: <your-password>
max_tokens: 4096
token_count = 123456789
npm install --save-dev jest
version 1.2.3, build 10.0.19045
SELECT * FROM users WHERE id = 5;
Contact: support@example.com
curl http://localhost:3000/api
Database: PostgreSQL
const result = await fetch("https://api.example.com/v1/items?page=2");
git clone https://github.com/user/repo.git
`;
  const spans = E.plan(code, new Vault());
  assert.deepEqual(spans.map((s) => [s.type, s.value]), []);
});

// ---------------------------------------------- consistency & vault
test('the same value always gets the same token, across calls', () => {
  const vault = new Vault();
  const a = E.sanitize('mail bob@corp.io', vault).text;
  const b = E.sanitize('again bob@corp.io and sue@corp.io', vault).text;
  assert.equal(a, 'mail mock.user.01@example.com');
  assert.equal(b, 'again mock.user.01@example.com and mock.user.02@example.com');
});

test('known values are masked everywhere once seen, even without context', () => {
  const vault = new Vault();
  E.sanitize('POSTGRES_DB=ledger_main', vault);
  const r = E.sanitize('The ledger_main tables are slow; ledger_main_replica too.', vault);
  assert.equal(r.text, 'The MOCK_DB_01 tables are slow; MOCK_DB_01_replica too.');
});

test('a value found on one line masks other mentions within the same text', () => {
  const t = 'url=postgres://u1:pw0rdXYZ12@db.internal.corp/shopdb\nlater we drop shopdb entirely';
  const { out } = san(t);
  assert.ok(!out.includes('shopdb'), out);
});

test('existing tokens are never re-masked (idempotent)', () => {
  const t = 'k=sk-' + 'proj-' + rep('Zq7', 14) + ' mail a@corp.io ip 10.9.8.7 db=POSTGRES_DB=core_ledger';
  const vault = new Vault();
  const once = E.sanitize(t, vault);
  const twice = E.sanitize(once.text, vault);
  assert.equal(twice.count, 0);
  assert.equal(twice.text, once.text);
});

test('never mints a token that already appears in the text', () => {
  const vault = new Vault();
  const r = E.sanitize('legacy MOCK_DB_01 stays; real db: POSTGRES_DB=ledger_main', vault);
  assert.ok(r.text.includes('legacy MOCK_DB_01 stays'));
  assert.equal(vault.tokenOf('ledger_main'), 'MOCK_DB_02');
  assert.equal(vault.restore(r.text).includes('ledger_main'), true);
});

test('restore leaves unknown tokens alone and reports them', () => {
  const vault = new Vault();
  vault.tokenFor('DB', 'real_db');
  const text = 'use MOCK_DB_01 then MOCK_DB_07';
  assert.equal(vault.restore(text), 'use real_db then MOCK_DB_07');
  assert.deepEqual(vault.unresolved('use real_db then MOCK_DB_07'), ['MOCK_DB_07']);
});

test('restore uses boundaries: MOCK_DB_01 does not eat MOCK_DB_011', () => {
  const vault = new Vault();
  vault.tokenFor('DB', 'real_db');
  assert.equal(vault.restore('MOCK_DB_011 / MOCK_DB_01 / get_MOCK_DB_01_conn'), 'MOCK_DB_011 / real_db / get_real_db_conn');
});

test('replacement strings with $ patterns are inserted literally', () => {
  const vault = new Vault();
  vault.tokenFor('SECRET', 'p$&ss$1word');
  assert.equal(vault.restore('x MOCK_SECRET_01 y'), 'x p$&ss$1word y');
});

test('vault.clear() forgets everything', () => {
  const vault = new Vault();
  E.sanitize('mail bob@corp.io', vault);
  assert.equal(vault.size, 1);
  vault.clear();
  assert.equal(vault.size, 0);
  assert.equal(vault.restore('mock.user.01@example.com'), 'mock.user.01@example.com');
});

// ------------------------------------------------ prefs / custom terms
test('custom terms: case-insensitive, labelled, longest first, original case restored', () => {
  const prefs = LDS.prefs.merge({ customTerms: 'Acme Corp => COMPANY\nacme\n# comment\nproject-orion' });
  const t = 'ACME CORP built project-orion with acme tools; "Acme Corp" again; acmeville is not matched';
  const { out, vault } = san(t, prefs);
  assert.ok(!/acme corp/i.test(out.replace('acmeville', '')), out);
  assert.ok(out.includes('MOCK_COMPANY_'), out);
  assert.ok(out.includes('acmeville'), 'word boundary respected');
  assert.equal(vault.restore(out), t);
});

test('disabled categories are not masked', () => {
  const prefs = LDS.prefs.merge({ categories: { emails: false, secrets: true } });
  const t = 'mail bob@corp.io key sk-' + 'proj-' + rep('Qw3', 14);
  const { out } = san(t, prefs);
  assert.ok(out.includes('bob@corp.io'));
  assert.ok(out.includes('MOCK_API_KEY_01'));
});

test('parseCustomTerms normalises labels and drops junk', () => {
  const r = LDS.prefs.parseCustomTerms('  Foo Bar => my label! \n\nx\nfoo bar\n#c\nBaz');
  assert.deepEqual(r, [
    { term: 'Foo Bar', label: 'MY_LABEL' },
    { term: 'Baz', label: 'TERM' }
  ]);
});

test('prefs.merge ignores unknown keys and wrong types', () => {
  const p = LDS.prefs.merge({ enabled: 'yes', guardSend: false, evil: 1, categories: { emails: 0, secrets: false } });
  assert.equal(p.enabled, true);
  assert.equal(p.guardSend, false);
  assert.equal(p.categories.emails, true);
  assert.equal(p.categories.secrets, false);
  assert.equal('evil' in p, false);
});

// ---------------------------------------------------------- fuzz
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: restore(sanitize(x)) === x, nothing sensitive survives, second pass is a no-op', () => {
  const rnd = mulberry32(20241019);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const alnum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const rs = (n, set = alnum) => Array.from({ length: n }, () => set[Math.floor(rnd() * set.length)]).join('');
  const num = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const sensitive = [
    () => { const v = `${rs(6, lower)}.${rs(4, lower)}@${rs(7, lower)}corp.io`; return { text: v, gone: [v] }; },
    () => { const v = 'sk-proj-' + rs(40); return { text: v, gone: [v] }; },
    () => { const v = 'AKIA' + rs(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'); return { text: v, gone: [v] }; },
    () => { const v = `10.${num(1, 254)}.${num(1, 254)}.${num(1, 254)}`; return { text: v, gone: [v] }; },
    () => { const v = `+91 9${rs(4, '0123456789')} ${rs(5, '0123456789')}`; return { text: v, gone: [v] }; },
    () => { const pw = `Pw${rs(8)}9!`; const db = `acme_${rs(5, lower)}_prod_db`; const host = `db${num(1, 9)}.${rs(6, lower)}.corp`;
      return { text: `postgres://svc${rs(5, lower)}:${pw}@${host}:5432/${db}`, gone: [pw, db, host] }; },
    () => { const val = rs(24) + '7!'; return { text: `export API_TOKEN_${num(1, 9)}="${val}"`, gone: [val] }; },
    () => { const db = `${rs(6, lower)}_staging_db`; return { text: `psql -d ${db} -c 'select 1'`, gone: [db] }; }
  ];
  const neutral = ['hello', 'world', 'the', 'quick', 'brown fox', 'jumps', 'over', '(see below)', 'x = 42;', 'return value', 'TODO:', 'naïve café', '日本語', '→', 'v1.2.3'];
  const seps = [' ', '\n', ', ', ' (', ') ', '\n\n', '\t', '; ', ': '];

  const vault = new Vault();
  for (let n = 0; n < 400; n++) {
    const parts = [];
    const golds = [];
    for (let i = num(3, 12); i > 0; i--) {
      if (rnd() < 0.45) {
        const s = pick(sensitive)();
        parts.push(s.text);
        golds.push(...s.gone);
      } else parts.push(pick(neutral));
    }
    let doc = parts[0];
    for (let i = 1; i < parts.length; i++) doc += pick(seps) + parts[i];

    const res = E.sanitize(doc, vault);
    assert.equal(vault.restore(res.text), doc, `round trip failed (doc #${n}):\n${doc}\n---\n${res.text}`);
    for (const g of golds) assert.ok(!res.text.includes(g), `leaked "${g}" (doc #${n}):\n${res.text}`);
    const again = E.sanitize(res.text, vault);
    assert.equal(again.count, 0, `not idempotent (doc #${n}): ${JSON.stringify(again.items)}\n${res.text}`);
  }
});

// ------------------------------------------- performance / ReDoS guard
test('large and pathological inputs finish quickly', () => {
  const budgetMs = 4000;
  const inputs = {
    'mixed 1MB code': (() => {
      const unit = 'function f(a,b){return a.b.c(d)+e.f.g;}\nconst x = {password: "p", token: 12};\n// db host a.b.c.d\n';
      return unit.repeat(Math.floor(1_000_000 / unit.length)) + '\nmail me@corp.io key=sk-proj-' + rep('Ab9', 14);
    })(),
    'dotted chain': 'a.'.repeat(150_000) + 'db',
    'key chars': 'token'.repeat(60_000),
    'base64 blob': 'QUJD'.repeat(125_000),
    'many equals': '='.repeat(300_000),
    'quotes': '"password"'.repeat(30_000),
    'many @': 'a@'.repeat(100_000),
    'urls': 'http://u:p@h.co/x '.repeat(20_000),
    'dotted chain + @': 'a.'.repeat(100_000) + '@x.io',
    'BEGIN without END': '-----BEGIN PRIVATE KEY-----'.repeat(10_000),
    'psql repeated on one line': 'psql '.repeat(80_000),
    'eyJ repeated': 'eyJ'.repeat(100_000),
    'sk- repeated': 'sk-'.repeat(100_000),
    'db: repeated': 'db: '.repeat(100_000),
    'spaces': ' '.repeat(500_000) + 'password:'
  };
  const slow = [];
  for (const [name, text] of Object.entries(inputs)) {
    const t0 = process.hrtime.bigint();
    E.sanitize(text, new Vault());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= budgetMs) slow.push(`${name}: ${ms.toFixed(0)}ms`);
  }
  assert.deepEqual(slow, [], 'inputs over the time budget');
});
