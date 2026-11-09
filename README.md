# Live-DOM Reversible AI Sanitizer

A Chrome (Manifest V3) extension that keeps secrets out of AI chats **without breaking the conversation**.

- **Going in:** when you paste code, logs or config into ChatGPT, Claude or Gemini, API keys, emails, database names and similar values are swapped for structurally similar placeholders (`acme_prod_db` → `MOCK_DB_01`) *before* the text reaches the input box.
- **Coming out:** as the AI streams its reply, a `MutationObserver` swaps the placeholders back, so you see your real names on screen. The model never knew them.
- **Taking it with you:** "Copy code" and Ctrl+C hand you the restored text.

Everything is local. No servers, no network requests, no background worker, and the token map exists only in the tab's memory.

```
you paste:    export OPENAI_API_KEY="sk-proj-…"   psql -d acme_prod_db   ping jane@acme-corp.io
AI receives:  export OPENAI_API_KEY="MOCK_API_KEY_01"   psql -d MOCK_DB_01   ping mock.user.01@example.com
AI replies:   "Connect to MOCK_DB_01 and notify mock.user.01@example.com …"
you see:      "Connect to acme_prod_db and notify jane@acme-corp.io …"
```

## Install

1. Unzip `ai-sanitizer-extension-v1.0.0.zip` somewhere permanent.
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, pick the unzipped folder.
3. **Reload any open ChatGPT / Claude / Gemini tab** (content scripts only attach to pages loaded after install).

A small shield badge docks on the right edge of the page. Click it for the control panel.

## Using it

| You do | What happens |
|---|---|
| Paste text containing sensitive values | Only the sensitive parts are replaced; formatting is kept. Text with nothing sensitive is pasted natively and untouched. |
| Type a secret by hand and press Enter / Send | The send is blocked once, the secret is masked in place, and you press Enter again. (Turn off with *Check before sending*.) |
| Read a reply | Placeholders turn back into your real values as it streams, in prose and in code blocks. |
| Click **Copy** on a code block, or press Ctrl+C | The clipboard receives the restored text. |
| `Alt+Shift+R` | Toggle between *showing originals* and *showing tokens* (useful when screen-sharing). |
| `Alt+Shift+S` | Mask whatever is already in the message box. |

The popup (toolbar icon) has a master switch, per-feature toggles, per-category toggles, and an **Always mask** list for your own terms (`Acme Corp => COMPANY`, one per line).

## What it detects

| Category | Examples | Placeholder |
|---|---|---|
| Secrets | OpenAI / Anthropic / AWS / GitHub / GitLab / Google / Slack / Stripe / SendGrid / npm / Hugging Face keys, JWTs, PEM private keys, `Bearer`/`Basic` credentials, `password=`/`token:`/`api_key=` style values, credentials inside URLs | `MOCK_API_KEY_01`, `MOCK_SECRET_01`, `MOCK_JWT_01`, `MOCK_PRIVATE_KEY_01`, `MOCK_PASSWORD_01` |
| Databases | `CREATE DATABASE x`, `USE x;`, `psql -d x`, `POSTGRES_DB=x`, `database: x`, connection-string db / host, `acme_prod_db`-style names | `MOCK_DB_01`, `mock-host-01.example.net` |
| Emails | `jane.doe@acme-corp.io` (placeholder domains like `example.com` are ignored) | `mock.user.01@example.com` |
| Network | IPv4 addresses, `*.internal` / `*.corp`, RDS / ElastiCache / Azure / Mongo Atlas hosts | `192.0.2.1` (RFC 5737 range), `mock-host-01.corp` |
| Personal | Phone numbers, Luhn-valid card numbers, US SSN, Indian PAN, Verhoeff-valid Aadhaar | `+1-555-0101`, `MOCK_CARD_01` |
| Always mask | Anything you list (case-insensitive, whole words) | `MOCK_TERM_01` or your own label |

The same value always gets the same placeholder, in every message of the tab. Once a value has been seen (say a database name inside a connection string), every later mention is masked too, even without surrounding context. Generic values (`admin`, `root`, `localhost`, `127.0.0.1`, `example.com`, `8.8.8.8`) are deliberately left alone, as are variable references such as `password = req.body.password`.

## How it works

```
                  ┌──────────────── content scripts (isolated world, one per tab) ────────────────┐
 clipboard ──────▶│ paste.onPaste ─▶ engine.sanitize ─▶ composer.insertText ──▶ chat input         │
                  │        │              │  ▲                                    │               │
                  │        │              ▼  │ tokens                             ▼ send          │
                  │        │         ┌────────────┐                          AI provider          │
                  │        │         │ Vault (Map)│  ◀── memory only                │ tokens only │
                  │        │         └────────────┘                                 ▼             │
 screen ◀─────────│ dom-rehydrate (MutationObserver) ◀──────── streamed reply (tokens)            │
 clipboard ◀──────│ copy.js: restore on Ctrl+C and on "Copy code" buttons                          │
                  └────────────────────────────────────────────────────────────────────────────────┘
```

| File | Role |
|---|---|
| `src/core/detectors.js` | Regex and checksum detectors, overlap resolution. Pure functions, every quantifier bounded. |
| `src/core/vault.js` | The volatile token map: original ↔ token, boundary-aware regexes, structure-preserving token formats. |
| `src/core/engine.js` | `sanitize` / `plan`: detectors + vault, consistent tokens, known-value propagation. |
| `src/content/composer.js` | Finds the chat input and inserts text so React / ProseMirror / Quill register it (synthetic `paste`, then `execCommand`, then manual insert). Masks typed text in place. |
| `src/content/dom-rehydrate.js` | The live-DOM restorer. Edits `Text.nodeValue` only, never touches the composer, stitches tokens split across highlight spans. |
| `src/content/copy.js` | Selection copy and copy-button handling. Reads the clipboard through a hidden textarea and `execCommand('paste')`, so Chrome never shows a clipboard permission prompt. |
| `src/content/ui.js` | Status pill, panel and toasts in a **closed** shadow root. |
| `src/content/main.js` | Wiring, hotkeys, send guard, popup messaging. |
| `src/popup/*` | Settings. |

### How this maps to the original MVP spec

1. **Manifest V3 + content scripts.** No service worker. Permissions are exactly `clipboardRead`, `clipboardWrite`, `storage`; there are no host permissions. Match patterns are `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://claude.ai/*`, `https://gemini.google.com/*`. The token map is a plain in-memory `Map`.
2. **Paste interceptor.** A capture-phase `paste` listener on `window`, `preventDefault`, local regex detection, structure-preserving tokens, then re-insertion through the editor's own paste pipeline plus an `input` event.
3. **MutationObserver rehydration.** Observes `childList` and `characterData`. It watches the whole document instead of a site-specific container like `react-scroll-to-bottom`, because those class names change often. It does nothing until the first token exists.
4. **Copy hooks.** Selection copy plus copy-button handling, verifying that no tokens remain and warning if the AI invented a placeholder that is not in the vault.

Beyond the spec: send-time safety net, drag-and-drop interception, mask/reveal toggle, known-value propagation, an *Always mask* list, popup, and the test suites below.

## Privacy and threat model

**Enforced by tests** (`test/no-network.test.js`, `test/e2e/e2e.mjs`):

- No `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `eval` or remote code anywhere in the extension. The browser test confirms it made zero outbound requests.
- `chrome.storage` is used only by `prefs.js`, only the `local` area, and only for settings. The browser test reads storage back and checks it holds no secrets and no tokens.
- The token map is never written to `localStorage`, `sessionStorage`, IndexedDB, cookies or the clipboard.
- The page's own JavaScript cannot see the extension (`window.LDS` is `undefined` in the page world).
- Across all six editor scenarios, the text the "provider" received never contained an original value.

**Honest limits. Please read these:**

- **Restored values are in the page DOM.** To show you your real names, the extension writes them into the page's text nodes. Page scripts, analytics or session-replay tools running on the AI site, and other extensions, can read DOM text. The AI *model* never receives originals, but if you do not trust the site's front-end code, use *Show tokens* (`Alt+Shift+R`) and copy through the extension.
- **Reloading the tab forgets the mapping**, by design. Old messages then show placeholders. The tokens are meaningless without the map.
- **Detection is pattern-based, not a guarantee.** It will miss secrets that look like ordinary words. Add those to *Always mask*. It can also mask things you did not want masked; undo by turning that category off.
- **Only text is handled.** Images, files and uploads are not scanned.
- The *Always mask* list is stored in `chrome.storage.local` (it is a preference). If a term is itself sensitive, keep that in mind.
- If the AI invents a placeholder that is not in the vault (say `MOCK_DB_09`), it is left as is.

## Verification status

What has been run (Node 22, Chromium 141 under Xvfb):

- **45 unit tests** (`npm test`): every detector, false-positive corpus, round-trip and idempotence fuzzing (400 random documents), boundary and collision rules, a ReDoS / performance guard (worst pathological input about 0.6 s), jsdom streaming and stitching tests, static privacy checks.
- **95 end-to-end checks** (`npm run test:e2e`): the unpacked extension loaded into real Chromium, real keyboard paste (Ctrl+V), real clipboard, against mock chat pages served at the three real domains. Composers covered: **real ProseMirror**, **real Quill 2**, a bare contenteditable, a React-style controlled textarea, and a hand-rolled rich editor.

**What has not been run:** the live chatgpt.com, claude.ai and gemini.google.com. Those sites change their markup often and could not be reached from the build environment. The design avoids depending on their class names (editable detection and observation are generic), but please do this five-minute check on each site after installing:

1. Paste a snippet containing an email and `sk-proj-` followed by 30 random characters. The input should show `mock.user.01@example.com` and `MOCK_API_KEY_01`.
2. Send it and ask the AI to "repeat my email back". Your real email should appear on screen.
3. Ask for a code block mentioning the key, click **Copy**, paste into a notepad. You should get the real values.
4. Type a fake key like `AKIA` + 16 capitals by hand and press Enter. It should be blocked once, then masked.
5. Press `Alt+Shift+R` twice. The page should flip to tokens and back.

If a site breaks one of these, the likely fixes are in `SITES` in `src/content/composer.js` (send button / composer selectors) or `insertText` (how that editor accepts pasted text). Claude.ai may convert very long pastes into an attachment; the attachment will contain the masked text.

## Development

```bash
npm install              # jsdom, playwright-core, esbuild, prosemirror, quill (dev only)
npm test                 # unit + jsdom + static privacy tests
npm run test:e2e         # real Chromium; needs xvfb (set CHROME_PATH if Chromium is elsewhere)
npm run icons            # regenerate icons (Pillow)
npm run package          # dist/*.zip
```

Add a detector: write a function in `src/core/detectors.js` that pushes `mk('your_type', start, end, text)` spans, register the type in `TYPES` (label, category, tier), call it from `detect()`, and add a test. Keep every quantifier bounded; the performance test will tell you if you did not.

## Roadmap

- Lightweight WASM named-entity model for names and organisations (the spec's "later" step).
- Opt-in encrypted per-conversation persistence so placeholders survive a reload.
- Firefox build.
- A "report what was masked" log (local only) to help tune detectors.
