/**
 * scripts/verify_gate.js
 * Checks scripts/gate.js. Data steps only (--skip-suites), so the gate can
 * run this file as one of its suites without recursing:
 *   - a synthetic data dir with two deck scans → compare_finders and deck_report PASS.
 *     td_deck FAIL: those borders are not the answer-key millimetres.
 *   - a candidate that loses centering → compare_finders and deck_report FAIL
 *   - no data → SKIP (gate passes), or FAIL with --require-data
 *   - suite discovery; CLI exit codes
 * Run: node scripts/verify_gate.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const g = require('../services/grading_engine');
const deck = require('../services/test_deck');
const { capture } = require('./synthetic_capture');
const { gate, listSuites, tdSideFailure } = require('./gate');
const { resultFromReport } = require('./deck_report');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function quietGrade(buf, opts) {
  const log = console.log;
  console.log = function () {};
  try { return await g.gradeBuffer(buf, opts); } finally { console.log = log; }
}

async function makeData(root) {
  const dataDir = path.join(root, 'data');
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });
  const store = deck.createStore(dataDir);
  const inventory = [];
  for (let i = 0; i < 2; i++) {
    const cap = await capture(700 + i);
    const scanId = 'gate000' + i + '-0000-4000-8000-000000000000';
    fs.writeFileSync(path.join(uploads, scanId + '.jpg'), cap.jpeg);
    const report = await quietGrade(cap.jpeg, {
      alignmentCrop: true, cardQuad: cap.cardQuad, quadImageWidth: cap.photoWidth, quadImageHeight: cap.photoHeight
    });
    inventory.push({ scanId: scanId, createdAt: '2026-09-29T02:0' + i + ':00Z', imagePath: 'uploads/' + scanId + '.jpg',
      engine: { version: g.ENGINE_VERSION }, gradingReport: report });
    store.upsertCard('TD-0' + (i + 1), { category: 'white-modern' });
    store.labelScan(scanId, { deckId: 'TD-0' + (i + 1) });
  }
  fs.writeFileSync(path.join(dataDir, 'database.json'), JSON.stringify({ inventory: inventory }));
  return { dataDir: dataDir, uploadsDir: uploads };
}

function makeBrokenCandidate(root) {
  const dir = path.join(root, 'broken');
  fs.mkdirSync(path.join(dir, 'services'), { recursive: true });
  const real = JSON.stringify(path.join(ROOT, 'services', 'grading_engine.js'));
  fs.writeFileSync(path.join(dir, 'services', 'grading_engine.js'),
    "const real = require(" + real + ");\n" +
    "module.exports = Object.assign({}, real, { gradeBuffer: async function (b, o) {\n" +
    "  const r = await real.gradeBuffer(b, o);\n" +
    "  r.centeringMetrics = Object.assign({}, r.centeringMetrics, { leftRightRatio: null, topBottomRatio: null });\n" +
    "  return r;\n} });\n");
  return dir;
}

function step(r, name) { return r.steps.find(function (s) { return s.step === name; }); }

async function run() {
  const suites = listSuites();
  assert('gate discovers verify suites, including cut confidence', suites.indexOf('verify_cut_confidence.js') !== -1 &&
    suites.indexOf('verify_judge_math.js') !== -1, suites);
  assert('gate runs this test too (it uses --skip-suites, so no recursion)', suites.indexOf('verify_gate.js') !== -1);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const d = await makeData(root);

  const ok = await gate({ skipSuites: true, dataDir: d.dataDir, uploadsDir: d.uploadsDir });
  console.log(ok.text);
  assert('compare_finders PASS with identical same-engine runs', step(ok, 'compare_finders').status === 'PASS' &&
    /runs identical/.test(step(ok, 'compare_finders').detail), step(ok, 'compare_finders'));
  assert('deck_report PASS, 2 of 2 kept', step(ok, 'deck_report').status === 'PASS' &&
    /candidate 2 of 2/.test(step(ok, 'deck_report').detail), step(ok, 'deck_report'));
  assert('td_deck FAIL when synthetic borders are not the answer-key millimetres', step(ok, 'td_deck').status === 'FAIL' &&
    /TD-01 front /.test(step(ok, 'td_deck').failures.join(' ')) &&
    /vs key /.test(step(ok, 'td_deck').failures.join(' ')) &&
    /TD-02 front /.test(step(ok, 'td_deck').failures.join(' ')), step(ok, 'td_deck'));

  const broken = makeBrokenCandidate(root);
  const bad = await gate({ skipSuites: true, dataDir: d.dataDir, uploadsDir: d.uploadsDir, candidateDir: broken, currentDir: ROOT });
  console.log(bad.text);
  assert('candidate that loses centering → GATE FAIL', bad.ok === false);
  assert('compare_finders FAIL names the drop', step(bad, 'compare_finders').status === 'FAIL' &&
    /candidate measured 0 of 2/.test(step(bad, 'compare_finders').failures.join(' ')), step(bad, 'compare_finders'));
  assert('deck_report FAIL lists lost deck cards', step(bad, 'deck_report').status === 'FAIL' &&
    /TD-01, TD-02/.test(step(bad, 'deck_report').failures.join(' ')), step(bad, 'deck_report'));

  const empty = path.join(root, 'empty', 'data');
  fs.mkdirSync(empty, { recursive: true });
  const skip = await gate({ skipSuites: true, dataDir: empty });
  assert('no data → SKIP, gate still passes', skip.ok === true && step(skip, 'compare_finders').status === 'SKIP' &&
    step(skip, 'deck_report').status === 'SKIP' && step(skip, 'td_deck').status === 'SKIP', skip.steps);

  // The expectation rules are checked on a graded result, not on a stored
  // report the current engine did not produce. td_deck scores the re-grade.
  const measured = resultFromReport({
    centeringMetrics: { leftRightRatio: { left: 55, right: 45 }, topBottomRatio: { top: 52, bottom: 48 } },
    subGrades: { centering: 9 }
  });
  const undetectable = resultFromReport({ centeringMetrics: {}, subGrades: { centering: null }, incomplete: true, centeringUndetected: true });
  const withheld = resultFromReport({
    centeringMetrics: {
      leftRightRatio: { left: 55, right: 45 },
      topBottomRatio: { top: 52, bottom: 48 },
      borderVoteLowConfidenceEdges: ['left']
    },
    subGrades: { centering: null },
    incomplete: true
  });
  const forced = resultFromReport({
    centeringMetrics: {
      leftRightRatio: { left: 55, right: 45 },
      topBottomRatio: { top: 52, bottom: 48 },
      borderVoteLowConfidenceEdges: ['left']
    },
    subGrades: { centering: 9 }
  });
  const tdFront = tdSideFailure('TD-05', 'front', 'undetectable', measured);
  const tdBack = tdSideFailure('TD-05', 'back', 'undetectable', measured);
  assert('td_deck rule FAIL when a borderless card measures', tdFront && tdBack &&
    /TD-05 front expected undetectable/.test(tdFront) &&
    /TD-05 back expected undetectable/.test(tdBack), [tdFront, tdBack]);
  assert('td_deck rule PASS when TD-05 front and back stay undetectable',
    tdSideFailure('TD-05', 'front', 'undetectable', undetectable) == null &&
    tdSideFailure('TD-05', 'back', 'undetectable', undetectable) == null);
  assert('td_deck rule PASS when TD-02 front is withheld on a low-confidence edge',
    tdSideFailure('TD-02', 'front', ['measured', 'withheld'], withheld) == null, withheld);
  const wBad = tdSideFailure('TD-02', 'front', ['measured', 'withheld'], forced);
  assert('td_deck rule FAIL when a low-confidence TD-02 front still has a centering number', wBad &&
    /CEN 9 on a low-confidence edge \(left\)/.test(wBad), wBad);

  const wrongBottom = {
    measured: true, status: 'offcenter', cen: 6, lr: 52, tb: 70,
    mm: { top: 3.41, bottom: 1.152, left: null, right: null }
  };
  const wrongLine = tdSideFailure('TD-04', 'front', 'offcenter', wrongBottom);
  assert('td_deck scores a published edge against the answer key, not the offcenter label', wrongLine &&
    wrongLine === 'TD-04 front bottom 1.152 mm vs key 1.416 (±0.1)', wrongLine);
  const withheldBottom = {
    measured: false, status: 'undetectable', cen: null, lr: null, tb: null,
    mm: { top: null, bottom: null, left: null, right: null }
  };
  assert('td_deck accepts a withheld edge when the published reading was not the key',
    tdSideFailure('TD-04', 'front', 'offcenter', withheldBottom) == null);
  const onTolerance = {
    measured: true, status: 'measured', cen: 8, lr: 50, tb: 55,
    mm: { top: 3.41, bottom: 1.516, left: null, right: null }
  };
  assert('td_deck accepts a solid edge 0.1 mm from the key',
    tdSideFailure('TD-04', 'front', 'offcenter', onTolerance) == null);
  const pastTolerance = {
    measured: true, status: 'measured', cen: 8, lr: 50, tb: 55,
    mm: { top: 3.41, bottom: 1.517, left: null, right: null }
  };
  const pastLine = tdSideFailure('TD-04', 'front', 'offcenter', pastTolerance);
  assert('td_deck rejects a solid edge past 0.1 mm', pastLine &&
    /bottom 1.517 mm vs key 1.416 \(±0.1\)/.test(pastLine), pastLine);
  const fineOk = {
    measured: true, status: 'measured', cen: 9, lr: 50, tb: 50,
    mm: { top: 3.535, bottom: null, left: null, right: null }
  };
  assert('td_deck accepts a fine-print edge 0.2 mm from the key',
    tdSideFailure('TD-02', 'front', 'measured', fineOk) == null);
  const fineFar = {
    measured: true, status: 'measured', cen: 9, lr: 50, tb: 50,
    mm: { top: 3.556, bottom: null, left: null, right: null }
  };
  const fineLine = tdSideFailure('TD-02', 'front', 'measured', fineFar);
  assert('td_deck rejects a fine-print edge past 0.2 mm', fineLine &&
    /top 3.556 mm vs key 3.345 \(±0.2\)/.test(fineLine), fineLine);
  const solidFar = {
    measured: true, status: 'measured', cen: 9, lr: 50, tb: 50,
    mm: { top: null, bottom: 4.049, left: null, right: null }
  };
  const solidLine = tdSideFailure('TD-02', 'front', 'measured', solidFar);
  assert('td_deck keeps a solid edge at 0.1 mm when another edge on the card is fine-print', solidLine &&
    /bottom 4.049 mm vs key 3.899 \(±0.1\)/.test(solidLine), solidLine);
  const underThirty = Object.assign({}, pastTolerance, { pxPerMm: 20 });
  assert('td_deck accepts a solid edge inside 0.2 mm when the capture is under 30 px/mm',
    tdSideFailure('TD-04', 'front', 'offcenter', underThirty) == null, underThirty);
  const underThirtyFar = {
    measured: true, status: 'measured', cen: 8, lr: 50, tb: 55, pxPerMm: 20,
    mm: { top: 3.41, bottom: 1.617, left: null, right: null }
  };
  const underThirtyLine = tdSideFailure('TD-04', 'front', 'offcenter', underThirtyFar);
  assert('td_deck rejects a solid edge past 0.2 mm on a 20 px/mm capture', underThirtyLine &&
    /bottom 1.617 mm vs key 1.416 \(±0.2\)/.test(underThirtyLine), underThirtyLine);
  const tooCoarse = {
    measured: true, status: 'measured', cen: 6, lr: 52, tb: 70, pxPerMm: 10,
    mm: { top: null, bottom: 1.152, left: null, right: null }
  };
  assert('td_deck does not score an edge the resolution withholds',
    tdSideFailure('TD-04', 'front', 'offcenter', tooCoarse) == null, tooCoarse);
  const fineAtFull = Object.assign({}, fineFar, { pxPerMm: 40 });
  const fineAtFullLine = tdSideFailure('TD-02', 'front', 'measured', fineAtFull);
  assert('td_deck keeps a fine-print edge at 0.2 mm when the capture supports 0.1', fineAtFullLine &&
    /top 3.556 mm vs key 3.345 \(±0.2\)/.test(fineAtFullLine), fineAtFullLine);
  assert('td_deck still uses the label on a back', 
    /TD-04 back expected measured/.test(tdSideFailure('TD-04', 'back', 'measured', withheldBottom) || ''));

  const staleRoot = path.join(root, 'stale');
  const staleData = path.join(staleRoot, 'data');
  const staleUploads = path.join(staleRoot, 'uploads');
  fs.cpSync(d.dataDir, staleData, { recursive: true });
  fs.cpSync(d.uploadsDir, staleUploads, { recursive: true });
  const staleDb = JSON.parse(fs.readFileSync(path.join(staleData, 'database.json'), 'utf8'));
  staleDb.inventory.forEach(function (item) {
    const det = item.gradingReport && item.gradingReport.cardDetection;
    item.gradingReport = {
      incomplete: true, centeringUndetected: true, centeringMetrics: {},
      subGrades: { centering: null }, cardDetection: det
    };
    item.engine = { version: 'old-engine' };
  });
  fs.writeFileSync(path.join(staleData, 'database.json'), JSON.stringify(staleDb));
  const stale = await gate({ skipSuites: true, dataDir: staleData, uploadsDir: staleUploads });
  console.log(stale.text);
  assert('td_deck follows the re-grade when the stored report is from an old engine',
    step(stale, 'td_deck').status === 'FAIL' &&
    /vs key /.test(step(stale, 'td_deck').failures.join(' ')) &&
    /expected undetectable/.test(step(stale, 'td_deck').failures.join(' ')) === false, step(stale, 'td_deck'));
  const req = await gate({ skipSuites: true, dataDir: empty, requireData: true });
  assert('no data + --require-data → GATE FAIL', req.ok === false && step(req, 'compare_finders').status === 'FAIL', req.steps);

  const cliOk = spawnSync(process.execPath, [path.join(__dirname, 'gate.js'), '--skip-suites', '--data', empty],
    { encoding: 'utf8' });
  assert('CLI exit 0 and prints GATE PASS when the deck is absent', cliOk.status === 0 && /GATE PASS\s*$/.test(cliOk.stdout), cliOk.stdout + cliOk.stderr);
  const cliBad = spawnSync(process.execPath, [path.join(__dirname, 'gate.js'), '--skip-suites', '--data', d.dataDir, '--uploads', d.uploadsDir,
    '--candidate', broken, '--current', ROOT], { encoding: 'utf8' });
  assert('CLI exit 1 and prints GATE FAIL', cliBad.status === 1 && /GATE FAIL\s*$/.test(cliBad.stdout), cliBad.stdout + cliBad.stderr);

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) { console.error(failures + ' gate check(s) failed.'); process.exit(1); }
  console.log('All gate checks passed.');
}

run().catch(function (err) { console.error('FAIL gate run threw', err); process.exit(1); });
