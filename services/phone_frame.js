/**
 * services/phone_frame.js
 *
 * One phone photo, already warped so the raster edges are the card cut.
 * Stations are read the same way the flatbed reads a side: a profile inward
 * from the cut, the design-block outline, and the frame marks. The shared
 * matcher then runs. Nothing here is an upright/180 average, and no
 * millimetre is added.
 *
 * The step finder stays when it is already on that outline. "Already on"
 * uses the existing 3 px group gap (0.296 mm on the 643-wide warp).
 * A step inside the design is replaced when the matcher accepted that
 * side. A shallower step is replaced in that same case. A solid outermost
 * step stays, so a pale strip is not pushed inward. An anchored-thin step
 * under 1.185 mm is replaced when its vote is a minority and the outline
 * is past the floor. A vote broken up along the edge is withheld when the
 * straight-edge profile sits on the outline. A contiguous partial edge
 * stays. An outline under 1.185 mm, or
 * past 12% of the card, is not published.
 */
'use strict';

const designOutline = require('./design_outline');
const cardOutline = require('./card_outline');

const CARD_W_MM = 63.5;
const CARD_H_MM = 88.9;
const DEPTH_STEP_MM = 0.02;
const STATION_STEP_MM = 0.4;
const SEARCH_TO_MM = 14;
const SIDE_MARGIN = 0.1;
const EDGES = ['left', 'right', 'top', 'bottom'];

function sampleRgb(data, w, h, channels, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = (y0 * w + x0) * channels;
  const i10 = (y0 * w + x1) * channels;
  const i01 = (y1 * w + x0) * channels;
  const i11 = (y1 * w + x1) * channels;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v0 = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const v1 = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[c] = v0 * (1 - ty) + v1 * ty;
  }
  return out;
}

function sideGeometry(name, w, h) {
  const ppmX = w / CARD_W_MM;
  const ppmY = h / CARD_H_MM;
  if (name === 'left') {
    return {
      lengthMm: CARD_H_MM, ppmAlong: ppmY, ppmDepth: ppmX, nx: 1, ny: 0,
      at: function (alongPx) { return { x: 0, y: alongPx }; }
    };
  }
  if (name === 'right') {
    return {
      lengthMm: CARD_H_MM, ppmAlong: ppmY, ppmDepth: ppmX, nx: -1, ny: 0,
      at: function (alongPx) { return { x: w - 1, y: alongPx }; }
    };
  }
  if (name === 'top') {
    return {
      lengthMm: CARD_W_MM, ppmAlong: ppmX, ppmDepth: ppmY, nx: 0, ny: 1,
      at: function (alongPx) { return { x: alongPx, y: 0 }; }
    };
  }
  return {
    lengthMm: CARD_W_MM, ppmAlong: ppmX, ppmDepth: ppmY, nx: 0, ny: -1,
    at: function (alongPx) { return { x: alongPx, y: h - 1 }; }
  };
}

function profileAt(data, w, h, channels, origin, g, depthSteps) {
  const profile = new Array(depthSteps);
  for (let i = 0; i < depthSteps; i++) {
    const depthMm = i * DEPTH_STEP_MM;
    profile[i] = sampleRgb(
      data, w, h, channels,
      origin.x + g.nx * depthMm * g.ppmDepth,
      origin.y + g.ny * depthMm * g.ppmDepth
    );
  }
  return profile;
}

function stationFromProfile(profile, origin, g, alongMm, t) {
  const designStart = designOutline.outlineStartIndex(profile, DEPTH_STEP_MM);
  const model = designOutline.marginModelFromProfile(profile, designStart, DEPTH_STEP_MM);
  const designDepth = designOutline.lastingDesignDepth(
    profile, DEPTH_STEP_MM, model, designStart * DEPTH_STEP_MM, SEARCH_TO_MM
  );
  return {
    x: origin.x,
    y: origin.y,
    nx: g.nx,
    ny: g.ny,
    alongMm: alongMm,
    t: t,
    margin: model ? model.med : null,
    marginTextured: !!(model && model.textured),
    marginPattern: !!(model && model.pattern),
    marginVaried: !!(model && model.variedColour),
    designDepth: designDepth,
    candidates: [],
    frameMarks: cardOutline.frameMarksFromProfile(profile, DEPTH_STEP_MM),
    goldMarks: cardOutline.goldMarksFromProfile(profile, DEPTH_STEP_MM)
  };
}

function sampleSide(data, w, h, channels, name) {
  const g = sideGeometry(name, w, h);
  const lengthPx = g.lengthMm * g.ppmAlong;
  const stepPx = STATION_STEP_MM * g.ppmAlong;
  const depthSteps = Math.round(SEARCH_TO_MM / DEPTH_STEP_MM);
  const start = lengthPx * SIDE_MARGIN;
  const end = lengthPx * (1 - SIDE_MARGIN);
  const stations = [];
  for (let s = start; s <= end; s += stepPx) {
    const origin = g.at(s);
    const profile = profileAt(data, w, h, channels, origin, g, depthSteps);
    const alongMm = s / g.ppmAlong;
    const t = (s - start) / Math.max(1e-6, end - start);
    stations.push(stationFromProfile(profile, origin, g, alongMm, t));
  }
  // The gold frame's outer corners sit in the end zone the design search
  // leaves alone. They are corner contacts only.
  const goldEnds = [];
  const endStep = 0.25 * g.ppmAlong;
  const mainStart = lengthPx * SIDE_MARGIN;
  const mainEnd = lengthPx * (1 - SIDE_MARGIN);
  function addGoldEnd(s) {
    const origin = g.at(s);
    const profile = profileAt(data, w, h, channels, origin, g, depthSteps);
    goldEnds.push({
      x: origin.x,
      y: origin.y,
      nx: g.nx,
      ny: g.ny,
      alongMm: s / g.ppmAlong,
      goldMarks: cardOutline.goldMarksFromProfile(profile, DEPTH_STEP_MM)
    });
  }
  for (let s = 1.2 * g.ppmAlong; s < mainStart; s += endStep) addGoldEnd(s);
  for (let s = mainEnd + endStep; s <= lengthPx - 1.2 * g.ppmAlong; s += endStep) addGoldEnd(s);
  const best = cardOutline.summarizeDesign(stations);
  best.side = name;
  best.lengthMm = g.lengthMm;
  best.stations = stations;
  best.goldEnds = goldEnds;
  return best;
}

/**
 * Millimetres from the card cut to the shared outline, or null when that
 * side is withheld. The matcher has already replaced a matched frame.
 */
function measureWarp(warp) {
  const out = { left: null, right: null, top: null, bottom: null, matched: false };
  if (!warp || !warp.data || !warp.width || !warp.height) return out;
  const channels = warp.channels || 3;
  if (channels < 3) return out;
  const sides = {};
  EDGES.forEach(function (name) {
    sides[name] = sampleSide(warp.data, warp.width, warp.height, channels, name);
  });
  const before = {};
  EDGES.forEach(function (name) { before[name] = sides[name].mm; });
  cardOutline.applyRectangularFrame(sides);
  out.designMm = {};
  out.frameMatches = {};
  EDGES.forEach(function (name) {
    const side = sides[name];
    out.designMm[name] = before[name] == null ? null : Math.round(before[name] * 1000) / 1000;
    out.frameMatches[name] = !!(side && side.frameMatches);
    out[name] = side && side.withheld !== true && side.mm != null && isFinite(side.mm) ? side.mm : null;
    if (side && side.frameMatches && before[name] !== side.mm) out.matched = true;
  });
  return out;
}

/**
 * Keep the step finder when it is on the outline. Take the outline when
 * the step withheld, when the matcher accepted a different line, or when
 * an anchored-thin minority is under the floor. A solid outermost step
 * stays. A step the straight-edge profile does not share with the outline
 * is withheld. An outline under the floor, or past the inward cap, stays off.
 *
 * @returns {{mm: object, replaced: string[], withheld: string[]}}
 */
function adoptOutline(stepMm, outlineMm, floorMm, gapMmFor, options) {
  const opts = options || {};
  const low = opts.lowConfidence || [];
  const matched = opts.frameMatches || {};
  const maxMmFor = opts.maxMmFor;
  const mm = {
    left: stepMm ? stepMm.left : null,
    right: stepMm ? stepMm.right : null,
    top: stepMm ? stepMm.top : null,
    bottom: stepMm ? stepMm.bottom : null
  };
  const replaced = [];
  const withheld = [];
  if (!outlineMm) return { mm: mm, replaced: replaced, withheld: withheld };
  EDGES.forEach(function (edge) {
    const outlined = outlineMm[edge];
    if (outlined == null || !isFinite(outlined) || outlined < floorMm) return;
    if (maxMmFor && outlined > maxMmFor(edge)) return;
    const step = mm[edge];
    const published = Math.round(outlined * 1000) / 1000;
    if (step == null || !isFinite(step)) {
      mm[edge] = published;
      replaced.push(edge);
      return;
    }
    const delta = outlined - step;
    if (Math.abs(delta) <= gapMmFor(edge)) return;
    if (matched[edge]) {
      mm[edge] = published;
      replaced.push(edge);
      return;
    }
    // The thin exception kept a sliver. A minority sliver is not the
    // outline when the shared reading is past the floor.
    if (step < floorMm && low.indexOf(edge) >= 0) {
      mm[edge] = published;
      replaced.push(edge);
    }
  });
  // The vote landed on a different line from the straight-edge profile,
  // and that profile is the outline. Do not publish the vote. A side the
  // matcher already accepted keeps the outline.
  const mismatch = opts.profileMismatch || [];
  mismatch.forEach(function (edge) {
    if (replaced.indexOf(edge) >= 0) return;
    if (mm[edge] == null) return;
    mm[edge] = null;
    withheld.push(edge);
  });
  return { mm: mm, replaced: replaced, withheld: withheld };
}

module.exports = {
  measureWarp: measureWarp,
  adoptOutline: adoptOutline,
  DEPTH_STEP_MM: DEPTH_STEP_MM,
  STATION_STEP_MM: STATION_STEP_MM
};
