/**
 * scripts/measure_flatbed.js
 *
 * Flatbed answer key. Measures the border on a 1200 dpi scan of a card
 * lying on a sheet of paper (pink, for this set). Does not use the phone
 * grading engine.
 *
 * The border is the space between the card edge and the design block: the
 * main printed artwork (photo, frame, nameplate, trim) treated as one
 * object. On each side the outline is the boundary that runs continuously
 * along that side. It may change colour, element, and shape, and it may be
 * straight or curved. The width is the perpendicular distance from the card
 * edge to the outermost points of that outline.
 *
 * A mark that sits in the margin, or that enters it along only part of a
 * side, is not the outline. If a side's outline cannot be followed with
 * confidence, that side is withheld.
 *
 * Run: node scripts/measure_flatbed.js [--flatbed DIR] [--self-test]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const NOMINAL_W_MM = 63.5;
const NOMINAL_H_MM = 88.9;
const DEFAULT_DPI = 1200;
const AGREE_MM = 0.05;

const SEARCH_FROM_MM = 0.25;
const SEARCH_TO_MM = 14;
const DEPTH_STEP_MM = 0.02;
const STATION_STEP_MM = 0.4;
const SIDE_MARGIN = 0.1;
const EDGE_FIT_MARGIN = 0.15;
const MAX_SLOPE = 0.55;
const MIN_COVERAGE = 0.75;
const CONTRAST_FLOOR = 12;
const MAX_CANDIDATES = 6;
const MAX_LAYERS = 4;

function pxPerMm(dpi) {
  return dpi / 25.4;
}

function hypot(x, y) {
  return Math.sqrt(x * x + y * y);
}

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

function mean(values) {
  if (!values.length) return null;
  let t = 0;
  for (let i = 0; i < values.length; i++) t += values[i];
  return t / values.length;
}

function roundMm(v) {
  if (v == null || !isFinite(v)) return null;
  return Math.round(v * 1000) / 1000;
}

function rgbDist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function distToPaper(r, g, b, paper) {
  const dr = r - paper[0];
  const dg = g - paper[1];
  const db = b - paper[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
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

function otsu(distances) {
  const bins = 256;
  const hist = new Uint32Array(bins);
  let maxD = 1;
  for (let i = 0; i < distances.length; i++) if (distances[i] > maxD) maxD = distances[i];
  const scale = (bins - 1) / maxD;
  for (let i = 0; i < distances.length; i++) {
    hist[Math.max(0, Math.min(bins - 1, Math.round(distances[i] * scale)))] += 1;
  }
  const total = distances.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thresh = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thresh = i;
    }
  }
  return thresh / scale;
}

function estimatePaper(data, w, h) {
  const cw = Math.max(4, Math.round(w * 0.06));
  const ch = Math.max(4, Math.round(h * 0.06));
  const rs = [];
  const gs = [];
  const bs = [];
  const corners = [
    [0, 0],
    [w - cw, 0],
    [0, h - ch],
    [w - cw, h - ch]
  ];
  for (let k = 0; k < corners.length; k++) {
    const x0 = corners[k][0];
    const y0 = corners[k][1];
    for (let y = y0; y < y0 + ch; y += 2) {
      for (let x = x0; x < x0 + cw; x += 2) {
        const i = (y * w + x) * 3;
        rs.push(data[i]);
        gs.push(data[i + 1]);
        bs.push(data[i + 2]);
      }
    }
  }
  const paper = [median(rs), median(gs), median(bs)];
  const samples = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 80000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 3;
      samples.push(distToPaper(data[i], data[i + 1], data[i + 2], paper));
    }
  }
  let threshold = otsu(samples);
  if (!isFinite(threshold) || threshold < 8) threshold = 18;
  return { paper: paper, threshold: threshold };
}

function largestComponentBBox(data, w, h, paper, threshold) {
  const step = Math.max(1, Math.floor(Math.max(w, h) / 900));
  const gw = Math.ceil(w / step);
  const gh = Math.ceil(h / step);
  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y = Math.min(h - 1, gy * step);
    for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(w - 1, gx * step);
      const i = (y * w + x) * 3;
      if (distToPaper(data[i], data[i + 1], data[i + 2], paper) >= threshold) {
        mask[gy * gw + gx] = 1;
      }
    }
  }
  const seen = new Uint8Array(gw * gh);
  let best = null;
  let bestArea = 0;
  const qx = new Int32Array(gw * gh);
  const qy = new Int32Array(gw * gh);
  for (let sy = 0; sy < gh; sy++) {
    for (let sx = 0; sx < gw; sx++) {
      const s = sy * gw + sx;
      if (!mask[s] || seen[s]) continue;
      let head = 0;
      let tail = 0;
      qx[tail] = sx;
      qy[tail] = sy;
      tail += 1;
      seen[s] = 1;
      let area = 0;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      while (head < tail) {
        const x = qx[head];
        const y = qy[head];
        head += 1;
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const ni = ny * gw + nx;
            if (!mask[ni] || seen[ni]) continue;
            seen[ni] = 1;
            qx[tail] = nx;
            qy[tail] = ny;
            tail += 1;
          }
        }
      }
      if (area > bestArea) {
        bestArea = area;
        best = { minX: minX, maxX: maxX, minY: minY, maxY: maxY, area: area };
      }
    }
  }
  if (!best || bestArea < 50) return null;
  return {
    left: best.minX * step,
    right: Math.min(w - 1, best.maxX * step + step),
    top: best.minY * step,
    bottom: Math.min(h - 1, best.maxY * step + step),
    area: bestArea * step * step
  };
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

function fitLine(points) {
  const n = points.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += points[i].x;
    my += points[i].y;
  }
  mx /= n;
  my /= n;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let i = 0; i < n; i++) {
    const dx = points[i].x - mx;
    const dy = points[i].y - my;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  let a = -Math.sin(theta);
  let b = Math.cos(theta);
  const norm = hypot(a, b) || 1;
  a /= norm;
  b /= norm;
  const c = -a * mx - b * my;
  return { a: a, b: b, c: c };
}

function signedDist(line, x, y) {
  return line.a * x + line.b * y + line.c;
}

function orientInward(line, cx, cy) {
  if (signedDist(line, cx, cy) < 0) {
    return { a: -line.a, b: -line.b, c: -line.c };
  }
  return line;
}

function trimLine(points) {
  let line = fitLine(points);
  if (!line) return { line: null, points: [] };
  const dist = points.map(function (p) { return signedDist(line, p.x, p.y); });
  const med = median(dist);
  const abs = dist.map(function (d) { return Math.abs(d - med); });
  const mad = median(abs) || 0.4;
  const keep = [];
  const limit = Math.max(1.25, mad * 3.5);
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(dist[i] - med) <= limit) keep.push(points[i]);
  }
  if (keep.length >= 8) {
    line = fitLine(keep);
    return { line: line, points: keep };
  }
  return { line: line, points: points };
}

function intersect(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-8) return null;
  const x = (-l1.c * l2.b + l2.c * l1.b) / det;
  const y = (-l1.a * l2.c + l2.a * l1.c) / det;
  return { x: x, y: y };
}

function collectEdgePoints(data, w, h, paper, threshold, x0, y0, x1, y1, outwardX, outwardY, reach) {
  const len = hypot(x1 - x0, y1 - y0);
  if (len < 4) return [];
  const points = [];
  const step = 0.5;
  const steps = Math.ceil((2 * reach) / step);
  const samples = Math.max(12, Math.floor(len / 2));
  for (let s = 0; s <= samples; s++) {
    const u = s / samples;
    const px = x0 + (x1 - x0) * u;
    const py = y0 + (y1 - y0) * u;
    const dists = [];
    const ts = [];
    for (let k = 0; k <= steps; k++) {
      const t = reach - k * step;
      const x = px + outwardX * t;
      const y = py + outwardY * t;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const rgb = sampleRgb(data, w, h, x, y);
      dists.push(distToPaper(rgb[0], rgb[1], rgb[2], paper));
      ts.push(t);
    }
    let bestK = -1;
    let bestRise = 0;
    for (let k = 1; k < dists.length; k++) {
      const rise = dists[k] - dists[k - 1];
      if (rise > bestRise) {
        bestRise = rise;
        bestK = k;
      }
    }
    if (bestK > 0 && bestRise >= 8) {
      let lo = bestK - 1;
      let hi = bestK;
      while (lo > 0 && dists[lo] - dists[lo - 1] > bestRise * 0.3) lo -= 1;
      while (hi < dists.length - 1 && dists[hi + 1] - dists[hi] > bestRise * 0.3) hi += 1;
      const target = 0.5 * (dists[lo] + dists[hi]);
      let hitT = ts[bestK];
      for (let k = lo + 1; k <= hi; k++) {
        if (dists[k - 1] <= target && dists[k] >= target) {
          const f = (target - dists[k - 1]) / ((dists[k] - dists[k - 1]) || 1);
          hitT = ts[k - 1] + (ts[k] - ts[k - 1]) * f;
          break;
        }
      }
      points.push({ x: px + outwardX * hitT, y: py + outwardY * hitT });
    }
  }
  return points;
}

function findCardQuad(data, w, h, paper, threshold, bbox, ppm) {
  const reach = 4 * ppm;
  const cx0 = (bbox.left + bbox.right) / 2;
  const cy0 = (bbox.top + bbox.bottom) / 2;
  const sides = [
    {
      name: 'top',
      x0: bbox.left + (bbox.right - bbox.left) * EDGE_FIT_MARGIN,
      y0: bbox.top,
      x1: bbox.right - (bbox.right - bbox.left) * EDGE_FIT_MARGIN,
      y1: bbox.top,
      ox: 0,
      oy: -1
    },
    {
      name: 'bottom',
      x0: bbox.left + (bbox.right - bbox.left) * EDGE_FIT_MARGIN,
      y0: bbox.bottom,
      x1: bbox.right - (bbox.right - bbox.left) * EDGE_FIT_MARGIN,
      y1: bbox.bottom,
      ox: 0,
      oy: 1
    },
    {
      name: 'left',
      x0: bbox.left,
      y0: bbox.top + (bbox.bottom - bbox.top) * EDGE_FIT_MARGIN,
      x1: bbox.left,
      y1: bbox.bottom - (bbox.bottom - bbox.top) * EDGE_FIT_MARGIN,
      ox: -1,
      oy: 0
    },
    {
      name: 'right',
      x0: bbox.right,
      y0: bbox.top + (bbox.bottom - bbox.top) * EDGE_FIT_MARGIN,
      x1: bbox.right,
      y1: bbox.bottom - (bbox.bottom - bbox.top) * EDGE_FIT_MARGIN,
      ox: 1,
      oy: 0
    }
  ];
  const lines = {};
  sides.forEach(function (side) {
    const raw = collectEdgePoints(
      data, w, h, paper, threshold,
      side.x0, side.y0, side.x1, side.y1,
      side.ox, side.oy, reach
    );
    const fitted = trimLine(raw);
    if (!fitted.line || fitted.points.length < 8) {
      lines[side.name] = null;
      return;
    }
    lines[side.name] = orientInward(fitted.line, cx0, cy0);
  });
  if (!lines.top || !lines.bottom || !lines.left || !lines.right) return null;
  const tl = intersect(lines.top, lines.left);
  const tr = intersect(lines.top, lines.right);
  const br = intersect(lines.bottom, lines.right);
  const bl = intersect(lines.bottom, lines.left);
  if (!tl || !tr || !br || !bl) return null;
  const widthPx = 0.5 * (
    Math.abs(signedDist(lines.right, tl.x, tl.y)) +
    Math.abs(signedDist(lines.right, bl.x, bl.y))
  );
  const heightPx = 0.5 * (
    Math.abs(signedDist(lines.bottom, tl.x, tl.y)) +
    Math.abs(signedDist(lines.bottom, tr.x, tr.y))
  );
  return {
    lines: lines,
    corners: { tl: tl, tr: tr, br: br, bl: bl },
    widthMm: widthPx / ppm,
    heightMm: heightPx / ppm
  };
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
        const jump = MAX_SLOPE * stepMm * back;
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

function measureSide(data, w, h, quad, sideName, ppm) {
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
  const lengthMm = lengthPx / ppm;
  const nx = normalLine.a;
  const ny = normalLine.b;
  const stepPx = STATION_STEP_MM * ppm;
  const stations = [];
  const start = lengthPx * SIDE_MARGIN;
  const end = lengthPx * (1 - SIDE_MARGIN);
  for (let s = start; s <= end; s += stepPx) {
    const t = (s - start) / Math.max(1e-6, end - start);
    const x = a.x + (b.x - a.x) * (s / lengthPx);
    const y = a.y + (b.y - a.y) * (s / lengthPx);
    const nSteps = Math.round((SEARCH_TO_MM - SEARCH_FROM_MM) / DEPTH_STEP_MM);
    const profile = new Array(nSteps);
    for (let i = 0; i < nSteps; i++) {
      const depthMm = SEARCH_FROM_MM + i * DEPTH_STEP_MM;
      const px = x + nx * depthMm * ppm;
      const py = y + ny * depthMm * ppm;
      profile[i] = sampleRgb(data, w, h, px, py);
    }
    stations.push({
      x: x,
      y: y,
      nx: nx,
      ny: ny,
      alongMm: s / ppm,
      t: t,
      candidates: rayCandidates(profile, SEARCH_FROM_MM, DEPTH_STEP_MM)
    });
  }
  let pool = stations;
  let best = null;
  for (let layer = 0; layer < MAX_LAYERS; layer++) {
    const path = linkOutline(pool, STATION_STEP_MM);
    const summary = summarizePath(path, pool.length);
    summary.layer = layer;
    if (!best) best = summary;
    if (!summary.withheld || (summary.reason !== 'partial' && summary.reason !== 'no-outline')) {
      best = summary;
      break;
    }
    if (!path || !path.length) break;
    const cut = Math.max.apply(null, path.map(function (p) { return p.depth; })) + 0.25;
    let removed = 0;
    pool = pool.map(function (st) {
      const next = st.candidates.filter(function (c) { return c.depth > cut; });
      removed += st.candidates.length - next.length;
      return {
        x: st.x,
        y: st.y,
        nx: st.nx,
        ny: st.ny,
        alongMm: st.alongMm,
        t: st.t,
        candidates: next
      };
    });
    if (!removed) break;
    best = summary;
  }
  best.side = sideName;
  best.lengthMm = lengthMm;
  best.edge = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, nx: nx, ny: ny };
  return best;
}

function measureImage(data, w, h, dpi) {
  const ppm = pxPerMm(dpi);
  const paperModel = estimatePaper(data, w, h);
  const bbox = largestComponentBBox(data, w, h, paperModel.paper, paperModel.threshold);
  if (!bbox) {
    return { ok: false, error: 'no-card', dpi: dpi };
  }
  const quad = findCardQuad(data, w, h, paperModel.paper, paperModel.threshold, bbox, ppm);
  if (!quad) {
    return { ok: false, error: 'no-quad', dpi: dpi, paper: paperModel.paper };
  }
  const sides = {};
  ['top', 'bottom', 'left', 'right'].forEach(function (name) {
    sides[name] = measureSide(data, w, h, quad, name, ppm);
  });
  const widthErr = Math.abs(quad.widthMm - NOMINAL_W_MM);
  const heightErr = Math.abs(quad.heightMm - NOMINAL_H_MM);
  const swapped = Math.abs(quad.widthMm - NOMINAL_H_MM) + Math.abs(quad.heightMm - NOMINAL_W_MM);
  const direct = widthErr + heightErr;
  return {
    ok: true,
    dpi: dpi,
    paper: paperModel.paper.map(function (v) { return Math.round(v); }),
    threshold: roundMm(paperModel.threshold),
    cardMm: {
      width: roundMm(quad.widthMm),
      height: roundMm(quad.heightMm)
    },
    sizeOk: Math.min(direct, swapped) < 2.5,
    corners: quad.corners,
    sides: sides
  };
}

function borderRatios(sides) {
  function mmOf(name) {
    const side = sides && sides[name];
    if (!side || side.withheld || side.mm == null) return null;
    return side.mm;
  }
  function quot(a, b) {
    if (a == null || b == null || b === 0) return null;
    return Math.round((a / b) * 1000) / 1000;
  }
  function share(a, b) {
    if (a == null || b == null || a + b === 0) return null;
    return Math.round((a / (a + b)) * 1000) / 1000;
  }
  const top = mmOf('top');
  const bottom = mmOf('bottom');
  const left = mmOf('left');
  const right = mmOf('right');
  return {
    leftOverRight: quot(left, right),
    topOverBottom: quot(top, bottom),
    leftShare: share(left, right),
    topShare: share(top, bottom)
  };
}

function sidePublic(side) {
  return {
    mm: side.mm == null ? null : roundMm(side.mm),
    confidence: side.confidence == null ? 0 : Math.round(side.confidence * 1000) / 1000,
    withheld: !!side.withheld,
    reason: side.reason || null,
    shape: side.shape || null,
    coverage: side.coverage == null ? null : Math.round(side.coverage * 1000) / 1000,
    points: (side.used || []).map(function (p) {
      return { alongMm: roundMm(p.alongMm), depthMm: roundMm(p.depth) };
    })
  };
}

function rotate180(data, w, h) {
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = ((h - 1 - y) * w + (w - 1 - x)) * 3;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
    }
  }
  return out;
}

const SWAP_180 = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function agreeEdges(upSides, rotSides) {
  const out = {};
  ['top', 'bottom', 'left', 'right'].forEach(function (side) {
    const a = upSides[side];
    const b = rotSides[SWAP_180[side]];
    const upMm = a && !a.withheld ? a.mm : null;
    const rotMm = b && !b.withheld ? b.mm : null;
    let diff = null;
    let agree = false;
    let mm = null;
    let withheld = true;
    if (upMm != null && rotMm != null) {
      diff = Math.abs(upMm - rotMm);
      agree = diff <= AGREE_MM;
      if (agree) {
        mm = (upMm + rotMm) / 2;
        withheld = false;
      }
    }
    const confs = [];
    if (a && a.confidence) confs.push(a.confidence);
    if (b && b.confidence) confs.push(b.confidence);
    out[side] = {
      mm: mm == null ? null : roundMm(mm),
      confidence: confs.length ? Math.round(Math.min.apply(null, confs) * 1000) / 1000 : 0,
      withheld: withheld,
      approved: false,
      upMm: upMm == null ? null : roundMm(upMm),
      rot180Mm: rotMm == null ? null : roundMm(rotMm),
      diffMm: diff == null ? null : roundMm(diff),
      agree: agree
    };
  });
  return out;
}

function loadApproved(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keep = {};
    const cards = prev.cards || {};
    Object.keys(cards).forEach(function (id) {
      keep[id] = {};
      const sides = (cards[id] && cards[id].sides) || {};
      Object.keys(sides).forEach(function (side) {
        keep[id][side] = !!sides[side].approved;
      });
    });
    return keep;
  } catch (err) {
    return {};
  }
}

function buildAnswerKey(measurements, dpi, previousApproved) {
  const cards = {};
  measurements.forEach(function (m) {
    if (!cards[m.card]) {
      cards[m.card] = { up: null, rot: null };
    }
    if (m.orientation === 'up') cards[m.card].up = m;
    if (m.orientation === '180') cards[m.card].rot = m;
  });
  const outCards = {};
  Object.keys(cards).sort().forEach(function (id) {
    const pair = cards[id];
    const upSides = pair.up ? pair.up.result.sides : {};
    const rotSides = pair.rot ? pair.rot.result.sides : {};
    const agreed = agreeEdges(upSides, rotSides);
    const prev = previousApproved[id] || {};
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      if (prev[side]) agreed[side].approved = true;
    });
    function scanRecord(entry) {
      if (!entry || !entry.result || !entry.result.ok) {
        return { file: entry ? entry.file : null, error: entry && entry.result ? entry.result.error : 'missing' };
      }
      const sides = {};
      ['top', 'bottom', 'left', 'right'].forEach(function (side) {
        sides[side] = sidePublic(entry.result.sides[side]);
      });
      return {
        file: path.basename(entry.file),
        cardMm: entry.result.cardMm,
        sizeOk: entry.result.sizeOk,
        ratios: borderRatios(sides),
        sides: sides
      };
    }
    outCards[id] = {
      sides: agreed,
      ratios: borderRatios(agreed),
      scans: {
        up: scanRecord(pair.up),
        '180': scanRecord(pair.rot)
      }
    };
  });
  return {
    version: 1,
    dpi: dpi,
    nominalCardMm: { width: NOMINAL_W_MM, height: NOMINAL_H_MM },
    agreeToleranceMm: AGREE_MM,
    definition: 'Border is the perpendicular distance from the card edge to the outermost points of the continuous design-block outline on that side. Partial margin marks are not the outline. Unapproved until a person checks the overlay.',
    cards: outCards
  };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
  });
}

async function writeOverlay(file, result, dest) {
  const meta = await sharp(file).metadata();
  const long = Math.max(meta.width, meta.height);
  const target = 1600;
  const scale = long > target ? target / long : 1;
  const dw = Math.round(meta.width * scale);
  const dh = Math.round(meta.height * scale);
  const base = await sharp(file).rotate().resize(dw, dh).png().toBuffer();
  if (!result || !result.ok) {
    await sharp(base).png().toFile(dest);
    return dest;
  }
  const parts = [];
  const c = result.corners;
  function sx(x) { return (x * scale).toFixed(1); }
  function sy(y) { return (y * scale).toFixed(1); }
  parts.push(
    '<polygon points="' +
    [c.tl, c.tr, c.br, c.bl].map(function (p) { return sx(p.x) + ',' + sy(p.y); }).join(' ') +
    '" fill="none" stroke="#39ff14" stroke-width="2"/>'
  );
  ['top', 'bottom', 'left', 'right'].forEach(function (name) {
    const side = result.sides[name];
    if (!side || !side.edge) return;
    const col = side.withheld ? '#ff5a36' : '#ffe14a';
    (side.points || []).forEach(function (p) {
      const ox = p.x + side.edge.nx * p.depth * pxPerMm(result.dpi);
      const oy = p.y + side.edge.ny * p.depth * pxPerMm(result.dpi);
      parts.push('<circle cx="' + sx(ox) + '" cy="' + sy(oy) + '" r="2.2" fill="' + col + '" fill-opacity="0.85"/>');
    });
    (side.used || []).forEach(function (p) {
      const ox = p.x + side.edge.nx * p.depth * pxPerMm(result.dpi);
      const oy = p.y + side.edge.ny * p.depth * pxPerMm(result.dpi);
      parts.push('<circle cx="' + sx(ox) + '" cy="' + sy(oy) + '" r="3.4" fill="none" stroke="#ffffff" stroke-width="1"/>');
    });
    if (!side.withheld && side.mm != null) {
      const depthPx = side.mm * pxPerMm(result.dpi);
      const a = side.edge.a;
      const b = side.edge.b;
      const ax = a.x + side.edge.nx * depthPx;
      const ay = a.y + side.edge.ny * depthPx;
      const bx = b.x + side.edge.nx * depthPx;
      const by = b.y + side.edge.ny * depthPx;
      parts.push(
        '<line x1="' + sx(ax) + '" y1="' + sy(ay) + '" x2="' + sx(bx) + '" y2="' + sy(by) +
        '" stroke="#3ee0ff" stroke-width="2"/>'
      );
    }
    const labelX = (side.edge.a.x + side.edge.b.x) / 2 + side.edge.nx * 40 / scale;
    const labelY = (side.edge.a.y + side.edge.b.y) / 2 + side.edge.ny * 40 / scale;
    const text = side.withheld
      ? name + ' withheld'
      : name + ' ' + side.mm.toFixed(2) + ' mm';
    const anchor = name === 'right' ? 'end' : (name === 'left' ? 'start' : 'middle');
    parts.push(
      '<text x="' + sx(labelX) + '" y="' + sy(labelY) + '" fill="#ffffff" font-size="22" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke" text-anchor="' + anchor + '" dominant-baseline="middle">' +
      esc(text) + '</text>'
    );
  });
  const sizeText = 'card ' + result.cardMm.width.toFixed(2) + ' x ' + result.cardMm.height.toFixed(2) + ' mm';
  parts.push(
    '<text x="16" y="32" fill="#ffffff" font-size="22" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke">' +
    esc(sizeText) + '</text>'
  );
  const svg = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + dw + '" height="' + dh + '">' +
    parts.join('') + '</svg>';
  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(dest);
  return dest;
}

async function loadRaster(file) {
  const meta = await sharp(file).rotate().metadata();
  const w = meta.width;
  const h = meta.height;
  const long = Math.max(w, h);
  if (long <= 2600) {
    const raw = await sharp(file).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
      full: { data: raw.data, width: raw.info.width, height: raw.info.height },
      origin: { x: 0, y: 0 },
      sourceWidth: raw.info.width,
      sourceHeight: raw.info.height
    };
  }
  const previewW = Math.round(w * (1800 / long));
  const preview = await sharp(file).rotate().resize({ width: previewW }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const paperModel = estimatePaper(preview.data, preview.info.width, preview.info.height);
  const bbox = largestComponentBBox(
    preview.data, preview.info.width, preview.info.height,
    paperModel.paper, paperModel.threshold
  );
  if (!bbox) {
    return { error: 'no-card', sourceWidth: w, sourceHeight: h };
  }
  const scale = w / preview.info.width;
  const pad = Math.round(8 * pxPerMm(DEFAULT_DPI));
  let left = Math.max(0, Math.floor(bbox.left * scale) - pad);
  let top = Math.max(0, Math.floor(bbox.top * scale) - pad);
  let right = Math.min(w, Math.ceil(bbox.right * scale) + pad);
  let bottom = Math.min(h, Math.ceil(bbox.bottom * scale) + pad);
  const crop = await sharp(file).rotate().extract({
    left: left,
    top: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    full: { data: crop.data, width: crop.info.width, height: crop.info.height },
    origin: { x: left, y: top },
    sourceWidth: w,
    sourceHeight: h
  };
}

function shiftResult(result, origin) {
  if (!result || !result.ok || (origin.x === 0 && origin.y === 0)) return result;
  const c = result.corners;
  ['tl', 'tr', 'br', 'bl'].forEach(function (k) {
    c[k] = { x: c[k].x + origin.x, y: c[k].y + origin.y };
  });
  ['top', 'bottom', 'left', 'right'].forEach(function (name) {
    const side = result.sides[name];
    if (!side || !side.edge) return;
    side.edge.a = { x: side.edge.a.x + origin.x, y: side.edge.a.y + origin.y };
    side.edge.b = { x: side.edge.b.x + origin.x, y: side.edge.b.y + origin.y };
    const shifted = new Set();
    (side.points || []).concat(side.used || []).forEach(function (p) {
      if (shifted.has(p)) return;
      shifted.add(p);
      p.x += origin.x;
      p.y += origin.y;
    });
  });
  return result;
}

async function measureFile(file, dpi) {
  const loaded = await loadRaster(file);
  if (loaded.error) return { ok: false, error: loaded.error, dpi: dpi };
  const result = measureImage(loaded.full.data, loaded.full.width, loaded.full.height, dpi);
  return shiftResult(result, loaded.origin);
}

function parseScanName(file) {
  const base = path.basename(file);
  const m = /^(TD-\d+)_(up|180)\.png$/i.exec(base);
  if (!m) return null;
  return { card: m[1].toUpperCase(), orientation: m[2].toLowerCase(), file: file };
}

function defaultFlatbedDir() {
  if (process.env.JUDGE_FLATBED_DIR) return process.env.JUDGE_FLATBED_DIR;
  const candidates = [];
  if (process.env.JUDGE_SCAN_REPO) candidates.push(path.join(process.env.JUDGE_SCAN_REPO, 'flatbed'));
  candidates.push('/tmp/judge-scans/flatbed');
  candidates.push(path.join(os.homedir(), 'the-judge-scans', 'flatbed'));
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return candidates[0] || candidates[candidates.length - 1];
}

function listScans(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function (name) { return /^TD-\d+_(up|180)\.png$/i.test(name); })
    .map(function (name) { return path.join(dir, name); })
    .sort();
}

function printReport(key) {
  const rows = [];
  const cards = key.cards || {};
  Object.keys(cards).sort().forEach(function (id) {
    const card = cards[id];
    const up = card.scans && card.scans.up;
    const rot = card.scans && card.scans['180'];
    console.log(id +
      '  up ' + (up && up.cardMm ? up.cardMm.width.toFixed(2) + 'x' + up.cardMm.height.toFixed(2) : '—') +
      ' mm   180 ' + (rot && rot.cardMm ? rot.cardMm.width.toFixed(2) + 'x' + rot.cardMm.height.toFixed(2) : '—') +
      ' mm');
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      const s = card.sides[side];
      rows.push({
        card: id,
        side: side,
        up: s.upMm,
        rot: s.rot180Mm,
        diff: s.diffMm,
        agree: s.agree,
        mm: s.mm,
        conf: s.confidence,
        approved: s.approved
      });
      console.log(
        '  ' + side.padEnd(6, ' ') +
        ' up ' + fmt(s.upMm) +
        '  180 ' + fmt(s.rot180Mm) +
        '  diff ' + fmt(s.diffMm) +
        '  ' + (s.agree ? 'agree' : 'WITHHELD') +
        '  conf ' + (s.confidence == null ? '—' : s.confidence.toFixed(2)) +
        '  approved ' + (s.approved ? 'yes' : 'no')
      );
    });
    const ratios = card.ratios || {};
    console.log(
      '  L/R ' + fmtRatio(ratios.leftOverRight) +
      '  left share ' + fmtShare(ratios.leftShare) +
      '   T/B ' + fmtRatio(ratios.topOverBottom) +
      '  top share ' + fmtShare(ratios.topShare)
    );
  });
  return rows;
}

function fmt(v) {
  return v == null ? '  —  ' : v.toFixed(3).padStart(6, ' ');
}

function fmtRatio(v) {
  return v == null ? '—' : v.toFixed(3);
}

function fmtShare(v) {
  return v == null ? '—' : (v * 100).toFixed(1) + '%';
}

async function runDirectory(dir, opts) {
  const files = listScans(dir);
  if (!files.length) {
    return { ok: false, error: 'no scans in ' + dir, files: [] };
  }
  const dpi = opts.dpi || DEFAULT_DPI;
  const measurements = [];
  for (let i = 0; i < files.length; i++) {
    const parsed = parseScanName(files[i]);
    process.stdout.write('measure ' + path.basename(files[i]) + '\n');
    const result = await measureFile(files[i], dpi);
    measurements.push({
      card: parsed.card,
      orientation: parsed.orientation,
      file: files[i],
      result: result
    });
    if (opts.overlayDir) {
      fs.mkdirSync(opts.overlayDir, { recursive: true });
      const dest = path.join(opts.overlayDir, parsed.card + '_' + parsed.orientation + '.png');
      await writeOverlay(files[i], result, dest);
      if (opts.artifactDir) {
        fs.mkdirSync(opts.artifactDir, { recursive: true });
        const copy = path.join(opts.artifactDir, parsed.card + '_' + parsed.orientation + '.png');
        fs.copyFileSync(dest, copy);
      }
    }
  }
  const previous = loadApproved(opts.out);
  const key = buildAnswerKey(measurements, dpi, previous);
  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(key, null, 2) + '\n');
  }
  printReport(key);
  return { ok: true, key: key, measurements: measurements };
}

function drawSynthetic(opts) {
  const dpi = opts.dpi;
  const ppm = pxPerMm(dpi);
  const margin = Math.round(opts.marginMm * ppm);
  const cardW = opts.cardWmm * ppm;
  const cardH = opts.cardHmm * ppm;
  const w = Math.ceil(margin * 2 + cardW);
  const h = Math.ceil(margin * 2 + cardH);
  const data = Buffer.alloc(w * h * 3);
  const pink = opts.pink;
  const white = opts.white;
  for (let i = 0; i < data.length; i += 3) {
    data[i] = pink[0];
    data[i + 1] = pink[1];
    data[i + 2] = pink[2];
  }
  function setPix(x, y, rgb) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  }
  const x0 = margin;
  const y0 = margin;
  const x1 = margin + cardW;
  const y1 = margin + cardH;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const dTop = (y - y0) / ppm;
      const dBot = (y1 - y) / ppm;
      const dLeft = (x - x0) / ppm;
      const dRight = (x1 - x) / ppm;
      if (dTop < 0 || dBot < 0 || dLeft < 0 || dRight < 0) continue;
      let rgb = white;
      const bands = [
        { depth: dTop, edge: opts.top, along: (x - x0) / cardW },
        { depth: dBot, edge: opts.bottom, along: (x - x0) / cardW },
        { depth: dLeft, edge: opts.left, along: (y - y0) / cardH },
        { depth: dRight, edge: opts.right, along: (y - y0) / cardH }
      ];
      for (let k = 0; k < bands.length; k++) {
        const band = bands[k];
        const outer = band.edge.depth(band.along);
        const marks = band.edge.marks || [];
        for (let m = 0; m < marks.length; m++) {
          const mark = marks[m];
          if (band.along >= mark.from && band.along <= mark.to &&
            band.depth >= mark.inner && band.depth < outer) {
            rgb = mark.color;
          }
        }
      }
      let best = null;
      for (let k = 0; k < bands.length; k++) {
        const band = bands[k];
        const outer = band.edge.depth(band.along);
        if (band.depth >= outer && (!best || band.depth < best.depth)) best = band;
      }
      if (best) {
        const outer = best.edge.depth(best.along);
        rgb = best.depth >= outer + opts.frameMm ? opts.photo : best.edge.color;
      }
      setPix(x, y, rgb);
    }
  }
  return { data: data, width: w, height: h, dpi: dpi };
}

function constantEdge(depth, color, marks) {
  return {
    depth: function () { return depth; },
    color: color,
    marks: marks || []
  };
}

async function selfTest() {
  const dpi = 600;
  const pink = [232, 150, 186];
  const white = [246, 246, 244];
  const photo = [92, 118, 78];
  const blue = [28, 72, 168];
  let failed = 0;
  function check(label, cond, detail) {
    if (cond) {
      console.log('PASS', label);
    } else {
      failed += 1;
      console.error('FAIL', label, detail !== undefined ? detail : '');
    }
  }
  function near(v, expect, tol) {
    return v != null && Math.abs(v - expect) <= tol;
  }

  const partial = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.4,
    top: constantEdge(4.0, blue, [{ from: 0.02, to: 0.28, inner: 1.0, color: [210, 36, 48] }]),
    bottom: constantEdge(3.6, blue, []),
    left: constantEdge(3.2, blue, []),
    right: constantEdge(5.1, blue, [{ from: 0.4, to: 0.58, inner: 1.6, color: [16, 16, 18] }])
  });
  const partialM = measureImage(partial.data, partial.width, partial.height, dpi);
  check('partial card found', partialM.ok, partialM.error);
  if (partialM.ok) {
    check('partial width', near(partialM.cardMm.width, NOMINAL_W_MM, 0.15), partialM.cardMm);
    check('partial height', near(partialM.cardMm.height, NOMINAL_H_MM, 0.15), partialM.cardMm);
    check('partial ignores corner stripe', near(partialM.sides.top.mm, 4.0, 0.05) && !partialM.sides.top.withheld,
      sideBrief(partialM.sides.top));
    check('partial bottom', near(partialM.sides.bottom.mm, 3.6, 0.05), sideBrief(partialM.sides.bottom));
    check('partial left', near(partialM.sides.left.mm, 3.2, 0.05), sideBrief(partialM.sides.left));
    check('partial ignores side logo', near(partialM.sides.right.mm, 5.1, 0.05) && !partialM.sides.right.withheld,
      sideBrief(partialM.sides.right));
    const ratios = borderRatios(partialM.sides);
    check('partial L/R share', near(ratios.leftShare, 3.2 / (3.2 + 5.1), 0.01), ratios);
    check('partial T/B share', near(ratios.topShare, 4.0 / (4.0 + 3.6), 0.01), ratios);
    const rot = rotate180(partial.data, partial.width, partial.height);
    const rotM = measureImage(rot, partial.width, partial.height, dpi);
    const agreed = agreeEdges(partialM.sides, rotM.sides);
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      check('partial 180 ' + side, agreed[side].agree && agreed[side].diffMm <= AGREE_MM, agreed[side]);
    });
  }

  const mixed = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.3,
    top: constantEdge(3.4, [198, 202, 208], []),
    bottom: constantEdge(4.2, [24, 36, 92], []),
    left: constantEdge(2.8, [22, 24, 30], []),
    right: constantEdge(4.8, [206, 170, 64], [])
  });
  const mixedM = measureImage(mixed.data, mixed.width, mixed.height, dpi);
  check('mixed card found', mixedM.ok, mixedM.error);
  if (mixedM.ok) {
    check('mixed top silver', near(mixedM.sides.top.mm, 3.4, 0.05), sideBrief(mixedM.sides.top));
    check('mixed bottom navy', near(mixedM.sides.bottom.mm, 4.2, 0.05), sideBrief(mixedM.sides.bottom));
    check('mixed left dark', near(mixedM.sides.left.mm, 2.8, 0.05), sideBrief(mixedM.sides.left));
    check('mixed right gold', near(mixedM.sides.right.mm, 4.8, 0.05), sideBrief(mixedM.sides.right));
  }

  const curved = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.5,
    top: {
      depth: function (along) {
        const u = 2 * (along - 0.5);
        return 3.2 + 2.2 * u * u;
      },
      color: [186, 146, 48],
      marks: []
    },
    bottom: constantEdge(4.4, [186, 146, 48], []),
    left: constantEdge(3.8, [186, 146, 48], []),
    right: constantEdge(3.8, [186, 146, 48], [])
  });
  const curvedM = measureImage(curved.data, curved.width, curved.height, dpi);
  check('curve card found', curvedM.ok, curvedM.error);
  if (curvedM.ok) {
    check('curve uses the extreme', near(curvedM.sides.top.mm, 3.2, 0.08) && !curvedM.sides.top.withheld,
      sideBrief(curvedM.sides.top));
    check('curve other sides', near(curvedM.sides.bottom.mm, 4.4, 0.05) && near(curvedM.sides.left.mm, 3.8, 0.05),
      { bottom: sideBrief(curvedM.sides.bottom), left: sideBrief(curvedM.sides.left) });
    const rot = rotate180(curved.data, curved.width, curved.height);
    const rotM = measureImage(rot, curved.width, curved.height, dpi);
    const agreed = agreeEdges(curvedM.sides, rotM.sides);
    check('curve 180 agrees', agreed.top.agree && agreed.top.diffMm <= AGREE_MM, agreed.top);
  }

  const tiltedPng = await sharp(mixed.data, {
    raw: { width: mixed.width, height: mixed.height, channels: 3 }
  }).rotate(2, { background: { r: pink[0], g: pink[1], b: pink[2] } }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tiltedM = measureImage(tiltedPng.data, tiltedPng.info.width, tiltedPng.info.height, dpi);
  check('tilted card found', tiltedM.ok && tiltedM.sizeOk, tiltedM.ok ? tiltedM.cardMm : tiltedM.error);
  if (tiltedM.ok) {
    check('tilted top', near(tiltedM.sides.top.mm, 3.4, 0.08), sideBrief(tiltedM.sides.top));
    check('tilted bottom', near(tiltedM.sides.bottom.mm, 4.2, 0.08), sideBrief(tiltedM.sides.bottom));
    check('tilted left', near(tiltedM.sides.left.mm, 2.8, 0.08), sideBrief(tiltedM.sides.left));
    check('tilted right', near(tiltedM.sides.right.mm, 4.8, 0.08), sideBrief(tiltedM.sides.right));
  }

  const tmpCard = path.join(os.tmpdir(), 'flatbed-selftest-card.png');
  const tmpOver = path.join(os.tmpdir(), 'flatbed-selftest-overlay.png');
  const tmpCurve = path.join(os.tmpdir(), 'flatbed-selftest-curve.png');
  await sharp(partial.data, { raw: { width: partial.width, height: partial.height, channels: 3 } }).png().toFile(tmpCard);
  await writeOverlay(tmpCard, partialM, tmpOver);
  await sharp(curved.data, { raw: { width: curved.width, height: curved.height, channels: 3 } }).png().toFile(tmpCard);
  await writeOverlay(tmpCard, curvedM, tmpCurve);
  check('overlay written', fs.existsSync(tmpOver) && fs.statSync(tmpOver).size > 1000 && fs.statSync(tmpCurve).size > 1000, tmpOver);

  if (failed) {
    console.error(failed + ' self-test failure(s)');
    process.exitCode = 1;
  } else {
    console.log('self-test ok');
  }
  return failed;
}

function sideBrief(side) {
  if (!side) return null;
  return {
    mm: side.mm == null ? null : roundMm(side.mm),
    withheld: side.withheld,
    reason: side.reason,
    shape: side.shape,
    coverage: side.coverage == null ? null : Math.round(side.coverage * 1000) / 1000,
    rms: side.rms == null ? null : roundMm(side.rms),
    conf: side.confidence == null ? null : Math.round(side.confidence * 100) / 100
  };
}

function parseArgs(argv) {
  const opts = {
    flatbed: null,
    out: path.join('reference', 'answer_key.json'),
    overlayDir: path.join('reference', 'overlays'),
    artifactDir: '/opt/cursor/artifacts/flatbed-overlays',
    dpi: DEFAULT_DPI,
    selfTest: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') opts.selfTest = true;
    else if (a === '--flatbed') opts.flatbed = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--overlay-dir') opts.overlayDir = argv[++i];
    else if (a === '--dpi') opts.dpi = Number(argv[++i]);
    else if (a === '--help') opts.help = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: node scripts/measure_flatbed.js [--flatbed DIR] [--out reference/answer_key.json] [--overlay-dir reference/overlays] [--dpi 1200] [--self-test]');
    return;
  }
  if (opts.selfTest) {
    await selfTest();
    return;
  }
  const dir = opts.flatbed || defaultFlatbedDir();
  const ran = await runDirectory(dir, opts);
  if (!ran.ok) {
    console.error(ran.error || 'no scans');
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  measureImage: measureImage,
  measureFile: measureFile,
  agreeEdges: agreeEdges,
  buildAnswerKey: buildAnswerKey,
  AGREE_MM: AGREE_MM
};
