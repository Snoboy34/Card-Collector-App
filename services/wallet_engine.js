/**
 * services/wallet_engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Proprietary Wallet & Asset Pricing Engine
 *
 * Responsibilities:
 *   1. Accept a card's numeric grade (from grading_engine.js) and an optional
 *      raw market price for a PSA 10 copy of that card.
 *   2. Apply condition-based pricing modifiers to project the card's current
 *      market value at each grade tier.
 *   3. Return a structured pricing report for display in the Wallet dashboard.
 *
 * Modular contract (BusinessPlan §3 Module C, §4 Monetisation):
 *   • Input  : { numericGrade, cardName, rawPsa10Price? }
 *   • Output : { estimatedValue, gradeLabel, modifier, allTiers, currency,
 *               disclaimer }
 *   Swap the PRICE_MODIFIERS table to a live pricing API call in Phase 3
 *   without changing any other file.
 *
 * Pricing modifier rationale:
 *   Derived from observed PSA population-report auction comps (eBay sold
 *   listings, PWCC, Goldin).  Grade 10 = reference (1.0×).  Lower grades
 *   fall steeply because the collector market is strongly top-heavy — a PSA 9
 *   of many vintage cards trades at 30–60 % of a PSA 10, and PSA 7 and below
 *   can trade at 5–15 %.  Modifiers are intentionally conservative to avoid
 *   over-valuing inventory.
 *
 * Guard clauses:
 *   • Missing grade        → throws TypeError
 *   • Out-of-range grade   → throws RangeError
 *   • Negative price       → throws RangeError
 *   • Zero / absent price  → returns relative modifiers with no dollar value
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── Pricing Modifier Table ────────────────────────────────────────────────
//
// modifier: fraction of the PSA 10 reference price for that grade tier.
// valueRange: [low, high] multipliers for the expected auction spread.
//
// Grade 10 is defined as 1.0× (the reference ceiling).
// Grades below 6 are included for completeness (raw cards, damaged slabs).
//
const PRICE_MODIFIERS = new Map([
  // numericGrade → { label, modifier, valueRange: [low, high] }
  [ 10, { label: 'Gem Mint (PSA 10)',        modifier: 1.000, valueRange: [0.90, 1.20] } ],
  [  9, { label: 'Mint (PSA 9)',             modifier: 0.450, valueRange: [0.35, 0.60] } ],
  [  8, { label: 'Near Mint-Mint (PSA 8)',   modifier: 0.220, valueRange: [0.16, 0.30] } ],
  [  7, { label: 'Near Mint (PSA 7)',        modifier: 0.120, valueRange: [0.08, 0.18] } ],
  [  6, { label: 'Excellent-Mint (PSA 6)',   modifier: 0.070, valueRange: [0.04, 0.10] } ],
  [  5, { label: 'Excellent (PSA 5)',        modifier: 0.040, valueRange: [0.02, 0.07] } ],
  [  4, { label: 'Very Good-Excellent (PSA 4)', modifier: 0.025, valueRange: [0.01, 0.04] } ],
  [  3, { label: 'Very Good (PSA 3)',        modifier: 0.015, valueRange: [0.008, 0.025] } ],
  [  2, { label: 'Good (PSA 2)',             modifier: 0.010, valueRange: [0.005, 0.015] } ],
  [  1, { label: 'Poor (PSA 1)',             modifier: 0.005, valueRange: [0.002, 0.010] } ],
]);

// Valid grade range accepted by this engine
const MIN_GRADE = 1;
const MAX_GRADE = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * formatCurrency(amount, currency) → string
 * Formats a number to a two-decimal currency string.
 * Avoids the Intl API for maximum compatibility with older runtimes.
 */
function formatCurrency(amount, currency) {
  const symbol = currency === 'USD' ? '$' : currency + ' ';
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * roundTo(value, decimals) → number
 * Rounds a float to a given number of decimal places without floating-point drift.
 */
function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * pricingReport(options) → PricingReport
 *
 * Synchronous — no I/O required.  Returns immediately.
 *
 * @param {Object}  options
 * @param {number}  options.numericGrade   Numeric grade 1–10 from grading_engine.js
 * @param {string}  [options.cardName]     Card identifier for display (optional)
 * @param {number}  [options.rawPsa10Price] Known or estimated PSA 10 value in USD (optional)
 * @param {string}  [options.currency]     Output currency symbol (default: 'USD')
 *
 * @returns {PricingReport}
 *
 * @throws {TypeError}   If numericGrade is absent or not a number
 * @throws {RangeError}  If numericGrade is outside [1, 10]
 * @throws {RangeError}  If rawPsa10Price is a negative number
 */
function pricingReport({
  numericGrade,
  cardName      = 'Unnamed Card',
  rawPsa10Price = null,
  currency      = 'USD',
} = {}) {

  // ── Guard clauses ────────────────────────────────────────────────────
  if (numericGrade === undefined || numericGrade === null) {
    throw new TypeError('pricingReport: numericGrade is required');
  }
  if (typeof numericGrade !== 'number' || !isFinite(numericGrade)) {
    throw new TypeError(`pricingReport: numericGrade must be a finite number, got ${typeof numericGrade}`);
  }
  const grade = Math.round(numericGrade); // tolerate fractional grades from future sub-grade weighting
  if (grade < MIN_GRADE || grade > MAX_GRADE) {
    throw new RangeError(`pricingReport: numericGrade must be between ${MIN_GRADE} and ${MAX_GRADE}, got ${grade}`);
  }
  if (rawPsa10Price !== null && rawPsa10Price !== undefined) {
    if (typeof rawPsa10Price !== 'number' || !isFinite(rawPsa10Price)) {
      throw new TypeError('pricingReport: rawPsa10Price must be a finite number');
    }
    if (rawPsa10Price < 0) {
      throw new RangeError('pricingReport: rawPsa10Price cannot be negative');
    }
  }

  // ── Lookup modifier for this grade ───────────────────────────────────
  const entry = PRICE_MODIFIERS.get(grade);
  if (!entry) {
    // Should be unreachable given the range guard above, but be explicit
    throw new RangeError(`pricingReport: no modifier found for grade ${grade}`);
  }

  const { label: gradeLabel, modifier, valueRange } = entry;
  const hasPriceReference = rawPsa10Price !== null && rawPsa10Price > 0;

  // ── Compute estimated value ───────────────────────────────────────────
  let estimatedValue     = null;
  let estimatedLow       = null;
  let estimatedHigh      = null;
  let estimatedValueStr  = 'N/A — provide a PSA 10 reference price';
  let estimatedRangeStr  = null;

  if (hasPriceReference) {
    estimatedValue    = roundTo(rawPsa10Price * modifier,          2);
    estimatedLow      = roundTo(rawPsa10Price * valueRange[0],     2);
    estimatedHigh     = roundTo(rawPsa10Price * valueRange[1],     2);
    estimatedValueStr = formatCurrency(estimatedValue, currency);
    estimatedRangeStr = `${formatCurrency(estimatedLow, currency)} – ${formatCurrency(estimatedHigh, currency)}`;
  }

  // ── Build all-tier comparison table ──────────────────────────────────
  // Useful for the Wallet dashboard "what would this card be worth at each grade?"
  const allTiers = [];
  for (const [tierGrade, tierEntry] of PRICE_MODIFIERS) {
    const tierValue = hasPriceReference
      ? roundTo(rawPsa10Price * tierEntry.modifier, 2)
      : null;
    allTiers.push({
      numericGrade: tierGrade,
      label:        tierEntry.label,
      modifier:     tierEntry.modifier,
      modifierPct:  `${Math.round(tierEntry.modifier * 100)}%`,
      estimatedValue:    tierValue,
      estimatedValueStr: tierValue !== null ? formatCurrency(tierValue, currency) : '—',
      isCurrentGrade:    tierGrade === grade,
    });
  }
  // Sort descending so PSA 10 is always first in the UI
  allTiers.sort((a, b) => b.numericGrade - a.numericGrade);

  // ── Return structured pricing report ─────────────────────────────────
  return {
    cardName,
    numericGrade:      grade,
    gradeLabel,
    modifier,
    modifierPct:       `${Math.round(modifier * 100)}%`,
    estimatedValue,
    estimatedValueStr,
    estimatedLow,
    estimatedHigh,
    estimatedRangeStr,
    psa10Reference:    hasPriceReference ? rawPsa10Price : null,
    psa10ReferenceStr: hasPriceReference ? formatCurrency(rawPsa10Price, currency) : 'Not provided',
    currency,
    allTiers,
    disclaimer: [
      'Estimates are based on historical PSA auction comps and should not be',
      'treated as financial advice.  Actual sale prices vary by card, print run,',
      'population count, and current market conditions.',
      'Phase 3 will integrate live pricing API data.'
    ].join(' '),
    engineVersion: '1.0.0',
  };
}

/**
 * getModifierForGrade(numericGrade) → number
 *
 * Convenience export for other modules that only need the raw multiplier
 * (e.g., a batch inventory valuation loop) without the full pricing report.
 *
 * @param {number} numericGrade  1–10
 * @returns {number}             Pricing modifier fraction (0–1)
 */
function getModifierForGrade(numericGrade) {
  const grade = Math.round(numericGrade);
  if (grade < MIN_GRADE || grade > MAX_GRADE) return 0;
  const entry = PRICE_MODIFIERS.get(grade);
  return entry ? entry.modifier : 0;
}

/**
 * getAllModifiers() → Array<{numericGrade, label, modifier, modifierPct}>
 *
 * Returns the full modifier table, useful for rendering a reference chart
 * in the Premium tier dashboard.
 */
function getAllModifiers() {
  return Array.from(PRICE_MODIFIERS.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([grade, entry]) => ({
      numericGrade: grade,
      label:        entry.label,
      modifier:     entry.modifier,
      modifierPct:  `${Math.round(entry.modifier * 100)}%`,
    }));
}

module.exports = { pricingReport, getModifierForGrade, getAllModifiers };
