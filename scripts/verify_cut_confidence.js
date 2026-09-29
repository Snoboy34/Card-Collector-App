/**
 * scripts/verify_cut_confidence.js
 * Cut-edge confidence: when refineQuadToCut sees a second step ≥60% of the
 * chosen one within 3 px (643-equivalent), that edge is marked low-confidence
 * in the grade output and the deck report. It is a flag only: the chosen cut,
 * widths, CEN, and final score are computed exactly as before.
 * Run: node scripts/verify_cut_confidence.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../services/grading_engine');
const cq = require('../services/card_quad');
const deck = require('../services/test_deck');
const { buildDeckReport } = require('./deck_report');
const { capture } = require('./synthetic_capture');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function grade(cap) {
  const log = console.log;
  console.log = function () {};
  try {
    return await g.gradeBuffer(cap.jpeg, {
      alignmentCrop: true, cardQuad: cap.cardQuad, quadImageWidth: cap.photoWidth, quadImageHeight: cap.photoHeight
    });
  } finally { console.log = log; }
}

function unitProfileCase() {
  // One output row per step pattern, refined on a tiny synthetic raster.
  const W = 200;
  const H = 280;
  const data = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 60;
      if (x >= 20 && x < 180 && y >= 20 && y < 260) v = 240;
      // Right edge: a 140-grey lip 3 px wide just outside the cut.
      if (x >= 180 && x < 183 && y >= 20 && y < 260) v = 150;
      data[y * W + x] = v;
    }
  }
  const src = { data: data, width: W, height: H, channels: 1 };
  const quad = { tl: [20, 20], tr: [179, 20], br: [179, 259], bl: [20, 259] };
  return cq.refineQuadToCut(src, quad, 160, 240);
}

async function run() {
  const u = unitProfileCase();
  assert('unit: clean left edge has no strong runner-up', u.cutSteps.left.runnerUpRatio < 0.3, u.cutSteps.left);
  assert('unit: right lip → runner-up ≥ 0.6 at 3 px', u.cutSteps.right.runnerUpRatio >= 0.6 &&
    Math.abs(u.cutSteps.right.runnerUpOffsetPx) === 3, u.cutSteps.right);

  const clean = await grade(await capture(101));
  const cleanConf = clean.cardDetection.edgeCutConfidence;
  assert('clean card: every edge has a cut-confidence entry', cleanConf &&
    ['left', 'right', 'top', 'bottom'].every(function (e) { return typeof cleanConf[e].lowConfidence === 'boolean'; }), cleanConf);
  assert('clean card: no low-confidence edges', clean.centeringMetrics.lowConfidenceEdges.length === 0, cleanConf);

  const lipCap = await capture(101, { outsideBand: { edge: 'right', mm: 0.25, color: [200, 200, 200] } });
  const lip = await grade(lipCap);
  const lipConf = lip.cardDetection.edgeCutConfidence;
  console.log('lip 0.25 mm right: ' + JSON.stringify(lipConf.right));
  assert('0.25 mm lip outside the right cut → right is low-confidence',
    lip.centeringMetrics.lowConfidenceEdges.length === 1 && lip.centeringMetrics.lowConfidenceEdges[0] === 'right', lipConf);
  assert('runner-up ≥ 60% and within 3 px', lipConf.right.runnerUpRatio >= 0.6 && Math.abs(lipConf.right.runnerUpOffsetPx) <= 3,
    lipConf.right);
  assert('cardDetection.lowConfidenceEdges matches centeringMetrics',
    JSON.stringify(lip.cardDetection.lowConfidenceEdges) === JSON.stringify(lip.centeringMetrics.lowConfidenceEdges));
  assert('edge flag says which edge and why', (lip.centeringDiagnostics.edgeFlags || []).some(function (f) {
    return /^right: cut edge low confidence/.test(f);
  }), lip.centeringDiagnostics.edgeFlags);
  assert('flag only: centering still measured and scored', lip.centeringMetrics.detected !== false &&
    lip.subGrades.centering != null && lip.centeringMetrics.borderWidthsMm.right != null, lip.subGrades);
  const expectCen = g.scoreCenteringPhase(lip.centeringMetrics.leftRightRatio, lip.centeringMetrics.topBottomRatio).score;
  assert('flag only: CEN is the normal table lookup on the measured ratios', lip.subGrades.centering === expectCen,
    { cen: lip.subGrades.centering, expect: expectCen });
  assert('flag only: other edges unchanged vs the clean capture (< 0.02 mm)', ['left', 'top', 'bottom'].every(function (e) {
    return Math.abs(lip.centeringMetrics.borderWidthsMm[e] - clean.centeringMetrics.borderWidthsMm[e]) < 0.02;
  }), { lip: lip.centeringMetrics.borderWidthsMm, clean: clean.centeringMetrics.borderWidthsMm });

  const wide = await grade(await capture(101, { outsideBand: { edge: 'right', mm: 0.6, color: [200, 200, 200] } }));
  console.log('band 0.6 mm right: ' + JSON.stringify(wide.cardDetection.edgeCutConfidence.right));
  assert('0.6 mm band (second step > 3 px away) → not low-confidence', wide.centeringMetrics.lowConfidenceEdges.length === 0,
    wide.cardDetection.edgeCutConfidence.right);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-conf-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const store = deck.createStore(dataDir);
  store.upsertCard('TD-01', { category: 'white-modern' });
  store.upsertCard('TD-02', { category: 'white-modern' });
  store.labelScan('scan-lip', { deckId: 'TD-01' });
  store.labelScan('scan-clean', { deckId: 'TD-02' });
  fs.writeFileSync(path.join(dataDir, 'database.json'), JSON.stringify({ inventory: [
    { scanId: 'scan-lip', createdAt: '2026-09-29T01:00:00Z', gradingReport: lip },
    { scanId: 'scan-clean', createdAt: '2026-09-29T01:01:00Z', gradingReport: clean }
  ] }));
  const rep = await buildDeckReport({ dataDir: dataDir });
  const td1 = rep.text.split('\n').find(function (l) { return /^\s+latest/.test(l) && /low-confidence cut/.test(l); });
  assert('deck report marks TD-01 latest as low-confidence cut: right', td1 && /low-confidence cut: right/.test(td1), rep.text);
  assert('deck report summary lists TD-01 only', rep.lowConfidenceCut.length === 1 && rep.lowConfidenceCut[0].deckId === 'TD-01' &&
    rep.lowConfidenceCut[0].edges[0] === 'right', rep.lowConfidenceCut);
  assert('deck report still counts TD-01 as measured (PASS)', rep.rows.find(function (r) { return r.deckId === 'TD-01'; }).latest.pass === true);
  fs.rmSync(root, { recursive: true, force: true });

  if (failures) { console.error(failures + ' cut-confidence check(s) failed.'); process.exit(1); }
  console.log('All cut-confidence checks passed.');
}

run().catch(function (err) { console.error('FAIL cut-confidence run threw', err); process.exit(1); });
