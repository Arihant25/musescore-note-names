/*
 * Note Names for MuseScore - SVG score analyzer.
 *
 * musescore.com serves each score page as an SVG exported by MuseScore. Every
 * engraved element carries a class (Note, StaffLines, Clef, KeySig,
 * Accidental, BarLine, ...), but the actual pitch data is gone. Glyphs of the
 * same class are frequently merged into a single <path>, so we:
 *
 *   1. parse every relevant path into subpaths and bounding boxes,
 *   2. cluster subpaths into glyphs,
 *   3. rebuild 5-line staves from the staff lines,
 *   4. work out each staff's clef / key signature / barlines,
 *   5. turn every notehead's vertical position into a pitch, applying the key
 *      signature and measure-scoped accidentals.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- geometry

  function parseTransform(str) {
    // Returns [a,b,c,d,e,f] for a chain of transforms.
    let m = [1, 0, 0, 1, 0, 0];
    if (!str) return m;
    const re = /(matrix|translate|scale)\s*\(([^)]*)\)/g;
    let t;
    while ((t = re.exec(str))) {
      const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
      let n;
      if (t[1] === 'matrix') n = v;
      else if (t[1] === 'translate') n = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
      else n = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
      m = [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
      ];
    }
    return m;
  }

  function elementTransform(el) {
    // Compose transforms of the element and its ancestors (rare, but cheap).
    const chain = [];
    for (let e = el; e && e.getAttribute; e = e.parentNode) {
      const t = e.getAttribute('transform');
      if (t) chain.unshift(t);
    }
    return parseTransform(chain.join(' '));
  }

  const NUM_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

  /**
   * Split path data into command letters and numbers. Arc flags are single
   * characters that may be packed together ("a5 5 0 014 3"), so they are
   * read one character at a time.
   */
  function tokenize(d) {
    const out = [];
    let pos = 0, cmd = '', argIdx = 0;
    const n = d.length;
    while (pos < n) {
      const ch = d[pos];
      if (ch === ' ' || ch === ',' || ch === '\n' || ch === '\t' || ch === '\r') { pos++; continue; }
      if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { out.push(ch); cmd = ch; argIdx = 0; pos++; continue; }
      if ((cmd === 'a' || cmd === 'A') && (argIdx % 7 === 3 || argIdx % 7 === 4) && (ch === '0' || ch === '1')) {
        out.push(ch === '1' ? 1 : 0); argIdx++; pos++; continue;
      }
      NUM_RE.lastIndex = pos;
      const m = NUM_RE.exec(d);
      if (!m) { pos++; continue; }
      out.push(Number(m[0])); argIdx++; pos = NUM_RE.lastIndex;
    }
    return out;
  }

  /** Sample points along an SVG elliptical arc (endpoint parameterisation). */
  function arcPoints(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry) return [x2, y2];
    const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num / den));
    if (fa === fs) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI;
    else if (fs && dt < 0) dt += 2 * Math.PI;
    const pts = [];
    const steps = Math.max(2, Math.ceil(Math.abs(dt) / (Math.PI / 8)));
    for (let k = 1; k <= steps; k++) {
      const t = t1 + (dt * k) / steps;
      pts.push(cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
    }
    return pts;
  }

  /**
   * Parse path data into subpaths. Each subpath is a list of sample points
   * (curves sampled at a few t values) in absolute coordinates.
   */
  function parsePathData(d) {
    const tokens = tokenize(d);

    const subpaths = [];
    let cur = null;
    let x = 0, y = 0, sx = 0, sy = 0;
    let lastCtrl = null; // for S/T reflection
    let i = 0;
    let cmd = null;

    const num = () => tokens[i++];
    const add = (px, py) => cur && cur.push(px, py);
    const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => {
      for (const tt of [0.25, 0.5, 0.75, 1]) {
        const u = 1 - tt;
        add(
          u * u * u * x0 + 3 * u * u * tt * x1 + 3 * u * tt * tt * x2 + tt * tt * tt * x3,
          u * u * u * y0 + 3 * u * u * tt * y1 + 3 * u * tt * tt * y2 + tt * tt * tt * y3
        );
      }
    };

    while (i < tokens.length) {
      if (typeof tokens[i] === 'string') cmd = tokens[i++];
      else if (cmd === null) { i++; continue; }
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === 'Z') {
        x = sx; y = sy; lastCtrl = null;
        // Implicit repeat makes no sense for Z; wait for next command.
        cmd = null;
        continue;
      }
      if (typeof tokens[i] !== 'number') { cmd = null; continue; }
      switch (C) {
        case 'M': {
          const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
          x = sx = nx; y = sy = ny;
          cur = [x, y];
          cur.absolute = !rel;
          subpaths.push(cur);
          cmd = rel ? 'l' : 'L'; // subsequent pairs are lineto
          lastCtrl = null;
          break;
        }
        case 'L': x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); add(x, y); lastCtrl = null; break;
        case 'H': x = num() + (rel ? x : 0); add(x, y); lastCtrl = null; break;
        case 'V': y = num() + (rel ? y : 0); add(x, y); lastCtrl = null; break;
        case 'C': {
          const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0);
          const x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0);
          const x3 = num() + (rel ? x : 0), y3 = num() + (rel ? y : 0);
          cubic(x, y, x1, y1, x2, y2, x3, y3);
          lastCtrl = [x2, y2]; x = x3; y = y3;
          break;
        }
        case 'S': {
          const x1 = lastCtrl ? 2 * x - lastCtrl[0] : x, y1 = lastCtrl ? 2 * y - lastCtrl[1] : y;
          const x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0);
          const x3 = num() + (rel ? x : 0), y3 = num() + (rel ? y : 0);
          cubic(x, y, x1, y1, x2, y2, x3, y3);
          lastCtrl = [x2, y2]; x = x3; y = y3;
          break;
        }
        case 'Q': {
          const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0);
          const x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0);
          cubic(x, y, x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2);
          lastCtrl = [x1, y1]; x = x2; y = y2;
          break;
        }
        case 'T': {
          const x1 = lastCtrl ? 2 * x - lastCtrl[0] : x, y1 = lastCtrl ? 2 * y - lastCtrl[1] : y;
          const x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0);
          cubic(x, y, x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2);
          lastCtrl = [x1, y1]; x = x2; y = y2;
          break;
        }
        case 'A': {
          const rx = num(), ry = num(), phi = num(), fa = num(), fs = num();
          const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
          const pts = arcPoints(x, y, rx, ry, phi, fa, fs, nx, ny);
          for (let k = 0; k < pts.length; k += 2) add(pts[k], pts[k + 1]);
          x = nx; y = ny; lastCtrl = null;
          break;
        }
        default: i++;
      }
    }
    return subpaths;
  }

  function applyMatrix(pts, m) {
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0) return pts;
    const out = new Array(pts.length);
    for (let k = 0; k < pts.length; k += 2) {
      out[k] = m[0] * pts[k] + m[2] * pts[k + 1] + m[4];
      out[k + 1] = m[1] * pts[k] + m[3] * pts[k + 1] + m[5];
    }
    out.absolute = pts.absolute;
    return out;
  }

  function boxOf(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      const px = pts[k], py = pts[k + 1];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return { minX, minY, maxX, maxY, pts };
  }

  /** All subpaths (with boxes) of every element with the given class. */
  function subpathsOf(doc, cls) {
    const out = [];
    doc.querySelectorAll('.' + cls).forEach((el) => {
      const m = elementTransform(el);
      const tag = el.localName;
      let sps = [];
      if (tag === 'path') {
        sps = parsePathData(el.getAttribute('d') || '');
      } else if (tag === 'polyline' || tag === 'polygon') {
        const v = (el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
        if (v.length >= 2) sps = [v];
      } else if (tag === 'line') {
        sps = [['x1', 'y1', 'x2', 'y2'].map((a) => Number(el.getAttribute(a) || 0))];
      } else if (tag === 'rect') {
        const rx = +el.getAttribute('x') || 0, ry = +el.getAttribute('y') || 0;
        const rw = +el.getAttribute('width') || 0, rh = +el.getAttribute('height') || 0;
        sps = [[rx, ry, rx + rw, ry, rx + rw, ry + rh, rx, ry + rh]];
      }
      for (const sp of sps) {
        if (sp.length < 2) continue;
        const b = boxOf(applyMatrix(sp, m));
        b.absolute = sp.absolute !== false;
        out.push(b);
      }
    });
    return out;
  }

  function area(b) {
    return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
  }

  function overlapArea(a, b) {
    const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /**
   * Merge subpaths into glyphs. Two subpaths belong to the same glyph when
   * they overlap substantially (holes, multi-part outlines). Relative "m"
   * subpaths continue the preceding glyph in MuseScore's output, which also
   * keeps things like the dots of an F clef with their clef.
   */
  function clusterGlyphs(sps, minOverlap = 0.35) {
    const n = sps.length;
    const parent = Array.from({ length: n }, (_, k) => k);
    const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

    for (let a = 0; a < n; a++) {
      if (!sps[a].absolute && a > 0) union(a - 1, a);
    }
    const order = Array.from({ length: n }, (_, k) => k).sort((p, q) => sps[p].minX - sps[q].minX);
    for (let oi = 0; oi < n; oi++) {
      const a = sps[order[oi]];
      const aa = area(a);
      for (let oj = oi + 1; oj < n; oj++) {
        const b = sps[order[oj]];
        if (b.minX > a.maxX) break;
        const ov = overlapArea(a, b);
        if (!ov) continue;
        const small = Math.min(aa, area(b));
        if (small === 0 || ov >= minOverlap * small) union(order[oi], order[oj]);
      }
    }
    const groups = new Map();
    for (let k = 0; k < n; k++) {
      const r = find(k);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(sps[k]);
    }
    const glyphs = [];
    for (const parts of groups.values()) {
      const g = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, parts };
      for (const p of parts) {
        g.minX = Math.min(g.minX, p.minX); g.minY = Math.min(g.minY, p.minY);
        g.maxX = Math.max(g.maxX, p.maxX); g.maxY = Math.max(g.maxY, p.maxY);
      }
      g.w = g.maxX - g.minX; g.h = g.maxY - g.minY;
      g.cx = (g.minX + g.maxX) / 2; g.cy = (g.minY + g.maxY) / 2;
      glyphs.push(g);
    }
    return glyphs;
  }

  // ------------------------------------------------------------------ staves

  function findStaves(doc) {
    const lines = subpathsOf(doc, 'StaffLines')
      .filter((b) => b.maxX - b.minX > 0 && b.maxY - b.minY < (b.maxX - b.minX) * 0.02)
      .map((b) => ({ y: (b.minY + b.maxY) / 2, x1: b.minX, x2: b.maxX }));

    // Group lines that share the same horizontal extent (= same system).
    const buckets = new Map();
    for (const l of lines) {
      const key = Math.round(l.x1 / 4) + ':' + Math.round(l.x2 / 4);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(l);
    }

    const staves = [];
    for (const group of buckets.values()) {
      group.sort((a, b) => a.y - b.y);
      const ys = [];
      for (const l of group) if (!ys.length || l.y - ys[ys.length - 1].y > 0.5) ys.push(l);
      const same = (g1, g2) => Math.abs(g1 - g2) <= Math.max(g1, g2) * 0.1;
      let k = 0;
      while (k + 4 < ys.length) {
        const g0 = ys[k + 1].y - ys[k].y;
        let n = 1;
        while (k + n < ys.length && same(ys[k + n].y - ys[k + n - 1].y, g0)) n++;
        // n = number of equally spaced lines starting at k
        if (n === 5) {
          const run = ys.slice(k, k + 5);
          staves.push({
            top: run[0].y, bottom: run[4].y, sp: (run[4].y - run[0].y) / 4,
            x1: Math.min(...run.map((l) => l.x1)), x2: Math.max(...run.map((l) => l.x2)),
          });
          k += 5;
        } else {
          k += Math.max(1, n === 1 ? 1 : n); // skip 1-4 line runs and 6+ line (tab) staves
        }
      }
    }
    staves.sort((a, b) => a.top - b.top || a.x1 - b.x1);
    staves.forEach((s, k) => (s.index = k));
    return staves;
  }

  /** Nearest staff (vertically) whose horizontal span contains x. */
  function staffFor(staves, x, y, maxDistSp) {
    let best = null, bestD = Infinity;
    for (const s of staves) {
      if (x < s.x1 - 2 * s.sp || x > s.x2 + 2 * s.sp) continue;
      const d = y < s.top ? s.top - y : y > s.bottom ? y - s.bottom : 0;
      if (d < bestD && d <= maxDistSp * s.sp) { best = s; bestD = d; }
    }
    return best;
  }

  // ------------------------------------------------------------------- clefs

  // Diatonic index (octave*7 + letter, C=0) of the top staff line per clef.
  const CLEF_TOP_LINE = {
    treble: 38,      // F5
    'treble-8vb': 31,
    'treble-8va': 45,
    bass: 26,        // A3
    'bass-8vb': 19,
    'bass-8va': 33,
    alto: 32,        // G4
    tenor: 30,       // E4
    soprano: 33,     // A4  (C on bottom line)
    mezzo: 31,       // F4
    baritone: 28,    // C4  (C on top line)
    percussion: null,
  };

  function classifyClef(g, staff, tinyNeighbours) {
    const sp = staff.sp;
    const top = (g.minY - staff.top) / sp; // in staff spaces, 0 = top line
    const bottom = (g.minY + g.h - staff.top) / sp;
    const h = g.h / sp;
    const w = g.w / sp;

    if (h >= 4.6) {
      // G clef (spans well beyond the staff). Octave marks add height.
      if (bottom > 6.9 && top > -2.8) return 'treble-8vb';
      if (top < -2.9 && bottom < 6.8) return 'treble-8va';
      return 'treble';
    }
    if (h < 2.2 && w < 1.6 && top > 0.7) return 'percussion';

    // F clef: body hangs from the top line and has two dots to its right.
    const hasDots = tinyNeighbours.some(
      (t) => t.minX >= g.maxX - 0.3 * sp && t.minX - g.maxX < 1.2 * sp && Math.abs(t.cy - g.minY) < 2.2 * sp
    ) || g.parts.some((p) => (p.maxX - p.minX) < 0.6 * sp && (p.maxY - p.minY) < 0.6 * sp && p.minX > g.minX + g.w * 0.6);
    const center = (top + bottom) / 2;

    if (hasDots && h < 4.2) {
      // The F-clef's reference line passes between the two dots (~1 space
      // below its top). Normally this is the 4th line from the bottom.
      const fLine = Math.round(top + 1);
      if (bottom > 4.2) return 'bass-8vb';
      if (top < -1.3) return 'bass-8va';
      if (fLine === 2) return 'baritone';
      return 'bass';
    }
    // C clef: symmetric around the line it marks.
    const cLine = Math.round(center); // 0..4 from the top
    switch (cLine) {
      case 4: return 'soprano';
      case 3: return 'mezzo';
      case 2: return 'alto';
      case 1: return 'tenor';
      case 0: return 'baritone';
      default: return 'treble';
    }
  }

  // ------------------------------------------------------------- accidentals

  function glyphFromParts(parts) {
    const g = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, parts };
    for (const p of parts) {
      g.minX = Math.min(g.minX, p.minX); g.minY = Math.min(g.minY, p.minY);
      g.maxX = Math.max(g.maxX, p.maxX); g.maxY = Math.max(g.maxY, p.maxY);
    }
    g.w = g.maxX - g.minX; g.h = g.maxY - g.minY;
    g.cx = (g.minX + g.maxX) / 2; g.cy = (g.minY + g.maxY) / 2;
    return g;
  }

  /** Shape of a single (non-compound) accidental. */
  function classifySimple(g, sp) {
    const w = g.w / sp, h = g.h / sp;
    if (w < 0.45) return null;                 // parenthesis / bracket
    if (h < 1.5) return w > 0.6 ? 'dsharp' : null;

    const occ = (y0, y1, x0, x1) => {
      for (const p of g.parts) {
        const pts = p.pts;
        for (let k = 0; k < pts.length; k += 2) {
          const fx = (pts[k] - g.minX) / g.w, fy = (pts[k + 1] - g.minY) / g.h;
          if (fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1) return true;
        }
      }
      return false;
    };
    const topRight = occ(0, 0.2, 0.62, 1);
    const bottomLeft = occ(0.8, 1, 0, 0.38);
    const bottomRight = occ(0.8, 1, 0.62, 1);
    if (topRight && bottomLeft) return 'sharp';
    if (!topRight && bottomLeft && bottomRight) return 'flat';
    if (!topRight && !bottomLeft) return 'natural';
    if (topRight && !bottomLeft) return 'natural'; // mirrored-looking natural
    return bottomLeft ? 'flat' : 'natural';
  }

  /** Vertical reference point (staff position) of a simple accidental. */
  function refY(g, type) {
    if (type === 'flat' || type === 'dflat') return g.maxY - 0.285 * g.h;
    return g.cy;
  }

  /**
   * Classify an accidental glyph by which parts of its bounding box contain
   * outline points. Wide glyphs are compounds (double flat, natural-sharp,
   * natural-flat): each half is classified separately.
   * Returns {type, refY} with type sharp | flat | natural | dsharp | dflat,
   * or null for parentheses and other non-accidentals.
   */
  function classifyAccidental(g, sp) {
    if (g.w / sp > 1.25 && g.h / sp >= 1.5) {
      const left = g.parts.filter((p) => (p.minX + p.maxX) / 2 < g.cx);
      const right = g.parts.filter((p) => (p.minX + p.maxX) / 2 >= g.cx);
      if (left.length && right.length) {
        const lg = glyphFromParts(left), rg = glyphFromParts(right);
        const lt = classifySimple(lg, sp), rt = classifySimple(rg, sp);
        if (lt === 'flat' && rt === 'flat') return { type: 'dflat', refY: refY(rg, 'flat') };
        if (lt === 'natural' && rt) return { type: rt, refY: refY(rg, rt) };   // ♮♯ / ♮♭
        if (rt === 'natural' && lt) return { type: lt, refY: refY(lg, lt) };
        if (lt === 'sharp' && rt === 'sharp') return { type: 'dsharp', refY: g.cy };
      }
      return { type: 'dflat', refY: refY(g, 'dflat') };
    }
    const type = classifySimple(g, sp);
    return type ? { type, refY: refY(g, type) } : null;
  }

  const ALTER = { sharp: 1, flat: -1, natural: 0, dsharp: 2, dflat: -2 };

  // ------------------------------------------------------------------ main

  function analyze(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.localName !== 'svg') throw new Error('Not an SVG document');

    let viewBox = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (viewBox.length !== 4 || viewBox.some(isNaN)) {
      viewBox = [0, 0, parseFloat(svg.getAttribute('width')) || 0, parseFloat(svg.getAttribute('height')) || 0];
    }

    const staves = findStaves(doc);
    const result = { viewBox, staves, notes: [] };
    if (!staves.length) return result;

    const perStaff = (glyphs, maxDist) => {
      const map = new Map();
      for (const g of glyphs) {
        const s = staffFor(staves, g.cx, g.cy, maxDist);
        if (!s) continue;
        if (!map.has(s)) map.set(s, []);
        map.get(s).push(g);
      }
      for (const arr of map.values()) arr.sort((a, b) => a.cx - b.cx);
      return map;
    };

    // --- clefs
    const clefGlyphs = clusterGlyphs(subpathsOf(doc, 'Clef'));
    const clefsByStaff = perStaff(clefGlyphs, 4);
    const clefs = new Map(); // staff -> [{x, type}]
    for (const [s, gs] of clefsByStaff) {
      const tiny = gs.filter((g) => g.h < 0.7 * s.sp && g.w < 0.7 * s.sp);
      const list = [];
      for (const g of gs) {
        if (g.h < 0.7 * s.sp) continue;
        list.push({ x: g.minX, type: classifyClef(g, s, tiny) });
      }
      clefs.set(s, list);
      s.clefs = list;
    }
    const clefAt = (s, x) => {
      const list = clefs.get(s) || [];
      let c = list.length ? list[0].type : 'treble';
      for (const e of list) if (e.x <= x) c = e.type;
      return c;
    };
    const diatonicAt = (s, x, y) => {
      const clef = clefAt(s, x);
      const top = CLEF_TOP_LINE[clef];
      if (top == null) return null;
      const step = Math.round((y - s.top) / (s.sp / 2));
      return { d: top - step, clef, step };
    };

    // --- barlines (per staff, x positions)
    const barGlyphs = subpathsOf(doc, 'BarLine').filter((b) => b.maxY - b.minY > 0);
    const bars = new Map();
    for (const s of staves) {
      const xs = barGlyphs
        .filter((b) => b.maxY - b.minY >= 2.5 * s.sp && b.minY <= s.top + s.sp && b.maxY >= s.bottom - s.sp &&
          b.minX >= s.x1 - s.sp && b.maxX <= s.x2 + s.sp)
        .map((b) => (b.minX + b.maxX) / 2)
        .sort((a, b) => a - b);
      bars.set(s, xs);
    }
    const measureAt = (s, x) => {
      const xs = bars.get(s) || [];
      let m = 0;
      for (const bx of xs) if (bx < x) m++;
      return m;
    };

    // --- key signatures
    const keyGlyphs = clusterGlyphs(subpathsOf(doc, 'KeySig'), 0.9);
    const keysByStaff = perStaff(keyGlyphs, 3);
    const keys = new Map(); // staff -> [{x, alter: {letter: n}}]
    for (const [s, gs] of keysByStaff) {
      const blocks = [];
      let block = null;
      for (const g of gs) {
        if (!block || g.minX - block.maxX > 1.0 * s.sp) {
          block = { x: g.minX, maxX: g.maxX, glyphs: [] };
          blocks.push(block);
        }
        block.glyphs.push(g);
        block.maxX = Math.max(block.maxX, g.maxX);
      }
      const list = [];
      for (const b of blocks) {
        const alter = {};
        for (const g of b.glyphs) {
          const acc = classifyAccidental(g, s.sp);
          if (!acc || acc.type === 'natural') continue;
          const type = acc.type;
          const pos = diatonicAt(s, g.cx, acc.refY);
          if (!pos) continue;
          alter[((pos.d % 7) + 7) % 7] = ALTER[type];
        }
        list.push({ x: b.x, alter });
      }
      keys.set(s, list);
      s.keys = list;
    }
    const keyAt = (s, x) => {
      let k = {};
      for (const e of keys.get(s) || []) if (e.x <= x) k = e.alter;
      return k;
    };

    // --- ledger lines (used to decide which staff a far-off note belongs to)
    const ledgers = subpathsOf(doc, 'LedgerLine')
      .filter((b) => b.maxX - b.minX > 0)
      .map((b) => ({ y: (b.minY + b.maxY) / 2, x1: b.minX, x2: b.maxX }));
    const hasLedger = (x, y, sp) =>
      ledgers.some((l) => Math.abs(l.y - y) < 0.3 * sp && l.x1 - 0.2 * sp <= x && l.x2 + 0.2 * sp >= x);

    /**
     * Staff for a notehead. Notes inside (or just outside) a staff are easy.
     * A note further out needs ledger lines, and the first ledger line next to
     * its own staff must exist under/over it - which disambiguates notes
     * written between the two staves of a grand staff.
     */
    const noteStaff = (g) => {
      const cands = [];
      for (const s of staves) {
        if (g.cx < s.x1 - s.sp || g.cx > s.x2 + s.sp) continue;
        const d = g.cy < s.top ? s.top - g.cy : g.cy > s.bottom ? g.cy - s.bottom : 0;
        if (d > 12 * s.sp) continue;
        let ok = true;
        if (d > 0.8 * s.sp) {
          const ly = g.cy < s.top ? s.top - s.sp : s.bottom + s.sp;
          ok = hasLedger(g.cx, ly, s.sp);
        }
        cands.push({ s, d, ok });
      }
      if (!cands.length) return null;
      cands.sort((a, b) => (b.ok - a.ok) || a.d - b.d);
      return cands[0].s;
    };

    // --- noteheads
    const noteGlyphs = clusterGlyphs(subpathsOf(doc, 'Note'), 0.5);
    const allNotes = [];
    const stats = (result.stats = { noteGlyphs: noteGlyphs.length, unplacedNotes: [], accidentals: 0, unattachedAcc: [] });
    for (const g of noteGlyphs) {
      const s = noteStaff(g);
      if (!s) { stats.unplacedNotes.push({ x: g.minX, y: g.minY, why: 'no staff' }); continue; }
      if (!(g.w > 0.5 * s.sp && g.w < 3 * s.sp && g.h > 0.4 * s.sp && g.h < 2 * s.sp)) {
        stats.unplacedNotes.push({ x: g.minX, y: g.minY, w: g.w / s.sp, h: g.h / s.sp, why: 'size' });
        continue;
      }
      const pos = diatonicAt(s, g.cx, g.cy);
      if (!pos) continue;
      allNotes.push({ g, staff: s, pos, acc: null, alter: 0 });
    }

    // --- accidentals: attach each to the best matching notehead to its right
    const accGlyphs = clusterGlyphs(subpathsOf(doc, 'Accidental'), 0.9);
    for (const a of accGlyphs) {
      const near = staffFor(staves, a.cx, a.cy, 12);
      if (!near) continue;
      const sp = near.sp;
      const acc = classifyAccidental(a, sp);
      if (!acc) continue;
      const type = acc.type, ay = acc.refY;
      let best = null, bestScore = Infinity;
      for (const n of allNotes) {
        const dx = n.g.minX - a.maxX;
        if (dx < -0.4 * sp || dx > 6 * sp) continue;
        const dy = Math.abs(n.g.cy - ay) / (sp / 2);
        if (dy > 1.2) continue;
        const score = dy * 3 + dx / sp;
        if (score < bestScore) { bestScore = score; best = n; }
      }
      stats.accidentals++;
      if (!best) stats.unattachedAcc.push({ x: a.minX, y: a.minY, type });
      if (best && (!best.acc || bestScore < best.accScore)) {
        best.acc = type;
        best.accScore = bestScore;
      }
    }

    // --- ties: a tied note inherits the alteration of the note it continues
    const ties = clusterGlyphs(['Tie', 'TieSegment', 'SlurSegment'].flatMap((c) => subpathsOf(doc, c)), 0.9)
      .filter((t) => t.w > t.h);

    for (const s of staves) {
      const notes = allNotes.filter((n) => n.staff === s);
      if (!notes.length) continue;

      // Resolve alterations left to right, measure by measure.
      notes.sort((p, q) => p.g.cx - q.g.cx);
      const state = new Map(); // `${measure}:${d}` -> alter
      for (const n of notes) {
        const m = measureAt(s, n.g.cx);
        const key = m + ':' + n.pos.d;
        let tiedFrom = null;
        if (!n.acc && !state.has(key)) {
          const tie = ties.find((t) => Math.abs(t.maxX - n.g.minX) < 1.2 * s.sp && Math.abs(t.cy - n.g.cy) < 1.5 * s.sp);
          if (tie) {
            tiedFrom = notes.find((p) => p !== n && p.pos.d === n.pos.d && p.done &&
              Math.abs(p.g.maxX - tie.minX) < 1.2 * s.sp && Math.abs(p.g.cy - n.g.cy) < 0.3 * s.sp);
          }
        }
        if (n.acc) {
          n.alter = ALTER[n.acc];
          state.set(key, n.alter);
        } else if (state.has(key)) {
          n.alter = state.get(key);
        } else if (tiedFrom) {
          n.alter = tiedFrom.alter;
        } else {
          const ks = keyAt(s, n.g.cx);
          n.alter = ks[((n.pos.d % 7) + 7) % 7] || 0;
        }
        n.done = true;
        const d = n.pos.d;
        result.notes.push({
          x: n.g.minX, y: n.g.minY, w: n.g.w, h: n.g.h, cx: n.g.cx, cy: n.g.cy,
          staff: s.index, sp: s.sp,
          letter: ((d % 7) + 7) % 7, octave: Math.floor(d / 7),
          alter: n.alter, explicit: !!n.acc, clef: n.pos.clef, measure: m,
        });
      }
    }
    return result;
  }

  global.MSNN = global.MSNN || {};
  Object.assign(global.MSNN, { analyze, _internals: { parsePathData, clusterGlyphs, classifyAccidental, findStaves, subpathsOf } });
})(typeof window !== 'undefined' ? window : globalThis);
