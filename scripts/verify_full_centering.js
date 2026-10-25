/**
 * scripts/verify_full_centering.js
 * Opt-in 70 px/mm centering. The default grade path stays the capped native
 * warp. `centeringResolution: 'full'` crops the card and measures it on one
 * shared warp, with the runner-up cut excluded inside 0.2 mm.
 * Run: node scripts/verify_full_centering.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const cq = require('../services/card_quad');
const g = require('../services/grading_engine');
const { capture } = require('./synthetic_capture');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : ''); }
}

function quiet(fn) {
  const log = console.log;
  console.log = function () {};
  return Promise.resolve().then(fn).finally(function () { console.log = log; });
}

/** Identity-scale card. Left edge has a second step 10 px in and a third 20 px in. */
function steppedCard() {
  const W = 2080;
  const H = 416;
  const data = Buffer.alloc(W * H, 220);
  function paint(x0, x1, v) {
    for (let y = 8; y < 408; y++) {
      for (let x = x0; x < x1; x++) data[y * W + x] = v;
    }
  }
  paint(40, 50, 80);
  paint(50, 60, 20);
  paint(60, 2040, 0);
  return {
    src: { data: data, width: W, height: H, channels: 1 },
    quad: { tl: [40, 8], tr: [2039, 8], br: [2039, 407], bl: [40, 407] }
  };
}

async function uprightCropKeepsOrientation() {
  const W = 48;
  const H = 32;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const red = x < W / 2;
      raw[i] = red ? 220 : 20;
      raw[i + 1] = 20;
      raw[i + 2] = red ? 20 : 220;
    }
  }
  const jpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const upright = await sharp(jpeg).rotate().raw().toBuffer({ resolveWithObject: true });
  const quad = {
    tl: [0, 0],
    tr: [upright.info.width - 1, 0],
    br: [upright.info.width - 1, upright.info.height - 1],
    bl: [0, upright.info.height - 1]
  };
  const crop = await g.uprightCardCrop(jpeg, quad, upright.info.width, upright.info.height);
  if (!crop || crop.width !== upright.info.width || crop.height !== upright.info.height) return false;
  let diff = 0;
  for (let i = 0; i < crop.data.length; i++) diff += Math.abs(crop.data[i] - upright.data[i]);
  return diff / crop.data.length < 2;
}

async function run() {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert('upload limit is 20 MB', server.includes('20 * 1024 * 1024') && !server.includes('10 * 1024 * 1024'));
  assert('full centering is 70 px/mm', g.FULL_CENTERING_PX_PER_MM === 70);
  assert('refine exclusion is 0.2 mm', g.REFINE_RUNNER_UP_SEPARATION_MM === 0.2);

  const turned = cq.rotate180({
    data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    width: 2, height: 2, channels: 3
  });
  assert('rotate180 swaps both axes', turned.width === 2 && turned.height === 2 &&
    turned.data[0] === 10 && turned.data[1] === 11 && turned.data[2] === 12 &&
    turned.data[9] === 1 && turned.data[10] === 2 && turned.data[11] === 3);

  const step = steppedCard();
  const near = cq.refineQuadToCut(step.src, step.quad, 2000, 400);
  const far = cq.refineQuadToCut(step.src, step.quad, 2000, 400, {
    runnerUpSeparationPx: 14,
    keepWarp: true
  });
  assert('default exclusion still sees a step 10 px away', near.cutSteps.left.runnerUpOffsetPx === 10, near.cutSteps.left);
  assert('0.2 mm exclusion (14 px at 70 px/mm) skips that step', far.cutSteps.left.runnerUpOffsetPx === 20, far.cutSteps.left);
  assert('keepWarp returns the one expanded warp', far.warp && far.warp.width > 2000 && far.edgePx && far.edgePx.left > 0);

  assert('upright crop follows EXIF orientation', await uprightCropKeepsOrientation());

  const cap = await capture(7);
  const native = await quiet(function () {
    return g.gradeBuffer(cap.jpeg, {
      alignmentCrop: true, cardQuad: cap.cardQuad, quadImageWidth: cap.photoWidth, quadImageHeight: cap.photoHeight
    });
  });
  const full = await quiet(function () {
    return g.gradeBuffer(cap.jpeg, {
      alignmentCrop: true, cardQuad: cap.cardQuad, quadImageWidth: cap.photoWidth, quadImageHeight: cap.photoHeight,
      centeringResolution: 'full'
    });
  });
  const nativeWarp = native.centeringMetrics && native.centeringMetrics.centeringWarp;
  const fullWarp = full.centeringMetrics && full.centeringMetrics.centeringWarp;
  assert('omitted setting stays on the capped warp', nativeWarp && nativeWarp.mode === 'native' && nativeWarp.height <= 2400, nativeWarp);
  assert('full setting is the shared 70 px/mm warp', fullWarp && fullWarp.mode === 'full' && fullWarp.sharedWarp === true &&
    fullWarp.runnerUpSeparationMm === 0.2 && fullWarp.pxPerMm >= 65 && fullWarp.pxPerMm <= 75 && fullWarp.height >= 5600, fullWarp);
  const nativeMm = (native.centeringMetrics && native.centeringMetrics.borderWidthsMm) || {};
  const fullMm = (full.centeringMetrics && full.centeringMetrics.borderWidthsMm) || {};
  const close = ['left', 'right', 'top', 'bottom'].every(function (k) {
    return nativeMm[k] != null && fullMm[k] != null && Math.abs(nativeMm[k] - fullMm[k]) <= 0.2;
  });
  assert('full borders stay within 0.2 mm of the same capture graded the old way', close, { native: nativeMm, full: fullMm });

  if (failures) { console.error(failures + ' full-centering check(s) failed.'); process.exit(1); }
  console.log('All full-centering checks passed.');
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
