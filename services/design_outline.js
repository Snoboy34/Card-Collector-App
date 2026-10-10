/**
 * services/design_outline.js
 *
 * Shared rules for where the design block starts. The flatbed measurer
 * calls this. A step is the outline only when it is the boundary between
 * the card's margin and the design block. Texture or shading inside a
 * uniform margin — foil stripes, gloss, scanner noise — is not that
 * boundary. A mark that returns to the margin, or that covers only part
 * of a side, is not the outline either.
 *
 * The width is the distance from the card edge to the outermost points of
 * the outline. tiltDegrees is the angle of those points against the card
 * edge. Positive means the border widens as you travel from the side's
 * start corner toward its end corner.
 */
'use strict';

const CONTRAST_FLOOR = 12;
const MARGIN_DIST = 40;

function rgbDist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort(function (a, b) { return a - b; });
  const m = s.length >> 1;
  if (s.length % 2) return s[m];
  return 0.5 * (s[m - 1] + s[m]);
}

function luma(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function chroma(rgb) {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function smooth5(values) {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const w = k === 0 ? 2 : 1;
      acc += values[j] * w;
      wsum += w;
    }
    out[i] = acc / wsum;
  }
  return out;
}

function colorAt(profile, depth, stepMm) {
  const idx = Math.round(depth / stepMm);
  if (idx < 0 || idx >= profile.length) return null;
  return profile[idx];
}

// Where the margin sample starts. Only the paper-to-card step, in the
// first half millimetre, is skipped. A frame further in is the design
// boundary, so the margin has to be read on the outside of it. Taking the
// strongest peak in a wide window reads the margin from inside that frame.
function outlineStartIndex(profile, stepMm) {
  const n = profile.length;
  if (n < 8) return 0;
  const grad = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    if (!profile[i] || !profile[i + 1]) continue;
    grad[i] = rgbDist(profile[i], profile[i + 1]);
  }
  const sm = smooth5(grad);
  const need = Math.max(3, Math.round(0.28 / stepMm));
  const opening = Math.min(n - 2, Math.round(0.5 / stepMm));
  let peakI = -1;
  let peakV = 0;
  for (let i = 1; i <= opening; i++) {
    if (sm[i] < CONTRAST_FLOOR) continue;
    if (sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
    peakI = i;
    peakV = sm[i];
  }
  const quiet = peakV > 0 ? Math.max(CONTRAST_FLOOR, peakV * 0.12) : CONTRAST_FLOOR;
  const searchFrom = peakI < 0 ? 1 : peakI + 1;
  const searchEnd = Math.min(n - need - 1, Math.round(1.0 / stepMm));
  for (let i = searchFrom; i <= searchEnd; i++) {
    let calm = true;
    for (let j = 0; j < need; j++) {
      if (i + j >= n || sm[i + j] > quiet) {
        calm = false;
        break;
      }
    }
    if (calm) return i;
  }
  return Math.min(n - 2, Math.max(1, searchFrom));
}

// A uniform margin can still change brightness. Foil does that every
// fraction of a millimetre while staying the same neutral material.
// Shading inside that range is not a new edge.
function marginModelFromProfile(profile, designStart, stepMm) {
  const colors = [];
  const from = Math.max(0, designStart);
  const span = Math.max(4, Math.round(0.6 / stepMm));
  const end = Math.min(profile.length, from + span);
  for (let i = from; i < end; i++) {
    if (profile[i]) colors.push(profile[i]);
  }
  if (!colors.length) return null;
  const med = [
    median(colors.map(function (c) { return c[0]; })),
    median(colors.map(function (c) { return c[1]; })),
    median(colors.map(function (c) { return c[2]; }))
  ];
  const lums = colors.map(luma).sort(function (a, b) { return a - b; });
  const chrs = colors.map(chroma);
  const lo = Math.max(0, Math.floor((lums.length - 1) * 0.1));
  const hi = Math.min(lums.length - 1, Math.ceil((lums.length - 1) * 0.9));
  const lumLo = lums[lo];
  const lumHi = lums[hi];
  const chrHi = Math.max.apply(null, chrs);
  const textured = (lumHi - lumLo) >= 45 && chrHi <= 30;
  return {
    med: med,
    textured: textured,
    chrLimit: Math.max(26, chrHi + 14),
    lumLo: lumLo,
    lumHi: lumHi
  };
}

function isMarginMaterial(rgb, model) {
  if (!rgb || !model || !model.med) return false;
  if (model.textured) {
    if (chroma(rgb) > model.chrLimit) return false;
    const L = luma(rgb);
    if (L < model.lumLo - 35 || L > model.lumHi + 35) return false;
    return true;
  }
  return rgbDist(rgb, model.med) < MARGIN_DIST;
}

// Walk inward from the card edge. Ink that returns to the margin is a mark
// or a stripe in the margin. Ink that keeps going is the design block.
// On a textured margin, brightness stripes are still the margin.
function lastingDesignDepth(profile, stepMm, model, startDepth, maxDepth) {
  if (!model) return null;
  const maxD = Math.min(maxDepth == null ? 14 : maxDepth, (profile.length - 1) * stepMm);
  let depth = startDepth || 0;
  while (depth < maxD) {
    while (depth < maxD && isMarginMaterial(colorAt(profile, depth, stepMm), model)) {
      depth += stepMm;
    }
    if (depth >= maxD) return null;
    const inkStart = depth;
    let marginRun = 0;
    let inkRun = 0;
    let d = depth;
    let returned = false;
    for (; d <= maxD; d += stepMm) {
      if (isMarginMaterial(colorAt(profile, d, stepMm), model)) {
        marginRun += stepMm;
        inkRun = 0;
        if (marginRun >= 0.28) {
          returned = true;
          break;
        }
      } else {
        marginRun = 0;
        inkRun += stepMm;
        if (inkRun >= 0.85) break;
      }
    }
    if (!returned && inkRun >= 0.55) return inkStart;
    depth = d + stepMm;
  }
  return null;
}

// Slope of outline depth against distance along the card edge.
function tiltDegrees(points) {
  const pts = (points || []).filter(function (p) {
    return p && isFinite(p.depth) && isFinite(p.alongMm);
  });
  if (pts.length < 2) return null;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let z0 = 0;
  let z1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = pts[i].alongMm;
    const z = pts[i].depth;
    s0 += 1;
    s1 += t;
    s2 += t * t;
    z0 += z;
    z1 += z * t;
  }
  const det = s0 * s2 - s1 * s1;
  if (Math.abs(det) < 1e-8) return 0;
  const slope = (s0 * z1 - s1 * z0) / det;
  return Math.atan(slope) * (180 / Math.PI);
}

module.exports = {
  outlineStartIndex: outlineStartIndex,
  marginModelFromProfile: marginModelFromProfile,
  isMarginMaterial: isMarginMaterial,
  lastingDesignDepth: lastingDesignDepth,
  tiltDegrees: tiltDegrees,
  CONTRAST_FLOOR: CONTRAST_FLOOR
};
