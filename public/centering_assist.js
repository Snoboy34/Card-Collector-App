/**
 * public/centering_assist.js
 * Geometry for a user-placed centering line. Loaded in the browser and
 * required from Node. This is not the border finder: it never invents a
 * width, and it does not read pixels.
 *
 * A line is parallel to one card edge. Its distance from that edge is the
 * border width, stored in millimetres. The card is the standard
 * 63.5 × 88.9 mm (2.5 × 3.5 in) used by measureCenteringOnWarp.
 *
 * Warp pixels match scan_debug.innerLines on the 643×900 oriented card:
 *   left  x = widthPx
 *   right x = (warpWidth - 1) - widthPx
 *   top   y = widthPx
 *   bottom y = (warpHeight - 1) - widthPx
 * and widthMm = widthPx * cardMm / warpSpan, the same ratio as
 * widthPx / (warpSpan / cardMm).
 */
'use strict';

(function (root) {
  var CARD_WIDTH_MM = 63.5;
  var CARD_HEIGHT_MM = 88.9;
  var SIDES = ['left', 'right', 'top', 'bottom'];
  /** A line past this fraction of the card would cross the middle. */
  var MAX_WIDTH_FRACTION = 0.49;

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function roundMm(value) {
    return Math.round(value * 1000) / 1000;
  }

  function axis(side) {
    if (side === 'left' || side === 'right') {
      return { spanKey: 'width', cardMm: CARD_WIDTH_MM, horizontal: true };
    }
    if (side === 'top' || side === 'bottom') {
      return { spanKey: 'height', cardMm: CARD_HEIGHT_MM, horizontal: false };
    }
    return null;
  }

  /**
   * @returns {number|null} millimetres from the card edge, or null when the
   * line is off the card. Zero is a real placement on the edge itself.
   */
  function widthMmFromLine(side, positionPx, warpWidth, warpHeight) {
    var spec = axis(side);
    if (!spec) return null;
    if (!isFiniteNumber(positionPx) || !isFiniteNumber(warpWidth) || !isFiniteNumber(warpHeight)) return null;
    if (warpWidth < 2 || warpHeight < 2) return null;
    var span = spec.horizontal ? warpWidth : warpHeight;
    var widthPx;
    if (side === 'left' || side === 'top') widthPx = positionPx;
    else if (side === 'right') widthPx = (warpWidth - 1) - positionPx;
    else widthPx = (warpHeight - 1) - positionPx;
    if (!(widthPx >= 0)) return null;
    if (widthPx > (span - 1) * MAX_WIDTH_FRACTION) return null;
    if (widthPx === 0) return 0;
    return roundMm(widthPx * spec.cardMm / span);
  }

  /** Inverse of widthMmFromLine. Null when the width is not a placement. */
  function linePxFromWidthMm(side, widthMm, warpWidth, warpHeight) {
    var spec = axis(side);
    if (!spec) return null;
    if (!isFiniteNumber(widthMm) || widthMm < 0) return null;
    if (!isFiniteNumber(warpWidth) || !isFiniteNumber(warpHeight)) return null;
    if (warpWidth < 2 || warpHeight < 2) return null;
    var span = spec.horizontal ? warpWidth : warpHeight;
    var widthPx = widthMm * span / spec.cardMm;
    if (widthPx > (span - 1) * MAX_WIDTH_FRACTION) return null;
    if (side === 'left' || side === 'top') return widthPx;
    if (side === 'right') return (warpWidth - 1) - widthPx;
    return (warpHeight - 1) - widthPx;
  }

  function engineWidthsMm(report) {
    var metrics = report && report.centeringMetrics;
    var raw = metrics && metrics.borderWidthsMm;
    var out = { left: null, right: null, top: null, bottom: null };
    SIDES.forEach(function (side) {
      var value = raw && raw[side];
      out[side] = isFiniteNumber(value) ? value : null;
    });
    return out;
  }

  function voteLowSides(report) {
    var metrics = report && report.centeringMetrics;
    var list = (metrics && metrics.borderVoteLowConfidenceEdges) || [];
    if (!Array.isArray(list)) return [];
    return SIDES.filter(function (side) { return list.indexOf(side) !== -1; });
  }

  /**
   * A side is measured only when the engine kept a finite width and did not
   * withhold that side's vote. A null width, or a vote the engine refused
   * to score, is withheld. The whole centering score can still be withheld
   * while a side remains measured — the line is shown, and moving it is a
   * disagreement, not a new engine measurement.
   */
  function sideStatus(report) {
    var widths = engineWidthsMm(report);
    var low = voteLowSides(report);
    var status = {};
    SIDES.forEach(function (side) {
      var raw = widths[side];
      var measured = isFiniteNumber(raw) && low.indexOf(side) === -1;
      status[side] = {
        engineWidthMm: isFiniteNumber(raw) ? raw : null,
        measured: measured,
        withheld: !measured
      };
    });
    return status;
  }

  function centeringScoreWithheld(report) {
    if (!report || report.cardNotFound) return false;
    if (report.centeringUndetected === true) return true;
    if (report.printCenteringDetected === false) return true;
    var sub = report.subGrades ? report.subGrades.centering : null;
    return sub == null;
  }

  /** Engine voting lines for one side, or null when the report has none. */
  function candidateLines(report, side) {
    var diag = report && report.centeringDiagnostics;
    var lines = diag && diag.sampleLines && diag.sampleLines[side];
    if (!Array.isArray(lines) || !lines.length) return null;
    return lines.map(function (line) {
      return {
        at: line && line.at != null ? line.at : null,
        pos: line && line.pos != null ? line.pos : null,
        threshold: line && line.threshold != null ? line.threshold : null,
        inGroup: Boolean(line && line.inGroup)
      };
    });
  }

  function headline(adjustedCount) {
    var n = Number(adjustedCount) || 0;
    if (n === 1) return 'Centering (you adjusted 1 side)';
    return 'Centering (you adjusted ' + n + ' sides)';
  }

  /**
   * L/R and T/B shares from millimetre widths. Null unless every side is a
   * real number and both axes have a positive total — never 50/50.
   */
  function ratiosFromWidthsMm(widths) {
    if (!widths) return null;
    var left = widths.left;
    var right = widths.right;
    var top = widths.top;
    var bottom = widths.bottom;
    if (!isFiniteNumber(left) || !isFiniteNumber(right) || !isFiniteNumber(top) || !isFiniteNumber(bottom)) {
      return null;
    }
    if (left < 0 || right < 0 || top < 0 || bottom < 0) return null;
    var lr = left + right;
    var tb = top + bottom;
    if (!(lr > 0) || !(tb > 0)) return null;
    var leftPct = (left / lr) * 100;
    var topPct = (top / tb) * 100;
    return {
      leftRightRatio: { left: leftPct, right: 100 - leftPct },
      topBottomRatio: { top: topPct, bottom: 100 - topPct }
    };
  }

  function edgeMm(side) {
    if (side === 'left' || side === 'right') return CARD_WIDTH_MM;
    if (side === 'top' || side === 'bottom') return CARD_HEIGHT_MM;
    return null;
  }

  /**
   * Plausible millimetre range for one border. Built only from the engine
   * widths on this card and the length of each edge. No per-card constants.
   *
   * Each measured width becomes a fraction of its own edge. The spread of
   * those fractions is how much this card's borders already disagree. A new
   * border may sit that same spread outside the smallest and largest
   * fraction. If the measured borders all agree, the spread is zero and the
   * unit is the fraction itself, so the band is one border-width wide.
   *
   * With no measured border, the only fact left is the edge length. The face
   * has to be at least as large as the two borders on that edge, and those
   * borders are unknown so they count as equal: one border is at most a
   * quarter of the edge.
   */
  function plausibleRangeMm(side, measuredWidthsMm) {
    var edge = edgeMm(side);
    if (!edge) return null;
    var fractions = [];
    SIDES.forEach(function (name) {
      var width = measuredWidthsMm && measuredWidthsMm[name];
      var length = edgeMm(name);
      if (!isFiniteNumber(width) || width < 0 || !length) return;
      fractions.push(width / length);
    });
    var cardCap = roundMm(edge / 4);
    if (!fractions.length) return { minMm: 0, maxMm: cardCap };
    var lo = fractions[0];
    var hi = fractions[0];
    fractions.forEach(function (fraction) {
      if (fraction < lo) lo = fraction;
      if (fraction > hi) hi = fraction;
    });
    var spread = hi - lo;
    var unit = spread > 0 ? spread : lo;
    var minMm = roundMm(Math.max(0, lo - unit) * edge);
    var maxMm = roundMm((hi + unit) * edge);
    if (maxMm > cardCap) maxMm = cardCap;
    if (maxMm < minMm) maxMm = minMm;
    return { minMm: minMm, maxMm: maxMm };
  }

  function measuredWidthsMm(report) {
    var status = sideStatus(report);
    var out = { left: null, right: null, top: null, bottom: null };
    SIDES.forEach(function (side) {
      out[side] = status[side].measured ? status[side].engineWidthMm : null;
    });
    return out;
  }

  /** User widths outside plausibleRangeMm. Engine-matched lines are not user widths. */
  function implausibleSides(report, userWidthsMm) {
    var measured = measuredWidthsMm(report);
    var hits = [];
    SIDES.forEach(function (side) {
      var placed = userWidthsMm && userWidthsMm[side];
      if (!isFiniteNumber(placed)) return;
      if (isFiniteNumber(measured[side]) && Math.abs(placed - measured[side]) < 0.0005) return;
      var range = plausibleRangeMm(side, measured);
      if (!range) return;
      if (placed < range.minMm - 0.0005 || placed > range.maxMm + 0.0005) {
        hits.push({
          side: side,
          userWidthMm: roundMm(placed),
          minMm: range.minMm,
          maxMm: range.maxMm
        });
      }
    });
    return hits;
  }

  function plausibilityWarning(hits) {
    if (!hits || !hits.length) return '';
    var parts = hits.map(function (hit) {
      var label = hit.side.charAt(0).toUpperCase() + hit.side.slice(1);
      return label + ' is ' + hit.userWidthMm + ' mm. The borders measured on this card, and the card size, put a ' +
        hit.side + ' border between ' + hit.minMm + ' mm and ' + hit.maxMm + ' mm.';
    });
    return parts.join(' ') + ' This is outside that range. Save again to keep this line.';
  }

  function warpBox(report) {
    var box = report && report.centeringDiagnostics && report.centeringDiagnostics.box;
    if (!box || !isFiniteNumber(box.width) || !isFiniteNumber(box.height)) return null;
    if (box.width < 2 || box.height < 2) return null;
    return { width: box.width, height: box.height };
  }

  var api = {
    CARD_WIDTH_MM: CARD_WIDTH_MM,
    CARD_HEIGHT_MM: CARD_HEIGHT_MM,
    SIDES: SIDES,
    isFiniteNumber: isFiniteNumber,
    roundMm: roundMm,
    widthMmFromLine: widthMmFromLine,
    linePxFromWidthMm: linePxFromWidthMm,
    engineWidthsMm: engineWidthsMm,
    sideStatus: sideStatus,
    centeringScoreWithheld: centeringScoreWithheld,
    candidateLines: candidateLines,
    headline: headline,
    ratiosFromWidthsMm: ratiosFromWidthsMm,
    plausibleRangeMm: plausibleRangeMm,
    measuredWidthsMm: measuredWidthsMm,
    implausibleSides: implausibleSides,
    plausibilityWarning: plausibilityWarning,
    warpBox: warpBox
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CenteringAssist = api;
}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
