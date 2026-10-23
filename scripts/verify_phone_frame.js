/**
 * scripts/verify_phone_frame.js
 *
 * The phone calls the shared frame matcher. A step on a different line
 * takes the outline. A step already within the group gap stays. An outline
 * under 1.185 mm is not published.
 */
'use strict';

const phoneFrame = require('../services/phone_frame');
const frameProfile = require('../services/frame_profile');

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('PASS ' + name);
    return;
  }
  failed += 1;
  console.error('FAIL ' + name + (detail == null ? '' : ' ' + JSON.stringify(detail)));
}

const FLOOR = 12 * 63.5 / 643;
const GAP = 3 * 63.5 / 643;

function gapFor() { return GAP; }

const sameLine = phoneFrame.adoptOutline(
  { left: 3.65, right: 2.8, top: 2.9, bottom: 3.55 },
  { left: 3.6, right: 2.76, top: 2.82, bottom: 3.4 },
  FLOOR,
  gapFor
);
check('a step within the group gap stays',
  sameLine.replaced.length === 0 && sameLine.mm.left === 3.65 && sameLine.mm.bottom === 3.55,
  sameLine);

const different = phoneFrame.adoptOutline(
  { left: 2.45, right: 3.49, top: 3.91, bottom: 3.85 },
  { left: 4.08, right: 3.44, top: 3.3, bottom: 3.76 },
  FLOOR,
  gapFor,
  { lowConfidence: ['left'], frameMatches: { left: true, top: true, bottom: true } }
);
check('a matched inner step and a deep step take the outline',
  different.replaced.indexOf('left') >= 0 && different.replaced.indexOf('top') >= 0 &&
  different.mm.left === 4.08 && different.mm.top === 3.3 &&
  different.replaced.indexOf('right') < 0 && different.mm.right === 3.49 &&
  different.replaced.indexOf('bottom') < 0 && different.mm.bottom === 3.85,
  different);

const pale = phoneFrame.adoptOutline(
  { left: 3.95, right: 2.96, top: 2.96, bottom: 3.46 },
  { left: 3.88, right: 2.88, top: 4.06, bottom: 3.38 },
  FLOOR,
  gapFor,
  { lowConfidence: [], frameMatches: {} }
);
check('a solid outer step is not pushed to a deeper outline',
  pale.replaced.length === 0 && pale.mm.top === 2.96,
  pale);

const soft = phoneFrame.adoptOutline(
  { left: 3.95, right: 2.96, top: 2.96, bottom: 3.46 },
  { left: 3.64, right: 2.66, top: 2.66, bottom: 3.14 },
  FLOOR,
  gapFor,
  { lowConfidence: [], frameMatches: {} }
);
check('a soft edge within a step of the outline stays',
  soft.replaced.length === 0 && soft.mm.top === 2.96,
  soft);

const sliver = phoneFrame.adoptOutline(
  { left: 1.035, right: 3.26, top: 3.46, bottom: 2.88 },
  { left: 2.96, right: 3.18, top: 3.38, bottom: 2.74 },
  FLOOR,
  gapFor,
  { lowConfidence: ['left'], frameMatches: {} }
);
check('an anchored-thin minority takes the outline',
  sliver.replaced.indexOf('left') >= 0 && sliver.mm.left === 2.96 && sliver.mm.right === 3.26,
  sliver);

const deep = phoneFrame.adoptOutline(
  { left: null, right: 3, top: null, bottom: 3.5 },
  { left: 4, right: 3, top: 12.8, bottom: 3.5 },
  FLOOR,
  gapFor,
  { maxMmFor: function (edge) { return (edge === 'top' || edge === 'bottom') ? 0.12 * 88.9 : 0.12 * 63.5; } }
);
check('an outline past 12% of the card is not a border',
  deep.mm.top == null && deep.mm.left === 4,
  deep);

const filled = phoneFrame.adoptOutline(
  { left: null, right: 3.22, top: 3.46, bottom: 2.84 },
  { left: 3.0, right: 3.22, top: 3.46, bottom: 2.84 },
  FLOOR,
  gapFor
);
check('a withheld step takes an outline past the floor',
  filled.replaced.indexOf('left') >= 0 && filled.mm.left === 3,
  filled);

const under = phoneFrame.adoptOutline(
  { left: null, right: 2.2, top: 3.32, bottom: null },
  { left: 0.9, right: 2.2, top: 3.32, bottom: 1.06 },
  FLOOR,
  gapFor
);
check('an outline under 1.185 mm is not published',
  under.replaced.length === 0 && under.mm.left == null && under.mm.bottom == null,
  under);

function paint(w, h, borders) {
  const data = Buffer.alloc(w * h * 3);
  const ppmX = w / 63.5;
  const ppmY = h / 88.9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dl = x / ppmX;
      const dr = (w - 1 - x) / ppmX;
      const dt = y / ppmY;
      const db = (h - 1 - y) / ppmY;
      let rgb = [28, 36, 72];
      if (dl < borders.left || dr < borders.right || dt < borders.top || db < borders.bottom) {
        rgb = [236, 236, 232];
      }
      if (dl >= 1.15 && dl <= 1.35 && dl < borders.left) rgb = [150, 150, 150];
      const i = (y * w + x) * 3;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  }
  return { data: data, width: w, height: h, channels: 3 };
}

const warp = paint(420, 588, { left: 4.0, right: 3.4, top: 3.3, bottom: 3.7 });
const measured = phoneFrame.measureWarp(warp);
function near(v, expect) { return v != null && Math.abs(v - expect) <= 0.15; }
check('left outline skips the returning stripe', near(measured.left, 4.0), measured);
check('right outline is the ink', near(measured.right, 3.4), measured);
check('top outline is the ink', near(measured.top, 3.3), measured);
check('bottom outline is the ink', near(measured.bottom, 3.7), measured);

// The shared matcher accepts four sides with the same bands. This is the
// flatbed fixture shape: outer width, thicker black, inner width.
const seg = function (depth, width, blackWidth, innerWidth) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    points.push({ depth: depth, alongMm: 8 + i * 4, black: depth + width });
  }
  return {
    points: points,
    median: depth,
    width: width,
    blackWidth: blackWidth,
    innerWidth: innerWidth
  };
};
const matched = frameProfile.matchedProfileSegments({
  top: [seg(3.2, 0.24, 1.4, 0.18)],
  bottom: [seg(3.4, 0.26, 1.45, 0.2)],
  left: [seg(3.1, 0.22, 1.35, 0.16)],
  right: [seg(3.3, 0.25, 1.5, 0.19)]
});
check('shared matcher accepts the same bands on four sides', !!matched, matched);
const reading = matched ? frameProfile.outermostReading(matched.left) : null;
check('outermost reading uses the matched left edge',
  reading && Math.abs(reading.mm - 3.1) < 0.02, reading);

if (failed) {
  console.error(failed + ' phone-frame check(s) failed');
  process.exit(1);
}
console.log('phone frame ok');
