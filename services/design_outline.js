/**
 * services/design_outline.js
 *
 * The border is the space between the card edge and the design block
 * (photo, frame, nameplate, and trim, one object). Each side is measured
 * to the outermost points of that outline. A mark that sits in the margin
 * along only part of a side is not the outline. A side whose outline is
 * not clear is withheld.
 *
 * Shared by the flatbed answer key and the phone engine. Distances are
 * millimetres. Nothing here assumes a scanner dpi, a paper colour, or a
 * particular card.
 */
'use strict';

const SEARCH_TO_MM = 14;
const DEPTH_STEP_MM = 0.02;
const STATION_STEP_MM = 0.4;
const SIDE_MARGIN = 0.1;
const MAX_SLOPE = 0.55;
const MIN_COVERAGE = 0.75;
const CONTRAST_FLOOR = 12;
const MAX_CANDIDATES = 6;
const PARTIAL_COVERAGE = 0.32;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort(function (a, b) { return a - b; });
  const m = s.length >> 1;
  if (s.length % 2) return s[m];
  return 0.5 * (s[m - 1] + s[m]);
}

function roundMm(v) {
  if (v == null || !isFinite(v)) return null;
  return Math.round(v * 1000) / 1000;
}

function hypot(x, y) {
  return Math.sqrt(x * x + y * y);
}

function rgbDist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function solve3(A, b) {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]]
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-10) return null;
    if (piv !== col) {
      const tmp = M[col];
      M[col] = M[piv];
      M[piv] = tmp;
    }
    const div = M[col][col];
    for (let c = col; c < 4; c++) M[col][c] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

function sampleRgb(data, w, h, x, y, channels) {
  const ch = channels || 3;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = (y0 * w + x0) * ch;
  const i10 = (y0 * w + x1) * ch;
  const i01 = (y1 * w + x0) * ch;
  const i11 = (y1 * w + x1) * ch;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v0 = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const v1 = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[c] = v0 * (1 - ty) + v1 * ty;
  }
  return out;
}

function ppmPair(ppm) {
  if (ppm && typeof ppm === 'object') return { along: ppm.along, depth: ppm.depth };
  return { along: ppm, depth: ppm };
}

function smooth5(values) {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const w = k === 0 ? 2 : 1;
      acc += values[j] * w;
      wsum += w;
    }
    out[i] = acc / wsum;
  }
  return out;
}

function outlineStartIndex(profile, stepMm) {
  const n = profile.length;
  if (n < 8) return 0;
  const grad = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    if (!profile[i] || !profile[i + 1]) continue;
    grad[i] = rgbDist(profile[i], profile[i + 1]);
  }
  const sm = smooth5(grad);
  const window = Math.min(n - 2, Math.max(4, Math.round(0.75 / stepMm)));
  let peakI = 1;
  let peakV = 0;
  for (let i = 1; i < window; i++) {
    if (sm[i] > peakV) {
      peakV = sm[i];
      peakI = i;
    }
  }
  if (peakV < CONTRAST_FLOOR) return Math.round(0.2 / stepMm);
  const quiet = Math.max(CONTRAST_FLOOR, peakV * 0.12);
  const need = Math.max(3, Math.round(0.28 / stepMm));
  const limit = Math.min(n - need - 1, Math.round(2.2 / stepMm));
  for (let i = peakI + 1; i <= limit; i++) {
    let calm = true;
    for (let j = 0; j < need; j++) {
      if (sm[i + j] > quiet) {
        calm = false;
        break;
      }
    }
    if (calm) return i + need;
  }
  return Math.min(n - 2, peakI + Math.round(0.2 / stepMm));
}

function marginColorFromProfile(profile, designStart) {
  const colors = [];
  const end = Math.min(profile.length, designStart + 8);
  for (let i = Math.max(0, designStart); i < end; i++) {
    if (profile[i]) colors.push(profile[i]);
  }
  if (!colors.length) return null;
  return [
    median(colors.map(function (c) { return c[0]; })),
    median(colors.map(function (c) { return c[1]; })),
    median(colors.map(function (c) { return c[2]; }))
  ];
}

function colorAtDepth(profile, depth, stepMm) {
  const idx = Math.round(depth / stepMm);
  if (idx < 0 || idx >= profile.length) return null;
  return profile[idx];
}

function isMarginColor(rgb, marginColor) {
  if (!rgb || !marginColor) return false;
  return rgbDist(rgb, marginColor) < 40;
}

// The design block is the ink run that keeps going inward. A mark that sits
// in the margin is an ink run with margin colour on the inside of it.
function lastingDesignDepth(profile, stepMm, marginColor, startDepth) {
  if (!marginColor) return null;
  const maxD = Math.min(SEARCH_TO_MM, (profile.length - 1) * stepMm);
  let depth = startDepth || 0;
  while (depth < maxD) {
    while (depth < maxD && isMarginColor(colorAtDepth(profile, depth, stepMm), marginColor)) {
      depth += stepMm;
    }
    if (depth >= maxD) return null;
    const inkStart = depth;
    let marginRun = 0;
    let inkRun = 0;
    let d = depth;
    let returned = false;
    for (; d <= maxD; d += stepMm) {
      if (isMarginColor(colorAtDepth(profile, d, stepMm), marginColor)) {
        marginRun += stepMm;
        inkRun = 0;
        if (marginRun >= 0.28) {
          returned = true;
          break;
        }
      } else {
        marginRun = 0;
        inkRun += stepMm;
        if (inkRun >= 0.85) break;
      }
    }
    if (!returned && inkRun >= 0.55) return inkStart;
    depth = d + stepMm;
  }
  return null;
}

function snapDesignDepth(raw, cands) {
  if (raw == null) return null;
  let best = null;
  for (let k = 0; k < cands.length; k++) {
    const dd = Math.abs(cands[k].depth - raw);
    if (dd > 0.3) continue;
    if (!best || dd < best.dd || (dd === best.dd && cands[k].strength > best.strength)) {
      best = { dd: dd, depth: cands[k].depth, strength: cands[k].strength };
    }
  }
  return best ? best.depth : raw;
}

function tagMarginMarks(cands, profile, marginColor, stepMm, startDepth) {
  const raw = lastingDesignDepth(profile, stepMm, marginColor, startDepth);
  const designDepth = snapDesignDepth(raw, cands);
  for (let k = 0; k < cands.length; k++) {
    const depth = cands[k].depth;
    cands[k].marginMark = designDepth == null ? false : depth < designDepth - 0.18;
    cands[k].designEdge = designDepth != null && Math.abs(depth - designDepth) <= 0.22;
  }
  return designDepth;
}

function rayCandidates(profile, depth0, stepMm) {
  const raw = new Array(profile.length).fill(0);
  for (let i = 0; i < profile.length - 1; i++) {
    if (!profile[i] || !profile[i + 1]) continue;
    raw[i] = rgbDist(profile[i], profile[i + 1]);
  }
  const sm = smooth5(raw);
  const maxima = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] < CONTRAST_FLOOR) continue;
    if (sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
    const denom = sm[i - 1] - 2 * sm[i] + sm[i + 1];
    let shift = 0.5;
    if (Math.abs(denom) > 1e-6) {
      shift = clamp(0.5 * (sm[i - 1] - sm[i + 1]) / denom, -0.5, 0.5) + 0.5;
    }
    const depth = depth0 + (i + shift) * stepMm;
    if (maxima.length && depth - maxima[maxima.length - 1].depth < 0.2) {
      if (sm[i] > maxima[maxima.length - 1].strength) {
        maxima[maxima.length - 1] = { depth: depth, strength: sm[i] };
      }
      continue;
    }
    maxima.push({ depth: depth, strength: sm[i] });
  }
  maxima.sort(function (a, b) { return a.depth - b.depth; });
  return maxima.slice(0, MAX_CANDIDATES);
}

function linkOutline(stations, stepMm) {
  const n = stations.length;
  if (n < 8) return null;
  const maxGap = 3;
  const dpLen = new Array(n);
  const dpSum = new Array(n);
  const dpPrevK = new Array(n);
  const dpPrevI = new Array(n);
  for (let i = 0; i < n; i++) {
    const K = stations[i].candidates.length;
    dpLen[i] = new Int16Array(K);
    dpSum[i] = new Float64Array(K);
    dpPrevK[i] = new Int16Array(K);
    dpPrevI[i] = new Int16Array(K);
    for (let k = 0; k < K; k++) {
      dpLen[i][k] = 1;
      dpSum[i][k] = stations[i].candidates[k].depth;
      dpPrevK[i][k] = -1;
      dpPrevI[i][k] = -1;
      const d = stations[i].candidates[k].depth;
      for (let back = 1; back <= maxGap + 1 && i - back >= 0; back++) {
        const j = i - back;
        const pK = stations[j].candidates.length;
        const jump = Math.min(0.55, 0.22 + MAX_SLOPE * stepMm * back);
        for (let p = 0; p < pK; p++) {
          const pd = stations[j].candidates[p].depth;
          if (Math.abs(d - pd) > jump) continue;
          const len = dpLen[j][p] + 1;
          const sum = dpSum[j][p] + d;
          const better = len > dpLen[i][k] || (len === dpLen[i][k] && sum < dpSum[i][k]);
          if (better) {
            dpLen[i][k] = len;
            dpSum[i][k] = sum;
            dpPrevK[i][k] = p;
            dpPrevI[i][k] = j;
          }
        }
      }
    }
  }
  const minLen = Math.ceil(MIN_COVERAGE * n);
  let best = null;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < stations[i].candidates.length; k++) {
      const len = dpLen[i][k];
      if (len < minLen) continue;
      const sum = dpSum[i][k];
      const meanD = sum / len;
      if (!best || meanD < best.mean - 1e-9 || (Math.abs(meanD - best.mean) <= 1e-9 && len > best.len)) {
        best = { i: i, k: k, len: len, sum: sum, mean: meanD };
      }
    }
  }
  if (!best) return null;
  const seq = [];
  let i = best.i;
  let k = best.k;
  while (i >= 0 && k >= 0) {
    const cand = stations[i].candidates[k];
    seq.push({
      index: i,
      depth: cand.depth,
      strength: cand.strength,
      x: stations[i].x,
      y: stations[i].y,
      nx: stations[i].nx,
      ny: stations[i].ny,
      alongMm: stations[i].alongMm,
      t: stations[i].t
    });
    const p = dpPrevK[i][k];
    const pi = dpPrevI[i][k];
    if (p < 0 || pi < 0) break;
    k = p;
    i = pi;
  }
  seq.reverse();
  return seq;
}

function fitPoly(points) {
  const n = points.length;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let z0 = 0;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < n; i++) {
    const t = points[i].t;
    const z = points[i].depth;
    const t2 = t * t;
    s0 += 1;
    s1 += t;
    s2 += t2;
    s3 += t2 * t;
    s4 += t2 * t2;
    z0 += z;
    z1 += z * t;
    z2 += z * t2;
  }
  const quad = solve3(
    [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]],
    [z0, z1, z2]
  );
  let lin = null;
  const det = s0 * s2 - s1 * s1;
  if (Math.abs(det) > 1e-10) {
    const a = (z0 * s2 - z1 * s1) / det;
    const b = (s0 * z1 - s1 * z0) / det;
    lin = [a, b];
  }
  return { quad: quad, lin: lin };
}

function predictQuad(coef, t) {
  return coef[0] + coef[1] * t + coef[2] * t * t;
}

function predictLin(coef, t) {
  return coef[0] + coef[1] * t;
}

function residualRms(points, predict) {
  if (!points.length) return Infinity;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const r = points[i].depth - predict(points[i].t);
    s += r * r;
  }
  return Math.sqrt(s / points.length);
}

function dropDepthOutliers(points) {
  if (points.length < 12) return points;
  const fit = fitPoly(points);
  const predict = fit.quad
    ? function (t) { return predictQuad(fit.quad, t); }
    : (fit.lin ? function (t) { return predictLin(fit.lin, t); } : null);
  if (!predict) return points;
  const res = points.map(function (p) { return Math.abs(p.depth - predict(p.t)); });
  const med = median(res) || 0;
  const mad = median(res.map(function (r) { return Math.abs(r - med); })) || 0.02;
  const limit = Math.max(0.18, mad * 6);
  const kept = points.filter(function (p, i) { return res[i] <= limit; });
  return kept.length >= 8 ? kept : points;
}

function summarizePath(path, stationCount) {
  const empty = {
    mm: null,
    confidence: 0,
    withheld: true,
    reason: 'no-outline',
    points: [],
    used: [],
    shape: null
  };
  if (!path || path.length < 8) return empty;
  const cleaned = dropDepthOutliers(path);
  const coverage = cleaned.length / stationCount;
  if (coverage < MIN_COVERAGE) {
    return {
      mm: null,
      confidence: 0,
      withheld: true,
      reason: 'partial',
      points: cleaned,
      used: [],
      shape: null,
      coverage: coverage
    };
  }
  const fit = fitPoly(cleaned);
  const depths = cleaned.map(function (p) { return p.depth; });
  const dMin = Math.min.apply(null, depths);
  const dMax = Math.max.apply(null, depths);
  const range = dMax - dMin;
  const med = median(depths);
  let rmsQ = Infinity;
  let rmsL = Infinity;
  if (fit.quad) rmsQ = residualRms(cleaned, function (t) { return predictQuad(fit.quad, t); });
  if (fit.lin) rmsL = residualRms(cleaned, function (t) { return predictLin(fit.lin, t); });
  const straight = range < 0.45 && rmsL <= rmsQ + 0.02;
  let shape = 'line';
  let modelMin = med;
  let predict = null;
  if (!straight && fit.quad && rmsQ <= rmsL * 0.9 && rmsQ < 0.2) {
    shape = 'curve';
    const a = fit.quad[0];
    const b = fit.quad[1];
    const c = fit.quad[2];
    let tStar = 0;
    if (c > 1e-6) {
      tStar = clamp(-b / (2 * c), 0, 1);
    } else {
      tStar = predictQuad(fit.quad, 0) <= predictQuad(fit.quad, 1) ? 0 : 1;
    }
    modelMin = predictQuad(fit.quad, tStar);
    predict = function (t) { return predictQuad(fit.quad, t); };
  } else if (fit.lin && rmsL < 0.2) {
    shape = range < 0.45 ? 'line' : 'slant';
    const z0 = predictLin(fit.lin, 0);
    const z1 = predictLin(fit.lin, 1);
    modelMin = Math.min(z0, z1);
    if (shape === 'line') modelMin = med;
    predict = function (t) { return predictLin(fit.lin, t); };
  } else if (fit.quad && rmsQ < 0.2) {
    shape = 'curve';
    const b = fit.quad[1];
    const c = fit.quad[2];
    const tStar = c > 1e-6 ? clamp(-b / (2 * c), 0, 1) : 0;
    modelMin = predictQuad(fit.quad, tStar);
    predict = function (t) { return predictQuad(fit.quad, t); };
  } else {
    return {
      mm: null,
      confidence: 0,
      withheld: true,
      reason: 'incoherent',
      points: cleaned,
      used: [],
      shape: null,
      coverage: coverage,
      rms: Math.min(rmsQ, rmsL)
    };
  }
  const rms = shape === 'curve' ? rmsQ : (shape === 'line' ? Math.min(rmsL, residualRms(cleaned, function () { return med; })) : rmsL);
  if (rms > 0.22) {
    return {
      mm: null,
      confidence: 0,
      withheld: true,
      reason: 'incoherent',
      points: cleaned,
      used: [],
      shape: shape,
      coverage: coverage,
      rms: rms
    };
  }
  let used;
  if (shape === 'line') {
    used = cleaned.filter(function (p) { return Math.abs(p.depth - med) <= Math.max(0.18, range); });
    modelMin = med;
  } else {
    const band = Math.max(0.15, Math.min(0.35, range * 0.2));
    used = cleaned.filter(function (p) { return Math.abs(p.depth - modelMin) <= band; });
    if (used.length < 2) {
      const ranked = cleaned.slice().sort(function (a, b) {
        return Math.abs(a.depth - modelMin) - Math.abs(b.depth - modelMin);
      });
      used = ranked.slice(0, Math.min(4, ranked.length));
    }
  }
  if (used.length < 2) {
    return {
      mm: null,
      confidence: 0,
      withheld: true,
      reason: 'few-points',
      points: cleaned,
      used: used,
      shape: shape,
      coverage: coverage,
      rms: rms
    };
  }
  const usedSpread = Math.max.apply(null, used.map(function (p) { return p.depth; })) -
    Math.min.apply(null, used.map(function (p) { return p.depth; }));
  if (shape !== 'line' && usedSpread > 0.4) {
    return {
      mm: null,
      confidence: 0,
      withheld: true,
      reason: 'unstable-extreme',
      points: cleaned,
      used: used,
      shape: shape,
      coverage: coverage,
      rms: rms
    };
  }
  const reported = shape === 'line' ? med : modelMin;
  const strength = median(cleaned.map(function (p) { return p.strength; })) || 0;
  const covScore = coverage >= MIN_COVERAGE
    ? 0.72 + 0.28 * clamp((coverage - MIN_COVERAGE) / 0.2, 0, 1)
    : 0;
  const rmsScore = clamp(1 - rms / 0.22, 0, 1);
  const strScore = clamp((strength - CONTRAST_FLOOR) / 25, 0, 1);
  let conf = Math.min(covScore, 0.55 + 0.45 * rmsScore) * (0.7 + 0.3 * strScore);
  if (used.length < 2) conf = 0;
  const withheld = conf < 0.45 || !isFinite(reported) || coverage < MIN_COVERAGE || rms > 0.22;
  return {
    mm: withheld ? null : reported,
    confidence: withheld ? Math.min(conf, 0.34) : conf,
    withheld: withheld,
    reason: withheld ? 'low-confidence' : null,
    points: cleaned,
    used: used,
    shape: shape,
    coverage: coverage,
    rms: rms,
    strength: strength
  };
}

function measureSide(data, w, h, quad, sideName, ppm, channels, options) {
  const scale = ppmPair(ppm);
  const corners = quad.corners;
  let a;
  let b;
  let normalLine;
  if (sideName === 'top') {
    a = corners.tl;
    b = corners.tr;
    normalLine = quad.lines.top;
  } else if (sideName === 'bottom') {
    a = corners.bl;
    b = corners.br;
    normalLine = quad.lines.bottom;
  } else if (sideName === 'left') {
    a = corners.tl;
    b = corners.bl;
    normalLine = quad.lines.left;
  } else {
    a = corners.tr;
    b = corners.br;
    normalLine = quad.lines.right;
  }
  const lengthPx = hypot(b.x - a.x, b.y - a.y);
  const lengthMm = lengthPx / scale.along;
  const nx = normalLine.a;
  const ny = normalLine.b;
  const stepPx = STATION_STEP_MM * scale.along;
  const stations = [];
  const start = lengthPx * SIDE_MARGIN;
  const end = lengthPx * (1 - SIDE_MARGIN);
  for (let s = start; s <= end; s += stepPx) {
    const t = (s - start) / Math.max(1e-6, end - start);
    const x = a.x + (b.x - a.x) * (s / lengthPx);
    const y = a.y + (b.y - a.y) * (s / lengthPx);
    const nSteps = Math.round(SEARCH_TO_MM / DEPTH_STEP_MM);
    const profile = new Array(nSteps);
    for (let i = 0; i < nSteps; i++) {
      const depthMm = i * DEPTH_STEP_MM;
      const px = x + nx * depthMm * scale.depth;
      const py = y + ny * depthMm * scale.depth;
      profile[i] = sampleRgb(data, w, h, px, py, channels);
    }
    const designStart = options && options.skipEdgeShoulder === false
      ? Math.round(0.12 / DEPTH_STEP_MM)
      : outlineStartIndex(profile, DEPTH_STEP_MM);
    const cands = rayCandidates(profile.slice(designStart), designStart * DEPTH_STEP_MM, DEPTH_STEP_MM);
    const marginColor = marginColorFromProfile(profile, designStart);
    const designDepth = tagMarginMarks(cands, profile, marginColor, DEPTH_STEP_MM, designStart * DEPTH_STEP_MM);
    stations.push({
      x: x,
      y: y,
      nx: nx,
      ny: ny,
      alongMm: s / scale.along,
      t: t,
      margin: marginColor,
      designDepth: designDepth,
      candidates: cands
    });
  }
  let best = summarizeDesign(stations);
  if (best.withheld && best.reason === 'no-outline') {
    const path = linkOutline(stations, STATION_STEP_MM);
    const linked = summarizePath(path, stations.length);
    if (linked && !linked.withheld) best = linked;
  }
  best.side = sideName;
  best.lengthMm = lengthMm;
  best.edge = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, nx: nx, ny: ny };
  if (process.env.TRACE_FLATBED) {
    process.stdout.write(sideName + ' ' + JSON.stringify(traceSide(stations)) + '\n');
  }
  return best;
}

function traceSide(stations) {
  const depths = stations.map(function (st) { return st.designDepth; }).filter(function (d) { return d != null; });
  const hist = {};
  depths.forEach(function (d) {
    const key = (Math.round(d * 5) / 5).toFixed(1);
    hist[key] = (hist[key] || 0) + 1;
  });
  const sample = [];
  for (let i = 0; i < stations.length; i += Math.max(1, Math.floor(stations.length / 12))) {
    sample.push(roundMm(stations[i].alongMm) + ':' + (stations[i].designDepth == null ? '—' : roundMm(stations[i].designDepth)));
  }
  return { n: stations.length, design: depths.length, hist: hist, sample: sample };
}

function strengthAt(st) {
  if (st.designDepth == null) return 0;
  let best = 0;
  let bestD = 1e9;
  (st.candidates || []).forEach(function (c) {
    const dd = Math.abs(c.depth - st.designDepth);
    if (dd < bestD) {
      bestD = dd;
      best = c.strength;
    }
  });
  return bestD <= 0.35 ? best : 0;
}

function clusterDepths(points) {
  const items = points.slice().sort(function (a, b) { return a.depth - b.depth; });
  const layers = [];
  items.forEach(function (item) {
    let best = null;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const dd = Math.abs(item.depth - layer.median);
      if (dd > 0.2) continue;
      const span = Math.max(layer.max, item.depth) - Math.min(layer.min, item.depth);
      if (span > 0.4) continue;
      if (!best || dd < Math.abs(item.depth - best.median)) best = layer;
    }
    if (!best) {
      layers.push({ points: [item], median: item.depth, min: item.depth, max: item.depth });
      return;
    }
    best.points.push(item);
    best.min = Math.min(best.min, item.depth);
    best.max = Math.max(best.max, item.depth);
    best.median = median(best.points.map(function (p) { return p.depth; }));
  });
  layers.sort(function (a, b) { return a.median - b.median; });
  return layers;
}

function denseBody(points) {
  const depths = points.map(function (p) { return p.depth; });
  let mode = median(depths);
  let bestN = -1;
  for (let i = 0; i < depths.length; i++) {
    const d = depths[i];
    let n = 0;
    for (let j = 0; j < depths.length; j++) {
      if (Math.abs(depths[j] - d) <= 0.12) n += 1;
    }
    if (n > bestN || (n === bestN && d < mode)) {
      bestN = n;
      mode = d;
    }
  }
  const body = points.filter(function (p) { return Math.abs(p.depth - mode) <= 0.16; });
  return body.length >= 2 ? body : points.slice();
}

function mergeCloseLayers(layers) {
  const list = layers.map(function (layer) {
    return {
      points: layer.points.slice(),
      median: layer.median,
      min: layer.min,
      max: layer.max
    };
  });
  let changed = true;
  while (changed) {
    changed = false;
    let bestI = -1;
    let bestJ = -1;
    let bestD = 0.32;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.abs(list[i].median - list[j].median);
        const span = Math.max(list[i].max, list[j].max) - Math.min(list[i].min, list[j].min);
        if (d < bestD && span <= 0.55) {
          bestD = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;
    const a = list[bestI];
    const b = list[bestJ];
    const points = a.points.concat(b.points);
    list[bestI] = {
      points: points,
      median: median(points.map(function (p) { return p.depth; })),
      min: Math.min(a.min, b.min),
      max: Math.max(a.max, b.max)
    };
    list.splice(bestJ, 1);
    changed = true;
  }
  list.sort(function (a, b) { return a.median - b.median; });
  return list;
}

function layerRuns(points) {
  const sorted = points.slice().sort(function (a, b) { return a.i - b.i; });
  const runs = [];
  if (!sorted.length) return runs;
  let run = [sorted[0]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].i > run[run.length - 1].i + 2) {
      runs.push(run);
      run = [];
    }
    run.push(sorted[k]);
  }
  runs.push(run);
  return runs.map(function (group) {
    const along = group.map(function (p) { return p.alongMm; });
    return {
      fromMm: roundMm(Math.min.apply(null, along)),
      toMm: roundMm(Math.max.apply(null, along)),
      stations: group.length
    };
  });
}

function layerElement(layer, stationCount, role, refused, why) {
  const along = layer.points.map(function (p) { return p.alongMm; });
  const runs = layerRuns(layer.points);
  return {
    depthMm: roundMm(layer.median),
    fromMm: roundMm(Math.min.apply(null, along)),
    toMm: roundMm(Math.max.apply(null, along)),
    coverage: stationCount ? Math.round((layer.points.length / stationCount) * 1000) / 1000 : null,
    stations: layer.points.length,
    runs: runs.slice(0, 12),
    runCount: runs.length,
    role: role,
    refused: refused,
    why: why
  };
}

function summarizeDesign(stations) {
  const empty = {
    mm: null,
    confidence: 0,
    withheld: true,
    reason: 'no-outline',
    points: [],
    used: [],
    shape: null,
    elements: [],
    coverage: 0
  };
  const n = stations.length;
  if (n < 4) return empty;
  const shadow = [];
  const readings = [];
  stations.forEach(function (st, i) {
    if (st.designDepth == null) return;
    const point = {
      i: i,
      depth: st.designDepth,
      strength: strengthAt(st),
      x: st.x,
      y: st.y,
      nx: st.nx,
      ny: st.ny,
      alongMm: st.alongMm,
      t: st.t
    };
    if (st.designDepth < 0.45) shadow.push(point);
    else readings.push(point);
  });
  const layers = mergeCloseLayers(clusterDepths(readings));
  layers.forEach(function (layer) {
    layer.cov = layer.points.length / n;
    layer.partial = false;
    layer.why = null;
  });
  layers.forEach(function (layer) {
    // One printed frame can change depth along a side and split into
    // neighbouring layers. A short mark outside that frame is still a
    // margin mark when the deeper design, taken together, continues.
    let deeperStations = 0;
    stations.forEach(function (st) {
      if (st.designDepth != null && st.designDepth > layer.median + 0.28) deeperStations += 1;
    });
    const deeperCov = n ? deeperStations / n : 0;
    if (deeperCov < 0.28) return;
    if (layer.cov < PARTIAL_COVERAGE && layer.cov < deeperCov * 0.65) {
      layer.partial = true;
      layer.why = 'covers ' + Math.round(layer.cov * 100) +
        '% of the side and sits outside the outline that continues along the rest';
    }
  });
  const elements = [];
  if (shadow.length >= 3) {
    elements.push(layerElement(
      { points: shadow, median: median(shadow.map(function (p) { return p.depth; })) || 0 },
      n,
      'edge-shadow',
      true,
      'sits in the card-edge transition, not the design block'
    ));
  }
  const eligible = layers.filter(function (layer) { return !layer.partial && layer.points.length >= 2; });
  eligible.sort(function (a, b) { return a.median - b.median; });
  const outline = eligible.length ? eligible[0] : null;
  const isolated = [];
  layers.forEach(function (layer) {
    if (layer === outline) return;
    if (layer.points.length < 2) {
      isolated.push.apply(isolated, layer.points);
      return;
    }
    if (layer.partial) {
      elements.push(layerElement(layer, n, 'partial-margin', true, layer.why));
      return;
    }
    elements.push(layerElement(
      layer, n, 'deeper-element', true,
      'deeper than the outermost points of the design block'
    ));
  });
  if (isolated.length) {
    elements.push(layerElement(
      { points: isolated, median: median(isolated.map(function (p) { return p.depth; })) || 0 },
      n,
      'isolated',
      true,
      'single-station readings, not an outline'
    ));
  }
  if (!outline) {
    return {
      mm: null,
      confidence: 0,
      withheld: true,
      reason: readings.length ? 'partial' : 'no-outline',
      points: readings,
      used: [],
      shape: null,
      elements: elements,
      coverage: readings.length / n
    };
  }
  const extreme = denseBody(outline.points);
  const extDepths = extreme.map(function (p) { return p.depth; });
  const extSpread = Math.max.apply(null, extDepths) - Math.min.apply(null, extDepths);
  const tipMin = Math.min.apply(null, extDepths);
  const tip = extreme.filter(function (p) { return p.depth <= tipMin + 0.08; });
  const useTip = tip.length >= 4 && tip.length >= extreme.length * 0.45;
  const reported = useTip ? median(tip.map(function (p) { return p.depth; })) : median(extDepths);
  const measuredPts = useTip ? tip : extreme;
  const strength = median(measuredPts.map(function (p) { return p.strength; })) || 0;
  const coverage = extreme.length / n;
  const measDepths = measuredPts.map(function (p) { return p.depth; });
  const measSpread = Math.max.apply(null, measDepths) - Math.min.apply(null, measDepths);
  const clear = measuredPts.length >= 2 && measSpread <= 0.36 && coverage >= 0.12 && isFinite(reported);
  const covScore = clamp((coverage - 0.15) / 0.6, 0, 1);
  const tightScore = clamp(1 - measSpread / 0.36, 0, 1);
  const strScore = strength > 0 ? clamp((strength - CONTRAST_FLOOR) / 25, 0, 1) : 0.5;
  let conf = (0.48 + 0.52 * covScore) * (0.62 + 0.38 * tightScore) * (0.72 + 0.28 * strScore);
  if (measuredPts.length < 4) conf *= 0.85;
  const withheld = !clear;
  let why = null;
  if (withheld) {
    if (measuredPts.length < 2) why = 'fewer than 2 outermost points';
    else if (measSpread > 0.36) why = 'outermost points disagree by ' + roundMm(measSpread) + ' mm';
    else why = 'the outermost points do not cover enough of the side to be the outline';
  }
  elements.unshift(layerElement({ points: measuredPts, median: reported }, n, 'outline', withheld, why));
  elements.sort(function (a, b) { return a.depthMm - b.depthMm; });
  return {
    mm: withheld ? null : reported,
    confidence: withheld ? Math.min(conf, 0.34) : conf,
    withheld: withheld,
    reason: withheld ? 'unclear' : null,
    points: measuredPts,
    used: measuredPts,
    shape: extSpread <= 0.22 ? 'line' : 'outer',
    elements: elements,
    coverage: coverage,
    rms: extSpread / 2,
    strength: strength
  };
}

function measureRect(data, w, h, pxPerMmX, pxPerMmY, channels) {
  const ch = channels || 3;
  const quad = {
    corners: {
      tl: { x: 0, y: 0 },
      tr: { x: Math.max(0, w - 1), y: 0 },
      br: { x: Math.max(0, w - 1), y: Math.max(0, h - 1) },
      bl: { x: 0, y: Math.max(0, h - 1) }
    },
    lines: {
      top: { a: 0, b: 1 },
      bottom: { a: 0, b: -1 },
      left: { a: 1, b: 0 },
      right: { a: -1, b: 0 }
    }
  };
  const horizontal = { along: pxPerMmX, depth: pxPerMmY };
  const vertical = { along: pxPerMmY, depth: pxPerMmX };
  return {
    top: measureSide(data, w, h, quad, 'top', horizontal, ch),
    bottom: measureSide(data, w, h, quad, 'bottom', horizontal, ch),
    left: measureSide(data, w, h, quad, 'left', vertical, ch),
    right: measureSide(data, w, h, quad, 'right', vertical, ch)
  };
}

module.exports = {
  measureSide: measureSide,
  measureRect: measureRect,
  sampleRgb: sampleRgb,
  SEARCH_TO_MM: SEARCH_TO_MM,
  DEPTH_STEP_MM: DEPTH_STEP_MM,
  PARTIAL_COVERAGE: PARTIAL_COVERAGE
};
