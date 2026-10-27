/**
 * scripts/verify_ink_dark.js
 * A faint shade in a plain border is not a border line. The finder keeps
 * going until a step reaches ink darkness relative to that border.
 * Run: node scripts/verify_ink_dark.js
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

function measure(paint) {
  const w = 500;
  const h = 700;
  return g.measurePrintCentering(function (x, y) {
    return paint(x, y, w, h);
  }, w, h, null, { scale: 1 });
}

function edge(x, y, w, h, inkAt) {
  const paper = 210;
  const ink = 40;
  if (x < inkAt) return paper;
  if (x < inkAt + 4) return ink;
  if (x > w - inkAt) return paper;
  if (x > w - inkAt - 4) return ink;
  if (y < inkAt) return paper;
  if (y < inkAt + 4) return ink;
  if (y > h - inkAt) return paper;
  if (y > h - inkAt - 4) return ink;
  return ink;
}

const plain = measure(function (x, y, w, h) { return edge(x, y, w, h, 30); });

const shaded = measure(function (x, y, w, h) {
  const paper = 210;
  // A faint shade a fraction of a millimetre outside the dark line.
  // Other edges stay a plain ink step.
  if (y < 30 || y > h - 30 || x > w - 30) return edge(x, y, w, h, 30);
  if (x < 32) return paper;
  if (x < 34) return 200;
  if (x < 38) return paper - (paper - 70) * ((x - 34) / 4);
  if (x < 44) return 70;
  if (x < 48) return 70 + (paper - 70) * ((x - 44) / 4);
  return 190;
});

assert('a plain ink step is still a border',
  plain.detected && plain.widths.left > 28 && plain.widths.left < 36, plain.widths);
assert('a faint shade is not the border; the darker line is',
  shaded.widths.left > 33 && shaded.widths.left < 40, shaded.widths);
assert('the ink-darkness minimum sits between a shade and a real border',
  g.INK_STEP_CONTRAST > 0.08 && g.INK_STEP_CONTRAST < 0.16, g.INK_STEP_CONTRAST);

if (failures) {
  console.error(failures + ' failed');
  process.exit(1);
}
console.log('ink-dark checks passed');
