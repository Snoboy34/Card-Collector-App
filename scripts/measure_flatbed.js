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
 * side, is not the outline. Texture or shading inside a uniform margin
 * (foil, gloss, scanner noise) is not an edge either. A step counts only
 * when it is the boundary between that margin and the design block. The
 * outline may change element along a side; the width is then the outermost
 * points of the design block. If those points are not clear, that side is
 * withheld. The overlay follows those points, so a tilted frame is not
 * crossed by a single-depth line. tiltDeg is the frame's angle against
 * the card edge, in degrees. Positive means the border widens toward the
 * side's end corner.
 *
 * A patterned margin (a wave, a foil, a refractor) is margin however busy
 * it is. The outline is the outer edge of the first thin line that is
 * parallel to the edge and closes a rectangle with the same stroke on the
 * other three sides. The line may be a segment; it does not have to run
 * the whole side. What qualifies it is the same profile on all four sides:
 * a thin silver line, a thicker black line, and a thin silver line inside
 * that. A thin line under half a millimetre counts. A logo, stamp, or
 * lettering that sits on only one side does not. The width is the
 * perpendicular distance to the outermost points of that outer edge, at
 * least two per side. The outer edge of the black line is a cross-check;
 * the two centering ratios are both reported. A side whose stroke does not
 * match the others does not take that outline. A plain margin whose
 * outline already sits outside such a stroke is left alone.
 *
 * A chrome margin can carry rays and angled shapes. Those are margin
 * pattern, not the outline. The outline there is a gold line with black
 * immediately inside it, the same profile on all four sides. A line
 * sliding in from the card edge meets that frame at its outer corners.
 * Each corner is the contact for the two sides that meet there, so each
 * side is measured from its two corners. A ray that does not close that
 * frame is not a contact.
 *
 * A full-bleed photo has no frame. Its top and bottom stay withheld. The
 * ends of a player-name line may be reported as design-referenced left and
 * right, and a corner mark or a letter descender may be recorded as an
 * anchor. Those are not a centering measurement and they are not a grade.
 *
 * A found quad that is not a card fails closed. Each dimension has to sit
 * within SIZE_AXIS_MM of 63.5 × 88.9 mm (or swapped). Two scans of one card
 * repeat its width and height to within 0.2 mm. Real cards on this deck sit
 * within 0.83 mm of nominal. A lost edge is the next step out, about 1.9 mm,
 * and the two scans agree on it, so it is not the repeat. 1.0 mm per
 * dimension covers the real cards plus the repeat and rejects the lost edge.
 * Otherwise every side is withheld with reason not-card-sized.
 *
 * The card edge is the paper-to-card colour step. A tight crop's corners
 * include the card, and that raises the bed gate until a silver or yellow
 * edge counts as the sheet. When that gate does not yield a card-sized
 * quad, the measurement is retried with the uncropped sheet's bed colour.
 * A card-sized result from the crop is kept, so a lower sheet gate cannot
 * move a card that was already found.
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
const designOutline = require('../services/design_outline');

const NOMINAL_W_MM = 63.5;
const NOMINAL_H_MM = 88.9;
const DEFAULT_DPI = 1200;
const BIAS_AGREE_MM = 0.02;
const SIZE_AXIS_MM = 1;
const PARTIAL_COVERAGE = 0.32;
// A real outline is found along the side. Foil and gloss make some stations
// miss it, so this is not every station. A lock on fewer than one station
// in five is a local mark or texture, not that boundary.
const OUTLINE_COVERAGE = 0.20;

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
  return designOutline.outlineStartIndex(profile, stepMm);
}

function marginModelFromProfile(profile, designStart, stepMm) {
  return designOutline.marginModelFromProfile(profile, designStart, stepMm);
}

function lastingDesignDepth(profile, stepMm, model, startDepth) {
  return designOutline.lastingDesignDepth(profile, stepMm, model, startDepth, SEARCH_TO_MM);
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

function tagMarginMarks(cands, profile, marginModel, stepMm, startDepth) {
  const raw = lastingDesignDepth(profile, stepMm, marginModel, startDepth);
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
  const ux = (b.x - a.x) / lengthPx;
  const uy = (b.y - a.y) / lengthPx;
  // A gold line is a halftone. One ray can miss the warm dots, so the gold
  // profile uses the warmest pixel in a short stretch along the edge.
  function goldRgb(x, y, depthMm) {
    let best = null;
    let bestY = -1e9;
    for (let da = -0.12; da <= 0.12; da += 0.06) {
      const px = x + ux * da * ppm + nx * depthMm * ppm;
      const py = y + uy * da * ppm + ny * depthMm * ppm;
      const rgb = sampleRgb(data, w, h, px, py);
      if (!rgb) continue;
      const yv = Math.min(rgb[0], rgb[1]) - rgb[2];
      if (yv > bestY) {
        bestY = yv;
        best = rgb;
      }
    }
    return best;
  }
  function goldProfileAt(x, y) {
    const nSteps = Math.round(SEARCH_TO_MM / DEPTH_STEP_MM);
    const profile = new Array(nSteps);
    for (let i = 0; i < nSteps; i++) profile[i] = goldRgb(x, y, i * DEPTH_STEP_MM);
    return profile;
  }
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
    const marginModel = marginModelFromProfile(profile, designStart, DEPTH_STEP_MM);
    const designDepth = tagMarginMarks(cands, profile, marginModel, DEPTH_STEP_MM, designStart * DEPTH_STEP_MM);
    stations.push({
      x: x,
      y: y,
      nx: nx,
      ny: ny,
      alongMm: s / ppm,
      t: t,
      margin: marginModel ? marginModel.med : null,
      marginTextured: !!(marginModel && marginModel.textured),
      marginPattern: !!(marginModel && marginModel.pattern),
      marginVaried: !!(marginModel && marginModel.variedColour),
      designDepth: designDepth,
      candidates: cands,
      frameMarks: frameMarksFromProfile(profile, DEPTH_STEP_MM),
      goldMarks: goldMarksFromProfile(goldProfileAt(x, y), DEPTH_STEP_MM)
    });
  }
  // The design search stays off the cut corners. The gold frame's outer
  // corners sit in that end zone, so sample them for the corner contacts
  // only. They are not design-outline stations.
  const goldEnds = [];
  const endStep = 0.25 * ppm;
  const mainStart = lengthPx * SIDE_MARGIN;
  const mainEnd = lengthPx * (1 - SIDE_MARGIN);
  function addGoldEnd(s) {
    const x = a.x + (b.x - a.x) * (s / lengthPx);
    const y = a.y + (b.y - a.y) * (s / lengthPx);
    goldEnds.push({
      x: x,
      y: y,
      nx: nx,
      ny: ny,
      alongMm: s / ppm,
      goldMarks: goldMarksFromProfile(goldProfileAt(x, y), DEPTH_STEP_MM)
    });
  }
  for (let s = 1.2 * ppm; s < mainStart; s += endStep) addGoldEnd(s);
  for (let s = mainEnd + endStep; s <= lengthPx - 1.2 * ppm; s += endStep) addGoldEnd(s);
  let best = summarizeDesign(stations);
  if (best.withheld && best.reason === 'no-outline') {
    const path = linkOutline(stations, STATION_STEP_MM);
    const linked = summarizePath(path, stations.length);
    if (linked && !linked.withheld) best = linked;
  }
  best.side = sideName;
  best.lengthMm = lengthMm;
  best.edge = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, nx: nx, ny: ny };
  const tiltPts = (best.used && best.used.length >= 2) ? best.used : best.points;
  best.tiltDeg = designOutline.tiltDegrees(tiltPts);
  // A repeating pattern that begins at the cut is not a margin. A step
  // inside the first millimetre of that pattern is texture, not the
  // design block. Withhold it instead of publishing the first wave.
  const patterned = stations.filter(function (st) { return st.marginPattern; }).length;
  if (!best.withheld && best.mm != null && best.mm < 1 && patterned > stations.length * 0.5) {
    best.withheld = true;
    best.mm = null;
    best.reason = 'unclear';
    best.confidence = Math.min(best.confidence || 0, 0.34);
  }
  if (process.env.TRACE_FLATBED) {
    process.stdout.write(sideName + ' ' + JSON.stringify(traceSide(stations)) + '\n');
  }
  best.stations = stations;
  best.goldEnds = goldEnds;
  return best;
}

function profileLuma(rgb) {
  if (!rgb) return 0;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

// A thin bright stroke with a darker band just inside it. The wave in a
// refractor is not this: it does not stay one width and it is not followed
// by one dark band. Width stays under 0.5 mm, so a white margin is not a stroke.
function frameMarksFromProfile(profile, stepMm) {
  const n = profile.length;
  if (n < 8) return [];
  const sm = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      acc += profileLuma(profile[j]);
      wsum++;
    }
    sm[i] = wsum ? acc / wsum : 0;
  }
  const marks = [];
  const start = Math.round(0.8 / stepMm);
  const maxWidth = Math.round(0.5 / stepMm);
  const minWidth = Math.max(2, Math.round(0.06 / stepMm));
  // A thin line falls away on both sides within half a millimetre. Try the
  // steeper fall first so a bright wave next to the line does not widen it
  // past 0.5 mm and hide it. A lower line can still use the gentler fall.
  function ridge(i, drop) {
    let lo = i;
    while (lo > 0 && (i - lo) <= maxWidth && sm[i] - sm[lo] < drop) lo--;
    let hi = i;
    while (hi < n - 1 && (hi - i) <= maxWidth && sm[i] - sm[hi] < drop) hi++;
    if (sm[i] - sm[lo] < drop || sm[i] - sm[hi] < drop) return null;
    const widthPx = hi - lo;
    if (widthPx < minWidth || widthPx > maxWidth) return null;
    let dark = 0;
    let darkGap = 0;
    const end = Math.min(n, hi + Math.round(1.6 / stepMm));
    for (let k = hi; k < end; k++) {
      if (sm[k] < 90 && sm[k] <= sm[i] - 60) {
        dark++;
        darkGap = 0;
      } else {
        darkGap++;
        if (dark > 3 && darkGap > 2) break;
      }
    }
    // The black line inside the silver is thicker than the silver. A dark
    // gap in a wave is about as wide as the bright ridge, so it does not count.
    if (dark * stepMm < 0.45) return null;
    // The profile is thin silver, thicker black, thin silver. The inner
    // silver is what separates that frame from a bright ridge in the wave.
    let darkEnd = hi;
    let gap = 0;
    const hunt = Math.min(n - 1, hi + Math.round(2.4 / stepMm));
    for (let k = hi; k <= hunt; k++) {
      if (sm[k] < 90 && sm[k] <= sm[i] - 60) {
        darkEnd = k;
        gap = 0;
      } else {
        gap++;
        if (gap > 2) break;
      }
    }
    let innerOuter = null;
    let innerWidth = null;
    const after = Math.min(n - 2, darkEnd + Math.round(1.4 / stepMm));
    for (let k = darkEnd + 1; k < after; k++) {
      if (!(sm[k] >= sm[k - 1] && sm[k] >= sm[k + 1] && sm[k] >= 130)) continue;
      let lo2 = k;
      while (lo2 > darkEnd && (k - lo2) <= maxWidth && sm[k] - sm[lo2] < 40) lo2--;
      let hi2 = k;
      while (hi2 < n - 1 && (hi2 - k) <= maxWidth && sm[k] - sm[hi2] < 40) hi2++;
      const w2 = hi2 - lo2;
      if (w2 < minWidth || w2 > maxWidth) continue;
      if (sm[k] - sm[lo2] < 40 || sm[k] - sm[hi2] < 40) continue;
      innerOuter = lo2 * stepMm;
      innerWidth = w2 * stepMm;
      break;
    }
    return {
      outer: lo * stepMm,
      width: widthPx * stepMm,
      black: hi * stepMm,
      dark: dark * stepMm,
      blackWidth: Math.max(0, (darkEnd - hi) * stepMm),
      inner: innerOuter,
      innerWidth: innerWidth,
      hi: hi
    };
  }
  for (let i = Math.max(1, start); i < n - 3; i++) {
    if (!(sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] >= 140)) continue;
    const mark = ridge(i, 70) || ridge(i, 40);
    if (!mark) continue;
    const hi = mark.hi;
    delete mark.hi;
    marks.push(mark);
    i = hi;
  }
  return marks.slice(0, 6);
}

// A thin gold line with a black band immediately inside it. Chrome rays are
// bright and neutral, or they are not followed by that black band, so they
// do not count. The outer value is the shallow edge of the gold.
function goldMarksFromProfile(profile, stepMm) {
  const n = profile.length;
  if (n < 8) return [];
  const yel = new Array(n);
  const lum = new Array(n);
  for (let i = 0; i < n; i++) {
    let yacc = 0;
    let lacc = 0;
    let wsum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j < 0 || j >= n || !profile[j]) continue;
      const rgb = profile[j];
      yacc += Math.min(rgb[0], rgb[1]) - rgb[2];
      lacc += profileLuma(rgb);
      wsum++;
    }
    yel[i] = wsum ? yacc / wsum : 0;
    lum[i] = wsum ? lacc / wsum : 0;
  }
  const marks = [];
  const start = Math.round(0.8 / stepMm);
  const maxWidth = Math.round(0.55 / stepMm);
  for (let i = Math.max(1, start); i < n - 3; i++) {
    if (!(yel[i] >= yel[i - 1] && yel[i] >= yel[i + 1] && yel[i] >= 9)) continue;
    if (lum[i] < 26 || lum[i] > 235) continue;
    let lo = i;
    while (lo > 0 && (i - lo) <= maxWidth && yel[i] - yel[lo] < 5) lo--;
    if (yel[i] - yel[lo] < 5) continue;
    let hi = i;
    while (hi < n - 1 && (hi - i) <= maxWidth && lum[hi + 1] >= 42 && yel[i] - yel[hi + 1] < 12) hi++;
    const widthMm = (hi - lo) * stepMm;
    if (widthMm < 0.06 || widthMm > 0.55) continue;
    let dark = 0;
    let gap = 0;
    const lumas = [];
    const hunt = Math.min(n - 1, hi + Math.round(2.0 / stepMm));
    let lastDark = hi;
    for (let k = hi; k <= hunt; k++) {
      if (lum[k] < 45) {
        dark++;
        gap = 0;
        lastDark = k;
        lumas.push(lum[k]);
      } else {
        gap++;
        if (dark > 4 && gap > 2) break;
      }
    }
    const blackWidth = (lastDark - hi) * stepMm;
    if (dark * stepMm < 0.9 || blackWidth < 0.9) continue;
    const blackMed = median(lumas);
    if (blackMed == null || blackMed > 32) continue;
    marks.push({
      outer: lo * stepMm,
      width: widthMm,
      black: hi * stepMm,
      blackWidth: blackWidth
    });
    i = Math.max(hi, lastDark);
  }
  return marks.slice(0, 4);
}

function clusterFrameMarks(stations, opts) {
  opts = opts || {};
  const profileOnly = !!opts.profile;
  const minPoints = opts.minPoints == null ? 6 : opts.minPoints;
  const minSpanFrac = opts.minSpanFrac == null ? 0.48 : opts.minSpanFrac;
  const minCov = opts.minCov == null ? 0.28 : opts.minCov;
  const minSpanMm = opts.minSpanMm == null ? 0 : opts.minSpanMm;
  const n = stations.length;
  const marks = [];
  let sideLen = 0;
  stations.forEach(function (st, i) {
    if (st.alongMm > sideLen) sideLen = st.alongMm;
    (st.frameMarks || []).forEach(function (mk) {
      // The black band is thicker than the silver. A dark gap in the wave is
      // about as wide as the bright ridge, so it stays under 0.7 mm.
      if (profileOnly && (mk.inner == null || !(mk.blackWidth >= 0.7) || !(mk.blackWidth > mk.width + 0.05))) return;
      marks.push({
        i: i,
        depth: mk.outer,
        width: mk.width,
        black: mk.black,
        dark: mk.dark,
        blackWidth: mk.blackWidth,
        inner: mk.inner,
        innerWidth: mk.innerWidth,
        alongMm: st.alongMm,
        x: st.x,
        y: st.y,
        nx: st.nx,
        ny: st.ny
      });
    });
  });
  const items = marks.slice().sort(function (a, b) { return a.depth - b.depth; });
  const groups = [];
  items.forEach(function (item) {
    let g = null;
    for (let gi = 0; gi < groups.length; gi++) {
      if (Math.abs(item.depth - groups[gi].median) <= 0.22 && item.depth <= groups[gi].min + 0.45) {
        g = groups[gi];
        break;
      }
    }
    if (!g) {
      groups.push({ points: [item], median: item.depth, min: item.depth, max: item.depth });
      return;
    }
    g.points.push(item);
    g.min = Math.min(g.min, item.depth);
    g.max = Math.max(g.max, item.depth);
    g.median = median(g.points.map(function (p) { return p.depth; }));
  });
  const usable = [];
  groups.forEach(function (g) {
    if (g.max - g.min > 0.45 || g.points.length < minPoints) return;
    const seen = {};
    const uniq = [];
    g.points.forEach(function (p) {
      if (seen[p.i]) return;
      seen[p.i] = true;
      uniq.push(p);
    });
    if (uniq.length < minPoints) return;
    const along = uniq.map(function (p) { return p.alongMm; });
    const span = Math.max.apply(null, along) - Math.min.apply(null, along);
    const cov = n ? uniq.length / n : 0;
    const width = median(uniq.map(function (p) { return p.width; }));
    if ((minSpanFrac > 0 && span < sideLen * minSpanFrac) || span < minSpanMm) return;
    if (minCov > 0 && cov < minCov) return;
    if (!(width >= 0.06 && width < 0.5)) return;
    const blacks = uniq.map(function (p) { return p.blackWidth; }).filter(function (v) { return v != null; });
    const inners = uniq.map(function (p) { return p.innerWidth; }).filter(function (v) { return v != null; });
    usable.push({
      points: uniq,
      median: median(uniq.map(function (p) { return p.depth; })),
      min: Math.min.apply(null, uniq.map(function (p) { return p.depth; })),
      max: Math.max.apply(null, uniq.map(function (p) { return p.depth; })),
      width: width,
      black: median(uniq.map(function (p) { return p.black; })),
      blackWidth: blacks.length ? median(blacks) : null,
      innerWidth: inners.length ? median(inners) : null,
      cov: cov,
      span: span,
      profile: profileOnly
    });
  });
  usable.sort(function (a, b) { return a.median - b.median; });
  return usable;
}

// Marks shallower than the chosen stroke that still run the side. That is an
// earlier line, so the deeper stroke is not the outline.
function earlierFrameBand(stations, medianMm) {
  let sideLen = 0;
  const marks = [];
  stations.forEach(function (st, i) {
    if (st.alongMm > sideLen) sideLen = st.alongMm;
    (st.frameMarks || []).forEach(function (mk) {
      if (mk.outer <= medianMm - 0.5) marks.push({ depth: mk.outer, along: st.alongMm, i: i });
    });
  });
  if (marks.length < 8 || !sideLen) return null;
  marks.sort(function (a, b) { return a.depth - b.depth; });
  let best = null;
  for (let a = 0; a < marks.length; a++) {
    const win = [];
    for (let b = a; b < marks.length && marks[b].depth <= marks[a].depth + 0.4; b++) win.push(marks[b]);
    const seen = {};
    const uniq = [];
    win.forEach(function (p) {
      if (seen[p.i]) return;
      seen[p.i] = true;
      uniq.push(p);
    });
    if (uniq.length < 6) continue;
    const along = uniq.map(function (p) { return p.along; });
    const span = Math.max.apply(null, along) - Math.min.apply(null, along);
    const cov = uniq.length / stations.length;
    if (cov < 0.2 || span < sideLen * 0.45) continue;
    const med = median(uniq.map(function (p) { return p.depth; }));
    if (!best || med < best.median) best = { median: med, cov: cov };
  }
  return best;
}

// The reported width is the outer edge at the points closest to the card
// edge. One stray pixel does not count: at least two points have to agree.
function outermostReading(line) {
  const points = line.points || [];
  if (!points.length) return null;
  const minD = Math.min.apply(null, points.map(function (p) { return p.depth; }));
  const tip = points.filter(function (p) { return p.depth <= minD + 0.08; });
  const use = tip.length >= 2
    ? tip
    : points.slice().sort(function (a, b) { return a.depth - b.depth; }).slice(0, Math.min(2, points.length));
  if (use.length < 2) return null;
  return {
    mm: median(use.map(function (p) { return p.depth; })),
    black: median(use.map(function (p) { return p.black; })),
    points: use
  };
}

// Points at one depth are one segment only while they stay in a run. A
// gap of a few millimetres is a design break. A gap across the side is two
// unrelated marks, and the longer run is the line.
function profileRuns(line) {
  const pts = (line.points || []).slice().sort(function (a, b) { return a.alongMm - b.alongMm; });
  if (pts.length < 2) return [];
  const raw = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].alongMm - pts[i - 1].alongMm > 3.2) {
      raw.push(cur);
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  raw.push(cur);
  const merged = [];
  raw.forEach(function (run) {
    const last = merged[merged.length - 1];
    if (last && run[0].alongMm - last[last.length - 1].alongMm <= 12) {
      run.forEach(function (p) { last.push(p); });
    } else {
      merged.push(run.slice());
    }
  });
  const runs = [];
  merged.forEach(function (run) {
    const span = run[run.length - 1].alongMm - run[0].alongMm;
    // Two samples are enough to measure a line that is already qualified.
    // Qualifying takes a run long enough that a wave speck cannot close
    // the rectangle by itself.
    if (run.length < 6 || span < 4) return;
    const depths = run.map(function (p) { return p.depth; });
    runs.push({
      points: run,
      median: median(depths),
      min: Math.min.apply(null, depths),
      max: Math.max.apply(null, depths),
      width: line.width,
      black: median(run.map(function (p) { return p.black; })),
      blackWidth: line.blackWidth,
      innerWidth: line.innerWidth,
      cov: line.points.length ? line.cov * (run.length / line.points.length) : 0,
      span: span,
      profile: true
    });
  });
  return runs;
}

// The same silver-black-silver profile on every side, including a segment
// that does not run the whole side. A profile that is missing on any side
// is not the outline.
function matchedProfileSegments(lists) {
  const names = ['top', 'bottom', 'left', 'right'];
  const near = {};
  names.forEach(function (name) {
    const list = lists[name] || [];
    if (!list.length) {
      near[name] = [];
      return;
    }
    const floor = list[0].median;
    // The outline is the outer stroke. A line several millimetres deeper
    // is an interior frame, not a second try at the same edge.
    near[name] = list.filter(function (line) { return line.median <= floor + 0.8; });
  });
  const idx = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let attempt = 0; attempt < 12; attempt++) {
    const pick = {};
    let ready = true;
    names.forEach(function (name) {
      const list = near[name] || [];
      if (idx[name] >= list.length) ready = false;
      else pick[name] = list[idx[name]];
    });
    if (!ready) return null;
    const widths = names.map(function (name) { return pick[name].width; });
    const blacks = names.map(function (name) { return pick[name].blackWidth; });
    const inners = names.map(function (name) { return pick[name].innerWidth; });
    const wMed = median(widths);
    const bMed = median(blacks);
    const iMed = median(inners);
    const wRange = Math.max.apply(null, widths) - Math.min.apply(null, widths);
    const bRange = Math.max.apply(null, blacks) - Math.min.apply(null, blacks);
    const same = wRange <= 0.15 && bRange <= 0.45 && names.every(function (name) {
      const line = pick[name];
      return line.points.length >= 2 &&
        Math.abs(line.width - wMed) <= 0.12 &&
        line.blackWidth != null && Math.abs(line.blackWidth - bMed) <= 0.3 &&
        line.innerWidth != null && Math.abs(line.innerWidth - iMed) <= 0.2 &&
        line.blackWidth > line.width + 0.05;
    });
    if (same) return pick;
    let worst = names[0];
    let worstD = -1;
    names.forEach(function (name) {
      const line = pick[name];
      const d = Math.abs(line.width - wMed) / 0.12 +
        Math.abs((line.blackWidth == null ? 0 : line.blackWidth) - bMed) / 0.3;
      if (d > worstD) {
        worstD = d;
        worst = name;
      }
    });
    idx[worst] += 1;
  }
  return null;
}

function publishFrameLine(side, line, stations) {
  const reading = outermostReading(line);
  if (!reading) return false;
  const source = (line.points && line.points.length >= 2) ? line.points : reading.points;
  const pts = source.map(function (p) {
    return {
      i: p.i,
      depth: p.depth,
      x: p.x,
      y: p.y,
      nx: p.nx,
      ny: p.ny,
      alongMm: p.alongMm,
      t: side.lengthMm ? p.alongMm / side.lengthMm : 0,
      strength: 20
    };
  });
  side.frameOuterMm = reading.mm;
  side.blackOuterMm = reading.black;
  side.frameDiffMm = reading.black - reading.mm;
  side.frameWidthMm = line.width;
  side.frameCoverage = line.cov;
  side.frameMatches = true;
  side.mm = reading.mm;
  side.withheld = false;
  side.reason = null;
  side.points = pts;
  side.used = pts;
  side.coverage = line.cov;
  side.shape = 'line';
  side.confidence = Math.round(Math.min(0.86, 0.42 + 0.5 * Math.max(line.cov, 0.2)) * 1000) / 1000;
  side.tiltDeg = designOutline.tiltDegrees(pts);
  side.elements = side.elements || [];
  side.elements.unshift(layerElement(
    { points: pts, median: reading.mm },
    stations.length,
    'outline',
    false,
    null
  ));
  return true;
}

// The shallowest gold-with-black mark in one end of the side. It counts only
// when the same edge continues and deepens toward the middle, which is the
// frame corner sticking out past the angled side. A ray does not.
function goldEndContact(stations, fromStart, lengthMm) {
  const len = lengthMm || 0;
  if (!len || !stations.length) return null;
  const windowMm = Math.min(18, Math.max(12, len * 0.28));
  const marks = [];
  stations.forEach(function (st, i) {
    const mk = st.goldMarks && st.goldMarks[0];
    if (!mk) return;
    marks.push({
      i: i,
      depth: mk.outer,
      black: mk.black,
      width: mk.width,
      blackWidth: mk.blackWidth,
      alongMm: st.alongMm,
      x: st.x,
      y: st.y,
      nx: st.nx,
      ny: st.ny
    });
  });
  if (marks.length < 2) return null;
  const inWindow = marks.filter(function (m) {
    return fromStart ? m.alongMm <= windowMm : m.alongMm >= len - windowMm;
  });
  const kept = inWindow.filter(function (h) {
    return marks.some(function (o) {
      return o !== h && Math.abs(o.alongMm - h.alongMm) <= 2 && Math.abs(o.depth - h.depth) <= 0.8;
    });
  });
  if (!kept.length) return null;
  const minD = Math.min.apply(null, kept.map(function (p) { return p.depth; }));
  const tip = kept.filter(function (p) { return p.depth <= minD + 0.1; });
  const corner = tip.slice().sort(function (a, b) {
    return fromStart ? a.alongMm - b.alongMm : b.alongMm - a.alongMm;
  })[0];
  const towardMid = marks.some(function (m) {
    const past = fromStart ? m.alongMm > corner.alongMm + 1.2 : m.alongMm < corner.alongMm - 1.2;
    const near = Math.abs(m.alongMm - corner.alongMm) <= 14;
    return past && near && m.depth >= corner.depth + 0.3;
  });
  if (!towardMid) return null;
  const use = tip.length >= 2
    ? tip
    : kept.slice().sort(function (a, b) { return a.depth - b.depth; }).slice(0, Math.min(2, kept.length));
  if (!use.length) return null;
  return {
    mm: median(use.map(function (p) { return p.depth; })),
    black: median(use.map(function (p) { return p.black; })),
    width: median(use.map(function (p) { return p.width; })),
    blackWidth: median(use.map(function (p) { return p.blackWidth; })),
    points: use,
    corner: corner
  };
}

function goldCornerOutline(sides) {
  const names = ['top', 'bottom', 'left', 'right'];
  const contacts = {};
  const widths = [];
  for (let n = 0; n < names.length; n++) {
    const name = names[n];
    const side = sides[name];
    const stations = ((side && side.stations) || []).concat((side && side.goldEnds) || []);
    const start = goldEndContact(stations, true, side && side.lengthMm);
    const end = goldEndContact(stations, false, side && side.lengthMm);
    if (!start || !end) return null;
    if (Math.abs(start.corner.alongMm - end.corner.alongMm) < side.lengthMm * 0.35) return null;
    // The two corners of one side are the two ends of the same frame. A
    // reading several millimetres deeper is an interior line, not that corner.
    if (Math.abs(start.mm - end.mm) > 1.5) return null;
    if (start.mm > 8 || end.mm > 8) return null;
    contacts[name] = { start: start, end: end };
    widths.push(start.width, end.width);
  }
  const wRange = Math.max.apply(null, widths) - Math.min.apply(null, widths);
  if (wRange > 0.28) return null;
  if (process.env.TRACE_GOLD) {
    names.forEach(function (name) {
      const c = contacts[name];
      process.stdout.write(name +
        ' start ' + c.start.mm.toFixed(2) + '@' + c.start.corner.alongMm.toFixed(1) +
        ' end ' + c.end.mm.toFixed(2) + '@' + c.end.corner.alongMm.toFixed(1) +
        ' w ' + c.start.width.toFixed(2) + '/' + c.end.width.toFixed(2) + '\n');
    });
  }
  return contacts;
}

function publishGoldSide(side, contact) {
  const raw = contact.start.points.concat(contact.end.points);
  const pts = raw.map(function (p) {
    return {
      i: p.i,
      depth: p.depth,
      black: p.black,
      width: p.width,
      x: p.x,
      y: p.y,
      nx: p.nx,
      ny: p.ny,
      alongMm: p.alongMm,
      t: side.lengthMm ? p.alongMm / side.lengthMm : 0,
      strength: 20
    };
  });
  const reading = outermostReading({ points: pts });
  if (!reading) return false;
  side.cornerContact = true;
  side.cornerDepths = [contact.start.mm, contact.end.mm].map(function (v) {
    return Math.round(v * 1000) / 1000;
  });
  side.frameOuterMm = reading.mm;
  side.blackOuterMm = reading.black;
  side.frameDiffMm = reading.black - reading.mm;
  side.frameWidthMm = median(pts.map(function (p) { return p.width; }));
  side.frameMatches = true;
  side.mm = reading.mm;
  side.withheld = false;
  side.reason = null;
  side.points = pts;
  side.used = pts;
  side.coverage = pts.length / Math.max(1, (side.stations || []).length + (side.goldEnds || []).length);
  side.shape = 'corners';
  side.confidence = 0.62;
  side.tiltDeg = designOutline.tiltDegrees(pts);
  return true;
}

// Patterned colour (a wave, a refractor) is margin. The outline is the outer
// edge of the silver-black-silver stroke when that same profile is on every
// side, even as a segment. A published outline on a plain margin is left alone.
function applyRectangularFrame(sides) {
  const names = ['top', 'bottom', 'left', 'right'];
  const found = {};
  const segments = {};
  const chromaticSide = {};
  names.forEach(function (name) {
    const side = sides[name];
    const stations = side && side.stations ? side.stations : [];
    const clusters = stations.length ? clusterFrameMarks(stations) : [];
    found[name] = clusters[0] || null;
    const rawSegments = stations.length
      ? clusterFrameMarks(stations, { profile: true, minPoints: 2, minSpanFrac: 0, minCov: 0, minSpanMm: 1.2 })
      : [];
    segments[name] = [];
    rawSegments.forEach(function (line) {
      profileRuns(line).forEach(function (run) { segments[name].push(run); });
    });
    segments[name].sort(function (a, b) { return a.median - b.median; });
    chromaticSide[name] = stations.filter(function (st) {
      return (st.marginPattern && !st.marginTextured) || st.marginVaried;
    }).length > stations.length * 0.5;
  });
  const chromaticCount = names.filter(function (name) { return chromaticSide[name]; }).length;
  const allOpen = names.every(function (name) {
    const side = sides[name];
    return !side || side.withheld || side.mm == null;
  });
  if (process.env.TRACE_FRAME) {
    names.forEach(function (name) {
      const list = segments[name] || [];
      process.stdout.write(name + ' chromatic ' + chromaticSide[name] + '\n');
      list.forEach(function (line) {
        if (line.median > 5 || line.points.length < 6) return;
        const along = line.points.map(function (p) { return p.alongMm; }).sort(function (a, b) { return a - b; });
        const runs = [];
        let cur = [along[0]];
        for (let i = 1; i < along.length; i++) {
          if (along[i] - along[i - 1] > 2.4) {
            runs.push(cur);
            cur = [along[i]];
          } else cur.push(along[i]);
        }
        runs.push(cur);
        const brief = runs.filter(function (r) { return r.length >= 2; }).map(function (r) {
          return r.length + '@' + r[0].toFixed(0) + '-' + r[r.length - 1].toFixed(0);
        }).join(',');
        process.stdout.write('  ' + line.median.toFixed(2) + ' w' + line.width.toFixed(2) + ' b' +
          (line.blackWidth == null ? '-' : line.blackWidth.toFixed(2)) + ' runs ' + brief + '\n');
      });
    });
  }
  const profileMatch = matchedProfileSegments(segments);
  if (process.env.TRACE_FRAME) {
    process.stdout.write('match ' + (profileMatch ? names.map(function (name) {
      const line = profileMatch[name];
      return name + ' ' + line.median.toFixed(2) + ' w' + line.width.toFixed(2) + ' b' +
        (line.blackWidth == null ? '-' : line.blackWidth.toFixed(2)) + ' n' + line.points.length;
    }).join(' | ') : 'none') + ' chromatic ' + chromaticCount + ' open ' + allOpen + '\n');
  }
  if (profileMatch && (chromaticCount >= 3 || allOpen)) {
    names.forEach(function (name) {
      const side = sides[name];
      if (!side) return;
      side.marginPatterned = !!chromaticSide[name];
      side.sawProfile = segments[name].length > 0;
      publishFrameLine(side, profileMatch[name], side.stations || []);
      delete side.stations;
      delete side.goldEnds;
    });
    return;
  }
  // No silver-black-silver rectangle. A gold line with black immediately
  // inside, the same profile at all four outer corners, is the outline when
  // every side is still open. The contact on each side is those two corners.
  // A published outline on any side is left alone.
  if (allOpen) {
    const gold = goldCornerOutline(sides);
    if (gold) {
      let published = true;
      names.forEach(function (name) {
        const side = sides[name];
        if (!side || !publishGoldSide(side, gold[name])) published = false;
      });
      if (published) {
        names.forEach(function (name) {
          const side = sides[name];
          if (!side) return;
          side.marginPatterned = !!chromaticSide[name];
          side.sawProfile = segments[name].length > 0;
          delete side.stations;
          delete side.goldEnds;
        });
        return;
      }
    }
  }
  const widths = [];
  names.forEach(function (name) {
    if (found[name]) widths.push(found[name].width);
  });
  const widthMed = widths.length >= 3 ? median(widths) : null;
  names.forEach(function (name) {
    const side = sides[name];
    if (!side) return;
    const stations = side.stations || [];
    // One dark side of a wave can miss the colour test. The stroke still
    // counts when the other three sides already show the patterned margin.
    const chromatic = chromaticSide[name] || chromaticCount >= 3;
    const line = found[name];
    const matches = !!(line && widthMed != null && Math.abs(line.width - widthMed) <= 0.15);
    if (line) {
      const reading = outermostReading(line);
      side.frameOuterMm = reading ? reading.mm : line.median;
      side.blackOuterMm = reading ? reading.black : line.black;
      side.frameDiffMm = side.blackOuterMm - side.frameOuterMm;
      side.frameWidthMm = line.width;
      side.frameCoverage = line.cov;
      side.frameMatches = matches;
    }
    // A patterned margin has no outline outside this stroke. A plain margin
    // never reaches here, so a border outside an interior line stays.
    // A shallower band that already runs the side is an earlier line. Do not
    // publish a deeper stroke over it.
    const earlier = line ? earlierFrameBand(stations, line.median) : null;
    if (matches && chromatic && line && earlier) {
      side.frameOuterMm = earlier.median;
      side.blackOuterMm = null;
      side.frameDiffMm = null;
      side.frameWidthMm = null;
      side.frameCoverage = earlier.cov;
      side.frameMatches = false;
      side.mm = null;
      side.withheld = true;
      side.reason = 'unclear';
      side.confidence = Math.min(side.confidence || 0, 0.34);
    } else if (chromatic && line && !matches && side.mm != null && !side.withheld) {
      side.mm = null;
      side.withheld = true;
      side.reason = 'unclear';
      side.confidence = Math.min(side.confidence || 0, 0.34);
    } else if (matches && chromatic && line) {
      publishFrameLine(side, line, stations);
    }
    side.marginPatterned = !!chromaticSide[name];
    side.sawProfile = segments[name].length > 0;
    delete side.stations;
    delete side.goldEnds;
  });
}

function frameShare(sides, field, a, b) {
  const sa = sides[a];
  const sb = sides[b];
  if (!sa || !sb) return null;
  const va = field === 'mm' ? sa.mm : sa[field];
  const vb = field === 'mm' ? sb.mm : sb[field];
  if (va == null || vb == null || va + vb <= 0) return null;
  return va / (va + vb);
}

function frameCheck(sides) {
  const top = frameShare(sides, 'mm', 'top', 'bottom');
  const topBlack = frameShare(sides, 'blackOuterMm', 'top', 'bottom');
  const left = frameShare(sides, 'mm', 'left', 'right');
  const leftBlack = frameShare(sides, 'blackOuterMm', 'left', 'right');
  function pack(share, black) {
    if (share == null && black == null) return null;
    return {
      outline: share == null ? null : Math.round(share * 1000) / 1000,
      black: black == null ? null : Math.round(black * 1000) / 1000,
      diff: share == null || black == null ? null : Math.round((share - black) * 1000) / 1000
    };
  }
  return {
    topShare: pack(top, topBlack),
    leftShare: pack(left, leftBlack)
  };
}

function dimensionsAreCard(widthMm, heightMm) {
  function fit(w, h) {
    return Math.abs(w - NOMINAL_W_MM) <= SIZE_AXIS_MM && Math.abs(h - NOMINAL_H_MM) <= SIZE_AXIS_MM;
  }
  return fit(widthMm, heightMm) || fit(heightMm, widthMm);
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
      // A short step just outside a boundary that continues along the side
      // is texture in the margin, not a second outline. 0.16 mm still keeps
      // a real nearer element (a frame that only covers part of the side).
      if (other.median <= layer.median + 0.16) continue;
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
  const clear = measuredPts.length >= 2 && measSpread <= 0.36 && coverage >= OUTLINE_COVERAGE && isFinite(reported);
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

function measureImage(data, w, h, dpi, bedModel) {
  const ppm = pxPerMm(dpi);
  const paperModel = estimatePaper(data, w, h);
  const first = measureWithPaper(data, w, h, dpi, ppm, paperModel);
  // A tight crop's corners include the card, so this gate rises until silver
  // and yellow count as the pink bed and the quad keeps only the dark half.
  // The uncropped sheet's corners are the bed. Use that gate when the crop
  // gate did not find a card.
  const missed = !first.ok || !first.sizeOk;
  if (missed && bedModel && isFinite(bedModel.threshold) &&
      bedModel.threshold + 1 < paperModel.threshold) {
    const retry = measureWithPaper(data, w, h, dpi, ppm, bedModel);
    if (retry.ok && retry.sizeOk) return retry;
  }
  return first;
}

function pointOnCard(quad, u, v) {
  const tl = quad.corners.tl;
  const tr = quad.corners.tr;
  const bl = quad.corners.bl;
  const br = quad.corners.br;
  const ax = tl.x + (tr.x - tl.x) * u;
  const ay = tl.y + (tr.y - tl.y) * u;
  const bx = bl.x + (br.x - bl.x) * u;
  const by = bl.y + (br.y - bl.y) * u;
  return { x: ax + (bx - ax) * v, y: ay + (by - ay) * v };
}

function rgbLuma(rgb) {
  return profileLuma(rgb);
}

function rgbChroma(rgb) {
  if (!rgb) return 0;
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

// Full-bleed cards have no frame. A player-name line can be reported as a
// design reference, and a corner diamond or a letter descender can be stored
// as an anchor. Neither one is a centering grade.
function collectDesignReference(data, w, h, quad, sides) {
  const top = sides.top;
  const bottom = sides.bottom;
  if (!top || !bottom || top.mm != null || bottom.mm != null) return null;
  if (!top.withheld || !bottom.withheld) return null;
  // A card that already has the silver-black-silver profile is a framed
  // card, even when that frame was withheld. Do not read its lettering as
  // a border. A full-bleed photo has no such profile.
  const framed = ['top', 'bottom', 'left', 'right'].filter(function (name) {
    return sides[name] && sides[name].sawProfile;
  }).length;
  if (framed >= 3) return null;
  const widthMm = quad.widthMm;
  const heightMm = quad.heightMm;
  if (!(widthMm > 20 && heightMm > 20)) return null;
  const rows = [];
  for (let y = heightMm * 0.62; y < heightMm - 0.35; y += 0.12) {
    const samples = [];
    for (let x = 0.6; x < widthMm - 0.6; x += 0.16) {
      const p = pointOnCard(quad, x / widthMm, y / heightMm);
      const rgb = sampleRgb(data, w, h, p.x, p.y);
      samples.push({ x: x, y: y, L: rgbLuma(rgb) });
    }
    if (samples.length < 20) continue;
    const sorted = samples.map(function (s) { return s.L; }).sort(function (a, b) { return a - b; });
    const med = sorted[Math.floor(sorted.length / 2)];
    // Lettering for a design reference sits on a dark field. A bright photo
    // (a uniform, the grass) is not that field, so it is not used.
    if (med > 105) continue;
    const ink = samples.filter(function (s) { return s.L >= med + 32 && s.L >= 120; });
    if (ink.length < 10) continue;
    const xs = ink.map(function (s) { return s.x; });
    const x0 = Math.min.apply(null, xs);
    const x1 = Math.max.apply(null, xs);
    if (x1 - x0 < 10 || x1 - x0 > widthMm * 0.82) continue;
    rows.push({ y: y, x0: x0, x1: x1, n: ink.length });
  }
  const bands = [];
  rows.forEach(function (row) {
    const last = bands[bands.length - 1];
    if (last && row.y - last.to <= 0.45) {
      last.to = row.y;
      last.x0 = Math.min(last.x0, row.x0);
      last.x1 = Math.max(last.x1, row.x1);
      last.rows.push(row);
    } else {
      bands.push({ from: row.y, to: row.y, x0: row.x0, x1: row.x1, rows: [row] });
    }
  });
  const named = bands.filter(function (b) {
    return (b.to - b.from) >= 0.45 && (b.to - b.from) <= 6.5 && (b.x1 - b.x0) >= 14;
  });
  let playerName = null;
  let teamDescender = null;
  if (named.length) {
    const name = named[0];
    const left = pointOnCard(quad, name.x0 / widthMm, ((name.from + name.to) / 2) / heightMm);
    const right = pointOnCard(quad, name.x1 / widthMm, ((name.from + name.to) / 2) / heightMm);
    playerName = {
      role: 'design-referenced',
      grade: false,
      source: 'player-name',
      leftMm: roundMm(name.x0),
      rightMm: roundMm(widthMm - name.x1),
      left: { x: left.x, y: left.y },
      right: { x: right.x, y: right.y }
    };
    const team = named.length >= 2 ? named[1] : null;
    if (team) {
      let lowY = team.from;
      let lowX = (team.x0 + team.x1) / 2;
      for (let y = team.from; y <= Math.min(heightMm - 0.2, team.to + 1.2); y += 0.06) {
        for (let x = Math.max(0.4, team.x0 - 1); x <= Math.min(widthMm - 0.4, team.x1 + 1); x += 0.1) {
          const p = pointOnCard(quad, x / widthMm, y / heightMm);
          const rgb = sampleRgb(data, w, h, p.x, p.y);
          const L = rgbLuma(rgb);
          if (L < 120) continue;
          const around = [];
          for (let k = -3; k <= 3; k++) {
            const q = pointOnCard(quad, x / widthMm, Math.min(0.99, (y + k * 0.2) / heightMm));
            around.push(rgbLuma(sampleRgb(data, w, h, q.x, q.y)));
          }
          around.sort(function (a, b) { return a - b; });
          const med = around[3];
          if (L >= med + 28 && y >= lowY) {
            lowY = y;
            lowX = x;
          }
        }
      }
      const tip = pointOnCard(quad, lowX / widthMm, lowY / heightMm);
      teamDescender = {
        role: 'anchor',
        grade: false,
        source: 'team-name-descender',
        fromBottomMm: roundMm(heightMm - lowY),
        fromLeftMm: roundMm(lowX),
        x: tip.x,
        y: tip.y
      };
    }
  }
  let diamondTip = null;
  const step = 0.2;
  const ys = [];
  const xs = [];
  for (let y = 1.0; y < heightMm * 0.36; y += step) ys.push(y);
  for (let x = 0.8; x < widthMm * 0.5; x += step) xs.push(x);
  let textureN = 0;
  const grid = ys.map(function () { return xs.map(function () { return 0; }); });
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length; i++) {
      let lo = 255;
      let hi = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const p = pointOnCard(quad,
            Math.min(0.98, Math.max(0.01, (xs[i] + dx * 0.18) / widthMm)),
            Math.min(0.98, Math.max(0.01, (ys[j] + dy * 0.18) / heightMm)));
          const L = rgbLuma(sampleRgb(data, w, h, p.x, p.y));
          if (L < lo) lo = L;
          if (L > hi) hi = L;
        }
      }
      // Fine hatching in a metal logo, not a smooth photo.
      if (hi - lo >= 45) {
        grid[j][i] = 1;
        textureN++;
      }
    }
  }
  if (process.env.TRACE_ANCHOR) process.stdout.write('texture cells ' + textureN + '\n');
  const seen = ys.map(function () { return xs.map(function () { return 0; }); });
  let bestDiamond = null;
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length; i++) {
      if (!grid[j][i] || seen[j][i]) continue;
      const stack = [[j, i]];
      seen[j][i] = 1;
      const cells = [];
      while (stack.length) {
        const cur = stack.pop();
        cells.push(cur);
        const cj = cur[0];
        const ci = cur[1];
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
          const nj = cj + d[0];
          const ni = ci + d[1];
          if (nj < 0 || ni < 0 || nj >= ys.length || ni >= xs.length) return;
          if (!grid[nj][ni] || seen[nj][ni]) return;
          seen[nj][ni] = 1;
          stack.push([nj, ni]);
        });
      }
      if (cells.length < 40 || cells.length > 6000) continue;
      let minJ = cells[0][0];
      let maxJ = cells[0][0];
      let minI = cells[0][1];
      let maxI = cells[0][1];
      cells.forEach(function (c) {
        if (c[0] < minJ) minJ = c[0];
        if (c[0] > maxJ) maxJ = c[0];
        if (c[1] < minI) minI = c[1];
        if (c[1] > maxI) maxI = c[1];
      });
      const boxH = (maxJ - minJ + 1) * step;
      const boxW = (maxI - minI + 1) * step;
      if (boxW < 3.5 || boxW > 22 || boxH < 3.5 || boxH > 20) continue;
      if (process.env.TRACE_ANCHOR) {
        process.stdout.write('blob ' + cells.length + ' ' + boxW.toFixed(1) + 'x' + boxH.toFixed(1) +
          ' at ' + xs[minI].toFixed(1) + ',' + ys[minJ].toFixed(1) + '\n');
      }
      const topCells = cells.filter(function (c) { return c[0] <= minJ + 1; });
      const midCells = cells.filter(function (c) {
        return c[0] >= minJ + (maxJ - minJ) * 0.35 && c[0] <= minJ + (maxJ - minJ) * 0.65;
      });
      const topW = topCells.length ? (Math.max.apply(null, topCells.map(function (c) { return c[1]; })) - Math.min.apply(null, topCells.map(function (c) { return c[1]; })) + 1) * step : boxW;
      const midW = midCells.length ? (Math.max.apply(null, midCells.map(function (c) { return c[1]; })) - Math.min.apply(null, midCells.map(function (c) { return c[1]; })) + 1) * step : boxW;
      if (!(topW < midW * 0.7 && topCells.length <= 12)) continue;
      const tipX = median(topCells.map(function (c) { return xs[c[1]]; }));
      const tipY = ys[minJ];
      if (!bestDiamond || tipY < bestDiamond.fromTopMm) {
        const at = pointOnCard(quad, tipX / widthMm, tipY / heightMm);
        bestDiamond = {
          role: 'anchor',
          grade: false,
          source: 'diamond-tip',
          fromTopMm: roundMm(tipY),
          fromLeftMm: roundMm(tipX),
          x: at.x,
          y: at.y
        };
      }
    }
  }
  diamondTip = bestDiamond;
  if (!playerName && !teamDescender && !diamondTip) return null;
  return {
    grade: false,
    centering: false,
    playerName: playerName,
    diamondTip: diamondTip,
    teamDescender: teamDescender
  };
}

function measureWithPaper(data, w, h, dpi, ppm, paperModel) {
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
  applyRectangularFrame(sides);
  const sizeOk = dimensionsAreCard(quad.widthMm, quad.heightMm);
  if (!sizeOk) withholdNotCardSized(sides);
  const designReference = sizeOk ? collectDesignReference(data, w, h, quad, sides) : null;
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
    frameCheck: frameCheck(sides),
    designReference: designReference,
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
    tiltDeg: side.tiltDeg == null || !isFinite(side.tiltDeg) ? null : Math.round(side.tiltDeg * 1000) / 1000,
    frameOuterMm: side.frameOuterMm == null ? null : roundMm(side.frameOuterMm),
    blackOuterMm: side.blackOuterMm == null ? null : roundMm(side.blackOuterMm),
    frameDiffMm: side.frameDiffMm == null ? null : roundMm(side.frameDiffMm),
    frameWidthMm: side.frameWidthMm == null ? null : roundMm(side.frameWidthMm),
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
        frameCheck: entry.result.frameCheck || null,
        designReference: entry.result.designReference || null,
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
    definition: 'Border is the perpendicular distance from the card edge to the outermost points of the design-block outline on that side. A patterned margin is margin, including chrome rays and angled shapes. The outline may be a segment: the same thin-silver, thicker-black, thin-silver profile has to appear on all four sides, parallel to the edges. A gold line with black immediately inside it is the outline when that same profile is on all four sides; the contacts are the outer corners, two per side. A logo, stamp, lettering, or ray on only one side is not the outline. The published value is the mean of the upright scan and the swapped 180 degree scan. An axis is accepted only when the bias estimated from each of its two sides agrees within 0.02 mm. That bias is reported and is not subtracted as a constant. tiltDeg is the outline angle against the card edge, in degrees, positive when the border widens toward the side end corner. A design-referenced name edge or an anchor (a diamond tip, a letter descender) is not a centering measurement and is not a grade. Unapproved until a person checks the overlay.',
    cards: outCards
  };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
  });
}

// The cyan line follows the outline points. A single depth at the median
// cuts through a tilted frame on the side where the frame is closer to the cut.
function outlinePolyline(side, dpi) {
  const hasPts = side && ((side.used && side.used.length >= 2) || (side.points && side.points.length >= 2));
  if (!side || !side.edge || (side.mm == null && !hasPts)) return null;
  const ppm = pxPerMm(dpi);
  const a = side.edge.a;
  const b = side.edge.b;
  const lenPx = hypot(b.x - a.x, b.y - a.y);
  const lenMm = side.lengthMm || (lenPx / ppm);
  const pts = (side.used || []).filter(function (p) {
    return p && isFinite(p.depth) && isFinite(p.alongMm);
  }).slice().sort(function (p, q) { return p.alongMm - q.alongMm; });
  function atAlong(alongMm, depthMm) {
    const t = lenMm > 0 ? alongMm / lenMm : 0;
    const depth = Math.max(0, depthMm);
    return {
      x: a.x + (b.x - a.x) * t + side.edge.nx * depth * ppm,
      y: a.y + (b.y - a.y) * t + side.edge.ny * depth * ppm
    };
  }
  if (pts.length < 2) {
    return [atAlong(0, side.mm), atAlong(lenMm, side.mm)];
  }
  const slope = (pts[pts.length - 1].depth - pts[0].depth) /
    Math.max(0.5, pts[pts.length - 1].alongMm - pts[0].alongMm);
  const poly = [atAlong(0, pts[0].depth + slope * (0 - pts[0].alongMm))];
  pts.forEach(function (p) {
    poly.push(atAlong(p.alongMm, p.depth));
  });
  const last = pts[pts.length - 1];
  poly.push(atAlong(lenMm, last.depth + slope * (lenMm - last.alongMm)));
  return poly;
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
    const markR = side.cornerContact ? pointR * 2.4 : pointR;
    (side.points || []).forEach(function (p) {
      const px = p.x + side.edge.nx * p.depth * pxPerMm(result.dpi);
      const py = p.y + side.edge.ny * p.depth * pxPerMm(result.dpi);
      parts.push('<circle cx="' + sx(px) + '" cy="' + sy(py) + '" r="' + markR + '" fill="' + col + '" fill-opacity="0.95"/>');
    });
    (side.used || []).forEach(function (p) {
      const px = p.x + side.edge.nx * p.depth * pxPerMm(result.dpi);
      const py = p.y + side.edge.ny * p.depth * pxPerMm(result.dpi);
      parts.push('<circle cx="' + sx(px) + '" cy="' + sy(py) + '" r="' + (pointR + 1.5) + '" fill="none" stroke="#ffffff" stroke-width="' + Math.max(1, stroke * 0.35) + '"/>');
    });
    const poly = side.cornerContact ? [] : (outlinePolyline(side, result.dpi) || []);
    if (poly.length >= 2) {
      const pointsAttr = poly.map(function (p) { return sx(p.x) + ',' + sy(p.y); }).join(' ');
      parts.push(
        '<polyline points="' + pointsAttr + '" fill="none" stroke="#000000" stroke-width="' + (stroke + 2) + '" stroke-linejoin="round"/>'
      );
      parts.push(
        '<polyline points="' + pointsAttr + '" fill="none" stroke="#3ee0ff" stroke-width="' + stroke + '" stroke-linejoin="round"/>'
      );
    }
    if (!labels) return;
    const labelX = (side.edge.a.x + side.edge.b.x) / 2 + side.edge.nx * 40 / scale;
    const labelY = (side.edge.a.y + side.edge.b.y) / 2 + side.edge.ny * 40 / scale;
    const tiltNote = side.tiltDeg == null || !isFinite(side.tiltDeg)
      ? ''
      : '  tilt ' + side.tiltDeg.toFixed(2) + '°';
    const covNote = side.coverage == null ? '' : '  cov ' + Math.round(side.coverage * 100) + '%';
    const confNote = side.confidence == null ? '' : '  conf ' + side.confidence.toFixed(2);
    const shown = side.mm != null ? side.mm : candidateDepth(side);
    const blackNote = side.blackOuterMm == null
      ? ''
      : '  black ' + side.blackOuterMm.toFixed(2);
    const text = side.withheld
      ? name + ' withheld' + (side.reason ? ' (' + side.reason + ')' : '') +
        (shown == null ? '' : '  candidate ' + shown.toFixed(2) + ' mm') + blackNote + covNote + confNote + tiltNote
      : name + ' ' + side.mm.toFixed(2) + ' mm' + blackNote + covNote + confNote + tiltNote;
    const anchor = name === 'right' ? 'end' : (name === 'left' ? 'start' : 'middle');
    parts.push(
      '<text x="' + sx(labelX) + '" y="' + sy(labelY) + '" fill="#ffffff" font-size="22" font-family="sans-serif" stroke="#000000" stroke-width="3" paint-order="stroke" text-anchor="' + anchor + '" dominant-baseline="middle">' +
      esc(text) + '</text>'
    );
  });
  const ref = !onlySide && result.designReference;
  if (ref) {
    const marks = [];
    if (ref.diamondTip) marks.push(ref.diamondTip);
    if (ref.teamDescender) marks.push(ref.teamDescender);
    if (ref.playerName && ref.playerName.left) marks.push(ref.playerName.left);
    if (ref.playerName && ref.playerName.right) marks.push(ref.playerName.right);
    marks.forEach(function (p) {
      if (!p || p.x == null) return;
      parts.push('<circle cx="' + sx(p.x) + '" cy="' + sy(p.y) + '" r="' + (pointR + 2) + '" fill="none" stroke="#ff4dff" stroke-width="' + stroke + '"/>');
    });
  }
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
    sourceHeight: h,
    bedModel: paperModel
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
  const ref = result.designReference;
  if (ref) {
    [ref.diamondTip, ref.teamDescender].forEach(function (p) {
      if (!p || p.x == null) return;
      p.x += origin.x;
      p.y += origin.y;
    });
    if (ref.playerName) {
      ['left', 'right'].forEach(function (k) {
        const p = ref.playerName[k];
        if (!p || p.x == null) return;
        p.x += origin.x;
        p.y += origin.y;
      });
    }
  }
  return result;
}

async function measureFile(file, dpi) {
  const loaded = await loadRaster(file);
  if (loaded.error) return { ok: false, error: loaded.error, dpi: dpi };
  const result = measureImage(loaded.full.data, loaded.full.width, loaded.full.height, dpi, loaded.bedModel);
  return shiftResult(result, loaded.origin);
}

function flatbedManifestPath() {
  return path.join(__dirname, '..', 'reference', 'flatbed_manifest.json');
}

function loadFlatbedManifest(file) {
  const manifestFile = file || flatbedManifestPath();
  const raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const byName = {};
  Object.keys(raw).forEach(function (name) {
    const entry = raw[name];
    if (!entry || typeof entry !== 'object') return;
    const deck = String(entry.deck || '').trim().toUpperCase();
    const orientation = String(entry.orientation || '').trim().toLowerCase();
    if (!deck || (orientation !== 'up' && orientation !== '180')) return;
    byName[name] = { card: deck, orientation: orientation };
  });
  return byName;
}

function parseScanName(file, manifest) {
  const base = path.basename(file);
  const table = manifest || loadFlatbedManifest();
  const hit = table[base];
  if (!hit) return null;
  return { card: hit.card, orientation: hit.orientation, file: file };
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

function listScans(dir, manifest) {
  if (!dir || !fs.existsSync(dir)) return [];
  const table = manifest || loadFlatbedManifest();
  return Object.keys(table)
    .filter(function (name) { return fs.existsSync(path.join(dir, name)); })
    .map(function (name) { return path.join(dir, name); })
    .sort(function (a, b) {
      const pa = table[path.basename(a)];
      const pb = table[path.basename(b)];
      const ka = pa.card + '\0' + (pa.orientation === 'up' ? '0' : '1');
      const kb = pb.card + '\0' + (pb.orientation === 'up' ? '0' : '1');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
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

const REVIEW_MAX_BYTES = 3 * 1024 * 1024;

function reviewCropBox(side, dpi, imageW, imageH) {
  const ppm = pxPerMm(dpi);
  const outside = 2.2 * ppm;
  const inside = 8 * ppm;
  const along = 14 * ppm;
  const a = side.edge.a;
  const b = side.edge.b;
  const nx = side.edge.nx;
  const ny = side.edge.ny;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(1, hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const a2 = { x: mx - ux * along, y: my - uy * along };
  const b2 = { x: mx + ux * along, y: my + uy * along };
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

async function composeOverlay(file, result, options) {
  const meta = await sharp(file).rotate().metadata();
  let originX = 0;
  let originY = 0;
  let srcW = meta.width;
  let srcH = meta.height;
  let img = sharp(file).rotate();
  if (options.extract) {
    const box = options.extract;
    img = img.extract(box);
    originX = box.left;
    originY = box.top;
    srcW = box.width;
    srcH = box.height;
  }
  const rot = options.rotate || 0;
  const rotMod = Math.abs(rot % 180);
  const quarterTurn = rotMod > 45 && rotMod < 135;
  const limitW = quarterTurn ? options.maxHeight : options.maxWidth;
  const limitH = quarterTurn ? options.maxWidth : options.maxHeight;
  let scale = 1;
  if (limitW) scale = Math.min(scale, limitW / srcW);
  if (limitH) scale = Math.min(scale, limitH / srcH);
  if (!isFinite(scale) || scale <= 0) scale = 1;
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));
  const base = await img.resize(dw, dh).png().toBuffer();
  const stroke = options.stroke == null ? Math.max(2, Math.round(2.5 / Math.max(scale, 0.2))) : options.stroke;
  const svg = buildOverlaySvg(result, {
    scale: scale,
    originX: originX,
    originY: originY,
    width: dw,
    height: dh,
    stroke: stroke,
    pointR: options.pointR == null ? Math.max(2.2, stroke * 0.7) : options.pointR,
    labels: options.labels !== false,
    side: options.side || null
  });
  let out = await sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  if (options.rotate) {
    out = await sharp(out).rotate(options.rotate, { background: { r: 18, g: 18, b: 18 } }).png().toBuffer();
  }
  return out;
}

function rotateInwardDown(edge) {
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  const along = Math.atan2(dy, dx);
  let deg = -along * 180 / Math.PI;
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const iy = edge.nx * s + edge.ny * c;
  if (iy < 0) deg += 180;
  return Math.round(deg);
}

function reviewCaption(text, width) {
  const h = 28;
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + h + '">' +
    '<text x="8" y="20" fill="#ffffff" font-size="18" font-family="sans-serif">' + esc(text) + '</text></svg>'
  );
}

function candidateDepth(side) {
  const pts = (side.used && side.used.length) ? side.used : (side.points || []);
  const depths = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i] && isFinite(pts[i].depth)) depths.push(pts[i].depth);
  }
  return median(depths);
}

function sideCaption(side, result) {
  const s = result && result.sides && result.sides[side];
  if (!s) return side + '  no edge';
  const tilt = s.tiltDeg == null || !isFinite(s.tiltDeg) ? '' : '   tilt ' + s.tiltDeg.toFixed(2) + '°';
  const cov = s.coverage == null ? '' : '   cov ' + Math.round(s.coverage * 100) + '%';
  const conf = s.confidence == null ? '' : '   conf ' + s.confidence.toFixed(2);
  const shown = s.mm != null ? s.mm : candidateDepth(s);
  const ref = result && result.designReference;
  let design = '';
  if (ref && ref.grade === false) {
    if (side === 'left' && ref.playerName) {
      design = '   design-referenced ' + ref.playerName.leftMm.toFixed(3) + ' mm (player name, not a grade)';
    } else if (side === 'right' && ref.playerName) {
      design = '   design-referenced ' + ref.playerName.rightMm.toFixed(3) + ' mm (player name, not a grade)';
    } else if (side === 'top' && ref.diamondTip) {
      design = '   anchor diamond tip ' + ref.diamondTip.fromTopMm.toFixed(3) + ' mm from top, ' +
        ref.diamondTip.fromLeftMm.toFixed(3) + ' mm from left (not a grade)';
    } else if (side === 'bottom' && ref.teamDescender) {
      design = '   anchor team-name descender ' + ref.teamDescender.fromBottomMm.toFixed(3) +
        ' mm from bottom (not a grade)';
    }
  }
  const black = s.blackOuterMm == null || (s.mm != null && s.frameOuterMm != null && Math.abs(s.frameOuterMm - s.mm) > 0.08)
    ? ''
    : '   black ' + s.blackOuterMm.toFixed(3) + ' diff ' + (s.frameDiffMm == null ? '—' : s.frameDiffMm.toFixed(3));
  const corners = s.cornerContact && s.cornerDepths
    ? '   corners ' + s.cornerDepths.map(function (d) { return d.toFixed(2); }).join(' / ')
    : '';
  if (s.withheld || s.mm == null) {
    const cand = shown == null ? '' : '   candidate ' + shown.toFixed(3) + ' mm';
    return side + '  withheld' + (s.reason ? ' (' + s.reason + ')' : '') + cand + black + corners + design + cov + conf + tilt;
  }
  return side + '  ' + s.mm.toFixed(3) + ' mm' + black + corners + design + cov + conf + tilt;
}

async function writeCardReviewSheet(cardId, scans, dest) {
  const canvasW = 1500;
  const gap = 14;
  const pieces = [];
  let y = gap;
  function add(buf, left, top) {
    pieces.push({ input: buf, left: left, top: top });
  }
  const ordered = scans.slice().sort(function (a, b) {
    if (a.orientation === b.orientation) return 0;
    return a.orientation === 'up' ? -1 : 1;
  });
  for (let i = 0; i < ordered.length; i++) {
    const scan = ordered[i];
    const result = scan.result;
    const cardMm = result && result.cardMm;
    const sizeText = cardMm ? cardMm.width.toFixed(2) + ' x ' + cardMm.height.toFixed(2) + ' mm' : 'no card';
    const header = cardId + '  ' + scan.orientation + '  ' + sizeText +
      (result && result.sizeOk === false ? '  NOT CARD SIZED' : '');
    add(reviewCaption(header, canvasW), 0, y);
    y += 28;
    if (!result || !result.ok) {
      add(reviewCaption('not measured', canvasW), 0, y);
      y += 28 + gap;
      continue;
    }
    const full = await composeOverlay(scan.file, result, { maxHeight: 520, maxWidth: 420, labels: false });
    const fullMeta = await sharp(full).metadata();
    add(full, Math.round((canvasW - fullMeta.width) / 2), y);
    y += fullMeta.height + 8;
    const meta = await sharp(scan.file).rotate().metadata();
    const stripW = canvasW - gap * 2;
    for (let s = 0; s < 4; s++) {
      const name = ['top', 'bottom', 'left', 'right'][s];
      const side = result.sides[name];
      add(reviewCaption(sideCaption(name, result), stripW), gap, y);
      y += 26;
      if (!side || !side.edge) {
        y += 4;
        continue;
      }
      const box = reviewCropBox(side, result.dpi, meta.width, meta.height);
      const turn = (name === 'left' || name === 'right') ? rotateInwardDown(side.edge) : 0;
      const crop = await composeOverlay(scan.file, result, {
        extract: box,
        maxWidth: stripW,
        maxHeight: 190,
        labels: false,
        side: name,
        stroke: 4,
        pointR: 3.5,
        rotate: turn || null
      });
      const cm = await sharp(crop).metadata();
      add(crop, gap, y);
      y += cm.height + 8;
    }
    y += gap;
  }
  const canvasH = Math.max(y, 32);
  let quality = 78;
  let scale = 1;
  let jpg = null;
  while (scale >= 0.55) {
    quality = 78;
    const w = Math.round(canvasW * scale);
    const h = Math.round(canvasH * scale);
    const base = sharp({
      create: { width: canvasW, height: canvasH, channels: 3, background: { r: 18, g: 18, b: 18 } }
    }).composite(pieces);
    while (quality >= 42) {
      let pipe = base.clone();
      if (scale < 0.999) pipe = pipe.resize(w, h);
      jpg = await pipe.jpeg({ quality: quality, mozjpeg: true }).toBuffer();
      if (jpg.length <= REVIEW_MAX_BYTES) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, jpg);
        return { file: dest, bytes: jpg.length };
      }
      quality -= 8;
    }
    scale -= 0.12;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, jpg);
  return { file: dest, bytes: jpg.length };
}

function copyHeldTilt(oldCard, newCard) {
  if (!oldCard || !newCard || !oldCard.scans || !newCard.scans) return;
  ['up', '180'].forEach(function (ori) {
    const oldScan = oldCard.scans[ori];
    const newScan = newCard.scans[ori];
    if (!oldScan || !newScan || !oldScan.sides || !newScan.sides) return;
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      if (!oldScan.sides[side] || !newScan.sides[side]) return;
      oldScan.sides[side].tiltDeg = newScan.sides[side].tiltDeg;
    });
  });
}

function approvedMeansHeld(oldCard, newCard) {
  if (!oldCard || !oldCard.sides || !newCard || !newCard.sides) return false;
  const names = ['top', 'bottom', 'left', 'right'];
  let any = false;
  for (let i = 0; i < names.length; i++) {
    const oldSide = oldCard.sides[names[i]];
    const newSide = newCard.sides[names[i]];
    if (!oldSide || !oldSide.approved) return false;
    any = true;
    if (!newSide || newSide.mm == null || oldSide.mm == null) return false;
    if (Math.abs(newSide.mm - oldSide.mm) > 0.02) return false;
  }
  return any;
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
  }
  if (opts.overlayDir) {
    const groups = {};
    measurements.forEach(function (m) {
      if (!groups[m.card]) groups[m.card] = [];
      groups[m.card].push(m);
    });
    fs.mkdirSync(opts.overlayDir, { recursive: true });
    const ids = Object.keys(groups).sort();
    for (let g = 0; g < ids.length; g++) {
      const dest = path.join(opts.overlayDir, ids[g] + '_review.jpg');
      const sheet = await writeCardReviewSheet(ids[g], groups[ids[g]], dest);
      console.log('review ' + path.basename(dest) + '  ' + (sheet.bytes / (1024 * 1024)).toFixed(2) + ' MB');
      if (opts.artifactDir) {
        try {
          fs.mkdirSync(opts.artifactDir, { recursive: true });
          fs.copyFileSync(dest, path.join(opts.artifactDir, path.basename(dest)));
        } catch (err) {
          console.error('artifact copy skipped: ' + (err && err.message ? err.message : err));
        }
      }
    }
  }
  const previous = loadApproved(opts.out);
  const key = buildAnswerKey(measurements, dpiUsed, previous);
  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    let stored = key;
    if (fs.existsSync(opts.out)) {
      try {
        stored = JSON.parse(fs.readFileSync(opts.out, 'utf8'));
        stored.definition = key.definition;
        stored.cards = stored.cards || {};
        Object.keys(key.cards).forEach(function (id) {
          if (!approvedMeansHeld(stored.cards[id], key.cards[id])) {
            stored.cards[id] = key.cards[id];
          } else {
            copyHeldTilt(stored.cards[id], key.cards[id]);
          }
        });
      } catch (err) {
        stored = key;
      }
    }
    fs.writeFileSync(opts.out, JSON.stringify(stored, null, 2) + '\n');
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

  // A coloured band with the margin colour again on its inner side. The
  // outline is the outer edge of the band, not the inner edge.
  const banded = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: [250, 250, 248],
    frameMm: 1.2,
    top: constantEdge(1.15, [232, 208, 42], []),
    bottom: constantEdge(3.5, [232, 208, 42], []),
    left: constantEdge(2.4, [232, 208, 42], []),
    right: constantEdge(2.7, [232, 208, 42], [])
  });
  const bandedM = measureImage(banded.data, banded.width, banded.height, dpi);
  check('inner-white band found', bandedM.ok && bandedM.sizeOk, bandedM.ok ? bandedM.cardMm : bandedM.error);
  if (bandedM.ok) {
    check('inner-white uses the outer edge', near(bandedM.sides.top.mm, 1.15, 0.12) && !bandedM.sides.top.withheld,
      sideBrief(bandedM.sides.top));
    check('inner-white other sides', near(bandedM.sides.bottom.mm, 3.5, 0.1) && near(bandedM.sides.left.mm, 2.4, 0.1),
      { bottom: sideBrief(bandedM.sides.bottom), left: sideBrief(bandedM.sides.left) });
  }

  // Neutral brightness stripes in the margin are foil, not the design block.
  const foil = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.4,
    top: constantEdge(3.0, [236, 206, 48], []),
    bottom: constantEdge(3.2, [236, 206, 48], []),
    left: constantEdge(2.8, [236, 206, 48], []),
    right: constantEdge(3.1, [236, 206, 48], [])
  });
  const foilPpm = pxPerMm(dpi);
  const foilMargin = Math.round(6 * foilPpm);
  for (let y = 0; y < foil.height; y++) {
    for (let x = 0; x < foil.width; x++) {
      const dTop = (y - foilMargin) / foilPpm;
      const dBot = (foilMargin + NOMINAL_H_MM * foilPpm - y) / foilPpm;
      const dLeft = (x - foilMargin) / foilPpm;
      const dRight = (foilMargin + NOMINAL_W_MM * foilPpm - x) / foilPpm;
      const depth = Math.min(dTop, dBot, dLeft, dRight);
      if (depth < 0.2 || depth >= 2.95) continue;
      const stripe = Math.floor(depth / 0.18) % 2 === 0 ? 248 : 110;
      const i = (y * foil.width + x) * 3;
      foil.data[i] = stripe;
      foil.data[i + 1] = stripe;
      foil.data[i + 2] = stripe;
    }
  }
  const foilM = measureImage(foil.data, foil.width, foil.height, dpi);
  check('foil card found', foilM.ok && foilM.sizeOk, foilM.ok ? foilM.cardMm : foilM.error);
  if (foilM.ok) {
    check('foil top is the colour frame', near(foilM.sides.top.mm, 3.0, 0.2) && !foilM.sides.top.withheld,
      sideBrief(foilM.sides.top));
    check('foil ignores the stripes', near(foilM.sides.left.mm, 2.8, 0.2) && near(foilM.sides.right.mm, 3.1, 0.2),
      { left: sideBrief(foilM.sides.left), right: sideBrief(foilM.sides.right) });
  }

  // A dark patch on a fraction of one side is a mark. It is not an outline
  // when the rest of that side has no boundary.
  const patch = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: white,
    frameMm: 1.2,
    top: constantEdge(14, white, []),
    bottom: constantEdge(3.4, blue, []),
    left: constantEdge(3.1, blue, []),
    right: constantEdge(3.3, blue, [])
  });
  const patchPpm = pxPerMm(dpi);
  const patchMargin = Math.round(6 * patchPpm);
  const patchX0 = patchMargin + NOMINAL_W_MM * patchPpm * 0.42;
  const patchX1 = patchMargin + NOMINAL_W_MM * patchPpm * 0.55;
  const patchY0 = patchMargin + 0.55 * patchPpm;
  const patchY1 = patchMargin + 8 * patchPpm;
  for (let y = Math.floor(patchY0); y < Math.ceil(patchY1); y++) {
    for (let x = Math.floor(patchX0); x < Math.ceil(patchX1); x++) {
      const i = (y * patch.width + x) * 3;
      if (i < 0 || i + 2 >= patch.data.length) continue;
      patch.data[i] = 20;
      patch.data[i + 1] = 20;
      patch.data[i + 2] = 24;
    }
  }
  const patchM = measureImage(patch.data, patch.width, patch.height, dpi);
  check('patch card found', patchM.ok && patchM.sizeOk, patchM.ok ? patchM.cardMm : patchM.error);
  if (patchM.ok) {
    check('short patch is not the outline', patchM.sides.top.withheld === true && patchM.sides.top.mm == null,
      sideBrief(patchM.sides.top));
    check('patch leaves the other sides', near(patchM.sides.bottom.mm, 3.4, 0.12) && !patchM.sides.bottom.withheld,
      sideBrief(patchM.sides.bottom));
  }

  // A grey border then a yellow panel. A minority of each corner is card
  // ink, the way a tight crop is: the median stays the pink bed, the 98th
  // percentile lifts the gate past the grey, and the sheet gate does not.
  const silver = drawSynthetic({
    dpi: dpi,
    marginMm: 8,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: [209, 137, 149],
    white: [190, 190, 190],
    photo: [255, 225, 104],
    frameMm: 0.4,
    top: constantEdge(3.2, [255, 225, 104], []),
    bottom: constantEdge(3.2, [255, 225, 104], []),
    left: constantEdge(3.2, [255, 225, 104], []),
    right: constantEdge(3.2, [255, 225, 104], [])
  });
  const silverCw = Math.max(4, Math.round(silver.width * 0.06));
  const silverCh = Math.max(4, Math.round(silver.height * 0.06));
  const silverCorners = [
    [0, 0],
    [silver.width - silverCw, 0],
    [0, silver.height - silverCh],
    [silver.width - silverCw, silver.height - silverCh]
  ];
  silverCorners.forEach(function (origin) {
    for (let y = origin[1]; y < origin[1] + silverCh; y++) {
      for (let x = origin[0]; x < origin[0] + silverCw; x++) {
        if (((x + y) % 6) !== 0) continue;
        const i = (y * silver.width + x) * 3;
        silver.data[i] = 40;
        silver.data[i + 1] = 30;
        silver.data[i + 2] = 20;
      }
    }
  });
  const silverCrop = measureImage(silver.data, silver.width, silver.height, dpi);
  check('silver-yellow crop gate misses the card', !silverCrop.ok || silverCrop.sizeOk === false,
    silverCrop.ok ? silverCrop.cardMm : silverCrop.error);
  const silverM = measureImage(silver.data, silver.width, silver.height, dpi, {
    paper: [209, 137, 149],
    threshold: 60
  });
  check('silver-yellow card found', silverM.ok && silverM.sizeOk, silverM.ok ? silverM.cardMm : silverM.error);
  if (silverM.ok) {
    check('silver-yellow keeps the outer edge',
      near(silverM.cardMm.width, NOMINAL_W_MM, 1.2) && near(silverM.cardMm.height, NOMINAL_H_MM, 1.2),
      silverM.cardMm);
  }
  const kept = measureImage(partial.data, partial.width, partial.height, dpi, {
    paper: pink,
    threshold: 8
  });
  check('size-ok card keeps its own gate',
    kept.ok && kept.sizeOk && partialM.sides.top.mm === kept.sides.top.mm &&
    near(kept.cardMm.width, partialM.cardMm.width, 0.001),
    { own: partialM.cardMm, kept: kept.ok ? kept.cardMm : kept.error });

  const short = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: 86.9,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.0,
    top: constantEdge(3.0, blue, []),
    bottom: constantEdge(3.2, blue, []),
    left: constantEdge(3.1, blue, []),
    right: constantEdge(3.3, blue, [])
  });
  const shortM = measureImage(short.data, short.width, short.height, dpi);
  check('short height is not card-sized', shortM.ok === true && shortM.sizeOk === false, shortM.ok ? shortM.cardMm : shortM.error);
  if (shortM.ok) {
    check('short height withholds the sides', shortM.sides.top.reason === 'not-card-sized' && shortM.sides.top.mm == null,
      sideBrief(shortM.sides.top));
  }

  // Coloured stripes are the margin. The outline is the thin light line
  // outside the black band, the same stroke on every side. The inner light
  // line is not the outline.
  const wave = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: [40, 40, 160],
    photo: [80, 100, 140],
    frameMm: 0.2,
    top: constantEdge(2.4, [245, 245, 245], []),
    bottom: constantEdge(2.4, [245, 245, 245], []),
    left: constantEdge(2.4, [245, 245, 245], []),
    right: constantEdge(2.4, [245, 245, 245], [])
  });
  const wavePpm = pxPerMm(dpi);
  const waveMargin = Math.round(6 * wavePpm);
  for (let y = 0; y < wave.height; y++) {
    for (let x = 0; x < wave.width; x++) {
      const dTop = (y - waveMargin) / wavePpm;
      const dBot = (waveMargin + NOMINAL_H_MM * wavePpm - y) / wavePpm;
      const dLeft = (x - waveMargin) / wavePpm;
      const dRight = (waveMargin + NOMINAL_W_MM * wavePpm - x) / wavePpm;
      const depth = Math.min(dTop, dBot, dLeft, dRight);
      if (depth < 0 || depth >= 2.4) continue;
      const band = Math.floor(depth / 0.35) % 2;
      const i = (y * wave.width + x) * 3;
      if (band) {
        wave.data[i] = 180;
        wave.data[i + 1] = 40;
        wave.data[i + 2] = 80;
      } else {
        wave.data[i] = 40;
        wave.data[i + 1] = 40;
        wave.data[i + 2] = 180;
      }
    }
  }
  for (let y = 0; y < wave.height; y++) {
    for (let x = 0; x < wave.width; x++) {
      const dTop = (y - waveMargin) / wavePpm;
      const dBot = (waveMargin + NOMINAL_H_MM * wavePpm - y) / wavePpm;
      const dLeft = (x - waveMargin) / wavePpm;
      const dRight = (waveMargin + NOMINAL_W_MM * wavePpm - x) / wavePpm;
      const depth = Math.min(dTop, dBot, dLeft, dRight);
      if (depth < 2.6 || depth >= 3.5) continue;
      const i = (y * wave.width + x) * 3;
      wave.data[i] = 12;
      wave.data[i + 1] = 12;
      wave.data[i + 2] = 12;
    }
  }
  const waveM = measureImage(wave.data, wave.width, wave.height, dpi);
  check('wave card found', waveM.ok && waveM.sizeOk, waveM.ok ? waveM.cardMm : waveM.error);
  if (waveM.ok) {
    ['top', 'bottom', 'left', 'right'].forEach(function (name) {
      const side = waveM.sides[name];
      check('wave ' + name + ' is the outer light line',
        side.withheld === false && near(side.mm, 2.4, 0.2),
        sideBrief(side));
      check('wave ' + name + ' black is inside that line',
        side.blackOuterMm != null && near(side.blackOuterMm, 2.6, 0.25) &&
        side.frameDiffMm != null && side.frameDiffMm > 0.05 && side.frameDiffMm < 0.5,
        { mm: side.mm, black: side.blackOuterMm, diff: side.frameDiffMm });
    });
    const share = waveM.frameCheck && waveM.frameCheck.topShare;
    check('wave black ratio matches the outline ratio',
      share && share.diff != null && Math.abs(share.diff) < 0.02,
      share);
  }

  // The silver-black-silver stroke is only a segment on each side. It is
  // still the outline because the same profile closes the rectangle. A
  // bright bar on one side only is not.
  const segment = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: [40, 40, 160],
    photo: [70, 90, 120],
    frameMm: 0.2,
    top: constantEdge(6.2, [40, 40, 160], []),
    bottom: constantEdge(6.2, [40, 40, 160], []),
    left: constantEdge(6.2, [40, 40, 160], []),
    right: constantEdge(6.2, [40, 40, 160], [])
  });
  const segPpm = pxPerMm(dpi);
  const segMargin = Math.round(6 * segPpm);
  for (let y = 0; y < segment.height; y++) {
    for (let x = 0; x < segment.width; x++) {
      const dTop = (y - segMargin) / segPpm;
      const dBot = (segMargin + NOMINAL_H_MM * segPpm - y) / segPpm;
      const dLeft = (x - segMargin) / segPpm;
      const dRight = (segMargin + NOMINAL_W_MM * segPpm - x) / segPpm;
      const depth = Math.min(dTop, dBot, dLeft, dRight);
      let along = 0;
      if (depth === dTop || depth === dBot) along = (x - segMargin) / (NOMINAL_W_MM * segPpm);
      else along = (y - segMargin) / (NOMINAL_H_MM * segPpm);
      const i = (y * segment.width + x) * 3;
      if (depth >= 0 && depth < 2.6) {
        const band = Math.floor(depth / 0.35) % 2;
        if (band) {
          segment.data[i] = 180;
          segment.data[i + 1] = 40;
          segment.data[i + 2] = 80;
        } else {
          segment.data[i] = 40;
          segment.data[i + 1] = 40;
          segment.data[i + 2] = 180;
        }
      }
      const onSegment = along >= 0.32 && along <= 0.68;
      const loneBar = depth === dTop && along >= 0.08 && along <= 0.18 && depth >= 1.15 && depth < 1.35;
      if (loneBar) {
        segment.data[i] = 245;
        segment.data[i + 1] = 245;
        segment.data[i + 2] = 245;
      }
      if (!onSegment || depth < 2.8) continue;
      if (depth < 3.0) {
        segment.data[i] = 245;
        segment.data[i + 1] = 245;
        segment.data[i + 2] = 245;
      } else if (depth < 3.8) {
        segment.data[i] = 8;
        segment.data[i + 1] = 8;
        segment.data[i + 2] = 8;
      } else if (depth < 4.0) {
        segment.data[i] = 230;
        segment.data[i + 1] = 230;
        segment.data[i + 2] = 230;
      }
    }
  }
  const segM = measureImage(segment.data, segment.width, segment.height, dpi);
  check('segment card found', segM.ok && segM.sizeOk, segM.ok ? segM.cardMm : segM.error);
  if (segM.ok) {
    ['top', 'bottom', 'left', 'right'].forEach(function (name) {
      const side = segM.sides[name];
      check('segment ' + name + ' is the outer silver',
        side.withheld === false && near(side.mm, 2.8, 0.2) && (side.used || []).length >= 2,
        sideBrief(side));
      check('segment ' + name + ' black ratio uses the black edge',
        side.blackOuterMm != null && near(side.blackOuterMm, 3.0, 0.25),
        { mm: side.mm, black: side.blackOuterMm });
    });
    const segShare = segM.frameCheck && segM.frameCheck.topShare;
    check('segment black ratio matches the outline ratio',
      segShare && segShare.diff != null && Math.abs(segShare.diff) < 0.02,
      segShare);
    check('segment ignores the single-side bar',
      segM.sides.top.mm > 2.2,
      segM.sides.top.mm);
  }

  // Gold line, black immediately inside, shallowest at the four outer
  // corners. A neutral ray in the margin is not the contact.
  function goldCornerEdge() {
    return {
      depth: function (along) {
        const t = Math.min(Math.abs(along - 0.08), Math.abs(along - 0.92)) / 0.4;
        return 3.5 + 4.0 * Math.max(0, Math.min(1, t));
      },
      color: [190, 150, 40],
      marks: []
    };
  }
  const goldCard = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: [36, 36, 38],
    photo: [12, 12, 14],
    frameMm: 0.28,
    top: goldCornerEdge(),
    bottom: goldCornerEdge(),
    left: goldCornerEdge(),
    right: goldCornerEdge()
  });
  const goldPpm = pxPerMm(dpi);
  const goldMargin = Math.round(6 * goldPpm);
  for (let y = 0; y < goldCard.height; y++) {
    for (let x = 0; x < goldCard.width; x++) {
      const dTop = (y - goldMargin) / goldPpm;
      const along = (x - goldMargin) / (NOMINAL_W_MM * goldPpm);
      if (dTop >= 1.35 && dTop < 1.6 && along >= 0.3 && along <= 0.55) {
        const i = (y * goldCard.width + x) * 3;
        goldCard.data[i] = 236;
        goldCard.data[i + 1] = 236;
        goldCard.data[i + 2] = 236;
      }
    }
  }
  const goldM = measureImage(goldCard.data, goldCard.width, goldCard.height, dpi);
  check('gold-corner card found', goldM.ok && goldM.sizeOk, goldM.ok ? goldM.cardMm : goldM.error);
  if (goldM.ok) {
    ['top', 'bottom', 'left', 'right'].forEach(function (name) {
      const side = goldM.sides[name];
      check('gold-corner ' + name + ' is the outer corner',
        side.cornerContact === true && side.withheld === false && near(side.mm, 3.5, 0.25) &&
        (side.points || []).length >= 2,
        sideBrief(side));
      check('gold-corner ' + name + ' black is inside the gold',
        side.blackOuterMm != null && side.blackOuterMm > side.mm && side.blackOuterMm < side.mm + 0.6,
        { mm: side.mm, black: side.blackOuterMm });
    });
    check('gold-corner ignores the margin ray', goldM.sides.top.mm > 2.5, goldM.sides.top.mm);
  }

  const slant = drawSynthetic({
    dpi: dpi,
    marginMm: 6,
    cardWmm: NOMINAL_W_MM,
    cardHmm: NOMINAL_H_MM,
    pink: pink,
    white: white,
    photo: photo,
    frameMm: 1.2,
    top: {
      depth: function (along) { return 3.0 + 0.4 * along; },
      color: blue,
      marks: []
    },
    bottom: constantEdge(4.0, blue, []),
    left: constantEdge(3.2, blue, []),
    right: constantEdge(3.6, blue, [])
  });
  const slantM = measureImage(slant.data, slant.width, slant.height, dpi);
  check('slant card found', slantM.ok && slantM.sizeOk, slantM.ok ? slantM.cardMm : slantM.error);
  if (slantM.ok) {
    const top = slantM.sides.top;
    const expectTilt = Math.atan(0.4 / NOMINAL_W_MM) * (180 / Math.PI);
    check('slant width stays on the outer edge', near(top.mm, 3.2, 0.15) && !top.withheld, sideBrief(top));
    check('slant tilt is the frame angle', top.tiltDeg != null && Math.abs(top.tiltDeg - expectTilt) < 0.15,
      { tilt: top.tiltDeg, expect: expectTilt });
    const depths = (top.used || []).map(function (p) { return p.depth; });
    const span = depths.length ? Math.max.apply(null, depths) - Math.min.apply(null, depths) : 0;
    check('slant line is not one depth', span > 0.2, span);
  }

  const tmpCard = path.join(os.tmpdir(), 'flatbed-selftest-card.png');
  const tmpOver = path.join(os.tmpdir(), 'flatbed-selftest-overlay.png');
  const tmpCurve = path.join(os.tmpdir(), 'flatbed-selftest-curve.png');
  await sharp(partial.data, { raw: { width: partial.width, height: partial.height, channels: 3 } }).png().toFile(tmpCard);
  await writeOverlay(tmpCard, partialM, tmpOver);
  await sharp(curved.data, { raw: { width: curved.width, height: curved.height, channels: 3 } }).png().toFile(tmpCard);
  await writeOverlay(tmpCard, curvedM, tmpCurve);
  check('overlay written', fs.existsSync(tmpOver) && fs.statSync(tmpOver).size > 1000 && fs.statSync(tmpCurve).size > 1000, tmpOver);
  const manifest = loadFlatbedManifest();
  const lavitar = parseScanName('flatbed/Lavitar_up.png', manifest);
  const fouts = parseScanName('/scans/Fouts_180.png', manifest);
  check('manifest maps Lavitar_up to TD-03', lavitar && lavitar.card === 'TD-03' && lavitar.orientation === 'up', lavitar);
  check('manifest maps Fouts_180 to TD-04', fouts && fouts.card === 'TD-04' && fouts.orientation === '180', fouts);
  const tmpReviewCard = path.join(os.tmpdir(), 'flatbed-selftest-review-card.png');
  const tmpReview = path.join(os.tmpdir(), 'flatbed-selftest-review.jpg');
  await sharp(partial.data, { raw: { width: partial.width, height: partial.height, channels: 3 } }).png().toFile(tmpReviewCard);
  const reviewSheet = await writeCardReviewSheet('PARTIAL', [{
    orientation: 'up',
    file: tmpReviewCard,
    result: partialM
  }], tmpReview);
  check('review sheet under 3 MB', reviewSheet.bytes > 1000 && reviewSheet.bytes <= REVIEW_MAX_BYTES, reviewSheet.bytes);

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
  BIAS_AGREE_MM: BIAS_AGREE_MM
};
