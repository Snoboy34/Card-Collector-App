/**
 * scripts/verify_card_box.js
 * Card-box regression: homography + warp, quad validation, locateCard, and
 * the /api/grade 422 path (nothing saved to inventory, failed scan logged).
 * Run: node scripts/verify_card_box.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const cq = require('../services/card_quad');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log('PASS', label);
  } else {
    failures += 1;
    console.error('FAIL', label, detail !== undefined ? detail : '');
  }
}
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// Homography: known quad → known output corners
// ---------------------------------------------------------------------------
const skewQuad = { tl: [212.5, 140], tr: [1011, 188], br: [1064, 1302], bl: [161, 1245] };
const outCorners = [[0, 0], [642, 0], [642, 899], [0, 899]];
const H = cq.computeHomography(outCorners, [skewQuad.tl, skewQuad.tr, skewQuad.br, skewQuad.bl]);
['tl', 'tr', 'br', 'bl'].forEach(function (key, i) {
  const mapped = cq.applyHomography(H, outCorners[i][0], outCorners[i][1]);
  assert('homography maps output ' + key + ' onto quad ' + key,
    near(mapped[0], skewQuad[key][0], 1e-6) && near(mapped[1], skewQuad[key][1], 1e-6), mapped);
});
const Hinv = cq.computeHomography([skewQuad.tl, skewQuad.tr, skewQuad.br, skewQuad.bl], outCorners);
const roundTrip = cq.applyHomography(Hinv, ...cq.applyHomography(H, 321, 450));
assert('homography inverse round-trips an interior point',
  near(roundTrip[0], 321, 1e-6) && near(roundTrip[1], 450, 1e-6), roundTrip);

// ---------------------------------------------------------------------------
// Synthetic card rendered into a photo through a known perspective quad
// ---------------------------------------------------------------------------
const CARD_W = 643;
const CARD_H = 900;
const PATCH = 60;
const BORDER = 40;
const PATCH_COLORS = {
  tl: [220, 30, 30],
  tr: [30, 200, 30],
  br: [30, 60, 220],
  bl: [230, 210, 30]
};

function makeCardRaster() {
  const data = Buffer.alloc(CARD_W * CARD_H * 3);
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      const i = (y * CARD_W + x) * 3;
      const inBorder = x < BORDER || x >= CARD_W - BORDER || y < BORDER || y >= CARD_H - BORDER;
      let c = inBorder ? [245, 245, 245] : [20, 46, 110];
      const ix = x - BORDER;
      const iy = y - BORDER;
      const innerW = CARD_W - 2 * BORDER;
      const innerH = CARD_H - 2 * BORDER;
      if (!inBorder) {
        if (ix < PATCH && iy < PATCH) c = PATCH_COLORS.tl;
        else if (ix >= innerW - PATCH && iy < PATCH) c = PATCH_COLORS.tr;
        else if (ix >= innerW - PATCH && iy >= innerH - PATCH) c = PATCH_COLORS.br;
        else if (ix < PATCH && iy >= innerH - PATCH) c = PATCH_COLORS.bl;
      }
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    }
  }
  return { data: data, width: CARD_W, height: CARD_H, channels: 3 };
}

/** Forward-render the card into a pink-mat photo so `quad` is its outline. */
function renderPhoto(card, quad, photoW, photoH) {
  const data = Buffer.alloc(photoW * photoH * 3);
  const Hpc = cq.computeHomography(
    [quad.tl, quad.tr, quad.br, quad.bl],
    [[0, 0], [card.width - 1, 0], [card.width - 1, card.height - 1], [0, card.height - 1]]
  );
  for (let y = 0; y < photoH; y++) {
    for (let x = 0; x < photoW; x++) {
      const o = (y * photoW + x) * 3;
      const m = cq.applyHomography(Hpc, x, y);
      const cx = Math.round(m[0]);
      const cy = Math.round(m[1]);
      if (cx >= 0 && cy >= 0 && cx < card.width && cy < card.height) {
        const s = (cy * card.width + cx) * 3;
        data[o] = card.data[s]; data[o + 1] = card.data[s + 1]; data[o + 2] = card.data[s + 2];
      } else {
        data[o] = 236; data[o + 1] = 72; data[o + 2] = 153;
      }
    }
  }
  return { data: data, width: photoW, height: photoH, channels: 3 };
}

function meanColor(img, x0, y0, x1, y1) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * img.channels;
      sum[0] += img.data[i]; sum[1] += img.data[i + 1]; sum[2] += img.data[i + 2];
      n += 1;
    }
  }
  return sum.map(function (v) { return v / n; });
}
function colorClose(a, b, tol) {
  return near(a[0], b[0], tol) && near(a[1], b[1], tol) && near(a[2], b[2], tol);
}

const card = makeCardRaster();
const PHOTO_W = 1240;
const PHOTO_H = 1460;
const photo = renderPhoto(card, skewQuad, PHOTO_W, PHOTO_H);
const warped = cq.warpPerspective(photo, cq.orderQuad([skewQuad.tl, skewQuad.tr, skewQuad.br, skewQuad.bl]), CARD_W, CARD_H);
assert('warp output is 643×900', warped.width === 643 && warped.height === 900);

// Corner patches must land in the same corners of the output raster.
const c0 = BORDER + 10;
const c1 = BORDER + PATCH - 10;
const tlPatch = meanColor(warped, c0, c0, c1, c1);
const trPatch = meanColor(warped, CARD_W - c1, c0, CARD_W - c0, c1);
const brPatch = meanColor(warped, CARD_W - c1, CARD_H - c1, CARD_W - c0, CARD_H - c0);
const blPatch = meanColor(warped, c0, CARD_H - c1, c1, CARD_H - c0);
assert('warp puts the TL patch at output TL', colorClose(tlPatch, PATCH_COLORS.tl, 12), tlPatch);
assert('warp puts the TR patch at output TR', colorClose(trPatch, PATCH_COLORS.tr, 12), trPatch);
assert('warp puts the BR patch at output BR', colorClose(brPatch, PATCH_COLORS.br, 12), brPatch);
assert('warp puts the BL patch at output BL', colorClose(blPatch, PATCH_COLORS.bl, 12), blPatch);

// Inner border line position survives the warp (±2px).
function firstDarkFromLeft(img, y) {
  for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * img.channels;
    if (img.data[i] < 128) return x;
  }
  return -1;
}
const innerLeft = firstDarkFromLeft(warped, 450);
assert('warp preserves the 40px inner border (±2px)', near(innerLeft, BORDER, 2), innerLeft);

// A shuffled / landscape point order is normalized before warping.
const shuffled = cq.orderQuad([skewQuad.br, skewQuad.tl, skewQuad.bl, skewQuad.tr]);
assert('orderQuad recovers tl from shuffled points',
  shuffled.tl[0] === skewQuad.tl[0] && shuffled.tl[1] === skewQuad.tl[1], shuffled.tl);
const landscape = cq.orderQuad([[100, 100], [900, 100], [900, 671], [100, 671]]);
assert('orderQuad rotates a landscape card to portrait', landscape.rotatedToPortrait === true);
assert('landscape → portrait: new tl is old bl', landscape.tl[0] === 100 && landscape.tl[1] === 671);

// ---------------------------------------------------------------------------
// Quad validation
// ---------------------------------------------------------------------------
function v(points, w, h) {
  return cq.validateQuad(cq.orderQuad(points), w || 1000, h || 1400);
}
const good = v([[150, 150], [850, 150], [850, 1130], [150, 1130]]);
assert('validate accepts a well-framed 2.5×3.5 card', good.ok === true, good.reasons);

const full = v([[0, 0], [999, 0], [999, 1399], [0, 1399]]);
assert('validate rejects a card that fills the whole photo', full.ok === false &&
  full.reasons.join(' ').indexOf('leave a little background') !== -1, full.reasons);

const tiny = v([[400, 500], [520, 500], [520, 668], [400, 668]]);
assert('validate rejects a card under 15% of the photo', tiny.ok === false &&
  tiny.reasons.join(' ').indexOf('need ≥') !== -1, tiny.reasons);

const square = v([[200, 200], [800, 200], [800, 800], [200, 800]]);
assert('validate rejects a square (not 2.5×3.5)', square.ok === false &&
  square.reasons.join(' ').indexOf('aspect') !== -1, square.reasons);

const outside = v([[-40, 150], [850, 150], [850, 1130], [150, 1130]]);
assert('validate rejects a corner outside the photo', outside.ok === false &&
  outside.reasons.join(' ').indexOf('outside the photo') !== -1, outside.reasons);

const concave = cq.validateQuad(
  { tl: [150, 150], tr: [850, 150], br: [400, 400], bl: [150, 1130] }, 1000, 1400
);
assert('validate rejects a non-convex quad', concave.ok === false &&
  concave.reasons.join(' ').indexOf('not convex') !== -1, concave.reasons);

const small = v([[10, 10], [150, 10], [150, 206], [10, 206]], 180, 230);
assert('validate rejects a side under 200px', small.ok === false &&
  small.reasons.join(' ').indexOf('below 200px') !== -1, small.reasons);

assert('parseCardQuad reads {tl,tr,br,bl} JSON',
  cq.parseCardQuad('{"tl":[1,2],"tr":[3,4],"br":[5,6],"bl":[7,8]}').length === 4);
assert('parseCardQuad reads {x,y} points',
  cq.parseCardQuad({ tl: { x: 1, y: 2 }, tr: { x: 3, y: 4 }, br: { x: 5, y: 6 }, bl: { x: 7, y: 8 } }) != null);
assert('parseCardQuad rejects garbage', cq.parseCardQuad('not json') === null &&
  cq.parseCardQuad({ tl: [1, 2] }) === null);

// ---------------------------------------------------------------------------
// locateCard + 422 route
// ---------------------------------------------------------------------------
async function toJpeg(img) {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } })
    .jpeg({ quality: 92 }).toBuffer();
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-cardbox-'));
  process.env.JUDGE_DATA_DIR = path.join(tmp, 'data');
  process.env.JUDGE_UPLOADS_DIR = path.join(tmp, 'uploads');
  const g = require('../services/grading_engine');
  const silence = console.log;

  const skewJpeg = await toJpeg(photo);
  console.log = function () {};
  const nativeLoc = await g.locateCard(skewJpeg, {
    cardQuad: JSON.stringify(skewQuad), quadImageWidth: PHOTO_W, quadImageHeight: PHOTO_H,
    quadConfidence: 0.97
  });
  console.log = silence;
  assert('locateCard accepts the native quad', nativeLoc.found && nativeLoc.detection.quadSource === 'native',
    nativeLoc.detection);
  assert('locateCard reports card box % of photo',
    nativeLoc.detection.cardBoxPctOfPhoto > 40 && nativeLoc.detection.cardBoxPctOfPhoto < 70,
    nativeLoc.detection.cardBoxPctOfPhoto);
  const refine = nativeLoc.detection.edgeRefinementPx || {};
  assert('edge refinement barely moves an exact quad (≤2px per side)',
    ['left', 'right', 'top', 'bottom'].every(function (k) { return Math.abs(refine[k]) <= 2; }), refine);

  // Native quad scaled for a half-size upload still lands on the card.
  console.log = function () {};
  const halfLoc = await g.locateCard(skewJpeg, {
    cardQuad: JSON.stringify({
      tl: [skewQuad.tl[0] / 2, skewQuad.tl[1] / 2], tr: [skewQuad.tr[0] / 2, skewQuad.tr[1] / 2],
      br: [skewQuad.br[0] / 2, skewQuad.br[1] / 2], bl: [skewQuad.bl[0] / 2, skewQuad.bl[1] / 2]
    }),
    quadImageWidth: PHOTO_W / 2, quadImageHeight: PHOTO_H / 2
  });
  console.log = silence;
  assert('native quad in a different image size is rescaled',
    halfLoc.found && near(halfLoc.detection.quad.tl[0], skewQuad.tl[0], 4), halfLoc.detection.quad);

  // Bad native quad → server detector (skewed card fails its upright box) → not found.
  console.log = function () {};
  const badNative = await g.locateCard(skewJpeg, { cardQuad: '{"tl":[0,0],"tr":[5,0],"br":[5,5],"bl":[0,5]}' });
  console.log = silence;
  assert('an invalid native quad is rejected with reasons',
    Array.isArray(badNative.detection.nativeQuadRejected) && badNative.detection.nativeQuadRejected.length > 0,
    badNative.detection);

  const { app, DB_PATH, FAILED_SCANS_PATH } = require('../server');
  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  async function post(fields, imageBuf) {
    const fd = new FormData();
    fd.append('image', new Blob([imageBuf], { type: 'image/jpeg' }), 'still.jpg');
    Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
    console.log = function () {};
    const res = await fetch(base + '/api/grade', { method: 'POST', body: fd });
    const body = await res.json();
    console.log = silence;
    return { status: res.status, body: body };
  }
  function inventoryCount() {
    if (!fs.existsSync(DB_PATH)) return 0;
    return (JSON.parse(fs.readFileSync(DB_PATH, 'utf8')).inventory || []).length;
  }

  try {
    // Pink paper, no card → 422, nothing saved, failed scan logged.
    const pink = { data: Buffer.alloc(900 * 1200 * 3), width: 900, height: 1200, channels: 3 };
    for (let i = 0; i < 900 * 1200; i++) {
      pink.data[i * 3] = 236; pink.data[i * 3 + 1] = 72; pink.data[i * 3 + 2] = 153;
    }
    const failScanId = '11111111-2222-4333-8444-555555555555';
    const miss = await post({ scanId: failScanId, alignmentCrop: 'true' }, await toJpeg(pink));
    assert('no card → HTTP 422', miss.status === 422, miss.status);
    assert('422 body ok:false + card not found', miss.body.ok === false && miss.body.error === 'card not found');
    assert('422 body carries the reason', typeof miss.body.reason === 'string' && miss.body.reason.length > 0);
    assert('422 body echoes scanId', miss.body.scanId === failScanId);
    assert('422 report has all sub-grades null',
      miss.body.report && miss.body.report.subGrades.centering === null &&
      miss.body.report.subGrades.surface === null && miss.body.report.subGrades.edges === null &&
      miss.body.report.subGrades.corners === null);
    assert('422 saves nothing to inventory', inventoryCount() === 0, inventoryCount());
    const logLines = fs.existsSync(FAILED_SCANS_PATH)
      ? fs.readFileSync(FAILED_SCANS_PATH, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert('422 appends one failed-scans log line', logLines.length === 1, logLines.length);
    const logged = logLines.length ? JSON.parse(logLines[0]) : {};
    assert('failed-scans log has scanId', logged.scanId === failScanId);
    assert('failed-scans log has timestamp', typeof logged.timestamp === 'string' && !isNaN(Date.parse(logged.timestamp)));
    assert('failed-scans log has reason', typeof logged.reason === 'string' && logged.reason.length > 0);
    assert('failed-scans log has diagnostics with quadSource none',
      logged.diagnostics && logged.diagnostics.quadSource === 'none');

    // Real card + native quad → 200 and saved (the success path still persists).
    const okScanId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const hit = await post({
      scanId: okScanId,
      alignmentCrop: 'true',
      cardQuad: JSON.stringify(skewQuad),
      quadImageWidth: String(PHOTO_W),
      quadImageHeight: String(PHOTO_H),
      quadConfidence: '0.97'
    }, skewJpeg);
    assert('card found → HTTP 200', hit.status === 200, hit.status);
    const rep = hit.body.item && hit.body.item.gradingReport;
    assert('200 report quadSource native', rep && rep.cardDetection && rep.cardDetection.quadSource === 'native');
    assert('200 report measured centering on the warp', rep && typeof rep.subGrades.centering === 'number',
      rep && rep.centeringDiagnostics && rep.centeringDiagnostics.borderReliability);
    const lr = rep && rep.centeringMetrics && rep.centeringMetrics.leftRightRatio;
    const tb = rep && rep.centeringMetrics && rep.centeringMetrics.topBottomRatio;
    assert('skewed symmetric card measures ~50/50 L/R through the warp (±2)',
      lr && near(lr.left, 50, 2), lr);
    assert('skewed symmetric card measures ~50/50 T/B through the warp (±2)',
      tb && near(tb.top, 50, 2), tb);
    assert('200 report CRN is null', rep && rep.subGrades.corners === null);
    assert('200 report SUR/EDG not measured (detector gate)',
      rep && rep.subGrades.surface === null && rep.subGrades.edges === null && rep.finalScore === null);
    assert('200 saves exactly one inventory item', inventoryCount() === 1, inventoryCount());
    const logAfter = fs.readFileSync(FAILED_SCANS_PATH, 'utf8').trim().split('\n').filter(Boolean);
    assert('success does not touch failed-scans log', logAfter.length === 1, logAfter.length);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }

  if (failures) {
    console.error(failures + ' card-box check(s) failed.');
    process.exit(1);
  }
  console.log('All card-box checks passed.');
  process.exit(0);
}

run().catch(function (err) {
  console.error('FAIL card-box run threw', err);
  process.exit(1);
});
