/**
 * services/grading_engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Proprietary Centering Engine — Phase 2
 *
 * Responsibilities:
 *   1. Decode an incoming base64 card image (JPEG or PNG).
 *   2. Derive the card's border colour by sampling all four corners.
 *   3. Walk inward from each edge along the horizontal and vertical midlines,
 *      finding the pixel where the border transitions into inner artwork.
 *   4. Compute left/right and top/bottom pixel ratios.
 *   5. Map the worst-case deviation from 50/50 to a numeric grade (10 → 6)
 *      using the CENTERING_THRESHOLDS table below.
 *
 * Modular contract (BusinessPlan §3 Module B):
 *   • Input  : base64 string (with or without data-URL prefix)
 *   • Output : { centering, numericGrade, centeringGrade, rawMeasurements,
 *               notes, engineVersion }
 *   Replace the body of analyzeImageBuffer() in Phase 3 with a trained CV
 *   model call — the output schema stays the same, so no other file changes.
 *
 * Guard clauses:
 *   • Missing / empty input       → throws TypeError immediately
 *   • Corrupt / unreadable image  → throws Error with message from Jimp
 *   • No border transition found  → falls back to symmetric 50/50 defaults
 *   • Division by zero in ratios  → clamped to 50/50
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const Jimp = require('jimp');

// ─── Centering Grade Table ─────────────────────────────────────────────────
//
// Derived from PSA / Beckett published centering standards.
// maxDeviation = the worst-case deviation (in percentage points) from a
// perfect 50/50 split that still qualifies for that grade.
//
// Example: a card measuring 58% Left / 42% Right has a horizontal deviation
// of |58 - 50| = 8 pp, which falls inside grade 9 (≤ 10 pp) but outside
// grade 10 (≤ 5 pp).
//
// Ordered from strictest (10) to most lenient (6).  Anything beyond grade 6
// is returned as grade 5 with label "Off-Center".
//
const CENTERING_THRESHOLDS = [
  { numericGrade: 10, label: 'Gem Mint',          maxDeviation:  5 },
  { numericGrade:  9, label: 'Mint',               maxDeviation: 10 },
  { numericGrade:  8, label: 'Near Mint-Mint',     maxDeviation: 15 },
  { numericGrade:  7, label: 'Near Mint',          maxDeviation: 20 },
  { numericGrade:  6, label: 'Excellent-Mint',     maxDeviation: 25 },
  { numericGrade:  5, label: 'Off-Center',         maxDeviation: Infinity }, // catch-all
];

// ─── Tuning Constants ─────────────────────────────────────────────────────
const CORNER_SAMPLE_RADIUS = 8;   // pixel radius averaged per corner sample
const DEVIATION_THRESHOLD  = 30;  // brightness delta that signals border → artwork
const MAX_SCAN_FRACTION    = 0.45; // never scan past 45 % of the image dimension

// ─── Internal Helpers ─────────────────────────────────────────────────────

/**
 * perceptualBrightness(r, g, b) → number [0–255]
 * ITU-R BT.601 luminance formula — weights channels as the human eye does.
 */
function perceptualBrightness(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * sampleRegionBrightness(image, cx, cy, radius) → number
 * Averages brightness over a (2·radius+1)² pixel square centred on (cx, cy).
 * Coordinates are clamped to image bounds, so corner regions are safe to sample.
 */
function sampleRegionBrightness(image, cx, cy, radius) {
  const { width, height } = image.bitmap;
  let total = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.min(Math.max(cx + dx, 0), width  - 1);
      const py = Math.min(Math.max(cy + dy, 0), height - 1);
      const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(px, py));
      total += perceptualBrightness(r, g, b);
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * findArtworkEdge(image, axis, direction, midpoint, borderBrightness) → number
 *
 * Scans inward from one card edge to find the first pixel that deviates from
 * the sampled border colour, indicating the start of the inner artwork area.
 *
 * @param {Jimp}   image            Loaded image
 * @param {'x'|'y'} axis            Scanning axis
 * @param {'fwd'|'bwd'} direction   fwd = left/top edge;  bwd = right/bottom edge
 * @param {number} midpoint         Fixed coordinate on the other axis
 * @param {number} borderBrightness Reference brightness from corner sampling
 * @returns {number} Pixel distance from that edge to the artwork boundary.
 *                   Returns a 5 % fallback if no transition is detected.
 */
function findArtworkEdge(image, axis, direction, midpoint, borderBrightness) {
  const { width, height } = image.bitmap;
  const limit   = axis === 'x' ? width : height;
  const maxScan = Math.floor(limit * MAX_SCAN_FRACTION);

  const start = direction === 'fwd' ? 0 : limit - 1;
  const end   = direction === 'fwd' ? maxScan : limit - 1 - maxScan;
  const step  = direction === 'fwd' ? 1 : -1;

  for (
    let i = start;
    direction === 'fwd' ? i < end : i > end;
    i += step
  ) {
    const px = axis === 'x' ? i : midpoint;
    const py = axis === 'x' ? midpoint : i;

    const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(px, py));
    const brightness   = perceptualBrightness(r, g, b);

    if (Math.abs(brightness - borderBrightness) > DEVIATION_THRESHOLD) {
      return direction === 'fwd' ? i : limit - 1 - i;
    }
  }

  // No clear transition found — return a safe 5 % default so math stays valid
  return Math.floor(limit * 0.05);
}

/**
 * mapDeviationToGrade(maxDeviation) → { numericGrade, label }
 *
 * Walks the CENTERING_THRESHOLDS table and returns the first entry whose
 * maxDeviation threshold the supplied deviation does not exceed.
 *
 * @param {number} maxDeviation  Worst-case deviation in percentage points (0–50)
 */
function mapDeviationToGrade(maxDeviation) {
  for (const entry of CENTERING_THRESHOLDS) {
    if (maxDeviation <= entry.maxDeviation) {
      return { numericGrade: entry.numericGrade, label: entry.label };
    }
  }
  // Unreachable (Infinity catch-all always matches), but TypeScript-safe fallback
  return { numericGrade: 1, label: 'Poor' };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * analyzeImageBuffer(base64String) → Promise<GradingReport>
 *
 * Main entry point.  Called by the /api/grade route in server.js.
 *
 * @param  {string} base64String  Base64-encoded JPEG/PNG (data-URL prefix optional)
 * @returns {Promise<Object>}     Structured grading report
 *
 * @throws {TypeError}  If base64String is absent or not a string
 * @throws {Error}      If Jimp cannot decode the image data
 */
async function analyzeImageBuffer(base64String) {
  // ── Guard clauses ──────────────────────────────────────────────────────
  if (!base64String) {
    throw new TypeError('analyzeImageBuffer: base64String is required');
  }
  if (typeof base64String !== 'string') {
    throw new TypeError('analyzeImageBuffer: base64String must be a string');
  }

  // Strip optional data-URL prefix (e.g. "data:image/jpeg;base64,")
  const raw    = base64String.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(raw, 'base64');

  if (buffer.length < 100) {
    throw new Error('analyzeImageBuffer: image buffer too small — likely corrupt or empty');
  }

  // ── Load & decode ──────────────────────────────────────────────────────
  // Jimp.read throws if the buffer is not a valid image; let the error propagate
  // to the caller (server.js catches it and returns HTTP 500 with the message).
  const image  = await Jimp.read(buffer);
  const { width, height } = image.bitmap;

  if (width < 20 || height < 20) {
    throw new Error(`analyzeImageBuffer: image dimensions too small (${width}×${height})`);
  }

  // ── Step 1: Sample border colour from all four corners ─────────────────
  // Corners are always in the card border area (never the inner artwork),
  // so averaging them gives a robust reference regardless of card colour.
  const m = CORNER_SAMPLE_RADIUS + 2; // safe inset from the absolute edge
  const topLeftBright     = sampleRegionBrightness(image, m,         m,          CORNER_SAMPLE_RADIUS);
  const topRightBright    = sampleRegionBrightness(image, width - m,  m,          CORNER_SAMPLE_RADIUS);
  const bottomLeftBright  = sampleRegionBrightness(image, m,          height - m, CORNER_SAMPLE_RADIUS);
  const bottomRightBright = sampleRegionBrightness(image, width - m,  height - m, CORNER_SAMPLE_RADIUS);
  const borderBrightness  = (topLeftBright + topRightBright + bottomLeftBright + bottomRightBright) / 4;

  // ── Step 2: Locate artwork boundary on all four sides ──────────────────
  const midX = Math.floor(width  / 2);
  const midY = Math.floor(height / 2);

  const leftPx   = findArtworkEdge(image, 'x', 'fwd', midY, borderBrightness);
  const rightPx  = findArtworkEdge(image, 'x', 'bwd', midY, borderBrightness);
  const topPx    = findArtworkEdge(image, 'y', 'fwd', midX, borderBrightness);
  const bottomPx = findArtworkEdge(image, 'y', 'bwd', midX, borderBrightness);

  // ── Step 3: Compute centering ratios ───────────────────────────────────
  // Guard against divide-by-zero: if both sides return 0, default to 50/50.
  const hTotal = leftPx  + rightPx  || 1;
  const vTotal = topPx   + bottomPx || 1;

  const leftPct   = Math.round((leftPx  / hTotal) * 100);
  const rightPct  = 100 - leftPct;
  const topPct    = Math.round((topPx   / vTotal) * 100);
  const bottomPct = 100 - topPct;

  // ── Step 4: Derive grade from worst-case deviation ─────────────────────
  // We use the MAXIMUM of the horizontal and vertical deviations so that a
  // card badly off-centre in even one axis is penalised appropriately.
  const hDeviation   = Math.abs(leftPct  - 50);
  const vDeviation   = Math.abs(topPct   - 50);
  const maxDeviation = Math.max(hDeviation, vDeviation);

  const { numericGrade, label: centeringGrade } = mapDeviationToGrade(maxDeviation);

  // ── Return structured report ────────────────────────────────────────────
  return {
    centering: {
      // Display-ready labels for the dashboard overlay
      leftLabel:   `${leftPct}% Left`,
      rightLabel:  `${rightPct}% Right`,
      topLabel:    `${topPct}% Top`,
      bottomLabel: `${bottomPct}% Bottom`,
      hRatio:      `${leftPct}/${rightPct}`,
      vRatio:      `${topPct}/${bottomPct}`,
      // Raw percentages for wallet_engine.js and future scoring formula
      leftPct,
      rightPct,
      topPct,
      bottomPct,
    },
    numericGrade,      // 5–10  (used by wallet_engine.js for pricing)
    centeringGrade,    // human-readable label
    // Raw pixel measurements stored for future ML retraining (Phase 3 flywheel)
    rawMeasurements: {
      leftPx, rightPx, topPx, bottomPx,
      hDeviation, vDeviation, maxDeviation,
      borderBrightness:   Math.round(borderBrightness),
      imageDimensions:    { width, height },
    },
    notes:         'Phase 2 centering engine — contrast-based midline scan with corner-sampled border reference.',
    engineVersion: '2.1.0',
  };
}

/**
 * gradeBuffer(buffer, opts) → Promise<GradingReport>
 *
 * Convenience wrapper called by the /api/grade multer route in server.js.
 * Converts a Node.js Buffer to a base64 string then delegates to analyzeImageBuffer().
 *
 * @param {Buffer} buffer  Raw image bytes (JPEG or PNG)
 * @param {Object} [opts]  Reserved for future options (cardType, weights, etc.)
 */
async function gradeBuffer(buffer, opts) {
  // Guard clause
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('gradeBuffer: buffer must be a non-empty Node.js Buffer');
  }
  const base64 = buffer.toString('base64');
  return analyzeImageBuffer(base64);
}

module.exports = { analyzeImageBuffer, gradeBuffer };
