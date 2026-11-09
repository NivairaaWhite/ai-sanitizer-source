/*
 * Live-DOM rehydration.
 *
 * A MutationObserver watches the page. Whenever text appears or changes -- the
 * model streaming a reply word by word, React re-rendering a message, the user's
 * own sent bubble -- tokens in that text are swapped back to the original values
 * (mode "restore") or the other way round (mode "mask").
 *
 * Design rules:
 *  - Only ever edit Text.nodeValue. Never add, remove or move nodes, so React /
 *    Angular reconciliation is not disturbed.
 *  - Never touch the composer, other editable fields, scripts, styles or our own UI.
 *    Restoring inside the composer would put the real secret back in the text that is
 *    about to be sent.
 *  - A token can be split across nodes (syntax-highlight spans, streaming chunks), so a
 *    debounced second pass stitches matches that span several text nodes in a block.
 *  - Zero cost until the vault has an entry.
 */
(function () {
  'use strict';
  const LDS = (globalThis.LDS = globalThis.LDS || {});

  const SKIP_SELECTOR = [
    'textarea',
    'input',
    'select',
    'script',
    'style',
    'noscript',
    'template',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
    '[data-lds-ui]'
  ].join(',');

  const BLOCK_SELECTOR = 'p,pre,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,div';
  const FLUSH_MS = 60;

  function create(opts) {
    const vault = opts.vault;
    const doc = opts.document || document;
    const stats = { restored: 0 };
    let mode = 'restore'; // 'restore' | 'mask' | 'off'
    let observer = null;
    let timer = null;
    const pending = new Set();

    const direction = () => (mode === 'mask' ? 'mask' : 'restore');

    function skipped(node) {
      const el = node.nodeType === 3 ? node.parentElement : node;
      return !el || !!el.closest(SKIP_SELECTOR);
    }

    function blockOf(node) {
      const el = node.nodeType === 3 ? node.parentElement : node;
      return el ? el.closest(BLOCK_SELECTOR) || el : null;
    }

    /** enclosing block of an added node, so tokens split between new and old siblings are seen */
    function contextBlock(node) {
      const parent = node.parentElement;
      return (parent && (parent.closest(BLOCK_SELECTOR) || parent)) || (node.nodeType === 1 ? node : null);
    }

    function walkTexts(root, cb) {
      if (root.nodeType === 3) {
        if (!skipped(root)) cb(root);
        return;
      }
      if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
      if (root.nodeType === 1 && skipped(root)) return;
      const tw = doc.createTreeWalker(root, 1 | 4, (n) => {
        if (n.nodeType === 1) return n.matches(SKIP_SELECTOR) ? 2 /* REJECT subtree */ : 3 /* SKIP, keep children */;
        return 1; /* ACCEPT text */
      });
      while (tw.nextNode()) cb(tw.currentNode);
    }

    function processText(node) {
      if (mode === 'off') return false;
      const v = node.nodeValue;
      if (!v || v.length < 3) return false;
      const d = direction();
      if (!vault.test(d, v)) return false;
      const out = d === 'restore' ? vault.restore(v) : vault.mask(v);
      if (out === v) return false;
      node.nodeValue = out;
      stats.restored++;
      return true;
    }

    // ---- second pass: matches that span several text nodes in one block
    function lastIndexAtMost(arr, x) {
      let lo = 0;
      let hi = arr.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= x) {
          ans = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    }

    function fixBlock(block) {
      if (mode === 'off' || !block || !block.isConnected) return;
      const d = direction();
      if (!vault.test(d, block.textContent)) return;

      const nodes = [];
      const starts = [];
      let full = '';
      let lastBlock = null;
      walkTexts(block, (n) => {
        const b = blockOf(n);
        if (lastBlock && b !== lastBlock) full += '\u0000'; // never stitch across blocks
        lastBlock = b;
        starts.push(full.length);
        nodes.push(n);
        full += n.nodeValue;
      });
      if (!nodes.length) return;

      const re = vault.regex(d);
      re.lastIndex = 0;
      const hits = [];
      let m;
      while ((m = re.exec(full)) !== null) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        hits.push({ s: m.index, e: m.index + m[0].length, r: vault.replacementFor(d, m[0]) });
      }

      // back to front so earlier offsets stay valid
      for (let h = hits.length - 1; h >= 0; h--) {
        const { s, e, r } = hits[h];
        const i = lastIndexAtMost(starts, s);
        const j = lastIndexAtMost(starts, e - 1);
        const a = s - starts[i];
        const b = e - starts[j];
        if (i === j) {
          const v = nodes[i].nodeValue;
          nodes[i].nodeValue = v.slice(0, a) + r + v.slice(b);
        } else {
          nodes[i].nodeValue = nodes[i].nodeValue.slice(0, a) + r;
          for (let k = i + 1; k < j; k++) nodes[k].nodeValue = '';
          nodes[j].nodeValue = nodes[j].nodeValue.slice(b);
        }
        stats.restored++;
      }
    }

    function scheduleBlock(block) {
      if (!block) return;
      pending.add(block);
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    }

    function flush() {
      timer = null;
      const list = [...pending];
      pending.clear();
      for (const b of list) fixBlock(b);
      if (observer) observer.takeRecords(); // drop the mutations we just caused
    }

    function processTree(root) {
      if (mode === 'off' || !root || !vault.size) return;
      walkTexts(root, processText);
      scheduleBlock(root.nodeType === 1 ? contextBlock(root) || root : blockOf(root));
    }

    function onMutations(records) {
      if (mode === 'off' || !vault.size) return;
      for (const r of records) {
        if (r.type === 'characterData') {
          const n = r.target;
          if (n.nodeType === 3 && !skipped(n)) {
            processText(n);
            scheduleBlock(blockOf(n));
          }
        } else if (r.type === 'childList') {
          for (const n of r.addedNodes) {
            if (n.nodeType === 3) {
              if (!skipped(n)) {
                processText(n);
                scheduleBlock(blockOf(n));
              }
            } else if (n.nodeType === 1) {
              processTree(n);
            }
          }
        }
      }
      observer.takeRecords(); // ignore the changes we made ourselves
    }

    function start() {
      if (observer) return;
      observer = new (doc.defaultView || window).MutationObserver(onMutations);
      observer.observe(doc, { subtree: true, childList: true, characterData: true });
    }

    function stop() {
      if (observer) observer.disconnect();
      observer = null;
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    }

    /** full re-scan of the page (mode switch, new tokens) */
    function refresh() {
      if (mode === 'off' || !vault.size) return;
      const root = doc.body || doc.documentElement;
      if (!root) return;
      walkTexts(root, processText);
      fixBlock(root);
      if (observer) observer.takeRecords();
    }

    function setMode(next) {
      if (next === mode) return;
      mode = next;
      if (mode !== 'off') refresh();
    }

    return { start, stop, setMode, getMode: () => mode, refresh, processTree, flush, stats };
  }

  LDS.rehydrate = { create, SKIP_SELECTOR, BLOCK_SELECTOR };
  if (typeof module !== 'undefined' && module.exports) module.exports = LDS.rehydrate;
})();
