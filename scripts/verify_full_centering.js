/**
 * scripts/verify_full_centering.js
 * Opt-in centering at the card's own pixels. The default grade path stays
 * the capped native warp. `centeringResolution: 'full'` crops the card and
 * measures it on one shared warp. Confidence follows the achieved px/mm.
 * Run: node scripts/verify_full_centering.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const cq = require('../services/card_quad');
const g = require('../services/grading_engine');
const { buildCaptureGroups } = require('./deck_report');
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

/** A card taller than the 2400 decode cap, so the full warp has to keep those pixels. */
async function tallCard() {
  const photoW = 2800;
  const photoH = 4000;
  const cardH = 2800;
  const cardW = Math.round(cardH * 63.5 / 88.9);
  const left = Math.round((photoW - cardW) / 2);
  const top = Math.round((photoH - cardH) / 2);
  const sw = 280;
  const sh = 400;
  const raw = Buffer.alloc(sw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const X = (x + 0.5) * (photoW / sw);
      const Y = (y + 0.5) * (photoH / sh);
      const inside = X >= left && X < left + cardW && Y >= top && Y < top + cardH;
      const i = (y * sw + x) * 3;
      raw[i] = inside ? 40 : 220;
      raw[i + 1] = inside ? 48 : 70;
      raw[i + 2] = inside ? 70 : 150;
    }
  }
  const jpeg = await sharp(raw, { raw: { width: sw, height: sh, channels: 3 } })
    .resize(photoW, photoH, { kernel: 'nearest' })
    .jpeg({ quality: 75 })
    .toBuffer();
  const quad = {
    tl: [left, top],
    tr: [left + cardW - 1, top],
    br: [left + cardW - 1, top + cardH - 1],
    bl: [left, top + cardH - 1]
  };
  return { jpeg: jpeg, quad: JSON.stringify(quad), photoW: photoW, photoH: photoH, cardH: cardH };
}

async function run() {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const contract = fs.readFileSync(path.join(__dirname, '..', 'docs', 'capture_contract.md'), 'utf8');
  assert('upload limit is 20 MB', server.includes('20 * 1024 * 1024') && !server.includes('10 * 1024 * 1024'));
  assert('no fixed full-resolution pixel size', g.FULL_CENTERING_PX_PER_MM == null);
  assert('refine exclusion is 0.2 mm', g.REFINE_RUNNER_UP_SEPARATION_MM === 0.2);
  assert('the capture contract is platform-neutral',
    contract.includes('deviceModel') && contract.includes('cardQuad') && contract.includes('px/mm') &&
    !/builtInWideAngle|HEIC|photoSizeSetting/.test(contract));

  assert('30 px/mm supports ±0.1 mm', g.resolutionToleranceMm(30) === 0.1);
  assert('29.9 px/mm is ±0.2 mm', g.resolutionToleranceMm(29.9) === 0.2);
  assert('the contract uploads the quad plus a margin',
    /quad plus a margin/.test(contract) && !contract.includes('1748×2448') && !contract.includes('1748x2448'));
  assert('the contract keeps the sharp band on the measured phone',
    contract.includes('29–31') && contract.includes('iPhone14,2'));
  assert('an unmeasured phone uses a default band and is not locked out',
    /default band/.test(contract) && !/shutter stays closed/.test(contract));
  const bandLog = require('../services/sharp_band_log');
  assert('30.0 logs as ±0.1 mm', bandLog.tierLabel(30) === '±0.1 mm' && bandLog.tierLabel(30.0) === '±0.1 mm');
  assert('29.9 logs as ±0.2 mm', bandLog.tierLabel(29.9) === '±0.2 mm');
  assert('14.9 logs as withheld', bandLog.tierLabel(14.9) === 'withheld, resolution');
  const learned = bandLog.recordFromItem({
    scanId: 'learn-1', side: 'front',
    capture: { deviceModel: 'Pixel 8', camera: 'back', captureWidth: 4000, captureHeight: 3000, pxPerMm: 30 },
    captureMetadata: { capture: { sharpBand: 'default' } }
  });
  assert('the learning row keeps the device, the label, and the default band',
    learned && learned.deviceModel === 'Pixel 8' && learned.camera === 'back' &&
    learned.pxPerMm === 30 && learned.label === '±0.1 mm' && learned.sharpBand === 'default' &&
    learned.captureWidth === 4000);
  assert('a scan with no px/mm is not a band sample',
    bandLog.recordFromItem({ capture: { deviceModel: 'Pixel 8', pxPerMm: null } }) == null);
  const onLine = g.applyEdgeResolution({
    cardDetection: { achievedPxPerMm: 30.0 },
    centeringMetrics: { finePrintEdges: [], borderWidthsMm: { left: 3.1 } }
  });
  const underLine = g.applyEdgeResolution({
    cardDetection: { achievedPxPerMm: 29.9 },
    centeringMetrics: { finePrintEdges: [], borderWidthsMm: { left: 3.1 } }
  });
  assert('30.0 is on the line and the label follows that scan',
    onLine.centeringMetrics.edgeResolution.left.label === '±0.1 mm' &&
    onLine.centeringMetrics.edgeResolution.left.toleranceMm === 0.1 &&
    onLine.centeringMetrics.borderWidthsMm.left === 3.1);
  assert('29.9 on the next scan stays ±0.2 mm',
    underLine.centeringMetrics.edgeResolution.left.label === '±0.2 mm' &&
    underLine.centeringMetrics.edgeResolution.left.toleranceMm === 0.2 &&
    underLine.centeringMetrics.borderWidthsMm.left === 3.1);
  assert('15 px/mm supports ±0.2 mm', g.resolutionToleranceMm(15) === 0.2);
  assert('14.9 px/mm is withheld', g.resolutionToleranceMm(14.9) == null);
  assert('unknown px/mm keeps the flatbed rule',
    g.edgeScoreToleranceMm(null, false) === 0.1 && g.edgeScoreToleranceMm(undefined, true) === 0.2);
  assert('fine-print stays at ±0.2 mm when the pixels support 0.1', g.edgeScoreToleranceMm(40, true) === 0.2);
  assert('fine-print is withheld below 15 px/mm', g.edgeScoreToleranceMm(10, true) == null);
  const untouched = g.applyEdgeResolution({ centeringMetrics: { borderToleranceMm: { left: 0.1 }, borderWidthsMm: { left: 3 } } });
  assert('a report with no px/mm keeps its tolerances',
    untouched.centeringMetrics.edgeResolution == null && untouched.centeringMetrics.borderToleranceMm.left === 0.1);
  const withheld = g.applyEdgeResolution({
    cardDetection: { achievedPxPerMm: 12 },
    centeringMetrics: { finePrintEdges: ['top'], borderWidthsMm: { left: 1.25, right: 1, top: 2, bottom: 2 } }
  });
  assert('12 px/mm withholds the edge and keeps the millimetres',
    withheld.centeringMetrics.edgeResolution.left.label === 'withheld, resolution' &&
    withheld.centeringMetrics.edgeResolution.top.label === 'withheld, resolution' &&
    withheld.centeringMetrics.borderWidthsMm.left === 1.25 &&
    withheld.centeringMetrics.borderToleranceMm.left == null, withheld.centeringMetrics.edgeResolution);

  const trusted = buildCaptureGroups([{
    deckId: 'TD-04', deviceModel: 'Pixel 8', camera: 'back', captureWidth: 4000, captureHeight: 3000,
    pxPerMm: 32, mm: { bottom: 1.416 }
  }]);
  assert('a 32 px/mm capture on the key is trusted at ±0.1 mm',
    trusted.length === 1 && trusted[0].claim === 'trusted, ±0.1 mm' && trusted[0].line.indexOf('Pixel 8') === 0, trusted[0]);
  const mixed = buildCaptureGroups([
    { deckId: 'TD-04', deviceModel: 'Pixel 8', camera: 'back', captureWidth: 4000, captureHeight: 3000, pxPerMm: 32, mm: { bottom: 1.416 } },
    { deckId: 'TD-04', deviceModel: 'Pixel 8', camera: 'back', captureWidth: 4000, captureHeight: 3000, pxPerMm: 22, mm: { bottom: 1.50 } }
  ]);
  assert('the weakest scan in a group sets the claim',
    mixed.length === 1 && mixed[0].claim === '±0.2 mm' && mixed[0].pxMin === 22 && mixed[0].pxMax === 32, mixed[0]);
  const fine = buildCaptureGroups([{
    deckId: 'TD-02', deviceModel: 'Pixel 8', camera: 'back', captureWidth: 4000, captureHeight: 3000,
    pxPerMm: 40, mm: { top: 3.495 }
  }]);
  assert('a fine-print edge inside 0.2 mm still trusts ±0.1 mm at 40 px/mm',
    fine[0].claim === 'trusted, ±0.1 mm', fine[0]);
  const off = buildCaptureGroups([{
    deckId: 'TD-04', deviceModel: 'Pixel 8', camera: 'back', captureWidth: 4000, captureHeight: 3000,
    pxPerMm: 32, mm: { bottom: 1.152 }
  }]);
  assert('a group off the flatbed key is not trusted',
    off[0].claim === 'not trusted' && off[0].reason === 'off the flatbed key', off[0]);
  const lowGroup = buildCaptureGroups([{
    deckId: 'TD-04', deviceModel: 'Pixel 8', camera: 'back', captureWidth: 1000, captureHeight: 1500,
    pxPerMm: 10, mm: { bottom: 1.416 }
  }]);
  assert('a group under 15 px/mm is not trusted',
    lowGroup[0].claim === 'not trusted' && lowGroup[0].reason === 'withheld, resolution', lowGroup[0]);
  const unnamed = buildCaptureGroups([{ deckId: 'TD-04', pxPerMm: 32, mm: { bottom: 1.416 } }]);
  assert('a scan with no device groups as unspecified',
    unnamed[0].deviceModel === 'unspecified device' && unnamed[0].camera === 'unspecified camera' &&
    unnamed[0].size === 'unspecified size', unnamed[0]);

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
  assert('a 14 px exclusion skips that step', far.cutSteps.left.runnerUpOffsetPx === 20, far.cutSteps.left);
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
  const cardH = full.cardDetection && full.cardDetection.cardSizePx && full.cardDetection.cardSizePx.heightPx;
  const achieved = full.cardDetection && full.cardDetection.achievedPxPerMm;
  assert('omitted setting stays on the capped warp', nativeWarp && nativeWarp.mode === 'native' && nativeWarp.height <= 2400, nativeWarp);
  assert('full warp follows the card height in the photo', fullWarp && fullWarp.mode === 'full' && fullWarp.sharedWarp === true &&
    fullWarp.runnerUpSeparationMm === 0.2 && cardH > 900 && cardH < 2400 &&
    fullWarp.height > 900 && fullWarp.height < 2400 &&
    fullWarp.height <= cardH * 1.02 && fullWarp.height >= cardH * 0.85, { cardH: cardH, fullWarp: fullWarp });
  assert('achieved px/mm is the card in the photo, not the warp target',
    achieved > 15 && achieved < 30 && Math.abs(achieved - cardH / 88.9) < 0.05, { achieved: achieved, cardH: cardH });
  assert('about 18 px/mm is labeled ±0.2 mm',
    full.centeringMetrics.edgeResolution.left.label === '±0.2 mm' &&
    full.centeringMetrics.edgeResolution.left.toleranceMm === 0.2, full.centeringMetrics.edgeResolution);
  const nativeMm = (native.centeringMetrics && native.centeringMetrics.borderWidthsMm) || {};
  const fullMm = (full.centeringMetrics && full.centeringMetrics.borderWidthsMm) || {};
  const close = ['left', 'right', 'top', 'bottom'].every(function (k) {
    return nativeMm[k] != null && fullMm[k] != null && Math.abs(nativeMm[k] - fullMm[k]) <= 0.2;
  });
  assert('full borders stay within 0.2 mm of the same capture graded the old way', close, { native: nativeMm, full: fullMm });

  const tall = await tallCard();
  const tallGrade = await quiet(function () {
    return g.gradeBuffer(tall.jpeg, {
      alignmentCrop: true, cardQuad: tall.quad, quadImageWidth: tall.photoW, quadImageHeight: tall.photoH,
      centeringResolution: 'full'
    });
  });
  const tallWarp = tallGrade.centeringMetrics && tallGrade.centeringMetrics.centeringWarp;
  const tallPx = tallGrade.cardDetection && tallGrade.cardDetection.achievedPxPerMm;
  assert('a card above the decode cap is warped at its own pixels',
    tallWarp && tallWarp.mode === 'full' && tallWarp.height > 2400 && tallWarp.height <= tall.cardH * 1.02, tallWarp);
  assert('that card is labeled from its own px/mm',
    tallPx >= 30 && tallGrade.centeringMetrics.edgeResolution.left.label === '±0.1 mm',
    { tallPx: tallPx, label: tallGrade.centeringMetrics && tallGrade.centeringMetrics.edgeResolution });

  if (failures) { console.error(failures + ' full-centering check(s) failed.'); process.exit(1); }
  console.log('All full-centering checks passed.');
}

run().catch(function (err) {
  console.error(err);
  process.exit(1);
});
