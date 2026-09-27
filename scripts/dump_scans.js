#!/usr/bin/env node
/**
 * scripts/dump_scans.js
 * Compact per-scan centering dump from data/database.json (graded scans)
 * and data/failed_scans.jsonl (card not found), newest N, oldest first.
 *
 * Usage:
 *   node scripts/dump_scans.js            # last 10
 *   node scripts/dump_scans.js 25         # last 25
 *   node scripts/dump_scans.js 10 8260d8  # only scanIds starting with 8260d8
 *   JUDGE_DATA_DIR=/other/data node scripts/dump_scans.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(function (line) {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(Boolean);
}

function num(v, digits) {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return '—';
  return v.toFixed(digits == null ? 1 : digits);
}

function signed(v) {
  if (v == null || typeof v !== 'number') return '?';
  return (v > 0 ? '+' : '') + v;
}

function pt(p) {
  return p ? '(' + Math.round(p[0]) + ',' + Math.round(p[1]) + ')' : '(—)';
}

function quadLine(q) {
  if (!q) return '—';
  return 'tl' + pt(q.tl) + ' tr' + pt(q.tr) + ' br' + pt(q.br) + ' bl' + pt(q.bl);
}

function ratio(r, a, b) {
  return r ? num(r[a]) + '/' + num(r[b]) : '—';
}

function localTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '—');
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function edgeLines(diag, edge) {
  const lines = diag && diag.sampleLines && diag.sampleLines[edge];
  if (Array.isArray(lines)) {
    return lines.map(function (l) {
      const pos = l.pos == null ? 'x' : num(l.pos);
      return '@' + l.at + ' ' + pos + '/t' + (l.threshold == null ? '?' : l.threshold);
    }).join('  ');
  }
  const sorted = diag && diag.samples && diag.samples[edge];
  return 'sorted hits [' + (sorted || []).map(function (v) { return num(v); }).join(', ') +
    '] (per-line order not recorded for this scan)';
}

function detectionBlock(det) {
  const out = [];
  if (!det) {
    out.push('quad    — (no cardDetection on this record)');
    return out;
  }
  const conf = det.nativeQuadConfidence != null ? ' conf ' + num(det.nativeQuadConfidence, 2) : '';
  const size = det.cardSizePx ? '  card ' + det.cardSizePx.widthPx + '×' + det.cardSizePx.heightPx + ' px' : '';
  const refine = det.edgeRefinementPx
    ? '  tighten L' + signed(det.edgeRefinementPx.left) + ' R' + signed(det.edgeRefinementPx.right) +
      ' T' + signed(det.edgeRefinementPx.top) + ' B' + signed(det.edgeRefinementPx.bottom) + ' (warp px)'
    : '';
  out.push('quad    ' + det.quadSource + conf + '  card box ' +
    (det.cardBoxPctOfPhoto != null ? det.cardBoxPctOfPhoto + '%' : '—') + size +
    '  upload ' + det.photoWidth + '×' + det.photoHeight + refine);
  const raw = det.rawQuad || det.nativeQuadRaw || det.serverQuadRaw;
  out.push('  raw   ' + (raw ? quadLine(raw) : '— (raw quad not logged for this scan)'));
  out.push('  tight ' + quadLine(det.quad));
  if (det.nativeQuadRejected) out.push('  native rejected: ' + det.nativeQuadRejected.join('; '));
  if (det.serverQuadRejected && det.quadSource !== 'server') {
    out.push('  server rejected: ' + det.serverQuadRejected.join('; '));
  }
  return out;
}

function formatGraded(item) {
  const r = item.gradingReport || {};
  const diag = r.centeringDiagnostics || {};
  const w = diag.printBorderWidths || {};
  const m = r.centeringMetrics || {};
  const sub = r.subGrades || {};
  const id = String(item.scanId || item.id || '');
  const tilt = r.captureTilt;
  const out = [];
  out.push('── ' + id.slice(0, 8).toUpperCase() + '  ' + localTime(item.createdAt) + '  graded  ' + id +
    (tilt ? '  tilt P ' + num(tilt.pitchDeg) + '° R ' + num(tilt.rollDeg) + '°' : ''));
  detectionBlock(r.cardDetection).forEach(function (l) { out.push(l); });
  out.push('borders L ' + num(w.left) + '  R ' + num(w.right) + '  T ' + num(w.top) + '  B ' + num(w.bottom) +
    ' px   spread L/R ' + num(diag.leftRightSampleSpreadPx) + '  T/B ' + num(diag.topBottomSampleSpreadPx) +
    '   hint ' + (diag.hint || '—'));
  ['top', 'bottom', 'left', 'right'].forEach(function (edge) {
    out.push('  ' + edge.padEnd(6) + ' ' + edgeLines(diag, edge));
  });
  out.push('result  L/R ' + ratio(m.leftRightRatio, 'left', 'right') +
    '  T/B ' + ratio(m.topBottomRatio, 'top', 'bottom') +
    '  CEN ' + num(sub.centering) + '  SUR ' + num(sub.surface) + '  EDG ' + num(sub.edges) +
    '  CRN ' + num(sub.corners) + '  final ' + num(r.finalScore));
  const reasons = diag.borderReliability && diag.borderReliability.reasons;
  if (reasons && reasons.length) out.push('reject  ' + reasons.join('; '));
  return out.join('\n');
}

function formatFailed(entry) {
  const id = String(entry.scanId || '');
  const out = [];
  out.push('── ' + id.slice(0, 8).toUpperCase() + '  ' + localTime(entry.timestamp) + '  CARD NOT FOUND  ' + id);
  detectionBlock(entry.diagnostics).forEach(function (l) { out.push(l); });
  out.push('reject  ' + (entry.reason || '—'));
  return out.join('\n');
}

function formatScans(dataDir, count, idPrefix) {
  const db = readJson(path.join(dataDir, 'database.json'), { inventory: [] });
  const graded = (db.inventory || []).map(function (item) {
    return { time: Date.parse(item.createdAt) || 0, id: String(item.scanId || item.id || ''), text: function () { return formatGraded(item); } };
  });
  const failed = readJsonl(path.join(dataDir, 'failed_scans.jsonl')).map(function (entry) {
    return { time: Date.parse(entry.timestamp) || 0, id: String(entry.scanId || ''), text: function () { return formatFailed(entry); } };
  });
  let all = graded.concat(failed);
  if (idPrefix) {
    const p = idPrefix.toLowerCase();
    all = all.filter(function (e) { return e.id.toLowerCase().indexOf(p) === 0; });
  }
  all.sort(function (a, b) { return b.time - a.time; });
  const picked = all.slice(0, count).reverse();
  if (!picked.length) return 'No scans found in ' + dataDir;
  return picked.map(function (e) { return e.text(); }).join('\n\n');
}

/** Exact-id block for one scan (graded or card-not-found), or null. */
function formatScanById(dataDir, scanId) {
  const id = String(scanId || '').toLowerCase();
  if (!id) return null;
  const db = readJson(path.join(dataDir, 'database.json'), { inventory: [] });
  const item = (db.inventory || []).find(function (it) {
    return String(it.scanId || it.id || '').toLowerCase() === id;
  });
  if (item) return formatGraded(item);
  const failed = readJsonl(path.join(dataDir, 'failed_scans.jsonl')).filter(function (e) {
    return String(e.scanId || '').toLowerCase() === id;
  });
  return failed.length ? formatFailed(failed[failed.length - 1]) : null;
}

if (require.main === module) {
  const count = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 10;
  const idPrefix = process.argv[3] || null;
  const dataDir = process.env.JUDGE_DATA_DIR || path.join(__dirname, '..', 'data');
  console.log(formatScans(dataDir, count, idPrefix));
}

module.exports = { formatScans, formatScanById, formatGraded, formatFailed };
