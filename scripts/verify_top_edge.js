/**
 * scripts/verify_top_edge.js
 * Stage C regression: the border finder must pick the true border→art step
 * on the 1991 Upper Deck Karros geometry (ruler: L 4mm, R 3mm, T 3mm,
 * B 3.5mm → 40/30/30/35px on the 643×900 warp → L/R 57.1/42.9, T/B 46.2/53.8).
 * Run: node scripts/verify_top_edge.js
 */
'use strict';

const sharp = require('sharp');
const g = require('../services/grading_engine');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail) : ''); }
}
function near(a, b, tol) { return a != null && Math.abs(a - b) <= tol; }

const W = 643;
const H = 900;
const KARROS = { left: 40, right: 30, top: 30, bottom: 35 };
const WHITE = [246, 246, 244];
const DARK = [40, 50, 70];

/** Build a card raster; `paint(x, y, borders)` returns [r,g,b] or null (→ default). */
async function gradeCard(opts) {
  const b = Object.assign({}, KARROS, opts.borders || {});
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBorder = x < b.left || x >= W - b.right || y < b.top || y >= H - b.bottom;
      let v = inBorder ? WHITE : DARK;
      if (opts.paint) {
        const custom = opts.paint(x, y, b, inBorder);
        if (custom) v = custom;
      }
      const i = (y * W + x) * 3;
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2];
    }
  }
  const pad = 80;
  let raster = sharp(d, { raw: { width: W, height: H, channels: 3 } });
  if (opts.soften) {
    raster = sharp(await raster.blur(opts.soften).raw().toBuffer(), { raw: { width: W, height: H, channels: 3 } });
  }
  const png = await raster
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 236, g: 72, b: 153 } })
    .jpeg({ quality: 92 }).toBuffer();
  const quad = { tl: [pad, pad], tr: [pad + W - 1, pad], br: [pad + W - 1, pad + H - 1], bl: [pad, pad + H - 1] };
  const log = console.log;
  console.log = function () {};
  const report = await g.gradeBuffer(png, { debug: true, cardQuad: JSON.stringify(quad) });
  console.log = log;
  const diag = report.centeringDiagnostics || {};
  return {
    report: report,
    widths: diag.printBorderWidths || {},
    lr: report.centeringMetrics && report.centeringMetrics.leftRightRatio,
    tb: report.centeringMetrics && report.centeringMetrics.topBottomRatio,
    flags: diag.edgeFlags || [],
    topLines: (diag.sampleLines && diag.sampleLines.top) || []
  };
}

function paleStrip(grey, rows, xFrom, xTo) {
  return function (x, y, b, inBorder) {
    if (inBorder) return null;
    const inX = xFrom == null || (x >= xFrom && x < xTo);
    if (inX && y >= b.top && y < b.top + rows) return [grey, grey + 4, grey + 12];
    return null;
  };
}

async function run() {
  // 1. Plain Karros geometry.
  const plain = await gradeCard({});
  assert('plain: T ≈ 30', near(plain.widths.top, 30, 1), plain.widths);
  assert('plain: B ≈ 35', near(plain.widths.bottom, 35, 1), plain.widths);
  assert('plain: L/R ≈ 57.1/42.9', plain.lr && near(plain.lr.left, 57.1, 1), plain.lr);
  assert('plain: T/B ≈ 46.2/53.8', plain.tb && near(plain.tb.top, 46.2, 1), plain.tb);

  // 2. The 8260D8EF failure: pale strip 12px under the top edge, dark below.
  const pale = await gradeCard({ paint: paleStrip(224, 12) });
  assert('pale strip: T ≈ 30 (old finder read 40.4)', near(pale.widths.top, 30, 1), pale.widths);
  assert('pale strip: T/B ≈ 46/54 (old finder read 54.4/45.6)', pale.tb && near(pale.tb.top, 46.2, 1), pale.tb);
  assert('pale strip: every top line agrees', pale.topLines.every(function (l) { return l.inGroup; }), pale.topLines);

  // 3. Pale strip only across the middle (half the lines saw it in the old finder).
  const partial = await gradeCard({ paint: paleStrip(224, 12, 200, 470) });
  assert('partial pale strip: T ≈ 30', near(partial.widths.top, 30, 1), partial.widths);
  assert('partial pale strip: T/B ≈ 46/54', partial.tb && near(partial.tb.top, 46.2, 1), partial.tb);

  // 4. Stationary repeatability across lighting/strip variations: T/B spread < 3.
  const tops = [];
  for (const grey of [205, 215, 225, 232]) {
    for (const rows of [8, 12, 20]) {
      const r = await gradeCard({ paint: paleStrip(grey, rows) });
      tops.push(r.tb ? r.tb.top : null);
    }
  }
  const valid = tops.filter(function (v) { return v != null; });
  const spread = Math.max.apply(null, valid) - Math.min.apply(null, valid);
  assert('12 stationary variants all measured', valid.length === tops.length, tops);
  assert('T/B spread across variants < 3 points (got ' + spread.toFixed(2) + ')', spread < 3, tops);

  // 5. Logo crossing the top-left corner lines (over the border and into the photo).
  const logo = await gradeCard({
    paint: function (x, y) {
      if (x >= 20 && x < 190 && y >= 8 && y < 70) return [30, 30, 140];
      return null;
    }
  });
  const logoOutliers = logo.topLines.filter(function (l) { return !l.inGroup; }).map(function (l) { return l.at; });
  assert('logo: T ≈ 30 despite the corner logo', near(logo.widths.top, 30, 1), logo.widths);
  assert('logo: T/B ≈ 46/54', logo.tb && near(logo.tb.top, 46.2, 1), logo.tb);
  assert('logo: the lines under the logo are the outliers', logoOutliers.length >= 2 &&
    logoOutliers.every(function (at) { return at < 190; }), logoOutliers);
  assert('logo: outliers are flagged, edge not failed', logo.flags.some(function (f) {
    return f.indexOf('top:') === 0 && f.indexOf('outside the agreeing group') !== -1;
  }), logo.flags);

  // 6. Glare over the pale strip on the right: border "continues" for 4 lines.
  const glare = await gradeCard({
    paint: function (x, y, b, inBorder) {
      if (!inBorder && x >= 395 && x < 495 && y >= b.top && y < b.top + 30) return [250, 250, 250];
      return paleStrip(224, 12)(x, y, b, inBorder);
    }
  });
  assert('glare: T ≈ 30 (outermost agreeing group, not the glare overshoot)', near(glare.widths.top, 30, 1), glare.widths);
  assert('glare: T/B ≈ 46/54', glare.tb && near(glare.tb.top, 46.2, 1), glare.tb);

  // 7. Opposite border is a flag, not a correction.
  const miscut = await gradeCard({ borders: { top: 20, bottom: 70 } });
  assert('miscut: measured, not rejected', miscut.tb && near(miscut.tb.top, 22.2, 1.5), miscut.tb);
  assert('miscut: opposite-border flag raised', miscut.flags.some(function (f) {
    return f.indexOf('T/B') === 0 && f.indexOf('check the bottom edge') !== -1;
  }), miscut.flags);
  assert('plain Karros: no opposite-border flag', !plain.flags.some(function (f) { return f.indexOf('flag only') !== -1; }), plain.flags);

  // 8. Max inward depth: a "border" deeper than 12% of the card is not a border.
  const deep = await gradeCard({ borders: { top: 130 } });
  assert('top step at 130px (>108px cap) is not accepted as a border',
    deep.widths.top == null && deep.report.printCenteringDetected === false, deep.widths);

  // Soft edges (focus / motion blur / JPEG): the half-step crossing falls
  // after the trigger pixel. Widths must not read short.
  const soft = await gradeCard({ soften: 2.5 });
  assert('soft edges: T ≈ 30, B ≈ 35, L ≈ 40, R ≈ 30 (not short)',
    near(soft.widths.top, 30, 1) && near(soft.widths.bottom, 35, 1) &&
    near(soft.widths.left, 40, 1) && near(soft.widths.right, 30, 1), soft.widths);
  assert('soft edges: T/B ≈ 46.2 and L/R ≈ 57.1', soft.tb && near(soft.tb.top, 46.2, 0.7) &&
    soft.lr && near(soft.lr.left, 57.1, 0.7), { tb: soft.tb, lr: soft.lr });

  // 9. Pattern A (5-scan run, e.g. 198A60F1 top @375/@429/@483 at 3.0/4.0/8.3px,
  //    right @375 at 3–4px on every scan): a darker sliver at the cut, left by a
  //    cut-edge shadow or a tighten that sits a few px outside the card. Here it
  //    spans 7 of the 15 top lines, enough to form an "outermost group".
  const sliver = await gradeCard({
    paint: function (x, y, b, inBorder) {
      if (y < 4 && x >= 330 && x < 530) return [150, 150, 158];
      if (x >= W - 4 && y >= 360 && y < 390) return [150, 150, 158];
      return null;
    }
  });
  assert('pattern A: near-cut sliver on 7 top lines does not become the border (T ≈ 30)',
    near(sliver.widths.top, 30, 1), { widths: sliver.widths, top: sliver.topLines });
  assert('pattern A: T/B ≈ 46/54', sliver.tb && near(sliver.tb.top, 46.2, 1), sliver.tb);
  assert('pattern A: no top line reports a hit inside the 6px guard',
    sliver.topLines.every(function (l) { return l.pos == null || l.pos >= 6; }), sliver.topLines);
  assert('pattern A: right sliver line does not move R (R ≈ 30)', near(sliver.widths.right, 30, 1), sliver.widths);

  // 10. Pattern B (late hits with pinned triggers in the old finder):
  //     bottom nameplate bar 35→47px on the middle lines, a lone top spike to
  //     78px (@483 on 108B472C), and right @225 ~57px on every scan.
  const late = await gradeCard({
    paint: function (x, y, b, inBorder) {
      if (!inBorder && x >= 250 && x < 420 && y >= H - b.bottom - 12 && y < H - b.bottom) return [226, 228, 232];
      if (x >= 474 && x < 492 && y >= b.top && y < 78) return [248, 248, 246];
      if (x >= W - 57 && x < W - b.right && y >= 214 && y < 236) return [248, 248, 246];
      return null;
    }
  });
  assert('pattern B: nameplate bar is not the bottom border (B ≈ 35)', near(late.widths.bottom, 35, 1), late.widths);
  assert('pattern B: lone 78px top spike is outvoted (T ≈ 30)', near(late.widths.top, 30, 1), late.widths);
  assert('pattern B: right ~57px spike near the top is outvoted (R ≈ 30)', near(late.widths.right, 30, 1), late.widths);
  assert('pattern B: T/B ≈ 46/54 and L/R ≈ 57/43',
    late.tb && near(late.tb.top, 46.2, 1) && late.lr && near(late.lr.left, 57.1, 1), { tb: late.tb, lr: late.lr });

  // Colored border on pink. Grey-below-165 must not reject it.
  const blue = await gradeCard({
    paint: function (x, y, b, inBorder) { return inBorder ? [30, 70, 170] : null; }
  });
  const blueReasons = ((blue.report.centeringDiagnostics || {}).borderReliability || {}).reasons || [];
  assert('blue border is measured and scored',
    blue.report.printCenteringDetected === true && typeof blue.report.subGrades.centering === 'number',
    { widths: blue.widths, reasons: blueReasons, cen: blue.report.subGrades && blue.report.subGrades.centering });
  assert('blue border is not a white-frame reject',
    blueReasons.join(' ').indexOf('white printed') === -1 && blueReasons.join(' ').indexOf('below 165') === -1, blueReasons);

  // 1.15 mm class. A hard white-to-dark step is what the cut refiner locks onto,
  // so this border is only slightly lighter than the interior: the cut stays
  // on the pink table, and the ~11px band is the frame.
  const thin = await gradeCard({
    borders: { bottom: 11 },
    paint: function (x, y, b, inBorder) {
      return inBorder ? [230, 230, 228] : [180, 170, 160];
    }
  });
  const thinReasons = ((thin.report.centeringDiagnostics || {}).borderReliability || {}).reasons || [];
  assert('11px bottom is accepted', thin.report.printCenteringDetected === true && near(thin.widths.bottom, 11, 1.5),
    { widths: thin.widths, reasons: thinReasons });
  assert('11px bottom keeps a centering score', typeof thin.report.subGrades.centering === 'number', thin.report.subGrades);

  // 6 lines at ~25px vs 9 at ~42px. The outer group is a minority; do not score it.
  const split = await gradeCard({
    paint: function (x, y, b, inBorder) {
      const span0 = Math.floor(H * 0.2);
      const span1 = Math.floor(H * 0.8);
      if (y < span0 || y >= span1) return null;
      const narrow = y < span0 + (span1 - span0) * 0.4;
      const edge = narrow ? 25 : 42;
      if (x < edge) return WHITE;
      if (x < 70) return DARK;
      return null;
    }
  });
  // The straight-edge profile follows the longer run (42px, 9 of 15 lines).
  // That majority agrees with the profile, so it is a measure. The 25px run
  // is flagged as outside the group. A minority outermost cluster is what
  // still withholds.
  assert('split left edge follows the profile majority', near(split.widths.left, 42, 1.5), split.widths);
  assert('split outliers stay flagged', split.flags.some(function (f) {
    return f.indexOf('left:') === 0 && f.indexOf('outside the agreeing group') !== -1;
  }), split.flags);
  assert('split majority that agrees with the profile keeps the centering score',
    split.report.subGrades && split.report.subGrades.centering != null, split.report.subGrades);
  assert('split vote still reports the measured widths',
    split.widths.left != null && split.widths.right != null, split.widths);

  if (failures) {
    console.error(failures + ' top-edge check(s) failed.');
    process.exit(1);
  }
  console.log('All top-edge checks passed.');
}

run().catch(function (err) {
  console.error('FAIL top-edge run threw', err);
  process.exit(1);
});
