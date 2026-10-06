/**
 * services/card_quad.js
 * Card-box geometry for /api/grade: parse, order, validate, and
 * perspective-warp a 4-corner card quad to the fixed grading raster.
 *
 * Grading always runs on a WARP_WIDTH × WARP_HEIGHT card (643×900) so
 * border-width thresholds in grading_engine.js keep their tuned scale.
 * A photo is never graded as "the card" unless a quad passed validation.
 */
'use strict';

const WARP_WIDTH = 643;
const WARP_HEIGHT = 900;

const CARD_ASPECT = 2.5 / 3.5;
const ASPECT_TOLERANCE = 0.10;
const MIN_AREA_FRAC = 0.15;
const MAX_AREA_FRAC = 0.95;
const MIN_SIDE_PX = 200;
const BOUNDS_SLOP_PX = 2;

function toPoint(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return isFinite(x) && isFinite(y) ? [x, y] : null;
  }
  if (value && typeof value === 'object') {
    const x = Number(value.x);
    const y = Number(value.y);
    return isFinite(x) && isFinite(y) ? [x, y] : null;
  }
  return null;
}

/**
 * Accepts `{tl,tr,br,bl}` (points as [x,y] or {x,y}), or an array of four
 * points, or a JSON string of either. Returns four [x,y] points or null.
 */
function parseCardQuad(raw) {
  if (raw == null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch (e) { return null; }
  }
  let points;
  if (Array.isArray(value)) {
    points = value.map(toPoint);
  } else if (value && typeof value === 'object') {
    points = [value.tl, value.tr, value.br, value.bl].map(toPoint);
  } else {
    return null;
  }
  if (points.length !== 4 || points.some(function (p) { return p == null; })) return null;
  return points;
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Order four points as tl, tr, br, bl in image coordinates (y down), then
 * rotate the labelling 90° clockwise if the card lies landscape so the
 * warp output is always portrait.
 */
function orderQuad(points) {
  const cx = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4;
  const cy = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;
  const sorted = points.slice().sort(function (a, b) {
    return Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx);
  });
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  }
  const cw = [0, 1, 2, 3].map(function (k) { return sorted[(start + k) % 4]; });
  let tl = cw[0];
  let tr = cw[1];
  let br = cw[2];
  let bl = cw[3];
  const horizontal = (dist(tl, tr) + dist(bl, br)) / 2;
  const vertical = (dist(tl, bl) + dist(tr, br)) / 2;
  let rotatedToPortrait = false;
  if (horizontal > vertical) {
    const oldTl = tl;
    tl = bl;
    bl = br;
    br = tr;
    tr = oldTl;
    rotatedToPortrait = true;
  }
  return { tl: tl, tr: tr, br: br, bl: bl, rotatedToPortrait: rotatedToPortrait };
}

function quadArea(q) {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

function isConvex(q) {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function round2(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v;
}

/**
 * Validate an ordered quad against the photo it came from.
 *
 * @returns {{ ok: boolean, reasons: string[], areaPct: number, aspect: number, minSidePx: number, convex: boolean }}
 */
function validateQuad(q, imageWidth, imageHeight) {
  const reasons = [];
  const pts = [q.tl, q.tr, q.br, q.bl];
  const outOfBounds = pts.some(function (p) {
    return p[0] < -BOUNDS_SLOP_PX || p[1] < -BOUNDS_SLOP_PX ||
      p[0] > imageWidth - 1 + BOUNDS_SLOP_PX || p[1] > imageHeight - 1 + BOUNDS_SLOP_PX;
  });
  if (outOfBounds) reasons.push('quad corner lies outside the photo');

  const convex = isConvex(q);
  if (!convex) reasons.push('quad is not convex');

  const areaFrac = quadArea(q) / Math.max(1, imageWidth * imageHeight);
  if (areaFrac < MIN_AREA_FRAC) {
    reasons.push('card covers ' + round2(areaFrac * 100) + '% of photo (need ≥ ' + MIN_AREA_FRAC * 100 + '%)');
  }
  if (areaFrac > MAX_AREA_FRAC) {
    reasons.push('card covers ' + round2(areaFrac * 100) + '% of photo (need ≤ ' + MAX_AREA_FRAC * 100 +
      '% — leave a little background showing)');
  }

  const top = dist(q.tl, q.tr);
  const bottom = dist(q.bl, q.br);
  const left = dist(q.tl, q.bl);
  const right = dist(q.tr, q.br);
  const shortSide = (top + bottom) / 2;
  const longSide = (left + right) / 2;
  const aspect = longSide > 0 ? shortSide / longSide : 0;
  const aspectMin = CARD_ASPECT * (1 - ASPECT_TOLERANCE);
  const aspectMax = CARD_ASPECT * (1 + ASPECT_TOLERANCE);
  if (aspect < aspectMin || aspect > aspectMax) {
    reasons.push('quad aspect ' + round2(aspect) + ' is outside ' + round2(aspectMin) + '–' +
      round2(aspectMax) + ' (2.5×3.5 card)');
  }

  const minSidePx = Math.min(top, bottom, left, right);
  if (minSidePx < MIN_SIDE_PX) {
    reasons.push('shortest quad side ' + round2(minSidePx) + 'px is below ' + MIN_SIDE_PX + 'px');
  }

  return {
    ok: reasons.length === 0,
    reasons: reasons,
    areaPct: round2(areaFrac * 100),
    aspect: round2(aspect),
    minSidePx: round2(minSidePx),
    convex: convex
  };
}

/**
 * Homography H (row-major, 9 entries, h33 = 1) mapping each src[i] to dst[i].
 * Solves the standard 8×8 DLT system with partial-pivot Gaussian elimination.
 */
function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i][0];
    const y = src[i][1];
    const u = dst[i][0];
    const v = dst[i][1];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) throw new Error('degenerate quad (singular homography)');
    if (pivot !== col) {
      const tmp = A[col]; A[col] = A[pivot]; A[pivot] = tmp;
      const tb = b[col]; b[col] = b[pivot]; b[pivot] = tb;
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const h = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * h[c];
    h[r] = s / A[r][r];
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * Perspective-warp an interleaved raw buffer so the ordered quad fills
 * outW × outH. Output corner pixels (0,0), (outW-1,0), (outW-1,outH-1),
 * (0,outH-1) map exactly to tl, tr, br, bl. Bilinear, edge-clamped.
 */
function warpPerspective(src, quad, outW, outH) {
  const outCorners = [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]];
  const H = computeHomography(outCorners, [quad.tl, quad.tr, quad.br, quad.bl]);
  return warpWithHomography(src, H, outW, outH);
}

/** Inverse-map every output pixel through H (output → source). */
function warpWithHomography(src, H, outW, outH) {
  const width = src.width;
  const height = src.height;
  const channels = src.channels;
  const data = src.data;
  const out = Buffer.alloc(outW * outH * channels);
  const maxX = width - 1;
  const maxY = height - 1;
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const w = H[6] * ox + H[7] * oy + H[8];
      let sx = (H[0] * ox + H[1] * oy + H[2]) / w;
      let sy = (H[3] * ox + H[4] * oy + H[5]) / w;
      if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
      if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * width + x0) * channels;
      const i10 = (y0 * width + x1) * channels;
      const i01 = (y1 * width + x0) * channels;
      const i11 = (y1 * width + x1) * channels;
      const o = (oy * outW + ox) * channels;
      for (let c = 0; c < channels; c++) {
        const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
        const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
        out[o + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { data: out, width: outW, height: outH, channels: channels, homography: H };
}

/** Fraction of each warp dimension added as background margin before the
 *  cut-edge search. Also the max quad error the refinement can absorb. */
const REFINE_EXPAND_FRAC = 0.02;

/**
 * Tighten a quad to the physical cut. A detector quad that sits on an
 * inner printed line eats the border, so the search looks several
 * millimetres outside the quad and takes the first sustained step off
 * the background colour. A stronger step farther in (the frame) is not
 * the cut.
 *
 * @param {{data:Buffer,width:number,height:number,channels:number}} src interleaved photo
 * @param {{tl:number[],tr:number[],br:number[],bl:number[]}} quad ordered quad in src pixels
 * @returns {{ quad: object, shiftPx: object, cutSteps: object }} cutSteps per edge:
 *   stepSize, runnerUpRatio (strongest separate step / chosen), runnerUpOffsetPx (output px)
 */
function refineQuadToCut(src, quad, outW, outH) {
  // Look far enough outside the detector quad to start on the backdrop
  // when the detector sat on an inner printed line. A wide white border
  // is several millimetres, so a short window samples that border and
  // then treats the frame as the cut. The cut is the first sustained
  // step off the background, not the strongest step in the window.
  const ppmX = outW / 63.5;
  const ppmY = outH / 88.9;
  const CUT_SEARCH_MM = 9;
  const ex = Math.max(4, Math.round(CUT_SEARCH_MM * ppmX));
  const ey = Math.max(4, Math.round(CUT_SEARCH_MM * ppmY));
  const bigW = outW + 2 * ex;
  const bigH = outH + 2 * ey;
  // Homography from the inner (card-sized) output rectangle to the quad, then
  // evaluate it on the expanded canvas so the margin is real photo pixels.
  const Hin = computeHomography(
    [[ex, ey], [ex + outW - 1, ey], [ex + outW - 1, ey + outH - 1], [ex, ey + outH - 1]],
    [quad.tl, quad.tr, quad.br, quad.bl]
  );
  const big = warpWithHomography(src, Hin, bigW, bigH);
  const ch = big.channels;
  function rgbOf(x, y) {
    const i = (y * bigW + x) * ch;
    if (ch >= 3) return [big.data[i], big.data[i + 1], big.data[i + 2]];
    const g = big.data[i];
    return [g, g, g];
  }
  function colorDist(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }
  function findCut(edge, expand, ppm) {
    const length = 2 * expand + 2;
    const alongMax = (edge === 'left' || edge === 'right') ? bigH : bigW;
    const a0 = Math.floor(alongMax * 0.25);
    const a1 = Math.floor(alongMax * 0.75);
    const stepA = Math.max(1, Math.floor((a1 - a0) / 36));
    function at(d, a) {
      if (edge === 'left') return rgbOf(Math.min(bigW - 1, d), a);
      if (edge === 'right') return rgbOf(Math.max(0, bigW - 1 - d), a);
      if (edge === 'top') return rgbOf(a, Math.min(bigH - 1, d));
      return rgbOf(a, Math.max(0, bigH - 1 - d));
    }
    const bgDepth = Math.max(2, Math.round(0.35 * ppm));
    const bgPx = [[], [], []];
    for (let d = 0; d < bgDepth; d++) {
      for (let a = a0; a < a1; a += stepA) {
        const p = at(d, a);
        bgPx[0].push(p[0]);
        bgPx[1].push(p[1]);
        bgPx[2].push(p[2]);
      }
    }
    const paper = bgPx.map(function (arr) {
      const s = arr.sort(function (x, y) { return x - y; });
      return s[s.length >> 1];
    });
    const profile = new Float64Array(length);
    for (let d = 0; d < length; d++) {
      let sum = 0;
      let n = 0;
      for (let a = a0; a < a1; a += stepA) {
        sum += colorDist(at(d, a), paper);
        n += 1;
      }
      profile[d] = n ? sum / n : 0;
    }
    let base = 0;
    for (let d = 0; d < bgDepth; d++) base += profile[d];
    base /= bgDepth;
    let mad = 0;
    for (let d = 0; d < bgDepth; d++) mad += Math.abs(profile[d] - base);
    mad /= bgDepth;
    const thresh = Math.max(18, base + 8, base + mad * 6);
    const sustain = Math.max(2, Math.round(0.45 * ppm));
    let hit = -1;
    for (let i = bgDepth; i < length - sustain; i++) {
      if (profile[i] < thresh) continue;
      let above = 0;
      for (let j = 0; j < sustain; j++) {
        if (profile[i + j] >= thresh * 0.85) above += 1;
      }
      if (above >= sustain * 0.7) { hit = i; break; }
    }
    const steps = new Float64Array(Math.max(0, length - 1));
    let best = expand;
    let bestStep = -1;
    for (let i = 0; i < length - 1; i++) {
      steps[i] = Math.abs(profile[i + 1] - profile[i]);
      if (steps[i] > bestStep) { bestStep = steps[i]; best = i; }
    }
    if (hit < 0) hit = best;
    // The threshold hit can sit on the plateau, where the local step is
    // small. The chosen step is the shoulder just outside that hit.
    let chosenStep = 0;
    let chosenAt = hit;
    const shoulder = Math.max(2, Math.round(0.45 * ppm));
    for (let i = Math.max(0, hit - shoulder); i <= Math.min(steps.length - 1, hit); i++) {
      if (steps[i] > chosenStep) { chosenStep = steps[i]; chosenAt = i; }
    }
    if (!(chosenStep > 0)) { chosenStep = bestStep; chosenAt = best; }
    let runner = -1;
    let runnerStep = 0;
    const runnerReach = Math.max(4, Math.round(1.5 * ppm));
    const sameEdge = Math.max(2, Math.round(0.25 * ppm));
    for (let i = 0; i < steps.length; i++) {
      if (Math.abs(i - chosenAt) <= sameEdge) continue;
      if (Math.abs(i - chosenAt) > runnerReach) continue;
      const left = i > 0 ? steps[i - 1] : -Infinity;
      const right = i < steps.length - 1 ? steps[i + 1] : -Infinity;
      if (steps[i] >= left && steps[i] >= right && steps[i] > runnerStep) {
        runnerStep = steps[i];
        runner = i;
      }
    }
    cutSteps[edge] = {
      stepSize: Math.round((chosenStep > 0 ? chosenStep : bestStep) * 10) / 10,
      runnerUpRatio: runner >= 0 && chosenStep > 0 ? Math.round((runnerStep / chosenStep) * 1000) / 1000 : 0,
      runnerUpOffsetPx: runner >= 0 ? runner - hit : null
    };
    // The plateau is on the card, past the cut's soft shoulder. Sampling
    // the shoulder itself pulls the 50% point outward into the background.
    const inLo = Math.min(length - 1, hit + Math.max(2, Math.round(0.7 * ppm)));
    const inHi = Math.min(length - 1, inLo + Math.max(2, Math.round(0.35 * ppm)));
    let inner = 0;
    let nInner = 0;
    for (let k = inLo; k <= inHi; k++) { inner += profile[k]; nInner += 1; }
    inner = nInner ? inner / nInner : profile[Math.min(length - 1, hit)];
    const target = base + 0.5 * (inner - base);
    let crossing = hit;
    const lo = Math.max(1, hit - 2);
    // Walk back from the card plateau. The first rise off the background
    // can be a shadow ledge that only gets halfway; the cut is the step
    // that actually arrives at the card.
    for (let k = inHi; k >= lo; k--) {
      if (profile[k - 1] <= target && profile[k] >= target && profile[k] !== profile[k - 1]) {
        crossing = (k - 1) + (target - profile[k - 1]) / (profile[k] - profile[k - 1]);
        break;
      }
    }
    return crossing;
  }
  const cutSteps = {};
  const leftCut = findCut('left', ex, ppmX);
  const rightCut = findCut('right', ex, ppmX);
  const topCut = findCut('top', ey, ppmY);
  const bottomCut = findCut('bottom', ey, ppmY);
  const x0 = leftCut;
  const x1 = bigW - 1 - rightCut;
  const y0 = topCut;
  const y1 = bigH - 1 - bottomCut;
  return {
    quad: {
      tl: applyHomography(Hin, x0, y0),
      tr: applyHomography(Hin, x1, y0),
      br: applyHomography(Hin, x1, y1),
      bl: applyHomography(Hin, x0, y1),
      rotatedToPortrait: quad.rotatedToPortrait
    },
    shiftPx: {
      left: Math.round((leftCut - ex) * 100) / 100,
      right: Math.round((rightCut - ex) * 100) / 100,
      top: Math.round((topCut - ey) * 100) / 100,
      bottom: Math.round((bottomCut - ey) * 100) / 100
    },
    cutSteps: cutSteps
  };
}

function scaleQuad(points, sx, sy) {
  return points.map(function (p) { return [p[0] * sx, p[1] * sy]; });
}

function quadToJSON(q) {
  function r(p) { return [round2(p[0]), round2(p[1])]; }
  return { tl: r(q.tl), tr: r(q.tr), br: r(q.br), bl: r(q.bl) };
}

module.exports = {
  WARP_WIDTH,
  WARP_HEIGHT,
  CARD_ASPECT,
  ASPECT_TOLERANCE,
  MIN_AREA_FRAC,
  MAX_AREA_FRAC,
  MIN_SIDE_PX,
  parseCardQuad,
  orderQuad,
  validateQuad,
  quadArea,
  isConvex,
  computeHomography,
  applyHomography,
  warpPerspective,
  warpWithHomography,
  refineQuadToCut,
  REFINE_EXPAND_FRAC,
  scaleQuad,
  quadToJSON
};
