/**
 * services/grading_engine.js
 * =============================================================================
 * THE JUDGE — Isolated Proprietary Scoring Module (Node/Express port)
 * =============================================================================
 *
 * Architectural purpose
 * ---------------------
 * This module is the server-side counterpart of `The Judge.swift`. It is the
 * ONLY place the HTTP API is allowed to turn raw structural measurements into
 * a final grade. Vision / image metrology lives in the first half of the file;
 * the scoring formula is fully decoupled from how those measurements were
 * obtained (BusinessPlan.md §4 Module D — Isolated Proprietary Scoring Module).
 *
 * Pipeline (BusinessPlan.md §4 Module B + The Judge.swift)
 * --------------------------------------------------------
 *   1. Image pre-processing (anti-distortion): EXIF rotate, portrait lock,
 *      greyscale, normalize, mild blur to flatten smartphone computational
 *      photography before any measurement.
 *   2. Quad-core metrology against the uploaded still:
 *        - Centering: contrast-variance inward scans along all four borders
 *          (pixel-perfect L/R and T/B print-border ratios).
 *        - Surface: high-frequency residual clusters (scratches), compact
 *          mid-frequency blobs (dimples/dents), long linear faults (creases).
 *        - Edges: perimeter whitening / silvering cluster count.
 *        - Corners: independent 0–5 fraying severity at each of the four
 *          corners; the WORST corner drives the sub-grade (never an average).
 *   3. Four-phase Judge scoring (exact numeric port of
 *      `TheJudge.evaluateMultiPhaseCondition`):
 *        Phase 1  Centering sub-grade from max(L/R, T/B) deviation.
 *        Phase 2  Surface sub-grade with scratch / dimple / crease penalties.
 *        Phase 3  Edges sub-grade from whitening count.
 *        Phase 4  Corners sub-grade from max fraying severity.
 *   4. STRICT 0.5-POINT CONDITION CEILING
 *        A card cannot finish higher than (lowest sub-grade + 0.5).
 *        final = min(average of four sub-grades, lowest + 0.5)
 *        then round to the standard 0.5 lab step and clamp to [1.0, 10.0].
 *
 * Downstream consumers
 * --------------------
 *   - `server.js` POST /api/grade and POST /api/grade/upload call `gradeBuffer`.
 *   - `services/wallet_engine.js` still reads 0–100 `weighted` / `centering`
 *     (those are derived as sub-grade × 10 so existing pricing is unchanged).
 *   - The frontend report modal reads `finalScore`, `subGradesLabel`,
 *     `primaryFlawDescription`, and the legacy 0–100 fields.
 *
 * Public API
 * ----------
 *   evaluateMultiPhaseCondition(centering, surface, edgesWhiteningCount, corners)
 *       Pure scoring. No I/O. Direct port of TheJudge.swift. Safe to unit-test.
 *       Callers MUST pass a real CenteringResult (numeric L/R and T/B ratios).
 *       A failed print-border scan is handled in `gradeBuffer` — never pass
 *       null/undetected centering into this function (it cannot represent
 *       "unknown" and would look like a 50/50 Gem if given empty ratios).
 *   gradeBuffer(buffer, options)
 *       Full still-image pipeline: metrology → evaluateMultiPhaseCondition
 *       when all four print borders resolve; otherwise a partial report with
 *       centeringUndetected / incomplete flags and no overall finalScore.
 *
 * @module services/grading_engine
 */

'use strict';

// -----------------------------------------------------------------------------
// Optional native decoder. If `sharp` is missing we still export the pure
// scoring function so tests / callers can grade pre-measured defects, and
// `gradeBuffer` returns a documented fallback report instead of crashing
// the Express process (keeps /api/health and the rest of the app alive).
// -----------------------------------------------------------------------------
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn(
    'services/grading_engine: optional dependency `sharp` not available — ' +
    'gradeBuffer will return a fallback report; evaluateMultiPhaseCondition remains usable.'
  );
}

/** Lab scale bounds matching CalculatedGrade.finalScore in The Judge.swift. */
const GRADE_SCALE = {
  min: 1.0,
  max: 10.0,
  /** Standard PSA/BGS half-point step. */
  step: 0.5,
  /**
   * Real-world laboratories will not let the overall grade float more than
   * this many points above the worst isolated sub-grade.
   * Port of: `absoluteConditionCeilingLimit = lowestIsolatedSubGrade + 0.5`
   */
  conditionCeilingOffset: 0.5
};

/** Standard trading-card portrait lock: rotate if width exceeds height by >15%. */
const PORTRAIT_LOCK_WIDTH_RATIO = 1.15;

/** PSA 10 centering window (40/60 on each axis) from CenteringAnalyzer.swift. */
const PSA10_CENTERING_MIN = 40.0;
const PSA10_CENTERING_MAX = 60.0;
/** BGS 10 centering window (48/52 — near 50/50). */
const BGS10_CENTERING_MIN = 48.0;
const BGS10_CENTERING_MAX = 52.0;


// =============================================================================
// PART 1 — THE JUDGE: STRICT 4-PHASE SCORING (direct port of The Judge.swift)
// =============================================================================
//
// Every numeric threshold, penalty coefficient, and branch below is copied
// from `TheJudge.evaluateMultiPhaseCondition`. Do not "smooth" or re-weight
// these values here; vision-model improvements belong in the metrology
// section, not in this formula.
// =============================================================================

/**
 * Round a raw 1–10 value onto the standard 0.5 lab step.
 *
 * Port of Swift: `(strictCalculatedFinalGrade * 2.0).rounded() / 2.0`
 * Swift's default `rounded()` is `.toNearestOrAwayFromZero`. For the positive
 * domain used here, `Math.round` matches that rule (e.g. 9.25 → 9.5).
 *
 * @param {number} value
 * @returns {number}
 */
function roundToLabHalfStep(value) {
  return Math.round(value * 2.0) / 2.0;
}

/**
 * Clamp a numeric grade onto the closed [1.0, 10.0] lab interval.
 *
 * @param {number} value
 * @returns {number}
 */
function clampLabGrade(value) {
  return Math.min(GRADE_SCALE.max, Math.max(GRADE_SCALE.min, value));
}

/**
 * PHASE 1 — Centering sub-grade (PSA & BGS tolerances matrix).
 *
 * Inputs are left/right and top/bottom print-border percentages that each
 * already sum to 100 (e.g. 55/45). The score is driven by the WORST axis
 * deviation, never an average of the two, so a perfect T/B cannot rescue a
 * blown L/R.
 *
 * Thresholds (The Judge.swift lines 42–48):
 *   maxDeviation <=  2.0  → 10.0   Perfect 50/50 tracking
 *   maxDeviation <=  4.0  →  9.5   BGS Pristine threshold
 *   maxDeviation <=  9.0  →  9.0   PSA 10 strict bound (≈ 55.5/44.5)
 *   maxDeviation <= 14.0  →  8.0   Near Mint 8 track
 *   maxDeviation <= 20.0  →  7.0
 *   otherwise             →  5.0
 *
 * @param {{ left: number, right: number }} leftRightRatio
 * @param {{ top: number, bottom: number }} topBottomRatio
 * @returns {{ score: number, maxDeviation: number, lrDiff: number, tbDiff: number }}
 */
function scoreCenteringPhase(leftRightRatio, topBottomRatio) {
  const lrDiff = Math.abs(leftRightRatio.left - leftRightRatio.right);
  const tbDiff = Math.abs(topBottomRatio.top - topBottomRatio.bottom);
  const maxCenteringDeviation = Math.max(lrDiff, tbDiff);

  let centeringScore;
  if (maxCenteringDeviation <= 2.0) centeringScore = 10.0;
  else if (maxCenteringDeviation <= 4.0) centeringScore = 9.5;
  else if (maxCenteringDeviation <= 9.0) centeringScore = 9.0;
  else if (maxCenteringDeviation <= 14.0) centeringScore = 8.0;
  else if (maxCenteringDeviation <= 20.0) centeringScore = 7.0;
  else centeringScore = 5.0;

  return { score: centeringScore, maxDeviation: maxCenteringDeviation, lrDiff, tbDiff };
}

/**
 * PHASE 2 — Surface sub-grade (tilt-reflective / still-frame defect penalties).
 *
 * Starts at a perfect 10.0 and subtracts:
 *   - 1 scratch            → −0.5
 *   - N > 1 scratches      → −(N × 0.5)
 *   - each dimple/dent     → −1.0
 *   - KILL SWITCH (crease) → if `surfaceCreaseDetected` OR
 *     `wrinkleOrCreaseSeverity >= 2`, subtract
 *     `max(2, wrinkleOrCreaseSeverity) × 1.5`
 *
 * Floor is 1.0 (never a zero / negative surface sub-grade).
 *
 * @param {{ scratchCount: number, dimpleOrDentCount: number, surfaceCreaseDetected: boolean, wrinkleOrCreaseSeverity: number }} surface
 * @returns {{ score: number, creasePenaltyApplied: boolean, creasePenalty: number }}
 */
function scoreSurfacePhase(surface) {
  let surfaceScore = 10.0;
  const scratchCount = Number(surface.scratchCount) || 0;
  const dimpleOrDentCount = Number(surface.dimpleOrDentCount) || 0;
  const wrinkleOrCreaseSeverity = Number(surface.wrinkleOrCreaseSeverity) || 0;
  const surfaceCreaseDetected = Boolean(surface.surfaceCreaseDetected);

  // Minor print / clearcoat surface scratches.
  if (scratchCount === 1) surfaceScore -= 0.5;
  else if (scratchCount > 1) surfaceScore -= scratchCount * 0.5;

  // Volumetric dimples or print-dot dents.
  if (dimpleOrDentCount > 0) surfaceScore -= dimpleOrDentCount * 1.0;

  // KILL SWITCH: a physical wrinkle or cardboard crease breaks structural safety.
  let creasePenalty = 0;
  let creasePenaltyApplied = false;
  if (surfaceCreaseDetected || wrinkleOrCreaseSeverity >= 2) {
    creasePenalty = Math.max(2, wrinkleOrCreaseSeverity) * 1.5;
    surfaceScore -= creasePenalty;
    creasePenaltyApplied = true;
  }

  const finalSurfaceScore = Math.max(1.0, surfaceScore);
  return { score: finalSurfaceScore, creasePenaltyApplied, creasePenalty };
}

/**
 * PHASE 3 — Edges sub-grade (back-perimeter silvering / whitening).
 *
 *   0 whitening sites → 10.0
 *   1 site            →  9.0   (immediately out of Gem Mint)
 *   2–3 sites         →  8.0
 *   4+ sites          →  5.0
 *
 * @param {number} edgesWhiteningCount
 * @returns {number}
 */
function scoreEdgesPhase(edgesWhiteningCount) {
  const count = Number(edgesWhiteningCount) || 0;
  if (count === 0) return 10.0;
  if (count === 1) return 9.0;
  if (count <= 3) return 8.0;
  return 5.0;
}

/**
 * PHASE 4 — Corners sub-grade (high-res 4-point macro curvature / fray).
 *
 * Driven exclusively by the WORST of the four corners (a single split corner
 * must sink the sub-grade; averaging would hide it).
 *
 *   maxFray == 0 → 10.0
 *   maxFray == 1 →  9.0   light corner softening
 *   maxFray == 2 →  8.0   distinct rounding wear
 *   maxFray == 3 →  6.5   layer splitting / paper lifting
 *   maxFray >= 4 →  4.0
 *
 * @param {{ topLeftFrayingSeverity: number, topRightFrayingSeverity: number, bottomLeftFrayingSeverity: number, bottomRightFrayingSeverity: number }} corners
 * @returns {{ score: number, absoluteMaxCornerFray: number }}
 */
function scoreCornersPhase(corners) {
  const absoluteMaxCornerFray = Math.max(
    Number(corners.topLeftFrayingSeverity) || 0,
    Number(corners.topRightFrayingSeverity) || 0,
    Number(corners.bottomLeftFrayingSeverity) || 0,
    Number(corners.bottomRightFrayingSeverity) || 0
  );

  let cornerScore;
  if (absoluteMaxCornerFray === 0) cornerScore = 10.0;
  else if (absoluteMaxCornerFray === 1) cornerScore = 9.0;
  else if (absoluteMaxCornerFray === 2) cornerScore = 8.0;
  else if (absoluteMaxCornerFray === 3) cornerScore = 6.5;
  else cornerScore = 4.0;

  return { score: cornerScore, absoluteMaxCornerFray };
}

/**
 * Human-readable primary-flaw readout. Branch order is identical to
 * The Judge.swift lines 100–113 so the same physical defect produces the
 * same sentence on iOS and on the Node pipeline.
 *
 * @param {object} args
 * @returns {string}
 */
function describePrimaryFlaw(args) {
  const {
    cappedFinalGrade,
    surface,
    absoluteMaxCornerFray,
    finalSurfaceScore,
    centeringScore
  } = args;

  if (cappedFinalGrade >= 9.5) {
    return 'Gem Mint Compliance Locked. Reflective light sweeps verify zero surface dent fracture lines or micro-creases.';
  }
  if (surface.surfaceCreaseDetected || surface.wrinkleOrCreaseSeverity >= 2) {
    return 'Capped Condition Grade. Volumetric frame processing tracked structural cardboard crease lines or soft wrinkles.';
  }
  if (absoluteMaxCornerFray >= 3) {
    return 'Pristine criteria broken due to corner layer separation or localized card paper splitting.';
  }
  if (finalSurfaceScore <= 8.5) {
    return 'Surface grade lowered due to clearcoat micro-scratch clusters or background indentation dimples.';
  }
  if (centeringScore <= 8.5) {
    return 'Border aspect alignment variation exceeds premium limits. Outer perimeter matrix out of tolerance.';
  }
  return 'Perimeter edge tracking isolated card border silvering or whitening chipping down back line.';
}

/**
 * Map the 10-point Judge scale onto the collector-facing label used by the
 * wallet UI. Gem Mint is locked to the Swift `isGemMint` rule (`>= 9.5`).
 *
 * @param {number} finalScore
 * @returns {string}
 */
function labelForFinalScore(finalScore) {
  if (finalScore >= 9.5) return 'Gem Mint';
  if (finalScore >= 9.0) return 'Mint';
  if (finalScore >= 8.0) return 'Near Mint';
  if (finalScore >= 7.0) return 'Excellent';
  if (finalScore >= 5.0) return 'Very Good';
  return 'Good';
}

/**
 * Fully automated real-world evaluation engine.
 *
 * Direct port of `TheJudge.evaluateMultiPhaseCondition` in The Judge.swift.
 * Accepts already-measured structural inputs (from live Swift CV, from this
 * file's still-image metrology, or from a unit test) and returns the strict
 * dual-scale grade. This function is intentionally free of I/O and of `sharp`
 * so the math can be regression-tested in isolation.
 *
 * CALLER CONTRACT: `centering.leftRightRatio` and `centering.topBottomRatio`
 * must be real numeric percentages that sum to 100 per axis. Do NOT pass a
 * null/undetected result from `measurePrintCentering` (detected === false).
 * That null-check belongs in `gradeBuffer`, upstream of this function. This
 * scorer has no "unknown" state — empty ratios would collapse to a fake 50/50
 * and be indistinguishable from a genuine perfect-centering measurement.
 *
 * @param {{ leftRightRatio: {left:number, right:number}, topBottomRatio: {top:number, bottom:number} }} centering
 * @param {{ scratchCount: number, dimpleOrDentCount: number, surfaceCreaseDetected: boolean, wrinkleOrCreaseSeverity: number }} surface
 * @param {number} edgesWhiteningCount
 * @param {{ topLeftFrayingSeverity: number, topRightFrayingSeverity: number, bottomLeftFrayingSeverity: number, bottomRightFrayingSeverity: number }} corners
 * @returns {object} CalculatedGrade-equivalent plus diagnostic ceiling fields
 */
function evaluateMultiPhaseCondition(centering, surface, edgesWhiteningCount, corners) {
  const leftRightRatio = centering.leftRightRatio || { left: 50, right: 50 };
  const topBottomRatio = centering.topBottomRatio || { top: 50, bottom: 50 };
  const surfaceInput = surface || {
    scratchCount: 0,
    dimpleOrDentCount: 0,
    surfaceCreaseDetected: false,
    wrinkleOrCreaseSeverity: 0
  };
  const cornerInput = corners || {
    topLeftFrayingSeverity: 0,
    topRightFrayingSeverity: 0,
    bottomLeftFrayingSeverity: 0,
    bottomRightFrayingSeverity: 0
  };

  // ----- Phase 1: Centering -----
  const centeringPhase = scoreCenteringPhase(leftRightRatio, topBottomRatio);
  const centeringScore = centeringPhase.score;

  // ----- Phase 2: Surface -----
  const surfacePhase = scoreSurfacePhase(surfaceInput);
  const finalSurfaceScore = surfacePhase.score;

  // ----- Phase 3: Edges -----
  const edgeScore = scoreEdgesPhase(edgesWhiteningCount);

  // ----- Phase 4: Corners -----
  const cornerPhase = scoreCornersPhase(cornerInput);
  const cornerScore = cornerPhase.score;
  const absoluteMaxCornerFray = cornerPhase.absoluteMaxCornerFray;

  // ----- STRICT REAL-WORLD GRADE CEILING -----
  // A card cannot receive a final grade higher than 0.5 points above its
  // lowest isolated sub-grade. This is the rule that stops a Gem-looking
  // average from surviving a single 8.0 corner or a crease-killed surface.
  const subGradesList = [centeringScore, finalSurfaceScore, edgeScore, cornerScore];
  const lowestIsolatedSubGrade = Math.min.apply(null, subGradesList);
  const overallMathematicalAverage =
    (centeringScore + finalSurfaceScore + edgeScore + cornerScore) / 4.0;

  const absoluteConditionCeilingLimit =
    lowestIsolatedSubGrade + GRADE_SCALE.conditionCeilingOffset;
  const strictCalculatedFinalGrade = Math.min(
    overallMathematicalAverage,
    absoluteConditionCeilingLimit
  );
  const conditionCeilingApplied =
    overallMathematicalAverage > absoluteConditionCeilingLimit;

  // Round onto 0.5 lab steps, then clamp to [1.0, 10.0].
  const roundedFinalGrade = roundToLabHalfStep(strictCalculatedFinalGrade);
  const cappedFinalGrade = clampLabGrade(roundedFinalGrade);

  const flawExplanation = describePrimaryFlaw({
    cappedFinalGrade,
    surface: surfaceInput,
    absoluteMaxCornerFray,
    finalSurfaceScore,
    centeringScore
  });

  const subGradesDisplayLabel =
    'CEN: ' + centeringScore.toFixed(1) +
    ' | SUR: ' + finalSurfaceScore.toFixed(1) +
    ' | EDG: ' + edgeScore.toFixed(1) +
    ' | CRN: ' + cornerScore.toFixed(1);

  const leftPct = leftRightRatio.left;
  const topPct = topBottomRatio.top;
  const passesPSA10 =
    leftPct >= PSA10_CENTERING_MIN && leftPct <= PSA10_CENTERING_MAX &&
    topPct >= PSA10_CENTERING_MIN && topPct <= PSA10_CENTERING_MAX;
  const passesBGS10 =
    leftPct >= BGS10_CENTERING_MIN && leftPct <= BGS10_CENTERING_MAX &&
    topPct >= BGS10_CENTERING_MIN && topPct <= BGS10_CENTERING_MAX;

  return {
    // Swift CalculatedGrade fields
    finalScore: cappedFinalGrade,
    primaryFlawDescription: flawExplanation,
    subGradesLabel: subGradesDisplayLabel,
    isGemMint: cappedFinalGrade >= 9.5,

    // Explicit sub-grades (10-point) for the report UI and for ML flywheel logs
    subGrades: {
      centering: centeringScore,
      surface: finalSurfaceScore,
      edges: edgeScore,
      corners: cornerScore
    },

    // Ceiling diagnostics (not in the Swift struct; added so operators can
    // see WHEN the 0.5-point rule actually fired).
    lowestIsolatedSubGrade,
    overallMathematicalAverage,
    absoluteConditionCeilingLimit,
    strictCalculatedFinalGrade,
    conditionCeilingApplied,

    centeringMetrics: {
      leftRightRatio: { left: leftRightRatio.left, right: leftRightRatio.right },
      topBottomRatio: { top: topBottomRatio.top, bottom: topBottomRatio.bottom },
      maxDeviation: centeringPhase.maxDeviation,
      lrDiff: centeringPhase.lrDiff,
      tbDiff: centeringPhase.tbDiff,
      passesPSA10,
      passesBGS10
    },

    surfacePenalties: {
      scratchCount: Number(surfaceInput.scratchCount) || 0,
      dimpleOrDentCount: Number(surfaceInput.dimpleOrDentCount) || 0,
      surfaceCreaseDetected: Boolean(surfaceInput.surfaceCreaseDetected),
      wrinkleOrCreaseSeverity: Number(surfaceInput.wrinkleOrCreaseSeverity) || 0,
      creasePenaltyApplied: surfacePhase.creasePenaltyApplied,
      creasePenalty: surfacePhase.creasePenalty
    },

    edgesWhiteningCount: Number(edgesWhiteningCount) || 0,
    absoluteMaxCornerFray,

    label: labelForFinalScore(cappedFinalGrade)
  };
}


// =============================================================================
// PART 2 — STILL-IMAGE METROLOGY (feeds Part 1)
// =============================================================================
//
// BusinessPlan.md Phase 2: "calculating contrast variances along card
// boundaries for pixel-perfect edge-to-edge centering calculations."
//
// This section produces the four input structs The Judge expects. It does
// NOT assign sub-grades. All scoring happens in evaluateMultiPhaseCondition.
// =============================================================================

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2.0
    : sorted[mid];
}

function clamp01to100(v) {
  return Math.max(0, Math.min(100, v));
}

/**
 * Locate the card rectangle by scanning column/row brightness against a
 * sampled background. Used so subsequent inward border scans run on the
 * card itself rather than on table/backdrop pixels.
 *
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @returns {{ left: number, right: number, top: number, bottom: number, width: number, height: number }}
 */
function findCardBoundingBox(pixels, width, height) {
  const sample = 6;
  const leftCols = [];
  const rightCols = [];
  const topRows = [];
  const bottomRows = [];

  const colLimit = Math.min(sample, width);
  const rowLimit = Math.min(sample, height);

  for (let x = 0; x < colLimit; x++) {
    let col = 0;
    for (let y = 0; y < height; y++) col += pixels[y * width + x];
    leftCols.push(col / height);
  }
  for (let x = width - colLimit; x < width; x++) {
    let col = 0;
    for (let y = 0; y < height; y++) col += pixels[y * width + x];
    rightCols.push(col / height);
  }
  for (let y = 0; y < rowLimit; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) row += pixels[y * width + x];
    topRows.push(row / width);
  }
  for (let y = height - rowLimit; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) row += pixels[y * width + x];
    bottomRows.push(row / width);
  }

  const bgApprox = mean([mean(leftCols), mean(rightCols), mean(topRows), mean(bottomRows)]);

  const colAvgs = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let col = 0;
    for (let y = 0; y < height; y++) col += pixels[y * width + x];
    colAvgs[x] = col / height;
  }
  const rowAvgs = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) row += pixels[y * width + x];
    rowAvgs[y] = row / width;
  }

  const threshold = 10;
  let left = 0;
  let right = width - 1;
  let top = 0;
  let bottom = height - 1;

  for (let x = 0; x < width; x++) {
    if (Math.abs(colAvgs[x] - bgApprox) > threshold) { left = x; break; }
  }
  for (let x = width - 1; x >= 0; x--) {
    if (Math.abs(colAvgs[x] - bgApprox) > threshold) { right = x; break; }
  }
  for (let y = 0; y < height; y++) {
    if (Math.abs(rowAvgs[y] - bgApprox) > threshold) { top = y; break; }
  }
  for (let y = height - 1; y >= 0; y--) {
    if (Math.abs(rowAvgs[y] - bgApprox) > threshold) { bottom = y; break; }
  }

  if (right <= left || bottom <= top) {
    left = 0; right = width - 1; top = 0; bottom = height - 1;
  }

  return {
    left, right, top, bottom,
    width: right - left + 1,
    height: bottom - top + 1,
    bgApprox
  };
}

/**
 * Inward contrast scan for a single sample line. Port of
 * `CenteringAnalyzer.scanLineForBorder`:
 *   - baseline = mean of the first 4 pixels (the cut-edge border color)
 *   - adaptive threshold from the local 60px brightness range, floored at 12
 *     and capped at 50
 *   - require 5 consecutive pixels past the threshold (sustained run)
 *   - linearly interpolate a sub-pixel crossing
 *
 * @returns {number|null} fractional pixel distance from the outer edge
 */
function scanLineForBorder(getPixel, edge, lineOffset, cardWidth, cardHeight) {
  const scanLength = (edge === 'left' || edge === 'right')
    ? Math.floor(cardWidth / 2)
    : Math.floor(cardHeight / 2);
  if (scanLength <= 12) return null;

  function pixelAt(i) {
    switch (edge) {
      case 'left': return getPixel(i, lineOffset);
      case 'right': return getPixel(cardWidth - 1 - i, lineOffset);
      case 'top': return getPixel(lineOffset, i);
      default: return getPixel(lineOffset, cardHeight - 1 - i);
    }
  }

  const profile = new Float32Array(scanLength);
  for (let i = 0; i < scanLength; i++) profile[i] = pixelAt(i);

  const baselineSampleCount = 4;
  let baselineSum = 0;
  for (let i = 0; i < baselineSampleCount; i++) baselineSum += profile[i];
  const baseline = baselineSum / baselineSampleCount;

  const localWindowSize = Math.min(scanLength, 60);
  let localMin = profile[0];
  let localMax = profile[0];
  for (let i = 1; i < localWindowSize; i++) {
    if (profile[i] < localMin) localMin = profile[i];
    if (profile[i] > localMax) localMax = profile[i];
  }
  const localRange = localMax - localMin;
  const adaptiveThreshold = Math.max(12, Math.min(50, Math.round(localRange * 0.2)));
  const sustainedRunRequired = 5;

  let i = baselineSampleCount;
  while (i < scanLength - sustainedRunRequired) {
    const signedDiff = profile[i] - baseline;
    if (Math.abs(signedDiff) > adaptiveThreshold) {
      let sustained = true;
      for (let offset = 1; offset <= sustainedRunRequired; offset++) {
        if (Math.abs(profile[i + offset] - baseline) <= adaptiveThreshold) {
          sustained = false;
          break;
        }
      }
      if (sustained) {
        const target = signedDiff > 0
          ? baseline + adaptiveThreshold
          : baseline - adaptiveThreshold;
        const previous = profile[i - 1];
        const current = profile[i];
        const stepDelta = current - previous;
        const fraction = stepDelta === 0 ? 0 : (target - previous) / stepDelta;
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        return (i - 1) + clampedFraction;
      }
    }
    i += 1;
  }
  return null;
}

/**
 * Seven-line median border width for one edge. Port of
 * `CenteringAnalyzer.findBorderWidth`. Returns null width if every sample
 * line failed — callers must NOT invent a fake 50/50 from a failed detection.
 *
 * `samples` is the raw hit list (already sorted) so a single still can show
 * whether T/B scan-lines disagree more than L/R (algorithm / keystone) vs.
 * only drifting across separate shots (camera pitch).
 *
 * @returns {{ width: number|null, samples: number[], attempted: number }}
 */
function findBorderWidth(getPixel, edge, cardWidth, cardHeight) {
  const sampleCount = 7;
  const dimension = (edge === 'left' || edge === 'right') ? cardHeight : cardWidth;
  const margin = Math.floor(dimension / 4);
  const positions = [];

  for (let sample = 0; sample < sampleCount; sample++) {
    const span = dimension - 2 * margin;
    const lineOffset = margin + Math.round(sample * span / (sampleCount - 1));
    const pos = scanLineForBorder(getPixel, edge, lineOffset, cardWidth, cardHeight);
    if (pos != null) positions.push(pos);
  }

  if (!positions.length) {
    return { width: null, samples: [], attempted: sampleCount };
  }
  positions.sort(function (a, b) { return a - b; });
  return { width: median(positions), samples: positions, attempted: sampleCount };
}

/**
 * Pixel-perfect print-border centering. Converts the four inward scans into
 * L/R and T/B percentages that sum to 100 per axis — the exact input shape
 * `evaluateMultiPhaseCondition` inherited from CenteringResult.
 *
 * When ANY edge fails to find a sustained border (borderless/full-bleed stock,
 * low-contrast lighting, foil glare), `detected` is false and the ratios are
 * null. Callers must NOT treat that as 50/50 — a failed scan is unknown, not
 * Gem-centered. `gradeBuffer` is the place that branches on `detected`.
 *
 * @returns {{ leftRightRatio: {left:number, right:number}|null, topBottomRatio: {top:number, bottom:number}|null, detected: boolean, widths: object, samples: object }}
 */
function measurePrintCentering(getPixel, cardWidth, cardHeight) {
  const leftScan = findBorderWidth(getPixel, 'left', cardWidth, cardHeight);
  const rightScan = findBorderWidth(getPixel, 'right', cardWidth, cardHeight);
  const topScan = findBorderWidth(getPixel, 'top', cardWidth, cardHeight);
  const bottomScan = findBorderWidth(getPixel, 'bottom', cardWidth, cardHeight);

  const leftW = leftScan.width;
  const rightW = rightScan.width;
  const topW = topScan.width;
  const bottomW = bottomScan.width;
  const samples = {
    left: leftScan.samples,
    right: rightScan.samples,
    top: topScan.samples,
    bottom: bottomScan.samples
  };

  const detected = leftW != null && rightW != null && topW != null && bottomW != null;

  if (!detected) {
    return {
      leftRightRatio: null,
      topBottomRatio: null,
      detected: false,
      widths: { left: leftW, right: rightW, top: topW, bottom: bottomW },
      samples: samples
    };
  }

  const totalH = leftW + rightW;
  const totalV = topW + bottomW;
  const leftPct = totalH > 0 ? (leftW / totalH) * 100 : 50;
  const rightPct = 100 - leftPct;
  const topPct = totalV > 0 ? (topW / totalV) * 100 : 50;
  const bottomPct = 100 - topPct;

  return {
    leftRightRatio: { left: leftPct, right: rightPct },
    topBottomRatio: { top: topPct, bottom: bottomPct },
    detected: true,
    widths: { left: leftW, right: rightW, top: topW, bottom: bottomW },
    samples: samples
  };
}

function round2(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return value;
  return Math.round(value * 100) / 100;
}

function stddev(arr) {
  if (!arr || arr.length < 2) return null;
  const m = mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) sumSq += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(sumSq / arr.length);
}

function meanOf(arr) {
  const vals = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] != null && typeof arr[i] === 'number' && isFinite(arr[i])) vals.push(arr[i]);
  }
  return vals.length ? mean(vals) : null;
}

/**
 * Operator-facing hint for "is this a real printed frame, or the backdrop?"
 *
 * Rules match the Star Rookie / Chipper Jones investigation:
 *   - a few pixels, uniform on all sides → likely mat / cut-edge bleed
 *   - tens of pixels, especially uneven L vs R, with the card box inset
 *     from the photo edge → likely a real printed frame
 *   - tens of pixels but the box fills the photo → inward scan is probably
 *     measuring backdrop that was included inside the bounding box
 *
 * Also reports L/R vs T/B sample-line spread on THIS still. If T/B samples
 * already disagree on one photo, residual top/bottom drift is not only
 * phone pitch between shots.
 *
 * @returns {object}
 */
function describeBorderSource(args) {
  args = args || {};
  const imageWidth = Number(args.imageWidth) || 0;
  const imageHeight = Number(args.imageHeight) || 0;
  const box = args.box || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  const widths = args.widths || { left: null, right: null, top: null, bottom: null };
  const samples = args.samples || {};
  const detected = Boolean(args.detected);

  const imageArea = Math.max(1, imageWidth * imageHeight);
  const boxArea = Math.max(0, (Number(box.width) || 0) * (Number(box.height) || 0));
  const boxFillRatio = boxArea / imageArea;

  const px = [widths.left, widths.right, widths.top, widths.bottom].filter(function (v) {
    return v != null && typeof v === 'number' && isFinite(v);
  });
  const avgWidthPx = px.length ? mean(px) : null;
  const minWidthPx = px.length ? Math.min.apply(null, px) : null;
  const maxWidthPx = px.length ? Math.max.apply(null, px) : null;
  const widthRangePx = (minWidthPx != null && maxWidthPx != null) ? maxWidthPx - minWidthPx : null;
  const uniform = widthRangePx != null && widthRangePx <= 4;
  const thin = avgWidthPx != null && avgWidthPx <= 6;
  const substantial = avgWidthPx != null && avgWidthPx >= 12;

  const leftRightSampleSpreadPx = meanOf([stddev(samples.left), stddev(samples.right)]);
  const topBottomSampleSpreadPx = meanOf([stddev(samples.top), stddev(samples.bottom)]);

  let hint;
  let summary;
  if (!detected) {
    hint = 'undetected';
    summary = 'No sustained print border on at least one edge. Treat as unknown, not 50/50.';
  } else if (thin && uniform && boxFillRatio >= 0.88) {
    hint = 'likely-backdrop';
    summary = 'Border of only a few pixels, nearly uniform, and the card box fills the photo. Likely measuring backdrop/mat (or cut-edge anti-alias), not a printed frame.';
  } else if (thin && uniform) {
    hint = 'thin-ambiguous';
    summary = 'Border of only a few pixels on all sides. Could be cut-edge anti-alias or a very thin printed line — not a typical sports-card frame.';
  } else if (substantial && boxFillRatio >= 0.90) {
    hint = 'likely-backdrop';
    summary = 'Tens of pixels of "border" but the detected card box fills the photo. The inward scan is probably picking up the backdrop mat, not a printed frame.';
  } else if (substantial) {
    hint = 'likely-printed-frame';
    summary = 'Tens of pixels of border with the card box inset from the photo edge. This pattern matches a real printed frame. Uneven left vs right strengthens that reading.';
  } else {
    hint = 'needs-review';
    summary = 'Border widths sit between "thin mat-bleed" and "clear printed frame." Compare L/R vs T/B sample spreads and reshoot with the card filling the neon frame.';
  }

  let axisSpreadNote = null;
  if (leftRightSampleSpreadPx != null && topBottomSampleSpreadPx != null) {
    if (topBottomSampleSpreadPx > leftRightSampleSpreadPx * 1.8 + 0.4) {
      axisSpreadNote = 'T/B sample lines disagree more than L/R on this single still — vertical scan-pass or keystone, not just shot-to-shot pitch.';
    } else {
      axisSpreadNote = 'On this still, T/B sample spread is similar to L/R. Cross-scan T/B drift is more likely camera pitch than a one-sided algorithm bug.';
    }
  }

  return {
    hint: hint,
    summary: summary,
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    box: {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height
    },
    boxFillRatio: round2(boxFillRatio),
    printBorderWidths: {
      left: round2(widths.left),
      right: round2(widths.right),
      top: round2(widths.top),
      bottom: round2(widths.bottom)
    },
    avgWidthPx: round2(avgWidthPx),
    minWidthPx: round2(minWidthPx),
    maxWidthPx: round2(maxWidthPx),
    widthRangePx: round2(widthRangePx),
    leftRightSampleSpreadPx: round2(leftRightSampleSpreadPx),
    topBottomSampleSpreadPx: round2(topBottomSampleSpreadPx),
    axisSpreadNote: axisSpreadNote,
    samples: {
      left: (samples.left || []).map(round2),
      right: (samples.right || []).map(round2),
      top: (samples.top || []).map(round2),
      bottom: (samples.bottom || []).map(round2)
    }
  };
}

function buildCenteringDiagnostics(width, height, box, centeringMeasurement) {
  return describeBorderSource({
    imageWidth: width,
    imageHeight: height,
    box: box,
    widths: centeringMeasurement.widths,
    samples: centeringMeasurement.samples,
    detected: centeringMeasurement.detected
  });
}

/**
 * Map a 0–255 peak-brightness reading onto the 0–5 fraying/whitening severity
 * scale The Judge consumes. Extends DefectAnalyzer.swift's 0–4 bands with a
 * 5th bucket for fully exposed paper pulp.
 *
 * @param {number} brightness 0–255
 * @returns {number} 0–5
 */
function brightnessToSeverity(brightness) {
  if (brightness >= 240) return 5;
  if (brightness >= 220) return 4;
  if (brightness >= 190) return 3;
  if (brightness >= 170) return 2;
  if (brightness >= 100) return 1;
  return 0;
}

/**
 * Peak brightness inside a rectangle of the greyscale buffer.
 *
 * @returns {number} 0–255
 */
function peakBrightnessInRect(pixels, imgWidth, x0, y0, x1, y1) {
  let peak = 0;
  const xStart = Math.max(0, x0);
  const yStart = Math.max(0, y0);
  const xEnd = Math.min(imgWidth - 1, x1);
  const yEnd = Math.min((pixels.length / imgWidth) - 1, y1);
  for (let y = yStart; y <= yEnd; y++) {
    const row = y * imgWidth;
    for (let x = xStart; x <= xEnd; x++) {
      const v = pixels[row + x];
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * PHASE 4 metrology: independent 0–5 fray reading at each corner square.
 * Sample size is ~8% of the short card side (DefectAnalyzer.swift).
 */
function measureCornerFraying(pixels, imgWidth, box) {
  const cornerSize = Math.max(20, Math.round(Math.min(box.width, box.height) * 0.08));
  const tl = brightnessToSeverity(peakBrightnessInRect(
    pixels, imgWidth, box.left, box.top, box.left + cornerSize, box.top + cornerSize
  ));
  const tr = brightnessToSeverity(peakBrightnessInRect(
    pixels, imgWidth, box.right - cornerSize, box.top, box.right, box.top + cornerSize
  ));
  const bl = brightnessToSeverity(peakBrightnessInRect(
    pixels, imgWidth, box.left, box.bottom - cornerSize, box.left + cornerSize, box.bottom
  ));
  const br = brightnessToSeverity(peakBrightnessInRect(
    pixels, imgWidth, box.right - cornerSize, box.bottom - cornerSize, box.right, box.bottom
  ));
  return {
    topLeftFrayingSeverity: tl,
    topRightFrayingSeverity: tr,
    bottomLeftFrayingSeverity: bl,
    bottomRightFrayingSeverity: br
  };
}

/**
 * PHASE 3 metrology: count distinct high-brightness clusters along a thin
 * perimeter strip. Each cluster is one "whitening site" for scoreEdgesPhase.
 * Corners are excluded so corner pulp does not double-count as edge wear.
 */
function measureEdgeWhitening(pixels, imgWidth, box) {
  const strip = Math.max(4, Math.round(Math.min(box.width, box.height) * 0.03));
  const cornerSkip = Math.max(20, Math.round(Math.min(box.width, box.height) * 0.08));
  const WHITEN_THRESHOLD = 200;
  let clusters = 0;
  let run = 0;

  function consider(v) {
    if (v >= WHITEN_THRESHOLD) {
      run += 1;
      if (run === 8) {
        clusters += 1;
        run = 0;
      }
    } else {
      run = 0;
    }
  }

  // Left + right vertical strips, skipping the corner squares.
  for (let y = box.top + cornerSkip; y <= box.bottom - cornerSkip; y++) {
    for (let x = box.left; x < box.left + strip; x++) consider(pixels[y * imgWidth + x]);
  }
  run = 0;
  for (let y = box.top + cornerSkip; y <= box.bottom - cornerSkip; y++) {
    for (let x = box.right - strip + 1; x <= box.right; x++) consider(pixels[y * imgWidth + x]);
  }
  run = 0;
  // Top + bottom horizontal strips, skipping the corner squares.
  for (let x = box.left + cornerSkip; x <= box.right - cornerSkip; x++) {
    for (let y = box.top; y < box.top + strip; y++) consider(pixels[y * imgWidth + x]);
  }
  run = 0;
  for (let x = box.left + cornerSkip; x <= box.right - cornerSkip; x++) {
    for (let y = box.bottom - strip + 1; y <= box.bottom; y++) consider(pixels[y * imgWidth + x]);
  }

  return clusters;
}

/**
 * PHASE 2 metrology: surface scratches, dimples, and crease/wrinkle faults.
 *
 * Method (BusinessPlan.md Surface Inspector, still-frame approximation of the
 * Condition Sweep): difference the mildly-preprocessed greyscale against a
 * stronger blur. High residuals are print/clearcoat scratches; compact mid-
 * size blobs are dimples; long thin components are creases.
 *
 * Scratch counting matches DefectAnalyzer.calculateHighIntensityPixelClusters:
 * six consecutive hot pixels → one fragment, then fragments/2, cap at 5.
 *
 * @returns {SurfaceDefects}
 */
function measureSurfaceDefects(pixels, blurred, imgWidth, box) {
  const SCRATCH_DIFF = 18;
  const DIMPLE_DIFF = 12;
  const inset = Math.max(8, Math.round(Math.min(box.width, box.height) * 0.08));
  const x0 = box.left + inset;
  const y0 = box.top + inset;
  const x1 = box.right - inset;
  const y1 = box.bottom - inset;
  if (x1 <= x0 || y1 <= y0) {
    return {
      scratchCount: 0,
      dimpleOrDentCount: 0,
      surfaceCreaseDetected: false,
      wrinkleOrCreaseSeverity: 0
    };
  }

  // --- Scratch fragments (row-major consecutive hot pixels) ---
  let consecutive = 0;
  let scratchFragments = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * imgWidth;
    consecutive = 0;
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(pixels[row + x] - blurred[row + x]);
      if (d > SCRATCH_DIFF) {
        consecutive += 1;
        if (consecutive === 6) {
          scratchFragments += 1;
          consecutive = 0;
        }
      } else {
        consecutive = 0;
      }
    }
  }
  const scratchCount = Math.min(5, Math.floor(scratchFragments / 2));

  // --- Connected components on a 2× downsampled residual map ---
  const regionW = x1 - x0 + 1;
  const regionH = y1 - y0 + 1;
  const step = 2;
  const gw = Math.max(1, Math.floor(regionW / step));
  const gh = Math.max(1, Math.floor(regionH / step));
  const mask = new Uint8Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    const y = y0 + gy * step;
    const row = y * imgWidth;
    for (let gx = 0; gx < gw; gx++) {
      const x = x0 + gx * step;
      const d = Math.abs(pixels[row + x] - blurred[row + x]);
      if (d > DIMPLE_DIFF) mask[gy * gw + gx] = 1;
    }
  }

  const seen = new Uint8Array(gw * gh);
  let dimpleOrDentCount = 0;
  let longestLinear = 0;
  const minDimpleArea = 6;
  const maxDimpleArea = 80;
  const regionShort = Math.min(gw, gh);

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;

    // Flood-fill this component.
    const stack = [i];
    seen[i] = 1;
    let area = 0;
    let minGX = gw;
    let maxGX = 0;
    let minGY = gh;
    let maxGY = 0;

    while (stack.length) {
      const idx = stack.pop();
      const gx = idx % gw;
      const gy = (idx - gx) / gw;
      area += 1;
      if (gx < minGX) minGX = gx;
      if (gx > maxGX) maxGX = gx;
      if (gy < minGY) minGY = gy;
      if (gy > maxGY) maxGY = gy;

      const neighbors = [idx - 1, idx + 1, idx - gw, idx + gw];
      for (let n = 0; n < 4; n++) {
        const nb = neighbors[n];
        if (nb < 0 || nb >= mask.length) continue;
        if (!mask[nb] || seen[nb]) continue;
        // Prevent wrapping across row boundaries for left/right neighbors.
        if (n < 2) {
          const nbGX = nb % gw;
          if (Math.abs(nbGX - gx) !== 1) continue;
        }
        seen[nb] = 1;
        stack.push(nb);
      }
    }

    const bboxW = maxGX - minGX + 1;
    const bboxH = maxGY - minGY + 1;
    const longSide = Math.max(bboxW, bboxH);
    const shortSide = Math.max(1, Math.min(bboxW, bboxH));
    const aspect = longSide / shortSide;

    // Long thin component → crease candidate.
    if (aspect >= 6 && longSide >= regionShort * 0.35) {
      if (longSide > longestLinear) longestLinear = longSide;
    } else if (area >= minDimpleArea && area <= maxDimpleArea && aspect < 3) {
      dimpleOrDentCount += 1;
    }
  }

  dimpleOrDentCount = Math.min(5, dimpleOrDentCount);

  let wrinkleOrCreaseSeverity = 0;
  if (longestLinear > 0) {
    const ratio = longestLinear / Math.max(1, regionShort);
    if (ratio >= 0.75) wrinkleOrCreaseSeverity = 5;
    else if (ratio >= 0.6) wrinkleOrCreaseSeverity = 4;
    else if (ratio >= 0.5) wrinkleOrCreaseSeverity = 3;
    else if (ratio >= 0.4) wrinkleOrCreaseSeverity = 2;
    else wrinkleOrCreaseSeverity = 1;
  }
  const surfaceCreaseDetected = wrinkleOrCreaseSeverity >= 2;

  return {
    scratchCount,
    dimpleOrDentCount,
    surfaceCreaseDetected,
    wrinkleOrCreaseSeverity
  };
}

/**
 * Assemble the defensive / fallback report used when `sharp` is missing or
 * when decoding throws. Sub-grades are 0 so the wallet engine will not
 * invent a Gem Mint from a failed scan.
 */
function fallbackReport(reason) {
  return {
    centering: 0,
    corners: 0,
    edges: 0,
    surface: 0,
    weighted: 0,
    label: 'Unknown',
    notes: reason,
    finalScore: 0,
    isGemMint: false,
    primaryFlawDescription: reason,
    subGradesLabel: 'CEN: 0.0 | SUR: 0.0 | EDG: 0.0 | CRN: 0.0',
    subGrades: { centering: 0, surface: 0, edges: 0, corners: 0 },
    conditionCeilingApplied: false
  };
}


// =============================================================================
// PART 3 — gradeBuffer: still-image orchestration used by server.js
// =============================================================================

/**
 * Accept an image Buffer (multer memory storage: `req.file.buffer`), run
 * anti-distortion pre-processing + quad-core metrology, then score with
 * `evaluateMultiPhaseCondition`.
 *
 * Options:
 *   maxDim    {number}  longest processed edge in pixels (default 900)
 *   debug     {boolean} attach raw metrology dumps
 *   cardType  {string}  reserved for sports-vs-TCG corner templates (Phase 3)
 *
 * Return shape (always JSON-serializable):
 *   Legacy 0–100 fields (wallet_engine.js / older UI):
 *     centering, corners, edges, surface, weighted, label, notes
 *   Judge 10-point fields (The Judge.swift):
 *     finalScore, isGemMint, primaryFlawDescription, subGradesLabel,
 *     subGrades, conditionCeilingApplied, centeringMetrics, ...
 *   When print borders cannot be resolved (full-bleed / glare / low contrast):
 *     centering and subGrades.centering are null (not 0, not 50),
 *     centeringUndetected and incomplete are true, finalScore / weighted
 *     are omitted as null so they cannot be read as a Gem Mint 10.
 *
 * @param {Buffer} buffer
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function gradeBuffer(buffer, options) {
  options = Object.assign({ maxDim: 900, debug: false, cardType: 'generic' }, options || {});

  // TEMP: dump every gradeBuffer payload to the server log (remove after LAN testing).
  function returnGrade(gradeResult) {
    if (options.captureTilt) {
      gradeResult.captureTilt = options.captureTilt;
      if (gradeResult.debug) gradeResult.debug.captureTilt = options.captureTilt;
    }
    console.log(JSON.stringify(gradeResult, null, 2));
    return gradeResult;
  }

  if (!sharp) {
    return returnGrade(fallbackReport('grading skipped: optional dependency `sharp` not installed'));
  }
  if (!buffer || !buffer.length) {
    return returnGrade(fallbackReport('grading skipped: empty image buffer'));
  }

  try {
    // ----- Module A: anti-distortion pre-processing -----
    // EXIF rotate, optional 90° portrait lock, downscale, greyscale, normalize,
    // and a 1px blur to strip smartphone computational sharpening before any
    // contrast scan (BusinessPlan.md §4 Module A).
    let pipeline = sharp(buffer, { failOnError: false }).rotate();
    const meta = await pipeline.metadata();
    const srcW = meta.width || 1;
    const srcH = meta.height || 1;
    const shouldRotate = srcW > srcH * PORTRAIT_LOCK_WIDTH_RATIO;
    if (shouldRotate) pipeline = pipeline.rotate(90);

    const postRotate = shouldRotate
      ? { width: srcH, height: srcW }
      : { width: srcW, height: srcH };
    const ratio = Math.max(postRotate.width, postRotate.height) / options.maxDim;
    if (ratio > 1) {
      pipeline = pipeline.resize({
        width: Math.round(postRotate.width / ratio),
        height: Math.round(postRotate.height / ratio)
      });
    }

    const { data, info } = await pipeline
      .greyscale()
      .normalize()
      .blur(1)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const pixels = new Uint8Array(data);

    // Stronger blur of the SAME processed raster, used as the surface residual
    // baseline. Built from the already-decoded pixels so geometry matches.
    const { data: blurredData } = await sharp(Buffer.from(pixels), {
      raw: { width, height, channels: 1 }
    }).blur(4).raw().toBuffer({ resolveWithObject: true });
    const blurred = new Uint8Array(blurredData);

    const box = findCardBoundingBox(pixels, width, height);

    // Pixel accessor in CARD-LOCAL coordinates so inward scans start at the
    // cut edge rather than at the photo's frame edge.
    const getPixel = function (cx, cy) {
      const x = box.left + cx;
      const y = box.top + cy;
      if (x < 0 || y < 0 || x >= width || y >= height) return 0;
      return pixels[y * width + x];
    };

    const centeringMeasurement = measurePrintCentering(getPixel, box.width, box.height);
    const surface = measureSurfaceDefects(pixels, blurred, width, box);
    const edgesWhiteningCount = measureEdgeWhitening(pixels, width, box);
    const corners = measureCornerFraying(pixels, width, box);

    // Failed print-border detection is UNKNOWN, not 50/50. Do not feed
    // fabricated ratios into evaluateMultiPhaseCondition — that scorer has
    // no "undetected" state and would emit a fake Gem centering sub-grade.
    if (!centeringMeasurement.detected) {
      const surfacePhase = scoreSurfacePhase(surface);
      const edgeScore = scoreEdgesPhase(edgesWhiteningCount);
      const cornerPhase = scoreCornersPhase(corners);
      const incompleteReason = 'centering undetectable — no printed border found';
      const report = {
        centering: null,
        corners: clamp01to100(Math.round(cornerPhase.score * 10)),
        edges: clamp01to100(Math.round(edgeScore * 10)),
        surface: clamp01to100(Math.round(surfacePhase.score * 10)),
        weighted: null,
        label: 'Incomplete',
        notes: incompleteReason,
        finalScore: null,
        isGemMint: false,
        primaryFlawDescription: incompleteReason,
        subGradesLabel:
          'CEN: — | SUR: ' + surfacePhase.score.toFixed(1) +
          ' | EDG: ' + edgeScore.toFixed(1) +
          ' | CRN: ' + cornerPhase.score.toFixed(1),
        subGrades: {
          centering: null,
          surface: surfacePhase.score,
          edges: edgeScore,
          corners: cornerPhase.score
        },
        centeringUndetected: true,
        incomplete: true,
        incompleteReason: incompleteReason,
        printCenteringDetected: false,
        centeringMetrics: {
          leftRightRatio: null,
          topBottomRatio: null,
          detected: false
        },
        surfacePenalties: {
          scratchCount: Number(surface.scratchCount) || 0,
          dimpleOrDentCount: Number(surface.dimpleOrDentCount) || 0,
          surfaceCreaseDetected: Boolean(surface.surfaceCreaseDetected),
          wrinkleOrCreaseSeverity: Number(surface.wrinkleOrCreaseSeverity) || 0,
          creasePenaltyApplied: surfacePhase.creasePenaltyApplied,
          creasePenalty: surfacePhase.creasePenalty
        },
        edgesWhiteningCount: Number(edgesWhiteningCount) || 0,
        absoluteMaxCornerFray: cornerPhase.absoluteMaxCornerFray,
        centeringDiagnostics: buildCenteringDiagnostics(width, height, box, centeringMeasurement)
      };
      if (options.debug) {
        report.debug = {
          width, height, box, shouldRotate,
          printBorderWidths: centeringMeasurement.widths,
          printBorderSamples: centeringMeasurement.samples,
          corners, surface, edgesWhiteningCount
        };
      }
      return returnGrade(report);
    }

    const judged = evaluateMultiPhaseCondition(
      centeringMeasurement,
      surface,
      edgesWhiteningCount,
      corners
    );

    // 0–100 projections keep wallet_engine.js and older UI tiles working.
    // They are linear maps of the 10-point sub-grades, NOT a second formula.
    const centering100 = clamp01to100(Math.round(judged.subGrades.centering * 10));
    const surface100 = clamp01to100(Math.round(judged.subGrades.surface * 10));
    const edges100 = clamp01to100(Math.round(judged.subGrades.edges * 10));
    const corners100 = clamp01to100(Math.round(judged.subGrades.corners * 10));
    const weighted100 = clamp01to100(Math.round(judged.finalScore * 10));

    const report = {
      // Legacy Phase-1 shape
      centering: centering100,
      corners: corners100,
      edges: edges100,
      surface: surface100,
      weighted: weighted100,
      label: judged.label,
      notes: judged.primaryFlawDescription,

      // The Judge 10-point dual-scale payload
      finalScore: judged.finalScore,
      isGemMint: judged.isGemMint,
      primaryFlawDescription: judged.primaryFlawDescription,
      subGradesLabel: judged.subGradesLabel,
      subGrades: judged.subGrades,
      lowestIsolatedSubGrade: judged.lowestIsolatedSubGrade,
      overallMathematicalAverage: judged.overallMathematicalAverage,
      absoluteConditionCeilingLimit: judged.absoluteConditionCeilingLimit,
      conditionCeilingApplied: judged.conditionCeilingApplied,
      centeringMetrics: judged.centeringMetrics,
      surfacePenalties: judged.surfacePenalties,
      edgesWhiteningCount: judged.edgesWhiteningCount,
      absoluteMaxCornerFray: judged.absoluteMaxCornerFray,
      printCenteringDetected: centeringMeasurement.detected,
      centeringUndetected: false,
      incomplete: false,
      centeringDiagnostics: buildCenteringDiagnostics(width, height, box, centeringMeasurement)
    };

    if (options.debug) {
      report.debug = {
        width, height, box, shouldRotate,
        printBorderWidths: centeringMeasurement.widths,
        printBorderSamples: centeringMeasurement.samples,
        corners, surface, edgesWhiteningCount
      };
    }

    return returnGrade(report);
  } catch (err) {
    return returnGrade(fallbackReport('grading engine error: ' + (err && err.message ? err.message : String(err))));
  }
}

module.exports = {
  gradeBuffer,
  evaluateMultiPhaseCondition,
  GRADE_SCALE,
  scoreCenteringPhase,
  scoreSurfacePhase,
  scoreEdgesPhase,
  scoreCornersPhase,
  roundToLabHalfStep,
  labelForFinalScore,
  measurePrintCentering,
  describeBorderSource,
  buildCenteringDiagnostics
};
