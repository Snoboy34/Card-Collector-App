#!/usr/bin/env node
/**
 * scripts/compare_finders.js
 * Re-grade the last N saved scans with two border finders side by side:
 *   --current   checkout whose services/grading_engine.js is live (the iMac server)
 *   --candidate checkout to compare (default: this script's own checkout)
 * Uses each scan's stored upload and saved quad. Read-only: no scanId or
 * scans root is passed, so neither engine writes debug artifacts, and
 * database.json / failed_scans.jsonl are only read.
 *
 * Usage:
 *   node scripts/compare_finders.js --current /path/to/live/checkout \
 *     [--candidate /path/to/stage-c] [--n 10] [--data DIR] [--uploads DIR] \
 *     [--ruler-lr 57.1] [--ruler-tb 46.2]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const dumpScans = require('./dump_scans');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}

function fmt(v, d) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(d == null ? 1 : d) : '—';
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

function loadEngine(dir) {
  const file = path.resolve(dir, 'services', 'grading_engine.js');
  if (!fs.existsSync(file)) throw new Error('no services/grading_engine.js under ' + dir);
  return require(file);
}

function quadOptions(report) {
  const det = report && report.cardDetection;
  if (!det || det.quadSource === 'server' || det.quadSource === 'none') {
    return { opts: {}, label: det ? det.quadSource + ' (re-detected)' : 'none recorded (server re-detects)' };
  }
  const quad = det.rawQuad || det.nativeQuadRaw || det.quad;
  if (!quad) return { opts: {}, label: 'no quad stored (server re-detects)' };
  const which = det.rawQuad || det.nativeQuadRaw ? 'raw' : 'tightened';
  return {
    opts: {
      cardQuad: JSON.stringify(quad),
      quadImageWidth: det.photoWidth,
      quadImageHeight: det.photoHeight,
      quadConfidence: det.nativeQuadConfidence
    },
    label: det.quadSource + ' (' + which + ' quad)'
  };
}

async function gradeQuietly(engine, buffer, opts) {
  const log = console.log;
  const warn = console.warn;
  console.log = function () {};
  console.warn = function () {};
  try {
    return await engine.gradeBuffer(buffer, Object.assign({ alignmentCrop: true, debug: false }, opts));
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function summarizeRun(report) {
  const diag = (report && report.centeringDiagnostics) || {};
  const w = diag.printBorderWidths || {};
  const m = (report && report.centeringMetrics) || {};
  const reasons = [];
  if (report && report.cardNotFound) reasons.push('card not found: ' + report.cardNotFoundReason);
  const rel = diag.borderReliability && diag.borderReliability.reasons;
  if (rel && rel.length) reasons.push.apply(reasons, rel);
  return {
    widths: w,
    lr: m.leftRightRatio ? m.leftRightRatio.left : null,
    tb: m.topBottomRatio ? m.topBottomRatio.top : null,
    cen: report && report.subGrades ? report.subGrades.centering : null,
    mm: m.borderWidthsMm || null,
    warp: m.centeringWarp || null,
    reasons: reasons,
    flags: diag.edgeFlags || []
  };
}

function rowText(name, r) {
  const w = r.widths;
  const lr = r.lr == null ? '—' : fmt(r.lr) + '/' + fmt(100 - r.lr);
  const tb = r.tb == null ? '—' : fmt(r.tb) + '/' + fmt(100 - r.tb);
  let line = pad(name, 10) + pad(fmt(w.left), 7) + pad(fmt(w.right), 7) + pad(fmt(w.top), 7) +
    pad(fmt(w.bottom), 7) + pad(lr, 12) + pad(tb, 12) + pad(fmt(r.cen), 5);
  if (r.warp) line += pad(r.warp.width + '×' + r.warp.height, 11);
  if (r.reasons.length) line += 'reject: ' + r.reasons.join('; ');
  else if (r.flags.length) line += 'flags: ' + r.flags.join('; ');
  return line;
}

function spreadStats(values, ruler) {
  const v = values.filter(function (x) { return x != null; });
  if (!v.length) return { n: 0, text: '—' };
  const min = Math.min.apply(null, v);
  const max = Math.max.apply(null, v);
  const mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
  let text = fmt(min) + '–' + fmt(max) + ' (spread ' + fmt(max - min) + ', mean ' + fmt(mean) + ')';
  if (ruler != null) text += ', mean − ruler ' + (mean - ruler >= 0 ? '+' : '') + fmt(mean - ruler);
  return { n: v.length, min: min, max: max, spread: max - min, mean: mean, text: text };
}

async function compareFinders(options) {
  const currentDir = path.resolve(options.currentDir);
  const candidateDir = path.resolve(options.candidateDir || path.join(__dirname, '..'));
  const dataDir = path.resolve(options.dataDir || path.join(currentDir, 'data'));
  const uploadsDir = path.resolve(options.uploadsDir || path.join(currentDir, 'uploads'));
  const n = options.n || 10;
  const current = loadEngine(currentDir);
  const candidate = loadEngine(candidateDir);
  const items = dumpScans.loadGradedItems(dataDir).slice(-n);

  const lines = [];
  const results = [];
  lines.push('compare_finders  current=' + currentDir + '  candidate=' + candidateDir);
  lines.push('data=' + dataDir + '  uploads=' + uploadsDir + '  scans=' + items.length);
  for (const item of items) {
    const id = String(item.scanId || item.id || '');
    const report = item.gradingReport || {};
    const file = item.imagePath ? path.join(uploadsDir, path.basename(item.imagePath)) : null;
    lines.push('');
    if (!file || !fs.existsSync(file)) {
      lines.push('── ' + id.slice(0, 8).toUpperCase() + '  ' + (item.createdAt || '') + '  upload missing: ' + (file || '—'));
      results.push({ scanId: id, skipped: 'upload missing' });
      continue;
    }
    const buffer = fs.readFileSync(file);
    const q = quadOptions(report);
    const a = summarizeRun(await gradeQuietly(current, buffer, q.opts));
    const b = summarizeRun(await gradeQuietly(candidate, buffer, q.opts));
    lines.push('── ' + id.slice(0, 8).toUpperCase() + '  ' + (item.createdAt || '') + '  quad ' + q.label);
    lines.push(pad('', 10) + pad('L', 7) + pad('R', 7) + pad('T', 7) + pad('B', 7) + pad('L/R', 12) + pad('T/B', 12) + pad('CEN', 5) + 'warp');
    lines.push(rowText('current', a));
    lines.push(rowText('candidate', b));
    results.push({ scanId: id, current: a, candidate: b });
  }

  const graded = results.filter(function (r) { return !r.skipped; });
  const rulerLr = options.rulerLr != null ? Number(options.rulerLr) : null;
  const rulerTb = options.rulerTb != null ? Number(options.rulerTb) : null;
  lines.push('');
  lines.push('SUMMARY (' + graded.length + ' scans re-graded' +
    (results.length - graded.length ? ', ' + (results.length - graded.length) + ' skipped' : '') + ')');
  ['current', 'candidate'].forEach(function (name) {
    const lr = spreadStats(graded.map(function (r) { return r[name].lr; }), rulerLr);
    const tb = spreadStats(graded.map(function (r) { return r[name].tb; }), rulerTb);
    lines.push(pad(name, 10) + 'measured ' + lr.n + '/' + graded.length +
      '   L/R left ' + lr.text + '   T/B top ' + tb.text);
  });
  return { text: lines.join('\n'), results: results };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.current) {
    console.error('usage: node scripts/compare_finders.js --current <live checkout> [--candidate <checkout>] [--n 10] [--ruler-lr 57.1] [--ruler-tb 46.2]');
    process.exit(2);
  }
  compareFinders({
    currentDir: args.current,
    candidateDir: args.candidate,
    dataDir: args.data,
    uploadsDir: args.uploads,
    n: Number(args.n) > 0 ? Number(args.n) : 10,
    rulerLr: args['ruler-lr'],
    rulerTb: args['ruler-tb']
  }).then(function (out) {
    console.log(out.text);
  }).catch(function (err) {
    console.error('compare_finders failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { compareFinders, loadEngine, quadOptions, gradeQuietly, summarizeRun };
