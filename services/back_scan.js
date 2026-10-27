/**
 * services/back_scan.js
 * Back-of-card pair metadata. This does not measure or score.
 *
 * The phone's instruction is one flip: turn the card over left to right and
 * keep the same edge at the top. On an upright back photo that maps image
 * left to the front's right, and image right to the front's left. Top and
 * bottom stay. The map is stored only when a copyright line sits in the
 * bottom half of the OCR lines (the phone sends lines top to bottom). A
 * copyright line in the top half means the back was photographed upside
 * down, and the map is not applied. No copyright line, or a single line,
 * leaves the orientation unknown and the map unapplied.
 */
'use strict';

const FLIP_INSTRUCTION = 'Turn the card over left to right. Keep the same edge at the top of the frame. Leave background showing on all four sides.';

/**
 * PSA reverse centering, strict end of each published whole-grade tolerance.
 * Comparison only. This never sets the centering sub-grade.
 *
 * Source, confirmed 2026-10-01 from screenshots of each grade slide:
 * https://www.psacard.com/gradingstandards
 * Recorded in docs/test-deck-protocol.md.
 *
 *   10 = 75/25
 *    9 = 90/10
 *    8 = 90/10
 *    7 = 90/10
 *    6 = 90/10
 *    5 = 90/10
 *    4 = 90/10
 *    3 = 90/10
 *    2 = 90/10
 *
 * Half-point grades 2.5–9.5 focus on centering and do not publish a
 * separate ratio. Rows are best grade first. Shared bounds stay listed;
 * the first row the measured share meets is the best grade that share allows.
 */
const PSA_BACK_CENTERING_TABLE = [
  { grade: 10, maxShare: 75 },
  { grade: 9, maxShare: 90 },
  { grade: 8, maxShare: 90 },
  { grade: 7, maxShare: 90 },
  { grade: 6, maxShare: 90 },
  { grade: 5, maxShare: 90 },
  { grade: 4, maxShare: 90 },
  { grade: 3, maxShare: 90 },
  { grade: 2, maxShare: 90 }
];

/** Strict end of the Gem Mint 10 reverse row (75/25). */
const PSA_GEM_MINT_10_BACK_MAX_SHARE = PSA_BACK_CENTERING_TABLE[0].maxShare;
const COPYRIGHT_RE = /©|\(c\)|copyright/i;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;

/**
 * First copyright line that contains a 19xx or 20xx year.
 * @param {string[]} lines top-to-bottom
 * @returns {{ year: number|null, line: string|null, lineIndex: number|null, lineCount: number }}
 */
function parseCopyrightYear(lines) {
  const list = Array.isArray(lines) ? lines.map(function (line) { return String(line); }) : [];
  for (let i = 0; i < list.length; i++) {
    if (!COPYRIGHT_RE.test(list[i])) continue;
    const match = list[i].match(YEAR_RE);
    if (!match) continue;
    return { year: Number(match[0]), line: list[i], lineIndex: i, lineCount: list.length };
  }
  return { year: null, line: null, lineIndex: null, lineCount: list.length };
}

/**
 * @param {string[]} lines
 * @returns {{ instructedFlip: string, upsideDown: boolean|null, applied: boolean,
 *   imageToFront: { left: string, right: string, top: string, bottom: string }|null,
 *   copyrightYear: number|null, copyrightLine: string|null }}
 */
function inspectLines(lines) {
  const parsed = parseCopyrightYear(lines);
  let upsideDown = null;
  if (parsed.lineIndex != null && parsed.lineCount >= 2) {
    upsideDown = parsed.lineIndex < parsed.lineCount / 2;
  }
  const applied = upsideDown === false;
  return {
    instructedFlip: 'flip-left-right',
    upsideDown: upsideDown,
    applied: applied,
    imageToFront: applied
      ? { left: 'right', right: 'left', top: 'top', bottom: 'bottom' }
      : null,
    copyrightYear: parsed.year,
    copyrightLine: parsed.line
  };
}

/**
 * Best published PSA whole grade whose reverse tolerance covers `worstShare`.
 * Not a centering sub-grade. A share past every row is judged and allows
 * no grade in the table.
 *
 * @param {number|null} worstShare larger border share, 0–100
 * @returns {{ judged: boolean, grade: number|null, maxShare: number|null, worstShare: number|null }}
 */
function bestPsaBackGrade(worstShare) {
  if (typeof worstShare !== 'number' || !isFinite(worstShare)) {
    return { judged: false, grade: null, maxShare: null, worstShare: null };
  }
  for (let i = 0; i < PSA_BACK_CENTERING_TABLE.length; i++) {
    const row = PSA_BACK_CENTERING_TABLE[i];
    if (worstShare <= row.maxShare + 1e-9) {
      return { judged: true, grade: row.grade, maxShare: row.maxShare, worstShare: worstShare };
    }
  }
  return { judged: true, grade: null, maxShare: null, worstShare: worstShare };
}

/**
 * @param {number|null} worstShare larger border share, 0–100
 * @returns {{ judged: boolean, within: boolean|null, maxShare: number, worstShare: number|null }}
 */
function psaGemMint10Back(worstShare) {
  if (typeof worstShare !== 'number' || !isFinite(worstShare)) {
    return { judged: false, within: null, maxShare: PSA_GEM_MINT_10_BACK_MAX_SHARE, worstShare: null };
  }
  return {
    judged: true,
    within: worstShare <= PSA_GEM_MINT_10_BACK_MAX_SHARE + 1e-9,
    maxShare: PSA_GEM_MINT_10_BACK_MAX_SHARE,
    worstShare: worstShare
  };
}

/**
 * Drop the front-table centering score from a back report. Border
 * measurements already on the report stay. A missing or front report is
 * not passed here.
 * @param {object} report
 */
function unscoreBack(report) {
  if (!report) return report;
  report.side = 'back';
  if (report.cardNotFound) return report;
  if (report.subGrades) report.subGrades.centering = null;
  report.centering = null;
  const sub = report.subGrades || {};
  function fmt(v) { return v == null ? '—' : Number(v).toFixed(1); }
  report.subGradesLabel =
    'CEN: — | SUR: ' + fmt(sub.surface) +
    ' | EDG: ' + fmt(sub.edges) +
    ' | CRN: ' + fmt(sub.corners);
  report.finalScore = null;
  report.weighted = null;
  report.isGemMint = false;
  report.incomplete = true;
  const note = 'back measured, centering not scored';
  if (!report.incompleteReason || report.incompleteReason.indexOf(note) === -1) {
    report.incompleteReason = report.incompleteReason ? (report.incompleteReason + '; ' + note) : note;
  }
  report.notes = report.incompleteReason;
  report.primaryFlawDescription = report.incompleteReason;
  return report;
}

module.exports = {
  FLIP_INSTRUCTION,
  PSA_BACK_CENTERING_TABLE,
  PSA_GEM_MINT_10_BACK_MAX_SHARE,
  parseCopyrightYear,
  inspectLines,
  bestPsaBackGrade,
  psaGemMint10Back,
  unscoreBack
};
