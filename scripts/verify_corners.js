#!/usr/bin/env node
/**
 * scripts/verify_corners.js
 *
 * Synthetic flatbed corners at 1200 dpi. A known radius has to come back
 * within 0.1 mm. A sharp corner, a white border, a one-sided defect, a
 * not-card-sized quad, and TD-12 stay withheld. No scan files and no network.
 */
'use strict';

const corners = require('../services/corner_measure');

const DPI = 1200;
const PPM = corners.pxPerMm(DPI);
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    console.log('PASS', label);
    return;
  }
  failed += 1;
  console.error('FAIL', label, detail === undefined ? '' : detail);
}

function paperColor() {
  return [230, 170, 190];
}

function edgesFor(rect) {
  const tl = { x: rect.left, y: rect.top };
  const tr = { x: rect.right, y: rect.top };
  const br = { x: rect.right, y: rect.bottom };
  const bl = { x: rect.left, y: rect.bottom };
  return {
    corners: { tl: tl, tr: tr, br: br, bl: bl },
    edges: {
      top: { a: tl, b: tr, nx: 0, ny: 1 },
      bottom: { a: bl, b: br, nx: 0, ny: -1 },
      left: { a: tl, b: bl, nx: 1, ny: 0 },
      right: { a: tr, b: br, nx: -1, ny: 0 }
    }
  };
}

function paint(w, h, rect, opts) {
  const data = Buffer.alloc(w * h * 3);
  const paper = paperColor();
  const card = opts.card || [40, 70, 150];
  const border = opts.border || card;
  const borderMm = opts.borderMm == null ? 0 : opts.borderMm;
  const radius = (opts.radiusMm || 0) * PPM;
  const rise = Math.max((opts.riseMm == null ? 0.08 : opts.riseMm) * PPM, 0.8);
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const hw = (rect.right - rect.left) / 2;
  const hh = (rect.bottom - rect.top) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - cx) - (hw - radius);
      const dy = Math.abs(y - cy) - (hh - radius);
      const sdf = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
      let t = (rise / 2 - sdf) / rise;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      let ink = card;
      if (borderMm > 0) {
        const inside = Math.min(
          x - rect.left,
          rect.right - x,
          y - rect.top,
          rect.bottom - y
        );
        if (inside < borderMm * PPM) ink = border;
      }
      if (opts.notch && inNotch(x, y, rect, opts.notch)) t = 0;
      if (opts.fray && inFray(x, y, rect, opts.fray)) {
        ink = card;
        t = 1;
      }
      if (opts.pale && inPale(x, y, rect, opts.pale) && t > 0.8) ink = opts.pale.color;
      const i = (y * w + x) * 3;
      data[i] = paper[0] * (1 - t) + ink[0] * t;
      data[i + 1] = paper[1] * (1 - t) + ink[1] * t;
      data[i + 2] = paper[2] * (1 - t) + ink[2] * t;
    }
  }
  return data;
}

function inNotch(x, y, rect, notch) {
  const px = (x - (rect.left + notch.fromLeftMm * PPM)) / PPM;
  const py = (y - (rect.top + notch.fromTopMm * PPM)) / PPM;
  if (notch.edge === 'bottom') {
    const localY = (rect.bottom - y) / PPM;
    const localX = (x - (rect.left + notch.fromLeftMm * PPM)) / PPM;
    if (Math.abs(localX) > notch.halfMm) return false;
    const depth = notch.depthMm * (1 - Math.abs(localX) / notch.halfMm);
    return localY >= -0.05 && localY <= depth;
  }
  if (Math.abs(px) > notch.halfMm) return false;
  const depth = notch.depthMm * (1 - Math.abs(px) / notch.halfMm);
  return py >= -0.05 && py <= depth;
}

function inFray(x, y, rect, fray) {
  const x0 = rect.left + fray.fromLeftMm * PPM;
  const x1 = x0 + fray.lengthMm * PPM;
  const y0 = rect.top - fray.stickMm * PPM;
  const y1 = rect.top - 0.06 * PPM;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inPale(x, y, rect, pale) {
  const t = (x - (rect.left + pale.fromLeftMm * PPM)) / PPM;
  const depth = (y - rect.top) / PPM;
  return t >= pale.t0 && t <= pale.t1 && depth >= pale.d0 && depth <= pale.d1;
}

function rotate180(data, w, h, geom) {
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const nx = w - 1 - x;
      const ny = h - 1 - y;
      const d = (ny * w + nx) * 3;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
    }
  }
  function rot(p) {
    return { x: w - 1 - p.x, y: h - 1 - p.y };
  }
  function rotEdge(edge) {
    return {
      a: rot(edge.a),
      b: rot(edge.b),
      nx: -edge.nx,
      ny: -edge.ny
    };
  }
  return {
    data: out,
    corners: {
      tl: rot(geom.corners.br),
      tr: rot(geom.corners.bl),
      br: rot(geom.corners.tl),
      bl: rot(geom.corners.tr)
    },
    edges: {
      top: rotEdge(geom.edges.bottom),
      bottom: rotEdge(geom.edges.top),
      left: rotEdge(geom.edges.right),
      right: rotEdge(geom.edges.left)
    }
  };
}

function measureBoth(data, w, h, geom) {
  const up = corners.measureRaster({
    data: data,
    width: w,
    height: h,
    dpi: DPI,
    paper: paperColor(),
    sizeOk: true,
    corners: geom.corners,
    edges: geom.edges
  });
  const turned = rotate180(data, w, h, geom);
  const down = corners.measureRaster({
    data: turned.data,
    width: w,
    height: h,
    dpi: DPI,
    paper: paperColor(),
    sizeOk: true,
    corners: turned.corners,
    edges: turned.edges
  });
  return corners.pairReadings(up, down, null);
}

function cardRect() {
  return { left: 60, top: 50, right: 60 + 32 * PPM, bottom: 50 + 44 * PPM };
}

function run() {
  check('TD-12 is excluded', corners.isCornerCard('TD-12') === false && corners.isCornerCard('td-12') === false);
  check('LaPorta is excluded', corners.isCornerCard('LAPORTA') === false);
  check('shadow test is excluded', corners.isCornerCard('SHADOW-TD-01') === false);
  check('TD-14 stays eligible', corners.isCornerCard('TD-14') === true);
  check('TD-11 stays eligible', corners.isCornerCard('TD-11') === true);

  const rect = cardRect();
  const w = Math.ceil(rect.right + 80);
  const h = Math.ceil(rect.bottom + 80);
  const geom = edgesFor(rect);

  const sharp = paint(w, h, rect, { radiusMm: 0, riseMm: 0.08, card: [36, 64, 140] });
  const sharpPaired = measureBoth(sharp, w, h, geom);
  const sharpTl = sharpPaired.corners.tl;
  check(
    'sharp corner withholds inside the scanner rise',
    sharpTl.rounding.withheld && sharpTl.rounding.reason === 'inside-scanner-rise' && sharpTl.rounding.radiusMm == null,
    sharpTl.rounding
  );
  const sharpRise = sharpTl.up && sharpTl.up.riseMm;
  check(
    'synthetic 10–90 rise stays on the ramp',
    sharpRise && sharpRise.top > 0.03 && sharpRise.top < 0.14 && sharpRise.left > 0.03 && sharpRise.left < 0.14,
    sharpRise
  );
  check(
    'sharp corner publishes no ding and no fray',
    sharpTl.ding.depthMm === 0 && sharpTl.fray.lengthMm === 0 && sharpTl.whitening.areaMm2 === 0,
    { ding: sharpTl.ding, fray: sharpTl.fray, white: sharpTl.whitening }
  );

  const rounded = paint(w, h, rect, { radiusMm: 0.4, riseMm: 0.08, card: [36, 64, 140] });
  const roundPaired = measureBoth(rounded, w, h, geom);
  ['tl', 'tr', 'br', 'bl'].forEach(function (name) {
    const got = roundPaired.corners[name].rounding;
    const setback = 0.4 * (Math.SQRT2 - 1);
    check(
      name + ' recovers a 0.40 mm radius',
      got.withheld === false && Math.abs(got.radiusMm - 0.4) <= 0.1 && Math.abs(got.setbackMm - setback) <= 0.1,
      got
    );
  });

  const white = paint(w, h, rect, {
    radiusMm: 0,
    riseMm: 0.08,
    card: [30, 40, 80],
    border: [250, 250, 248],
    borderMm: 3,
    pale: { fromLeftMm: 0.2, t0: 0.15, t1: 1.0, d0: 0.45, d1: 1.05, color: [252, 252, 252] }
  });
  const whitePaired = measureBoth(white, w, h, geom);
  check(
    'white border withholds whitening',
    whitePaired.corners.tl.whitening.withheld && whitePaired.corners.tl.whitening.reason === 'white-border' &&
      whitePaired.corners.tl.whitening.areaMm2 == null,
    whitePaired.corners.tl.whitening
  );

  const colored = paint(w, h, rect, {
    radiusMm: 0,
    riseMm: 0.08,
    card: [20, 40, 90],
    border: [210, 190, 40],
    borderMm: 3.2,
    pale: { fromLeftMm: 30.85, t0: 0, t1: 0.7, d0: 0.45, d1: 1.05, color: [245, 240, 220] }
  });
  const coloredPaired = measureBoth(colored, w, h, geom);
  const trWhite = coloredPaired.corners.tr.whitening;
  check(
    'pale patch on a colored border reports area',
    trWhite.withheld === false && trWhite.areaMm2 > 0.05 && trWhite.lengthMm > 0.4,
    trWhite
  );
  check(
    'the opposite corner of that card stays clean',
    coloredPaired.corners.bl.whitening.withheld === false && coloredPaired.corners.bl.whitening.areaMm2 === 0,
    coloredPaired.corners.bl.whitening
  );

  const notched = paint(w, h, rect, {
    radiusMm: 0,
    riseMm: 0.08,
    card: [36, 64, 140],
    notch: { edge: 'bottom', fromLeftMm: 1.0, fromTopMm: 0, halfMm: 0.28, depthMm: 0.4 }
  });
  const notchPaired = measureBoth(notched, w, h, geom);
  const blDing = notchPaired.corners.bl.ding;
  check(
    'a notch reports ding depth',
    blDing.withheld === false && blDing.depthMm >= 0.2 && blDing.depthMm <= 0.6 && blDing.fromTipMm != null,
    blDing
  );
  check(
    'a corner without the notch publishes depth 0',
    notchPaired.corners.tl.ding.depthMm === 0,
    notchPaired.corners.tl.ding
  );

  const frayed = paint(w, h, rect, {
    radiusMm: 0,
    riseMm: 0.08,
    card: [36, 64, 140],
    fray: { fromLeftMm: 1.4, lengthMm: 0.55, stickMm: 0.22 }
  });
  const frayPaired = measureBoth(frayed, w, h, geom);
  const tlFray = frayPaired.corners.tl.fray;
  check(
    'fibers outside the cut report length',
    tlFray.withheld === false && tlFray.lengthMm >= 0.3 && tlFray.lengthMm <= 0.9 && tlFray.stickOutMm >= 0.1,
    tlFray
  );

  const upOnly = corners.measureRaster({
    data: frayed,
    width: w,
    height: h,
    dpi: DPI,
    paper: paperColor(),
    sizeOk: true,
    corners: geom.corners,
    edges: geom.edges
  });
  const clean = paint(w, h, rect, { radiusMm: 0, riseMm: 0.08, card: [36, 64, 140] });
  const cleanReading = corners.measureRaster({
    data: clean,
    width: w,
    height: h,
    dpi: DPI,
    paper: paperColor(),
    sizeOk: true,
    corners: geom.corners,
    edges: geom.edges
  });
  const dust = corners.pairReadings(upOnly, cleanReading, null);
  check(
    'a fiber on only one orientation is withheld',
    dust.corners.tl.fray.withheld && dust.corners.tl.fray.reason === 'orientation-disagreement' && dust.corners.tl.fray.lengthMm == null,
    dust.corners.tl.fray
  );

  const blocked = corners.pairReadings(
    roundPaired.sources.up,
    roundPaired.sources['180'],
    { top: false, bottom: false, left: true, right: false }
  );
  check(
    'a withheld centering side publishes no radius',
    blocked.corners.tl.rounding.radiusMm == null && blocked.corners.tl.rounding.reason === 'centering-side-withheld',
    blocked.corners.tl.rounding
  );

  const missing = corners.pairReadings(
    Object.assign({}, roundPaired.sources.up, { sizeOk: false }),
    roundPaired.sources['180'],
    null
  );
  ['tl', 'tr', 'br', 'bl'].forEach(function (name) {
    const got = missing.corners[name];
    check(
      name + ' withholds when the quad is not card-sized',
      got.rounding.reason === 'not-card-sized' && got.rounding.radiusMm == null &&
        got.whitening.areaMm2 == null && got.ding.depthMm == null && got.fray.lengthMm == null,
      got.rounding
    );
  });

  const doc = corners.reviewDocument({});
  check('review document stays unapproved', doc.approved === false && doc.excluded.indexOf('TD-12') >= 0);
  check(
    'pending worn ids are TD-14 through TD-18',
    doc.pendingScans.worn.join(',') === 'TD-14,TD-15,TD-16,TD-17,TD-18'
  );

  if (failed) {
    console.error(failed + ' failure(s)');
    process.exitCode = 1;
  } else {
    console.log('self-test ok');
  }
}

if (require.main === module) run();

module.exports = { run: run };
