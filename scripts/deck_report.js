#!/usr/bin/env node
/**
 * scripts/deck_report.js
 * Test-deck release gate. For each deck card (TD-xx): the latest scan vs
 * the latest scan from a different engine, optionally a candidate engine's
 * re-grade of the latest upload, the ruler check, and per-category pass
 * rates. Also ground truth per grading company: each returned grade, including
 * a slab with no number, sits next to that scan's Judge prediction. Companies
 * are not averaged together. Read-only.
 *
 * Usage:
 *   node scripts/deck_report.js                       # stored results
 *   node scripts/deck_report.js --candidate /tmp/judge-next   # + re-grade
 *   JUDGE_DATA_DIR=/path/to/data node scripts/deck_report.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const deck = require('../services/test_deck');
const dumpScans = require('./dump_scans');
const scanMetadata = require('../services/scan_metadata');
const backScan = require('../services/back_scan');

function fmt(v, d) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(d == null ? 1 : d) : '—';
}
function signed(v) {
  return typeof v === 'number' && isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(1) : '—';
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}
function localTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '—');
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function engineLabel(e) {
  if (!e) return 'engine ?';
  return 'engine ' + (e.version || '?') + (e.commit ? ' (' + e.commit + ')' : '');
}

function resultFromReport(report) {
  const r = report || {};
  const m = r.centeringMetrics || {};
  const diag = r.centeringDiagnostics || {};
  const lr = m.leftRightRatio ? m.leftRightRatio.left : null;
  const tb = m.topBottomRatio ? m.topBottomRatio.top : null;
  const measured = lr != null && tb != null;
  const reasons = (diag.borderReliability && diag.borderReliability.reasons) || [];
  const voteLow = m.borderVoteLowConfidenceEdges || [];
  const cen = r.subGrades ? r.subGrades.centering : null;
  let status = measured ? 'measured' : 'undetectable';
  if (measured && voteLow.length && cen == null) status = 'withheld';
  let reason = measured ? null : (reasons[0] || r.incompleteReason || null);
  if (r.cardNotFound) { status = 'card not found'; reason = r.cardNotFoundReason || 'card not found'; }
  return {
    measured: measured,
    status: status,
    reason: reason,
    lr: lr,
    tb: tb,
    worstShare: measured ? 50 + Math.max(Math.abs(lr - 50), Math.abs(tb - 50)) : null,
    cen: cen,
    corners: r.subGrades ? r.subGrades.corners : null,
    edges: r.subGrades ? r.subGrades.edges : null,
    surface: r.subGrades ? r.subGrades.surface : null,
    finalScore: r.finalScore != null ? r.finalScore : null,
    mm: m.borderWidthsMm || null,
    lowConfidenceEdges: m.lowConfidenceEdges || (r.cardDetection && r.cardDetection.lowConfidenceEdges) || [],
    borderVoteLowConfidenceEdges: m.borderVoteLowConfidenceEdges || []
  };
}

function rulerRatios(mm) {
  if (!mm || [mm.left, mm.right, mm.top, mm.bottom].some(function (v) { return v == null; })) return null;
  if (mm.left + mm.right <= 0 || mm.top + mm.bottom <= 0) return null;
  return { lr: 100 * mm.left / (mm.left + mm.right), tb: 100 * mm.top / (mm.top + mm.bottom) };
}

function psaBackComparison(scan) {
  const share = scan && scan.result ? scan.result.worstShare : null;
  const gem = backScan.psaGemMint10Back(share);
  if (!gem.judged) return 'PSA 10 reverse (75/25): centering —';
  const best = backScan.bestPsaBackGrade(share);
  let allows = 'none';
  if (best.grade != null) {
    allows = String(best.grade) + ' (' + best.maxShare + '/' + (100 - best.maxShare) + ')';
  }
  return 'PSA 10 reverse (75/25): worst share ' + fmt(gem.worstShare) +
    (gem.within ? ' (within)' : ' (outside)') +
    '; best grade the back allows: ' + allows;
}

function backNote(scan) {
  const map = scan && scan.edgeMap;
  const parts = ['not scored'];
  if (map && map.upsideDown === true) parts.push('upside down, edge map not applied');
  else if (map && map.applied && map.imageToFront) parts.push('flip-left-right, image left is front right');
  else parts.push('edge map not applied');
  if (scan && scan.copyrightYear) parts.push('copyright ' + scan.copyrightYear);
  return parts.join('; ');
}

function backgroundOf(meta) {
  const value = scanMetadata.normalizeBackground(meta && meta.capture && meta.capture.background);
  return value || null;
}

function resultLine(label, res, extra) {
  let line = '  ' + pad(label, 10) + pad(res.status, 15);
  if (res.measured) {
    line += 'L/R ' + fmt(res.lr) + '/' + fmt(100 - res.lr) + '  T/B ' + fmt(res.tb) + '/' + fmt(100 - res.tb) +
      '  CEN ' + fmt(res.cen);
    if (res.mm) {
      line += '  mm L' + fmt(res.mm.left, 2) + ' R' + fmt(res.mm.right, 2) + ' T' + fmt(res.mm.top, 2) + ' B' + fmt(res.mm.bottom, 2);
    }
  } else if (res.reason) {
    line += res.reason;
  }
  if (res.lowConfidenceEdges && res.lowConfidenceEdges.length) {
    line += '  low-confidence cut: ' + res.lowConfidenceEdges.join(', ');
  }
  if (res.borderVoteLowConfidenceEdges && res.borderVoteLowConfidenceEdges.length) {
    line += '  low-confidence border: ' + res.borderVoteLowConfidenceEdges.join(', ');
  }
  return line + (extra ? '  ' + extra : '');
}

/**
 * @param {{dataDir:string, uploadsDir?:string, candidateDir?:string, currentDir?:string}} opts
 */
async function buildDeckReport(opts) {
  const dataDir = path.resolve(opts.dataDir);
  const uploadsDir = path.resolve(opts.uploadsDir || path.join(dataDir, '..', 'uploads'));
  const store = deck.createStore(dataDir);
  const cards = store.loadDeck().cards;
  const labels = store.loadLabels().scans;
  const graded = dumpScans.loadGradedItems(dataDir);
  const failed = dumpScans.loadFailedEntries(dataDir);
  const byScan = new Map();
  graded.forEach(function (item) {
    byScan.set(String(item.scanId || item.id), {
      scanId: String(item.scanId || item.id), time: item.createdAt, item: item,
      engine: item.engine || (item.gradingReport && item.gradingReport.engineVersion
        ? { version: item.gradingReport.engineVersion } : null),
      result: resultFromReport(item.gradingReport),
      familyId: item.cardIdentity && item.cardIdentity.familyId,
      background: backgroundOf(item.captureMetadata),
      edgeMap: item.gradingReport && item.gradingReport.edgeMap || null,
      copyrightYear: item.gradingReport && item.gradingReport.copyrightYear || null
    });
  });
  failed.forEach(function (e) {
    const id = String(e.scanId);
    if (byScan.has(id)) return;
    byScan.set(id, {
      scanId: id, time: e.timestamp, item: null, engine: e.engine || null, familyId: null,
      background: backgroundOf(e.captureMetadata),
      result: { measured: false, status: 'card not found', reason: e.reason || 'card not found' }
    });
  });

  let candidate = null;
  if (opts.candidateDir) {
    const cmp = require('./compare_finders');
    candidate = {
      engine: cmp.loadEngine(opts.candidateDir),
      dir: path.resolve(opts.candidateDir),
      cmp: cmp
    };
  }

  const deckIds = new Set(Object.keys(cards));
  Object.keys(labels).forEach(function (sid) { if (labels[sid].deckId) deckIds.add(labels[sid].deckId); });
  const sortedIds = Array.from(deckIds).sort(function (a, b) {
    return Number(a.slice(3)) - Number(b.slice(3));
  });

  const lines = [];
  const rows = [];
  lines.push('# Test deck report · ' + sortedIds.length + ' deck cards · data=' + dataDir +
    (candidate ? ' · candidate=' + candidate.dir : ''));
  for (const deckId of sortedIds) {
    const card = cards[deckId] || { deckId: deckId };
    const cat = deck.DECK_CATEGORIES.find(function (c) { return c.id === card.category; });
    const expect = card.expect || (cat ? cat.expect : null);
    const scans = Object.keys(labels)
      .filter(function (sid) { return labels[sid].deckId === deckId && byScan.has(sid); })
      .map(function (sid) {
        const scan = byScan.get(sid);
        scan.side = labels[sid].side === 'back' ? 'back' : 'front';
        scan.pairId = labels[sid].pairId || null;
        return scan;
      })
      .sort(function (a, b) { return Date.parse(a.time) - Date.parse(b.time); });
    const frontScans = scans.filter(function (s) { return s.side !== 'back'; });
    const backScans = scans.filter(function (s) { return s.side === 'back'; });
    const latest = frontScans[frontScans.length - 1] || null;
    const latestBack = backScans[backScans.length - 1] || null;
    let previous = null;
    if (latest) {
      const latestVer = latest.engine && latest.engine.version;
      for (let i = frontScans.length - 2; i >= 0; i--) {
        const v = frontScans[i].engine && frontScans[i].engine.version;
        if (v !== latestVer) { previous = frontScans[i]; break; }
      }
    }
    const ruler = rulerRatios(card.physicalMm);
    lines.push('');
    const known = deck.resolveKnown(card);
    lines.push(deckId + '  ' + (card.category || 'uncategorized') + (card.title ? '  "' + card.title + '"' : '') +
      '  expect ' + (expect || '—') +
      (ruler ? '  ruler L/R ' + fmt(ruler.lr) + ' T/B ' + fmt(ruler.tb) : '') +
      (known ? '  known ' + deck.formatGradeShort(known) : ''));
    const row = { deckId: deckId, category: card.category || null, expect: expect, latest: null, previous: null, candidate: null, back: null };
    if (!latest && !latestBack) {
      lines.push('  not scanned yet');
      rows.push(row);
      continue;
    }
    if (latestBack) {
      row.back = {
        scanId: latestBack.scanId, result: latestBack.result, edgeMap: latestBack.edgeMap || null,
        copyrightYear: latestBack.copyrightYear || null
      };
    }
    if (!latest) {
      lines.push('  front not scanned');
      lines.push(resultLine('back', latestBack.result, backNote(latestBack)));
      lines.push('  ' + psaBackComparison(latestBack));
      rows.push(row);
      continue;
    }
    function describe(scan) {
      const pass = deck.judgeExpectation(expect, scan.result);
      const rulerNote = ruler && scan.result.measured
        ? 'ruler ΔL/R ' + signed(scan.result.lr - ruler.lr) + ' ΔT/B ' + signed(scan.result.tb - ruler.tb)
        : '';
      return { pass: pass, text: (pass == null ? '' : pass ? 'PASS' : 'FAIL') + (rulerNote ? '  ' + rulerNote : '') };
    }
    const l = describe(latest);
    row.latest = { scanId: latest.scanId, result: latest.result, pass: l.pass, engine: latest.engine };
    lines.push('  ' + localTime(latest.time) + '  ' + latest.scanId.slice(0, 8).toUpperCase() + '  ' + engineLabel(latest.engine) +
      '  family ' + (latest.familyId || '—') + '  (' + scans.length + ' scan' + (scans.length === 1 ? '' : 's') + ')' +
      '  background ' + (latest.background || 'unspecified'));
    lines.push(resultLine('latest', latest.result, l.text));
    if (previous) {
      const p = describe(previous);
      row.previous = { scanId: previous.scanId, result: previous.result, pass: p.pass, engine: previous.engine };
      lines.push(resultLine('previous', previous.result, p.text + '  ' + engineLabel(previous.engine) +
        ' · ' + previous.scanId.slice(0, 8).toUpperCase() +
        '  background ' + (previous.background || 'unspecified')));
    }
    if (latestBack) {
      lines.push(resultLine('back', latestBack.result, backNote(latestBack)));
      lines.push('  ' + psaBackComparison(latestBack));
    }
    if (candidate && latest.item && latest.item.imagePath) {
      const file = path.join(uploadsDir, path.basename(latest.item.imagePath));
      if (fs.existsSync(file)) {
        const q = candidate.cmp.quadOptions(latest.item.gradingReport);
        const report = await candidate.cmp.gradeQuietly(candidate.engine, fs.readFileSync(file), q.opts);
        const res = resultFromReport(report);
        const c = describe({ result: res });
        row.candidate = { result: res, pass: c.pass, engine: { version: report.engineVersion || '?' } };
        lines.push(resultLine('candidate', res, c.text + '  engine ' + (report.engineVersion || '?')));
      } else {
        lines.push('  candidate  upload missing: ' + file);
      }
    }
    rows.push(row);
  }

  lines.push('');
  lines.push('CATEGORY          cards scanned  latest pass' + (candidate ? '   candidate pass' : ''));
  const cats = deck.DECK_CATEGORIES.map(function (c) { return c.id; }).concat(['uncategorized']);
  const totals = { cards: 0, scanned: 0, pass: 0, judged: 0, cpass: 0, cjudged: 0 };
  const categories = {};
  cats.forEach(function (catId) {
    const inCat = rows.filter(function (r) { return (r.category || 'uncategorized') === catId; });
    if (!inCat.length) return;
    const scanned = inCat.filter(function (r) { return r.latest; });
    const judged = scanned.filter(function (r) { return r.latest.pass != null; });
    const passed = judged.filter(function (r) { return r.latest.pass; });
    const cj = inCat.filter(function (r) { return r.candidate && r.candidate.pass != null; });
    const cp = cj.filter(function (r) { return r.candidate.pass; });
    categories[catId] = { cards: inCat.length, scanned: scanned.length, pass: passed.length, judged: judged.length,
      candidatePass: cp.length, candidateJudged: cj.length };
    totals.cards += inCat.length; totals.scanned += scanned.length; totals.pass += passed.length;
    totals.judged += judged.length; totals.cpass += cp.length; totals.cjudged += cj.length;
    const rate = function (a, b) { return b ? a + '/' + b + ' ' + Math.round(100 * a / b) + '%' : '—'; };
    lines.push(pad(catId, 18) + pad(inCat.length, 6) + pad(scanned.length, 9) + pad(rate(passed.length, judged.length), 14) +
      (candidate ? rate(cp.length, cj.length) : ''));
  });
  const rateAll = function (a, b) { return b ? a + '/' + b + ' ' + Math.round(100 * a / b) + '%' : '—'; };
  lines.push(pad('OVERALL', 18) + pad(totals.cards, 6) + pad(totals.scanned, 9) + pad(rateAll(totals.pass, totals.judged), 14) +
    (candidate ? rateAll(totals.cpass, totals.cjudged) : ''));
  const lowCut = rows.filter(function (r) { return r.latest && (r.latest.result.lowConfidenceEdges || []).length; });
  lines.push('LOW-CONFIDENCE CUT  ' + lowCut.length + ' of ' + totals.scanned + ' latest scans' +
    (lowCut.length ? ': ' + lowCut.map(function (r) { return r.deckId + ' (' + r.latest.result.lowConfidenceEdges.join(', ') + ')'; }).join(', ') : ''));

  // Returned grades, one section per company. Scales are not combined.
  const groundTruth = groundTruthByGrader(labels, byScan);
  lines.push('');
  lines.push('GROUND TRUTH  by grading company (Judge predictions sit beside each result; scales are not combined)');
  const gradersPrinted = deck.GRADERS.filter(function (g) {
    return groundTruth[g].returned.length || groundTruth[g].awaiting;
  });
  if (groundTruth.unset) gradersPrinted.push('unset');
  if (!gradersPrinted.length) lines.push('  no returned grades and no pre-submission scans');
  gradersPrinted.forEach(function (g) {
    const bucket = g === 'unset' ? { returned: [], awaiting: groundTruth.unset } : groundTruth[g];
    lines.push(g + '  ' + bucket.returned.length + ' returned · ' + bucket.awaiting + ' pre-submission awaiting');
    bucket.returned.forEach(function (p) {
      const res = p.scan ? p.scan.result : null;
      lines.push('  ' + p.label.scanId.slice(0, 8).toUpperCase() + '  ' + pad(p.label.deckId || '—', 7) +
        deck.formatGradeShort(p.record));
      lines.push('    predicted (Judge scale)  ' + predictionText(res));
      const subLine = subgradeText(p.record, res);
      if (subLine) lines.push('    ' + subLine);
      if (p.record.grader === 'PSA' && p.record.qualifiers && p.record.qualifiers.indexOf('OC') !== -1) {
        lines.push('    OC vs centering: slab OC; ' + ocPrediction(res));
      }
    });
  });
  const pending = deck.GRADERS.reduce(function (n, g) { return n + groundTruth[g].awaiting; }, 0) + groundTruth.unset;

  return {
    text: lines.join('\n'), rows: rows, categories: categories,
    psa: groundTruth.PSA.returned.length, pending: pending, groundTruth: groundTruth,
    lowConfidenceCut: lowCut.map(function (r) { return { deckId: r.deckId, edges: r.latest.result.lowConfidenceEdges }; })
  };
}

function groundTruthByGrader(labels, byScan) {
  const deck = require('../services/test_deck');
  const out = { unset: 0 };
  deck.GRADERS.forEach(function (g) { out[g] = { returned: [], awaiting: 0 }; });
  Object.keys(labels).forEach(function (sid) {
    const label = labels[sid];
    const record = deck.resolveResult(label);
    if (deck.hasGradeResult(record)) {
      const g = deck.GRADERS.indexOf(record.grader) === -1 ? 'Other' : record.grader;
      out[g].returned.push({ label: label, record: record, scan: byScan.get(label.scanId) || null });
      return;
    }
    if (!label.preSubmission) return;
    const intended = label.intendedGrader && deck.GRADERS.indexOf(label.intendedGrader) !== -1 ? label.intendedGrader : null;
    if (intended) out[intended].awaiting += 1;
    else out.unset += 1;
  });
  deck.GRADERS.forEach(function (g) {
    out[g].returned.sort(function (a, b) {
      const da = a.label.deckId || '';
      const db = b.label.deckId || '';
      if (da !== db) return da < db ? -1 : 1;
      return String(a.label.scanId).localeCompare(String(b.label.scanId));
    });
  });
  return out;
}

function predictionText(res) {
  if (!res) return 'no saved grade';
  const final = 'final ' + fmt(res.finalScore) + '  CEN ' + fmt(res.cen);
  if (!res.measured) return final + '  centering —';
  return final + '  L/R ' + fmt(res.lr) + '/' + fmt(100 - res.lr) + '  T/B ' + fmt(res.tb) + '/' + fmt(100 - res.tb);
}

function subgradeText(record, res) {
  const sub = record.subgrades || {};
  const keys = [['centering', 'CEN', res && res.cen], ['corners', 'CRN', res && res.corners], ['edges', 'EDG', res && res.edges], ['surface', 'SUR', res && res.surface]];
  const any = keys.some(function (k) { return sub[k[0]] != null; });
  if (!any) return null;
  return 'sub-grades  ' + keys.map(function (k) {
    return k[1] + ' slab ' + fmt(sub[k[0]]) + ' / predicted ' + fmt(k[2]);
  }).join('  ');
}

function ocPrediction(res) {
  if (!res || !res.measured || res.worstShare == null) return 'predicted centering —';
  const caught = res.worstShare > 60;
  return 'predicted worst share ' + fmt(res.worstShare) + (caught ? ' (off-center)' : ' (not past 60/40)');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = function (name) { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
  const dataDir = opt('data') || process.env.JUDGE_DATA_DIR || path.join(__dirname, '..', 'data');
  buildDeckReport({ dataDir: dataDir, uploadsDir: opt('uploads'), candidateDir: opt('candidate') })
    .then(function (out) { console.log(out.text); })
    .catch(function (err) { console.error('deck_report failed:', err && err.stack ? err.stack : err); process.exit(1); });
}

module.exports = { buildDeckReport, resultFromReport };
