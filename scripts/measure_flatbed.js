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
 * side, is not the outline. The outline may change element along a side;
 * the width is then the outermost points of the design block. If those
 * points are not clear, that side is withheld.
 *
 * A found quad that is not a card fails closed. sizeOk is true only when
 * the quad is within 2.5 mm (sum of absolute edge errors) of 63.5 × 88.9 mm
 * in either orientation. Otherwise every side is withheld with reason
 * not-card-sized, and no width is published.
 *
 * A 180° pair cancels a directional scanner bias. The answer-key value is
 * the mean of the two orientations. An axis is kept only when the bias
 * estimated from each of its two sides agrees. The bias is reported and
 * is never subtracted as a fixed correction.
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
const BIAS_AGREE_MM = 0.02;
const PARTIAL_COVERAGE = 0.32;

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
  const cornerDists = [];
  for (let k = 0; k < corners.length; k++) {
    const x0 = corners[k][0];
    const y0 = corners[k][1];
    for (let y = y0; y < y0 + ch; y += 2) {
      for (let x = x0; x < x0 + cw; x += 2) {
        const i = (y * w + x) * 3;
        cornerDists.push(distToPaper(data[i], data[i + 1], data[i + 2], paper));
      }
    }
  }
  const med = median(cornerDists) || 0;
  const mad = median(cornerDists.map(function (d) { return Math.abs(d - med); })) || 1;
  const sorted = cornerDists.slice().sort(function (a, b) { return a - b; });
  const p98 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] || 0;
  // Above the sheet texture, below a printed card. The card edge is this
  // crossing, not the strongest ink step further inside.
  let threshold = Math.max(med + 8 * mad, p98 + 15, 22);
  if (!isFinite(threshold)) threshold = 22;
  return { paper: paper, threshold: threshold };
}

function componentBoxes(data, w, h, paper, threshold) {
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
  const boxes = [];
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
      if (area < 50) continue;
      boxes.push({
        left: minX * step,
        right: Math.min(w - 1, maxX * step + step),
        top: minY * step,
        bottom: Math.min(h - 1, maxY * step + step),
        area: area * step * step
      });
    }
  }
  return boxes;
}

function largestComponentBBox(data, w, h, paper, threshold) {
  const boxes = componentBoxes(data, w, h, paper, threshold);
  if (!boxes.length) return null;
  let best = boxes[0];
  for (let i = 1; i < boxes.length; i++) {
    if (boxes[i].area > best.area) best = boxes[i];
  }
  return best;
}

/**
 * One row on a letter glass (215.9 mm wide), every card portrait and upright
 * the same way as its single-card "up" scan. Reading order is left to right.
 * Gap is bare pink paper. The row is centered, so the side paper is whatever
 * the glass has left. Crop the full glass width and 110 mm of height at 1200 dpi.
 */
const MULTI_GAP_MM = 6;
const MULTI_CROP_MARGIN_MM = 3;
const MULTI_GLASS_WIDTH_MM = 215.9;
const MULTI_CROP_HEIGHT_MM = 110;
const MULTI_TOLERANCE_MM = 0.05;

function readingOrder(boxes) {
  if (!boxes.length) return [];
  const heights = boxes.map(function (b) { return b.bottom - b.top; }).sort(function (a, b) { return a - b; });
  const medianH = heights[Math.floor(heights.length / 2)] || 1;
  const rowBand = Math.max(8, medianH * 0.5);
  const pending = boxes.slice().sort(function (a, b) { return a.top - b.top || a.left - b.left; });
  const rows = [];
  pending.forEach(function (box) {
    let row = null;
    for (let i = 0; i < rows.length; i++) {
      if (Math.abs(rows[i].top - box.top) <= rowBand) { row = rows[i]; break; }
    }
    if (!row) rows.push({ top: box.top, boxes: [box] });
    else row.boxes.push(box);
  });
  const ordered = [];
  rows.forEach(function (row) {
    row.boxes.sort(function (a, b) { return a.left - b.left; });
    ordered.push.apply(ordered, row.boxes);
  });
  return ordered;
}

function cardComponents(data, w, h, paper, threshold) {
  const boxes = componentBoxes(data, w, h, paper, threshold);
  if (!boxes.length) return [];
  let largest = 0;
  boxes.forEach(function (b) { if (b.area > largest) largest = b.area; });
  const kept = boxes.filter(function (b) { return b.area >= largest * 0.45; });
  return readingOrder(kept);
}

function cropRgb(data, w, h, box, marginPx) {
  const left = Math.max(0, Math.floor(box.left - marginPx));
  const top = Math.max(0, Math.floor(box.top - marginPx));
  const right = Math.min(w - 1, Math.ceil(box.right + marginPx));
  const bottom = Math.min(h - 1, Math.ceil(box.bottom + marginPx));
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  const out = Buffer.alloc(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const src = ((top + y) * w + left) * 3;
    data.copy(out, y * cw * 3, src, src + cw * 3);
  }
  return { data: out, width: cw, height: ch, origin: { x: left, y: top } };
}

function measureMultiImage(data, w, h, dpi, cardIds) {
  const ids = cardIds || [];
  const est = estimatePaper(data, w, h);
  const boxes = cardComponents(data, w, h, est.paper, est.threshold);
  if (boxes.length !== ids.length) {
    return {
      ok: false,
      error: 'found ' + boxes.length + ' cards, manifest lists ' + ids.length,
      count: boxes.length,
      boxes: boxes
    };
  }
  const marginPx = Math.round(MULTI_CROP_MARGIN_MM * pxPerMm(dpi));
  const cards = [];
  for (let i = 0; i < boxes.length; i++) {
    const crop = cropRgb(data, w, h, boxes[i], marginPx);
    const result = shiftResult(measureImage(crop.data, crop.width, crop.height, dpi), crop.origin);
    cards.push({ id: ids[i], box: boxes[i], result: result });
  }
  return { ok: true, cards: cards, gapMm: MULTI_GAP_MM };
}

function finiteMm(v) {
  return typeof v === 'number' && isFinite(v);
}

/**
 * Each approved edge must be within tolerance of the multi-card measurement.
 * An edge the answer key did not approve is not a pass and is not a fail.
 * No approved edge means the check does not pass.
 */
function compareMultiToApproved(measuredById, answerKey, toleranceMm) {
  const tol = toleranceMm == null ? MULTI_TOLERANCE_MM : toleranceMm;
  const cards = {};
  let pass = true;
  let compared = 0;
  Object.keys(measuredById).forEach(function (id) {
    const approvedCard = answerKey && answerKey.cards && answerKey.cards[id];
    const got = measuredById[id] && measuredById[id].sides;
    const edges = {};
    ['left', 'right', 'top', 'bottom'].forEach(function (edge) {
      const approved = approvedCard && approvedCard.sides && approvedCard.sides[edge];
      const measured = got && got[edge];
      if (!approved || approved.approved !== true || approved.withheld || !finiteMm(approved.mm)) {
        edges[edge] = { compared: false, reason: 'not-an-approved-value' };
        return;
      }
      compared += 1;
      if (!measured || measured.withheld || !finiteMm(measured.mm)) {
        edges[edge] = { compared: true, pass: false, reason: 'multi-withheld', approvedMm: approved.mm };
        pass = false;
        return;
      }
      const delta = Math.round((measured.mm - approved.mm) * 1000) / 1000;
      const ok = Math.abs(delta) <= tol + 1e-9;
      if (!ok) pass = false;
      edges[edge] = { compared: true, pass: ok, deltaMm: delta, approvedMm: approved.mm, multiMm: measured.mm };
      if (finiteMm(approved.upMm)) {
        edges[edge].upDeltaMm = Math.round((measured.mm - approved.upMm) * 1000) / 1000;
      }
    });
    cards[id] = { edges: edges };
  });
  if (!compared) pass = false;
  return { pass: pass, pending: false, toleranceMm: tol, cards: cards };
}

function loadFlatbedManifest(file) {
  if (!file || !fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && typeof raw === 'object' ? raw : {};
}

function multiEntries(manifest) {
  const out = [];
  Object.keys(manifest || {}).forEach(function (name) {
    const entry = manifest[name];
    if (!entry || !Array.isArray(entry.cards) || !entry.cards.length) return;
    out.push({
      file: name,
      cards: entry.cards.map(function (id) { return String(id).toUpperCase(); }),
      orientation: entry.orientation === '180' ? '180' : 'up'
    });
  });
  out.sort(function (a, b) { return a.file < b.file ? -1 : a.file > b.file ? 1 : 0; });
  return out;
}

function checkMultiFile(imagePath, cardIds, answerKey, dpi) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { pass: false, pending: true, reason: 'not-scanned', file: imagePath || null };
  }
  return loadFullRaster(imagePath).then(function (loaded) {
    if (loaded.error) return { pass: false, pending: false, reason: loaded.error };
    const measured = measureMultiImage(loaded.full.data, loaded.full.width, loaded.full.height, dpi || loaded.dpi || DEFAULT_DPI, cardIds);
    if (!measured.ok) return { pass: false, pending: false, reason: measured.error, count: measured.count };
    const byId = {};
    measured.cards.forEach(function (card) {
      byId[card.id] = card.result;
    });
    const cmp = compareMultiToApproved(byId, answerKey, MULTI_TOLERANCE_MM);
    cmp.file = imagePath;
    return cmp;
  });
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

function collectEdgePoints(data, w, h, paper, threshold, x0, y0, x1, y1, outwardX, outwardY, reach, ppm) {
  const len = hypot(x1 - x0, y1 - y0);
  if (len < 4) return [];
  const points = [];
  const step = 0.5;
  const steps = Math.ceil((2 * reach) / step);
  const samples = Math.max(12, Math.floor(len / 2));
  const sustain = Math.max(4, Math.round((0.55 * ppm) / step));
  const lookOut = Math.round((1.1 * ppm) / step);
  const gapOut = Math.round((0.2 * ppm) / step);
  const lookIn = Math.round((0.5 * ppm) / step);
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
    let hitK = -1;
    for (let k = 1; k < dists.length; k++) {
      if (!(dists[k - 1] < threshold && dists[k] >= threshold)) continue;
      const end = Math.min(dists.length - 1, k + sustain);
      if (end <= k) continue;
      let above = 0;
      let count = 0;
      for (let j = k; j <= end; j++) {
        count += 1;
        if (dists[j] >= threshold * 0.85) above += 1;
      }
      if (count >= 3 && above >= count * 0.7) {
        hitK = k;
        break;
      }
    }
    if (hitK < 0) continue;
    const outLo = Math.max(0, hitK - lookOut);
    const outHi = Math.max(outLo, hitK - gapOut);
    const inLo = Math.min(dists.length - 1, hitK + Math.max(1, Math.round((0.08 * ppm) / step)));
    const inHi = Math.min(dists.length - 1, hitK + lookIn);
    const outside = [];
    for (let j = outLo; j <= outHi; j++) outside.push(dists[j]);
    const inside = [];
    for (let j = inLo; j <= inHi; j++) inside.push(dists[j]);
    const base = outside.length ? median(outside) : dists[hitK - 1];
    const inner = inside.length ? median(inside) : dists[hitK];
    if (!(inner > base + 8)) continue;
    const target = base + 0.5 * (inner - base);
    const lo = Math.max(1, hitK - Math.round((0.35 * ppm) / step));
    const hi = Math.min(dists.length - 1, hitK + Math.round((0.35 * ppm) / step));
    let hitT = ts[hitK];
    for (let k = lo; k <= hi; k++) {
      if (dists[k - 1] <= target && dists[k] >= target) {
        const f = (target - dists[k - 1]) / ((dists[k] - dists[k - 1]) || 1);
        hitT = ts[k - 1] + (ts[k] - ts[k - 1]) * f;
        break;
      }
    }
    points.push({ x: px + outwardX * hitT, y: py + outwardY * hitT });
  }
  return points;
}

function findCardQuad(data, w, h, paper, threshold, bbox, ppm) {
  const reach = 6 * ppm;
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
      side.ox, side.oy, reach, ppm
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

function outlineStartIndex(profile, stepMm) {
  const n = profile.length;
  if (n < 8) return 0;
  const grad = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    if (!profile[i] || !profile[i + 1]) continue;
    grad[i] = rgbDist(profile[i], profile[i + 1]);
  }
  const sm = smooth5(grad);
  const window = Math.min(n - 2, Math.max(4, Math.round(1.6 / stepMm)));
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
    const nSteps = Math.round(SEARCH_TO_MM / DEPTH_STEP_MM);
    const profile = new Array(nSteps);
    for (let i = 0; i < nSteps; i++) {
      const depthMm = i * DEPTH_STEP_MM;
      const px = x + nx * depthMm * ppm;
      const py = y + ny * depthMm * ppm;
      profile[i] = sampleRgb(data, w, h, px, py);
    }
    const designStart = outlineStartIndex(profile, DEPTH_STEP_MM);
    const cands = rayCandidates(profile.slice(designStart), designStart * DEPTH_STEP_MM, DEPTH_STEP_MM);
    const marginColor = marginColorFromProfile(profile, designStart);
    const designDepth = tagMarginMarks(cands, profile, marginColor, DEPTH_STEP_MM, designStart * DEPTH_STEP_MM);
    stations.push({
      x: x,
      y: y,
      nx: nx,
      ny: ny,
      alongMm: s / ppm,
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
    let deeper = null;
    for (let li = 0; li < layers.length; li++) {
      const other = layers[li];
      if (other.median <= layer.median + 0.28) continue;
      if (other.cov < 0.28) continue;
      if (!deeper || other.cov > deeper.cov) deeper = other;
    }
    if (!deeper) return;
    if (layer.cov < PARTIAL_COVERAGE && layer.cov < deeper.cov * 0.65) {
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
  const sizeOk = Math.min(direct, swapped) < 2.5;
  if (!sizeOk) withholdNotCardSized(sides);
  return {
    ok: true,
    dpi: dpi,
    paper: paperModel.paper.map(function (v) { return Math.round(v); }),
    threshold: roundMm(paperModel.threshold),
    cardMm: {
      width: roundMm(quad.widthMm),
      height: roundMm(quad.heightMm)
    },
    sizeOk: sizeOk,
    corners: quad.corners,
    sides: sides
  };
}

function withholdNotCardSized(sides) {
  ['top', 'bottom', 'left', 'right'].forEach(function (name) {
    const side = sides[name];
    if (!side) return;
    side.mm = null;
    side.withheld = true;
    side.reason = 'not-card-sized';
  });
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
    }),
    elements: (side.elements || []).map(function (el) {
      return {
        depthMm: el.depthMm,
        fromMm: el.fromMm,
        toMm: el.toMm,
        coverage: el.coverage,
        stations: el.stations,
        runs: el.runs || [],
        runCount: el.runCount == null ? (el.runs || []).length : el.runCount,
        role: el.role,
        refused: !!el.refused,
        why: el.why || null
      };
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

function measuredMm(side) {
  if (!side || side.withheld || side.mm == null || !isFinite(side.mm)) return null;
  return side.mm;
}

function pairBias(upSide, rotSide, upOpp, rotOpp) {
  const fromSide = upSide != null && rotSide != null ? (upSide - rotSide) / 2 : null;
  const fromOpp = upOpp != null && rotOpp != null ? (rotOpp - upOpp) / 2 : null;
  const agree = fromSide != null && fromOpp != null && Math.abs(fromSide - fromOpp) <= BIAS_AGREE_MM;
  return { fromSide: fromSide, fromOpp: fromOpp, agree: agree };
}

function agreeEdges(upSides, rotSides) {
  const up = {
    top: measuredMm(upSides.top),
    bottom: measuredMm(upSides.bottom),
    left: measuredMm(upSides.left),
    right: measuredMm(upSides.right)
  };
  const rot = {
    top: measuredMm(rotSides.bottom),
    bottom: measuredMm(rotSides.top),
    left: measuredMm(rotSides.right),
    right: measuredMm(rotSides.left)
  };
  const along = pairBias(up.top, rot.top, up.bottom, rot.bottom);
  const across = pairBias(up.left, rot.left, up.right, rot.right);
  const axes = {
    alongScan: {
      sides: ['top', 'bottom'],
      biasFromTop: along.fromSide == null ? null : roundMm(along.fromSide),
      biasFromBottom: along.fromOpp == null ? null : roundMm(along.fromOpp),
      agree: along.agree
    },
    acrossScan: {
      sides: ['left', 'right'],
      biasFromLeft: across.fromSide == null ? null : roundMm(across.fromSide),
      biasFromRight: across.fromOpp == null ? null : roundMm(across.fromOpp),
      agree: across.agree
    }
  };
  const axisOf = { top: along, bottom: along, left: across, right: across };
  const raw = { top: [up.top, rot.top], bottom: [up.bottom, rot.bottom], left: [up.left, rot.left], right: [up.right, rot.right] };
  const imageSide = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' };
  const rotImage = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const sides = {};
  ['top', 'bottom', 'left', 'right'].forEach(function (side) {
    const pair = raw[side];
    const upMm = pair[0];
    const rotMm = pair[1];
    const axis = axisOf[side];
    const opposite = side === 'top' || side === 'bottom'
      ? (side === 'top' ? 'bottom' : 'top')
      : (side === 'left' ? 'right' : 'left');
    const oppPair = raw[opposite];
    let mm = null;
    let withheld = true;
    let reason = 'unmeasured';
    if (axis.agree && upMm != null && rotMm != null) {
      mm = (upMm + rotMm) / 2;
      withheld = false;
      reason = null;
    } else if (upMm == null || rotMm == null) {
      reason = 'unmeasured';
    } else if (oppPair[0] == null || oppPair[1] == null) {
      reason = 'needs-both-sides';
    } else {
      reason = 'bias-disagreement';
    }
    const a = upSides[imageSide[side]];
    const b = rotSides[rotImage[side]];
    const confs = [];
    if (a && a.confidence) confs.push(a.confidence);
    if (b && b.confidence) confs.push(b.confidence);
    const diff = upMm != null && rotMm != null ? upMm - rotMm : null;
    sides[side] = {
      mm: mm == null ? null : roundMm(mm),
      confidence: confs.length ? Math.round(Math.min.apply(null, confs) * 1000) / 1000 : 0,
      withheld: withheld,
      reason: reason,
      approved: false,
      upMm: upMm == null ? null : roundMm(upMm),
      rot180Mm: rotMm == null ? null : roundMm(rotMm),
      diffMm: diff == null ? null : roundMm(diff),
      agree: !withheld
    };
  });
  return { sides: sides, axes: axes };
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
        keep[id][side] = {
          approved: !!sides[side].approved,
          approved_by: sides[side].approved_by || null,
          approved_on: sides[side].approved_on || null
        };
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
    const combined = agreeEdges(upSides, rotSides);
    const agreed = combined.sides;
    const prev = previousApproved[id] || {};
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      const kept = prev[side];
      const wasApproved = kept === true || (kept && kept.approved);
      if (!wasApproved) return;
      agreed[side].approved = true;
      if (kept && kept.approved_by) agreed[side].approved_by = kept.approved_by;
      if (kept && kept.approved_on) agreed[side].approved_on = kept.approved_on;
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
        dpi: entry.fileDpi || null,
        scale: axisScale(entry.result.cardMm, entry.fileDpi),
        cardMm: entry.result.cardMm,
        sizeOk: entry.result.sizeOk,
        ratios: borderRatios(sides),
        sides: sides
      };
    }
    outCards[id] = {
      sides: agreed,
      axes: combined.axes,
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
    biasAgreeMm: BIAS_AGREE_MM,
    definition: 'Border is the perpendicular distance from the card edge to the outermost points of the continuous design-block outline on that side. A mark that covers only part of a side is not the outline. The published value is the mean of the upright scan and the swapped 180 degree scan. An axis is accepted only when the bias estimated from each of its two sides agrees within 0.02 mm. That bias is reported and is not subtracted as a constant. Unapproved until a person checks the overlay.',
    cards: outCards
  };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
  });
}

function buildOverlaySvg(result, geom) {
  const scale = geom.scale;
  const ox = geom.originX || 0;
  const oy = geom.originY || 0;
  const dw = geom.width;
  const dh = geom.height;
  const stroke = geom.stroke == null ? 2 : geom.stroke;
  const pointR = geom.pointR == null ? 2.2 : geom.pointR;
  const labels = geom.labels !== false;
  const onlySide = geom.side || null;
  const parts = [];
  function sx(x) { return ((x - ox) * scale).toFixed(1); }
  function sy(y) { return ((y - oy) * scale).toFixed(1); }
  if (!result || !result.ok) {
    return svgWrap(dw, dh, parts);
  }
  const c = result.corners;
  if (!onlySide) {
    parts.push(
      '<polygon points="' +
      [c.tl, c.tr, c.br, c.bl].map(function (p) { return sx(p.x) + ',' + sy(p.y); }).join(' ') +
      '" fill="none" stroke="#000000" stroke-width="' + (stroke + 2) + '"/>'
    );
    parts.push(
      '<polygon points="' +
      [c.tl, c.tr, c.br, c.bl].map(function (p) { return sx(p.x) + ',' + sy(p.y); }).join(' ') +
      '" fill="none" stroke="#39ff14" stroke-width="' + stroke + '"/>'
    );
  }
  const names = onlySide ? [onlySide] : ['top', 'bottom', 'left', 'right'];
  names.forEach(function (name) {
    const side = result.sides[name];
    if (!side || !side.edge) return;
    if (onlySide) {
      parts.push(
        '<line x1="' + sx(side.edge.a.x) + '" y1="' + sy(side.edge.a.y) +
        '" x2="' + sx(side.edge.b.x) + '" y2="' + sy(side.edge.b.y) +
        '" stroke="#000000" stroke-width="' + (stroke + 2) + '"/>'
      );
      parts.push(
        '<line x1="' + sx(side.edge.a.x) + '" y1="' + sy(side.edge.a.y) +
        '" x2="' + sx(side.edge.b.x) + '" y2="' + sy(side.edge.b.y) +
        '" stroke="#39ff14" stroke-width="' + stroke + '"/>'
      );
    }
    const col = side.withheld ? '#ff5a36' : '#ffe14a';
    (side.points || []).forEach(function (p) {
      const px = p.x + side.edge.nx * p.depth * pxPerMm(result.dpi);
      const py = p.y + side.edge.ny * p.depth * pxPerMm(result.dpi);
      parts.push('<circle cx="' + sx(px) + '" cy="' + sy(py) + '" r="' + pointR + '" fill="' + col + '" fill-opacity="0.9"/>');
    });
    (side.used || []).forEach(function (p) {
      const px = p.x + side.edge.nx * p.depth * pxPerMm(result.dpi);
      const py = p.y + side.edge.ny * p.depth * pxPerMm(result.dpi);
      parts.push('<circle cx="' + sx(px) + '" cy="' + sy(py) + '" r="' + (pointR + 1.5) + '" fill="none" stroke="#ffffff" stroke-width="' + Math.max(1, stroke * 0.35) + '"/>');
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
        '" stroke="#000000" stroke-width="' + (stroke + 2) + '"/>'
      );
      parts.push(
        '<line x1="' + sx(ax) + '" y1="' + sy(ay) + '" x2="' + sx(bx) + '" y2="' + sy(by) +
        '" stroke="#3ee0ff" stroke-width="' + stroke + '"/>'
      );
    }
    if (!labels) return;
    const labelX = (side.edge.a.x + side.edge.b.x) / 2 + side.edge.nx * 40 / scale;
    const labelY = (side.edge.a.y + side.edge.b.y) / 2 + side.edge.ny * 40 / scale;
    const text = side.withheld
      ? name + ' withheld' + (side.reason ? ' (' + side.reason + ')' : '')
      : name + ' ' + side.mm.toFixed(2) + ' mm';
    const anchor = name === 'right' ? 'end' : (name === 'left' ? 'start' : 'middle');
    parts.push(
      '<text x="' + sx(labelX) + '" y="' + sy(labelY) + '" fill="#ffffff" font-size="22" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke" text-anchor="' + anchor + '" dominant-baseline="middle">' +
      esc(text) + '</text>'
    );
  });
  if (labels && result.cardMm) {
    const sizeText = 'card ' + result.cardMm.width.toFixed(2) + ' x ' + result.cardMm.height.toFixed(2) + ' mm';
    parts.push(
      '<text x="16" y="32" fill="#ffffff" font-size="22" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke">' +
      esc(sizeText) + '</text>'
    );
  }
  return svgWrap(dw, dh, parts);
}

function svgWrap(dw, dh, parts) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + dw + '" height="' + dh + '">' +
    parts.join('') + '</svg>';
}

async function writeOverlay(file, result, dest) {
  const meta = await sharp(file).metadata();
  const long = Math.max(meta.width, meta.height);
  const target = 1600;
  const scale = long > target ? target / long : 1;
  const dw = Math.round(meta.width * scale);
  const dh = Math.round(meta.height * scale);
  const base = await sharp(file).rotate().resize(dw, dh).png().toBuffer();
  const svg = buildOverlaySvg(result, { scale: scale, width: dw, height: dh });
  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(dest);
  return dest;
}

async function writeFullJpeg(file, result, dest) {
  const meta = await sharp(file).rotate().metadata();
  const targetH = 2000;
  const scale = meta.height > targetH ? targetH / meta.height : 1;
  const dw = Math.round(meta.width * scale);
  const dh = Math.round(meta.height * scale);
  const base = await sharp(file).rotate().resize(dw, dh).png().toBuffer();
  const svg = buildOverlaySvg(result, { scale: scale, width: dw, height: dh });
  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(dest);
  return dest;
}

function sideCropBox(side, dpi, imageW, imageH) {
  const ppm = pxPerMm(dpi);
  const outside = 3 * ppm;
  const inside = 15 * ppm;
  const along = 1.5 * ppm;
  const a = side.edge.a;
  const b = side.edge.b;
  const nx = side.edge.nx;
  const ny = side.edge.ny;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(1, hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const a2 = { x: a.x - ux * along, y: a.y - uy * along };
  const b2 = { x: b.x + ux * along, y: b.y + uy * along };
  const pts = [
    { x: a2.x - nx * outside, y: a2.y - ny * outside },
    { x: b2.x - nx * outside, y: b2.y - ny * outside },
    { x: b2.x + nx * inside, y: b2.y + ny * inside },
    { x: a2.x + nx * inside, y: a2.y + ny * inside }
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  pts.forEach(function (p) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  });
  const left = Math.max(0, Math.floor(minX));
  const top = Math.max(0, Math.floor(minY));
  const right = Math.min(imageW, Math.ceil(maxX));
  const bottom = Math.min(imageH, Math.ceil(maxY));
  return {
    left: left,
    top: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

async function writeSideCrop(file, result, sideName, dest) {
  const meta = await sharp(file).rotate().metadata();
  const side = result && result.sides && result.sides[sideName];
  if (!side || !side.edge) {
    throw new Error('no edge for ' + sideName);
  }
  const box = sideCropBox(side, result.dpi, meta.width, meta.height);
  const ppm = pxPerMm(result.dpi);
  const stroke = Math.max(4, Math.round(0.12 * ppm));
  const base = await sharp(file).rotate().extract(box).png().toBuffer();
  const svg = buildOverlaySvg(result, {
    scale: 1,
    originX: box.left,
    originY: box.top,
    width: box.width,
    height: box.height,
    stroke: stroke,
    pointR: Math.max(3, Math.round(0.08 * ppm)),
    labels: false,
    side: sideName
  });
  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toFile(dest);
  return dest;
}

async function writeReviewSet(file, result, dir, stem) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, stem + '_full.jpg');
  await writeFullJpeg(file, result, full);
  const sides = ['top', 'bottom', 'left', 'right'];
  for (let i = 0; i < sides.length; i++) {
    const dest = path.join(dir, stem + '_' + sides[i] + '.png');
    await writeSideCrop(file, result, sides[i], dest);
  }
  return full;
}

async function loadFullRaster(file) {
  const raw = await sharp(file).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    full: { data: raw.data, width: raw.info.width, height: raw.info.height },
    origin: { x: 0, y: 0 }
  };
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

function readPngDpi(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = 8;
    const hdr = Buffer.alloc(8);
    const chunk = Buffer.alloc(16);
    while (pos < 2 * 1024 * 1024) {
      if (fs.readSync(fd, hdr, 0, 8, pos) < 8) break;
      const length = hdr.readUInt32BE(0);
      const typ = hdr.toString('ascii', 4, 8);
      if (typ === 'pHYs' && length >= 9) {
        fs.readSync(fd, chunk, 0, 9, pos + 8);
        const ppmX = chunk.readUInt32BE(0);
        const ppmY = chunk.readUInt32BE(4);
        const unit = chunk.readUInt8(8);
        if (unit !== 1 || !ppmX || !ppmY) return { dpiX: null, dpiY: null, unit: unit };
        return { dpiX: ppmX * 0.0254, dpiY: ppmY * 0.0254, unit: unit };
      }
      if (typ === 'IEND' || typ === 'IDAT') break;
      pos += 12 + length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { dpiX: null, dpiY: null, unit: null };
}

function axisScale(cardMm, fileDpi) {
  if (!cardMm) return null;
  const widthScale = cardMm.width / NOMINAL_W_MM;
  const heightScale = cardMm.height / NOMINAL_H_MM;
  const dpiX = fileDpi && fileDpi.dpiX;
  const dpiY = fileDpi && fileDpi.dpiY;
  const fileDpiDiffer = dpiX != null && dpiY != null && Math.abs(dpiX - dpiY) > 0.5;
  const axisDiffer = Math.abs(widthScale - heightScale) > 0.008;
  return {
    dpiX: dpiX == null ? null : Math.round(dpiX * 1000) / 1000,
    dpiY: dpiY == null ? null : Math.round(dpiY * 1000) / 1000,
    fileDpiDiffer: fileDpiDiffer,
    widthScale: Math.round(widthScale * 10000) / 10000,
    heightScale: Math.round(heightScale * 10000) / 10000,
    xyScaleDiffer: fileDpiDiffer || axisDiffer
  };
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
    function sizeLine(label, scan) {
      if (!scan || !scan.cardMm) {
        console.log('  ' + label + '  missing');
        return;
      }
      const sc = scan.scale || {};
      const dpi = scan.dpi || {};
      console.log(
        '  ' + label +
        '  dpi ' + (dpi.dpiX == null ? '—' : dpi.dpiX.toFixed(2)) + ' x ' + (dpi.dpiY == null ? '—' : dpi.dpiY.toFixed(2)) +
        '  card ' + scan.cardMm.width.toFixed(3) + ' x ' + scan.cardMm.height.toFixed(3) + ' mm' +
        '  scale ' + (sc.widthScale == null ? '—' : sc.widthScale.toFixed(4)) + ' x ' + (sc.heightScale == null ? '—' : sc.heightScale.toFixed(4)) +
        (sc.xyScaleDiffer ? '  FLAG xy scale' : '')
      );
      const ratios = scan.ratios || {};
      ['top', 'bottom', 'left', 'right'].forEach(function (side) {
        const s = scan.sides[side];
        console.log(
          '    ' + side.padEnd(6, ' ') +
          ' ' + fmt(s.mm) + ' mm' +
          '  conf ' + (s.confidence == null ? '—' : s.confidence.toFixed(2)) +
          (s.withheld ? '  withheld ' + (s.reason || '') : '') +
          (s.shape ? '  ' + s.shape : '')
        );
        (s.elements || []).forEach(function (el) {
          if (!s.withheld && el.role === 'outline') return;
          const where = (el.runs && el.runs.length)
            ? el.runs.slice(0, 4).map(function (run) { return run.fromMm + '–' + run.toMm; }).join(', ')
            : (el.fromMm + '–' + el.toMm);
          console.log(
            '      ' + (el.role || 'element') +
            '  ' + fmt(el.depthMm) + ' mm' +
            '  ' + where + ' mm' +
            '  ' + (el.why || '')
          );
        });
      });
      console.log(
        '    L/R ' + fmtRatio(ratios.leftOverRight) +
        '  left share ' + fmtShare(ratios.leftShare) +
        '   T/B ' + fmtRatio(ratios.topOverBottom) +
        '  top share ' + fmtShare(ratios.topShare)
      );
    }
    console.log(id);
    sizeLine('up ', up);
    sizeLine('180', rot);
    const axes = card.axes || {};
    const along = axes.alongScan || {};
    const across = axes.acrossScan || {};
    console.log(
      '  along-scan bias  top ' + fmt(along.biasFromTop) +
      '  bottom ' + fmt(along.biasFromBottom) +
      '  ' + (along.agree ? 'agree' : 'WITHHELD')
    );
    console.log(
      '  across-scan bias  left ' + fmt(across.biasFromLeft) +
      '  right ' + fmt(across.biasFromRight) +
      '  ' + (across.agree ? 'agree' : 'WITHHELD')
    );
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
        ' mean ' + fmt(s.mm) +
        '  up ' + fmt(s.upMm) +
        '  180 ' + fmt(s.rot180Mm) +
        '  ' + (s.agree ? 'accept' : 'WITHHELD ' + (s.reason || '')) +
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
  const measurements = [];
  let dpiUsed = opts.dpi || DEFAULT_DPI;
  for (let i = 0; i < files.length; i++) {
    const parsed = parseScanName(files[i]);
    const fileDpi = readPngDpi(files[i]);
    let dpi = opts.dpiExplicit ? opts.dpi : DEFAULT_DPI;
    if (!opts.dpiExplicit && fileDpi.dpiX && fileDpi.dpiY) {
      dpi = (fileDpi.dpiX + fileDpi.dpiY) / 2;
    }
    dpiUsed = dpi;
    process.stdout.write('measure ' + path.basename(files[i]) + ' dpi ' + dpi.toFixed(3) + '\n');
    const result = await measureFile(files[i], dpi);
    measurements.push({
      card: parsed.card,
      orientation: parsed.orientation,
      file: files[i],
      fileDpi: fileDpi,
      result: result
    });
    if (opts.overlayDir) {
      fs.mkdirSync(opts.overlayDir, { recursive: true });
      const stem = parsed.card + '_' + parsed.orientation;
      const dest = path.join(opts.overlayDir, stem + '.png');
      await writeOverlay(files[i], result, dest);
      await writeReviewSet(files[i], result, opts.overlayDir, stem);
      if (opts.artifactDir) {
        fs.mkdirSync(opts.artifactDir, { recursive: true });
        const copy = path.join(opts.artifactDir, parsed.card + '_' + parsed.orientation + '.png');
        fs.copyFileSync(dest, copy);
      }
    }
  }
  const previous = loadApproved(opts.out);
  const key = buildAnswerKey(measurements, dpiUsed, previous);
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
    check('partial axis bias agrees', agreed.axes.alongScan.agree && agreed.axes.acrossScan.agree, agreed.axes);
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      const expect = { top: 4.0, bottom: 3.6, left: 3.2, right: 5.1 }[side];
      check('partial 180 ' + side, agreed.sides[side].agree && near(agreed.sides[side].mm, expect, 0.05), agreed.sides[side]);
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
    check('curve uses the extreme', near(curvedM.sides.top.mm, 3.2, 0.1) && !curvedM.sides.top.withheld,
      sideBrief(curvedM.sides.top));
    check('curve other sides', near(curvedM.sides.bottom.mm, 4.4, 0.05) && near(curvedM.sides.left.mm, 3.8, 0.05),
      { bottom: sideBrief(curvedM.sides.bottom), left: sideBrief(curvedM.sides.left) });
    const rot = rotate180(curved.data, curved.width, curved.height);
    const rotM = measureImage(rot, curved.width, curved.height, dpi);
    const agreed = agreeEdges(curvedM.sides, rotM.sides);
    check('curve 180 agrees', agreed.axes.alongScan.agree && agreed.sides.top.agree && near(agreed.sides.top.mm, 3.2, 0.08), agreed.sides.top);
  }

  const stepped = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.2,
    top: {
      depth: function (along) { return along < 0.5 ? 3.0 : 4.6; },
      color: blue,
      marks: []
    },
    bottom: constantEdge(4.0, blue, []),
    left: constantEdge(3.5, blue, []),
    right: constantEdge(3.5, blue, [])
  });
  const steppedM = measureImage(stepped.data, stepped.width, stepped.height, dpi);
  check('stepped card found', steppedM.ok, steppedM.error);
  if (steppedM.ok) {
    check('stepped top uses the outermost element', near(steppedM.sides.top.mm, 3.0, 0.08) && !steppedM.sides.top.withheld,
      sideBrief(steppedM.sides.top));
  }

  const biasUp = {
    top: { mm: 3.777, withheld: false, confidence: 0.84 },
    bottom: { mm: 3.022, withheld: false, confidence: 0.84 },
    left: { mm: null, withheld: true, confidence: 0 },
    right: { mm: 3.44, withheld: false, confidence: 0.91 }
  };
  const biasRot = {
    top: { mm: 3.271, withheld: false, confidence: 0.87 },
    bottom: { mm: 3.526, withheld: false, confidence: 0.83 },
    left: { mm: 3.431, withheld: false, confidence: 0.95 },
    right: { mm: null, withheld: true, confidence: 0 }
  };
  const bias = agreeEdges(biasUp, biasRot);
  check('bias from top', near(bias.axes.alongScan.biasFromTop, 0.1255, 0.001), bias.axes.alongScan);
  check('bias from bottom', near(bias.axes.alongScan.biasFromBottom, 0.1245, 0.001), bias.axes.alongScan);
  check('along-scan axis accepted', bias.axes.alongScan.agree === true, bias.axes.alongScan);
  check('top mean cancels bias', near(bias.sides.top.mm, 3.6515, 0.001), bias.sides.top);
  check('bottom mean cancels bias', near(bias.sides.bottom.mm, 3.1465, 0.001), bias.sides.bottom);
  check('across-scan needs both sides', bias.axes.acrossScan.agree === false && bias.sides.right.reason === 'needs-both-sides', bias.sides.right);
  check('no fixed correction', bias.sides.top.mm === roundMm((3.777 + 3.526) / 2), bias.sides.top.mm);

  const tiltedPng = await sharp(mixed.data, {
    raw: { width: mixed.width, height: mixed.height, channels: 3 }
  }).rotate(2, { background: { r: pink[0], g: pink[1], b: pink[2] } }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tiltedM = measureImage(tiltedPng.data, tiltedPng.info.width, tiltedPng.info.height, dpi);
  check('tilted card found', tiltedM.ok && tiltedM.sizeOk, tiltedM.ok ? tiltedM.cardMm : tiltedM.error);
  const tiny = drawSynthetic({
    dpi: dpi,
    marginMm: 4,
    cardWmm: 40,
    cardHmm: 55,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.0,
    top: constantEdge(2.0, blue, []),
    bottom: constantEdge(2.2, blue, []),
    left: constantEdge(1.8, blue, []),
    right: constantEdge(1.9, blue, [])
  });
  const tinyM = measureImage(tiny.data, tiny.width, tiny.height, dpi);
  check('undersized quad found', tinyM.ok === true && tinyM.sizeOk === false, tinyM.ok ? tinyM.cardMm : tinyM.error);
  if (tinyM.ok) {
    ['top', 'bottom', 'left', 'right'].forEach(function (name) {
      const side = tinyM.sides[name];
      check('undersized ' + name + ' withheld',
        side.withheld === true && side.mm == null && side.reason === 'not-card-sized',
        sideBrief(side));
    });
  }
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

  const mw = 480;
  const mh = 220;
  const sheet = Buffer.alloc(mw * mh * 3);
  for (let i = 0; i < sheet.length; i += 3) {
    sheet[i] = pink[0];
    sheet[i + 1] = pink[1];
    sheet[i + 2] = pink[2];
  }
  function paint(x0, y0, x1, y1) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * mw + x) * 3;
        sheet[i] = 20;
        sheet[i + 1] = 20;
        sheet[i + 2] = 20;
      }
    }
  }
  paint(30, 40, 110, 170);
  paint(180, 40, 260, 170);
  paint(330, 40, 410, 170);
  const sheetPaper = estimatePaper(sheet, mw, mh);
  const foundCards = cardComponents(sheet, mw, mh, sheetPaper.paper, sheetPaper.threshold);
  check('three cards in left-to-right order', foundCards.length === 3 &&
    foundCards[0].left < foundCards[1].left && foundCards[1].left < foundCards[2].left,
    foundCards.map(function (b) { return b.left; }));
  const rowOrder = readingOrder([
    { left: 200, right: 260, top: 40, bottom: 100 },
    { left: 20, right: 80, top: 40, bottom: 100 },
    { left: 20, right: 80, top: 140, bottom: 200 }
  ]);
  check('reading order is a row left to right, then the next row',
    rowOrder.length === 3 && rowOrder[0].left === 20 && rowOrder[1].left === 200 && rowOrder[2].top === 140, rowOrder);
  const approvedKey = { cards: { 'TD-01': { sides: {
    left: { mm: 3.1, withheld: false, approved: true },
    right: { mm: 3.2, withheld: false, approved: true },
    top: { mm: 3.6, withheld: false, approved: true },
    bottom: { mm: 3.1, withheld: false, approved: true }
  } } } };
  function moved(dx) {
    return { sides: {
      left: { mm: 3.1 + dx, withheld: false },
      right: { mm: 3.2, withheld: false },
      top: { mm: 3.6, withheld: false },
      bottom: { mm: 3.1, withheld: false }
    } };
  }
  check('multi-card within 0.05 mm passes', compareMultiToApproved({ 'TD-01': moved(0.05) }, approvedKey).pass === true);
  check('multi-card past 0.05 mm fails', compareMultiToApproved({ 'TD-01': moved(0.051) }, approvedKey).pass === false);
  const manifest = {
    'TD-01_TD-02_KARROS_up.png': { cards: ['TD-01', 'TD-02', 'KARROS'], orientation: 'up' },
    'TD-01_up.png': { deck: 'TD-01', orientation: 'up' }
  };
  const listed = multiEntries(manifest);
  check('manifest cards stay in reading order', listed.length === 1 &&
    listed[0].cards.join(',') === 'TD-01,TD-02,KARROS', listed);
  const notScanned = await checkMultiFile(path.join(os.tmpdir(), 'judge-multi-not-scanned.png'),
    ['TD-01', 'TD-02', 'KARROS'], approvedKey, 1200);
  check('a multi scan that is not on disk does not pass', notScanned.pass === false && notScanned.pending === true, notScanned);

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
    dpi: null,
    dpiExplicit: false,
    selfTest: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') opts.selfTest = true;
    else if (a === '--flatbed') opts.flatbed = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--overlay-dir') opts.overlayDir = argv[++i];
    else if (a === '--dpi') {
      opts.dpi = Number(argv[++i]);
      opts.dpiExplicit = true;
    }
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
  writeReviewSet: writeReviewSet,
  agreeEdges: agreeEdges,
  buildAnswerKey: buildAnswerKey,
  BIAS_AGREE_MM: BIAS_AGREE_MM,
  cardComponents: cardComponents,
  measureMultiImage: measureMultiImage,
  compareMultiToApproved: compareMultiToApproved,
  multiEntries: multiEntries,
  checkMultiFile: checkMultiFile,
  MULTI_TOLERANCE_MM: MULTI_TOLERANCE_MM,
  MULTI_GAP_MM: MULTI_GAP_MM,
  MULTI_GLASS_WIDTH_MM: MULTI_GLASS_WIDTH_MM,
  MULTI_CROP_HEIGHT_MM: MULTI_CROP_HEIGHT_MM
};
