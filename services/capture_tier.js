/**
 * The tier for one measured capture. px/mm is the server's measurement.
 * The tolerance comes from the grading engine's existing function.
 * Nothing here chooses a phone or a fixed px/mm.
 */
'use strict';

const grading = require('./grading_engine');

function tierForPxPerMm(pxPerMm) {
  const px = Number(pxPerMm);
  if (!(px > 0) || !isFinite(px)) return null;
  const toleranceMm = grading.edgeScoreToleranceMm(px, false);
  const label = toleranceMm == null
    ? grading.RESOLUTION_WITHHELD_LABEL
    : ('±' + Number(toleranceMm).toFixed(1) + ' mm');
  return {
    pxPerMm: Math.round(px * 100) / 100,
    toleranceMm: toleranceMm,
    label: label
  };
}

function attachTier(item) {
  if (!item || typeof item !== 'object') return null;
  const px = item.capture && item.capture.pxPerMm;
  const tier = tierForPxPerMm(px);
  item.captureTier = tier;
  return tier;
}

module.exports = { tierForPxPerMm, attachTier };
