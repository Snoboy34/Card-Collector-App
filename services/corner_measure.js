/**
 * services/corner_measure.js
 *
 * Corner cut on one flatbed scan, in millimetres. This file does not read
 * the centering answer key, does not score a phone photo, and does not
 * assign a 0–10 grade.
 *
 * The cut is the two edge lines already found for centering. Rounding is
 * the arc past those lines, beyond the 10–90% paper-to-card rise. Whitening
 * is paper showing against the same border at mid-edge. A ding is a local
 * notch in the cut. Fraying is card-colored fiber outside the cut.
 *
 * A single scan does not publish. pairReadings() keeps a result only when
 * the upright scan and the 180° scan agree. A setback inside the scanner
 * limit is the result "sharp", with that limit stated. Radius 0 is never published.
 */
'use strict';

const ADJACENT = {
  tl: ['top', 'left'],
  tr: ['top', 'right'],
  br: ['bottom', 'right'],
  bl: ['bottom', 'left']
};

const FROM_180 = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };

const EXCLUDED_IDS = { 'TD-12': true, LAPORTA: true };
const PENDING_WORN = [];
const WORN_SET = {
  'TD-14': { role: 'worn', name: 'Kugler', note: 'Whitening on red corners.' },
  'TD-15': { role: 'worn', name: 'Jurgensen', note: 'Rounded and frayed corners.' },
  'TD-16': { role: 'worn', name: 'Hatcher', note: 'Off-center. Two hurt corners. Lower-left whitening. Left and bottom border whitening on a black border.' },
  'TD-17': { role: 'worn', name: 'Little', note: 'Soft corners. Crooked print.' },
  'TD-18': { role: 'control', name: 'Speed Racer', note: 'Clean non-sports control.' },
  'TD-19': { role: 'worn', name: 'Dawsey', note: 'Four bad corners. Ding and wrinkle in the top border. Poor left and top edges.' },
  'TD-20': { role: 'worn', name: 'Jones', note: 'Off-center. Chipping, creases, and heavy surface wear.' },
  'TD-21': { role: 'control', name: 'Esiason', note: 'Clean sports control. Striped green border.' }
};
const BACK_IDS = [
  'TD-01', 'TD-02', 'TD-03', 'TD-04', 'TD-05', 'TD-06',
  'TD-07', 'TD-08', 'TD-09', 'TD-10', 'TD-11', 'KARROS'
];

const BGS_REFERENCE = {
  approved: false,
  role: 'reference-only',
  inAnswerKey: false,
  measured: false,
  onlySlabs: true,
  orderCheck: {
    rule: 'Once a corner method exists, a corners 9.5 should not measure worse than a corners 9.',
    higher: { player: 'Jerry Rice', corners: 9.5, cert: '0000640358' },
    lower: { player: 'Reggie Bush', corners: 9, cert: '0005205494' },
    families: 'White-border Score and foil Momentum. This pair is an order check. It does not set a millimetre scale.'
  },
  calibrationProposal: {
    approved: false,
    rawCards: 6,
    note: 'After the worn fronts exist and the owner has approved the overlays, submit six raw cards: TD-01 and Karros (sharp on all four corners), TD-02 (a fitted radius on one orientation), and three worn cards that carry a soft corner, a ding, and fraying. The first six stay with those white-border and worn cards. Foil, the halftone Pokémon card, and the full-bleed card wait. If the six corner subgrades fall on one half-point, stop.'
  },
  slabs: [
    {
      player: 'Reggie Bush',
      year: 2006,
      set: 'Score',
      number: '360',
      overall: 9,
      label: 'Mint',
      centering: 9.5,
      corners: 9,
      edges: 9,
      surface: 10,
      cert: '0005205494',
      family: 'white-border Score'
    },
    {
      player: 'Jerry Rice',
      year: 2000,
      set: 'Playoff Momentum Graded Series',
      number: '78',
      serial: '1 of 210',
      overall: 8.5,
      label: 'NM-MT+',
      centering: 8.5,
      corners: 9.5,
      edges: 9,
      surface: 8.5,
      cert: '0000640358',
      family: 'foil Momentum'
    }
  ]
};

const PAIR_MM = 0.1;
const FRAY_PAIR_MM = 0.3;
const FRAY_MIN_MM = 0.3;
const DING_MIN_MM = 0.15;
const WHITE_LUMA = 230;
const PAPER_CLOSE = 25;
const GREY_SEP = 18;
const ARC_GATE_MM = 0.1;
const WINDOW_MM = 2.5;
const STATION_MM = 0.05;

const DEFINITION = [
  'A corner is the cut, where two card edges meet. It is not the printed frame.',
  'Rounding is the arc past the measured 10–90% edge rise. The radius comes from the tip setback and from a circle fit to the silhouette. They must agree within 0.1 mm, and the upright and 180° scans must agree within 0.1 mm. A setback inside the scanner limit is a result, reported as sharp with that limit stated. The limit is the larger 10–90% rise of the two edges at that corner. Radius 0 is not published.',
  'Whitening is paper showing against the same border at mid-edge. Whitening on a border that is already paper-white is not applicable. A pale patch that is foil glare is withheld.',
  'A ding is a local notch in the cut. It is withheld when only one orientation shows it.',
  'Fraying is card-colored fiber outside the fitted cut. It is withheld when it does not rotate with the card. Length 0 is published only when both orientations are clean.',
  'A side the centering key has withheld does not grow a corner grade.',
  'TD-12 is excluded. TD-14 through TD-21 are an unapproved worn and control review. TD-18 and TD-21 are the clean controls. Flatbed backs of TD-01 through TD-11 and Karros are a separate unapproved corner review. The two BGS slabs are reference labels only. They stay sealed, stay out of the answer key, and are an order check between corners 9.5 and corners 9.',
  'A disagreement between the two orientations, a quad that is not card-sized, or an unclear step stays withheld.',
  'Unapproved until the owner checks the overlay. No 0–10 corner score is assigned. This review does not change grading.'
].join(' ');

function pxPerMm(dpi) {
  return dpi / 25.4;
}

function roundMm(v) {
  if (v == null || !isFinite(v)) return null;
  return Math.round(v * 1000) / 1000;
}

function sharpLabel(limitMm) {
  return 'sharp: setback under ' + limitMm.toFixed(3) + ' mm (scanner limit)';
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function unit(x, y) {
  const h = Math.hypot(x, y) || 1;
  return { x: x / h, y: y / h };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function colorDist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function sampleRgb(data, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = (y0 * w + x0) * 3;
  const i10 = (y0 * w + x1) * 3;
  const i01 = (y1 * w + x0) * 3;
  const i11 = (y1 * w + x1) * 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v0 = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const v1 = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[c] = v0 * (1 - ty) + v1 * ty;
  }
  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)];
}

function medianRgb(samples) {
  return [0, 1, 2].map(function (c) {
    return median(samples.map(function (s) { return s.rgb[c]; }));
  });
}

function isCornerCard(id) {
  if (!id) return false;
  const name = String(id).trim().toUpperCase();
  if (!name || name.indexOf('SHADOW') !== -1) return false;
  if (EXCLUDED_IDS[name]) return false;
  return true;
}

function profile(ctx, origin, dir, fromMm, toMm, stepMm) {
  const ppm = ctx.ppm;
  const out = [];
  for (let d = fromMm; d <= toMm + 1e-9; d += stepMm) {
    const rgb = sampleRgb(
      ctx.data, ctx.width, ctx.height,
      origin.x + dir.x * d * ppm,
      origin.y + dir.y * d * ppm
    );
    if (!rgb) continue;
    out.push({ d: d, dist: colorDist(rgb, ctx.paper), rgb: rgb });
  }
  return out;
}

function crossing(samples, target) {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.dist < target && b.dist >= target) {
      const span = b.dist - a.dist || 1;
      const f = (target - a.dist) / span;
      return a.d + (b.d - a.d) * f;
    }
  }
  return null;
}

function medianFilter(samples, radius) {
  return samples.map(function (sample, index) {
    const window = [];
    for (let k = index - radius; k <= index + radius; k++) {
      if (k >= 0 && k < samples.length) window.push(samples[k].dist);
    }
    return { d: sample.d, dist: median(window), rgb: sample.rgb };
  });
}

function measureRise(ctx, edge) {
  const n = unit(edge.nx, edge.ny);
  const origin = {
    x: (edge.a.x + edge.b.x) / 2,
    y: (edge.a.y + edge.b.y) / 2
  };
  const raw = profile(ctx, origin, n, -1.0, 1.6, 0.01);
  const inside = raw.filter(function (s) { return s.d >= 0.85 && s.d <= 1.5; });
  if (raw.length < 20 || inside.length < 4) return { ok: false, reason: 'weak-edge' };
  const smooth = medianFilter(raw, 1);
  let bestI = -1;
  let bestG = 0;
  const half = 4;
  for (let i = half; i < smooth.length - half; i++) {
    if (smooth[i].d < -0.45 || smooth[i].d > 0.55) continue;
    const g = smooth[i + half].dist - smooth[i - half].dist;
    if (g > bestG) {
      bestG = g;
      bestI = i;
    }
  }
  if (bestI < 0 || bestG < 18) return { ok: false, reason: 'weak-edge' };
  const center = smooth[bestI].d;
  const foot = smooth.filter(function (s) { return s.d >= center - 0.45 && s.d <= center - 0.14; });
  const head = smooth.filter(function (s) { return s.d >= center + 0.04 && s.d <= center + 0.28; });
  if (foot.length < 4 || head.length < 3) return { ok: false, reason: 'weak-edge' };
  const footDist = median(foot.map(function (s) { return s.dist; }));
  const headSorted = head.map(function (s) { return s.dist; }).sort(function (a, b) { return a - b; });
  const headDist = headSorted[Math.min(headSorted.length - 1, Math.ceil(headSorted.length * 0.75))];
  if (!(headDist > footDist + 18)) return { ok: false, reason: 'weak-edge' };
  const span = headDist - footDist;
  const local = smooth.filter(function (s) { return s.d >= center - 0.45 && s.d <= center + 0.40; });
  const p10 = crossing(local, footDist + 0.1 * span);
  const p90 = crossing(local, footDist + 0.9 * span);
  if (p10 == null || p90 == null || p90 <= p10) return { ok: false, reason: 'weak-edge' };
  return {
    ok: true,
    riseMm: p90 - p10,
    target: footDist + 0.5 * span,
    insideRgb: medianRgb(inside),
    outD: footDist,
    inD: headDist
  };
}

function awayDir(tip, edge) {
  const d1 = { x: edge.a.x - tip.x, y: edge.a.y - tip.y };
  const d2 = { x: edge.b.x - tip.x, y: edge.b.y - tip.y };
  const use = (d1.x * d1.x + d1.y * d1.y) >= (d2.x * d2.x + d2.y * d2.y) ? d1 : d2;
  return unit(use.x, use.y);
}

function edgeLengthMm(edge, ppm) {
  return Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y) / ppm;
}

function silhouette(ctx, tip, u, n, target) {
  const ppm = ctx.ppm;
  const pts = [];
  for (let t = STATION_MM; t <= WINDOW_MM + 1e-9; t += STATION_MM) {
    const origin = { x: tip.x + u.x * t * ppm, y: tip.y + u.y * t * ppm };
    const samples = profile(ctx, origin, n, -0.7, 1.4, 0.01);
    const hit = crossing(samples, target);
    if (hit == null) continue;
    pts.push({
      t: t,
      inwardMm: hit,
      x: origin.x + n.x * hit * ppm,
      y: origin.y + n.y * hit * ppm
    });
  }
  return pts;
}

function medianOffset(points) {
  const far = points.filter(function (p) { return p.t >= 1.6 && p.t <= WINDOW_MM; });
  if (far.length < 4) return null;
  return median(far.map(function (p) { return p.inwardMm; }));
}

function expectedInward(t, radiusMm, tip, u, n, bisector, alpha, ppm) {
  const sinA = Math.sin(alpha);
  if (!(sinA > 0.2) || !(radiusMm > 0)) return 0;
  const tangentMm = radiusMm / Math.tan(alpha);
  if (t > tangentMm + 0.02) return 0;
  const reach = (radiusMm / sinA) * ppm;
  const ox = tip.x + bisector.x * reach;
  const oy = tip.y + bisector.y * reach;
  const px = tip.x + u.x * t * ppm;
  const py = tip.y + u.y * t * ppm;
  const vx = ox - px;
  const vy = oy - py;
  const vN = vx * n.x + vy * n.y;
  const tang2 = Math.max(0, vx * vx + vy * vy - vN * vN);
  const rPx = radiusMm * ppm;
  if (tang2 > rPx * rPx) return 0;
  const dPx = vN - Math.sqrt(rPx * rPx - tang2);
  const dMm = dPx / ppm;
  if (dMm < -0.02) return 0;
  return Math.max(0, dMm);
}

function fitRadius(edges, tip, bisector, alpha, ppm, riseGate) {
  let best = null;
  for (let radius = 0.05; radius <= 3.0001; radius += 0.005) {
    const windowMm = radius / Math.tan(alpha) + 0.4;
    let acc = 0;
    let n = 0;
    let arcN = 0;
    let bowed = false;
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      for (let i = 0; i < edge.points.length; i++) {
        const p = edge.points[i];
        if (p.t < 0.05) continue;
        if (p.t > windowMm && p.t < 2.2 && Math.abs(p.corrected) > Math.max(riseGate, 0.08)) bowed = true;
        if (p.t > windowMm) continue;
        const exp = expectedInward(p.t, radius, tip, edge.u, edge.n, bisector, alpha, ppm);
        const err = p.corrected - exp;
        acc += err * err;
        n += 1;
        if (exp > riseGate) arcN += 1;
      }
    }
    if (bowed || n < 6 || arcN < 4) continue;
    const rms = Math.sqrt(acc / n);
    if (!best || rms < best.residualMm) best = { radiusMm: radius, residualMm: rms, arcN: arcN };
  }
  return best;
}

function lineShiftAlongBisector(nA, nB, bisector, offA, offB) {
  const d = dot(nA, nB);
  const det = 1 - d * d;
  if (Math.abs(det) < 1e-4) return (offA + offB) / 2;
  const a = (offA - d * offB) / det;
  const b = (offB - d * offA) / det;
  return (a * nA.x + b * nB.x) * bisector.x + (a * nA.y + b * nB.y) * bisector.y;
}

function localDing(points, tip, u, n, bisector, alpha, ppm, radiusMm) {
  let best = null;
  const rows = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.t < 0.15 || p.t > 2.4) continue;
    const exp = radiusMm
      ? expectedInward(p.t, radiusMm, tip, u, n, bisector, alpha, ppm)
      : 0;
    rows.push({ t: p.t, excess: p.corrected - exp });
  }
  for (let i = 0; i < rows.length; i++) {
    const peak = rows[i];
    if (peak.excess < DING_MIN_MM) continue;
    let left = false;
    let right = false;
    for (let j = 0; j < rows.length; j++) {
      const dt = rows[j].t - peak.t;
      if (dt <= -0.12 && dt >= -0.9 && rows[j].excess <= peak.excess * 0.45) left = true;
      if (dt >= 0.12 && dt <= 0.9 && rows[j].excess <= peak.excess * 0.45) right = true;
    }
    if (left && right && (!best || peak.excess > best.depthMm)) {
      best = { depthMm: peak.excess, fromTipMm: peak.t };
    }
  }
  return best;
}

function frayOnEdge(ctx, tip, u, n, insideRgb) {
  const ppm = ctx.ppm;
  const insideDist = colorDist(insideRgb, ctx.paper);
  if (!(insideDist > 20)) return { lengthMm: 0, stickOutMm: 0 };
  const hits = [];
  for (let t = 0; t <= WINDOW_MM + 1e-9; t += STATION_MM) {
    let stick = 0;
    let hit = false;
    for (let out = 0.05; out <= 0.7 + 1e-9; out += 0.05) {
      const rgb = sampleRgb(
        ctx.data, ctx.width, ctx.height,
        tip.x + u.x * t * ppm - n.x * out * ppm,
        tip.y + u.y * t * ppm - n.y * out * ppm
      );
      if (!rgb) continue;
      const dp = colorDist(rgb, ctx.paper);
      const di = colorDist(rgb, insideRgb);
      if (di < dp && dp > insideDist * 0.45) {
        hit = true;
        if (out > stick) stick = out;
      }
    }
    hits.push({ t: t, hit: hit, stick: stick });
  }
  let best = null;
  let runStart = null;
  let runStick = 0;
  function close(endT) {
    if (runStart == null) return;
    const length = endT - runStart;
    if (length + 1e-6 >= FRAY_MIN_MM && (!best || length > best.lengthMm)) {
      best = { lengthMm: length, stickOutMm: runStick };
    }
    runStart = null;
    runStick = 0;
  }
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].hit) {
      if (runStart == null) runStart = hits[i].t;
      if (hits[i].stick > runStick) runStick = hits[i].stick;
    } else if (runStart != null) {
      close(hits[i - 1].t + STATION_MM);
    }
  }
  if (runStart != null && hits.length) close(hits[hits.length - 1].t + STATION_MM);
  return best || { lengthMm: 0, stickOutMm: 0 };
}

function sampleAt(ctx, tip, u, n, tMm, depthMm) {
  const ppm = ctx.ppm;
  return sampleRgb(
    ctx.data, ctx.width, ctx.height,
    tip.x + u.x * tMm * ppm + n.x * depthMm * ppm,
    tip.y + u.y * tMm * ppm + n.y * depthMm * ppm
  );
}

function midBorder(ctx, tip, u, n, edgeLenMm) {
  const t = edgeLenMm > 28 ? 20 : Math.max(4, edgeLenMm * 0.35);
  const found = [];
  for (let depth = 0.4; depth <= 1.2 + 1e-9; depth += 0.08) {
    for (let dt = -0.4; dt <= 0.4 + 1e-9; dt += 0.1) {
      const rgb = sampleAt(ctx, tip, u, n, t + dt, depth);
      if (rgb) found.push({ rgb: rgb });
    }
  }
  if (found.length < 8) return null;
  const rgb = medianRgb(found);
  const lumas = found.map(function (s) { return luma(s.rgb); });
  const med = median(lumas);
  const dev = median(lumas.map(function (v) { return Math.abs(v - med); })) || 0;
  return {
    rgb: rgb,
    luma: med,
    spread: dev,
    distPaper: colorDist(rgb, ctx.paper)
  };
}

function whitening(ctx, tip, edges, paperLuma) {
  const mids = [];
  for (let i = 0; i < edges.length; i++) {
    const mid = midBorder(ctx, tip, edges[i].u, edges[i].n, edges[i].lengthMm);
    if (!mid) return { withheld: true, reason: 'weak-edge', lengthMm: null, areaMm2: null };
    mids.push(mid);
  }
  const lumaMid = median(mids.map(function (m) { return m.luma; }));
  const spread = Math.max(mids[0].spread, mids[1].spread);
  const distPaper = Math.min(mids[0].distPaper, mids[1].distPaper);
  const ref = mids[0].distPaper <= mids[1].distPaper ? mids[0] : mids[1];
  if (lumaMid >= WHITE_LUMA || distPaper < PAPER_CLOSE) {
    return {
      withheld: true,
      reason: 'white-border',
      label: 'not applicable',
      lengthMm: null,
      areaMm2: null,
      midLuma: roundMm(lumaMid)
    };
  }
  if (spread > 22) {
    return { withheld: true, reason: 'no-solid-border', lengthMm: null, areaMm2: null, midLuma: roundMm(lumaMid) };
  }
  const step = 0.08;
  let pale = 0;
  let glare = 0;
  const spans = [null, null];
  for (let e = 0; e < edges.length; e++) {
    const otherN = edges[1 - e].n;
    let lo = null;
    let hi = null;
    for (let t = 0; t <= 1.2 + 1e-9; t += step) {
      let stationPale = false;
      for (let depth = 0.4; depth <= 1.2 + 1e-9; depth += step) {
        const u = edges[e].u;
        const n = edges[e].n;
        const insideOther = t * (u.x * otherN.x + u.y * otherN.y) + depth * (n.x * otherN.x + n.y * otherN.y);
        if (insideOther < 0.35) continue;
        const rgb = sampleAt(ctx, tip, u, n, t, depth);
        if (!rgb) continue;
        const y = luma(rgb);
        const dp = colorDist(rgb, ctx.paper);
        const specular = y >= Math.max(paperLuma + 20, 242);
        const paler = y >= lumaMid + GREY_SEP && dp < ref.distPaper - 10;
        if (specular && paler) {
          glare += 1;
          continue;
        }
        if (!paler) continue;
        pale += 1;
        stationPale = true;
      }
      if (stationPale) {
        if (lo == null) lo = t;
        hi = t;
      }
    }
    spans[e] = lo == null ? 0 : (hi - lo + step);
  }
  if (glare > pale && glare >= 4) {
    return { withheld: true, reason: 'foil-glare', lengthMm: null, areaMm2: null, midLuma: roundMm(lumaMid) };
  }
  return {
    withheld: false,
    reason: null,
    lengthMm: spans[0] + spans[1],
    areaMm2: pale * step * step,
    midLuma: roundMm(lumaMid)
  };
}

function arcPolyline(tip, bisector, edges, radiusMm, alpha, ppm) {
  if (!(radiusMm > 0)) return [];
  const sinA = Math.sin(alpha);
  const reach = (radiusMm / sinA) * ppm;
  const ox = tip.x + bisector.x * reach;
  const oy = tip.y + bisector.y * reach;
  const tan = radiusMm / Math.tan(alpha);
  const ends = edges.map(function (edge) {
    return {
      x: tip.x + edge.u.x * tan * ppm,
      y: tip.y + edge.u.y * tan * ppm
    };
  });
  const a0 = Math.atan2(ends[0].y - oy, ends[0].x - ox);
  const a1 = Math.atan2(ends[1].y - oy, ends[1].x - ox);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const pts = [];
  const steps = 18;
  const rPx = radiusMm * ppm;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + sweep * (i / steps);
    pts.push({ x: ox + Math.cos(a) * rPx, y: oy + Math.sin(a) * rPx });
  }
  return pts;
}

function blankCorner(name, reason) {
  return {
    name: name,
    adjacent: ADJACENT[name],
    withheld: true,
    reason: reason,
    tip: null,
    bisector: null,
    alphaDeg: null,
    riseMm: null,
    rounding: {
      withheld: true,
      reason: reason,
      sharp: false,
      limitMm: null,
      label: null,
      setbackMm: null,
      radiusFromSetbackMm: null,
      radiusFitMm: null,
      residualMm: null,
      radiusMm: null
    },
    whitening: { withheld: true, reason: reason, lengthMm: null, areaMm2: null },
    ding: { withheld: true, reason: reason, depthMm: null, fromTipMm: null, edge: null },
    fray: { withheld: true, reason: reason, lengthMm: null, stickOutMm: null, edge: null },
    silhouette: null,
    arc: null
  };
}

function measureCorner(ctx, name) {
  const sides = ADJACENT[name];
  const edgeA = ctx.edges[sides[0]];
  const edgeB = ctx.edges[sides[1]];
  const tip = ctx.corners[name];
  if (!edgeA || !edgeB || !tip || edgeA.nx == null || edgeB.nx == null) return blankCorner(name, 'weak-edge');
  const nA = unit(edgeA.nx, edgeA.ny);
  const nB = unit(edgeB.nx, edgeB.ny);
  const uA = awayDir(tip, edgeA);
  const uB = awayDir(tip, edgeB);
  const bisector = unit(nA.x + nB.x, nA.y + nB.y);
  const alphaA = Math.acos(clamp(dot(bisector, uA), -1, 1));
  const alphaB = Math.acos(clamp(dot(bisector, uB), -1, 1));
  const alpha = (alphaA + alphaB) / 2;
  const base = {
    name: name,
    adjacent: sides,
    tip: { x: tip.x, y: tip.y },
    bisector: bisector,
    alphaDeg: roundMm(alpha * 180 / Math.PI),
    lines: [
      { a: { x: edgeA.a.x, y: edgeA.a.y }, b: { x: edgeA.b.x, y: edgeA.b.y } },
      { a: { x: edgeB.a.x, y: edgeB.a.y }, b: { x: edgeB.b.x, y: edgeB.b.y } }
    ]
  };
  if (!isFinite(alpha) || Math.abs(alphaA - alphaB) > 10 * Math.PI / 180 || alpha < 35 * Math.PI / 180 || alpha > 55 * Math.PI / 180) {
    const bad = blankCorner(name, 'not-a-right-angle');
    bad.tip = base.tip;
    bad.bisector = bisector;
    bad.alphaDeg = base.alphaDeg;
    bad.lines = base.lines;
    return bad;
  }
  const riseA = measureRise(ctx, edgeA);
  const riseB = measureRise(ctx, edgeB);
  if (!riseA.ok || !riseB.ok) {
    const bad = blankCorner(name, 'weak-edge');
    bad.tip = base.tip;
    bad.lines = base.lines;
    return bad;
  }
  const silA = silhouette(ctx, tip, uA, nA, riseA.target);
  const silB = silhouette(ctx, tip, uB, nB, riseB.target);
  const offA = medianOffset(silA);
  const offB = medianOffset(silB);
  if (offA == null || offB == null) {
    const bad = blankCorner(name, 'weak-edge');
    bad.tip = base.tip;
    bad.lines = base.lines;
    return bad;
  }
  silA.forEach(function (p) { p.corrected = p.inwardMm - offA; });
  silB.forEach(function (p) { p.corrected = p.inwardMm - offB; });
  const bisectorSamples = profile(ctx, tip, bisector, -0.8, 2.8, 0.01);
  const rawSetback = crossing(bisectorSamples, (riseA.target + riseB.target) / 2);
  const shift = lineShiftAlongBisector(nA, nB, bisector, offA, offB);
  const setback = rawSetback == null ? null : rawSetback - shift;
  const riseGate = Math.max(riseA.riseMm, riseB.riseMm);
  const sinA = Math.sin(alpha);
  const denom = (1 / sinA) - 1;
  const rSet = setback == null ? null : setback / denom;
  let roundingReason = null;
  let sharp = false;
  let fit = null;
  const withinLimit = setback != null && setback <= riseGate && setback >= -riseGate;
  if (setback == null) roundingReason = 'weak-edge';
  else if (setback < -riseGate) roundingReason = 'unclear';
  else if (withinLimit) sharp = true;
  else {
    fit = fitRadius(
      [
        { points: silA, u: uA, n: nA },
        { points: silB, u: uB, n: nB }
      ],
      tip, bisector, alpha, ctx.ppm, riseGate
    );
    if (!fit) roundingReason = 'not-an-arc';
    else if (fit.residualMm > ARC_GATE_MM) roundingReason = 'not-an-arc';
    else if (Math.abs(fit.radiusMm - rSet) > ARC_GATE_MM) roundingReason = 'not-an-arc';
  }
  const radiusFit = fit ? fit.radiusMm : null;
  const dingA = localDing(silA, tip, uA, nA, bisector, alpha, ctx.ppm, radiusFit);
  const dingB = localDing(silB, tip, uB, nB, bisector, alpha, ctx.ppm, radiusFit);
  const ding = !dingA ? dingB : !dingB ? dingA : (dingA.depthMm >= dingB.depthMm ? dingA : dingB);
  let dingSide = null;
  if (ding) {
    if (dingA && (!dingB || dingA.depthMm >= dingB.depthMm)) dingSide = sides[0];
    else dingSide = sides[1];
  }
  const frayA = frayOnEdge(ctx, tip, uA, nA, riseA.insideRgb);
  const frayB = frayOnEdge(ctx, tip, uB, nB, riseB.insideRgb);
  const fray = frayA.lengthMm >= frayB.lengthMm ? frayA : frayB;
  const fraySide = frayA.lengthMm >= frayB.lengthMm ? sides[0] : sides[1];
  const white = whitening(
    ctx,
    tip,
    [
      { u: uA, n: nA, lengthMm: edgeLengthMm(edgeA, ctx.ppm) },
      { u: uB, n: nB, lengthMm: edgeLengthMm(edgeB, ctx.ppm) }
    ],
    luma(ctx.paper)
  );
  const limitMm = roundMm(riseGate);
  const publishedFit = roundingReason || sharp ? null : radiusFit;
  return {
    name: name,
    adjacent: sides,
    tip: base.tip,
    bisector: bisector,
    alphaDeg: base.alphaDeg,
    lines: base.lines,
    riseMm: {
      [sides[0]]: roundMm(riseA.riseMm),
      [sides[1]]: roundMm(riseB.riseMm)
    },
    rounding: sharp ? {
      withheld: false,
      reason: null,
      sharp: true,
      limitMm: limitMm,
      label: sharpLabel(limitMm),
      setbackMm: roundMm(setback),
      radiusFromSetbackMm: null,
      radiusFitMm: null,
      residualMm: null,
      radiusMm: null
    } : {
      withheld: !!roundingReason,
      reason: roundingReason,
      sharp: false,
      limitMm: limitMm,
      label: null,
      setbackMm: roundMm(setback),
      radiusFromSetbackMm: roundingReason === 'weak-edge' || roundingReason === 'unclear' ? null : roundMm(rSet),
      radiusFitMm: roundMm(radiusFit),
      residualMm: fit ? roundMm(fit.residualMm) : null,
      radiusMm: roundMm(publishedFit)
    },
    whitening: {
      withheld: white.withheld,
      reason: white.reason,
      label: white.label || null,
      lengthMm: white.withheld ? null : roundMm(white.lengthMm),
      areaMm2: white.withheld ? null : roundMm(white.areaMm2),
      midLuma: white.midLuma == null ? null : white.midLuma
    },
    ding: ding ? {
      withheld: false,
      reason: null,
      depthMm: roundMm(ding.depthMm),
      fromTipMm: roundMm(ding.fromTipMm),
      edge: dingSide
    } : {
      withheld: false,
      reason: null,
      depthMm: 0,
      fromTipMm: null,
      edge: null
    },
    fray: {
      withheld: false,
      reason: null,
      lengthMm: roundMm(fray.lengthMm),
      stickOutMm: roundMm(fray.stickOutMm),
      edge: fray.lengthMm > 0 ? fraySide : null
    },
    silhouette: {
      [sides[0]]: silA.map(compactPoint),
      [sides[1]]: silB.map(compactPoint)
    },
    arc: sharp || roundingReason === 'weak-edge' || roundingReason === 'unclear'
      ? null
      : arcPolyline(tip, bisector, [
        { u: uA, n: nA },
        { u: uB, n: nB }
      ], radiusFit, alpha, ctx.ppm)
  };
}

function compactPoint(p) {
  return {
    t: roundMm(p.t),
    inwardMm: roundMm(p.inwardMm),
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10
  };
}

function measureRaster(opts) {
  const dpi = opts.dpi || 1200;
  const ctx = {
    data: opts.data,
    width: opts.width,
    height: opts.height,
    paper: opts.paper,
    dpi: dpi,
    ppm: pxPerMm(dpi)
  };
  ctx.edges = opts.edges;
  ctx.corners = opts.corners;
  const corners = {};
  ['tl', 'tr', 'br', 'bl'].forEach(function (name) {
    corners[name] = measureCorner(ctx, name);
  });
  return {
    dpi: dpi,
    ppm: ctx.ppm,
    sizeOk: opts.sizeOk !== false,
    cardMm: opts.cardMm || null,
    corners: corners
  };
}

function numsAgree(a, b, tol) {
  if (a == null || b == null || !isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}

function meanOrNull(a, b) {
  if (a == null || b == null) return null;
  return roundMm((a + b) / 2);
}

function withheldRounding(reason) {
  return {
    withheld: true,
    reason: reason,
    sharp: false,
    limitMm: null,
    label: null,
    radiusMm: null,
    setbackMm: null,
    residualMm: null,
    approved: false
  };
}

function pairRounding(a, b) {
  if (!a || !b) return withheldRounding('needs-both-orientations');
  if (a.sharp && b.sharp && !a.withheld && !b.withheld) {
    const limitMm = roundMm(Math.max(a.limitMm, b.limitMm));
    return {
      withheld: false,
      reason: null,
      sharp: true,
      limitMm: limitMm,
      label: sharpLabel(limitMm),
      radiusMm: null,
      setbackMm: null,
      residualMm: null,
      approved: false
    };
  }
  if (a.withheld || b.withheld || a.sharp || b.sharp) {
    const reason = a.withheld && b.withheld && a.reason === b.reason ? a.reason : 'orientation-disagreement';
    return withheldRounding(reason);
  }
  if (!numsAgree(a.radiusMm, b.radiusMm, PAIR_MM) || !numsAgree(a.setbackMm, b.setbackMm, PAIR_MM)) {
    return withheldRounding('orientation-disagreement');
  }
  return {
    withheld: false,
    reason: null,
    sharp: false,
    limitMm: null,
    label: null,
    radiusMm: meanOrNull(a.radiusMm, b.radiusMm),
    setbackMm: meanOrNull(a.setbackMm, b.setbackMm),
    residualMm: meanOrNull(a.residualMm, b.residualMm),
    approved: false
  };
}

function pairWhitening(a, b) {
  if (!a || !b) return { withheld: true, reason: 'needs-both-orientations', lengthMm: null, areaMm2: null, approved: false };
  if (a.withheld || b.withheld) {
    const reason = a.withheld && b.withheld && a.reason === b.reason ? a.reason : 'orientation-disagreement';
    return {
      withheld: true,
      reason: reason,
      label: reason === 'white-border' ? 'not applicable' : null,
      lengthMm: null,
      areaMm2: null,
      approved: false
    };
  }
  const areaTol = Math.max(0.08, 0.5 * Math.abs((a.areaMm2 + b.areaMm2) / 2));
  if (!numsAgree(a.lengthMm, b.lengthMm, PAIR_MM) || !numsAgree(a.areaMm2, b.areaMm2, areaTol)) {
    return { withheld: true, reason: 'orientation-disagreement', lengthMm: null, areaMm2: null, approved: false };
  }
  return {
    withheld: false,
    reason: null,
    lengthMm: meanOrNull(a.lengthMm, b.lengthMm),
    areaMm2: meanOrNull(a.areaMm2, b.areaMm2),
    approved: false
  };
}

function pairDing(a, b) {
  if (!a || !b) return { withheld: true, reason: 'needs-both-orientations', depthMm: null, fromTipMm: null, approved: false };
  if (a.withheld || b.withheld) {
    return { withheld: true, reason: 'orientation-disagreement', depthMm: null, fromTipMm: null, approved: false };
  }
  const aNone = !(a.depthMm > 0);
  const bNone = !(b.depthMm > 0);
  if (aNone && bNone) {
    return { withheld: false, reason: null, depthMm: 0, fromTipMm: null, approved: false };
  }
  if (aNone || bNone || !numsAgree(a.depthMm, b.depthMm, PAIR_MM) || !numsAgree(a.fromTipMm, b.fromTipMm, FRAY_PAIR_MM)) {
    return { withheld: true, reason: 'orientation-disagreement', depthMm: null, fromTipMm: null, approved: false };
  }
  return {
    withheld: false,
    reason: null,
    depthMm: meanOrNull(a.depthMm, b.depthMm),
    fromTipMm: meanOrNull(a.fromTipMm, b.fromTipMm),
    approved: false
  };
}

function pairFray(a, b) {
  if (!a || !b) return { withheld: true, reason: 'needs-both-orientations', lengthMm: null, stickOutMm: null, approved: false };
  if (a.withheld || b.withheld) {
    return { withheld: true, reason: 'orientation-disagreement', lengthMm: null, stickOutMm: null, approved: false };
  }
  const aNone = !(a.lengthMm > 0);
  const bNone = !(b.lengthMm > 0);
  if (aNone && bNone) {
    return { withheld: false, reason: null, lengthMm: 0, stickOutMm: 0, approved: false };
  }
  if (aNone || bNone || !numsAgree(a.lengthMm, b.lengthMm, FRAY_PAIR_MM) || !numsAgree(a.stickOutMm, b.stickOutMm, FRAY_PAIR_MM)) {
    return { withheld: true, reason: 'orientation-disagreement', lengthMm: null, stickOutMm: null, approved: false };
  }
  return {
    withheld: false,
    reason: null,
    lengthMm: meanOrNull(a.lengthMm, b.lengthMm),
    stickOutMm: meanOrNull(a.stickOutMm, b.stickOutMm),
    approved: false
  };
}

function blockForCentering(quantity, blocked, fields) {
  if (!blocked) return quantity;
  const out = Object.assign({}, quantity, { centeringSideWithheld: true });
  if (!out.withheld) {
    out.withheld = true;
    out.reason = 'centering-side-withheld';
    out.sharp = false;
    out.label = null;
    fields.forEach(function (name) { out[name] = null; });
  }
  return out;
}

function slimCorner(corner) {
  if (!corner) return null;
  return {
    rounding: corner.rounding,
    whitening: {
      withheld: corner.whitening.withheld,
      reason: corner.whitening.reason,
      label: corner.whitening.label || null,
      lengthMm: corner.whitening.lengthMm,
      areaMm2: corner.whitening.areaMm2,
      midLuma: corner.whitening.midLuma
    },
    ding: {
      withheld: corner.ding.withheld,
      reason: corner.ding.reason,
      depthMm: corner.ding.depthMm,
      fromTipMm: corner.ding.fromTipMm,
      edge: corner.ding.edge
    },
    fray: {
      withheld: corner.fray.withheld,
      reason: corner.fray.reason,
      lengthMm: corner.fray.lengthMm,
      stickOutMm: corner.fray.stickOutMm,
      edge: corner.fray.edge
    },
    riseMm: corner.riseMm,
    alphaDeg: corner.alphaDeg
  };
}

function pairReadings(up, down, centeringWithheld) {
  const corners = {};
  const upOk = !!(up && up.sizeOk && up.corners);
  const downOk = !!(down && down.sizeOk && down.corners);
  const missing = !up || !down || !up.corners || !down.corners;
  ['tl', 'tr', 'br', 'bl'].forEach(function (name) {
    const a = up && up.corners ? up.corners[name] : null;
    const b = down && down.corners ? down.corners[FROM_180[name]] : null;
    let rounding;
    let whiteningQ;
    let ding;
    let fray;
    if (!upOk || !downOk) {
      const reason = missing ? 'needs-both-orientations' : 'not-card-sized';
      rounding = withheldRounding(reason);
      whiteningQ = { withheld: true, reason: reason, lengthMm: null, areaMm2: null, approved: false };
      ding = { withheld: true, reason: reason, depthMm: null, fromTipMm: null, approved: false };
      fray = { withheld: true, reason: reason, lengthMm: null, stickOutMm: null, approved: false };
    } else {
      rounding = pairRounding(a.rounding, b.rounding);
      whiteningQ = pairWhitening(a.whitening, b.whitening);
      ding = pairDing(a.ding, b.ding);
      fray = pairFray(a.fray, b.fray);
    }
    const sides = ADJACENT[name];
    const blocked = !!(centeringWithheld && (centeringWithheld[sides[0]] || centeringWithheld[sides[1]]));
    rounding = blockForCentering(rounding, blocked, ['radiusMm', 'setbackMm', 'residualMm', 'limitMm']);
    whiteningQ = blockForCentering(whiteningQ, blocked, ['lengthMm', 'areaMm2']);
    ding = blockForCentering(ding, blocked, ['depthMm', 'fromTipMm']);
    fray = blockForCentering(fray, blocked, ['lengthMm', 'stickOutMm']);
    corners[name] = {
      approved: false,
      adjacent: sides,
      centeringSideWithheld: blocked,
      rounding: rounding,
      whitening: whiteningQ,
      ding: ding,
      fray: fray,
      up: slimCorner(a),
      '180': slimCorner(b)
    };
  });
  return {
    approved: false,
    sizeOk: { up: upOk, '180': downOk },
    corners: corners,
    sources: { up: up || null, '180': down || null }
  };
}

function reviewDocument(cards, backs) {
  return {
    version: 1,
    approved: false,
    dpi: 1199.9976,
    pairMm: PAIR_MM,
    definition: DEFINITION,
    excluded: ['TD-12'],
    pendingScans: {
      worn: PENDING_WORN.slice()
    },
    wornSet: WORN_SET,
    bgsReference: BGS_REFERENCE,
    phone: 'A phone corner is not scored. It waits until those two edges already match the centering key, on a still in the ±0.1 mm tier (at or above 30 px/mm) or the ±0.2 mm tier (from 15 px/mm up to 30).',
    backs: backs || {},
    cards: cards
  };
}

module.exports = {
  ADJACENT: ADJACENT,
  FROM_180: FROM_180,
  EXCLUDED_IDS: EXCLUDED_IDS,
  PENDING_WORN: PENDING_WORN,
  WORN_SET: WORN_SET,
  BACK_IDS: BACK_IDS,
  BGS_REFERENCE: BGS_REFERENCE,
  PAIR_MM: PAIR_MM,
  DEFINITION: DEFINITION,
  pxPerMm: pxPerMm,
  isCornerCard: isCornerCard,
  measureRaster: measureRaster,
  pairReadings: pairReadings,
  reviewDocument: reviewDocument,
  roundMm: roundMm
};
