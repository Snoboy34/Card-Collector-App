/**
 * scripts/verify_judge_math.js
 * Regression checks for the 4-phase Judge formula and the 0.5-point ceiling.
 * Run: node scripts/verify_judge_math.js
 */
'use strict';
const g = require('../services/grading_engine');

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

if (process.exitCode) {
  console.error('Judge math regression failed.');
} else {
  console.log('All Judge math checks passed.');
}
