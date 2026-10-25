/**
 * scripts/verify_fine_print.js
 * A fine-print edge is speckle: inside the measured line, p90 stays near the
 * border while p10 is ink and the station spread stays wide. A solid line
 * drops p90 with the median. The same test runs on every edge. The phone
 * report labels a flagged edge "fine-print, ±0.2 mm".
 * Run: node scripts/verify_fine_print.js
 */
'use strict';

const flatbed = require('./measure_flatbed');
const grading = require('../services/grading_engine');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else {
    failures += 1;
    console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

function stations(paint) {
  const list = [];
  for (let n = 0; n < 31; n++) {
    const t = 0.2 + n * 0.02;
    const luma = new Uint8Array(700);
    for (let i = 0; i < luma.length; i++) luma[i] = paint(i * 0.02, n);
    list.push({ t: t, luma: luma });
  }
  return list;
}

const speckle = stations(function (depth, n) {
  if (depth < 3) return 250;
  return n % 2 === 0 ? 18 : 246;
});
const speckleReading = flatbed.finePrintFromStations(speckle, 3, 0.02);
assert('speckle inside the line is fine-print', speckleReading.finePrint === true, speckleReading);
assert('speckle keeps p90 near the border and p10 in ink',
  speckleReading.p90Gap <= 40 && speckleReading.p10Drop >= 90 && speckleReading.inkSpread > 120,
  speckleReading);

const solid = stations(function (depth) {
  return depth < 3 ? 250 : 36;
});
const solidReading = flatbed.finePrintFromStations(solid, 3, 0.02);
assert('a solid ink step is not fine-print', solidReading.finePrint === false, solidReading);

const plateau = stations(function (depth, n) {
  if (depth < 3) return 254;
  return n % 5 === 0 ? 120 : 180;
});
const plateauReading = flatbed.finePrintFromStations(plateau, 3, 0.02);
assert('a short ramp whose bright stations leave the border is not fine-print',
  plateauReading.finePrint === false, plateauReading);

const shade = stations(function (depth) {
  return depth < 3 ? 210 : 198;
});
const shadeReading = flatbed.finePrintFromStations(shade, 3, 0.02);
assert('a faint shading step is not fine-print', shadeReading.finePrint === false, shadeReading);

const brighter = stations(function (depth, n) {
  if (depth < 3) return 80;
  return n % 2 === 0 ? 20 : 220;
});
const brighterReading = flatbed.finePrintFromStations(brighter, 3, 0.02);
assert('a bright interior is not fine-print just because the spread is wide',
  brighterReading.finePrint === false && brighterReading.p90Gap < -40, brighterReading);

assert('a missing width is not fine-print', flatbed.finePrintFromStations(speckle, null, 0.02).finePrint === false);
assert('a border too thin for a margin window is not fine-print',
  flatbed.finePrintFromStations(speckle, 0.4, 0.02).finePrint === false);

function side(mm, fine) {
  return { mm: mm, withheld: mm == null, confidence: 0.8, finePrint: !!fine };
}
const agreed = flatbed.agreeEdges({
  top: side(3.2, true),
  bottom: side(3.0, true),
  left: side(3.1, false),
  right: side(3.1, false)
}, {
  top: side(3.1, false),
  bottom: side(3.5, false),
  left: side(3.1, true),
  right: side(3.1, false)
});
assert('card top takes the 180 image-bottom flag', agreed.sides.top.finePrint === false && agreed.sides.top.mm === 3.5, agreed.sides.top);
assert('card bottom takes the upright image-bottom flag', agreed.sides.bottom.finePrint === true && agreed.sides.bottom.mm === 3, agreed.sides.bottom);
assert('one speckled scan does not flag a left or right edge',
  agreed.sides.left.finePrint === false && agreed.sides.right.finePrint === false, agreed.sides);
const both = flatbed.agreeEdges({
  top: side(3.2, false),
  bottom: side(3.0, false),
  left: side(3.1, true),
  right: side(3.1, true)
}, {
  top: side(3.0, false),
  bottom: side(3.2, false),
  left: side(3.1, true),
  right: side(3.1, true)
});
assert('left and right are fine-print when both scans are',
  both.sides.left.finePrint === true && both.sides.right.finePrint === true, both.sides);
assert('a withheld combined edge is not labeled fine-print',
  flatbed.agreeEdges({
    top: side(null, true), bottom: side(null, true), left: side(1, true), right: side(2, true)
  }, {
    top: side(null, true), bottom: side(null, true), left: side(null, true), right: side(null, true)
  }).sides.left.finePrint === false);

assert('label text is fine-print, ±0.2 mm',
  flatbed.FINE_PRINT_LABEL === 'fine-print, ±0.2 mm' && grading.FINE_PRINT_LABEL === 'fine-print, ±0.2 mm' &&
  flatbed.FINE_PRINT_TOLERANCE_MM === 0.2 && grading.FINE_PRINT_TOLERANCE_MM === 0.2);

const labeled = grading.applyFinePrintLabel({
  centeringMetrics: { borderWidthsMm: { left: 1, right: 1, top: 2, bottom: 2 } }
}, ['top', 'bottom', 'top']);
assert('the phone report labels only the flagged edges at 0.2 mm',
  labeled.centeringMetrics.finePrintLabel === 'fine-print, ±0.2 mm' &&
  labeled.centeringMetrics.finePrintEdges.join(',') === 'top,bottom' &&
  labeled.centeringMetrics.borderToleranceMm.top === 0.2 &&
  labeled.centeringMetrics.borderToleranceMm.left === 0.1,
  labeled.centeringMetrics);

if (failures) {
  console.error(failures + ' failed');
  process.exit(1);
}
console.log('fine-print checks passed');
