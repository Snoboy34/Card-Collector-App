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
    left: [3.0, 3.05, 3.1, 3.1, 3.15, 3.2, 3.2],
    right: [2.7, 2.75, 2.8, 2.8, 2.85, 2.9, 2.9],
    top: [2.9, 2.95, 3.0, 3.0, 3.05, 3.1, 3.1],
    bottom: [3.3, 3.35, 3.4, 3.4, 3.45, 3.5, 3.5]
  },
  detected: true
});
assertHint('thin full-frame hint', thinMatHint.hint, 'undetected');

const wideMatHint = g.describeBorderSource({
  imageWidth: 400,
  imageHeight: 560,
  box: { left: 2, right: 397, top: 2, bottom: 557, width: 396, height: 556 },
  widths: { left: 28, right: 30, top: 26, bottom: 32 },
  samples: {
    left: [27.5, 27.8, 28, 28, 28.2, 28.4, 28.5],
    right: [29.5, 29.8, 30, 30, 30.2, 30.3, 30.4],
    top: [25.6, 25.8, 26, 26, 26.1, 26.2, 26.3],
    bottom: [31.5, 31.8, 32, 32, 32.1, 32.2, 32.3]
  },
  detected: true
});
assertHint('wide full-frame hint', wideMatHint.hint, 'likely-printed-frame');

const undetectedHint = g.describeBorderSource({
  imageWidth: 200,
  imageHeight: 280,
  box: { left: 0, right: 199, top: 0, bottom: 279, width: 200, height: 280 },
  widths: { left: null, right: null, top: null, bottom: null },
  detected: false
});
assertHint('undetected hint', undetectedHint.hint, 'undetected');

assertEq('spread threshold is 8px', g.BORDER_SAMPLE_SPREAD_MAX_PX, 8);
assertEq('min hits is 5', g.BORDER_SAMPLE_MIN_HITS, 5);
assertEq('min median width is 12px', g.BORDER_MIN_MEDIAN_WIDTH_PX, 12);

const tightInset = g.assessPrintBorderReliability(
  { left: 80, right: 719, top: 90, bottom: 1009, width: 640, height: 920 },
  800,
  1100,
  {
    detected: true,
    widths: { left: 22.4, right: 18.1, top: 24.0, bottom: 31.2 },
    samples: {
      left: [21, 22, 22.4, 23, 22, 22.5, 22],
      right: [18, 18.2, 18.1, 17.8, 18.4, 18, 18.1],
      top: [23.5, 24, 24.2, 24, 23.8, 24.1, 24],
      bottom: [30.5, 31, 31.4, 31.2, 31, 31.3, 31.1]
    }
  }
);
assert('tight inset frame is accepted', tightInset.accepted === true);

const edgeTouch = g.assessPrintBorderReliability(
  { left: 0, right: 669, top: 128, bottom: 763, width: 670, height: 636 },
  670,
  900,
  {
    detected: true,
    widths: { left: 106.36, right: 110.36, top: 40.42, bottom: 8.83 },
    samples: {
      left: [106, 106.2, 106.3, 106.36, 106.4, 106.5, 106.6],
      right: [110, 110.1, 110.2, 110.36, 110.4, 110.5, 110.6],
      top: [40, 40.2, 40.3, 40.42, 40.5, 40.6, 40.7],
      bottom: [8.5, 8.6, 8.7, 8.83, 8.9, 9.0, 9.1]
    }
  }
);
assert('box touching photo is not enough to reject when samples are tight', edgeTouch.accepted === false);
assert('thin bottom width is rejected', edgeTouch.reasons.join(' ').indexOf('bottom median width') !== -1);

const highSpreadInset = g.assessPrintBorderReliability(
  { left: 70, right: 329, top: 80, bottom: 479, width: 260, height: 400 },
  400,
  560,
  {
    detected: true,
    widths: { left: 105, right: 78, top: 12, bottom: 23 },
    samples: {
      left: [22.75, 75.25, 83, 104.33, 104.97, 104.98, 105.11],
      right: [7.67, 61.19, 73.5, 78, 110.13, 112.03, 158.5],
      top: [3.68, 4.45, 4.6, 6.86, 7, 26.04, 28.23],
      bottom: [3, 4, 5.63, 23.43, 28.99, 67.25, 69.5]
    }
  }
);
assert('high sample spread on an inset box is rejected', highSpreadInset.accepted === false);
assert('high-spread reason mentions consensus', highSpreadInset.reasons.join(' ').indexOf('consensus range') !== -1);

// Real Mac debug payloads — Star Rookie A and Faulk 1 — must now reject.
const starRookieA = g.assessPrintBorderReliability(
  { left: 0, right: 669, top: 128, bottom: 763, width: 670, height: 636 },
  670,
  900,
  {
    detected: true,
    widths: { left: 106.36, right: 110.36, top: 40.42, bottom: 8.83 },
    samples: {
      left: [53.75, 90.33, 104.78, 106.36, 135, 163.13, 308.3],
      right: [8.88, 24, 109.4, 110.36, 130.32, 137.64, 140.42],
      top: [12.35, 19.58, 38.96, 40.42, 43.71, 136.63, 192.88],
      bottom: [3, 3, 4, 8.83, 22.7, 46.71, 80.93]
    }
  }
);
const starRookieHint = g.describeBorderSource({
  imageWidth: 670,
  imageHeight: 900,
  box: { left: 0, right: 669, top: 128, bottom: 763, width: 670, height: 636 },
  widths: { left: 106.36, right: 110.36, top: 40.42, bottom: 8.83 },
  samples: {
    left: [53.75, 90.33, 104.78, 106.36, 135, 163.13, 308.3],
    right: [8.88, 24, 109.4, 110.36, 130.32, 137.64, 140.42],
    top: [12.35, 19.58, 38.96, 40.42, 43.71, 136.63, 192.88],
    bottom: [3, 3, 4, 8.83, 22.7, 46.71, 80.93]
  },
  detected: true
});
assert('Star Rookie A reliability rejected', starRookieA.accepted === false);
assertHint('Star Rookie A hint is undetected', starRookieHint.hint, 'undetected');
assert('Star Rookie A hint is not printed-frame', starRookieHint.hint !== 'likely-printed-frame');

const faulk1 = g.assessPrintBorderReliability(
  { left: 0, right: 669, top: 174, bottom: 757, width: 670, height: 584 },
  670,
  900,
  {
    detected: true,
    widths: { left: 105.28, right: 112.31, top: 12.79, bottom: 23.34 },
    samples: {
      left: [33.5, 98, 104.94, 105.28, 105.34, 105.38, 108.22],
      right: [107.95, 111.06, 111.1, 112.31, 112.43, 173, 383.81],
      top: [11.31, 11.38, 12.74, 12.79, 14.73, 15.11, 16.77],
      bottom: [3, 3, 23.2, 23.34, 28.66, 67.18, 84.75]
    }
  }
);
const faulkHint = g.describeBorderSource({
  imageWidth: 670,
  imageHeight: 900,
  box: { left: 0, right: 669, top: 174, bottom: 757, width: 670, height: 584 },
  widths: { left: 105.28, right: 112.31, top: 12.79, bottom: 23.34 },
  samples: {
    left: [33.5, 98, 104.94, 105.28, 105.34, 105.38, 108.22],
    right: [107.95, 111.06, 111.1, 112.31, 112.43, 173, 383.81],
    top: [11.31, 11.38, 12.74, 12.79, 14.73, 15.11, 16.77],
    bottom: [3, 3, 23.2, 23.34, 28.66, 67.18, 84.75]
  },
  detected: true
});
assert('Faulk 1 reliability rejected', faulk1.accepted === false);
assertHint('Faulk 1 hint is undetected', faulkHint.hint, 'undetected');
assert('Faulk 1 hint is not printed-frame', faulkHint.hint !== 'likely-printed-frame');

// Live follow-up scans (inset box + full-frame box) that still scored on the
// pre-gate LAN process. Both must reject on this branch.
const liveInset = g.assessPrintBorderReliability(
  { left: 103, right: 599, top: 80, bottom: 768, width: 497, height: 689 },
  670,
  900,
  {
    detected: true,
    widths: { left: 27.08, right: 44.16, top: 47.05, bottom: 3 },
    samples: {
      left: [3, 4, 25.5, 27.08, 57.63, 60.25, 200],
      right: [43.47, 43.88, 43.89, 44.16, 44.61, 85.02, 152.75],
      top: [41, 43.63, 46.03, 47.05, 47.38, 47.65, 48.33],
      bottom: [3, 3, 3, 3, 3, 4, 5.17]
    }
  }
);
assert('live inset-box scan rejected on sample spread', liveInset.accepted === false);
assert('live inset-box names left consensus', liveInset.reasons.join(' ').indexOf('left consensus range') !== -1);

const liveFullFrame = g.assessPrintBorderReliability(
  { left: 0, right: 669, top: 0, bottom: 899, width: 670, height: 900 },
  670,
  900,
  {
    detected: true,
    widths: { left: 75.75, right: 108.25, top: 135.38, bottom: 113.17 },
    samples: {
      left: [40, 54.75, 58, 75.75, 92.63, 112, 155.89],
      right: [38.25, 42.5, 107.51, 108.25, 110.5, 127.13, 297.15],
      top: [129.26, 131.34, 132.64, 135.38, 146.58, 150.58, 154],
      bottom: [37.25, 82.25, 95.75, 113.17, 127.81, 128.03, 128.41]
    }
  }
);
assert('live full-frame scan rejected', liveFullFrame.accepted === false);
assert('live full-frame names box.left', liveFullFrame.reasons.join(' ').indexOf('box.left') !== -1);

// Post-gate confirmation scans from the iMac after checkout of this branch.
// Both must stay undetected (no invented CEN).
const postGateScan1 = g.assessPrintBorderReliability(
  { left: 91, right: 669, top: 125, bottom: 899, width: 579, height: 775 },
  670,
  900,
  {
    detected: true,
    widths: { left: 3, right: 105.84, top: 20.64, bottom: 115.08 },
    samples: {
      left: [3, 3, 3, 3, 8.58, 9.47, 17.85],
      right: [10, 79.25, 103.88, 105.84, 106.51, 107.64, 107.96],
      top: [5.94, 9.56, 18.03, 20.64, 48.2, 50, 66.5],
      bottom: [3.58, 76.25, 95.88, 115.08, 115.24, 115.52, 115.62]
    }
  }
);
const postGateHint1 = g.describeBorderSource({
  imageWidth: 670,
  imageHeight: 900,
  box: { left: 91, right: 669, top: 125, bottom: 899, width: 579, height: 775 },
  widths: { left: 3, right: 105.84, top: 20.64, bottom: 115.08 },
  samples: {
    left: [3, 3, 3, 3, 8.58, 9.47, 17.85],
    right: [10, 79.25, 103.88, 105.84, 106.51, 107.64, 107.96],
    top: [5.94, 9.56, 18.03, 20.64, 48.2, 50, 66.5],
    bottom: [3.58, 76.25, 95.88, 115.08, 115.24, 115.52, 115.62]
  },
  detected: true
});
assert('post-gate scan 1 rejected', postGateScan1.accepted === false);
assertHint('post-gate scan 1 hint is undetected', postGateHint1.hint, 'undetected');
assert('post-gate scan 1 names box.right', postGateScan1.reasons.join(' ').indexOf('box.right') !== -1 || postGateScan1.reasons.join(' ').indexOf('consensus range') !== -1);

const postGateScan2 = g.assessPrintBorderReliability(
  { left: 0, right: 669, top: 127, bottom: 899, width: 670, height: 773 },
  670,
  900,
  {
    detected: true,
    widths: { left: 103.8, right: 110.63, top: 15.03, bottom: 136.35 },
    samples: {
      left: [102.11, 102.71, 103.39, 103.8, 103.86, 104.1, 157.24],
      right: [52.45, 52.88, 72.42, 110.63, 112.1, 113.42, 114.82],
      top: [3, 10.63, 14.75, 15.03, 29.61, 40.73, 51.25],
      bottom: [3, 5.41, 19.67, 136.35, 137.03, 137.04, 138.01]
    }
  }
);
const postGateHint2 = g.describeBorderSource({
  imageWidth: 670,
  imageHeight: 900,
  box: { left: 0, right: 669, top: 127, bottom: 899, width: 670, height: 773 },
  widths: { left: 103.8, right: 110.63, top: 15.03, bottom: 136.35 },
  samples: {
    left: [102.11, 102.71, 103.39, 103.8, 103.86, 104.1, 157.24],
    right: [52.45, 52.88, 72.42, 110.63, 112.1, 113.42, 114.82],
    top: [3, 10.63, 14.75, 15.03, 29.61, 40.73, 51.25],
    bottom: [3, 5.41, 19.67, 136.35, 137.03, 137.04, 138.01]
  },
  detected: true
});
assert('post-gate scan 2 rejected', postGateScan2.accepted === false);
assertHint('post-gate scan 2 hint is undetected', postGateHint2.hint, 'undetected');
assert('post-gate scan 2 still rejected without box.left reason', postGateScan2.accepted === false);

// Live white-border card that filled the photo. Full min–max is huge because
// of one right-side outlier and a nameplate step on the left; the 5-hit
// consensus window is ≤ 5.5px and every median width is ~90–127px.
const whiteBorderLive = g.assessPrintBorderReliability(
  { left: 0, right: 669, top: 0, bottom: 899, width: 670, height: 900 },
  670,
  900,
  {
    detected: true,
    widths: { left: 89.53, right: 111.11, top: 124.88, bottom: 127.48 },
    samples: {
      left: [55.58, 60.38, 88.43, 89.53, 91.39, 91.71, 93.88],
      right: [16.56, 108.48, 109.83, 111.11, 111.54, 111.7, 111.99],
      top: [56.75, 83.71, 123.76, 124.88, 125.79, 125.9, 126.24],
      bottom: [125.23, 126.35, 127.05, 127.48, 128.28, 128.63, 129.05]
    }
  }
);
const whiteBorderHint = g.describeBorderSource({
  imageWidth: 670,
  imageHeight: 900,
  box: { left: 0, right: 669, top: 0, bottom: 899, width: 670, height: 900 },
  widths: { left: 89.53, right: 111.11, top: 124.88, bottom: 127.48 },
  samples: {
    left: [55.58, 60.38, 88.43, 89.53, 91.39, 91.71, 93.88],
    right: [16.56, 108.48, 109.83, 111.11, 111.54, 111.7, 111.99],
    top: [56.75, 83.71, 123.76, 124.88, 125.79, 125.9, 126.24],
    bottom: [125.23, 126.35, 127.05, 127.48, 128.28, 128.63, 129.05]
  },
  detected: true
});
assert('white-border uncropped still rejected on photo-edge', whiteBorderLive.accepted === false);
assert('white-border uncropped names box.left', whiteBorderLive.reasons.join(' ').indexOf('box.left') !== -1);
assertHint('white-border uncropped hint is undetected', whiteBorderHint.hint, 'undetected');

const whiteBorderCropped = g.assessPrintBorderReliability(
  { left: 0, right: 669, top: 0, bottom: 899, width: 670, height: 900 },
  670,
  900,
  {
    detected: true,
    widths: { left: 89.53, right: 111.11, top: 124.88, bottom: 127.48 },
    samples: {
      left: [55.58, 60.38, 88.43, 89.53, 91.39, 91.71, 93.88],
      right: [16.56, 108.48, 109.83, 111.11, 111.54, 111.7, 111.99],
      top: [56.75, 83.71, 123.76, 124.88, 125.79, 125.9, 126.24],
      bottom: [125.23, 126.35, 127.05, 127.48, 128.28, 128.63, 129.05]
    }
  },
  { alignmentCrop: true }
);
const whiteBorderCroppedHint = g.describeBorderSource({
  imageWidth: 670,
  imageHeight: 900,
  box: { left: 0, right: 669, top: 0, bottom: 899, width: 670, height: 900 },
  widths: { left: 89.53, right: 111.11, top: 124.88, bottom: 127.48 },
  samples: {
    left: [55.58, 60.38, 88.43, 89.53, 91.39, 91.71, 93.88],
    right: [16.56, 108.48, 109.83, 111.11, 111.54, 111.7, 111.99],
    top: [56.75, 83.71, 123.76, 124.88, 125.79, 125.9, 126.24],
    bottom: [125.23, 126.35, 127.05, 127.48, 128.28, 128.63, 129.05]
  },
  detected: true,
  alignmentCrop: true
});
assert('white-border neon-crop accepted', whiteBorderCropped.accepted === true);
assertHint('white-border neon-crop hint is printed-frame', whiteBorderCroppedHint.hint, 'likely-printed-frame');
assert('white-border left consensus under 8px', whiteBorderCropped.consensusRangePx.left <= 8);
assert('white-border still reports photo-edge contact', whiteBorderCropped.edgeTouchesImage.left === true);

// Live neon-crop still (643×900) where findCardBoundingBox ate the white
// T/B borders (top median 3px). That measurement must stay rejected; the
// engine now re-scans from the crop edges instead of this inset box.
const liveNeonInsetAteBorder = g.assessPrintBorderReliability(
  { left: 0, right: 642, top: 86, bottom: 818, width: 643, height: 733 },
  643,
  900,
  {
    detected: true,
    widths: { left: 57.19, right: 63.05, top: 3.08, bottom: 24.41 },
    samples: {
      left: [53.22, 56.42, 56.79, 57.19, 57.56, 57.66, 57.87],
      right: [50.7, 61.24, 62.26, 63.05, 63.23, 63.71, 64.21],
      top: [3, 3, 3, 3.08, 3.38, 4, 26.67],
      bottom: [3, 4, 15.25, 24.41, 24.83, 25.1, 25.17]
    }
  },
  { alignmentCrop: true }
);
assert('neon-crop inset-box (ate T/B white) rejected', liveNeonInsetAteBorder.accepted === false);
assert('neon-crop inset-box names thin top', liveNeonInsetAteBorder.reasons.join(' ').indexOf('top median width') !== -1);

// First live accepted white-border grade after scanning from the neon-crop
// edges (643×900, box = full JPEG). Must stay accepted.
const liveAcceptedWhiteBorder = g.assessPrintBorderReliability(
  { left: 0, right: 642, top: 0, bottom: 899, width: 643, height: 900 },
  643,
  900,
  {
    detected: true,
    widths: { left: 60.04, right: 66.55, top: 90.6, bottom: 92.23 },
    samples: {
      left: [59.17, 59.46, 59.95, 60.04, 60.3, 64, 64.11],
      right: [24.15, 43.25, 65.07, 66.55, 67.04, 67.04, 67.57],
      top: [88.75, 89.3, 90.06, 90.6, 90.68, 90.69, 91.01],
      bottom: [4.96, 91.48, 92.21, 92.23, 92.38, 92.4, 92.51]
    }
  },
  { alignmentCrop: true }
);
const liveAcceptedHint = g.describeBorderSource({
  imageWidth: 643,
  imageHeight: 900,
  box: { left: 0, right: 642, top: 0, bottom: 899, width: 643, height: 900 },
  widths: { left: 60.04, right: 66.55, top: 90.6, bottom: 92.23 },
  samples: {
    left: [59.17, 59.46, 59.95, 60.04, 60.3, 64, 64.11],
    right: [24.15, 43.25, 65.07, 66.55, 67.04, 67.04, 67.57],
    top: [88.75, 89.3, 90.06, 90.6, 90.68, 90.69, 91.01],
    bottom: [4.96, 91.48, 92.21, 92.23, 92.38, 92.4, 92.51]
  },
  detected: true,
  alignmentCrop: true
});
assert('live accepted white-border reliability', liveAcceptedWhiteBorder.accepted === true);
assertHint('live accepted white-border hint', liveAcceptedHint.hint, 'likely-printed-frame');
assert('live accepted bottom consensus under 8px', liveAcceptedWhiteBorder.consensusRangePx.bottom <= 8);

assert('consensus ignores a single outlier', g.consensusRangePx([16.56, 108.48, 109.83, 111.11, 111.54, 111.7, 111.99], 5) < 4);

const coverWide = scanLevel.videoCoverCrop(1920, 1080, 360, 480);
assert('cover on wide video crops left/right', coverWide.y === 0 && coverWide.x > 0);
const coverTall = scanLevel.videoCoverCrop(1080, 1920, 360, 480);
assert('cover on tall video crops top/bottom', coverTall.x === 0 && coverTall.y > 0);
const aligned = scanLevel.alignmentCropInVideo(1280, 1720, 360, 480);
assert('alignment crop exists', Boolean(aligned && aligned.w > 0 && aligned.h > 0));
assert('alignment crop is card aspect', Math.abs((aligned.w / aligned.h) - scanLevel.CARD_ASPECT) < 0.02);
assert('parseAlignmentCrop true', scanLevel.parseAlignmentCrop({ alignmentCrop: 'true' }) === true);
assert('parseAlignmentCrop missing is false', scanLevel.parseAlignmentCrop({}) === false);

(function assertBrowserScriptsDoNotCollide() {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const scanSrc = fs.readFileSync(path.join(__dirname, '../public/scan_level.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const el = function () {
    return {
      addEventListener: function () {},
      removeEventListener: function () {},
      setAttribute: function () {},
      appendChild: function () {},
      querySelector: function () { return el(); },
      querySelectorAll: function () { return []; },
      getContext: function () { return { clearRect: function () {}, save: function () {}, restore: function () {}, fillRect: function () {}, strokeRect: function () {}, beginPath: function () {}, moveTo: function () {}, lineTo: function () {}, stroke: function () {}, setLineDash: function () {}, setTransform: function () {} }; },
      style: {},
      classList: { toggle: function () {} },
      innerHTML: '',
      textContent: '',
      content: { cloneNode: function () { return el(); } }
    };
  };
  const document = {
    getElementById: function () { return el(); },
    querySelectorAll: function () { return []; },
    createElement: function () { return el(); },
    body: el()
  };
  const windowObj = {
    addEventListener: function () {},
    removeEventListener: function () {},
    location: { hash: '' },
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    devicePixelRatio: 1,
    EventSource: undefined
  };
  windowObj.window = windowObj;
  windowObj.document = document;
  const fetches = [];
  const ctx = {
    window: windowObj,
    document: document,
    location: windowObj.location,
    localStorage: windowObj.localStorage,
    navigator: { mediaDevices: undefined },
    console: console,
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
    setInterval: function () { return 0; },
    clearInterval: function () {},
    requestAnimationFrame: function () { return 0; },
    cancelAnimationFrame: function () {},
    fetch: function (url) {
      fetches.push(String(url));
      return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, inventory: [], stats: {} }); } });
    },
    module: undefined,
    exports: undefined
  };
  try {
    vm.runInNewContext(scanSrc, ctx, { filename: 'scan_level.js' });
  } catch (err) {
    console.error('FAIL scan_level.js in browser context', err && err.message);
    process.exitCode = 1;
    return;
  }
  assert('scan_level does not leak CARD_ASPECT', ctx.CARD_ASPECT === undefined);
  try {
    vm.runInNewContext(appSrc, ctx, { filename: 'app.js' });
  } catch (err) {
    console.error('FAIL app.js after scan_level.js (Safari-style global collision)', err && err.message);
    process.exitCode = 1;
    return;
  }
  assert('app.js sets __judgeBooted after scan_level', ctx.window.__judgeBooted === true);
  assert('ScanLevel is on window only', Boolean(ctx.window.ScanLevel && ctx.window.ScanLevel.cardFrameRect));
})();

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

/** Full-width "card" with letterboxed gray top/bottom and interior art panels.
 *  Box should touch left/right of the photo — without the reliability gate
 *  the inward scan would invent ~100px "borders" from the art. */
async function makeFullBleedArtPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const letter = 80;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (y < letter || y >= height - letter) {
        buf[i] = 140; buf[i + 1] = 140; buf[i + 2] = 140;
      } else if (x < 110) {
        buf[i] = 20; buf[i + 1] = 20; buf[i + 2] = 20;
      } else if (x > width - 110) {
        buf[i] = 20; buf[i + 1] = 20; buf[i + 2] = 20;
      } else {
        buf[i] = 200; buf[i + 1] = 210; buf[i + 2] = 230;
      }
    }
  }
  return sharpLib(buf, {
    raw: { width: width, height: height, channels: channels }
  }).png().toBuffer();
}

/** Pink mat + inset full-bleed art whose contrast edge slopes, so the 7
 *  sample lines disagree by tens of pixels on an otherwise inset box. */
async function makeHighSpreadInsetPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      buf[i] = 236; buf[i + 1] = 72; buf[i + 2] = 153;
    }
  }
  const card = { left: 70, right: 329, top: 80, bottom: 479 };
  const cardH = card.bottom - card.top;
  for (let y = card.top; y <= card.bottom; y++) {
    const relY = (y - card.top) / cardH;
    const split = card.left + 10 + Math.round(relY * 140);
    for (let x = card.left; x <= card.right; x++) {
      const i = (y * width + x) * channels;
      if (x < split) {
        buf[i] = 20; buf[i + 1] = 24; buf[i + 2] = 40;
      } else {
        buf[i] = 220; buf[i + 1] = 220; buf[i + 2] = 230;
      }
    }
  }
  return sharpLib(buf, {
    raw: { width: width, height: height, channels: channels }
  }).png().toBuffer();
}

function assertUndetectedNoFrameHint(label, report) {
  assert(label + ' centeringUndetected', report.centeringUndetected === true);
  assert(label + ' printCenteringDetected false', report.printCenteringDetected === false);
  assert(label + ' incomplete', report.incomplete === true);
  assert(label + ' centering is null', report.centering === null);
  assert(label + ' finalScore is not a number', typeof report.finalScore !== 'number');
  assert(label + ' ratios are null', report.centeringMetrics && report.centeringMetrics.leftRightRatio === null);
  const hint = report.centeringDiagnostics && report.centeringDiagnostics.hint;
  assert(label + ' hint is not printed-frame', hint !== 'likely-printed-frame');
  assert(label + ' hint is undetected', hint === 'undetected');
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
    assert('bordered-card reliability accepted',
      report.centeringDiagnostics.borderReliability &&
      report.centeringDiagnostics.borderReliability.accepted === true);
  } else {
    console.error('FAIL bordered-card should detect a printed frame', report.centeringDiagnostics);
    process.exitCode = 1;
  }
}

async function runEdgeTouchBleedCheck() {
  const buf = await makeFullBleedArtPng();
  if (!buf) {
    console.log('SKIP full-bleed edge-touch check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 560, debug: true });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP full-bleed edge-touch check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL full-bleed threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  assertUndetectedNoFrameHint('full-bleed', report);
  const box = report.debug && report.debug.box;
  assert('full-bleed box touches a photo edge',
    box && (box.left <= 0 || box.right >= (report.debug.width - 1) ||
      box.top <= 0 || box.bottom >= (report.debug.height - 1)));
}

/** Full-frame white-border card (no mat). BBox often eats the white T/B
 *  as background; alignmentCrop must still measure from the JPEG edges. */
async function makeFullFrameWhiteBorderPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const border = 24;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const inFrame = x < border || x >= width - border || y < border || y >= height - border;
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

async function runFullFrameWhiteBorderCropCheck() {
  const buf = await makeFullFrameWhiteBorderPng();
  if (!buf) {
    console.log('SKIP full-frame white-border crop check (sharp not installed)');
    return;
  }
  const cropped = await g.gradeBuffer(buf, { maxDim: 560, debug: true, alignmentCrop: true });
  if (cropped.notes && String(cropped.notes).indexOf('sharp') !== -1) {
    console.log('SKIP full-frame white-border crop check (sharp not installed)');
    return;
  }
  if (cropped.notes && String(cropped.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL full-frame white-border threw:', cropped.notes);
    process.exitCode = 1;
    return;
  }
  const box = cropped.debug && cropped.debug.box;
  assert('alignment-crop box is the full JPEG',
    box && box.left === 0 && box.top === 0 &&
    box.right === cropped.debug.width - 1 &&
    box.bottom === cropped.debug.height - 1);
  assert('alignment-crop white-border detected', cropped.printCenteringDetected === true);
  assert('alignment-crop white-border complete', cropped.incomplete === false);
  assert('alignment-crop white-border has CEN', typeof cropped.subGrades.centering === 'number');
  const topW = cropped.centeringDiagnostics && cropped.centeringDiagnostics.printBorderWidths
    ? cropped.centeringDiagnostics.printBorderWidths.top
    : 0;
  assert('alignment-crop top width is the white frame, not 3px AA', topW >= 12);
  assertHint('alignment-crop hint is printed-frame', cropped.centeringDiagnostics.hint, 'likely-printed-frame');
}

async function runHighSpreadInsetCheck() {
  const buf = await makeHighSpreadInsetPng();
  if (!buf) {
    console.log('SKIP high-spread inset check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 560, debug: true });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP high-spread inset check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL high-spread inset threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  assertUndetectedNoFrameHint('high-spread inset', report);
}

runGradeBufferUndetectedCheck().then(function () {
  return runBorderedCardDiagnosticsCheck();
}).then(function () {
  return runEdgeTouchBleedCheck();
}).then(function () {
  return runHighSpreadInsetCheck();
}).then(function () {
  return runFullFrameWhiteBorderCropCheck();
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

