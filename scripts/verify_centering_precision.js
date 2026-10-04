/**
 * scripts/verify_centering_precision.js
 * Centering precision: 643×900 warp ("standard") vs the card's native
 * resolution ("native"), on 12 synthetic phone-like captures of the Karros
 * geometry (ruler: L 4.0, R 3.0, T 3.0, B 3.5 mm → L/R 57.14, T/B 46.15).
 * Each capture has sub-pixel placement, a small rotation and keystone, a
 * native quad a few px off the true corners, sensor noise, and JPEG.
 * Run: node scripts/verify_centering_precision.js
 */
'use strict';

const sharp = require('sharp');
const cq = require('../services/card_quad');
const g = require('../services/grading_engine');

const CARD_W_MM = 63.5;
const CARD_H_MM = 88.9;
const BORDER_MM = { left: 4.0, right: 3.0, top: 3.0, bottom: 3.5 };
const TRUE_LR = 100 * BORDER_MM.left / (BORDER_MM.left + BORDER_MM.right);
const TRUE_TB = 100 * BORDER_MM.top / (BORDER_MM.top + BORDER_MM.bottom);
const PHOTO_W = 1400;
const PHOTO_H = 1900;
const SUPER = 2;

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : ''); }
}

function rng(seed) {
  let x = seed >>> 0;
  return function () {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

function cardColor(u, v) {
  // u,v in mm from the card's top-left corner.
  if (u < 0 || v < 0 || u > CARD_W_MM || v > CARD_H_MM) return null;
  const inBorder = u < BORDER_MM.left || u > CARD_W_MM - BORDER_MM.right ||
    v < BORDER_MM.top || v > CARD_H_MM - BORDER_MM.bottom;
  return inBorder ? [246, 246, 243] : [52, 60, 84];
}

async function capture(i) {
  const r = rng(1000 + i * 7919);
  const cx = PHOTO_W / 2 + (r() - 0.5) * 30;
  const cy = PHOTO_H / 2 + (r() - 0.5) * 30;
  const hPx = 1580 + (r() - 0.5) * 40;
  const wPx = hPx * CARD_W_MM / CARD_H_MM;
  const rot = (r() - 0.5) * 0.8 * Math.PI / 180;
  const keystone = (r() - 0.5) * 0.01;
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(function (c) {
    const k = 1 + keystone * (c[1] < 0 ? 1 : -1);
    const x = c[0] * wPx * k;
    const y = c[1] * hPx;
    return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
  });
  const quad = { tl: corners[0], tr: corners[1], br: corners[2], bl: corners[3] };
  // Photo(2x) pixel → card mm.
  const Hm = cq.computeHomography(
    corners.map(function (p) { return [p[0] * SUPER, p[1] * SUPER]; }),
    [[0, 0], [CARD_W_MM, 0], [CARD_W_MM, CARD_H_MM], [0, CARD_H_MM]]
  );
  const W2 = PHOTO_W * SUPER;
  const H2 = PHOTO_H * SUPER;
  const data = Buffer.alloc(W2 * H2 * 3);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const m = cq.applyHomography(Hm, x + 0.5, y + 0.5);
      const c = cardColor(m[0], m[1]) || [226, 80, 150];
      const o = (y * W2 + x) * 3;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
    }
  }
  let img = await sharp(data, { raw: { width: W2, height: H2, channels: 3 } })
    .resize(PHOTO_W, PHOTO_H, { kernel: 'cubic' }).raw().toBuffer();
  const noisy = Buffer.from(img);
  for (let k = 0; k < noisy.length; k++) {
    const n = (r() + r() + r() - 1.5) * 6;
    noisy[k] = Math.max(0, Math.min(255, Math.round(noisy[k] + n)));
  }
  const jpeg = await sharp(noisy, { raw: { width: PHOTO_W, height: PHOTO_H, channels: 3 } })
    .jpeg({ quality: 90 }).toBuffer();
  const off = function (p) { return [p[0] + (r() - 0.5) * 4, p[1] + (r() - 0.5) * 4]; };
  const vision = { tl: off(quad.tl), tr: off(quad.tr), br: off(quad.br), bl: off(quad.bl) };
  return { jpeg: jpeg, cardQuad: JSON.stringify(vision) };
}

async function measure(cap, mode) {
  const log = console.log;
  console.log = function () {};
  const rep = await g.gradeBuffer(cap.jpeg, {
    alignmentCrop: true, cardQuad: cap.cardQuad, quadImageWidth: PHOTO_W, quadImageHeight: PHOTO_H,
    centeringResolution: mode
  });
  console.log = log;
  const m = rep.centeringMetrics || {};
  return {
    lr: m.leftRightRatio ? m.leftRightRatio.left : null,
    tb: m.topBottomRatio ? m.topBottomRatio.top : null,
    mm: m.borderWidthsMm || null,
    warp: m.centeringWarp || null
  };
}

function stats(values, truth) {
  const v = values.filter(function (x) { return x != null; });
  const mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
  const sd = Math.sqrt(v.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / v.length);
  return { n: v.length, spread: Math.max.apply(null, v) - Math.min.apply(null, v), sd: sd, bias: mean - truth };
}

async function run() {
  const rows = { standard: [], native: [] };
  for (let i = 0; i < 12; i++) {
    const cap = await capture(i);
    rows.standard.push(await measure(cap, 'standard'));
    rows.native.push(await measure(cap, 'native'));
  }
  const out = {};
  ['standard', 'native'].forEach(function (mode) {
    out[mode] = {
      lr: stats(rows[mode].map(function (r) { return r.lr; }), TRUE_LR),
      tb: stats(rows[mode].map(function (r) { return r.tb; }), TRUE_TB)
    };
    const o = out[mode];
    console.log(mode.padEnd(9) + 'measured ' + o.lr.n + '/12  ' +
      'L/R spread ' + o.lr.spread.toFixed(2) + ' sd ' + o.lr.sd.toFixed(2) + ' bias ' + o.lr.bias.toFixed(2) + '   ' +
      'T/B spread ' + o.tb.spread.toFixed(2) + ' sd ' + o.tb.sd.toFixed(2) + ' bias ' + o.tb.bias.toFixed(2) +
      '   warp ' + (rows[mode][0].warp ? rows[mode][0].warp.width + '×' + rows[mode][0].warp.height : '—'));
  });
  const mmRow = rows.native[0].mm;
  console.log('native mm (scan 0): ' + JSON.stringify(mmRow) + '  truth ' + JSON.stringify(BORDER_MM));

  assert('both modes measure all 12', out.standard.lr.n === 12 && out.native.lr.n === 12);
  assert('native warp is the card\'s own resolution (> 900 tall)', rows.native[0].warp && rows.native[0].warp.height > 1400,
    rows.native[0].warp);
  assert('native L/R spread ≤ standard', out.native.lr.spread <= out.standard.lr.spread + 1e-9, out);
  assert('native T/B spread ≤ standard', out.native.tb.spread <= out.standard.tb.spread + 1e-9, out);
  assert('native L/R and T/B spread < 0.5 pt', out.native.lr.spread < 0.5 && out.native.tb.spread < 0.5, out.native);
  assert('native |bias| < 0.5 pt vs truth', Math.abs(out.native.lr.bias) < 0.5 && Math.abs(out.native.tb.bias) < 0.5,
    out.native);
  assert('mm widths within 0.1 mm of truth', mmRow &&
    ['left', 'right', 'top', 'bottom'].every(function (k) { return Math.abs(mmRow[k] - BORDER_MM[k]) < 0.1; }), mmRow);

  if (failures) { console.error(failures + ' precision check(s) failed.'); process.exit(1); }
  console.log('All centering precision checks passed.');
}

run().catch(function (err) { console.error('FAIL precision run threw', err); process.exit(1); });
