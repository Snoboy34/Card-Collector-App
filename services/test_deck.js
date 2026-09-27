/**
 * services/test_deck.js
 * Fixed benchmark "test deck" registry and per-scan labels.
 *
 *   data/test_deck.json   deck cards: TD-01…TD-50 → category, title, notes,
 *                         ruler/caliper border mm, known PSA grade, expectation
 *   data/scan_labels.json per scan: deck card, pre-submission flag, PSA result
 *
 * Labels are separate from inventory records so re-grading or re-saving a
 * scan never loses them, and every PSA submission (deck or not) becomes a
 * labeled example of predicted vs actual grade.
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

/** PSA grades: 1–10 in 0.5 steps (half grades 1.5–9.5). */
function normalizePsaGrade(v) {
  const n = numberOrNull(v, 1, 10);
  if (n == null || n === undefined) return n;
  return Math.round(n * 2) === n * 2 ? n : undefined;
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
    if ('knownPsaGrade' in f) {
      const g = normalizePsaGrade(f.knownPsaGrade);
      if (g === undefined) return { ok: false, error: 'knownPsaGrade must be 1–10 in 0.5 steps' };
      next.knownPsaGrade = g;
    }
    next.updatedAt = new Date().toISOString();
    deck.cards[deckId] = next;
    writeJsonAtomic(deckPath, deck);
    return { ok: true, card: next };
  }

  /**
   * Label a scan (deck card, pre-submission, PSA result). Unset fields are
   * left as they were; `deckId: null` removes the deck assignment.
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
    if ('psaGrade' in f) {
      const g = normalizePsaGrade(f.psaGrade);
      if (g === undefined) return { ok: false, error: 'psaGrade must be 1–10 in 0.5 steps' };
      next.psaGrade = g;
      next.psaRecordedAt = g == null ? null : new Date().toISOString();
    }
    if ('psaCert' in f) next.psaCert = f.psaCert ? String(f.psaCert).replace(/[^0-9A-Za-z-]/g, '').slice(0, 20) : null;
    next.source = prev.source || source || 'web';
    next.updatedAt = new Date().toISOString();
    labels.scans[scanId] = next;
    writeJsonAtomic(labelsPath, labels);
    return { ok: true, label: next };
  }

  return { deckPath, labelsPath, loadDeck, loadLabels, upsertCard, labelScan };
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
  normalizeDeckId,
  normalizePsaGrade,
  createStore,
  judgeExpectation
};
