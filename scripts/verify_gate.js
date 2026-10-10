/**
 * scripts/verify_gate.js
 * Checks scripts/gate.js. Data steps only (--skip-suites), so the gate can
 * run this file as one of its suites without recursing:
 *   - a synthetic data dir with two deck scans → PASS, same-engine runs identical
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
  assert('good data → GATE PASS', ok.ok === true, ok.steps);
  assert('compare_finders PASS with identical same-engine runs', step(ok, 'compare_finders').status === 'PASS' &&
    /runs identical/.test(step(ok, 'compare_finders').detail), step(ok, 'compare_finders'));
  assert('deck_report PASS, 2 of 2 kept', step(ok, 'deck_report').status === 'PASS' &&
    /candidate 2 of 2/.test(step(ok, 'deck_report').detail), step(ok, 'deck_report'));
  assert('td_deck PASS for the two white cards that measure', step(ok, 'td_deck').status === 'PASS' &&
    /2 of 6/.test(step(ok, 'td_deck').detail), step(ok, 'td_deck'));

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
    /TD-02 front expected measured or withheld, low-confidence edge/.test(wBad) &&
    /CEN 9 on a low-confidence edge \(left\)/.test(wBad), wBad);

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
  assert('td_deck follows the re-grade when the stored report is from an old engine', stale.ok === true &&
    step(stale, 'td_deck').status === 'PASS' && /2 of 6/.test(step(stale, 'td_deck').detail), step(stale, 'td_deck'));
  const req = await gate({ skipSuites: true, dataDir: empty, requireData: true });
  assert('no data + --require-data → GATE FAIL', req.ok === false && step(req, 'compare_finders').status === 'FAIL', req.steps);

  const cliOk = spawnSync(process.execPath, [path.join(__dirname, 'gate.js'), '--skip-suites', '--data', d.dataDir, '--uploads', d.uploadsDir],
    { encoding: 'utf8' });
  assert('CLI exit 0 and prints GATE PASS', cliOk.status === 0 && /GATE PASS\s*$/.test(cliOk.stdout), cliOk.stdout + cliOk.stderr);
  const cliBad = spawnSync(process.execPath, [path.join(__dirname, 'gate.js'), '--skip-suites', '--data', d.dataDir, '--uploads', d.uploadsDir,
    '--candidate', broken, '--current', ROOT], { encoding: 'utf8' });
  assert('CLI exit 1 and prints GATE FAIL', cliBad.status === 1 && /GATE FAIL\s*$/.test(cliBad.stdout), cliBad.stdout + cliBad.stderr);

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) { console.error(failures + ' gate check(s) failed.'); process.exit(1); }
  console.log('All gate checks passed.');
}

run().catch(function (err) { console.error('FAIL gate run threw', err); process.exit(1); });
