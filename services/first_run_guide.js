/**
 * Words for the first capture. A number appears only when this scan already
 * has a measured px/mm and the tier that measurement produced.
 */
'use strict';

function guideSentences(tier) {
  const lines = [
    'One card, flat, on the wide camera. Hold the phone level.',
    'Front, then back.',
    'Fill the neon frame and leave background showing on all four sides.',
    'The number is a prediction, not a company grade.',
    'A moved line is your estimate and does not change the prediction.',
    'Type the card after the scan. The card stays Unidentified until you do.',
    'A withheld border means that edge was not published.'
  ];
  if (!tier || !(Number(tier.pxPerMm) > 0) || !isFinite(Number(tier.pxPerMm))) {
    lines.push('After a scan, this screen shows the px/mm that scan measured and the tier that goes with it.');
    return lines;
  }
  const px = Number(tier.pxPerMm).toFixed(2);
  const label = tier.label ? String(tier.label) : 'withheld, resolution';
  lines.push('This scan measured ' + px + ' px/mm. The tier for this scan is ' + label + '.');
  return lines;
}

function guideText(tier) {
  return guideSentences(tier).join(' ');
}

module.exports = { guideSentences, guideText };
