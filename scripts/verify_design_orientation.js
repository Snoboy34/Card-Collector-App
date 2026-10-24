/**
 * scripts/verify_design_orientation.js
 *
 * Edge names follow the printed design. A mixed-case word has a straight
 * baseline and ascenders on one side of the x-height. That side is the top.
 * The six Karros fronts from 28 Sep 2026 are 180-degree photos; their edges
 * must come out in design order, not swapped. An all-caps nameplate does
 * not vote. A design that votes both ways is a conflict.
 *
 * Run: node scripts/verify_design_orientation.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { designOrientation } = require('../services/design_orientation');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else {
    failures += 1;
    console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// A hollow letter so the ink is a stroke, not a solid block.
function stampLetter(grey, W, x, top, height) {
  const bw = 11;
  const bh = height;
  for (let yy = top; yy < top + bh; yy++) {
    for (let xx = x; xx < x + bw; xx++) {
      const frame = xx < x + 3 || yy < top + 3 || yy >= top + bh - 3;
      if (frame) grey[yy * W + xx] = 20;
    }
  }
}

function blank() {
  const W = 643;
  const H = 900;
  const grey = new Uint8Array(W * H);
  grey.fill(210);
  return { grey: grey, W: W, H: H };
}

// side 'up': ascenders stick out above a shared bottom.
// side 'down': ascenders stick out below a shared top.
function writeWord(img, x0, baseline, side) {
  const xHeight = 16;
  const extra = 7;
  for (let i = 0; i < 9; i++) {
    const tall = i === 0 || i === 4;
    const h = xHeight + (tall ? extra : 0);
    const top = side === 'up' ? baseline - h : baseline;
    stampLetter(img.grey, img.W, x0 + i * 16, top, h);
  }
}

function runSynthetic() {
  const up = blank();
  writeWord(up, 240, 830, 'up');
  const upR = designOrientation(up.grey, up.W, up.H);
  assert('upright mixed-case word is upright', upR.orientation === 'upright' && upR.up === 1 && upR.down === 0, upR);

  const down = blank();
  writeWord(down, 240, 48, 'down');
  const downR = designOrientation(down.grey, down.W, down.H);
  assert('upside-down mixed-case word is 180', downR.orientation === '180' && downR.down === 1 && downR.up === 0, downR);

  const caps = blank();
  for (let i = 0; i < 9; i++) stampLetter(caps.grey, caps.W, 240 + i * 16, 80, 16);
  const capsR = designOrientation(caps.grey, caps.W, caps.H);
  assert('all-caps word does not vote', capsR.orientation === 'unknown' && capsR.up === 0 && capsR.down === 0, capsR);

  const both = blank();
  writeWord(both, 80, 830, 'up');
  writeWord(both, 80, 48, 'down');
  const bothR = designOrientation(both.grey, both.W, both.H);
  assert('both directions are a conflict', bothR.orientation === 'conflict' && bothR.up > 0 && bothR.down > 0, bothR);
}

// The 28 Sep Karros fronts. Image-left on these is the card's right.
const UPSIDE_DOWN = ['B49E95E4', 'F2FF06C6', '7E6208CC', '25E5F141', 'EF571543', '60DF47B1'];
const UPRIGHT_KARROS = ['CD4A2598', 'F7AE4717'];
const UPRIGHT_OTHER = ['407CED26', '0867D411'];

function scanRoot() {
  if (process.env.JUDGE_DATA_DIR && process.env.JUDGE_UPLOADS_DIR &&
      fs.existsSync(path.join(process.env.JUDGE_DATA_DIR, 'database.json'))) {
    return { data: process.env.JUDGE_DATA_DIR, uploads: process.env.JUDGE_UPLOADS_DIR };
  }
  const data = '/tmp/scan-data-repo/data';
  const uploads = '/tmp/scan-data-repo/uploads';
  if (fs.existsSync(path.join(data, 'database.json'))) return { data: data, uploads: uploads };
  return null;
}

function quadOptions(report) {
  const det = report && report.cardDetection;
  if (!det || det.quadSource === 'server' || det.quadSource === 'none') return {};
  const quad = det.rawQuad || det.nativeQuadRaw || det.quad;
  if (!quad) return {};
  return {
    cardQuad: JSON.stringify(quad),
    quadImageWidth: det.photoWidth,
    quadImageHeight: det.photoHeight,
    quadConfidence: det.nativeQuadConfidence
  };
}

async function gradeQuiet(engine, buffer, opts) {
  const log = console.log;
  const warn = console.warn;
  console.log = function () {};
  console.warn = function () {};
  try {
    return await engine.gradeBuffer(buffer, Object.assign({ alignmentCrop: true, debug: false }, opts));
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

async function runScans() {
  const root = scanRoot();
  if (!root) {
    console.log('SKIP 28 Sep Karros scans (no scan repo)');
    return;
  }
  const db = JSON.parse(fs.readFileSync(path.join(root.data, 'database.json'), 'utf8'));
  const engine = require('../services/grading_engine');
  async function gradeId(id) {
    const item = db.inventory.find(function (it) { return String(it.scanId).toUpperCase().indexOf(id) === 0; });
    if (!item) return null;
    const file = path.join(root.uploads, path.basename(item.imagePath || ''));
    if (!fs.existsSync(file)) return null;
    const report = await gradeQuiet(engine, fs.readFileSync(file), quadOptions(item.gradingReport || {}));
    const det = report.cardDetection || {};
    const mm = (report.centeringMetrics && report.centeringMetrics.borderWidthsMm) || {};
    return { orientation: det.designOrientation, mm: mm };
  }
  for (const id of UPSIDE_DOWN) {
    const g = await gradeId(id);
    assert(id + ' is detected as a 180-degree photo', g && g.orientation === '180', g && g.orientation);
    assert(id + ' names the long edge as the card left and the long edge as the card bottom',
      g && g.mm.left > g.mm.right + 0.4 && g.mm.bottom > g.mm.top + 0.3, g && g.mm);
  }
  for (const id of UPRIGHT_KARROS) {
    const g = await gradeId(id);
    assert(id + ' is not rotated', g && g.orientation !== '180', g && g.orientation);
    assert(id + ' keeps left and bottom as the long edges',
      g && g.mm.left > g.mm.right + 0.4 && g.mm.bottom > g.mm.top + 0.3, g && g.mm);
  }
  for (const id of UPRIGHT_OTHER) {
    const g = await gradeId(id);
    assert(id + ' is not called upside down', g && g.orientation !== '180', g && g.orientation);
    assert(id + ' keeps the card top as the wider border',
      g && g.mm.top != null && g.mm.bottom != null && g.mm.top > g.mm.bottom, g && g.mm);
  }
}

(async function () {
  runSynthetic();
  await runScans();
  if (failures) {
    console.error(failures + ' failed');
    process.exit(1);
  }
})().catch(function (err) {
  console.error('FAIL orientation suite', err && err.stack ? err.stack : err);
  process.exit(1);
});
