#!/usr/bin/env node
/**
 * scripts/phone_flatbed_baseline.js
 *
 * Re-grade saved phone scans with the current grading engine and compare
 * each edge, in millimetres, to the flatbed answer-key mean. Read-only:
 * the engine is not modified and no scan record is written.
 *
 * An edge error is phone millimetres minus the flatbed mean. It is withheld
 * when the phone did not publish that edge, when the flatbed mean is
 * withheld, or when the phone scan is a back (the flatbed key is the front).
 * Every row is provisional until the flatbed overlays are approved.
 *
 *   node scripts/phone_flatbed_baseline.js \
 *     --data /tmp/scan-data/data --uploads /tmp/scan-data/uploads \
 *     --answer-key reference/answer_key.json
 *   node scripts/phone_flatbed_baseline.js --self-test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const dumpScans = require('./dump_scans');
const compare = require('./compare_finders');

const EDGES = ['left', 'right', 'top', 'bottom'];
const DEFAULT_DECKS = ['TD-05', 'TD-06', 'TD-07', 'TD-08', 'TD-09', 'TD-10', 'TD-11'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function finite(v) {
  return typeof v === 'number' && isFinite(v);
}

/**
 * Phone millimetres minus the flatbed mean. Null when either side is withheld.
 * @param {number|null} phoneMm
 * @param {{mm?: number|null, withheld?: boolean, reason?: string|null}|null} flatbedSide
 * @returns {{errorMm: number|null, reason: string|null}}
 */
function edgeError(phoneMm, flatbedSide) {
  if (!finite(phoneMm)) return { errorMm: null, reason: 'phone-withheld' };
  if (!flatbedSide) return { errorMm: null, reason: 'no-flatbed-mean' };
  if (flatbedSide.withheld || !finite(flatbedSide.mm)) {
    return { errorMm: null, reason: flatbedSide.reason || 'flatbed-withheld' };
  }
  return { errorMm: round3(phoneMm - flatbedSide.mm), reason: null };
}

function loadAnswerKey(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.cards ? raw : { cards: {} };
}

function flatbedCard(key, deckId, side) {
  if (side === 'back') return { card: null, skipReason: 'no-flatbed-back' };
  const card = key.cards && key.cards[deckId];
  if (!card) return { card: null, skipReason: 'no-flatbed-mean' };
  return { card: card, skipReason: null };
}

function phoneEdgeMm(report) {
  const mm = report && report.centeringMetrics && report.centeringMetrics.borderWidthsMm;
  const out = {};
  EDGES.forEach(function (edge) {
    const v = mm && mm[edge];
    out[edge] = finite(v) ? v : null;
  });
  return out;
}

/**
 * A rejected print-border detection stores candidate widths and does not
 * accept them. Those widths are not a measurement.
 */
function measurementRejected(report) {
  if (!report || report.cardNotFound) return true;
  if (report.centeringUndetected === true) return true;
  if (report.incomplete === true) return true;
  if (report.printCenteringDetected === false) return true;
  return false;
}

function phoneStatus(report) {
  if (!report) return 'missing';
  if (report.cardNotFound) return 'card not found';
  const m = report.centeringMetrics || {};
  const lr = m.leftRightRatio && m.leftRightRatio.left;
  const tb = m.topBottomRatio && m.topBottomRatio.top;
  const measured = finite(lr) && finite(tb);
  const voteLow = m.borderVoteLowConfidenceEdges || [];
  const cen = report.subGrades ? report.subGrades.centering : null;
  if (measured && voteLow.length && cen == null) return 'withheld';
  if (measured) return 'measured';
  const reasons = (report.centeringDiagnostics && report.centeringDiagnostics.borderReliability &&
    report.centeringDiagnostics.borderReliability.reasons) || [];
  return 'undetectable' + (reasons[0] ? ': ' + reasons[0] : '');
}

function selectScans(dataDir, decks) {
  const want = {};
  decks.forEach(function (id) { want[String(id).toUpperCase()] = true; });
  const labels = dumpScans.loadLabelMap(dataDir);
  return dumpScans.loadGradedItems(dataDir).map(function (item) {
    return dumpScans.applyLabelFields(item, labels);
  }).filter(function (item) {
    return want[String(item.deckId || '').toUpperCase()];
  }).sort(function (a, b) {
    const da = String(a.deckId);
    const db = String(b.deckId);
    if (da !== db) return da < db ? -1 : 1;
    const sa = a.side === 'back' ? 1 : 0;
    const sb = b.side === 'back' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

function compareScan(report, key, deckId, side) {
  const raw = phoneEdgeMm(report);
  const rejected = measurementRejected(report);
  const phone = {};
  EDGES.forEach(function (edge) { phone[edge] = rejected ? null : raw[edge]; });
  const looked = flatbedCard(key, deckId, side);
  const edges = {};
  EDGES.forEach(function (edge) {
    const flat = looked.card && looked.card.sides && looked.card.sides[edge];
    const err = looked.skipReason
      ? { errorMm: null, reason: looked.skipReason }
      : edgeError(phone[edge], flat || null);
    let reason = err.reason;
    if (reason === 'phone-withheld' && flat && (flat.withheld || !finite(flat.mm))) {
      reason = 'phone-withheld; flatbed ' + (flat.reason || 'withheld');
    }
    edges[edge] = {
      phoneMm: phone[edge],
      rawMm: rejected && finite(raw[edge]) ? raw[edge] : null,
      flatbedMm: flat && !flat.withheld && finite(flat.mm) ? flat.mm : null,
      errorMm: err.errorMm,
      reason: reason,
      flatbedApproved: Boolean(flat && flat.approved)
    };
  });
  return {
    provisional: true,
    status: phoneStatus(report),
    engineVersion: report && report.engineVersion || null,
    edges: edges
  };
}

function fmt(v) {
  return finite(v) ? v.toFixed(3) : '—';
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function tableText(rows) {
  const lines = [];
  lines.push('provisional until the flatbed overlays are approved');
  lines.push(pad('deck', 8) + pad('side', 7) + pad('scan', 10) + pad('edge', 8) +
    pad('phone', 10) + pad('flatbed', 10) + pad('error', 10) + 'note');
  rows.forEach(function (row) {
    EDGES.forEach(function (edge) {
      const e = row.edges[edge];
      lines.push(pad(row.deckId, 8) + pad(row.side, 7) + pad(row.scanId.slice(0, 8), 10) +
        pad(edge, 8) + pad(fmt(e.phoneMm), 10) + pad(fmt(e.flatbedMm), 10) +
        pad(fmt(e.errorMm), 10) + (e.reason || '') +
        (finite(e.rawMm) ? '  raw ' + fmt(e.rawMm) + ' not accepted' : ''));
    });
    lines.push(pad('', 8) + pad('', 7) + pad('', 10) + pad('status', 8) + row.status +
      '  ' + (row.capturedAt || '') + (row.quad ? '  quad ' + row.quad : ''));
  });
  return lines.join('\n');
}

async function runBaseline(options) {
  const dataDir = path.resolve(options.dataDir);
  const uploadsDir = path.resolve(options.uploadsDir || path.join(dataDir, '..', 'uploads'));
  const keyFile = path.resolve(options.answerKey);
  const decks = options.decks || DEFAULT_DECKS;
  const engine = compare.loadEngine(options.engineDir || path.join(__dirname, '..'));
  const key = loadAnswerKey(keyFile);
  const scans = selectScans(dataDir, decks);
  const rows = [];
  for (const item of scans) {
    const id = String(item.scanId || item.id || '');
    const side = item.side === 'back' ? 'back' : 'front';
    const file = item.imagePath ? path.join(uploadsDir, path.basename(item.imagePath)) : null;
    if (!file || !fs.existsSync(file)) {
      rows.push({
        deckId: item.deckId, side: side, scanId: id, capturedAt: item.createdAt || null,
        quad: null, missing: file || 'no image', provisional: true, status: 'upload missing',
        engineVersion: null,
        edges: EDGES.reduce(function (acc, edge) {
          acc[edge] = { phoneMm: null, rawMm: null, flatbedMm: null, errorMm: null, reason: 'upload-missing', flatbedApproved: false };
          return acc;
        }, {})
      });
      continue;
    }
    const stored = item.gradingReport || {};
    const q = compare.quadOptions(stored);
    const gradeOpts = Object.assign({}, q.opts);
    if (side === 'back') gradeOpts.side = 'back';
    const report = await compare.gradeQuietly(engine, fs.readFileSync(file), gradeOpts);
    const compared = compareScan(report, key, String(item.deckId).toUpperCase(), side);
    rows.push({
      deckId: String(item.deckId).toUpperCase(),
      side: side,
      scanId: id,
      capturedAt: item.createdAt || null,
      quad: q.label,
      missing: null,
      provisional: true,
      status: compared.status,
      engineVersion: compared.engineVersion,
      edges: compared.edges
    });
  }
  return {
    provisional: true,
    engineDir: path.resolve(options.engineDir || path.join(__dirname, '..')),
    answerKey: keyFile,
    decks: decks,
    rows: rows,
    text: tableText(rows)
  };
}

function selfTest() {
  const failures = [];
  function assert(name, cond) {
    if (!cond) failures.push(name);
  }
  const kept = edgeError(1.2, { mm: 0.7, withheld: false });
  assert('error is phone minus flatbed', kept.errorMm === 0.5 && kept.reason == null);
  const withheldFlat = edgeError(1.2, { mm: 0.7, withheld: true, reason: 'unclear' });
  assert('withheld flatbed mean has no error', withheldFlat.errorMm == null && withheldFlat.reason === 'unclear');
  const noPhone = edgeError(null, { mm: 0.7, withheld: false });
  assert('withheld phone edge has no error', noPhone.errorMm == null && noPhone.reason === 'phone-withheld');
  const missing = edgeError(1.2, null);
  assert('missing flatbed side has no error', missing.errorMm == null && missing.reason === 'no-flatbed-mean');
  const back = compareScan({ centeringMetrics: { borderWidthsMm: { left: 1, right: 1, top: 1, bottom: 1 } } }, { cards: { 'TD-08': { sides: { left: { mm: 1, withheld: false } } } } }, 'TD-08', 'back');
  assert('a back is not compared to the front key', back.edges.left.errorMm == null && back.edges.left.reason === 'no-flatbed-back');
  assert('every comparison is provisional', back.provisional === true);
  const none = compareScan({
    centeringMetrics: { borderWidthsMm: { left: 2, right: null, top: 1, bottom: 1 }, leftRightRatio: { left: 50 }, topBottomRatio: { top: 50 } },
    subGrades: { centering: 9 }
  }, { cards: {} }, 'TD-11', 'front');
  assert('no answer-key card withholds the error', none.edges.left.reason === 'no-flatbed-mean' && none.edges.left.errorMm == null);
  assert('a missing key withholds the error even when the phone edge is null', none.edges.right.reason === 'no-flatbed-mean' && none.edges.right.phoneMm == null);
  const partial = compareScan({
    centeringMetrics: { borderWidthsMm: { left: 1.5, right: null, top: 1, bottom: 1 } }
  }, { cards: { 'TD-08': { sides: {
    left: { mm: 0.7, withheld: false, approved: false },
    right: { mm: 0.6, withheld: false, approved: false },
    top: { mm: null, withheld: true, reason: 'unclear', approved: false },
    bottom: { mm: 0.675, withheld: false, approved: false }
  } } } }, 'TD-08', 'front');
  assert('published edges subtract the flatbed mean', partial.edges.left.errorMm === 0.8);
  assert('a null phone edge is withheld when the flatbed mean exists', partial.edges.right.reason === 'phone-withheld' && partial.edges.right.errorMm == null);
  assert('a withheld flatbed mean publishes no error', partial.edges.top.reason === 'unclear' && partial.edges.top.errorMm == null);
  const rejected = compareScan({
    incomplete: true,
    centeringUndetected: true,
    printCenteringDetected: false,
    centeringMetrics: { borderWidthsMm: { left: null, right: 3.667, top: null, bottom: null } }
  }, { cards: { 'TD-07': { sides: { right: { mm: null, withheld: true, reason: 'unmeasured', approved: false } } } } }, 'TD-07', 'front');
  assert('a rejected detection is not a phone measurement', rejected.edges.right.phoneMm == null && rejected.edges.right.errorMm == null);
  assert('the rejected candidate width is kept only as raw', rejected.edges.right.rawMm === 3.667 && /phone-withheld/.test(rejected.edges.right.reason));
  if (failures.length) {
    console.error(failures.length + ' baseline check(s) failed: ' + failures.join('; '));
    process.exit(1);
  }
  console.log('self-test ok');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    selfTest();
  } else {
    if (!args.data || !args['answer-key']) {
      console.error('usage: node scripts/phone_flatbed_baseline.js --data DIR --answer-key FILE [--uploads DIR] [--decks TD-05,TD-06]');
      process.exit(2);
    }
    runBaseline({
      dataDir: args.data,
      uploadsDir: args.uploads,
      answerKey: args['answer-key'],
      engineDir: args.engine,
      decks: args.decks ? String(args.decks).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : DEFAULT_DECKS
    }).then(function (out) {
      console.log(out.text);
      if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 2) + '\n');
    }).catch(function (err) {
      console.error('phone_flatbed_baseline failed:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
  }
}

module.exports = { edgeError, compareScan, phoneStatus, selectScans, runBaseline, selfTest };
