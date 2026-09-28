/**
 * scripts/verify_edge_bias.js
 * Checks scripts/edge_bias.js and scripts/bench_centering.js on synthetic
 * captures written to a temp data dir (truth: L 4.0, R 3.0, T 3.0, B 3.5 mm).
 *   A. upright, clean: per-edge error ≈ 0; a ruler claiming top 3.2 shows a
 *      steady −0.2 mm top error; ratio test attributes 0.2 mm to the top.
 *   B. a dark notch inside the top border at the centre line: one shallow
 *      top outlier at k7 on every scan, top width unchanged.
 *   C. half upright, half turned 180°, with 0.2 mm trimmed off whichever
 *      card edge is at the photo top: rotation test reports photo-frame
 *      T−B ≈ −0.2 mm and card-frame T−B ≈ −0.5 mm.
 *   D. bench_centering runs and reports a native warp > 900 tall.
 * Run: node scripts/verify_edge_bias.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const cq = require('../services/card_quad');
const { edgeBias, impliedShift } = require('./edge_bias');
const { benchCentering } = require('./bench_centering');

const CARD_W_MM = 63.5;
const CARD_H_MM = 88.9;
const BORDER_MM = { left: 4.0, right: 3.0, top: 3.0, bottom: 3.5 };
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

/** u,v = mm from the top-left of the card as it lies in the photo. */
function placedColor(u, v, opts) {
  if (u < 0 || v < 0 || u > CARD_W_MM || v > CARD_H_MM) return null;
  if (opts.trimTopMm && v < opts.trimTopMm) return null;
  const cu = opts.rotated ? CARD_W_MM - u : u;
  const cv = opts.rotated ? CARD_H_MM - v : v;
  if (opts.notch && cu > 31.0 && cu < 32.5 && cv > 1.5 && cv < BORDER_MM.top) return [52, 60, 84];
  const inBorder = cu < BORDER_MM.left || cu > CARD_W_MM - BORDER_MM.right ||
    cv < BORDER_MM.top || cv > CARD_H_MM - BORDER_MM.bottom;
  return inBorder ? [246, 246, 243] : [52, 60, 84];
}

async function capture(i, opts) {
  const r = rng(5000 + i * 7919);
  const cx = PHOTO_W / 2 + (r() - 0.5) * 30;
  const cy = PHOTO_H / 2 + (r() - 0.5) * 30;
  const hPx = 1580 + (r() - 0.5) * 40;
  const wPx = hPx * CARD_W_MM / CARD_H_MM;
  const rot = (r() - 0.5) * 0.8 * Math.PI / 180;
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(function (c) {
    const x = c[0] * wPx;
    const y = c[1] * hPx;
    return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
  });
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
      const c = placedColor(m[0], m[1], opts) || [226, 80, 150];
      const o = (y * W2 + x) * 3;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
    }
  }
  const img = await sharp(data, { raw: { width: W2, height: H2, channels: 3 } })
    .resize(PHOTO_W, PHOTO_H, { kernel: 'cubic' }).raw().toBuffer();
  const noisy = Buffer.from(img);
  for (let k = 0; k < noisy.length; k++) {
    noisy[k] = Math.max(0, Math.min(255, Math.round(noisy[k] + (r() + r() + r() - 1.5) * 6)));
  }
  const jpeg = await sharp(noisy, { raw: { width: PHOTO_W, height: PHOTO_H, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  const off = function (p) { return [p[0] + (r() - 0.5) * 4, p[1] + (r() - 0.5) * 4]; };
  return { jpeg: jpeg, quad: { tl: off(corners[0]), tr: off(corners[1]), br: off(corners[2]), bl: off(corners[3]) } };
}

async function writeDeck(name, specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-bias-' + name + '-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'uploads'));
  const inventory = [];
  for (let i = 0; i < specs.length; i++) {
    const cap = await capture(i, specs[i]);
    const scanId = (specs[i].rotated ? 'r' : 'u') + String(i).padStart(7, '0') + '-0000-4000-8000-000000000000';
    const file = scanId + '.jpg';
    fs.writeFileSync(path.join(root, 'uploads', file), cap.jpeg);
    inventory.push({
      scanId: scanId,
      createdAt: new Date(Date.UTC(2026, 8, 28, 12, 0, i)).toISOString(),
      imagePath: 'uploads/' + file,
      gradingReport: {
        cardDetection: {
          quadSource: 'native', rawQuad: cq.quadToJSON(cap.quad),
          photoWidth: PHOTO_W, photoHeight: PHOTO_H, nativeQuadConfidence: 0.95
        }
      }
    });
  }
  fs.writeFileSync(path.join(root, 'data', 'database.json'), JSON.stringify({ inventory: inventory }));
  return root;
}

function repeat(n, spec) { return Array.from({ length: n }, function () { return Object.assign({}, spec); }); }

async function run() {
  const x = impliedShift(3.0, 3.5, 100 * 3.2 / 6.7);
  assert('impliedShift: top 3.0 vs ruler 3.2/3.5 → top short 0.2 mm', Math.abs(x.firstShort - 0.2) < 1e-9, x);

  const deckA = await writeDeck('a', repeat(6, {}));
  const a = await edgeBias({ appDir: deckA, n: 6, rulerMm: [4.0, 3.0, 3.2, 3.5], rulerTb: 100 * 3.2 / 6.7 });
  console.log(a.text);
  assert('A: all 6 scans analyzed', a.perScan.length === 6, a.skipped);
  const e = a.tests.rulerMm;
  assert('A: left/right/bottom error |mean| < 0.1 mm', ['left', 'right', 'bottom'].every(function (k) {
    return Math.abs(e[k].mean) < 0.1;
  }), e);
  assert('A: top error ≈ −0.2 mm (|err+0.2| < 0.1)', Math.abs(e.top.mean + 0.2) < 0.1, e.top);
  assert('A: top error is steady (|t| ≥ 5)', e.top.t != null && Math.abs(e.top.t) >= 5, e.top);
  assert('A: ratio test puts ≈ 0.2 mm on the top', Math.abs(a.tests.rulerTb.topShortMm.mean - 0.2) < 0.1, a.tests.rulerTb);
  assert('A: clean border → no top outliers', a.summary.top.scansWithOutliers === 0, a.summary.top);

  const deckB = await writeDeck('b', repeat(4, { notch: true }));
  const b = await edgeBias({ appDir: deckB, n: 4 });
  console.log(b.text);
  assert('B: every scan has a top outlier', b.summary.top.scansWithOutliers === 4, b.summary.top);
  assert('B: outliers are shallow at k7', /^k7−×4/.test(b.summary.top.outlierIndexes), b.summary.top.outlierIndexes);
  assert('B: top width unaffected (|mean − 3.0| < 0.1 mm)', Math.abs(b.summary.top.mm.mean - 3.0) < 0.1, b.summary.top.mm);

  const specsC = repeat(4, { trimTopMm: 0.2 }).concat(repeat(4, { trimTopMm: 0.2, rotated: true }));
  const deckC = await writeDeck('c', specsC);
  const rotatedIds = ['r0000004', 'r0000005', 'r0000006', 'r0000007'];
  const c = await edgeBias({ appDir: deckC, n: 8, rotated: rotatedIds });
  console.log(c.text);
  const rt = c.tests.rotation && c.tests.rotation['T−B'];
  assert('C: 4 upright + 4 rotated', c.perScan.filter(function (s) { return s.rotated; }).length === 4, c.perScan.map(function (s) { return s.scanId; }));
  assert('C: photo-frame T−B ≈ −0.2 mm', rt && Math.abs(rt.photoFrameMm + 0.2) < 0.1, rt);
  assert('C: card-frame T−B ≈ −0.5 mm (print truth)', rt && Math.abs(rt.cardFrameMm + 0.5) < 0.1, rt);
  const lrt = c.tests.rotation && c.tests.rotation['L−R'];
  assert('C: no photo-frame L−R bias (|x| < 0.1 mm)', lrt && Math.abs(lrt.photoFrameMm) < 0.1, lrt);

  const bench = await benchCentering({ appDir: deckA, n: 2, reps: 1 });
  console.log(bench.text);
  assert('D: bench timed 2 scans', bench.rows.length === 2, bench.skipped);
  assert('D: native warp taller than 900', bench.rows.every(function (r) { return Number(r.warpSize.split('×')[1]) > 900; }), bench.rows);
  assert('D: all timings finite', bench.rows.every(function (r) {
    return ['warpMs', 'refineMs', 'locateMs', 'gradeMs'].every(function (k) {
      return isFinite(r[k].standard) && isFinite(r[k].native);
    });
  }), bench.rows);

  [deckA, deckB, deckC].forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); });
  if (failures) { console.error(failures + ' edge-bias check(s) failed.'); process.exit(1); }
  console.log('All edge-bias checks passed.');
}

run().catch(function (err) { console.error('FAIL edge-bias run threw', err); process.exit(1); });
