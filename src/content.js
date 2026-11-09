/* Content script: finds score page images on musescore.com and overlays note names. */
(function () {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    system: 'english',      // english | german | solfege | solfege-ti
    octave: false,
    position: 'beside',     // beside | above | below
    size: 2.0,              // font size, in staff spaces (see MIN_PX)
    color: '#d0021b',
    colorByNote: false,
    asciiAccidentals: false,
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MIN_PX = 13;        // minimum on-screen label size (above/below)
  const MIN_PX_BESIDE = 12; // ... and next to notes
  const SCORE_IMG_RE = /score_\d+\.svg/i;
  const LOG = (...a) => console.debug('[Note Names for MuseScore]', ...a);

  let settings = { ...DEFAULTS };
  const pages = new Map(); // img -> { analysis, overlay, src }
  const analysisCache = new Map(); // src (without query) -> Promise<analysis>

  // ---------------------------------------------------------------- settings

  const storage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  if (storage) {
    storage.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; scan(); renderAll(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      renderAll();
    });
  }

  // ---------------------------------------------------------------- fetching

  async function fetchText(url) {
    try {
      // Default credentials: cookies for same-origin, none for the S3 CDN
      // (which allows CORS with "*" but not with credentials).
      const r = await fetch(url);
      if (r.ok) {
        const t = await r.text();
        if (t.trimStart().startsWith('<')) return t;
      }
    } catch (e) { /* fall through to background fetch */ }
    // Cross-origin fallback via the service worker (has host permissions).
    const res = await chrome.runtime.sendMessage({ type: 'fetch-svg', url });
    if (!res || !res.ok) throw new Error((res && res.error) || 'fetch failed');
    return res.text;
  }

  function analysisFor(src) {
    const key = src.split('?')[0];
    if (!analysisCache.has(key)) {
      analysisCache.set(key, fetchText(src).then((t) => window.MSNN.analyze(t)).catch((e) => {
        analysisCache.delete(key);
        throw e;
      }));
    }
    return analysisCache.get(key);
  }

  // ---------------------------------------------------------------- overlay

  function ensureOverlay(img) {
    let entry = pages.get(img);
    const parent = img.parentElement;
    if (!parent) return null;
    if (entry && entry.overlay.isConnected && entry.overlay.parentElement === parent) return entry;
    // Drop overlays left behind by an <img> the site replaced.
    parent.querySelectorAll(':scope > .msnn-overlay').forEach((o) => o.remove());
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const overlay = document.createElementNS(SVG_NS, 'svg');
    overlay.classList.add('msnn-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    parent.appendChild(overlay);
    entry = { ...(entry || {}), overlay };
    pages.set(img, entry);
    positionOverlay(img, overlay);
    if (!entry.ro) {
      entry.ro = new ResizeObserver(() => {
        positionOverlay(img, entry.overlay);
        // Re-render when zoom changes enough to affect the minimum label size.
        const k = entry.analysis ? img.offsetWidth / entry.analysis.viewBox[2] : 0;
        if (k && entry.renderedScale && Math.abs(k / entry.renderedScale - 1) > 0.05) render(img);
      });
      entry.ro.observe(img);
    }
    return entry;
  }

  function positionOverlay(img, overlay) {
    overlay.style.left = img.offsetLeft + 'px';
    overlay.style.top = img.offsetTop + 'px';
    overlay.style.width = img.offsetWidth + 'px';
    overlay.style.height = img.offsetHeight + 'px';
  }

  /** Group the notes of one staff into chords (same horizontal position). */
  function chords(notes) {
    const byStaff = new Map();
    for (const n of notes) {
      if (!byStaff.has(n.staff)) byStaff.set(n.staff, []);
      byStaff.get(n.staff).push(n);
    }
    const out = [];
    for (const list of byStaff.values()) {
      list.sort((a, b) => a.cx - b.cx);
      let cur = null;
      for (const n of list) {
        if (!cur || n.cx - cur.x0 > 1.5 * n.sp) {
          cur = { x0: n.cx, notes: [] };
          out.push(cur);
        }
        cur.notes.push(n);
      }
    }
    return out;
  }

  function render(img) {
    const entry = pages.get(img);
    if (!entry || !entry.analysis) return;
    const { analysis, overlay } = entry;
    overlay.replaceChildren();
    overlay.style.display = settings.enabled ? '' : 'none';
    if (!settings.enabled) return;

    const [vx, vy, vw, vh] = analysis.viewBox;
    overlay.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    overlay.setAttribute('preserveAspectRatio', 'none');

    const staves = analysis.staves;
    const frag = document.createDocumentFragment();
    // Screen pixels per SVG unit; labels never get smaller than MIN_PX on screen.
    const k = img.offsetWidth / vw || 1;
    entry.renderedScale = k;
    const fontSize = (sp, scale) => Math.max(settings.size * scale * sp, (scale < 1 ? MIN_PX_BESIDE : MIN_PX) / k);
    const addText = (x, y, n, anchor, baseline, fs, thin) => {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', x.toFixed(1));
      t.setAttribute('y', y.toFixed(1));
      t.setAttribute('font-size', fs.toFixed(1));
      t.setAttribute('text-anchor', anchor);
      t.setAttribute('dominant-baseline', baseline);
      t.setAttribute('fill', settings.colorByNote ? window.MSNN.LETTER_COLORS[n.letter] : settings.color);
      t.setAttribute('stroke-width', (fs * (thin ? 0.1 : 0.16)).toFixed(1));
      t.textContent = window.MSNN.formatName(n, settings);
      frag.appendChild(t);
    };

    if (settings.position === 'beside') {
      // Labels just right of each chord, one per notehead, at the notehead's
      // height (nudged apart where close intervals would collide).
      for (const c of chords(analysis.notes)) {
        const sp = c.notes[0].sp;
        const fs = fontSize(sp, 0.75);
        const xr = Math.max(...c.notes.map((n) => n.x + n.w)) + 0.15 * sp;
        let prevY = -Infinity;
        for (const n of [...c.notes].sort((a, b) => a.cy - b.cy)) {
          const y = Math.max(n.cy, prevY + fs * 0.9);
          addText(xr, y, n, 'start', 'central', fs, true);
          prevY = y;
        }
      }
    } else {
      for (const c of chords(analysis.notes)) {
        const s = staves[c.notes[0].staff];
        const sp = s.sp;
        const fs = fontSize(sp, 1);
        const lineH = fs * 1.02;
        const sorted = [...c.notes].sort((a, b) => a.cy - b.cy); // highest pitch first
        const x = c.notes.reduce((t, n) => t + n.cx, 0) / c.notes.length;
        if (settings.position === 'below') {
          const lowest = Math.max(s.bottom, ...c.notes.map((n) => n.y + n.h));
          let y = lowest + 0.8 * sp;
          for (const n of sorted) { addText(x, y, n, 'middle', 'hanging', fs); y += lineH; }
        } else {
          const highest = Math.min(s.top, ...c.notes.map((n) => n.y));
          let y = highest - 0.8 * sp;
          for (const n of [...sorted].reverse()) { addText(x, y, n, 'middle', 'alphabetic', fs); y -= lineH; }
        }
      }
    }
    overlay.appendChild(frag);
  }

  function renderAll() {
    dropDetached();
    for (const img of pages.keys()) render(img);
  }

  // ---------------------------------------------------------------- discovery

  function handleImage(img) {
    const src = img.currentSrc || img.src;
    if (!src || !SCORE_IMG_RE.test(src)) return;
    const entry = pages.get(img);
    if (entry && entry.src === src && entry.overlay?.isConnected) return;
    const e = ensureOverlay(img);
    if (!e) return;
    e.src = src;
    e.analysis = null;
    e.overlay.replaceChildren();
    analysisFor(src).then((analysis) => {
      if ((img.currentSrc || img.src) !== src) return;
      e.analysis = analysis;
      LOG(`${src.split('?')[0].split('/').pop()}: ${analysis.staves.length} staves, ${analysis.notes.length} notes`);
      render(img);
    }).catch((err) => LOG('could not analyse', src, err));
  }

  function scan(root = document) {
    root.querySelectorAll?.('img').forEach(handleImage);
  }

  function dropDetached() {
    for (const [img, e] of pages) {
      if (img.isConnected) continue;
      e.ro?.disconnect();
      e.overlay?.remove();
      pages.delete(img);
    }
  }

  const mo = new MutationObserver((muts) => {
    if (muts.some((m) => m.removedNodes.length)) dropDetached();
    for (const m of muts) {
      if (m.type === 'attributes') { if (m.target.tagName === 'IMG') handleImage(m.target); continue; }
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') handleImage(node);
        else scan(node);
      }
    }
  });
  if (window.MSNN && window.MSNN._mo) window.MSNN._mo.disconnect(); // re-injection
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  scan();

  // Status for the popup.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'status') return;
      let done = 0, pending = 0, notes = 0;
      for (const [img, e] of pages) {
        if (!img.isConnected) continue;
        if (e.analysis) { done++; notes += e.analysis.notes.length; } else pending++;
      }
      // Main-page raster images (thumbnails carry an "@WxH" suffix).
      const raster = [...document.images].some((i) => /\/score_\d+\.png(@0)?(\?|$)/.test(i.src) && i.offsetWidth > 300);
      sendResponse({ pages: done, pending, notes, raster });
    });
  }

  // Expose for debugging from the console.
  window.MSNN = window.MSNN || {};
  window.MSNN._mo = mo;
  window.MSNN.configure =(s) => { Object.assign(settings, s); renderAll(); };
  window.MSNN.rescan = () => { analysisCache.clear(); pages.forEach((e) => (e.src = null)); scan(); };
})();
