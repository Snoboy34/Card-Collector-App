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
const scanMetadata = require('../services/scan_metadata');

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
  const demoRange = geo.plausibleRangeMm('left', { left: null, right: 4.737, top: 4.148, bottom: 4.936 });
  assert('11.43 mm is outside the range taken from the measured borders',
    demoRange && 11.43 > demoRange.maxMm && demoRange.minMm >= 0, demoRange);
  const inRange = geo.plausibleRangeMm('left', geo.measuredWidthsMm(withheld));
  assert('2.2 mm is inside the fixture range', inRange && 2.2 >= inRange.minMm && 2.2 <= inRange.maxMm, inRange);
  withheld.side = 'front';
  const quiet = assist.buildFromLines(withheld, { left: lineForMm('left', 2.2) }, { scanId: 'assist-test-scan-0001' });
  assert('a plausible line saves without a warning',
    quiet.ok === true && quiet.examples[0].warningShown === false, quiet);
  const blocked = assist.buildFromLines(withheld, { left: lineForMm('left', 4) }, { scanId: 'assist-test-scan-0001' });
  assert('an implausible line is refused until it is confirmed',
    blocked.ok === false && blocked.implausible && blocked.implausible[0].side === 'left' && blocked.examples == null,
    blocked);
  const built = assist.buildFromLines(withheld, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001',
    engineVersion: '2026.10.01-border-band',
    engineCommit: 'abc1234',
    consent: false,
    confirmImplausible: true
  });
  assert('assisted build ok', built.ok === true, built);
  assert('headline names one side', built.assist.headline === 'Centering (you adjusted 1 side)', built.assist.headline);
  assert('grade source is assisted', built.assist.gradeSource === 'assisted' && built.assist.source === 'assisted');
  assert('centering score is the Judge table, not 50/50', built.assist.centering === 7, built.assist);
  assert('centering label says assisted', built.assist.centeringLabel === '7.0 assisted', built.assist.centeringLabel);
  assert('a stored front uses the front table', built.assist.side === 'front');
  const noSideReport = reportWith();
  const noSide = assist.buildFromLines(noSideReport, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001',
    confirmImplausible: true
  });
  assert('a report with no side does not default to the front table',
    noSide.ok === true &&
    noSide.assist.side == null &&
    noSide.assist.centering == null &&
    noSide.assist.centeringLabel == null,
    noSide.assist && { side: noSide.assist.side, centering: noSide.assist.centering, label: noSide.assist.centeringLabel });
  assert('assisted label does not say PSA', String(built.assist.centeringLabel).indexOf('PSA') === -1);

  function blankWidths(side) {
    const report = reportWith({ side: side });
    report.centeringMetrics = {
      borderWidthsMm: { left: null, right: null, top: null, bottom: null },
      borderVoteLowConfidenceEdges: [],
      leftRightRatio: null,
      topBottomRatio: null
    };
    report.subGrades = { centering: null, surface: null, edges: null, corners: null };
    return report;
  }
  const tableCases = [
    { name: '60/40', widths: { left: 6, right: 4, top: 5, bottom: 5 }, front: 9, frontLabel: '9.0 assisted', back: 10, backLabel: '10.0 assisted' },
    { name: '75/25', widths: { left: 7.5, right: 2.5, top: 5, bottom: 5 }, front: 6, frontLabel: '6.0 assisted', back: 10, backLabel: '10.0 assisted' },
    { name: '80/20', widths: { left: 8, right: 2, top: 5, bottom: 5 }, front: 6, frontLabel: '6.0 assisted', back: 9, backLabel: '9.0 assisted' },
    { name: '90/10', widths: { left: 9, right: 1, top: 5, bottom: 5 }, front: 3, frontLabel: '3.0 assisted', back: 9, backLabel: '9.0 assisted' },
    { name: 'past 90/10', widths: { left: 9.1, right: 0.9, top: 5, bottom: 5 }, front: 1, frontLabel: '1.0 assisted', back: null, backLabel: null }
  ];
  tableCases.forEach(function (row) {
    ['front', 'back'].forEach(function (side) {
      const before = blankWidths(side);
      const engineBefore = JSON.stringify(before.subGrades);
      const builtRow = assist.buildFromMillimetres(before, row.widths, { scanId: 'table-' + side, confirmImplausible: true });
      const expectScore = side === 'back' ? row.back : row.front;
      const expectLabel = side === 'back' ? row.backLabel : row.frontLabel;
      assert(side + ' ' + row.name + ' assisted score',
        builtRow.ok === true &&
        builtRow.assist.side === side &&
        builtRow.assist.centering === expectScore &&
        builtRow.assist.centeringLabel === expectLabel &&
        String(builtRow.assist.centeringLabel || '').indexOf('PSA') === -1 &&
        JSON.stringify(before.subGrades) === engineBefore,
        builtRow.assist && { side: builtRow.assist.side, centering: builtRow.assist.centering, label: builtRow.assist.centeringLabel });
    });
  });
  const backByMeta = assist.buildFromMillimetres(blankWidths(undefined), tableCases[0].widths, {
    scanId: 'table-meta-back', side: 'back', confirmImplausible: true
  });
  assert('item side back uses the back table when the report has no side',
    backByMeta.ok === true && backByMeta.assist.centeringLabel === '10.0 assisted', backByMeta.assist && backByMeta.assist.centeringLabel);
  const storedBack = {
    inventory: [{
      scanId: '366A0E19',
      side: 'back',
      gradingReport: {
        side: 'back',
        finalScore: null,
        subGrades: { centering: null, surface: 8, edges: 8, corners: 8 },
        centeringAssist: {
          adjustedCount: 1,
          side: 'front',
          centering: 9,
          centeringLabel: '9.0 assisted',
          borderWidthsMm: { left: 6, right: 4, top: 5, bottom: 5 }
        }
      }
    }]
  };
  const storedSubs = JSON.stringify(storedBack.inventory[0].gradingReport.subGrades);
  const rescoreLog = [];
  const emitRescore = function (line) { rescoreLog.push(line); };
  assert('a stored back 60/40 is rewritten onto the back table',
    assist.rescoreDatabase(storedBack, emitRescore) === 1 &&
    storedBack.inventory[0].gradingReport.centeringAssist.centering === 10 &&
    storedBack.inventory[0].gradingReport.centeringAssist.centeringLabel === '10.0 assisted' &&
    storedBack.inventory[0].gradingReport.centeringAssist.side === 'back' &&
    JSON.stringify(storedBack.inventory[0].gradingReport.subGrades) === storedSubs);
  assert('the rewrite logs the scan id and the old and new labels',
    rescoreLog.length === 1 &&
    rescoreLog[0] === '[centering-assist] rescore scanId=366A0E19 old=9.0 assisted new=10.0 assisted',
    rescoreLog);
  rescoreLog.length = 0;
  assert('a second pass leaves the corrected assist',
    assist.rescoreDatabase(storedBack, emitRescore) === 0 && rescoreLog.length === 0, rescoreLog);
  storedBack.inventory[0].gradingReport.centeringAssist.borderWidthsMm = { left: 9.1, right: 0.9, top: 5, bottom: 5 };
  storedBack.inventory[0].gradingReport.centeringAssist.centering = 1;
  storedBack.inventory[0].gradingReport.centeringAssist.centeringLabel = '1.0 assisted';
  assert('a stored back past 90/10 loses the fabricated label',
    assist.rescoreDatabase(storedBack, emitRescore) === 1 &&
    storedBack.inventory[0].gradingReport.centeringAssist.centering === null &&
    storedBack.inventory[0].gradingReport.centeringAssist.centeringLabel === null &&
    rescoreLog.length === 1 &&
    rescoreLog[0] === '[centering-assist] rescore scanId=366A0E19 old=1.0 assisted new=null',
    rescoreLog);
  rescoreLog.length = 0;
  assert('a second pass after withholding logs nothing',
    assist.rescoreDatabase(storedBack, emitRescore) === 0 && rescoreLog.length === 0, rescoreLog);
  const loggedByDefault = [];
  const previousLog = console.log;
  console.log = function (line) {
    loggedByDefault.push(line);
    previousLog.apply(console, arguments);
  };
  const defaultDb = {
    inventory: [{
      id: 'default-log-scan',
      side: 'back',
      gradingReport: {
        side: 'back',
        subGrades: { centering: null },
        centeringAssist: {
          adjustedCount: 1,
          side: 'front',
          centering: 9,
          centeringLabel: '9.0 assisted',
          borderWidthsMm: { left: 6, right: 4, top: 5, bottom: 5 }
        }
      }
    }]
  };
  let defaultChanged = 0;
  let defaultSecond = 1;
  try {
    defaultChanged = assist.rescoreDatabase(defaultDb);
    const afterFirst = loggedByDefault.length;
    defaultSecond = assist.rescoreDatabase(defaultDb);
    assert('startup rewrite logs through console.log',
      defaultChanged === 1 &&
      afterFirst === 1 &&
      loggedByDefault[0] === '[centering-assist] rescore scanId=default-log-scan old=9.0 assisted new=10.0 assisted' &&
      defaultSecond === 0 &&
      loggedByDefault.length === 1,
      loggedByDefault);
  } finally {
    console.log = previousLog;
  }

  const repairLog = [];
  const captureInstant = '2026-10-12T21:57:08.000Z';
  const corrupt = {
    inventory: [{
      scanId: '366A0E19-0000-4000-8000-000000000001',
      deckId: 'TD-13',
      side: 'front',
      name: 'replaced',
      createdAt: '2026-10-13T13:54:36.000Z',
      gradingReport: {
        side: 'front',
        centeringAssist: { adjustedCount: 1, centeringLabel: '9.0 assisted', borderWidthsMm: { left: 5.6, right: 4.4, top: 5, bottom: 5 } }
      }
    }]
  };
  const backup = {
    missing: false,
    path: 'data/' + assist.BACKUP_366_NAME,
    inventory: [{
      scanId: '366A0E19-0000-4000-8000-000000000001',
      deckId: 'TD-06',
      side: 'back',
      name: 'Dana Evans',
      pairId: 'front-pair-1',
      createdAt: captureInstant,
      gradingReport: { side: 'back', finalScore: null, centeringAssist: { centeringLabel: 'old' } }
    }]
  };
  assert('366A0E19 copies createdAt and other original fields from the backup',
    assist.repairRecord366A0E19(corrupt, function (line) { repairLog.push(line); }, backup) === 1 &&
    corrupt.inventory[0].deckId === 'TD-06' &&
    corrupt.inventory[0].side === 'back' &&
    corrupt.inventory[0].gradingReport.side === 'back' &&
    corrupt.inventory[0].createdAt === captureInstant &&
    corrupt.inventory[0].name === 'Dana Evans' &&
    corrupt.inventory[0].pairId === 'front-pair-1' &&
    corrupt.inventory[0].gradingReport.centeringAssist.centeringLabel === '9.0 assisted' &&
    corrupt.inventory[0].createdAt !== '2026-10-12T20:57:08.000Z');
  assert('the repair log names the scan, the deck, the side, and the backup time',
    repairLog.length === 1 &&
    repairLog[0].indexOf('scanId=366A0E19-0000-4000-8000-000000000001') !== -1 &&
    repairLog[0].indexOf('deckId TD-13 -> TD-06') !== -1 &&
    repairLog[0].indexOf('side front -> back') !== -1 &&
    repairLog[0].indexOf('2026-10-13T13:54:36.000Z') !== -1 &&
    repairLog[0].indexOf(captureInstant) !== -1 &&
    repairLog[0].indexOf('restored') !== -1 &&
    repairLog[0].indexOf('2026-10-12T20:57:08') === -1,
    repairLog);
  assert('a second repair from the same backup logs nothing',
    assist.repairRecord366A0E19(corrupt, function (line) { repairLog.push(line); }, backup) === 0 &&
    repairLog.length === 1, repairLog);
  const matchedAssist = {
    centering: 10,
    centeringLabel: '10.0 assisted',
    side: 'back',
    leftRightRatio: '56.0/44.0',
    topBottomRatio: '46.8/53.2'
  };
  const matchedCreatedAt = '2026-10-12T21:50:37.000Z';
  const already = {
    inventory: [{
      scanId: '366A0E19-0000-4000-8000-000000000001',
      deckId: 'TD-06',
      side: 'back',
      name: 'Dana Evans',
      createdAt: matchedCreatedAt,
      gradingReport: {
        side: 'back',
        centeringAssist: matchedAssist,
        finalScore: null,
        copyrightYear: 2024
      }
    }]
  };
  const alreadyBackup = {
    missing: false,
    path: 'data/' + assist.BACKUP_366_NAME,
    inventory: [{
      scanId: '366A0E19-0000-4000-8000-000000000001',
      deckId: 'TD-06',
      side: 'back',
      name: 'Dana Evans',
      createdAt: matchedCreatedAt,
      gradingReport: {
        finalScore: null,
        copyrightYear: 2024,
        centeringAssist: { centeringLabel: 'old' }
      }
    }]
  };
  const alreadyBefore = JSON.stringify(already);
  const alreadyLog = [];
  const alreadyFirst = assist.repairRecord366A0E19(already, function (line) { alreadyLog.push(line); }, alreadyBackup);
  const alreadyMid = JSON.stringify(already);
  const alreadySecond = assist.repairRecord366A0E19(already, function (line) { alreadyLog.push(line); }, alreadyBackup);
  assert('two restarts of an already matching 366A0E19 change nothing and log nothing',
    alreadyFirst === 0 &&
    alreadySecond === 0 &&
    alreadyLog.length === 0 &&
    alreadyMid === alreadyBefore &&
    JSON.stringify(already) === alreadyBefore &&
    already.inventory[0].deckId === 'TD-06' &&
    already.inventory[0].side === 'back' &&
    already.inventory[0].createdAt === matchedCreatedAt &&
    already.inventory[0].gradingReport.centeringAssist.centeringLabel === '10.0 assisted' &&
    already.inventory[0].gradingReport.centeringAssist.leftRightRatio === '56.0/44.0' &&
    already.inventory[0].gradingReport.centeringAssist.topBottomRatio === '46.8/53.2' &&
    already.inventory[0].gradingReport.side === 'back',
    { alreadyFirst: alreadyFirst, alreadySecond: alreadySecond, alreadyLog: alreadyLog });
  const missingBackupLog = [];
  const missingClock = {
    inventory: [{
      scanId: '366A0E19-0000-4000-8000-000000000001',
      deckId: 'TD-13',
      side: 'front',
      createdAt: '2026-10-13T13:54:36.000Z',
      gradingReport: { side: 'front' }
    }]
  };
  assert('a missing backup leaves createdAt unchanged and still sets TD-06 back',
    assist.repairRecord366A0E19(missingClock, function (line) { missingBackupLog.push(line); }, {
      missing: true,
      path: 'data/' + assist.BACKUP_366_NAME
    }) === 1 &&
    missingClock.inventory[0].createdAt === '2026-10-13T13:54:36.000Z' &&
    missingClock.inventory[0].deckId === 'TD-06' &&
    missingClock.inventory[0].side === 'back' &&
    missingBackupLog.length === 1 &&
    missingBackupLog[0].indexOf('backup missing') !== -1 &&
    missingBackupLog[0].indexOf('createdAt 2026-10-13T13:54:36.000Z left unchanged') !== -1 &&
    missingBackupLog[0].indexOf('2026-10-12T21:57:08') === -1 &&
    missingBackupLog[0].indexOf('2026-10-12T20:57:08') === -1,
    missingBackupLog);
  const absentLog = [];
  const absentClock = {
    inventory: [{
      scanId: '366A0E19-0000-4000-8000-000000000001',
      deckId: 'TD-02',
      side: 'front',
      createdAt: '2026-10-13T13:54:36.000Z',
      gradingReport: { side: 'front' }
    }]
  };
  assert('a backup without that scan leaves createdAt unchanged',
    assist.repairRecord366A0E19(absentClock, function (line) { absentLog.push(line); }, {
      missing: false,
      inventory: [{ scanId: 'other-scan-0001', createdAt: captureInstant, deckId: 'TD-06', side: 'back' }]
    }) === 1 &&
    absentClock.inventory[0].createdAt === '2026-10-13T13:54:36.000Z' &&
    absentClock.inventory[0].deckId === 'TD-06' &&
    absentClock.inventory[0].side === 'back' &&
    absentLog[0].indexOf('not in backup') !== -1 &&
    absentLog[0].indexOf('createdAt 2026-10-13T13:54:36.000Z left unchanged') !== -1,
    absentLog);
  const twoLog = [];
  const twoDb = {
    inventory: [
      {
        id: 'rescore-a',
        side: 'back',
        gradingReport: {
          side: 'back',
          centeringAssist: {
            adjustedCount: 1, side: 'front', centering: 9, centeringLabel: '9.0 assisted',
            borderWidthsMm: { left: 6, right: 4, top: 5, bottom: 5 }
          }
        }
      },
      {
        id: 'rescore-b',
        side: 'back',
        gradingReport: {
          side: 'back',
          centeringAssist: {
            adjustedCount: 1, side: 'front', centering: 1, centeringLabel: '1.0 assisted',
            borderWidthsMm: { left: 9.1, right: 0.9, top: 5, bottom: 5 }
          }
        }
      }
    ]
  };
  assert('startup rescore logs each record with the scan id and the old and new labels',
    assist.rescoreDatabase(twoDb, function (line) { twoLog.push(line); }) === 2 &&
    twoLog.length === 2 &&
    twoLog[0] === '[centering-assist] rescore scanId=rescore-a old=9.0 assisted new=10.0 assisted' &&
    twoLog[1] === '[centering-assist] rescore scanId=rescore-b old=1.0 assisted new=null',
    twoLog);

  const phoneCapture = '2026-10-12T21:57:08.000Z';
  const earlierPersist = '2026-10-12T21:50:37.000Z';
  const captureRow = {
    scanId: 'capture-clock-0001',
    createdAt: earlierPersist,
    captureMetadata: { capture: { capturedAt: phoneCapture, mode: 'native-still' } }
  };
  const captureLog = [];
  assert('a stored upload keeps the phone capture and does not copy the earlier server clock',
    scanMetadata.stampStoredCaptureTimes({ inventory: [captureRow] }, function (line) { captureLog.push(line); }) === 1 &&
    captureRow.capturedAt === phoneCapture &&
    captureRow.createdAt === earlierPersist &&
    captureLog[0] === '[centering-assist] capture scanId=capture-clock-0001 capturedAt ' + phoneCapture);
  const captureLogAgain = [];
  assert('a second capture stamp logs nothing',
    scanMetadata.stampStoredCaptureTimes({ inventory: [captureRow] }, function (line) { captureLogAgain.push(line); }) === 0 &&
    captureLogAgain.length === 0);
  const bareClock = { scanId: 'capture-clock-0002', createdAt: earlierPersist };
  assert('a row with only createdAt does not become a capture time',
    scanMetadata.stampStoredCaptureTimes({ inventory: [bareClock] }, function () {}) === 0 &&
    bareClock.capturedAt == null);

  const identityReport = blankWidths('back');
  const identityBuilt = assist.buildFromMillimetres(identityReport, { left: 5.6, right: 4.4, top: 5, bottom: 5 }, {
    scanId: 'identity-back-0001',
    confirmImplausible: true,
    side: 'back'
  });
  const identitySaved = assist.applyStoredAssist({
    scanId: 'identity-back-0001',
    deckId: 'TD-06',
    side: 'back',
    createdAt: '2026-10-12T21:50:37.000Z',
    capturedAt: '2026-10-12T21:57:08.000Z',
    gradingReport: identityReport
  }, identityBuilt.assist, '2026-10-13T13:54:36.000Z', { setSide: 'front' });
  assert('saving an adjustment keeps deck id, side, and scan time',
    identityBuilt.ok === true &&
    identitySaved.deckId === 'TD-06' &&
    identitySaved.side === 'back' &&
    identitySaved.gradingReport.side === 'back' &&
    identitySaved.createdAt === '2026-10-12T21:50:37.000Z' &&
    identitySaved.capturedAt === '2026-10-12T21:57:08.000Z' &&
    identitySaved.gradingReport.centeringAssist.adjustedAt === '2026-10-13T13:54:36.000Z' &&
    identitySaved.gradingReport.centeringAssist.side === 'back' &&
    identitySaved.gradingReport.centeringAssist.centering === 10 &&
    identitySaved.gradingReport.centeringAssist.centeringLabel === '10.0 assisted',
    identitySaved.gradingReport.centeringAssist);
  const missingReport = blankWidths(undefined);
  const missingBuilt = assist.buildFromMillimetres(missingReport, { left: 5.6, right: 4.4, top: 5, bottom: 5 }, {
    scanId: 'identity-missing-01',
    confirmImplausible: true
  });
  const missingSaved = assist.applyStoredAssist({
    scanId: 'identity-missing-01',
    deckId: 'TD-04',
    createdAt: '2026-10-11T00:00:00.000Z',
    gradingReport: missingReport
  }, missingBuilt.assist, '2026-10-13T13:54:36.000Z', {});
  assert('a missing side does not default to front',
    missingBuilt.ok === true &&
    missingSaved.side == null &&
    (missingSaved.gradingReport.side == null) &&
    missingSaved.gradingReport.centeringAssist.side == null &&
    missingSaved.gradingReport.centeringAssist.centering == null &&
    missingSaved.gradingReport.centeringAssist.centeringLabel == null &&
    missingSaved.deckId === 'TD-04' &&
    missingSaved.createdAt === '2026-10-11T00:00:00.000Z',
    missingSaved);
  const missingBack = assist.applyStoredAssist(
    missingSaved,
    missingSaved.gradingReport.centeringAssist,
    '2026-10-13T13:55:00.000Z',
    { setSide: 'back' }
  );
  assert('an explicit back on a side-less record uses the back table',
    missingBack.side === 'back' &&
    missingBack.deckId === 'TD-04' &&
    missingBack.createdAt === '2026-10-11T00:00:00.000Z' &&
    missingBack.gradingReport.centeringAssist.centering === 10 &&
    missingBack.gradingReport.centeringAssist.centeringLabel === '10.0 assisted' &&
    missingBack.gradingReport.centeringAssist.adjustedAt === '2026-10-13T13:55:00.000Z');
  const stillBack = assist.applyStoredAssist(
    missingBack,
    missingBack.gradingReport.centeringAssist,
    '2026-10-13T13:56:00.000Z',
    { setSide: 'front' }
  );
  assert('a later setSide does not replace a stored side',
    stillBack.side === 'back' &&
    stillBack.gradingReport.side === 'back' &&
    stillBack.gradingReport.centeringAssist.centeringLabel === '10.0 assisted' &&
    stillBack.createdAt === '2026-10-11T00:00:00.000Z' &&
    stillBack.deckId === 'TD-04');

  assert('user mm stored', built.assist.sides.left.userWidthMm === 4 && built.assist.sides.left.kind === 'assisted');
  assert('unmoved measured sides stay engine', built.assist.sides.right.source === 'engine' && built.assist.sides.right.userWidthMm === null);
  assert('engine centering on the report object is unchanged',
    withheld.subGrades.centering === originalCentering &&
    JSON.stringify(withheld.centeringMetrics.borderWidthsMm) === originalWidths &&
    withheld.centeringAssist == null);
  assert('example is assisted, not an engine row', built.examples.length === 1 && built.examples[0].kind === 'assisted');
  assert('example keeps candidate lines, mm, engine stamp, consent false',
    built.examples[0].consent === false &&
    built.examples[0].warningShown === true &&
    built.examples[0].userWidthMm === 4 &&
    built.examples[0].engineWidthMm === null &&
    built.examples[0].engineVersion === '2026.10.01-border-band' &&
    built.examples[0].engineCommit === 'abc1234' &&
    built.examples[0].scanId === 'assist-test-scan-0001' &&
    built.examples[0].side === 'left' &&
    built.examples[0].engineCandidateLines.length === 2 &&
    built.examples[0].engineCandidateLines[1].pos === 22.5, built.examples[0]);
  assert('omitted consent is false', assist.buildFromLines(withheld, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001',
    confirmImplausible: true
  }).examples[0].consent === false);
  const repeatReport = assist.attachAssist({ gradingReport: withheld }, built.assist).gradingReport;
  const repeatBlocked = assist.buildFromLines(repeatReport, { left: lineForMm('left', 4) }, { scanId: 'assist-test-scan-0001' });
  assert('repeating an implausible line without confirmation does not save',
    repeatBlocked.ok === false && repeatBlocked.implausible && repeatBlocked.implausible.length === 1, repeatBlocked);
  const repeat = assist.buildFromLines(repeatReport, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001',
    confirmImplausible: true
  });
  assert('the same user line is kept and not stored as a second example',
    repeat.ok === true && repeat.examples.length === 0 &&
    repeat.assist.sides.left.userWidthMm === 4 &&
    repeat.assist.headline === 'Centering (you adjusted 1 side)', repeat);

  const partial = assist.buildFromLines(withheld, { left: lineForMm('left', 4) }, {
    scanId: 'assist-test-scan-0001',
    confirmImplausible: true
  });
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
    engineCommit: 'abc1234',
    confirmImplausible: true
  });
  assert('disagreement keeps both numbers',
    disagree.ok === true &&
    disagree.examples[0].kind === 'disagreement' &&
    disagree.examples[0].warningShown === true &&
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
  }, { scanId: 'assist-test-scan-0001', confirmImplausible: true }).assist.headline === 'Centering (you adjusted 2 sides)');

  const redacted = assist.redactReportForEgress(attached.gradingReport);
  assert('scan-repo copy drops the disagreement millimetres and keeps the engine width',
    redacted.centeringAssist.sides.left.userWidthMm === null &&
    redacted.centeringAssist.sides.left.engineWidthMm === 2 &&
    redacted.centeringAssist.borderWidthsMm.left === 2 &&
    redacted.centeringAssist.engineBorderWidthsMm.left === 2 &&
    redacted.centeringAssist.headline === 'Centering (you adjusted 1 side)' &&
    redacted.subGrades.centering === 9 &&
    redacted.finalScore === 9 &&
    redacted.centeringMetrics.borderWidthsMm.left === 2);
  assert('hosted copy still strips the assist block, and the push script does not call it',
    assist.redactReportForHostedEgress(attached.gradingReport).centeringAssist.engineBorderWidthsMm === null &&
    assist.redactReportForHostedEgress(attached.gradingReport).centeringAssist.sides.left.engineWidthMm === null &&
    fs.readFileSync(path.join(__dirname, 'push_scan_data.sh'), 'utf8').indexOf('redactReportForHostedEgress') === -1 &&
    fs.readFileSync(path.join(__dirname, 'push_scan_data.sh'), 'utf8').indexOf('redactDatabaseForScanRepo') !== -1);
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
    gradingReport: reportWith({ side: 'front' }),
    side: 'front',
    createdAt: '2026-10-09T00:00:00.000Z'
  };
  const backScanId = 'td06-back-0001';
  const backStored = {
    id: backScanId,
    scanId: backScanId,
    name: 'TD-06 back',
    category: 'UNKNOWN',
    deckId: 'TD-06',
    side: 'back',
    imagePath: '/uploads/none.jpg',
    gradingReport: reportWith({ scanId: backScanId, side: 'back' }),
    createdAt: '2026-10-12T20:57:08.000Z'
  };
  const unknownScanId = 'noside-scan-0001';
  const unknownStored = {
    id: unknownScanId,
    scanId: unknownScanId,
    name: 'Side missing',
    category: 'UNKNOWN',
    deckId: 'TD-04',
    imagePath: '/uploads/none.jpg',
    gradingReport: reportWith({ scanId: unknownScanId }),
    createdAt: '2026-10-11T00:00:00.000Z'
  };
  const vaultScanId = '366A0E19-0000-4000-8000-000000000001';
  const captureUploadAt = '2026-10-12T21:50:37.000Z';
  const phoneCaptureAt = '2026-10-12T21:57:08.000Z';
  const adjustmentAt = '2026-10-13T14:54:36.000Z';
  const vaultStored = {
    id: vaultScanId,
    scanId: vaultScanId,
    name: 'Vault record',
    category: 'UNKNOWN',
    deckId: 'TD-06',
    side: 'back',
    imagePath: '/uploads/none.jpg',
    gradingReport: reportWith({
      scanId: vaultScanId,
      side: 'back',
      centeringAssist: {
        source: 'assisted',
        gradeSource: 'assisted',
        adjustedCount: 1,
        headline: 'Centering (you adjusted 1 side)',
        centeringLabel: '10.0 assisted',
        adjustedAt: adjustmentAt,
        sides: {
          left: { userWidthMm: 5.6, engineWidthMm: 5, kind: 'disagreement' },
          right: { userWidthMm: 4.4, engineWidthMm: 4.4, kind: 'agreement' },
          top: { userWidthMm: 5, engineWidthMm: 5, kind: 'agreement' },
          bottom: { userWidthMm: 5, engineWidthMm: 5, kind: 'agreement' }
        },
        borderWidthsMm: { left: 5.6, right: 4.4, top: 5, bottom: 5 }
      }
    }),
    createdAt: captureUploadAt,
    capturedAt: phoneCaptureAt,
    captureMetadata: { capture: { capturedAt: phoneCaptureAt, mode: 'native-still' } }
  };
  fs.writeFileSync(path.join(process.env.JUDGE_DATA_DIR, 'database.json'), JSON.stringify({
    inventory: [stored, backStored, unknownStored, vaultStored],
    categoryCounts: { SPORTS: 0, TCG: 0, UNKNOWN: 4 }
  }));
  const { app } = require('../server');
  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const memoryList = await fetch(base + '/api/inventory').then(function (r) { return r.json(); });
  assert('the memory inventory list does not hold the database records',
    memoryList.ok === true && memoryList.inventory.length === 0, memoryList);
  const vaultRead = await fetch(base + '/api/scans/' + vaultScanId).then(function (r) { return r.json(); });
  assert('GET scan returns the database record the phone vault replaces its copy with',
    vaultRead.ok === true &&
    vaultRead.item.deckId === 'TD-06' &&
    vaultRead.item.side === 'back' &&
    vaultRead.item.createdAt === captureUploadAt &&
    vaultRead.item.capturedAt === phoneCaptureAt &&
    vaultRead.item.capturedAt !== vaultRead.item.createdAt &&
    vaultRead.item.gradingReport.centeringAssist.centeringLabel === '10.0 assisted' &&
    vaultRead.item.gradingReport.centeringAssist.borderWidthsMm.left === 5.6 &&
    vaultRead.item.gradingReport.centeringAssist.adjustedAt === adjustmentAt &&
    vaultRead.item.gradingReport.centeringAssist.adjustedAt !== vaultRead.item.createdAt,
    vaultRead.item && { deckId: vaultRead.item.deckId, side: vaultRead.item.side, createdAt: vaultRead.item.createdAt });
  const missingScan = await fetch(base + '/api/scans/missing-scan-0001');
  assert('GET of an unknown scan is 404', missingScan.status === 404);

  const pref = await fetch(base + '/api/settings/assist-consent').then(function (r) { return r.json(); });
  assert('consent preference defaults to false', pref.ok === true && pref.consent === false, pref);

  const refused = await fetch(base + '/api/scans/' + scanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: { left: lineForMm('left', 4) } })
  }).then(function (r) { return r.json(); });
  assert('POST of an implausible line does not save',
    refused.ok === false && refused.implausible && refused.implausible[0].userWidthMm === 4, refused);
  assert('refused line is not in the example file',
    !fs.existsSync(path.join(process.env.JUDGE_DATA_DIR, 'centering_examples.jsonl')));

  const posted = await fetch(base + '/api/scans/' + scanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: { left: lineForMm('left', 4) },
      confirmImplausible: true,
      deckId: 'TD-13',
      side: 'back',
      createdAt: '2026-10-13T13:54:36.000Z'
    })
  }).then(function (r) { return r.json(); });
  assert('POST stores an assisted grade',
    posted.ok === true &&
    posted.assist.headline === 'Centering (you adjusted 1 side)' &&
    posted.assist.centeringLabel === '7.0 assisted' &&
    posted.item.gradingReport.subGrades.centering === null &&
    posted.item.gradingReport.centeringMetrics.borderWidthsMm.left === null &&
    posted.item.gradingReport.centeringAssist.sides.left.userWidthMm === 4, posted);
  assert('POST ignores a deck id, side, and clock sent with the lines',
    posted.item.deckId == null &&
    posted.item.side === 'front' &&
    posted.item.gradingReport.side === 'front' &&
    posted.item.createdAt === '2026-10-09T00:00:00.000Z' &&
    posted.assist.adjustedAt &&
    posted.assist.adjustedAt !== posted.item.createdAt,
    { deckId: posted.item.deckId, side: posted.item.side, createdAt: posted.item.createdAt, adjustedAt: posted.assist.adjustedAt });

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
    example.kind === 'assisted' && example.consent === false && example.warningShown === true &&
    example.userWidthMm === 4 &&
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
    body: JSON.stringify({ lines: { left: lineForMm('left', 5) }, consent: true, confirmImplausible: true })
  }).then(function (r) { return r.json(); });
  assert('consent true is stored on that example only',
    consented.ok === true && consented.assist.sides.left.userWidthMm === 5);
  const rows = fs.readFileSync(path.join(process.env.JUDGE_DATA_DIR, 'centering_examples.jsonl'), 'utf8')
    .trim().split('\n').map(function (line) { return JSON.parse(line); });
  assert('older example stays consent false', rows[0].consent === false && rows[1].consent === true && rows[1].userWidthMm === 5);
  assert('egress list stays empty after consent is on', assist.examplesClearedToLeave().length === 0);
  const vaultSaved = await fetch(base + '/api/scans/' + vaultScanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: { left: lineForMm('left', 4) },
      confirmImplausible: true,
      deckId: 'TD-13',
      side: 'front',
      createdAt: '2026-10-12T21:57:08.000Z',
      capturedAt: '1999-01-01T00:00:00.000Z'
    })
  }).then(function (r) { return r.json(); });
  const vaultAfter = await fetch(base + '/api/scans/' + vaultScanId).then(function (r) { return r.json(); });
  assert('a line save does not replace the stored deck, side, or capture time',
    vaultSaved.ok === true &&
    vaultSaved.item.deckId === 'TD-06' &&
    vaultSaved.item.side === 'back' &&
    vaultSaved.item.createdAt === captureUploadAt &&
    vaultAfter.item.deckId === 'TD-06' &&
    vaultAfter.item.side === 'back' &&
    vaultAfter.item.createdAt === captureUploadAt &&
    vaultAfter.item.capturedAt === phoneCaptureAt &&
    vaultAfter.item.capturedAt !== '1999-01-01T00:00:00.000Z' &&
    vaultAfter.item.createdAt !== phoneCaptureAt &&
    vaultAfter.item.gradingReport.centeringAssist.adjustedAt &&
    vaultAfter.item.gradingReport.centeringAssist.adjustedAt !== captureUploadAt,
    vaultAfter.item && {
      deckId: vaultAfter.item.deckId,
      side: vaultAfter.item.side,
      createdAt: vaultAfter.item.createdAt,
      adjustedAt: vaultAfter.item.gradingReport && vaultAfter.item.gradingReport.centeringAssist && vaultAfter.item.gradingReport.centeringAssist.adjustedAt
    });

  const badWarp = await fetch(base + '/api/scans/' + scanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: { left: { positionPx: 40, warpWidth: 100, warpHeight: 100 } } })
  });
  assert('a line on the wrong warp is rejected', badWarp.status === 400);

  const pushCopy = assist.redactReportForEgress(diskReport);
  assert('scan-repo copy of this report has no user millimetres and keeps the engine border',
    pushCopy.centeringAssist.sides.left.userWidthMm === null &&
    pushCopy.centeringAssist.borderWidthsMm.left === null &&
    pushCopy.centeringAssist.borderWidthsMm.right === 2.1 &&
    pushCopy.centeringMetrics.borderWidthsMm.right === 2.1 &&
    pushCopy.centeringAssist.headline === 'Centering (you adjusted 1 side)');

  const engineBefore = JSON.parse(JSON.stringify(diskReport));
  engineBefore.centeringAssist.sides.right.userWidthMm = 9.876;
  engineBefore.centeringAssist.sides.right.kind = 'disagreement';
  engineBefore.centeringAssist.sides.right.source = 'user';
  engineBefore.centeringAssist.borderWidthsMm.right = 9.876;
  engineBefore.centeringAssist.sides.left.userWidthMm = 11.43;
  engineBefore.centeringAssist.borderWidthsMm.left = 11.43;
  const sampleBefore = JSON.stringify(engineBefore.centeringDiagnostics.sampleLines);
  const metricsBefore = JSON.stringify(engineBefore.centeringMetrics);
  const scoresBefore = JSON.stringify({
    subGrades: engineBefore.subGrades,
    finalScore: engineBefore.finalScore,
    centering: engineBefore.centering,
    weighted: engineBefore.weighted,
    engineVersion: engineBefore.engineVersion
  });
  const engineWidthsBefore = JSON.stringify({
    engineBorderWidthsMm: engineBefore.centeringAssist.engineBorderWidthsMm,
    perSide: geo.SIDES.map(function (side) {
      return engineBefore.centeringAssist.sides[side].engineWidthMm;
    })
  });
  const dbBefore = {
    inventory: [{ id: 'assist-test-scan-0001', gradingReport: engineBefore, name: 'Assist test' }],
    centeringExamples: [{ side: 'left', userWidthMm: 11.43, engineWidthMm: null }],
    categoryCounts: { SPORTS: 0, TCG: 0, UNKNOWN: 1 }
  };
  const dbCopy = assist.redactDatabaseForScanRepo(dbBefore);
  const copied = dbCopy.inventory[0].gradingReport;
  assert('engine sample lines, border millimetres, and scores survive the copy byte-for-byte',
    JSON.stringify(copied.centeringDiagnostics.sampleLines) === sampleBefore &&
    JSON.stringify(copied.centeringMetrics) === metricsBefore &&
    JSON.stringify({
      subGrades: copied.subGrades,
      finalScore: copied.finalScore,
      centering: copied.centering,
      weighted: copied.weighted,
      engineVersion: copied.engineVersion
    }) === scoresBefore &&
    JSON.stringify({
      engineBorderWidthsMm: copied.centeringAssist.engineBorderWidthsMm,
      perSide: geo.SIDES.map(function (side) {
        return copied.centeringAssist.sides[side].engineWidthMm;
      })
    }) === engineWidthsBefore);
  const copiedText = JSON.stringify(dbCopy);
  assert('user millimetres and centeringExamples do not survive the copy',
    copied.centeringAssist.sides.left.userWidthMm === null &&
    copied.centeringAssist.sides.right.userWidthMm === null &&
    copied.centeringAssist.borderWidthsMm.left === null &&
    copied.centeringAssist.borderWidthsMm.right === 2.1 &&
    dbCopy.centeringExamples === undefined &&
    copiedText.indexOf('11.43') === -1 &&
    copiedText.indexOf('9.876') === -1);
  assert('a report with no user line is unchanged',
    JSON.stringify(assist.redactReportForEgress(reportWith())) === JSON.stringify(reportWith()));

  const backPosted = await fetch(base + '/api/scans/' + backScanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: {
        left: lineForMm('left', 5.6),
        right: lineForMm('right', 4.4),
        top: lineForMm('top', 5),
        bottom: lineForMm('bottom', 5)
      },
      confirmImplausible: true,
      deckId: 'TD-13',
      side: 'front',
      createdAt: '2026-10-13T13:54:36.000Z'
    })
  }).then(function (r) { return r.json(); });
  assert('re-saving a back keeps TD-06, back, the capture time, and the back table',
    backPosted.ok === true &&
    backPosted.item.deckId === 'TD-06' &&
    backPosted.item.side === 'back' &&
    backPosted.item.gradingReport.side === 'back' &&
    backPosted.item.createdAt === '2026-10-12T20:57:08.000Z' &&
    backPosted.assist.side === 'back' &&
    backPosted.assist.centeringLabel === '10.0 assisted' &&
    backPosted.assist.centering === 10 &&
    backPosted.assist.adjustedAt &&
    backPosted.assist.adjustedAt !== '2026-10-12T20:57:08.000Z',
    backPosted.assist && {
      deckId: backPosted.item.deckId,
      side: backPosted.item.side,
      createdAt: backPosted.item.createdAt,
      label: backPosted.assist.centeringLabel,
      adjustedAt: backPosted.assist.adjustedAt
    });
  const backFlip = await fetch(base + '/api/scans/' + backScanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setSide: 'front' })
  });
  const backFlipBody = await backFlip.json();
  assert('setSide is refused once a scan already has a side',
    backFlip.status === 400 && backFlipBody.ok === false, backFlipBody);

  const unknownPosted = await fetch(base + '/api/scans/' + unknownScanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: { left: lineForMm('left', 4) },
      confirmImplausible: true,
      deckId: 'TD-13',
      side: 'front',
      createdAt: '2026-10-13T13:54:36.000Z'
    })
  }).then(function (r) { return r.json(); });
  assert('POST on a side-less scan does not invent front',
    unknownPosted.ok === true &&
    unknownPosted.item.side == null &&
    unknownPosted.item.gradingReport.side == null &&
    unknownPosted.assist.side == null &&
    unknownPosted.assist.centeringLabel == null &&
    unknownPosted.assist.centering == null &&
    unknownPosted.item.deckId === 'TD-04' &&
    unknownPosted.item.createdAt === '2026-10-11T00:00:00.000Z',
    unknownPosted.item && { side: unknownPosted.item.side, deckId: unknownPosted.item.deckId, label: unknownPosted.assist.centeringLabel });
  const setBack = await fetch(base + '/api/scans/' + unknownScanId + '/centering-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setSide: 'back', deckId: 'TD-13', createdAt: '2026-10-13T13:54:36.000Z' })
  }).then(function (r) { return r.json(); });
  assert('setSide back on a side-less scan scores the back table and keeps the deck and time',
    setBack.ok === true &&
    setBack.item.side === 'back' &&
    setBack.item.gradingReport.side === 'back' &&
    setBack.assist.side === 'back' &&
    setBack.assist.centeringLabel === '10.0 assisted' &&
    setBack.item.deckId === 'TD-04' &&
    setBack.item.createdAt === '2026-10-11T00:00:00.000Z',
    setBack.assist && { side: setBack.item.side, label: setBack.assist.centeringLabel, deckId: setBack.item.deckId });

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
