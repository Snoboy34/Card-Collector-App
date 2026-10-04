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
const { gate, listSuites } = require('./gate');

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

  const tdRoot = path.join(root, 'td');
  const tdData = path.join(tdRoot, 'data');
  const tdUploads = path.join(tdRoot, 'uploads');
  fs.mkdirSync(tdData, { recursive: true });
  fs.mkdirSync(tdUploads, { recursive: true });
  const tdCap = await capture(701);
  const tdBlank = await capture(702, { borderMm: { left: 0, right: 0, top: 0, bottom: 0 } });
  fs.writeFileSync(path.join(tdUploads, 'td050000-0000-4000-8000-000000000001.jpg'), tdCap.jpeg);
  fs.writeFileSync(path.join(tdUploads, 'td050000-0000-4000-8000-000000000002.jpg'), tdCap.jpeg);
  const tdStore = deck.createStore(tdData);
  function tdItem(scanId, report) {
    return { scanId: scanId, createdAt: '2026-10-03T00:00:00Z', imagePath: 'uploads/' + scanId + '.jpg',
      engine: { version: g.ENGINE_VERSION }, gradingReport: report };
  }
  const gradedCap = await quietGrade(tdCap.jpeg, {
    alignmentCrop: true, cardQuad: tdCap.cardQuad, quadImageWidth: tdCap.photoWidth, quadImageHeight: tdCap.photoHeight
  });
  // Stored grade says undetectable. td_deck re-grades the white frame and must ignore that.
  const storedUndetectable = Object.assign({}, gradedCap, {
    centeringMetrics: {}, subGrades: { centering: null }, incomplete: true, centeringUndetected: true
  });
  tdStore.labelScan('td050000-0000-4000-8000-000000000001', { deckId: 'TD-05', side: 'front' });
  tdStore.labelScan('td050000-0000-4000-8000-000000000002', { deckId: 'TD-05', side: 'back' });
  fs.writeFileSync(path.join(tdData, 'database.json'), JSON.stringify({ inventory: [
    tdItem('td050000-0000-4000-8000-000000000001', storedUndetectable),
    tdItem('td050000-0000-4000-8000-000000000002', storedUndetectable)
  ] }));
  const tdBad = await gate({ skipSuites: true, dataDir: tdData, uploadsDir: tdUploads });
  assert('td_deck FAIL when a re-grade measures a card that must stay undetectable', tdBad.ok === false && step(tdBad, 'td_deck').status === 'FAIL' &&
    /TD-05 front expected undetectable/.test(step(tdBad, 'td_deck').failures.join(' ')) &&
    /TD-05 back expected undetectable/.test(step(tdBad, 'td_deck').failures.join(' ')), step(tdBad, 'td_deck'));
  fs.writeFileSync(path.join(tdUploads, 'td050000-0000-4000-8000-000000000001.jpg'), tdBlank.jpeg);
  fs.writeFileSync(path.join(tdUploads, 'td050000-0000-4000-8000-000000000002.jpg'), tdBlank.jpeg);
  const gradedBlank = await quietGrade(tdBlank.jpeg, {
    alignmentCrop: true, cardQuad: tdBlank.cardQuad, quadImageWidth: tdBlank.photoWidth, quadImageHeight: tdBlank.photoHeight
  });
  const storedMeasured = Object.assign({}, gradedBlank, {
    centeringMetrics: { leftRightRatio: { left: 55, right: 45 }, topBottomRatio: { top: 52, bottom: 48 } },
    subGrades: { centering: 9 }, incomplete: false, centeringUndetected: false
  });
  fs.writeFileSync(path.join(tdData, 'database.json'), JSON.stringify({ inventory: [
    tdItem('td050000-0000-4000-8000-000000000001', storedMeasured),
    tdItem('td050000-0000-4000-8000-000000000002', storedMeasured)
  ] }));
  const tdOk = await gate({ skipSuites: true, dataDir: tdData, uploadsDir: tdUploads });
  assert('td_deck PASS when the re-grade of a borderless card stays undetectable', tdOk.ok === true && step(tdOk, 'td_deck').status === 'PASS', step(tdOk, 'td_deck'));

  const wRoot = path.join(root, 'td02');
  const wData = path.join(wRoot, 'data');
  const wUploads = path.join(wRoot, 'uploads');
  fs.mkdirSync(wData, { recursive: true });
  fs.mkdirSync(wUploads, { recursive: true });
  fs.writeFileSync(path.join(wUploads, 'td020000-0000-4000-8000-000000000001.jpg'), tdCap.jpeg);
  const wStore = deck.createStore(wData);
  wStore.labelScan('td020000-0000-4000-8000-000000000001', { deckId: 'TD-02', side: 'front' });
  // Stored grade is the opposite of the engine under test, so a pass/fail
  // here is the re-grade and not the saved report.
  fs.writeFileSync(path.join(wData, 'database.json'), JSON.stringify({ inventory: [
    tdItem('td020000-0000-4000-8000-000000000001', Object.assign({}, gradedCap, {
      centeringMetrics: {
        leftRightRatio: { left: 55, right: 45 },
        topBottomRatio: { top: 52, bottom: 48 },
        borderVoteLowConfidenceEdges: ['left']
      },
      subGrades: { centering: 9 }
    }))
  ] }));
  function voteCandidate(name, cen) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'services'), { recursive: true });
    const real = JSON.stringify(path.join(ROOT, 'services', 'grading_engine.js'));
    fs.writeFileSync(path.join(dir, 'services', 'grading_engine.js'),
      'const real = require(' + real + ');\n' +
      'module.exports = Object.assign({}, real, { gradeBuffer: async function (b, o) {\n' +
      '  const r = await real.gradeBuffer(b, o);\n' +
      '  r.centeringMetrics = Object.assign({}, r.centeringMetrics, { borderVoteLowConfidenceEdges: ["left"] });\n' +
      '  r.subGrades = Object.assign({}, r.subGrades, { centering: ' + cen + ' });\n' +
      '  return r;\n} });\n');
    return dir;
  }
  const wOk = await gate({
    skipSuites: true, dataDir: wData, uploadsDir: wUploads, candidateDir: voteCandidate('withhold', 'null')
  });
  assert('td_deck PASS when the re-grade withholds TD-02 on a low-confidence edge', wOk.ok === true &&
    step(wOk, 'td_deck').status === 'PASS', step(wOk, 'td_deck'));
  const wBad = await gate({
    skipSuites: true, dataDir: wData, uploadsDir: wUploads, candidateDir: voteCandidate('forced', '9')
  });
  assert('td_deck FAIL when a low-confidence TD-02 re-grade still has a centering number', wBad.ok === false &&
    step(wBad, 'td_deck').status === 'FAIL' &&
    /TD-02 front expected measured or withheld, low-confidence edge/.test(step(wBad, 'td_deck').failures.join(' ')) &&
    /CEN 9 on a low-confidence edge \(left\)/.test(step(wBad, 'td_deck').failures.join(' ')), step(wBad, 'td_deck'));
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
