/*
 * Minimal in-page UI: a status pill, a small control panel and toasts.
 * Lives in a *closed* shadow root so page scripts (and session recorders that walk the
 * DOM) cannot read it, and the page's CSS cannot restyle it. Everything dynamic is set
 * with textContent, never innerHTML.
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0; }
    /* Pill docks to the right edge at mid-height: the bottom corners are where chat sites keep
       their send button and composer controls, so we never cover those. */
    .wrap { position: fixed; right: 12px; top: 45%; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; z-index: 2147483647; pointer-events: none; }
    .wrap > * { pointer-events: auto; }
    .toast, .panel, .pill { color: #f4f4f5; background: rgba(24,24,27,.94); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 28px rgba(0,0,0,.35); backdrop-filter: blur(10px); }
    .pill { order: 0; opacity: .85; transition: opacity .15s; }
    .pill:hover, .pill:focus-visible { opacity: 1; }
    .panel { order: 1; max-height: calc(55vh - 56px); overflow: auto; }
    /* toasts appear bottom-centre, just above the composer, where the user is looking */
    .toast { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); width: max-content; max-width: min(440px, calc(100vw - 32px)); padding: 9px 12px; border-radius: 10px; display: flex; gap: 9px; align-items: flex-start; }
    .toast[hidden], .panel[hidden] { display: none; }
    .dot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: #2dd4bf; }
    .toast.warn .dot { background: #fbbf24; }
    .panel { width: 300px; border-radius: 12px; padding: 12px; }
    .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
    .head strong { font-size: 14px; }
    .state { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(45,212,191,.16); color: #5eead4; }
    .state.off { background: rgba(161,161,170,.18); color: #d4d4d8; }
    .state.masked { background: rgba(251,191,36,.16); color: #fcd34d; }
    .sub { margin: 4px 0 10px; color: #a1a1aa; }
    .row { display: flex; gap: 8px; margin-bottom: 10px; }
    button { cursor: pointer; color: inherit; }
    .row button { flex: 1; padding: 7px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06); }
    .row button:hover { background: rgba(255,255,255,.12); }
    .list { list-style: none; margin: 0 0 8px; padding: 0; max-height: 160px; overflow: auto; border-top: 1px solid rgba(255,255,255,.1); }
    .list li { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
    .list code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #99f6e4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list span { color: #a1a1aa; font-size: 11px; white-space: nowrap; }
    .empty { color: #a1a1aa; padding: 8px 0; }
    .foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #71717a; font-size: 11px; }
    .link { background: none; border: 0; padding: 0; color: #fca5a5; font-size: 12px; text-decoration: underline; }
    .pill { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px 0 9px; border-radius: 15px; }
    .pill:hover { border-color: rgba(255,255,255,.3); }
    .pill svg { width: 15px; height: 15px; stroke: #2dd4bf; }
    .pill.masked svg { stroke: #fbbf24; }
    .pill.off svg { stroke: #a1a1aa; }
    .count { font-variant-numeric: tabular-nums; font-weight: 600; }
    :focus-visible { outline: 2px solid #5eead4; outline-offset: 2px; }
  `;

  const HTML = `
    <style>${CSS}</style>
    <div class="wrap">
      <div class="toast" role="status" aria-live="polite" hidden><span class="dot"></span><span class="msg"></span></div>
      <div class="panel" hidden>
        <div class="head"><strong>AI Sanitizer</strong><span class="state"></span></div>
        <p class="sub"></p>
        <div class="row">
          <button type="button" data-act="reveal"></button>
          <button type="button" data-act="sanitize">Mask composer</button>
        </div>
        <ul class="list"></ul>
        <div class="foot"><button type="button" class="link" data-act="clear">Clear vault</button><span>Alt+Shift+R / S</span></div>
      </div>
      <button type="button" class="pill" aria-label="AI Sanitizer status">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>
        <span class="count">0</span>
      </button>
    </div>`;

  function create(handlers) {
    handlers = handlers || {};
    let host = null;
    let el = {};
    let data = { enabled: true, show: true, count: 0, reveal: true, entries: [] };
    let open = false;
    let toastTimer = null;
    let queuedToast = null;
    let waiting = false;

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-lds-ui', '');
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = HTML; // constant markup only
      el = {
        wrap: root.querySelector('.wrap'),
        toast: root.querySelector('.toast'),
        msg: root.querySelector('.msg'),
        panel: root.querySelector('.panel'),
        state: root.querySelector('.state'),
        sub: root.querySelector('.sub'),
        list: root.querySelector('.list'),
        pill: root.querySelector('.pill'),
        count: root.querySelector('.count'),
        reveal: root.querySelector('[data-act="reveal"]')
      };
      el.pill.addEventListener('click', () => {
        open = !open;
        render();
      });
      root.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'reveal' && handlers.onToggleReveal) handlers.onToggleReveal();
        else if (act === 'sanitize' && handlers.onSanitizeComposer) handlers.onSanitizeComposer();
        else if (act === 'clear' && handlers.onClear) handlers.onClear();
      });
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Escape' && open) {
            open = false;
            render();
          }
        },
        true
      );
      document.addEventListener(
        'pointerdown',
        (e) => {
          if (open && !e.composedPath().includes(host)) {
            open = false;
            render();
          }
        },
        true
      );
    }

    /** Append lazily, after the page has loaded, so framework hydration never sees us. */
    function ensure() {
      if (host && host.isConnected) return true;
      if (document.readyState !== 'complete') {
        if (!waiting) {
          waiting = true;
          window.addEventListener('load', () => setTimeout(() => ((waiting = false), render()), 400), { once: true });
        }
        return false;
      }
      const parent = document.documentElement;
      if (!parent) return false;
      if (!host) build();
      parent.appendChild(host);
      return true;
    }

    function render() {
      if (!ensure()) return;
      el.wrap.style.display = data.show && data.enabled ? '' : 'none';
      const state = !data.enabled ? 'off' : data.reveal ? '' : 'masked';
      el.pill.className = 'pill' + (state ? ' ' + state : '');
      el.count.textContent = String(data.count);
      el.pill.title = data.count ? `${data.count} value${data.count === 1 ? '' : 's'} protected in this tab` : 'AI Sanitizer is on';
      el.state.className = 'state' + (state ? ' ' + state : '');
      el.state.textContent = !data.enabled ? 'off' : data.reveal ? 'showing originals' : 'showing tokens';
      el.sub.textContent = data.count
        ? `${data.count} value${data.count === 1 ? ' is' : 's are'} masked for the AI. Kept in memory only; gone when this tab reloads.`
        : 'Paste something sensitive and it is masked before the AI sees it.';
      el.reveal.textContent = data.reveal ? 'Show tokens' : 'Show originals';
      el.panel.hidden = !open;

      el.list.textContent = '';
      if (!data.entries.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'Nothing masked yet.';
        el.list.appendChild(li);
      } else {
        for (const it of data.entries.slice(0, 60)) {
          const li = document.createElement('li');
          const code = document.createElement('code');
          code.textContent = it.token;
          const span = document.createElement('span');
          span.textContent = String(it.label || '').toLowerCase().replace(/_/g, ' ');
          li.append(code, span);
          el.list.appendChild(li);
        }
      }
      if (queuedToast) {
        const q = queuedToast;
        queuedToast = null;
        toast(q.msg, q.kind);
      }
    }

    function toast(msg, kind) {
      if (!ensure()) {
        queuedToast = { msg, kind };
        return;
      }
      el.msg.textContent = msg;
      el.toast.className = 'toast' + (kind === 'warn' ? ' warn' : '');
      el.toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.toast.hidden = true;
      }, kind === 'warn' ? 8000 : 4500);
    }

    function update(next) {
      data = Object.assign({}, data, next);
      render();
    }

    return { update, toast, render, isOpen: () => open };
  }

  LDS.ui = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.ui;
})();
