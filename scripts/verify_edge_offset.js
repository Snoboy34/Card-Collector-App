/**
 * scripts/verify_edge_offset.js
 *
 * The phone cut is the half-level of the background→card step. A sharp edge
 * has its half-level on the outer contact. A soft edge has its half-level
 * inside the ramp, and the border measured from that cut is short by the
 * outer part of the ramp. This is the systematic shortfall on the soft
 * edges. No millimetre is added here.
 *
 * Run: node scripts/verify_edge_offset.js
 */
'use strict';

const cq = require('../services/card_quad');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else {
    failures += 1;
    console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

function build(tailPx, facePx) {
  // The refine search is 2% of the warp, so the warp has to be tall enough
  // that a short tail still falls inside that window. 1 output px = 1 source px.
  const outW = 400;
  const outH = 560;
  const x0 = 50;
  const y0 = 50;
  const x1 = x0 + outW - 1;
  const y1 = y0 + outH - 1;
  const W = x1 + 80;
  const H = y1 + 80;
  const data = Buffer.alloc(W * H);
  const bg = 40;
  const card = 200;
  const amp = card - bg;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = bg;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) v = card;
      // Bottom: a shallow outer tail, then a steep face. The outer contact
      // is y1. The steep face begins `tailPx` inside it.
      const d = y1 - y;
      if (x >= x0 && x <= x1 && d >= 0 && d < tailPx + facePx) {
        if (d < tailPx) v = Math.round(bg + 0.15 * amp * (tailPx ? d / tailPx : 0));
        else v = Math.round(bg + 0.15 * amp + 0.85 * amp * ((d - tailPx) / facePx));
      }
      data[y * W + x] = v;
    }
  }
  const src = { data: data, width: W, height: H, channels: 1 };
  const quad = { tl: [x0, y0], tr: [x1, y0], br: [x1, y1], bl: [x0, y1] };
  return cq.refineQuadToCut(src, quad, outW, outH);
}

function run() {
  const sharp = build(0, 1);
  assert('sharp edge: left cut stays on the outer contact (within 1 px)',
    Math.abs(sharp.shiftPx.left) <= 1, sharp.shiftPx);
  assert('sharp edge: right cut stays on the outer contact (within 1 px)',
    Math.abs(sharp.shiftPx.right) <= 1, sharp.shiftPx);
  assert('sharp edge: bottom cut stays on the outer contact (within 1 px)',
    Math.abs(sharp.shiftPx.bottom) <= 1, sharp.shiftPx);

  // Output pixels match source pixels (the quad spans outW-1 by outH-1).
  // The half-level locks onto the steep face, so a longer outer tail moves
  // the cut further inside the outer contact. That inset is the tail, not
  // a fixed distance.
  const shortTail = build(4, 3);
  const longTail = build(8, 3);
  const shortInset = shortTail.shiftPx.bottom - sharp.shiftPx.bottom;
  const longInset = longTail.shiftPx.bottom - sharp.shiftPx.bottom;
  assert('soft bottom: cut moves inside the outer contact', shortInset > 1, shortTail.shiftPx);
  assert('a longer outer tail insets the cut further', longInset > shortInset + 2,
    { shortInset: shortInset, longInset: longInset, short: shortTail.shiftPx, long: longTail.shiftPx });
  assert('the inset follows the tail, within 2 px of it',
    Math.abs(longInset - 8) <= 2 && Math.abs(shortInset - 4) <= 2,
    { shortInset: shortInset, longInset: longInset });
  assert('soft bottom does not move the sharp left cut',
    Math.abs(longTail.shiftPx.left - sharp.shiftPx.left) <= 1, longTail.shiftPx);
  assert('soft bottom does not move the sharp right cut',
    Math.abs(longTail.shiftPx.right - sharp.shiftPx.right) <= 1, longTail.shiftPx);

  if (failures) {
    console.error(failures + ' edge-offset check(s) failed.');
    process.exit(1);
  }
  console.log('All edge-offset checks passed.');
}

run();
