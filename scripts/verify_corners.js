#!/usr/bin/env node
/**
 * scripts/verify_corners.js
 *
 * Synthetic flatbed corners at 1200 dpi. A known radius has to come back
 * within 0.1 mm. A setback inside the scanner rise is a sharp result, with
 * that limit stated. A white border, a one-sided defect, a not-card-sized
 * quad, and TD-12 stay withheld. No scan files and no network.
 */
'use strict';

const fs = require('fs');
const path = require('path');
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
    'sharp corner reports the scanner limit',
    sharpTl.approved === false &&
      sharpTl.rounding.withheld === false &&
      sharpTl.rounding.sharp === true &&
      sharpTl.rounding.radiusMm == null &&
      sharpTl.rounding.setbackMm == null &&
      sharpTl.rounding.limitMm > 0 &&
      sharpTl.rounding.label === 'sharp: setback under ' + sharpTl.rounding.limitMm.toFixed(3) + ' mm (scanner limit)' &&
      sharpTl.up.rounding.setbackMm != null &&
      sharpTl.up.rounding.setbackMm <= sharpTl.up.rounding.limitMm &&
      sharpTl['180'].rounding.setbackMm != null &&
      sharpTl['180'].rounding.setbackMm <= sharpTl['180'].rounding.limitMm,
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
      whitePaired.corners.tl.whitening.label === 'not applicable' &&
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

  const sharpBlocked = corners.pairReadings(
    sharpPaired.sources.up,
    sharpPaired.sources['180'],
    { top: false, bottom: false, left: true, right: false }
  );
  check(
    'a withheld centering side clears a sharp label',
    sharpBlocked.corners.tl.rounding.reason === 'centering-side-withheld' &&
      sharpBlocked.corners.tl.rounding.label == null &&
      sharpBlocked.corners.tl.rounding.radiusMm == null &&
      sharpBlocked.corners.tl.up.rounding.sharp === true &&
      sharpBlocked.corners.tl.up.rounding.label.indexOf('sharp: setback under ') === 0,
    sharpBlocked.corners.tl.rounding
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
    'worn set TD-14 through TD-21 is in the review',
    doc.pendingScans.worn.length === 0 &&
      !doc.pendingScans.backs &&
      doc.definition.indexOf('TD-14 through TD-21 are an unapproved worn and control review') >= 0 &&
      doc.wornSet['TD-18'].role === 'control' &&
      doc.wornSet['TD-21'].role === 'control' &&
      doc.wornSet['TD-14'].role === 'worn' &&
      doc.wornSet['TD-14'].name === 'Kugler' &&
      Object.keys(doc.wornSet).join(',') === 'TD-14,TD-15,TD-16,TD-17,TD-18,TD-19,TD-20,TD-21'
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reference', 'flatbed_manifest.json'), 'utf8'));
  const backFiles = manifest.backs && manifest.backs.files ? manifest.backs.files : {};
  const backNames = Object.keys(backFiles);
  const frontNames = Object.keys(manifest).filter(function (name) {
    return manifest[name] && manifest[name].deck && (manifest[name].orientation === 'up' || manifest[name].orientation === '180');
  });
  check(
    'back scans stay out of the front manifest entries',
    backNames.length === 24 &&
      manifest.backs.face === 'back' &&
      manifest.backs.shadowFree.indexOf('2026.10.13-shadow-free-v1') >= 0 &&
      backNames.every(function (name) {
        const entry = backFiles[name];
        return entry.face === 'back' && (entry.orientation === 'up' || entry.orientation === '180') &&
          frontNames.indexOf(name) < 0;
      }) &&
      corners.BACK_IDS.every(function (id) {
        return backNames.some(function (name) { return backFiles[name].deck === id && backFiles[name].orientation === 'up'; }) &&
          backNames.some(function (name) { return backFiles[name].deck === id && backFiles[name].orientation === '180'; });
      }),
    backNames.length
  );
  const wornFiles = manifest.worn && manifest.worn.files ? manifest.worn.files : {};
  const wornNames = Object.keys(wornFiles);
  const wornIds = ['TD-14', 'TD-15', 'TD-16', 'TD-17', 'TD-18', 'TD-19', 'TD-20', 'TD-21'];
  check(
    'worn scans stay out of the front manifest entries',
    wornNames.length === 32 &&
      manifest.worn.shadowFree.indexOf('2026.10.13-shadow-free-v1') >= 0 &&
      wornNames.every(function (name) {
        const entry = wornFiles[name];
        return (entry.face === 'front' || entry.face === 'back') &&
          (entry.orientation === 'up' || entry.orientation === '180') &&
          frontNames.indexOf(name) < 0 && backNames.indexOf(name) < 0;
      }) &&
      wornIds.every(function (id) {
        return ['up', '180'].every(function (orientation) {
          return wornNames.some(function (name) {
            return wornFiles[name].deck === id && wornFiles[name].face === 'front' && wornFiles[name].orientation === orientation;
          }) && wornNames.some(function (name) {
            return wornFiles[name].deck === id && wornFiles[name].face === 'back' && wornFiles[name].orientation === orientation;
          });
        });
      }),
    wornNames.length
  );
  const bgs = doc.bgsReference;
  const bush = bgs && bgs.slabs && bgs.slabs[0];
  const rice = bgs && bgs.slabs && bgs.slabs[1];
  check(
    'the two BGS slabs are reference labels',
    bgs && bgs.approved === false && bgs.inAnswerKey === false && bgs.measured === false &&
      bgs.onlySlabs === true && bgs.slabs.length === 2 && !doc.pendingScans.bgsLabels,
    bgs
  );
  check(
    'Bush is corners 9 on white-border Score',
    bush && bush.player === 'Reggie Bush' && bush.year === 2006 && bush.set === 'Score' &&
      bush.number === '360' && bush.overall === 9 && bush.label === 'Mint' &&
      bush.centering === 9.5 && bush.corners === 9 && bush.edges === 9 && bush.surface === 10 &&
      bush.cert === '0005205494' && bush.family === 'white-border Score',
    bush
  );
  check(
    'Rice is corners 9.5 on foil Momentum',
    rice && rice.player === 'Jerry Rice' && rice.year === 2000 &&
      rice.set === 'Playoff Momentum Graded Series' && rice.number === '78' &&
      rice.serial === '1 of 210' && rice.overall === 8.5 && rice.label === 'NM-MT+' &&
      rice.centering === 8.5 && rice.corners === 9.5 && rice.edges === 9 && rice.surface === 8.5 &&
      rice.cert === '0000640358' && rice.family === 'foil Momentum',
    rice
  );
  check(
    'BGS corners are an order check',
    bgs.orderCheck.higher.corners === 9.5 && bgs.orderCheck.higher.cert === '0000640358' &&
      bgs.orderCheck.lower.corners === 9 && bgs.orderCheck.lower.cert === '0005205494' &&
      bgs.calibrationProposal.approved === false && bgs.calibrationProposal.rawCards === 6,
    bgs.orderCheck
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
