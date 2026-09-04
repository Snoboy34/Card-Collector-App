/**
 * scripts/verify_judge_math.js
 * Regression checks for the 4-phase Judge formula and the 0.5-point ceiling.
 * Run: node scripts/verify_judge_math.js
 */
'use strict';
const g = require('../services/grading_engine');
const scanLevel = require('../public/scan_level');

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    console.error('FAIL', label, 'got', actual, 'expected', expected);
    process.exitCode = 1;
  } else {
    console.log('PASS', label, actual);
  }
}

const pristineCentering = {
  leftRightRatio: { left: 50, right: 50 },
  topBottomRatio: { top: 50, bottom: 50 }
};
const cleanSurface = {
  scratchCount: 0,
  dimpleOrDentCount: 0,
  surfaceCreaseDetected: false,
  wrinkleOrCreaseSeverity: 0
};
const perfectCorners = {
  topLeftFrayingSeverity: 0,
  topRightFrayingSeverity: 0,
  bottomLeftFrayingSeverity: 0,
  bottomRightFrayingSeverity: 0
};

const pristine = g.evaluateMultiPhaseCondition(pristineCentering, cleanSurface, 0, perfectCorners);
assertEq('pristine finalScore', pristine.finalScore, 10);
assertEq('pristine isGemMint', pristine.isGemMint, true);
assertEq('pristine ceiling', pristine.conditionCeilingApplied, false);

// 2 scratches → surface 10 - 1.0 = 9.0; avg 9.75; ceiling 9.5; round 9.5
const twoScratch = g.evaluateMultiPhaseCondition(
  pristineCentering,
  Object.assign({}, cleanSurface, { scratchCount: 2 }),
  0,
  perfectCorners
);
assertEq('2-scratch finalScore (ceiling 9.5)', twoScratch.finalScore, 9.5);
assertEq('2-scratch ceiling applied', twoScratch.conditionCeilingApplied, true);
assertEq('2-scratch surface sub', twoScratch.subGrades.surface, 9.0);

// Crease severity 2 → penalty max(2,2)*1.5 = 3 → surface 7.0; avg 9.25; ceiling 7.5
const crease = g.evaluateMultiPhaseCondition(
  pristineCentering,
  Object.assign({}, cleanSurface, { surfaceCreaseDetected: true, wrinkleOrCreaseSeverity: 2 }),
  0,
  perfectCorners
);
assertEq('crease finalScore (ceiling 7.5)', crease.finalScore, 7.5);
assertEq('crease surface sub', crease.subGrades.surface, 7.0);

// Corner fray 3 → 6.5; avg 9.125; ceiling 7.0; round 7.0
const corner3 = g.evaluateMultiPhaseCondition(
  pristineCentering,
  cleanSurface,
  0,
  Object.assign({}, perfectCorners, { topLeftFrayingSeverity: 3 })
);
assertEq('corner-3 finalScore (ceiling 7.0)', corner3.finalScore, 7.0);
assertEq('corner-3 corners sub', corner3.subGrades.corners, 6.5);

// 1 edge whitening → 9.0; avg 9.75; ceiling 9.5
const oneEdge = g.evaluateMultiPhaseCondition(pristineCentering, cleanSurface, 1, perfectCorners);
assertEq('1-edge finalScore (ceiling 9.5)', oneEdge.finalScore, 9.5);
assertEq('1-edge edges sub', oneEdge.subGrades.edges, 9.0);

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL', label);
    process.exitCode = 1;
  } else {
    console.log('PASS', label);
  }
}

// Failed inward scans (flat field = no sustained border) must not look like 50/50.
const flatPixel = function () { return 128; };
const undetected = g.measurePrintCentering(flatPixel, 200, 280);
assert('flat-field detected is false', undetected.detected === false);
assert('flat-field leftRightRatio is null', undetected.leftRightRatio === null);
assert('flat-field topBottomRatio is null', undetected.topBottomRatio === null);

async function makeTinyUniformPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  // 20×24 so each inward scanLength is ≤ 12 and scanLineForBorder returns null
  // on every edge — a synthetic "no printed border" still.
  return sharpLib({
    create: {
      width: 20,
      height: 24,
      channels: 3,
      background: { r: 140, g: 140, b: 140 }
    }
  }).png().toBuffer();
}

async function runGradeBufferUndetectedCheck() {
  const buf = await makeTinyUniformPng();
  if (!buf) {
    console.log('SKIP gradeBuffer undetected check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 24 });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP gradeBuffer undetected check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL gradeBuffer threw before metrology:', report.notes);
    process.exitCode = 1;
    return;
  }
  assert('gradeBuffer centeringUndetected', report.centeringUndetected === true);
  assert('gradeBuffer incomplete', report.incomplete === true);
  assert('gradeBuffer centering is null', report.centering === null);
  assert('gradeBuffer subGrades.centering is null', report.subGrades && report.subGrades.centering === null);
  assert('gradeBuffer finalScore is not 10', report.finalScore !== 10 && report.finalScore !== 10.0);
  assert('gradeBuffer finalScore is not a number', typeof report.finalScore !== 'number');
  assert('gradeBuffer weighted is not a number', typeof report.weighted !== 'number');
  assert('gradeBuffer still reports surface', typeof report.subGrades.surface === 'number');
  assert('gradeBuffer still reports edges', typeof report.subGrades.edges === 'number');
  assert('gradeBuffer still reports corners', typeof report.subGrades.corners === 'number');
}

function assertHint(label, actual, expected) {
  assertEq(label, actual, expected);
}

const printedFrameHint = g.describeBorderSource({
  imageWidth: 800,
  imageHeight: 1100,
  box: { left: 80, right: 719, top: 90, bottom: 1009, width: 640, height: 920 },
  widths: { left: 22.4, right: 18.1, top: 24.0, bottom: 31.2 },
  samples: {
    left: [21, 22, 22.4, 23, 22, 22.5, 22],
    right: [18, 18.2, 18.1, 17.8, 18.4, 18, 18.1],
    top: [23.5, 24, 24.2, 24, 23.8, 24.1, 24],
    bottom: [30.5, 31, 31.4, 31.2, 31, 31.3, 31.1]
  },
  detected: true
});
assertHint('printed-frame hint', printedFrameHint.hint, 'likely-printed-frame');
assert('printed-frame box is inset', printedFrameHint.boxFillRatio < 0.9);

const thinMatHint = g.describeBorderSource({
  imageWidth: 800,
  imageHeight: 1100,
  box: { left: 4, right: 795, top: 4, bottom: 1095, width: 792, height: 1092 },
  widths: { left: 3.1, right: 2.8, top: 3.0, bottom: 3.4 },
  samples: {
    left: [3, 3.1, 3.2],
    right: [2.7, 2.8, 2.9],
    top: [2.9, 3.0, 3.1],
    bottom: [3.3, 3.4, 3.5]
  },
  detected: true
});
assertHint('thin full-frame hint', thinMatHint.hint, 'likely-backdrop');

const wideMatHint = g.describeBorderSource({
  imageWidth: 400,
  imageHeight: 560,
  box: { left: 2, right: 397, top: 2, bottom: 557, width: 396, height: 556 },
  widths: { left: 28, right: 30, top: 26, bottom: 32 },
  detected: true
});
assertHint('wide full-frame hint', wideMatHint.hint, 'likely-backdrop');

const undetectedHint = g.describeBorderSource({
  imageWidth: 200,
  imageHeight: 280,
  box: { left: 0, right: 199, top: 0, bottom: 279, width: 200, height: 280 },
  widths: { left: null, right: null, top: null, bottom: null },
  detected: false
});
assertHint('undetected hint', undetectedHint.hint, 'undetected');

assert('level: 0/0 is level', scanLevel.isDeviceLevel(0, 0) === true);
assert('level: 1.4/1.4 is level', scanLevel.isDeviceLevel(1.4, 1.4) === true);
assert('level: 1.6 pitch is not level', scanLevel.isDeviceLevel(1.6, 0) === false);
assert('level: 1.6 roll is not level', scanLevel.isDeviceLevel(0, 1.6) === false);
assert('level: null is not level', scanLevel.isDeviceLevel(null, 0) === false);

const mapped = scanLevel.orientationFromDeviceEvent({ beta: 4.2, gamma: -1.1 });
assert('orientation maps beta to pitch', mapped && mapped.pitch === 4.2);
assert('orientation maps gamma to roll', mapped && mapped.roll === -1.1);

const sm = scanLevel.pushSmoothedSample([], 10, 0, 5);
const sm2 = scanLevel.pushSmoothedSample(sm.samples, 0, 0, 5);
assert('smooth averages two samples', Math.abs(sm2.pitch - 5) < 0.001);

assert('auto-capture rejects 100ms pass-through', scanLevel.shouldAutoCapture(true, 100, false) === false);
assert('auto-capture fires at 400ms hold', scanLevel.shouldAutoCapture(true, 400, false) === true);
assert('auto-capture does not re-fire', scanLevel.shouldAutoCapture(true, 800, true) === false);

const parsedTilt = scanLevel.parseCaptureTilt({
  capturePitch: '0.42',
  captureRoll: '-1.08',
  captureLevel: 'true',
  captureMode: 'auto'
});
assert('parseCaptureTilt pitch', parsedTilt && parsedTilt.pitchDeg === 0.42);
assert('parseCaptureTilt roll', parsedTilt && parsedTilt.rollDeg === -1.08);
assert('parseCaptureTilt mode', parsedTilt && parsedTilt.mode === 'auto');
assert('parseCaptureTilt empty is null', scanLevel.parseCaptureTilt({}) == null);

const bubble = scanLevel.bubbleOffset(0, 12, 28, 12);
assert('bubble roll moves X', bubble.x === 28 && bubble.y === 0);
const bubblePitch = scanLevel.bubbleOffset(12, 0, 28, 12);
assert('bubble pitch moves Y', bubblePitch.x === 0 && bubblePitch.y === 28);

async function makeBorderedCardPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  // Pink mat + inset card with a real ~20px white printed frame.
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      buf[i] = 236; buf[i + 1] = 72; buf[i + 2] = 153; // pink mat
    }
  }
  const card = { left: 70, right: 329, top: 80, bottom: 479 };
  const border = 20;
  for (let y = card.top; y <= card.bottom; y++) {
    for (let x = card.left; x <= card.right; x++) {
      const i = (y * width + x) * channels;
      const inFrame =
        x < card.left + border || x > card.right - border ||
        y < card.top + border || y > card.bottom - border;
      if (inFrame) {
        buf[i] = 245; buf[i + 1] = 245; buf[i + 2] = 245;
      } else {
        buf[i] = 20; buf[i + 1] = 46; buf[i + 2] = 110;
      }
    }
  }
  return sharpLib(buf, {
    raw: { width: width, height: height, channels: channels }
  }).png().toBuffer();
}

async function runBorderedCardDiagnosticsCheck() {
  const buf = await makeBorderedCardPng();
  if (!buf) {
    console.log('SKIP bordered-card diagnostics check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, {
    maxDim: 560,
    debug: true,
    captureTilt: { pitchDeg: 0.4, rollDeg: -0.2, isLevel: true, mode: 'auto' }
  });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP bordered-card diagnostics check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL bordered-card diagnostics threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  assert('bordered-card has centeringDiagnostics', report.centeringDiagnostics != null);
  assert('bordered-card debug has box', report.debug && report.debug.box != null);
  assert('bordered-card debug has printBorderWidths', report.debug && report.debug.printBorderWidths != null);
  assert('bordered-card captureTilt mode', report.captureTilt && report.captureTilt.mode === 'auto');
  assert('bordered-card debug captureTilt pitch', report.debug.captureTilt && report.debug.captureTilt.pitchDeg === 0.4);
  if (report.printCenteringDetected) {
    assert('bordered-card hint is printed-frame', report.centeringDiagnostics.hint === 'likely-printed-frame');
    assert('bordered-card avgWidthPx is tens of pixels', report.centeringDiagnostics.avgWidthPx >= 12);
    assert('bordered-card box is inset', report.centeringDiagnostics.boxFillRatio < 0.85);
  } else {
    console.error('FAIL bordered-card should detect a printed frame', report.centeringDiagnostics);
    process.exitCode = 1;
  }
}

runGradeBufferUndetectedCheck().then(function () {
  return runBorderedCardDiagnosticsCheck();
}).then(function () {
  if (process.exitCode) {
    console.error('Judge math regression failed.');
  } else {
    console.log('All Judge math checks passed.');
  }
}).catch(function (err) {
  console.error('FAIL gradeBuffer undetected check threw', err && err.message);
  process.exitCode = 1;
});

