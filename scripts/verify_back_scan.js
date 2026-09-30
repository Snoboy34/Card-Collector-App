/**
 * scripts/verify_back_scan.js
 * A back is a second capture of the same card. Front grading is unchanged.
 * The back keeps the measured borders, drops the centering sub-grade, and
 * records a copyright year plus the left-right flip map only when the
 * copyright line is in the bottom half of the OCR text.
 * Run: node scripts/verify_back_scan.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const grading = require('../services/grading_engine');
const backScan = require('../services/back_scan');
const deck = require('../services/test_deck');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail).slice(0, 800) : ''); }
}

function gradeCore(report) {
  const m = report.centeringMetrics || {};
  return JSON.stringify({
    lr: m.leftRightRatio || null,
    tb: m.topBottomRatio || null,
    mm: m.borderWidthsMm || null,
    detected: m.detected,
    low: m.lowConfidenceEdges || null,
    cen: report.subGrades ? report.subGrades.centering : null,
    finalScore: report.finalScore == null ? null : report.finalScore,
    side: report.side || null
  });
}

async function cardJpeg() {
  const W = 643;
  const H = 900;
  const PAD = 80;
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inB = x < 40 || x >= W - 30 || y < 30 || y >= H - 35;
      const v = inB ? [246, 246, 244] : [40, 50, 70];
      const i = (y * W + x) * 3;
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2];
    }
  }
  const jpeg = await sharp(d, { raw: { width: W, height: H, channels: 3 } })
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 236, g: 72, b: 153 } })
    .jpeg({ quality: 92 }).toBuffer();
  const quad = { tl: [PAD, PAD], tr: [PAD + W - 1, PAD], br: [PAD + W - 1, PAD + H - 1], bl: [PAD, PAD + H - 1] };
  return { jpeg: jpeg, quad: JSON.stringify(quad), width: W + 2 * PAD, height: H + 2 * PAD };
}

async function run() {
  assert('flip instruction names the left-to-right turn',
    backScan.FLIP_INSTRUCTION === 'Turn the card over left to right. Keep the same edge at the top of the frame. Leave background showing on all four sides.');

  const upright = backScan.inspectLines(['TOPPS', 'player bio', '© 1991 The Topps Company, Inc.']);
  assert('bottom copyright year is kept', upright.copyrightYear === 1991 && /1991/.test(upright.copyrightLine), upright);
  assert('upright back applies the left-right map', upright.upsideDown === false && upright.applied === true &&
    upright.imageToFront.left === 'right' && upright.imageToFront.right === 'left' &&
    upright.imageToFront.top === 'top' && upright.imageToFront.bottom === 'bottom', upright);

  const flipped = backScan.inspectLines(['© 2023 Panini America', 'player bio', 'stats line']);
  assert('copyright in the top half flags upside down and does not map edges',
    flipped.copyrightYear === 2023 && flipped.upsideDown === true && flipped.applied === false &&
    flipped.imageToFront === null, flipped);

  const unknown = backScan.inspectLines(['player name', 'no year here']);
  assert('no copyright line leaves the year blank and the map off',
    unknown.copyrightYear === null && unknown.upsideDown === null && unknown.applied === false, unknown);

  const only = backScan.inspectLines(['© 1989 Score']);
  assert('a single copyright line stores the year and does not guess orientation',
    only.copyrightYear === 1989 && only.upsideDown === null && only.applied === false, only);

  const jpeg = await cardJpeg();
  const quadOpts = {
    alignmentCrop: true,
    cardQuad: jpeg.quad,
    quadImageWidth: jpeg.width,
    quadImageHeight: jpeg.height
  };
  const log = console.log;
  console.log = function () {};
  let front;
  let asFront;
  let back;
  try {
    front = await grading.gradeBuffer(jpeg.jpeg, quadOpts);
    asFront = await grading.gradeBuffer(jpeg.jpeg, Object.assign({ side: 'front' }, quadOpts));
    back = await grading.gradeBuffer(jpeg.jpeg, Object.assign({ side: 'back' }, quadOpts));
  } finally { console.log = log; }

  assert('side=front matches a grade with no side', JSON.stringify(front) === JSON.stringify(asFront));
  assert('front report has no side field', front.side == null, front.side);
  assert('back centering sub-grade is null', back.subGrades && back.subGrades.centering === null && back.centering === null, back.subGrades);
  assert('back does not receive a final score', back.finalScore == null && back.side === 'back', back.finalScore);
  assert('back border measurement matches the front',
    JSON.stringify(back.centeringMetrics && back.centeringMetrics.borderWidthsMm) ===
    JSON.stringify(front.centeringMetrics && front.centeringMetrics.borderWidthsMm) &&
    JSON.stringify(back.centeringMetrics && back.centeringMetrics.leftRightRatio) ===
    JSON.stringify(front.centeringMetrics && front.centeringMetrics.leftRightRatio),
    { front: gradeCore(front), back: gradeCore(back) });
  assert('front centering sub-grade is still present',
    front.subGrades && typeof front.subGrades.centering === 'number', front.subGrades);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-back-'));
  process.env.JUDGE_DATA_DIR = path.join(tmp, 'data');
  process.env.JUDGE_UPLOADS_DIR = path.join(tmp, 'uploads');
  process.env.JUDGE_SCANS_DIR = path.join(tmp, 'scans');
  const { app } = require('../server');
  const server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const warn = console.warn;
  async function post(fields) {
    const fd = new FormData();
    fd.append('image', new Blob([jpeg.jpeg], { type: 'image/jpeg' }), 'still.jpg');
    fd.append('alignmentCrop', 'true');
    fd.append('cardQuad', jpeg.quad);
    fd.append('quadImageWidth', String(jpeg.width));
    fd.append('quadImageHeight', String(jpeg.height));
    Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
    console.log = function () {};
    console.warn = function () {};
    try {
      const r = await fetch(base + '/api/grade', { method: 'POST', body: fd });
      return { status: r.status, body: await r.json() };
    } finally { console.log = log; console.warn = warn; }
  }
  try {
    const frontScan = 'cccccccc-3333-4000-8000-000000000003';
    const frontPost = await post({ side: 'front', scanId: frontScan, pairId: frontScan, deckId: 'TD-11' });
    const frontId = frontPost.body.item && frontPost.body.item.scanId;
    assert('front upload graded', frontPost.status === 200 && frontId && frontPost.body.item.side === 'front' &&
      frontPost.body.item.gradingReport.subGrades.centering != null, frontPost.body);
    const backPost = await post({
      side: 'back',
      pairId: frontId,
      deckId: 'TD-11',
      ocrLines: JSON.stringify(['TOPPS', '© 1991 The Topps Company, Inc.'])
    });
    const item = backPost.body.item;
    assert('back upload stores the pair and the year', backPost.status === 200 && item && item.side === 'back' &&
      item.pairId === frontId && item.gradingReport.copyrightYear === 1991 &&
      item.gradingReport.edgeMap.applied === true && item.gradingReport.subGrades.centering === null, item);
    const bad = await post({
      side: 'back',
      pairId: frontId,
      deckId: 'TD-11',
      ocrLines: JSON.stringify(['© 2020 Panini', 'bio'])
    });
    assert('upside-down back is flagged and not mapped', bad.status === 200 &&
      bad.body.item.gradingReport.edgeMap.upsideDown === true &&
      bad.body.item.gradingReport.edgeMap.applied === false, bad.body.item && bad.body.item.gradingReport.edgeMap);

    const store = deck.createStore(process.env.JUDGE_DATA_DIR);
    const report = await require('./deck_report').buildDeckReport({
      dataDir: process.env.JUDGE_DATA_DIR,
      uploadsDir: process.env.JUDGE_UPLOADS_DIR
    });
    const row = report.rows.find(function (r) { return r.deckId === 'TD-11'; });
    assert('deck report latest stays the front when a later back exists',
      row && row.latest && row.latest.scanId === frontId && row.back && row.back.copyrightYear === 2020, row);
    assert('deck report prints the upside-down flag', /back .*upside down, edge map not applied/.test(report.text) &&
      /copyright 2020/.test(report.text), report.text);
    const labels = store.loadLabels().scans;
    assert('front label keeps side front', labels[frontId] && labels[frontId].side === 'front' && labels[frontId].pairId === frontId, labels[frontId]);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures) { console.error(failures + ' back-scan check(s) failed.'); process.exit(1); }
  console.log('All back-scan checks passed.');
}

run().catch(function (err) { console.error('FAIL back-scan run threw', err); process.exit(1); });
