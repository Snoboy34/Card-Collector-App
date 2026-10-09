/**
 * scripts/verify_centering_assist.js
 * User-placed centering lines stay labelled assisted, in millimetres, and
 * do not replace the engine measurement. consent=false examples do not
 * leave the machine.
 * Run: node scripts/verify_centering_assist.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const geo = require('../public/centering_assist');
const assist = require('../services/centering_assist');
const wallet = require('../services/wallet_engine');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else {
    failures += 1;
    console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail).slice(0, 800) : '');
  }
}

const WARP = { width: 643, height: 900 };

function reportWith(overrides) {
  const base = {
    scanId: 'assist-test-scan-0001',
    engineVersion: '2026.10.01-border-band',
    finalScore: null,
    incomplete: true,
    centeringUndetected: true,
    printCenteringDetected: false,
    centering: null,
    subGrades: { centering: null, surface: null, edges: null, corners: null },
    centeringMetrics: {
      borderWidthsMm: { left: null, right: 2.1, top: 3.2, bottom: 3.0 },
      borderVoteLowConfidenceEdges: [],
      leftRightRatio: null,
      topBottomRatio: null
    },
    centeringDiagnostics: {
      box: { left: 0, right: 642, top: 0, bottom: 899, width: 643, height: 900 },
      sampleLines: {
        left: [
          { at: 180, pos: null, threshold: 12, inGroup: false },
          { at: 450, pos: 22.5, threshold: 12, inGroup: false }
        ],
        right: [{ at: 450, pos: 21, threshold: 12, inGroup: true }],
        top: [{ at: 320, pos: 32, threshold: 12, inGroup: true }],
        bottom: [{ at: 320, pos: 30, threshold: 12, inGroup: true }]
      }
    }
  };
  return Object.assign(base, overrides || {});
}

function lineForMm(side, mm) {
  const px = geo.linePxFromWidthMm(side, mm, WARP.width, WARP.height);
  return { positionPx: px, warpWidth: WARP.width, warpHeight: WARP.height };
}

async function main() {
  const leftPx = 40;
  const leftMm = geo.widthMmFromLine('left', leftPx, 643, 900);
  assert('left mm matches warpSpan formula', leftMm === Math.round((40 * 63.5 / 643) * 1000) / 1000, leftMm);
  const backPx = geo.linePxFromWidthMm('left', leftMm, 643, 900);
  assert('left line round-trips through mm', geo.widthMmFromLine('left', backPx, 643, 900) === leftMm, backPx);
  const rightPx = (643 - 1) - 40;
  const rightMm = geo.widthMmFromLine('right', rightPx, 643, 900);
  assert('right edge uses the same width as innerLines', rightMm === leftMm, rightMm);
  assert('top uses card height', geo.widthMmFromLine('top', 30, 643, 900) === Math.round((30 * 88.9 / 900) * 1000) / 1000);
  assert('off-card line is null', geo.widthMmFromLine('left', 500, 643, 900) === null);
  assert('zero is a real edge placement', geo.widthMmFromLine('left', 0, 643, 900) === 0);

  const withheld = reportWith();
  const status = geo.sideStatus(withheld);
  assert('null width is withheld', status.left.withheld === true && status.left.measured === false);
  assert('finite width is measured', status.right.measured === true && status.top.measured === true);

  const voteLow = reportWith();
  voteLow.centeringMetrics = Object.assign({}, voteLow.centeringMetrics, {
    borderWidthsMm: { left: 1.5, right: 2.1, top: 3.2, bottom: 3.0 },
    borderVoteLowConfidenceEdges: ['left']
  });
  voteLow.subGrades = { centering: null, surface: null, edges: null, corners: null };
  const lowStatus = geo.sideStatus(voteLow);
  assert('low-confidence vote is withheld even with a width', lowStatus.left.withheld === true && lowStatus.left.engineWidthMm === 1.5);

  const originalCentering = withheld.subGrades.centering;
  const originalWidths = JSON.stringify(withheld.centeringMetrics.borderWidthsMm);
  const built = assist.buildFromLines(withheld, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001',
    engineVersion: '2026.10.01-border-band',
    engineCommit: 'abc1234',
    consent: false
  });
  assert('assisted build ok', built.ok === true, built);
  assert('headline names one side', built.assist.headline === 'Centering (you adjusted 1 side)', built.assist.headline);
  assert('grade source is assisted', built.assist.gradeSource === 'assisted' && built.assist.source === 'assisted');
  assert('centering score is the Judge table, not 50/50', built.assist.centering === 7, built.assist);
  assert('centering label says assisted', built.assist.centeringLabel === '7.0 assisted', built.assist.centeringLabel);
  assert('user mm stored', built.assist.sides.left.userWidthMm === 4 && built.assist.sides.left.kind === 'assisted');
  assert('unmoved measured sides stay engine', built.assist.sides.right.source === 'engine' && built.assist.sides.right.userWidthMm === null);
  assert('engine centering on the report object is unchanged',
    withheld.subGrades.centering === originalCentering &&
    JSON.stringify(withheld.centeringMetrics.borderWidthsMm) === originalWidths &&
    withheld.centeringAssist == null);
  assert('example is assisted, not an engine row', built.examples.length === 1 && built.examples[0].kind === 'assisted');
  assert('example keeps candidate lines, mm, engine stamp, consent false',
    built.examples[0].consent === false &&
    built.examples[0].userWidthMm === 4 &&
    built.examples[0].engineWidthMm === null &&
    built.examples[0].engineVersion === '2026.10.01-border-band' &&
    built.examples[0].engineCommit === 'abc1234' &&
    built.examples[0].scanId === 'assist-test-scan-0001' &&
    built.examples[0].side === 'left' &&
    built.examples[0].engineCandidateLines.length === 2 &&
    built.examples[0].engineCandidateLines[1].pos === 22.5);
  assert('omitted consent is false', assist.buildFromLines(withheld, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001'
  }).examples[0].consent === false);
  const repeatReport = assist.attachAssist({ gradingReport: withheld }, built.assist).gradingReport;
  const repeat = assist.buildFromLines(repeatReport, { left: lineForMm('left', 4) }, { scanId: 'assist-test-scan-0001' });
  assert('the same user line is kept and not stored as a second example',
    repeat.ok === true && repeat.examples.length === 0 &&
    repeat.assist.sides.left.userWidthMm === 4 &&
    repeat.assist.headline === 'Centering (you adjusted 1 side)', repeat);

  const partial = assist.buildFromLines(withheld, { left: lineForMm('left', 4) }, { scanId: 'assist-test-scan-0001' });
  assert('one withheld side plus measured opposites can score', partial.assist.centering === 7);
  const onlyLeftCard = reportWith();
  onlyLeftCard.centeringMetrics.borderWidthsMm = { left: null, right: null, top: null, bottom: null };
  const incomplete = assist.buildFromLines(onlyLeftCard, { left: lineForMm('left', 4) }, { scanId: 'assist-test-scan-0001' });
  assert('missing sides do not invent a centering score',
    incomplete.ok === true && incomplete.assist.centering === null && incomplete.assist.leftRightRatio === null,
    incomplete.assist);
  assert('ratios helper refuses a gap', geo.ratiosFromWidthsMm({ left: 4, right: null, top: 3, bottom: 3 }) === null);

  const measured = reportWith();
  measured.centeringUndetected = false;
  measured.printCenteringDetected = true;
  measured.incomplete = false;
  measured.finalScore = 9;
  measured.subGrades = { centering: 9, surface: 9, edges: 9, corners: null };
  measured.centeringMetrics = {
    borderWidthsMm: { left: 2, right: 2, top: 3, bottom: 3 },
    borderVoteLowConfidenceEdges: [],
    leftRightRatio: { left: 50, right: 50 },
    topBottomRatio: { top: 50, bottom: 50 }
  };
  const same = assist.buildFromLines(measured, { left: lineForMm('left', 2) }, { scanId: 'assist-test-scan-0001' });
  assert('a line left on the engine width is not a disagreement', same.ok === false, same);
  const disagree = assist.buildFromLines(measured, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001',
    engineVersion: '2026.10.01-border-band',
    engineCommit: 'abc1234'
  });
  assert('disagreement keeps both numbers',
    disagree.ok === true &&
    disagree.examples[0].kind === 'disagreement' &&
    disagree.examples[0].engineWidthMm === 2 &&
    disagree.examples[0].userWidthMm === 4, disagree.examples[0]);
  assert('engine sub-grade and final score stay on the report',
    measured.subGrades.centering === 9 && measured.finalScore === 9 &&
    measured.centeringMetrics.borderWidthsMm.left === 2);
  const attached = assist.attachAssist({
    scanId: 'assist-test-scan-0001',
    gradingReport: measured
  }, disagree.assist);
  assert('attached report does not overwrite engine centering',
    attached.gradingReport.subGrades.centering === 9 &&
    attached.gradingReport.finalScore === 9 &&
    attached.gradingReport.centeringMetrics.borderWidthsMm.left === 2 &&
    attached.gradingReport.centeringAssist.sides.left.userWidthMm === 4 &&
    attached.gradingReport.centeringAssist.engineBorderWidthsMm.left === 2);
  assert('two sides pluralize', assist.buildFromLines(measured, {
    left: lineForMm('left', 4),
    top: lineForMm('top', 5)
  }, { scanId: 'assist-test-scan-0001' }).assist.headline === 'Centering (you adjusted 2 sides)');

  const redacted = assist.redactReportForEgress(attached.gradingReport);
  assert('egress copy drops user millimetres and keeps the assisted label',
    redacted.centeringAssist.redacted === true &&
    redacted.centeringAssist.borderWidthsMm === null &&
    redacted.centeringAssist.sides.left.userWidthMm === null &&
    redacted.centeringAssist.headline === 'Centering (you adjusted 1 side)' &&
    redacted.subGrades.centering === 9);
  assert('redact does not mutate the stored report',
    attached.gradingReport.centeringAssist.sides.left.userWidthMm === 4);
  assert('nothing is cleared to leave, including consent=true',
    assist.examplesClearedToLeave().length === 0);
  assert('export filter drops consent=false',
    assist.stripForExport([{ consent: false }, { consent: true }]).length === 1);

  const graded = wallet.isGraded({ gradingReport: attached.gradingReport });
  const withheldItem = assist.attachAssist({ gradingReport: withheld }, built.assist);
  assert('wallet does not treat a withheld engine card as graded because of an assist',
    wallet.isGraded({ gradingReport: withheldItem.gradingReport }) === false, withheldItem.gradingReport.finalScore);
  assert('an engine final score still counts when it was already there', graded === true);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-assist-'));
  process.env.JUDGE_DATA_DIR = path.join(tmp, 'data');
  process.env.JUDGE_UPLOADS_DIR = path.join(tmp, 'uploads');
  process.env.JUDGE_SCANS_DIR = path.join(tmp, 'scans');
  fs.mkdirSync(process.env.JUDGE_DATA_DIR, { recursive: true });
  const scanId = 'assist-test-scan-0001';
  const stored = {
    id: scanId,
    scanId: scanId,
    name: 'Assist test',
    category: 'UNKNOWN',
    imagePath: '/uploads/none.jpg',
    engine: { version: '2026.10.01-border-band', commit: 'abc1234' },
    gradingReport: reportWith(),
    createdAt: '2026-10-09T00:00:00.000Z'
  };
  fs.writeFileSync(path.join(process.env.JUDGE_DATA_DIR, 'database.json'), JSON.stringify({
    inventory: [stored],
    categoryCounts: { SPORTS: 0, TCG: 0, UNKNOWN: 1 }
  }));
  const { app } = require('../server');
  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const pref = await fetch(base + '/api/settings/assist-consent').then(function (r) { return r.json(); });
  assert('consent preference defaults to false', pref.ok === true && pref.consent === false, pref);

  const posted = await fetch(base + '/api/scans/' + scanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: { left: lineForMm('left', 4) } })
  }).then(function (r) { return r.json(); });
  assert('POST stores an assisted grade',
    posted.ok === true &&
    posted.assist.headline === 'Centering (you adjusted 1 side)' &&
    posted.assist.centeringLabel === '7.0 assisted' &&
    posted.item.gradingReport.subGrades.centering === null &&
    posted.item.gradingReport.centeringMetrics.borderWidthsMm.left === null &&
    posted.item.gradingReport.centeringAssist.sides.left.userWidthMm === 4, posted);

  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.JUDGE_DATA_DIR, 'database.json'), 'utf8'));
  const diskReport = onDisk.inventory[0].gradingReport;
  assert('database report is labelled assisted and keeps the engine width null',
    diskReport.centeringAssist.source === 'assisted' &&
    diskReport.centeringAssist.headline === 'Centering (you adjusted 1 side)' &&
    diskReport.subGrades.centering === null &&
    diskReport.centeringMetrics.borderWidthsMm.right === 2.1 &&
    JSON.stringify(diskReport).indexOf('engineCandidateLines') === -1);

  const exampleText = fs.readFileSync(path.join(process.env.JUDGE_DATA_DIR, 'centering_examples.jsonl'), 'utf8');
  const example = JSON.parse(exampleText.trim().split('\n')[0]);
  assert('example file has the labelled row and consent false',
    example.kind === 'assisted' && example.consent === false && example.userWidthMm === 4 &&
    example.engineCommit === 'abc1234' && example.engineCandidateLines[1].pos === 22.5, example);

  const turnedOn = await fetch(base + '/api/settings/assist-consent', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent: true })
  }).then(function (r) { return r.json(); });
  assert('settings toggle can be turned on', turnedOn.consent === true);
  const consented = await fetch(base + '/api/scans/' + scanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: { left: lineForMm('left', 5) }, consent: true })
  }).then(function (r) { return r.json(); });
  assert('consent true is stored on that example only',
    consented.ok === true && consented.assist.sides.left.userWidthMm === 5);
  const rows = fs.readFileSync(path.join(process.env.JUDGE_DATA_DIR, 'centering_examples.jsonl'), 'utf8')
    .trim().split('\n').map(function (line) { return JSON.parse(line); });
  assert('older example stays consent false', rows[0].consent === false && rows[1].consent === true && rows[1].userWidthMm === 5);
  assert('egress list stays empty after consent is on', assist.examplesClearedToLeave().length === 0);

  const badWarp = await fetch(base + '/api/scans/' + scanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: { left: { positionPx: 40, warpWidth: 100, warpHeight: 100 } } })
  });
  assert('a line on the wrong warp is rejected', badWarp.status === 400);

  const pushCopy = assist.redactReportForEgress(diskReport);
  assert('scan-repo copy of this report has no user millimetres',
    pushCopy.centeringAssist.sides.left.userWidthMm === null &&
    pushCopy.centeringAssist.borderWidthsMm === null &&
    pushCopy.centeringAssist.headline === 'Centering (you adjusted 1 side)');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures) {
    console.error(failures + ' failed');
    process.exit(1);
  }
  console.log('centering assist checks passed');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
