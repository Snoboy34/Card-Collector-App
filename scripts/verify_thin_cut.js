/**
 * scripts/verify_thin_cut.js
 * An under-floor border kept by the other three sides is withheld when that
 * edge's cut has a second edge. A side past 1.185 mm stays when the second
 * step is inside the 3 px shoulder window. A second step farther than that
 * window withholds the width. A thin side whose cut is confident stays.
 * Run: node scripts/verify_thin_cut.js
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

function measurement(bottom) {
  return {
    widthsMm: { left: 2.3, right: 2.2, top: 3.3, bottom: bottom },
    widths: { left: 23, right: 22, top: 33, bottom: bottom == null ? null : bottom * 10 },
    detected: true,
    leftRightRatio: { left: 51, right: 49 },
    topBottomRatio: { top: 60, bottom: 40 },
    edgeFlags: []
  };
}

const thin = measurement(1.115);
g.withholdThinUncertainCut(thin, ['bottom']);
assert('a thin border on a second cut is withheld', thin.widthsMm.bottom == null && thin.widths.bottom == null, thin.widthsMm);
assert('withholding the thin side drops the centering ratios', thin.detected === false && thin.leftRightRatio == null, thin);
assert('the withhold says the cut has a second edge', thin.edgeFlags.some(function (f) {
  return f.indexOf('bottom: thin border withheld') === 0;
}), thin.edgeFlags);

const wide = measurement(2.2);
g.withholdThinUncertainCut(wide, ['right'], {
  right: { runnerUpRatio: 0.7, runnerUpOffsetPx: 2.2 }
});
assert('a side past 1.185 mm keeps its width when the second cut is within 3 px',
  wide.widthsMm.right === 2.2 && wide.detected === true, wide.widthsMm);

const distant = measurement(2.162);
g.withholdThinUncertainCut(distant, ['bottom'], {
  bottom: { runnerUpRatio: 0.964, runnerUpOffsetPx: -24.67 }
});
assert('a border past the floor is withheld when the second cut is farther than 3 px',
  distant.widthsMm.bottom == null && distant.widths.bottom == null && distant.detected === false,
  distant.widthsMm);
assert('the distant withhold names the second edge', distant.edgeFlags.some(function (f) {
  return f.indexOf('bottom: border withheld') === 0;
}), distant.edgeFlags);

const inner = measurement(1.34);
inner.widthsMm.top = 1.34;
inner.widths.top = 13.56;
g.withholdThinUncertainCut(inner, ['top'], {
  top: { runnerUpRatio: 0.856, runnerUpOffsetPx: 22.3 }
});
assert('an inner second cut farther than 3 px withholds that side only',
  inner.widthsMm.top == null && inner.widthsMm.bottom === 1.34 && inner.widthsMm.left === 2.3,
  inner.widthsMm);

const confident = measurement(1.115);
g.withholdThinUncertainCut(confident, []);
assert('a thin border with a confident cut stays published', confident.widthsMm.bottom === 1.115 && confident.detected === true, confident.widthsMm);

if (failures) {
  console.error(failures + ' failed');
  process.exit(1);
}
console.log('thin-cut checks passed');
