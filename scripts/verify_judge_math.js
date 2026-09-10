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

assertEq('spread threshold is 12px', g.BORDER_SAMPLE_SPREAD_MAX_PX, 12);
assertEq('min hits is 5', g.BORDER_SAMPLE_MIN_HITS, 5);
assertEq('min median width is 12px', g.BORDER_MIN_MEDIAN_WIDTH_PX, 12);
assertEq('paper-white band floor is 165', g.WHITE_BAND_MIN_GREY, 165);

const brightBandVsDarkArt = g.describeBandVsInterior(
  { left: 200, right: 198, top: 204, bottom: 196 },
  { mean: 80, p50: 78, p95: 110, max: 140, glareFrac: 0, sampleCount: 100 }
);
assert('diagnostic ratio min is > 2 for white-on-dark', brightBandVsDarkArt.min > 2);
assert('diagnostic does not invent an accept flag', brightBandVsDarkArt.accepted === undefined);

const darkBandVsBrightArt = g.describeBandVsInterior(
  { left: 70, right: 74, top: 66, bottom: 72 },
  { mean: 140, p50: 138, p95: 200, max: 240, glareFrac: 0.1, sampleCount: 100 }
);
assert('diagnostic ratio min is < 1 for dark-on-bright', darkBandVsBrightArt.min < 1);

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
assert('live accepted bottom consensus under 12px', liveAcceptedWhiteBorder.consensusRangePx.bottom <= 12);

// Live neon-crop #2 — Star Rookie (borderless). Geometry alone looks like a
// printed frame (top consensus 11.17px, widths ~63–91px). That is a photo
// inset, not ink. Flat-ink nameplate wobble of the same size must still pass.
const starRookieGeometry = {
  detected: true,
  widths: { left: 66.91, right: 63.31, top: 88.18, bottom: 90.61 },
  samples: {
    left: [59.44, 65.06, 66.01, 66.91, 67.52, 68.35, 72.05],
    right: [62.92, 62.98, 63.13, 63.31, 63.47, 63.53, 135.25],
    top: [85.26, 87.29, 87.71, 88.18, 96.43, 106.25, 120.03],
    bottom: [88.29, 89.47, 89.69, 90.61, 90.63, 90.75, 92.13]
  }
};
const starRookieBox = { left: 0, right: 642, top: 0, bottom: 899, width: 643, height: 900 };
const starRookieGeometryOnly = g.assessPrintBorderReliability(
  starRookieBox, 643, 900, starRookieGeometry, { alignmentCrop: true }
);
assert('Star Rookie geometry alone would accept at 12px', starRookieGeometryOnly.accepted === true);
assert('Star Rookie top consensus is 11.17', Math.abs(starRookieGeometryOnly.consensusRangePx.top - 11.17) < 0.02);

const starRookieNavy = g.assessPrintBorderReliability(
  starRookieBox,
  643,
  900,
  Object.assign({}, starRookieGeometry, {
    bandStddev: { left: 8.47, right: 3.91, top: 10.5, bottom: 3.5 },
    paperBandMean: { left: 72, right: 81, top: 64, bottom: 78 }
  }),
  { alignmentCrop: true }
);
const starRookieNavyHint = g.describeBorderSource({
  imageWidth: 643,
  imageHeight: 900,
  box: starRookieBox,
  widths: starRookieGeometry.widths,
  samples: starRookieGeometry.samples,
  bandStddev: { left: 8.47, right: 3.91, top: 10.5, bottom: 3.5 },
  paperBandMean: { left: 72, right: 81, top: 64, bottom: 78 },
  detected: true,
  alignmentCrop: true
});
assert('Star Rookie navy surround rejected', starRookieNavy.accepted === false);
assert('Star Rookie names not a white printed frame', starRookieNavy.reasons.join(' ').indexOf('not a white printed frame') !== -1);
assertHint('Star Rookie navy hint is undetected', starRookieNavyHint.hint, 'undetected');

const flatInkNameplate = g.assessPrintBorderReliability(
  starRookieBox,
  643,
  900,
  Object.assign({}, starRookieGeometry, {
    bandStddev: { left: 4.1, right: 3.6, top: 5.2, bottom: 3.9 },
    paperBandMean: { left: 228, right: 224, top: 231, bottom: 226 }
  }),
  { alignmentCrop: true }
);
assert('flat-ink nameplate still accepted at 12px', flatInkNameplate.accepted === true);

// Live neon-crop #3 — Marshall Faulk (borderless). Geometry already agreed
// inside 8px (top consensus 4.58) and scored CEN 9.0. Paper-white must reject it.
const faulkGeometry = {
  detected: true,
  widths: { left: 68.41, right: 59.74, top: 96.43, bottom: 84.03 },
  samples: {
    left: [65.3, 67, 67.24, 68.41, 68.49, 73.52, 129.34],
    right: [57.5, 58.26, 59.44, 59.74, 61.21, 61.72, 130.75],
    top: [36.75, 94, 94.71, 96.43, 98, 98.58, 112.54],
    bottom: [83.39, 83.55, 83.63, 84.03, 84.3, 84.43, 84.7]
  }
};
const faulkBox = { left: 0, right: 642, top: 0, bottom: 899, width: 643, height: 900 };
const faulkGeometryOnly = g.assessPrintBorderReliability(
  faulkBox, 643, 900, faulkGeometry, { alignmentCrop: true }
);
assert('Faulk geometry alone would accept', faulkGeometryOnly.accepted === true);

const faulkNavy = g.assessPrintBorderReliability(
  faulkBox,
  643,
  900,
  Object.assign({}, faulkGeometry, {
    bandStddev: { left: 4.24, right: 4.45, top: 3.18, bottom: 2.11 },
    paperBandMean: { left: 68, right: 74, top: 61, bottom: 70 }
  }),
  { alignmentCrop: true }
);
const faulkNavyHint = g.describeBorderSource({
  imageWidth: 643,
  imageHeight: 900,
  box: faulkBox,
  widths: faulkGeometry.widths,
  samples: faulkGeometry.samples,
  bandStddev: { left: 4.24, right: 4.45, top: 3.18, bottom: 2.11 },
  paperBandMean: { left: 68, right: 74, top: 61, bottom: 70 },
  detected: true,
  alignmentCrop: true
});
assert('Faulk navy surround rejected', faulkNavy.accepted === false);
assertHint('Faulk navy hint is undetected', faulkNavyHint.hint, 'undetected');
assert('Faulk hint is not printed-frame', faulkNavyHint.hint !== 'likely-printed-frame');

// iMac confirmation trio (Faulk, then Star Rookie, then the real white-border).
// The live Node log still printed threshold=8px and omitted bandStddev — that
// process is older than this branch. These payloads must keep the same
// accept/reject on the 12px + texture gate.
const liveConfirmBox = { left: 0, right: 642, top: 0, bottom: 899, width: 643, height: 900 };
const liveConfirmFaulk = g.assessPrintBorderReliability(
  liveConfirmBox,
  643,
  900,
  {
    detected: true,
    widths: { left: 59.1, right: 66.82, top: 83.31, bottom: 91.75 },
    samples: {
      left: [56.18, 57.19, 57.87, 59.1, 59.52, 65.73, 121.41],
      right: [64.01, 66.29, 66.37, 66.82, 67.51, 69, 96.63],
      top: [35.83, 67.13, 81.6, 83.31, 84.28, 88.55, 99.03],
      bottom: [83.25, 91.42, 91.72, 91.75, 92.14, 92.5, 93.56]
    }
  },
  { alignmentCrop: true }
);
assert('live confirm Faulk rejected', liveConfirmFaulk.accepted === false);
assert('live confirm Faulk top consensus is 17.44', Math.abs(liveConfirmFaulk.consensusRangePx.top - 17.44) < 0.02);

const liveConfirmStarRookie = g.assessPrintBorderReliability(
  liveConfirmBox,
  643,
  900,
  {
    detected: true,
    widths: { left: 58.21, right: 64.96, top: 87.85, bottom: 86.88 },
    samples: {
      left: [55.33, 57.58, 58.09, 58.21, 58.24, 58.43, 115.63],
      right: [62.19, 62.97, 63.25, 64.96, 65.62, 138, 138.63],
      top: [78.17, 78.44, 83.05, 87.85, 91.13, 100.03, 111.48],
      bottom: [86.01, 86.57, 86.88, 86.88, 87.55, 87.98, 88.1]
    }
  },
  { alignmentCrop: true }
);
assert('live confirm Star Rookie rejected', liveConfirmStarRookie.accepted === false);
assert('live confirm Star Rookie top consensus is 12.95', Math.abs(liveConfirmStarRookie.consensusRangePx.top - 12.95) < 0.02);

const liveConfirmWhiteBorder = g.assessPrintBorderReliability(
  liveConfirmBox,
  643,
  900,
  {
    detected: true,
    widths: { left: 57.32, right: 61.12, top: 82.43, bottom: 84.89 },
    samples: {
      left: [52.83, 52.94, 54.13, 57.32, 57.62, 58.14, 58.36],
      right: [12.25, 59.23, 60.21, 61.12, 61.98, 62.49, 62.55],
      top: [33.58, 81.2, 81.27, 82.43, 83.06, 83.63, 83.95],
      bottom: [83.95, 84.22, 84.27, 84.89, 85, 85.1, 85.32]
    }
  },
  { alignmentCrop: true }
);
const liveConfirmWhiteHint = g.describeBorderSource({
  imageWidth: 643,
  imageHeight: 900,
  box: liveConfirmBox,
  widths: { left: 57.32, right: 61.12, top: 82.43, bottom: 84.89 },
  samples: {
    left: [52.83, 52.94, 54.13, 57.32, 57.62, 58.14, 58.36],
    right: [12.25, 59.23, 60.21, 61.12, 61.98, 62.49, 62.55],
    top: [33.58, 81.2, 81.27, 82.43, 83.06, 83.63, 83.95],
    bottom: [83.95, 84.22, 84.27, 84.89, 85, 85.1, 85.32]
  },
  detected: true,
  alignmentCrop: true
});
assert('live confirm white-border accepted', liveConfirmWhiteBorder.accepted === true);
assertHint('live confirm white-border hint', liveConfirmWhiteHint.hint, 'likely-printed-frame');
assert('live confirm white-border left consensus under 8px', liveConfirmWhiteBorder.consensusRangePx.left <= 8);

// 12px + texture-gate rescans. Faulk agreed and was flat (CEN 8.0). Star
// Rookie still failed top consensus. The real white-border failed the
// inverted stddev cap (left 18.32). That payload must accept again; Faulk
// must reject once paper-white means are present.
const live12FaulkGeometry = {
  detected: true,
  widths: { left: 57.79, right: 65.56, top: 77.75, bottom: 95.58 },
  samples: {
    left: [51.19, 56.31, 57, 57.79, 58.84, 59.7, 121.09],
    right: [60.53, 64.13, 64.41, 65.56, 65.6, 98.67, 248],
    top: [69.13, 74.67, 75.91, 77.75, 78.64, 83.25, 84.45],
    bottom: [95.11, 95.28, 95.57, 95.58, 95.58, 95.61, 95.95]
  },
  bandStddev: { left: 4.24, right: 4.45, top: 3.18, bottom: 2.11 }
};
const live12FaulkFlat = g.assessPrintBorderReliability(
  liveConfirmBox, 643, 900, live12FaulkGeometry, { alignmentCrop: true }
);
assert('live 12px Faulk geometry+flat band would accept', live12FaulkFlat.accepted === true);
const live12FaulkPaper = g.assessPrintBorderReliability(
  liveConfirmBox,
  643,
  900,
  Object.assign({}, live12FaulkGeometry, {
    paperBandMean: { left: 71, right: 79, top: 66, bottom: 74 }
  }),
  { alignmentCrop: true }
);
assert('live 12px Faulk paper-white rejected', live12FaulkPaper.accepted === false);

const live12StarRookie = g.assessPrintBorderReliability(
  liveConfirmBox,
  643,
  900,
  {
    detected: true,
    widths: { left: 61.07, right: 65.29, top: 92.33, bottom: 84.9 },
    samples: {
      left: [59.62, 60.58, 60.98, 61.07, 61.26, 66.6, 293.07],
      right: [62.47, 62.88, 65.25, 65.29, 65.43, 65.95, 94.5],
      top: [83.75, 84.94, 85, 92.33, 98.33, 99.51, 101.83],
      bottom: [4, 84.46, 84.79, 84.9, 84.98, 85.84, 86.15]
    },
    bandStddev: { left: 8.47, right: 3.91, top: 10.5, bottom: 3.5 }
  },
  { alignmentCrop: true }
);
assert('live 12px Star Rookie rejected on top consensus', live12StarRookie.accepted === false);
assert('live 12px Star Rookie top consensus is 14.58', Math.abs(live12StarRookie.consensusRangePx.top - 14.58) < 0.02);

const live12WhiteBorder = g.assessPrintBorderReliability(
  liveConfirmBox,
  643,
  900,
  {
    detected: true,
    widths: { left: 61.01, right: 62.15, top: 77.88, bottom: 94.19 },
    samples: {
      left: [54.44, 54.74, 60.37, 61.01, 61.12, 61.27, 61.29],
      right: [8, 61.45, 61.75, 62.15, 62.51, 62.54, 62.55],
      top: [76.11, 76.53, 77.39, 77.88, 78.36, 79.13, 79.2],
      bottom: [3.78, 17.61, 93.24, 94.19, 94.26, 94.26, 94.47]
    },
    bandStddev: { left: 18.32, right: 3.77, top: 3.86, bottom: 3.41 },
    paperBandMean: { left: 198, right: 214, top: 206, bottom: 201 }
  },
  { alignmentCrop: true }
);
const live12WhiteHint = g.describeBorderSource({
  imageWidth: 643,
  imageHeight: 900,
  box: liveConfirmBox,
  widths: { left: 61.01, right: 62.15, top: 77.88, bottom: 94.19 },
  samples: {
    left: [54.44, 54.74, 60.37, 61.01, 61.12, 61.27, 61.29],
    right: [8, 61.45, 61.75, 62.15, 62.51, 62.54, 62.55],
    top: [76.11, 76.53, 77.39, 77.88, 78.36, 79.13, 79.2],
    bottom: [3.78, 17.61, 93.24, 94.19, 94.26, 94.26, 94.47]
  },
  bandStddev: { left: 18.32, right: 3.77, top: 3.86, bottom: 3.41 },
  paperBandMean: { left: 198, right: 214, top: 206, bottom: 201 },
  detected: true,
  alignmentCrop: true
});
assert('live 12px white-border accepted despite left stddev 18.32', live12WhiteBorder.accepted === true);
assertHint('live 12px white-border hint', live12WhiteHint.hint, 'likely-printed-frame');

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

assert('sweep: level matches near 0/0', scanLevel.matchSweepBin(0.2, -0.4) === 'level');
assert('sweep: +12 pitch is pitchPlus', scanLevel.matchSweepBin(12, 0.5) === 'pitchPlus');
assert('sweep: -12 pitch is pitchMinus', scanLevel.matchSweepBin(-12, 0) === 'pitchMinus');
assert('sweep: +12 roll is rollPlus', scanLevel.matchSweepBin(0.3, 12) === 'rollPlus');
assert('sweep: -12 roll is rollMinus', scanLevel.matchSweepBin(1, -12) === 'rollMinus');
assert('sweep: diagonal is not a bin', scanLevel.matchSweepBin(12, 12) === null);
assert('sweep: 6° is between bins', scanLevel.matchSweepBin(6, 0) === null);
assert('sweep hold 100ms is not enough', scanLevel.shouldGrabSweepBin(true, 100, false) === false);
assert('sweep hold 250ms grabs', scanLevel.shouldGrabSweepBin(true, 250, false) === true);
assert('sweep does not re-grab', scanLevel.shouldGrabSweepBin(true, 400, true) === false);
assert('next after level is pitchPlus', scanLevel.nextSweepBin(['level']).id === 'pitchPlus');
assert('next after four angled is null', scanLevel.nextSweepBin(['level', 'pitchPlus', 'pitchMinus', 'rollPlus', 'rollMinus']) === null);
assert('parseSweepMeta json', scanLevel.parseSweepMeta({
  sweepMeta: JSON.stringify([{ bin: 'pitchPlus', pitch: 11.8, roll: 0.2 }])
})[0].bin === 'pitchPlus');

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

/** Borderless 90s card: busy chrome in the margin, rectangular photo inset.
 *  Geometry agrees (~10% "frame") the way Star Rookie / Faulk did after a
 *  neon crop. Texture / ink-color must keep it Incomplete. */
async function makeBusyInsetBorderlessPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const inset = { left: 42, right: 357, top: 55, bottom: 503 };
  const cell = 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const inPhoto = x >= inset.left && x <= inset.right && y >= inset.top && y <= inset.bottom;
      if (inPhoto) {
        buf[i] = 22; buf[i + 1] = 38; buf[i + 2] = 92;
      } else {
        const on = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) === 0;
        if (on) {
          buf[i] = 210; buf[i + 1] = 186; buf[i + 2] = 72;
        } else {
          buf[i] = 48; buf[i + 1] = 62; buf[i + 2] = 140;
        }
      }
    }
  }
  return sharpLib(buf, {
    raw: { width: width, height: height, channels: channels }
  }).png().toBuffer();
}

/** White printed frame with a nameplate bite on the top inner edge (~11px).
 *  Flat ink must still grade after the texture gate. */
async function makeWhiteBorderNameplatePng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const border = 28;
  const nameplateInner = 17;
  const nameplateLeft = 140;
  const nameplateRight = 260;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const topInner = (x >= nameplateLeft && x <= nameplateRight) ? nameplateInner : border;
      const inFrame =
        x < border || x >= width - border ||
        y < topInner || y >= height - border;
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

/** Flat navy surround + rectangular photo — the live Faulk shape.
 *  Geometry agrees and the band is flat; paper-white must still reject. */
async function makeFlatNavyInsetPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const inset = { left: 42, right: 357, top: 55, bottom: 503 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const inPhoto = x >= inset.left && x <= inset.right && y >= inset.top && y <= inset.bottom;
      if (inPhoto) {
        buf[i] = 196; buf[i + 1] = 164; buf[i + 2] = 120;
      } else {
        buf[i] = 36; buf[i + 1] = 48; buf[i + 2] = 88;
      }
    }
  }
  return sharpLib(buf, {
    raw: { width: width, height: height, channels: channels }
  }).png().toBuffer();
}

async function runFlatNavyInsetCheck() {
  const buf = await makeFlatNavyInsetPng();
  if (!buf) {
    console.log('SKIP flat-navy inset check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 560, debug: true, alignmentCrop: true });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP flat-navy inset check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL flat-navy inset threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  assertUndetectedNoFrameHint('flat-navy inset', report);
  const reliability = report.centeringDiagnostics && report.centeringDiagnostics.borderReliability;
  const reasons = reliability && reliability.reasons ? reliability.reasons.join(' ') : '';
  assert('flat-navy names not a white printed frame',
    reasons.indexOf('not a white printed frame') !== -1);
  const paper = reliability && reliability.paperBandMean;
  assert('flat-navy paper means are below the white floor',
    paper && paper.left < g.WHITE_BAND_MIN_GREY && paper.right < g.WHITE_BAND_MIN_GREY);
  const navyBvi = report.centeringDiagnostics.bandVsInterior;
  assert('flat-navy diagnostic ratio exists', Boolean(navyBvi && navyBvi.min != null));
  assert('flat-navy band is not brighter than interior', navyBvi.min < 1.05);
}

async function runBusyInsetBorderlessCheck() {
  const buf = await makeBusyInsetBorderlessPng();
  if (!buf) {
    console.log('SKIP busy-inset borderless check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 560, debug: true, alignmentCrop: true });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP busy-inset borderless check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL busy-inset borderless threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  assertUndetectedNoFrameHint('busy-inset borderless', report);
  const reliability = report.centeringDiagnostics && report.centeringDiagnostics.borderReliability;
  const reasons = reliability && reliability.reasons ? reliability.reasons.join(' ') : '';
  assert('busy-inset names texture, paper-white, or miss',
    reasons.indexOf('textured art') !== -1 ||
    reasons.indexOf('not a white printed frame') !== -1 ||
    reasons.indexOf('cut-edge ink greys') !== -1 ||
    reasons.indexOf('did not resolve') !== -1);
}

async function runWhiteBorderNameplateCheck() {
  const buf = await makeWhiteBorderNameplatePng();
  if (!buf) {
    console.log('SKIP white-border nameplate check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 560, debug: true, alignmentCrop: true });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP white-border nameplate check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL white-border nameplate threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  assert('nameplate white-border detected', report.printCenteringDetected === true);
  assert('nameplate white-border complete', report.incomplete === false);
  assert('nameplate white-border has CEN', typeof report.subGrades.centering === 'number');
  assertHint('nameplate white-border hint is printed-frame', report.centeringDiagnostics.hint, 'likely-printed-frame');
  const npBvi = report.centeringDiagnostics.bandVsInterior;
  assert('nameplate diagnostic ratio exists', Boolean(npBvi && npBvi.min != null));
  assert('nameplate band is brighter than interior', npBvi.min > 1.2);
}

/** Pastorini-class: white outer ring, orange inner frame, then photo. */
async function makeCompoundWhiteOrangePng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  const white = 28;
  const orange = 48;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const d = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (d < white) {
        buf[i] = 245; buf[i + 1] = 245; buf[i + 2] = 245;
      } else if (d < orange) {
        buf[i] = 220; buf[i + 1] = 90; buf[i + 2] = 30;
      } else {
        buf[i] = 20; buf[i + 1] = 46; buf[i + 2] = 110;
      }
    }
  }
  return sharpLib(buf, {
    raw: { width: width, height: height, channels: channels }
  }).png().toBuffer();
}

/** Full-bleed bright foil with a hot glare patch — no printed margin. */
async function makeFullBleedHoloPng() {
  let sharpLib = null;
  try { sharpLib = require('sharp'); } catch (e) { return null; }
  const width = 400;
  const height = 560;
  const channels = 3;
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const on = ((Math.floor(x / 6) + Math.floor(y / 6)) % 2) === 0;
      if (on) {
        buf[i] = 190; buf[i + 1] = 200; buf[i + 2] = 220;
      } else {
        buf[i] = 70; buf[i + 1] = 90; buf[i + 2] = 140;
      }
    }
  }
  for (let y = 180; y < 280; y++) {
    for (let x = 140; x < 260; x++) {
      const i = (y * width + x) * channels;
      buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255;
    }
  }
  return sharpLib(buf, {
    raw: { width: width, height: height, channels: channels }
  }).png().toBuffer();
}

async function runCompoundWhiteOrangeCheck() {
  const buf = await makeCompoundWhiteOrangePng();
  if (!buf) {
    console.log('SKIP compound white/orange check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 560, debug: true, alignmentCrop: true });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP compound white/orange check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL compound white/orange threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  const bvi = report.centeringDiagnostics && report.centeringDiagnostics.bandVsInterior;
  assert('compound diagnostic ratio exists', Boolean(bvi && bvi.min != null));
  assert('compound band is still brighter than interior', bvi.min > 1.1);
  console.log('compound white/orange bandVsInterior', JSON.stringify(bvi));
}

async function runFullBleedHoloCheck() {
  const buf = await makeFullBleedHoloPng();
  if (!buf) {
    console.log('SKIP full-bleed holo check (sharp not installed)');
    return;
  }
  const report = await g.gradeBuffer(buf, { maxDim: 560, debug: true, alignmentCrop: true });
  if (report.notes && String(report.notes).indexOf('sharp') !== -1) {
    console.log('SKIP full-bleed holo check (sharp not installed)');
    return;
  }
  if (report.notes && String(report.notes).indexOf('grading engine error') !== -1) {
    console.error('FAIL full-bleed holo threw:', report.notes);
    process.exitCode = 1;
    return;
  }
  const bvi = report.centeringDiagnostics && report.centeringDiagnostics.bandVsInterior;
  assert('holo diagnostic exists (interior at least)', Boolean(bvi && bvi.interior));
  console.log('full-bleed holo bandVsInterior', JSON.stringify(bvi));
  if (bvi && bvi.min != null) {
    assert('holo min ratio is not a strong white-frame signal', bvi.min < 1.5);
  }
  const glare = bvi && bvi.interior && bvi.interior.glareFrac;
  assert('holo interior records glare', glare != null && glare > 0);
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
  const whiteBvi = cropped.centeringDiagnostics.bandVsInterior;
  assert('white-border diagnostic ratio exists', Boolean(whiteBvi && whiteBvi.min != null));
  assert('white-border band is brighter than interior', whiteBvi.min > 1.2);
  assert('white-border still accepted (diagnostic is not a gate)', cropped.incomplete === false);
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
  return runBusyInsetBorderlessCheck();
}).then(function () {
  return runFlatNavyInsetCheck();
}).then(function () {
  return runWhiteBorderNameplateCheck();
}).then(function () {
  return runCompoundWhiteOrangeCheck();
}).then(function () {
  return runFullBleedHoloCheck();
}).then(async function () {
  const buf = await makeBorderedCardPng();
  if (!buf) {
    console.log('SKIP surfaceSweep diagnostic (no sharp / no synthetic)');
    return;
  }
  const graded = await g.gradeBuffer(buf, { debug: true, alignmentCrop: true });
  const surfaceBefore = graded.subGrades && graded.subGrades.surface;
  const sweep = await g.buildSurfaceSweep(graded, [
    { buffer: buf, bin: 'pitchPlus', pitch: 12, roll: 0 }
  ], { alignmentCrop: true, levelTilt: { pitchDeg: 0, rollDeg: 0 } });
  assert('surfaceSweep does not change SUR', graded.subGrades.surface === surfaceBefore);
  assert('surfaceSweep has level + extra', sweep.length === 2);
  assert('surfaceSweep[0] is level', sweep[0].bin === 'level');
  assert('surfaceSweep extra keeps bin', sweep[1].bin === 'pitchPlus');
  assert('surfaceSweep extra has scratchCount', typeof sweep[1].scratchCount === 'number');
  console.log('PASS surfaceSweep is diagnostic-only (SUR unchanged)');
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

