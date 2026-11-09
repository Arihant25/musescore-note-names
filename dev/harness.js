/*
 * Development harness: paste into the DevTools console on a musescore.com
 * score page while `python dev/serve.py` is running, to (re)load the content
 * scripts from disk without reinstalling the extension:
 *
 *   (0,eval)(await (await fetch('http://127.0.0.1:8765/dev/harness.js')).text())
 *
 * Then: await MSNNDev.reload(); await MSNNDev.collect(); MSNNDev.report();
 */
(function () {
  const BASE = 'http://127.0.0.1:8765/';
  const L = 'CDEFGAB';
  const scoreImgs = () => [...document.images].filter((i) => /score_\d+\.svg/.test(i.src));

  window.MSNNDev = {
    async reload() {
      document.querySelectorAll('.msnn-overlay').forEach((e) => e.remove());
      for (const f of ['src/analyzer.js', 'src/names.js', 'src/content.js', 'src/focus.js']) {
        (0, eval)(await (await fetch(BASE + f)).text());
      }
      let st = document.getElementById('msnn-css');
      if (!st) { st = document.createElement('style'); st.id = 'msnn-css'; document.head.appendChild(st); }
      st.textContent = await (await fetch(BASE + 'src/content.css')).text();
    },

    scroller() {
      let el = scoreImgs()[0];
      while (el && !(el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      return el || document.scrollingElement;
    },

    /** Scroll through the viewer and fetch every page's SVG. */
    async collect() {
      const sc = this.scroller();
      const urls = new Map();
      const grab = () => scoreImgs().forEach((i) => urls.set(+i.src.match(/score_(\d+)\.svg/)[1], i.src));
      sc.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 800));
      for (let k = 0; k < 80; k++) {
        grab();
        const before = sc.scrollTop;
        sc.scrollTop += sc.clientHeight * 0.8;
        await new Promise((r) => setTimeout(r, 600));
        if (sc.scrollTop === before) break;
      }
      grab();
      sc.scrollTop = 0;
      this.pages = [];
      for (const [n, u] of [...urls].sort((a, b) => a[0] - b[0])) {
        this.pages[n] = await (await fetch(u)).text();
      }
      return this.pages.length;
    },

    report(pageIdx) {
      const keyStr = (k) => Object.entries(k).map(([l, v]) => L[l] + (v > 0 ? '#' : 'b')).join('') || '-';
      const one = (t, p) => {
        const a = MSNN.analyze(t);
        return `p${p}: ` + a.staves.map((s) =>
          `[${s.index} ${(s.clefs || []).map((c) => c.type[0] + (c.type.includes('8') ? '8' : '')).join('') || '?'} ${(s.keys || []).map((k) => keyStr(k.alter)).join('|') || '·'} n${a.notes.filter((n) => n.staff === s.index).length}]`
        ).join(' ');
      };
      return (pageIdx == null ? this.pages.map(one) : [one(this.pages[pageIdx], pageIdx)]).join('\n');
    },

    /** Names of the notes on one page, staff by staff (left to right). */
    names(pageIdx, staffIdx, opts = { system: 'english', octave: true }) {
      const a = MSNN.analyze(this.pages[pageIdx]);
      return a.notes.filter((n) => staffIdx == null || n.staff === staffIdx)
        .map((n) => MSNN.formatName(n, opts) + (n.explicit ? '!' : '')).join(' ');
    },

    /** Scroll the viewer so page n is in view. */
    async show(n, offset = 0) {
      const sc = this.scroller();
      const page = sc.querySelectorAll(':scope > div')[n] || null;
      if (page) sc.scrollTop = page.offsetTop + offset;
      await new Promise((r) => setTimeout(r, 1500));
    },
  };
})();

/** Summary of anything the analyzer could not place, per page. */
window.MSNNDev.problems = function () {
  return this.pages.map((t, p) => {
    const a = MSNN.analyze(t);
    const st = a.stats;
    return `p${p}: notes ${a.notes.length}/${st.noteGlyphs}, unplaced ${JSON.stringify(st.unplacedNotes.map((u) => u.why + (u.w ? `(${u.w.toFixed(1)}x${u.h.toFixed(1)})` : '') + '@' + (u.x | 0) + ',' + (u.y | 0)))}, acc unattached ${st.unattachedAcc.length}/${st.accidentals} ${JSON.stringify(st.unattachedAcc.map((u) => u.type + '@' + (u.x | 0) + ',' + (u.y | 0)))}`;
  }).join('\n');
};

/**
 * Show an enlarged crop of page p (SVG coordinates) with labels drawn in,
 * fixed at the top-left of the window. Region defaults to staff pair i.
 */
window.MSNNDev.crop = function (p, x, y, w, h, px = 1400) {
  document.getElementById('__crop')?.remove();
  const a = MSNN.analyze(this.pages[p]);
  const doc = new DOMParser().parseFromString(this.pages[p], 'image/svg+xml');
  const svg = doc.documentElement;
  svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  svg.setAttribute('width', px);
  svg.setAttribute('height', (px * h) / w);
  for (const n of a.notes) {
    if (n.cx < x || n.cx > x + w || n.cy < y || n.cy > y + h) continue;
    const t = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', n.x + n.w + 0.15 * n.sp);
    t.setAttribute('y', n.cy);
    t.setAttribute('font-size', 0.95 * n.sp);
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('fill', n.explicit ? '#0050d0' : '#d0021b');
    t.setAttribute('font-family', 'Arial');
    t.setAttribute('font-weight', '700');
    t.textContent = MSNN.formatName(n, { system: 'english', octave: false });
    svg.appendChild(t);
  }
  const div = document.createElement('div');
  div.id = '__crop';
  div.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;border:2px solid red';
  div.appendChild(document.importNode(svg, true));
  document.body.appendChild(div);
  return a.staves.map((s) => `${s.index}:${s.top | 0}-${s.bottom | 0} x${s.x1 | 0}-${s.x2 | 0}`).join(' ');
};
window.MSNNDev.uncrop = () => document.getElementById('__crop')?.remove();
