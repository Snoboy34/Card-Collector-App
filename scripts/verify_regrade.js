/**
 * scripts/verify_regrade.js
 * scripts/regrade.js is append-only per engine:
 *   - first run appends one line per scan; a missing upload is not recorded
 *   - a second run adds nothing and leaves the file byte-identical
 *   - a new scan appends exactly one line; earlier bytes are untouched
 *   - a different engine version writes its own file
 *   - database.json is never modified; --summary-only omits the full report
 * Run: node scripts/verify_regrade.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const g = require('../services/grading_engine');
const { capture } = require('./synthetic_capture');
const { regrade, listHistories } = require('./regrade');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : ''); }
}
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function lineCount(file) { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; }

async function quietGrade(buf, opts) {
  const log = console.log;
  console.log = function () {};
  try { return await g.gradeBuffer(buf, opts); } finally { console.log = log; }
}

async function addScan(root, inventory, i, withUpload) {
  const cap = await capture(900 + i);
  const scanId = 'regr000' + i + '-0000-4000-8000-000000000000';
  if (withUpload) fs.writeFileSync(path.join(root, 'uploads', scanId + '.jpg'), cap.jpeg);
  const report = await quietGrade(cap.jpeg, {
    alignmentCrop: true, cardQuad: cap.cardQuad, quadImageWidth: cap.photoWidth, quadImageHeight: cap.photoHeight
  });
  inventory.push({ scanId: scanId, createdAt: '2026-09-29T03:0' + i + ':00Z', imagePath: 'uploads/' + scanId + '.jpg',
    engine: { version: 'stored-engine', commit: 'abc1234' }, gradingReport: report });
  fs.writeFileSync(path.join(root, 'data', 'database.json'), JSON.stringify({ inventory: inventory }));
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regrade-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'uploads'));
  const inventory = [];
  await addScan(root, inventory, 0, true);
  await addScan(root, inventory, 1, true);
  await addScan(root, inventory, 2, false);
  const db = path.join(root, 'data', 'database.json');
  const dbHash = sha(db);

  const first = await regrade({ appDir: root });
  console.log(first.text);
  assert('history file is <version>@<commit>.jsonl under data/regrades', path.dirname(first.file) === path.join(root, 'data', 'regrades') &&
    path.basename(first.file).startsWith(g.ENGINE_VERSION + '@'), first.file);
  assert('first run appends 2 scans; missing upload not recorded', first.added.length === 2 && first.missing.length === 1 &&
    lineCount(first.file) === 2, { added: first.added.length, missing: first.missing });
  const rec = JSON.parse(fs.readFileSync(first.file, 'utf8').split('\n')[0]);
  assert('record carries both engines, times, quad, summary and full report', rec.engine.version === g.ENGINE_VERSION &&
    rec.storedEngine.version === 'stored-engine' && rec.scannedAt && rec.regradedAt && /native/.test(rec.quad) &&
    rec.summary.lr != null && Array.isArray(rec.summary.lowConfidenceEdges) && rec.report && rec.report.centeringMetrics,
  Object.keys(rec));

  const hash1 = sha(first.file);
  const second = await regrade({ appDir: root });
  assert('second run adds nothing', second.added.length === 0 && second.already.length === 2, second.text);
  assert('second run leaves the file byte-identical', sha(first.file) === hash1);
  assert('database.json unchanged by two runs', sha(db) === dbHash);

  const before = fs.readFileSync(first.file);
  inventory.splice(2, 1);
  await addScan(root, inventory, 3, true);
  const dbHash2 = sha(db);
  const third = await regrade({ appDir: root });
  const after = fs.readFileSync(first.file);
  assert('new scan appends exactly one line', third.added.length === 1 && lineCount(first.file) === 3, third.text);
  assert('earlier lines untouched (file starts with the old bytes)', after.slice(0, before.length).equals(before));

  const fake = path.join(root, 'engine-next');
  fs.mkdirSync(path.join(fake, 'services'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'services', 'grading_engine.js'),
    'module.exports = Object.assign({}, require(' + JSON.stringify(path.join(ROOT, 'services', 'grading_engine.js')) +
    '), { ENGINE_VERSION: "2099.01.01-next" });\n');
  const other = await regrade({ appDir: root, engineDir: fake, summaryOnly: true });
  assert('another engine writes its own file', other.file !== first.file && /2099\.01\.01-next@nocommit\.jsonl$/.test(other.file) &&
    other.added.length === 3, other.file);
  const otherRec = JSON.parse(fs.readFileSync(other.file, 'utf8').split('\n')[0]);
  assert('--summary-only omits the full report', otherRec.report === undefined && otherRec.summary);
  assert('first engine\'s file unchanged by the other engine', fs.readFileSync(first.file).equals(after));

  const list = listHistories({ appDir: root });
  assert('--list shows both histories with counts', list.histories.length === 2 &&
    list.histories.every(function (h) { return h.scans === 3; }), list.histories);
  assert('database.json unchanged by the later runs', sha(db) === dbHash2);

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) { console.error(failures + ' regrade check(s) failed.'); process.exit(1); }
  console.log('All regrade checks passed.');
}

run().catch(function (err) { console.error('FAIL regrade run threw', err); process.exit(1); });
