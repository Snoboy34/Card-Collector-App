/**
 * services/centering_assist.js
 * Stores a user-placed centering line beside the engine's measurement.
 *
 * The border finder is not involved. Engine widths, ratios, and the engine
 * centering sub-grade are copied through untouched. A user line is either:
 *   assisted      — the engine withheld that side
 *   disagreement  — the engine measured it, and the user placed a different line
 * Both are labelled source "assisted" on the grade that uses the user's line.
 * Nothing here is written back into subGrades.centering or borderWidthsMm.
 *
 * Examples live in data/centering_examples.jsonl on this machine. consent
 * defaults to false. examplesClearedToLeave() is empty until accounts, a
 * recorded consent, and a privacy policy exist — and it never includes a
 * consent=false row even after that.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const geometry = require('../public/centering_assist');
const grading = require('./grading_engine');

const EXAMPLES_FILE = 'centering_examples.jsonl';
const SETTINGS_FILE = 'assist_settings.json';

function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function createStore(dataDir) {
  const root = dataDir || path.join(__dirname, '..', 'data');
  const examplesPath = path.join(root, EXAMPLES_FILE);
  const settingsPath = path.join(root, SETTINGS_FILE);

  function readExamples() {
    if (!fs.existsSync(examplesPath)) return [];
    const text = fs.readFileSync(examplesPath, 'utf8');
    const rows = [];
    text.split('\n').forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { rows.push(JSON.parse(trimmed)); } catch (e) { /* skip a torn line */ }
    });
    return rows;
  }

  function append(examples) {
    if (!examples || !examples.length) return [];
    fs.mkdirSync(root, { recursive: true });
    const lines = examples.map(function (row) { return JSON.stringify(row); }).join('\n') + '\n';
    fs.appendFileSync(examplesPath, lines);
    return examples;
  }

  function consentPreference() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return parsed && parsed.helpImprove === true;
    } catch (e) {
      return false;
    }
  }

  function setConsentPreference(helpImprove) {
    fs.mkdirSync(root, { recursive: true });
    const on = helpImprove === true;
    fs.writeFileSync(settingsPath, JSON.stringify({
      helpImprove: on,
      updatedAt: new Date().toISOString()
    }, null, 2));
    return on;
  }

  return {
    root: root,
    examplesPath: examplesPath,
    settingsPath: settingsPath,
    readExamples: readExamples,
    append: append,
    consentPreference: consentPreference,
    setConsentPreference: setConsentPreference
  };
}

/**
 * Nothing is cleared to leave this machine. consent=false rows are also
 * dropped by stripForExport so a later caller cannot flip the gate and
 * accidentally include them.
 */
function examplesClearedToLeave() {
  return [];
}

function stripForExport(examples) {
  return (examples || []).filter(function (row) { return row && row.consent === true; });
}

/**
 * Owner scan-repo copy. Removes only what the user entered: the dragged
 * line's millimetres, a disagreement value, and any centeringExamples hung
 * on the report. Engine border millimetres, sample lines, per-side engine
 * widths, and scores are left as they were.
 *
 * A side the user moved also wrote that millimetre into the assisted
 * border map and into the assisted ratios. Those copies of the user's
 * number are cleared. The engine width, when the engine measured one, is
 * what stays in that side of the map.
 */
function redactReportForEgress(report) {
  if (!report || typeof report !== 'object') return report;
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.centeringExamples;
  const assist = copy.centeringAssist;
  if (!assist) return copy;
  const widths = assist.borderWidthsMm;
  let stripped = false;
  if (assist.sides && typeof assist.sides === 'object') {
    Object.keys(assist.sides).forEach(function (side) {
      const row = assist.sides[side];
      if (!row || typeof row !== 'object') return;
      if (!geometry.isFiniteNumber(row.userWidthMm)) return;
      stripped = true;
      if (widths && typeof widths === 'object' && widths[side] === row.userWidthMm) {
        widths[side] = geometry.isFiniteNumber(row.engineWidthMm) ? row.engineWidthMm : null;
      }
      row.userWidthMm = null;
    });
  }
  if (stripped) {
    assist.leftRightRatio = null;
    assist.topBottomRatio = null;
    assist.centering = null;
    assist.centeringLabel = null;
  }
  return copy;
}

/**
 * Future hosted / tester copy. Strips the assisted measurement entirely,
 * including the engine widths that were repeated on the assist block.
 * push_scan_data.sh does not call this. The owner's private scan repo
 * uses redactReportForEgress so the engine's border millimetres survive.
 */
function redactReportForHostedEgress(report) {
  if (!report || typeof report !== 'object') return report;
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.centeringExamples;
  if (!copy.centeringAssist) return copy;
  const assist = copy.centeringAssist;
  assist.redacted = true;
  assist.borderWidthsMm = null;
  assist.engineBorderWidthsMm = null;
  assist.leftRightRatio = null;
  assist.topBottomRatio = null;
  assist.centering = null;
  assist.centeringLabel = null;
  if (assist.sides) {
    Object.keys(assist.sides).forEach(function (side) {
      const row = assist.sides[side];
      if (!row) return;
      row.userWidthMm = null;
      row.engineWidthMm = null;
    });
  }
  return copy;
}

/** Database object written to the-judge-scans. Engine reports stay; user lines do not. */
function redactDatabaseForScanRepo(db) {
  const copy = JSON.parse(JSON.stringify(db && typeof db === 'object' ? db : {}));
  (copy.inventory || []).forEach(function (item) {
    if (item && item.gradingReport) {
      item.gradingReport = redactReportForEgress(item.gradingReport);
    }
  });
  delete copy.centeringExamples;
  return copy;
}

function sameMm(a, b) {
  return geometry.isFiniteNumber(a) && geometry.isFiniteNumber(b) && Math.abs(a - b) < 0.0005;
}

/**
 * Build the assisted block and the example rows from user line positions
 * on the warped card. `lines` is { left: { positionPx, warpWidth, warpHeight } }.
 * A side omitted, or sent as null, was not placed.
 */
function buildFromLines(report, lines, meta) {
  meta = meta || {};
  if (!report || report.cardNotFound) {
    return { ok: false, error: 'no graded card to adjust' };
  }
  const box = geometry.warpBox(report);
  if (!box) return { ok: false, error: 'this scan has no warped card to adjust' };

  const userMm = { left: null, right: null, top: null, bottom: null };
  const incoming = lines && typeof lines === 'object' ? lines : null;
  if (!incoming) return { ok: false, error: 'no lines' };

  const sides = Object.keys(incoming);
  for (let i = 0; i < sides.length; i++) {
    const side = sides[i];
    if (geometry.SIDES.indexOf(side) === -1) {
      return { ok: false, error: 'unknown side' };
    }
    const line = incoming[side];
    if (line == null) continue;
    const warpWidth = Number(line.warpWidth);
    const warpHeight = Number(line.warpHeight);
    const positionPx = Number(line.positionPx);
    if (Math.abs(warpWidth - box.width) > 1 || Math.abs(warpHeight - box.height) > 1) {
      return { ok: false, error: 'line is not on this scan\'s warped card' };
    }
    const mm = geometry.widthMmFromLine(side, positionPx, box.width, box.height);
    if (mm == null) return { ok: false, error: side + ' line is not on the card' };
    userMm[side] = mm;
  }

  return buildFromMillimetres(report, userMm, meta);
}

function buildFromMillimetres(report, userMm, meta) {
  meta = meta || {};
  const status = geometry.sideStatus(report);
  const engine = geometry.engineWidthsMm(report);
  const combined = { left: null, right: null, top: null, bottom: null };
  const sideRecords = {};
  const examples = [];
  let adjusted = 0;
  const createdAt = meta.createdAt || new Date().toISOString();
  const consent = meta.consent === true;
  const flagged = geometry.implausibleSides(report, userMm);
  if (flagged.length && meta.confirmImplausible !== true) {
    return {
      ok: false,
      error: geometry.plausibilityWarning(flagged),
      implausible: flagged
    };
  }
  const flaggedBySide = {};
  flagged.forEach(function (hit) { flaggedBySide[hit.side] = hit; });

  geometry.SIDES.forEach(function (side) {
    const placed = userMm && geometry.isFiniteNumber(userMm[side]) ? geometry.roundMm(userMm[side]) : null;
    const rawEngine = engine[side];
    const measured = status[side].measured;

    if (placed == null) {
      combined[side] = measured ? rawEngine : null;
      sideRecords[side] = {
        source: measured ? 'engine' : 'withheld',
        engineWidthMm: rawEngine,
        userWidthMm: null
      };
      return;
    }

    if (measured && sameMm(placed, rawEngine)) {
      combined[side] = rawEngine;
      sideRecords[side] = {
        source: 'engine',
        engineWidthMm: rawEngine,
        userWidthMm: null
      };
      return;
    }

    const previous = report.centeringAssist && report.centeringAssist.sides && report.centeringAssist.sides[side];
    const previousUser = previous && geometry.isFiniteNumber(previous.userWidthMm) ? previous.userWidthMm : null;
    if (previousUser != null && sameMm(placed, previousUser)) {
      adjusted += 1;
      combined[side] = placed;
      sideRecords[side] = {
        source: 'user',
        kind: previous.kind || (measured ? 'disagreement' : 'assisted'),
        engineWidthMm: rawEngine,
        userWidthMm: placed
      };
      return;
    }

    adjusted += 1;
    const kind = measured ? 'disagreement' : 'assisted';
    combined[side] = placed;
    sideRecords[side] = {
      source: 'user',
      kind: kind,
      engineWidthMm: rawEngine,
      userWidthMm: placed
    };
    const range = geometry.plausibleRangeMm(side, geometry.measuredWidthsMm(report));
    const hit = flaggedBySide[side];
    examples.push({
      id: newId(),
      kind: kind,
      scanId: meta.scanId || (report && report.scanId) || null,
      side: side,
      engineCandidateLines: geometry.candidateLines(report, side),
      engineWidthMm: rawEngine,
      userWidthMm: placed,
      engineVersion: meta.engineVersion || (report && report.engineVersion) || null,
      engineCommit: meta.engineCommit || null,
      consent: consent,
      warningShown: Boolean(hit),
      plausibleMinMm: hit ? hit.minMm : (range && range.minMm),
      plausibleMaxMm: hit ? hit.maxMm : (range && range.maxMm),
      createdAt: createdAt
    });
  });

  if (adjusted === 0) {
    return { ok: false, error: 'no side was adjusted' };
  }

  const assist = {
    source: 'assisted',
    gradeSource: 'assisted',
    adjustedCount: adjusted,
    headline: geometry.headline(adjusted),
    sides: sideRecords,
    borderWidthsMm: combined,
    engineBorderWidthsMm: {
      left: engine.left,
      right: engine.right,
      top: engine.top,
      bottom: engine.bottom
    },
    engineCentering: report && report.subGrades ? report.subGrades.centering : null,
    engineFinalScore: geometry.isFiniteNumber(report && report.finalScore) ? report.finalScore : null,
    leftRightRatio: null,
    topBottomRatio: null,
    centering: null,
    centeringLabel: null
  };

  const ratios = geometry.ratiosFromWidthsMm(combined);
  if (ratios) {
    const phase = grading.scoreCenteringPhase(ratios.leftRightRatio, ratios.topBottomRatio);
    assist.leftRightRatio = ratios.leftRightRatio;
    assist.topBottomRatio = ratios.topBottomRatio;
    assist.centering = phase.score;
    assist.centeringLabel = phase.score.toFixed(1) + ' assisted';
  }

  return { ok: true, assist: assist, examples: examples };
}

/** New item. Engine centering fields on the report stay as they were. */
function attachAssist(item, assist) {
  const report = Object.assign({}, item.gradingReport, { centeringAssist: assist });
  return Object.assign({}, item, { gradingReport: report });
}

module.exports = {
  EXAMPLES_FILE: EXAMPLES_FILE,
  SETTINGS_FILE: SETTINGS_FILE,
  createStore: createStore,
  examplesClearedToLeave: examplesClearedToLeave,
  stripForExport: stripForExport,
  redactReportForEgress: redactReportForEgress,
  redactReportForHostedEgress: redactReportForHostedEgress,
  redactDatabaseForScanRepo: redactDatabaseForScanRepo,
  buildFromLines: buildFromLines,
  buildFromMillimetres: buildFromMillimetres,
  attachAssist: attachAssist
};
