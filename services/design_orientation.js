/**
 * services/design_orientation.js
 *
 * Which way is up, from the printed design, before an edge is called
 * top, bottom, left, or right.
 *
 * A mixed-case word has a straight baseline and a ragged other edge:
 * capitals and ascenders stick out on one side of the x-height. On an
 * upright word that ragged edge is the top. On a 180-degree word it is
 * the bottom. All-caps lettering has two straight edges, so it does not
 * vote. A photo texture does not share one baseline, so it does not vote.
 *
 *   upright  — every voting word is upright. Name the warp edges as they are.
 *   180      — every voting word is upside down. Rotate the warp 180
 *              before naming edges.
 *   conflict — both directions voted. Do not guess; withhold the edges.
 *   unknown  — nothing voted. An all-caps nameplate has no ascender to
 *              read. The portrait warp keeps its edge names; there is no
 *              second direction to swap them with.
 *
 * Nothing here is tuned to one card. Thresholds are pixel sizes on the
 * 643×900 warp.
 */
'use strict';

const LOCAL_RADIUS = 11;
const INK_DARKER = 32;
const INK_MAX = 150;
const MIN_LETTERS = 5;
const FLAT_SD_MAX = 1.15;
const EDGE_GAP = 1.2;
const SD_RATIO = 1.7;
const SPAN_MIN = 4;
const SPAN_MAX = 12;

function integral(grey, w, h) {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += grey[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + row;
    }
  }
  return ii;
}

function rectSum(ii, w, x0, y0, x1, y1) {
  const stride = w + 1;
  return ii[y1 * stride + x1] - ii[y0 * stride + x1] - ii[y1 * stride + x0] + ii[y0 * stride + x0];
}

function stddev(vals) {
  if (vals.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) sum += vals[i];
  const mean = sum / vals.length;
  let v = 0;
  for (let i = 0; i < vals.length; i++) {
    const d = vals[i] - mean;
    v += d * d;
  }
  return Math.sqrt(v / vals.length);
}

function components(ink, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const start = y * w + x;
      if (!ink[start] || seen[start]) continue;
      let qt = 0;
      let qh = 0;
      qx[qt] = x;
      qy[qt] = y;
      qt += 1;
      seen[start] = 1;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      while (qh < qt) {
        const cx = qx[qh];
        const cy = qy[qh];
        qh += 1;
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (area > 800) break;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ns = ny * w + nx;
            if (!ink[ns] || seen[ns]) continue;
            seen[ns] = 1;
            qx[qt] = nx;
            qy[qt] = ny;
            qt += 1;
          }
        }
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (area > 800 || area < 14) continue;
      if (bh < 8 || bh > 36 || bw < 3 || bw > 36) continue;
      if (area > bw * bh * 0.82) continue;
      if (bh > bw * 4.2) continue;
      out.push({ x: minX, y: minY, r: maxX, b: maxY, w: bw, h: bh });
    }
  }
  return out;
}

function wordsOf(comps) {
  const used = new Set();
  const words = [];
  const seeds = comps.slice().sort(function (a, b) { return a.y - b.y; });
  function flush(chain) {
    if (chain.length >= MIN_LETTERS) words.push(chain.slice());
    for (let i = 0; i < chain.length; i++) used.add(chain[i]);
  }
  for (let s = 0; s < seeds.length; s++) {
    const seed = seeds[s];
    if (used.has(seed)) continue;
    const band = comps.filter(function (c) {
      const overlap = Math.min(seed.b, c.b) - Math.max(seed.y, c.y);
      return overlap > Math.min(seed.h, c.h) * 0.5;
    }).sort(function (a, b) { return a.x - b.x; });
    let chain = [];
    for (let i = 0; i < band.length; i++) {
      const c = band[i];
      if (!chain.length) {
        if (!used.has(c)) chain.push(c);
        continue;
      }
      const prev = chain[chain.length - 1];
      const gap = c.x - prev.r;
      if (gap > Math.max(8, prev.w * 1.35) || gap < -2) {
        flush(chain);
        chain = [];
      }
      if (!chain.length) {
        if (!used.has(c)) chain.push(c);
      } else chain.push(c);
    }
    flush(chain);
  }
  return words;
}

function voteWord(word) {
  const heights = word.map(function (c) { return c.h; });
  heights.sort(function (a, b) { return a - b; });
  const median = heights[(heights.length - 1) >> 1];
  const body = word.filter(function (c) { return c.h >= median * 0.62; });
  if (body.length < MIN_LETTERS) return null;
  const bodyH = body.map(function (c) { return c.h; });
  const span = Math.max.apply(null, bodyH) - Math.min.apply(null, bodyH);
  const topSd = stddev(body.map(function (c) { return c.y; }));
  const botSd = stddev(body.map(function (c) { return c.b; }));
  const flatIsBottom = botSd <= topSd;
  const baseVals = body.map(function (c) { return flatIsBottom ? c.b : c.y; });
  const baseSorted = baseVals.slice().sort(function (a, b) { return a - b; });
  const baseMed = baseSorted[(baseSorted.length - 1) >> 1];
  // Letters that actually sit on the baseline. Their other edge is the
  // x-height. A capital or ascender clears that x-height, not the baseline.
  const shorts = [];
  for (let i = 0; i < body.length; i++) {
    if (Math.abs(baseVals[i] - baseMed) <= 1.5) shorts.push(body[i]);
  }
  const farVals = shorts.map(function (c) { return flatIsBottom ? c.y : c.b; });
  farVals.sort(function (a, b) { return a - b; });
  const xHeight = farVals.length ? farVals[(farVals.length - 1) >> 1] : baseMed;
  let nTall = 0;
  for (let i = 0; i < body.length; i++) {
    const ext = flatIsBottom ? (xHeight - body[i].y) : (body[i].b - xHeight);
    if (ext >= 4) nTall += 1;
  }
  const info = {
    x: body[0].x,
    y: body[0].y,
    n: body.length,
    span: span,
    topSd: Math.round(topSd * 10) / 10,
    botSd: Math.round(botSd * 10) / 10,
    nTall: nTall,
    vote: null
  };
  if (span < SPAN_MIN || span > SPAN_MAX) return info;
  const flat = Math.min(topSd, botSd);
  const ragged = Math.max(topSd, botSd);
  if (flat > FLAT_SD_MAX) return info;
  if (ragged < flat + EDGE_GAP) return info;
  if (ragged / Math.max(0.4, flat) < SD_RATIO) return info;
  // Two or more ascenders, and not so many that the whole word is just uneven.
  if (nTall < 2 || nTall > body.length / 2) return info;
  // The baseline is the straight edge. Upright type sits on the bottom.
  info.vote = flatIsBottom ? 'up' : 'down';
  return info;
}

/**
 * @param {Uint8Array} grey row-major, one byte per pixel
 * @param {number} width
 * @param {number} height
 * @returns {{ orientation: 'upright'|'180'|'conflict'|'unknown', up: number, down: number,
 *   words: Array<{x:number,y:number,n:number,span:number,topSd:number,botSd:number,nTall:number,vote:string}> }}
 */
function designOrientation(grey, width, height) {
  const w = width | 0;
  const h = height | 0;
  const empty = { orientation: 'unknown', up: 0, down: 0 };
  if (!grey || w < 40 || h < 40 || grey.length < w * h) return empty;
  const ii = integral(grey, w, h);
  const rad = LOCAL_RADIUS;
  const win = (2 * rad + 1) * (2 * rad + 1);
  const ink = new Uint8Array(w * h);
  for (let y = rad; y < h - rad; y++) {
    for (let x = rad; x < w - rad; x++) {
      const mean = rectSum(ii, w, x - rad, y - rad, x + rad + 1, y + rad + 1) / win;
      const g = grey[y * w + x];
      if (g + INK_DARKER < mean && g < INK_MAX) ink[y * w + x] = 1;
    }
  }
  const words = wordsOf(components(ink, w, h));
  let up = 0;
  let down = 0;
  const detail = [];
  for (let i = 0; i < words.length; i++) {
    const info = voteWord(words[i]);
    if (!info) continue;
    if (info.vote === 'up') up += 1;
    else if (info.vote === 'down') down += 1;
    if (info.vote) detail.push(info);
  }
  let orientation = 'unknown';
  if (up > 0 && down > 0) orientation = 'conflict';
  else if (down > 0) orientation = '180';
  else if (up > 0) orientation = 'upright';
  return { orientation: orientation, up: up, down: down, words: detail };
}

module.exports = {
  designOrientation,
  LOCAL_RADIUS,
  FLAT_SD_MAX,
  SPAN_MIN,
  SPAN_MAX
};
