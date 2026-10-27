/**
 * scripts/verify_border_group.js
 * Border group order: an outermost side at or above 1.185 mm wins, the
 * anchored thin exception beats a deeper jump, and every other under-floor
 * side is withheld. Frame-profile comparison is not this test.
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

const thinThenDeeper = [
  { widthMm: 0.93, widthPx: 9.44 },
  { widthMm: 2.80, widthPx: 28.3 }
];
const anchored = g.selectBorderGroup(thinThenDeeper, { anchoredThin: true });
assert('anchored thin exception keeps the outer side', anchored && anchored.widthMm === 0.93, anchored);

const withheld = g.selectBorderGroup(thinThenDeeper, { anchoredThin: false });
assert('an under-floor side is withheld instead of jumping deeper', withheld == null, withheld);

const alreadyFull = [
  { widthMm: 2.50, widthPx: 25.3 },
  { widthMm: 4.10, widthPx: 41.5 }
];
const outerWins = g.selectBorderGroup(alreadyFull, { anchoredThin: false });
assert('an outer side past 1.185mm is not replaced', outerWins && outerWins.widthMm === 2.50, outerWins);

const atFloor = g.selectBorderGroup([{ widthMm: g.BORDER_MIN_MEDIAN_MM, widthPx: 12 }], { anchoredThin: false });
assert('a side at 1.185mm is kept', atFloor && atFloor.widthMm === g.BORDER_MIN_MEDIAN_MM, atFloor);

assert('no group withholds the side', g.selectBorderGroup([], { anchoredThin: true }) == null);
assert('the engine does not export a silver or black width cutoff',
  g.FRAME_WIDTH_ABS_MM === undefined && g.FRAME_BLACK_ABS_MM === undefined && g.sharedFrameProfile === undefined);

if (failures) {
  console.error(failures + ' border-group check(s) failed.');
  process.exit(1);
}
console.log('All border-group checks passed.');
