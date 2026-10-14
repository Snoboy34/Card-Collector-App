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
const backScan = require('./back_scan');

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

/** "front" or "back" only. Anything else, including a missing side, is unknown. */
function knownFace(value) {
  if (value === 'front' || value === 'back') return value;
  return null;
}

/**
 * The capture's side, then the report's side. A missing side is null.
 * It is not treated as the front.
 */
function assistedSide(report, meta) {
  const fromMeta = knownFace(meta && meta.side);
  if (fromMeta) return fromMeta;
  return knownFace(report && report.side);
}

function assistScanId(item) {
  const report = item && item.gradingReport;
  const id = (item && (item.scanId || item.id)) || (report && report.scanId);
  return id ? String(id) : 'unknown';
}

function labelText(value) {
  if (value == null || value === '') return 'null';
  return String(value);
}

/**
 * Rewrite a stored assisted label from the scan side and the placed widths.
 * Engine fields on the report are not touched. Returns null when nothing
 * changed, otherwise the scan id and the old and new labels.
 */
function rescoreStoredAssist(item) {
  const report = item && item.gradingReport;
  const assist = report && report.centeringAssist;
  if (!assist || !(assist.adjustedCount > 0)) return null;
  const ratios = geometry.ratiosFromWidthsMm(assist.borderWidthsMm);
  if (!ratios) return null;
  const side = assistedSide(report, { side: item.side });
  const scored = scoreAssistedCentering(side, ratios);
  const oldLabel = assist.centeringLabel;
  if (assist.side === side && assist.centering === scored.score && oldLabel === scored.label) {
    return null;
  }
  assist.side = side;
  assist.centering = scored.score;
  assist.centeringLabel = scored.label;
  return {
    scanId: assistScanId(item),
    oldLabel: labelText(oldLabel),
    newLabel: labelText(scored.label)
  };
}

function rescoreDatabase(db, emit) {
  const log = typeof emit === 'function' ? emit : console.log;
  let changed = 0;
  ((db && db.inventory) || []).forEach(function (item) {
    const row = rescoreStoredAssist(item);
    if (!row) return;
    changed += 1;
    log('[centering-assist] rescore scanId=' + row.scanId + ' old=' + row.oldLabel + ' new=' + row.newLabel);
  });
  return changed;
}

/**
 * Assisted centering from the placed widths. Fronts use the engine's front
 * table (scoreCenteringPhase). Backs use the published back table in
 * back_scan.js: 10 = 75/25, 9 = 90/10. A back share past 90/10 matches no
 * row, so the score and the label stay null. This never writes
 * subGrades.centering.
 */
function scoreAssistedCentering(side, ratios) {
  if (side !== 'front' && side !== 'back') return { score: null, label: null };
  if (side === 'back') {
    const lr = ratios.leftRightRatio;
    const tb = ratios.topBottomRatio;
    const worst = 50 + Math.max(Math.abs(lr.left - lr.right), Math.abs(tb.top - tb.bottom)) / 2;
    const judged = backScan.bestPsaBackGrade(worst);
    if (!judged.judged || judged.grade == null) return { score: null, label: null };
    return { score: judged.grade, label: Number(judged.grade).toFixed(1) + ' assisted' };
  }
  const phase = grading.scoreCenteringPhase(ratios.leftRightRatio, ratios.topBottomRatio);
  return { score: phase.score, label: phase.score.toFixed(1) + ' assisted' };
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

  const side = assistedSide(report, meta);
  assist.side = side;
  const ratios = geometry.ratiosFromWidthsMm(combined);
  if (ratios) {
    const scored = scoreAssistedCentering(side, ratios);
    assist.leftRightRatio = ratios.leftRightRatio;
    assist.topBottomRatio = ratios.topBottomRatio;
    assist.centering = scored.score;
    assist.centeringLabel = scored.label;
  }

  return { ok: true, assist: assist, examples: examples };
}

/** New item. Engine centering fields on the report stay as they were. */
function attachAssist(item, assist) {
  const report = Object.assign({}, item.gradingReport, { centeringAssist: assist });
  return Object.assign({}, item, { gradingReport: report });
}

const BACKUP_366_NAME = 'database.backup-2026-10-13.json';

function sameJson(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch (err) { return a === b; }
}

/** Exact scan id, or the single backup row whose id is a prefix of this one. */
function backupItemFor(inventory, liveId) {
  const want = String(liveId || '').toUpperCase();
  const items = inventory || [];
  let prefix = null;
  let prefixCount = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const id = String(item.scanId || item.id || '');
    const upper = id.toUpperCase();
    if (!upper || upper.indexOf('366A0E19') !== 0) continue;
    if (upper === want) return { item: item };
    if (want.indexOf(upper) === 0 || upper.indexOf(want) === 0) {
      prefix = item;
      prefixCount += 1;
    }
  }
  if (prefixCount === 1) return { item: prefix };
  if (prefixCount > 1) return { ambiguous: true };
  return { item: null };
}

/**
 * Copy capture fields from the pre-resave backup. Deck id and side are not
 * copied; the caller sets those. The live centering assist stays, so the
 * adjustment made after the backup is kept.
 */
function restoreOriginalFields(live, backupItem) {
  const restored = [];
  const assist = live.gradingReport && live.gradingReport.centeringAssist;
  Object.keys(backupItem).forEach(function (key) {
    if (key === 'deckId' || key === 'side' || key === 'gradingReport') return;
    if (sameJson(live[key], backupItem[key])) return;
    live[key] = backupItem[key];
    restored.push(key);
  });
  if (backupItem.gradingReport && typeof backupItem.gradingReport === 'object') {
    const report = Object.assign({}, backupItem.gradingReport);
    if (assist) report.centeringAssist = assist;
    if (!sameJson(live.gradingReport, report)) {
      live.gradingReport = report;
      restored.push('gradingReport');
    }
  }
  return restored;
}

/**
 * One-time repair for scan 366A0E19. Deck TD-06 and side back are the owner's
 * instruction. createdAt and every other original field come from
 * data/database.backup-2026-10-13.json. A missing backup, or a backup that
 * does not contain the scan, is logged and createdAt is left as it is.
 * No capture time is invented. A second pass that finds the backup fields
 * already restored logs nothing.
 */
function repairRecord366A0E19(db, emit, backup) {
  const log = typeof emit === 'function' ? emit : console.log;
  const source = backup || { missing: true };
  const backupMissing = source.missing === true || source.unreadable === true;
  let changed = 0;
  let saw = false;
  ((db && db.inventory) || []).forEach(function (item) {
    if (!item) return;
    const id = String(item.scanId || item.id || '');
    if (id.toUpperCase().indexOf('366A0E19') !== 0) return;
    saw = true;
    const beforeDeck = item.deckId ? String(item.deckId) : 'null';
    const beforeSide = knownFace(item.side) || knownFace(item.gradingReport && item.gradingReport.side) || 'null';
    const beforeTime = item.createdAt ? String(item.createdAt) : 'null';
    const match = backupMissing ? { item: null } : backupItemFor(source.inventory, id);
    let restored = [];
    let timeNote = 'createdAt ' + beforeTime + ' left unchanged';
    if (backupMissing) {
      timeNote = 'backup missing ' + (source.path || BACKUP_366_NAME) +
        (source.error ? ' ' + source.error : '') +
        ' createdAt ' + beforeTime + ' left unchanged';
    } else if (match.ambiguous) {
      timeNote = 'backup has more than one ' + id + ' createdAt ' + beforeTime + ' left unchanged';
    } else if (!match.item) {
      timeNote = 'not in backup createdAt ' + beforeTime + ' left unchanged';
    } else {
      restored = restoreOriginalFields(item, match.item);
      const afterTime = item.createdAt ? String(item.createdAt) : 'null';
      timeNote = 'createdAt ' + beforeTime + ' -> ' + afterTime;
      if (restored.length) timeNote += ' restored ' + restored.join(',');
    }
    const deckChanged = item.deckId !== 'TD-06';
    const sideChanged = item.side !== 'back' || knownFace(item.gradingReport && item.gradingReport.side) !== 'back';
    item.deckId = 'TD-06';
    item.side = 'back';
    if (!item.gradingReport || typeof item.gradingReport !== 'object') item.gradingReport = {};
    item.gradingReport.side = 'back';
    const backupProblem = backupMissing || match.ambiguous || !match.item;
    if (!deckChanged && !sideChanged && !restored.length && !backupProblem) return;
    if (!deckChanged && !sideChanged && !restored.length && backupProblem) {
      log('[centering-assist] repair scanId=' + id + ' ' + timeNote);
      return;
    }
    changed += 1;
    log('[centering-assist] repair scanId=' + id +
      ' deckId ' + beforeDeck + ' -> TD-06' +
      ' side ' + beforeSide + ' -> back' +
      ' ' + timeNote);
  });
  if (!saw && backupMissing) {
    log('[centering-assist] repair backup missing ' + (source.path || BACKUP_366_NAME) +
      (source.error ? ' ' + source.error : '') +
      ' no 366A0E19 row createdAt left unchanged');
  }
  return changed;
}

/**
 * Save an assist onto an existing record. Deck id, side, and createdAt stay
 * the capture's values. A missing side is not filled with front. setSide is
 * applied only while the record has no side. adjustedAt is the save, not the capture.
 */
function applyStoredAssist(item, assist, now, options) {
  options = options || {};
  const createdAt = item && item.createdAt;
  const deckId = item && item.deckId;
  const stored = knownFace(item && item.side) || knownFace(item && item.gradingReport && item.gradingReport.side);
  const side = stored || (!stored && knownFace(options.setSide)) || null;
  const block = Object.assign({}, assist || {}, { adjustedAt: now || new Date().toISOString(), side: side });
  const ratios = geometry.ratiosFromWidthsMm(block.borderWidthsMm);
  if (side && ratios) {
    const scored = scoreAssistedCentering(side, ratios);
    block.centering = scored.score;
    block.centeringLabel = scored.label;
    block.leftRightRatio = ratios.leftRightRatio;
    block.topBottomRatio = ratios.topBottomRatio;
  } else if (!side) {
    block.centering = null;
    block.centeringLabel = null;
  }
  const next = attachAssist(item, block);
  next.createdAt = createdAt;
  if (deckId == null || deckId === '') delete next.deckId;
  else next.deckId = deckId;
  if (side) {
    next.side = side;
    if (next.gradingReport) next.gradingReport.side = side;
  } else if (next.gradingReport) {
    delete next.side;
    delete next.gradingReport.side;
  }
  return next;
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
  attachAssist: attachAssist,
  scoreAssistedCentering: scoreAssistedCentering,
  knownFace: knownFace,
  assistedSide: assistedSide,
  applyStoredAssist: applyStoredAssist,
  BACKUP_366_NAME: BACKUP_366_NAME,
  repairRecord366A0E19: repairRecord366A0E19,
  rescoreStoredAssist: rescoreStoredAssist,
  rescoreDatabase: rescoreDatabase
};
