/**
 * scripts/verify_border_group.js
 * Deeper border groups follow the agreed frame profile, and a single thin
 * side of a full frame is not replaced by an inner line.
 * Run: node scripts/verify_border_group.js
 */
'use strict';

const g = require('../services/grading_engine');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else {
    failures += 1;
    console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

const frame = { width: 0.40, blackWidth: 1.20, points: 8 };
const frameB = { width: 0.42, blackWidth: 1.24, points: 10 };
const inner = { width: 0.40, blackWidth: 2.40, points: 8 };
const shortRun = { width: 0.40, blackWidth: 1.20, points: 1 };

assert('profile width tolerance is 0.12mm', g.FRAME_WIDTH_ABS_MM === 0.12);
assert('profile width range is 0.16mm', g.FRAME_WIDTH_RANGE_MM === 0.16);
assert('profile black tolerance is 0.36mm', g.FRAME_BLACK_ABS_MM === 0.36);
assert('profile black range is 0.52mm', g.FRAME_BLACK_RANGE_MM === 0.52);
assert('black band is thicker than the silver', g.FRAME_BLACK_OVER_SILVER_MM === 0.05);
assert('a profile needs at least 2 points', g.FRAME_MIN_POINTS === 2);
assert('two matching sides share a profile', g.sharedFrameProfile([frame, frameB]) != null);
assert('an inner line does not share that profile', g.sharedFrameProfile([frame, inner]) == null);
assert('one point is not a profile', g.sharedFrameProfile([shortRun]) == null);

const siblings = [frame, frameB, frame];
const thinThenFrame = [
  { widthMm: 0.93, widthPx: 9.44, profile: null },
  { widthMm: 2.80, widthPx: 28.3, profile: frame }
];
const anchored = g.selectBorderGroup(thinThenFrame, { anchoredThin: true, siblingProfiles: siblings });
assert('anchored thin exception keeps the outer side', anchored && anchored.widthMm === 0.93, anchored);

const jumped = g.selectBorderGroup(thinThenFrame, { anchoredThin: false, siblingProfiles: siblings });
assert('a deeper group is taken when it matches the other sides', jumped && jumped.widthMm === 2.80, jumped);

const wrongDeeper = [
  { widthMm: 0.93, widthPx: 9.44, profile: null },
  { widthMm: 2.80, widthPx: 28.3, profile: inner }
];
const stayed = g.selectBorderGroup(wrongDeeper, { anchoredThin: false, siblingProfiles: siblings });
assert('a deeper group with a different profile stays unused', stayed && stayed.widthMm === 0.93, stayed);

const alreadyFull = [
  { widthMm: 2.50, widthPx: 25.3, profile: frame },
  { widthMm: 4.10, widthPx: 41.5, profile: frame }
];
const outerWins = g.selectBorderGroup(alreadyFull, { anchoredThin: false, siblingProfiles: siblings });
assert('an outer side past 1.185mm is not replaced', outerWins && outerWins.widthMm === 2.50, outerWins);

const noProfile = g.selectBorderGroup([
  { widthMm: 0.99, widthPx: 10, profile: null },
  { widthMm: 2.30, widthPx: 23, profile: null }
], { anchoredThin: false, siblingProfiles: [] });
assert('without a profile the outer group stays', noProfile && noProfile.widthMm === 0.99, noProfile);

if (failures) {
  console.error(failures + ' border-group check(s) failed.');
  process.exit(1);
}
console.log('All border-group checks passed.');
