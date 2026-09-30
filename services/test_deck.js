/**
 * services/test_deck.js
 * Fixed benchmark "test deck" registry and per-scan labels.
 *
 *   data/test_deck.json   deck cards: TD-01…TD-50 → category, title, notes,
 *                         ruler/caliper border mm, known grade, expectation
 *   data/scan_labels.json per scan: deck card, pre-submission flag and the
 *                         intended grader, and the returned grade
 *
 * Labels are separate from inventory records so re-grading or re-saving a
 * scan never loses them. Every submission (deck or not) becomes a labeled
 * example of predicted vs actual, stored per grading company. Companies are
 * never averaged together. A slab with no number (Authentic, Altered, No
 * Grade) is still a result.
 *
 * Older labels that only have psaGrade / psaCert / knownPsaGrade are read as
 * a PSA result. Saving a new result writes `result` and mirrors those fields
 * when the company is PSA, so nothing already entered is dropped.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** `expect`: what an honest engine should return for this category today. */
const DECK_CATEGORIES = [
  { id: 'white-vintage', label: 'White border — vintage (1950s–70s)', expect: 'measured' },
  { id: 'white-80s-90s', label: 'White border — 1980s–90s', expect: 'measured' },
  { id: 'white-modern', label: 'White border — modern', expect: 'measured' },
  { id: 'colored-border', label: 'Colored border (black, blue, team colors)', expect: 'measured' },
  { id: 'borderless', label: 'Borderless / full-bleed', expect: 'undetectable' },
  { id: 'chrome-foil', label: 'Chrome / refractor / foil', expect: 'measured' },
  { id: 'die-cut', label: 'Die-cut / odd shape', expect: 'undetectable' },
  { id: 'tcg-pokemon', label: 'TCG — Pokémon', expect: 'measured' },
  { id: 'tcg-magic', label: 'TCG — Magic', expect: 'measured' },
  { id: 'off-center', label: 'Visibly off-center', expect: 'offcenter' },
  { id: 'worn', label: 'Worn (corners, edges, creases)', expect: 'measured' }
];
const CATEGORY_IDS = DECK_CATEGORIES.map(function (c) { return c.id; });
const EXPECTATIONS = ['measured', 'undetectable', 'offcenter'];
/** Worst-axis share above this counts as "caught as off-center" (PSA 60/40 bound). */
const OFF_CENTER_SHARE = 60;
const DECK_ID_PATTERN = /^TD-\d{2,3}$/;

function normalizeDeckId(raw) {
  if (raw == null) return null;
  const id = String(raw).trim().toUpperCase();
  return DECK_ID_PATTERN.test(id) ? id : null;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function numberOrNull(v, min, max) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) return undefined;
  return n;
}

/** Overall grades and sub-grades: 1–10 in half-point steps. */
function normalizeHalfGrade(v) {
  const n = numberOrNull(v, 1, 10);
  if (n == null || n === undefined) return n;
  return Math.round(n * 2) === n * 2 ? n : undefined;
}

const GRADERS = ['PSA', 'BGS', 'SGC', 'CGC', 'TAG', 'Other'];
/** Printed special labels. The company prefix must match `grader`. */
const SPECIAL_LABELS = ['BGS Pristine', 'BGS Black Label', 'SGC Pristine 10', 'CGC Pristine', 'CGC Perfect 10'];
const QUALIFIERS = ['OC', 'ST', 'PD', 'OF', 'MC', 'MK'];
const OUTCOMES = ['Authentic', 'Altered', 'No Grade'];
const SUBGRADE_KEYS = ['centering', 'corners', 'edges', 'surface'];

function normalizeGrader(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  for (let i = 0; i < GRADERS.length; i++) {
    if (GRADERS[i].toLowerCase() === s) return GRADERS[i];
  }
  return undefined;
}

function normalizeSpecialLabel(v, grader) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  const hit = SPECIAL_LABELS.filter(function (label) { return label.toLowerCase() === s; })[0];
  if (!hit) return undefined;
  if (grader && hit.slice(0, grader.length).toLowerCase() !== grader.toLowerCase()) return undefined;
  return hit;
}

function normalizeOutcome(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  const hit = OUTCOMES.filter(function (o) { return o.toLowerCase() === s; })[0];
  return hit || undefined;
}

function normalizeQualifiers(v) {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] == null || list[i] === '') continue;
    const hit = QUALIFIERS.filter(function (q) { return q.toLowerCase() === String(list[i]).trim().toLowerCase(); })[0];
    if (!hit) return undefined;
    if (out.indexOf(hit) === -1) out.push(hit);
  }
  return QUALIFIERS.filter(function (q) { return out.indexOf(q) !== -1; });
}

/** Kept exactly as typed, so a TAG score of "975" is not turned into a number. */
function normalizePrinted(v, maxLen) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s || /[\u0000-\u001f]/.test(s) || s.length > maxLen) return undefined;
  return s;
}

function normalizeAutoGrade(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(s)) return normalizeHalfGrade(s);
  return normalizePrinted(s, 40);
}

function normalizeSubgrades(v) {
  const src = v && typeof v === 'object' ? v : {};
  const out = {};
  for (let i = 0; i < SUBGRADE_KEYS.length; i++) {
    const k = SUBGRADE_KEYS[i];
    if (!(k in src) || src[k] == null || src[k] === '') continue;
    const n = normalizeHalfGrade(src[k]);
    if (n === undefined) return undefined;
    if (n != null) out[k] = n;
  }
  return out;
}

function normalizeCert(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/[^0-9A-Za-z-]/g, '').slice(0, 32);
  return s || null;
}

/**
 * One company's returned grade. Null fields are omitted by the caller.
 * `grade` is the numeric overall (half points). `outcome` is Authentic,
 * Altered, or No Grade — a result with no number. They cannot both be set.
 * @returns {object|null|undefined} undefined = invalid
 */
function normalizeGradeResult(raw, fallbackGrader) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const grader = normalizeGrader(raw.grader != null && raw.grader !== '' ? raw.grader : fallbackGrader);
  if (grader === undefined) return undefined;
  const grade = normalizeHalfGrade(raw.grade);
  if (grade === undefined) return undefined;
  const specialLabel = normalizeSpecialLabel(raw.specialLabel, grader);
  if (specialLabel === undefined) return undefined;
  const outcome = normalizeOutcome(raw.outcome);
  if (outcome === undefined) return undefined;
  if (outcome && (grade != null || specialLabel)) return undefined;
  const subgrades = normalizeSubgrades(raw.subgrades);
  if (subgrades === undefined) return undefined;
  const tagScore = normalizePrinted(raw.tagScore, 40);
  if (tagScore === undefined) return undefined;
  const qualifiers = normalizeQualifiers(raw.qualifiers);
  if (qualifiers === undefined) return undefined;
  const autoGrade = normalizeAutoGrade(raw.autoGrade);
  if (autoGrade === undefined) return undefined;
  const cert = normalizeCert(raw.cert);
  const result = {
    grader: grader,
    grade: grade,
    specialLabel: specialLabel,
    outcome: outcome,
    subgrades: subgrades,
    tagScore: tagScore,
    qualifiers: qualifiers,
    autoGrade: autoGrade,
    cert: cert
  };
  if (!grader && (grade != null || specialLabel || outcome || tagScore || autoGrade != null || cert ||
      qualifiers.length || SUBGRADE_KEYS.some(function (k) { return subgrades[k] != null; }))) {
    return undefined;
  }
  if (!hasGradeResult(result)) return null;
  if (!grader) return undefined;
  return result;
}

function hasGradeResult(rec) {
  if (!rec) return false;
  if (rec.grade != null || rec.specialLabel || rec.outcome || rec.tagScore || rec.cert) return true;
  if (rec.autoGrade != null && rec.autoGrade !== '') return true;
  if (rec.qualifiers && rec.qualifiers.length) return true;
  const sub = rec.subgrades || {};
  return SUBGRADE_KEYS.some(function (k) { return sub[k] != null; });
}

/** Old PSA-only fields, read as a PSA result when `result` was never written. */
function resultFromLegacy(grade, cert) {
  if (grade == null && !cert) return null;
  return {
    grader: 'PSA',
    grade: grade == null ? null : grade,
    specialLabel: null,
    outcome: null,
    subgrades: {},
    tagScore: null,
    qualifiers: [],
    autoGrade: null,
    cert: cert || null
  };
}

function resolveResult(label) {
  if (!label) return null;
  if (hasGradeResult(label.result)) return label.result;
  return resultFromLegacy(label.psaGrade, label.psaCert);
}

function resolveKnown(card) {
  if (!card) return null;
  if (hasGradeResult(card.knownGrade)) return card.knownGrade;
  if (card.knownPsaGrade == null) return null;
  return resultFromLegacy(card.knownPsaGrade, null);
}

function presentLabel(label) {
  const out = Object.assign({}, label);
  const result = resolveResult(label);
  if (result) out.result = result;
  return out;
}

function presentCard(card) {
  const out = Object.assign({}, card);
  const known = resolveKnown(card);
  if (known) out.knownGrade = known;
  return out;
}

function formatGradeShort(rec) {
  if (!hasGradeResult(rec)) return null;
  const parts = [rec.grader || '?'];
  if (rec.outcome) parts.push(rec.outcome);
  else if (rec.grade != null) parts.push(String(rec.grade));
  if (rec.specialLabel) {
    const prefix = (rec.grader || '') + ' ';
    parts.push(rec.specialLabel.indexOf(prefix) === 0 ? rec.specialLabel.slice(prefix.length) : rec.specialLabel);
  }
  if (rec.tagScore) parts.push('score ' + rec.tagScore);
  if (rec.qualifiers && rec.qualifiers.length) parts.push(rec.qualifiers.join(' '));
  if (rec.autoGrade != null && rec.autoGrade !== '') parts.push('auto ' + rec.autoGrade);
  if (rec.cert) parts.push('cert ' + rec.cert);
  return parts.join(' ');
}

function createStore(dataDir) {
  const deckPath = path.join(dataDir, 'test_deck.json');
  const labelsPath = path.join(dataDir, 'scan_labels.json');

  function loadDeck() {
    const d = readJson(deckPath, null) || {};
    return { version: 1, cards: d.cards || {} };
  }
  function loadLabels() {
    const d = readJson(labelsPath, null) || {};
    return { version: 1, scans: d.scans || {} };
  }

  /** Upsert a deck card. Returns { ok, card } or { ok:false, error }. */
  function upsertCard(deckIdRaw, fields) {
    const deckId = normalizeDeckId(deckIdRaw);
    if (!deckId) return { ok: false, error: 'deck id must look like TD-01' };
    const f = fields || {};
    const deck = loadDeck();
    const prev = deck.cards[deckId] || { deckId: deckId };
    const next = Object.assign({}, prev);
    if ('category' in f) {
      if (f.category != null && f.category !== '' && CATEGORY_IDS.indexOf(f.category) === -1) {
        return { ok: false, error: 'unknown category ' + f.category };
      }
      next.category = f.category || null;
    }
    if ('expect' in f) {
      if (f.expect != null && f.expect !== '' && EXPECTATIONS.indexOf(f.expect) === -1) {
        return { ok: false, error: 'expect must be one of ' + EXPECTATIONS.join(', ') };
      }
      next.expect = f.expect || null;
    }
    if ('title' in f) next.title = f.title ? String(f.title).slice(0, 200) : null;
    if ('notes' in f) next.notes = f.notes ? String(f.notes).slice(0, 2000) : null;
    if ('physicalMm' in f) {
      const mm = f.physicalMm || {};
      const out = {};
      for (const k of ['left', 'right', 'top', 'bottom']) {
        const v = numberOrNull(mm[k], 0, 20);
        if (v === undefined) return { ok: false, error: 'physicalMm.' + k + ' must be 0–20 mm' };
        out[k] = v;
      }
      next.physicalMm = out;
    }
    if ('knownGrade' in f) {
      const g = normalizeGradeResult(f.knownGrade, null);
      if (g === undefined) return { ok: false, error: 'knownGrade is not a valid grade result' };
      next.knownGrade = g;
      next.knownPsaGrade = g && g.grader === 'PSA' && g.grade != null ? g.grade : null;
    } else if ('knownPsaGrade' in f) {
      const g = normalizeHalfGrade(f.knownPsaGrade);
      if (g === undefined) return { ok: false, error: 'knownPsaGrade must be 1–10 in 0.5 steps' };
      next.knownPsaGrade = g;
      next.knownGrade = g == null ? null : resultFromLegacy(g, null);
    }
    next.updatedAt = new Date().toISOString();
    deck.cards[deckId] = next;
    writeJsonAtomic(deckPath, deck);
    return { ok: true, card: next };
  }

  /**
   * Label a scan. Unset fields are left as they were; `deckId: null` removes
   * the deck assignment. `result: null` clears a returned grade. A legacy
   * `psaGrade` / `psaCert` is stored as a PSA result.
   */
  function labelScan(scanId, fields, source) {
    if (!scanId) return { ok: false, error: 'scanId required' };
    const f = fields || {};
    const labels = loadLabels();
    const prev = labels.scans[scanId] || { scanId: scanId };
    const next = Object.assign({}, prev);
    if ('deckId' in f) {
      if (f.deckId == null || f.deckId === '') next.deckId = null;
      else {
        const id = normalizeDeckId(f.deckId);
        if (!id) return { ok: false, error: 'deck id must look like TD-01' };
        next.deckId = id;
        if (!loadDeck().cards[id]) upsertCard(id, {});
      }
    }
    if ('preSubmission' in f) next.preSubmission = f.preSubmission === true || f.preSubmission === 'true' || f.preSubmission === '1';
    if ('side' in f) {
      if (f.side == null || f.side === '') next.side = null;
      else if (f.side === 'front' || f.side === 'back') next.side = f.side;
      else return { ok: false, error: 'side must be front or back' };
    }
    if ('pairId' in f) {
      if (f.pairId == null || f.pairId === '') next.pairId = null;
      else {
        const pairId = String(f.pairId).trim();
        if (!/^[A-Za-z0-9._-]{8,80}$/.test(pairId)) return { ok: false, error: 'pairId is not a scan id' };
        next.pairId = pairId;
      }
    }
    if ('intendedGrader' in f) {
      const g = normalizeGrader(f.intendedGrader);
      if (g === undefined) return { ok: false, error: 'intended grader must be one of ' + GRADERS.join(', ') };
      next.intendedGrader = g;
    }
    if ('result' in f) {
      const fallback = next.intendedGrader || (next.result && next.result.grader) || null;
      const g = normalizeGradeResult(f.result, fallback);
      if (g === undefined) return { ok: false, error: 'result is not a valid grade (company, half-point grade, label, outcome)' };
      applyResult(next, g);
    } else if ('psaGrade' in f || 'psaCert' in f) {
      const grade = 'psaGrade' in f ? normalizeHalfGrade(f.psaGrade) : (next.psaGrade == null ? null : next.psaGrade);
      if (grade === undefined) return { ok: false, error: 'psaGrade must be 1–10 in 0.5 steps' };
      const cert = 'psaCert' in f ? normalizeCert(f.psaCert) : (next.psaCert || null);
      applyResult(next, resultFromLegacy(grade, cert));
    }
    next.source = prev.source || source || 'web';
    next.updatedAt = new Date().toISOString();
    labels.scans[scanId] = next;
    writeJsonAtomic(labelsPath, labels);
    return { ok: true, label: next };
  }

  return { deckPath, labelsPath, loadDeck, loadLabels, upsertCard, labelScan };
}

function applyResult(label, result) {
  label.result = result;
  label.psaRecordedAt = result ? new Date().toISOString() : null;
  label.psaGrade = result && result.grader === 'PSA' && result.grade != null ? result.grade : null;
  label.psaCert = result && result.grader === 'PSA' ? (result.cert || null) : null;
}

/** Did this result meet the category's honest expectation? */
function judgeExpectation(expect, result) {
  if (!expect) return null;
  if (expect === 'undetectable') return !result.measured;
  if (!result.measured) return false;
  if (expect === 'offcenter') return result.worstShare != null && result.worstShare > OFF_CENTER_SHARE;
  return true;
}

module.exports = {
  DECK_CATEGORIES,
  CATEGORY_IDS,
  EXPECTATIONS,
  OFF_CENTER_SHARE,
  GRADERS,
  SPECIAL_LABELS,
  QUALIFIERS,
  OUTCOMES,
  SUBGRADE_KEYS,
  normalizeDeckId,
  normalizeHalfGrade,
  normalizePsaGrade: normalizeHalfGrade,
  normalizeGradeResult,
  hasGradeResult,
  resolveResult,
  resolveKnown,
  presentLabel,
  presentCard,
  formatGradeShort,
  createStore,
  judgeExpectation
};
