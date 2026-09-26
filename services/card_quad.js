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
 * Tighten a quad to the physical cut edge. A detector quad that is a few
 * pixels outside the card leaves a background sliver at the warp edge;
 * a few pixels inside eats the border. Both corrupt the inward border
 * scan, so: warp with a small outward margin, find the strongest
 * background→card step near the expected edge on each side (middle 50% of
 * the side, un-normalized grey), and map those edges back to the photo.
 *
 * @param {{data:Buffer,width:number,height:number,channels:number}} src interleaved photo
 * @param {{tl:number[],tr:number[],br:number[],bl:number[]}} quad ordered quad in src pixels
 * @returns {{ quad: object, shiftPx: object }}
 */
function refineQuadToCut(src, quad, outW, outH) {
  const ex = Math.max(4, Math.round(outW * REFINE_EXPAND_FRAC));
  const ey = Math.max(4, Math.round(outH * REFINE_EXPAND_FRAC));
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
  function grey(x, y) {
    const i = (y * bigW + x) * ch;
    if (ch >= 3) return (big.data[i] + big.data[i + 1] + big.data[i + 2]) / 3;
    return big.data[i];
  }
  // Mean profile along the inward direction, averaged across the middle half.
  function profile(edge, length) {
    const out = new Float64Array(length);
    const alongMax = (edge === 'left' || edge === 'right') ? bigH : bigW;
    const a0 = Math.floor(alongMax * 0.25);
    const a1 = Math.floor(alongMax * 0.75);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let a = a0; a < a1; a++) {
        if (edge === 'left') sum += grey(i, a);
        else if (edge === 'right') sum += grey(bigW - 1 - i, a);
        else if (edge === 'top') sum += grey(a, i);
        else sum += grey(a, bigH - 1 - i);
      }
      out[i] = sum / (a1 - a0);
    }
    return out;
  }
  function findCut(edge, expand) {
    const length = 2 * expand + 2;
    const p = profile(edge, length);
    let best = expand;
    let bestStep = -1;
    for (let i = 0; i < length - 1; i++) {
      const step = Math.abs(p[i + 1] - p[i]);
      if (step > bestStep) { bestStep = step; best = i + 1; }
    }
    return best;
  }
  const leftCut = findCut('left', ex);
  const rightCut = findCut('right', ex);
  const topCut = findCut('top', ey);
  const bottomCut = findCut('bottom', ey);
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
      left: leftCut - ex,
      right: rightCut - ex,
      top: topCut - ey,
      bottom: bottomCut - ey
    }
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
