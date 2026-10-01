#!/usr/bin/env node
/**
 * scripts/dump_scans.js
 * Compact per-scan centering dump from data/database.json (graded scans)
 * and data/failed_scans.jsonl (card not found), newest N, oldest first.
 *
 * Usage:
 *   node scripts/dump_scans.js            # last 10, oldest first
 *   node scripts/dump_scans.js 25         # last 25
 *   node scripts/dump_scans.js 10 8260d8  # only scanIds starting with 8260d8
 *   node scripts/dump_scans.js --deck TD-01
 *                                         # every scan of that deck card, including
 *                                         # ones outside the last-N window
 *   node scripts/dump_scans.js --audit BF3F8126 DD872A45
 *                                         # duplicates + where each id lives
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
    const prof = diag.edgeProfiles && diag.edgeProfiles[edge];
    const head = prof ? 'profile ' + num(prof.profileWidth) + ' trig ' + num(prof.trigger) + ' | ' : '';
    return head + lines.map(function (l) {
      const pos = l.pos == null ? 'x' : num(l.pos) + (l.inGroup === false ? '!' : '');
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

function metadataLines(cap, srv) {
  const out = [];
  if (cap) {
    const d = cap.device || {};
    const a = cap.app || {};
    const c = cap.camera || {};
    const k = cap.capture || {};
    const dims = function (w, h) { return w && h ? w + '×' + h : '—'; };
    const shutter = typeof c.exposureDurationS === 'number' && c.exposureDurationS > 0
      ? (c.exposureDurationS < 1 ? '1/' + Math.round(1 / c.exposureDurationS) : c.exposureDurationS.toFixed(1)) + 's'
      : null;
    out.push('capture ' + (d.model || '—') + ' ' + (d.systemName || '') + ' ' + (d.systemVersion || '') +
      '  app ' + (a.version || '—') + (a.build ? ' (' + a.build + ')' : '') +
      '  photo ' + dims(c.photoWidth, c.photoHeight) + ' of max ' + dims(c.maxPhotoWidth, c.maxPhotoHeight) +
      ' (' + (c.photoSizeSetting || '—') + ', ' + (c.codec || '—') + ')' +
      (c.iso != null ? '  ISO ' + Math.round(c.iso) : '') + (shutter ? ' ' + shutter : '') +
      (c.zoomFactor != null ? '  zoom ' + num(c.zoomFactor, 2) : '') + (k.mode ? '  ' + k.mode : '') +
      '  background ' + (k.background || 'unspecified'));
  }
  if (srv) {
    const img = srv.image || {};
    out.push('server  ' + (srv.uploadBytes != null ? (srv.uploadBytes / 1e6).toFixed(2) + ' MB' : '—') +
      ' ' + (img.format || '?') + ' ' + (img.width && img.height ? img.width + '×' + img.height : '—') +
      (img.orientation ? ' orient ' + img.orientation : '') +
      '  grade ' + (srv.gradeMs != null ? srv.gradeMs + 'ms' : '—') +
      (srv.uploadSha256 ? '  sha ' + srv.uploadSha256.slice(0, 12) : '') +
      (srv.localNetwork === true ? '  LAN' : srv.localNetwork === false ? '  remote' : '') +
      (srv.captureMetadataError ? '  (' + srv.captureMetadataError + ')' : ''));
  }
  return out;
}

function sidePair(entry) {
  const side = entry && entry.side ? '  ' + entry.side : '';
  const pair = entry && entry.pairId ? '  pair ' + entry.pairId : '';
  return side + pair;
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
    (item.deckId ? '  deck ' + item.deckId : '') +
    sidePair(item) +
    (item.engine ? '  engine ' + item.engine.version + (item.engine.commit ? ' (' + item.engine.commit + ')' : '') : '') +
    (tilt ? '  tilt P ' + num(tilt.pitchDeg) + '° R ' + num(tilt.rollDeg) + '°' : ''));
  metadataLines(item.captureMetadata, item.serverMetadata).forEach(function (l) { out.push(l); });
  detectionBlock(r.cardDetection).forEach(function (l) { out.push(l); });
  out.push('borders L ' + num(w.left) + '  R ' + num(w.right) + '  T ' + num(w.top) + '  B ' + num(w.bottom) +
    ' px   spread L/R ' + num(diag.leftRightSampleSpreadPx) + '  T/B ' + num(diag.topBottomSampleSpreadPx) +
    '   hint ' + (diag.hint || '—'));
  const mmW = m.borderWidthsMm;
  const cw = m.centeringWarp;
  if (mmW || cw) {
    out.push('        mm L ' + num(mmW && mmW.left, 2) + '  R ' + num(mmW && mmW.right, 2) + '  T ' +
      num(mmW && mmW.top, 2) + '  B ' + num(mmW && mmW.bottom, 2) +
      (cw ? '   centering warp ' + cw.width + '×' + cw.height + ' (' + cw.pxPerMm + ' px/mm, ' + cw.mode + ')' : ''));
  }
  ['top', 'bottom', 'left', 'right'].forEach(function (edge) {
    out.push('  ' + edge.padEnd(6) + ' ' + edgeLines(diag, edge));
  });
  out.push('result  L/R ' + ratio(m.leftRightRatio, 'left', 'right') +
    '  T/B ' + ratio(m.topBottomRatio, 'top', 'bottom') +
    '  CEN ' + num(sub.centering) + '  SUR ' + num(sub.surface) + '  EDG ' + num(sub.edges) +
    '  CRN ' + num(sub.corners) + '  final ' + num(r.finalScore));
  if (diag.edgeFlags && diag.edgeFlags.length) out.push('flags   ' + diag.edgeFlags.join('; '));
  const reasons = diag.borderReliability && diag.borderReliability.reasons;
  if (reasons && reasons.length) out.push('reject  ' + reasons.join('; '));
  return out.join('\n');
}

function formatFailed(entry) {
  const id = String(entry.scanId || '');
  const out = [];
  out.push('── ' + id.slice(0, 8).toUpperCase() + '  ' + localTime(entry.timestamp) + '  CARD NOT FOUND  ' + id +
    (entry.deckId ? '  deck ' + entry.deckId : '') + sidePair(entry));
  metadataLines(entry.captureMetadata, entry.serverMetadata).forEach(function (l) { out.push(l); });
  detectionBlock(entry.diagnostics).forEach(function (l) { out.push(l); });
  out.push('reject  ' + (entry.reason || '—'));
  return out.join('\n');
}

function timeOf(iso) {
  const t = Date.parse(iso);
  return isFinite(t) ? t : 0;
}

function idOf(entry) {
  return String((entry && (entry.scanId || entry.id)) || '').toLowerCase();
}

/**
 * One record per scanId (the latest if database.json holds repeats), sorted
 * oldest → newest with scanId as the tie-break so the order is stable.
 */
function dedupeSorted(entries, timeKey) {
  const byId = new Map();
  entries.forEach(function (e) {
    const id = idOf(e);
    const prev = byId.get(id);
    if (!prev || timeOf(e[timeKey]) >= timeOf(prev[timeKey])) byId.set(id, e);
  });
  return Array.from(byId.values()).sort(function (x, y) {
    const d = timeOf(x[timeKey]) - timeOf(y[timeKey]);
    return d !== 0 ? d : (idOf(x) < idOf(y) ? -1 : idOf(x) > idOf(y) ? 1 : 0);
  });
}

/** Graded inventory records, deduped by scanId, oldest → newest. */
function loadGradedItems(dataDir) {
  const db = readJson(path.join(dataDir, 'database.json'), { inventory: [] });
  return dedupeSorted(db.inventory || [], 'createdAt');
}

function loadFailedEntries(dataDir) {
  return dedupeSorted(readJsonl(path.join(dataDir, 'failed_scans.jsonl')), 'timestamp');
}

function loadLabelMap(dataDir) {
  const raw = readJson(path.join(dataDir, 'scan_labels.json'), { scans: {} });
  const scans = raw.scans || {};
  const byId = {};
  Object.keys(scans).forEach(function (key) { byId[String(key).toLowerCase()] = scans[key]; });
  return byId;
}

function labelOf(entry, labels) {
  return labels && labels[idOf(entry)] || null;
}

function deckIdOf(entry, labels) {
  if (entry && entry.deckId) return String(entry.deckId).toUpperCase();
  const lab = labelOf(entry, labels);
  return lab && lab.deckId ? String(lab.deckId).toUpperCase() : '';
}

function applyLabelFields(entry, labels) {
  const lab = labelOf(entry, labels);
  if (!lab) return entry;
  if (!entry.deckId && lab.deckId) entry.deckId = lab.deckId;
  if (!entry.side && lab.side) entry.side = lab.side;
  if (!entry.pairId && lab.pairId) entry.pairId = lab.pairId;
  return entry;
}

function formatScans(dataDir, count, idPrefix, deckId) {
  const labels = loadLabelMap(dataDir);
  const graded = loadGradedItems(dataDir).map(function (item) {
    applyLabelFields(item, labels);
    return {
      time: timeOf(item.createdAt), id: idOf(item), deck: deckIdOf(item, labels),
      text: function () { return formatGraded(item); }
    };
  });
  const gradedIds = new Set(graded.map(function (g) { return g.id; }));
  const failed = loadFailedEntries(dataDir)
    .filter(function (entry) { return !gradedIds.has(idOf(entry)); })
    .map(function (entry) {
      applyLabelFields(entry, labels);
      return {
        time: timeOf(entry.timestamp), id: idOf(entry), deck: deckIdOf(entry, labels),
        text: function () { return formatFailed(entry); }
      };
    });
  let all = graded.concat(failed);
  if (idPrefix) {
    const p = String(idPrefix).toLowerCase();
    all = all.filter(function (e) { return e.id.indexOf(p) === 0; });
  }
  const wantDeck = deckId ? String(deckId).toUpperCase() : '';
  if (wantDeck) all = all.filter(function (e) { return e.deck === wantDeck; });
  all.sort(function (a, b) { return a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  const picked = wantDeck ? all : all.slice(-count);
  if (!picked.length) return 'No scans found in ' + dataDir + (wantDeck ? ' for ' + wantDeck : '');
  const header = '# ' + picked.length + (wantDeck ? ' ' + wantDeck : ' most recent') +
    ' of ' + all.length + ' scans, oldest first · ' + dataDir;
  return header + '\n\n' + picked.map(function (e) { return e.text(); }).join('\n\n');
}

/**
 * Where does each record live, and does database.json hold repeats?
 * `ids` are scanId prefixes (8 hex chars from the phone are enough).
 */
function auditScans(dataDir, ids, dirs) {
  const uploadsDir = (dirs && dirs.uploadsDir) || path.join(dataDir, '..', 'uploads');
  const scansDir = (dirs && dirs.scansDir) || path.join(dataDir, '..', 'scans');
  const db = readJson(path.join(dataDir, 'database.json'), null);
  const inv = (db && db.inventory) || [];
  const failed = readJsonl(path.join(dataDir, 'failed_scans.jsonl'));
  const out = [];
  out.push('database.json  ' + path.join(dataDir, 'database.json') + (db ? '' : '  (missing or unreadable)'));
  const counts = new Map();
  inv.forEach(function (e) { const id = idOf(e); counts.set(id, (counts.get(id) || 0) + 1); });
  const dups = Array.from(counts.entries()).filter(function (kv) { return kv[1] > 1; });
  out.push('records ' + inv.length + ' · unique scanIds ' + counts.size + ' · duplicated ' + dups.length +
    ' · without scanId ' + inv.filter(function (e) { return !e.scanId; }).length);
  dups.forEach(function (kv) {
    const times = inv.filter(function (e) { return idOf(e) === kv[0]; }).map(function (e) { return e.createdAt; });
    out.push('  duplicate ' + kv[0] + ' ×' + kv[1] + '  ' + times.join(', '));
  });
  let lastTime = Infinity;
  let outOfOrder = 0;
  inv.forEach(function (e) { const t = timeOf(e.createdAt); if (t > lastTime) outOfOrder += 1; lastTime = t; });
  out.push('stored order: ' + (outOfOrder ? outOfOrder + ' record(s) newer than the one before them (file is not newest-first)' : 'newest-first as written'));
  out.push('failed_scans.jsonl lines ' + failed.length);
  (ids || []).forEach(function (raw) {
    const p = String(raw).toLowerCase();
    const inDb = inv.filter(function (e) { return idOf(e).indexOf(p) === 0; });
    const inFailed = failed.filter(function (e) { return idOf(e).indexOf(p) === 0; });
    const full = inDb.length ? idOf(inDb[0]) : inFailed.length ? idOf(inFailed[0]) : null;
    const upload = inDb.length && inDb[0].imagePath ? path.join(uploadsDir, path.basename(inDb[0].imagePath)) : null;
    out.push('');
    out.push(String(raw).toUpperCase() + '  scanId ' + (full || 'not found'));
    out.push('  database.json ×' + inDb.length + (inDb.length ? '  ' + inDb.map(function (e) { return e.createdAt; }).join(', ') : ''));
    out.push('  failed_scans.jsonl ×' + inFailed.length);
    out.push('  upload ' + (upload ? upload + (fs.existsSync(upload) ? ' (present)' : ' (MISSING)') : '—'));
    const scanDirMatch = fs.existsSync(scansDir)
      ? fs.readdirSync(scansDir).filter(function (d) { return d.toLowerCase().indexOf(p) === 0; })
      : [];
    out.push('  scans/ ' + (scanDirMatch.length ? scanDirMatch.join(', ') : '—'));
  });
  return out.join('\n');
}

/** Exact-id block for one scan (graded or card-not-found), or null. */
function formatScanById(dataDir, scanId) {
  const id = String(scanId || '').toLowerCase();
  if (!id) return null;
  const db = readJson(path.join(dataDir, 'database.json'), { inventory: [] });
  const matches = dedupeSorted((db.inventory || []).filter(function (it) { return idOf(it) === id; }), 'createdAt');
  const item = matches[matches.length - 1];
  if (item) return formatGraded(item);
  const failed = loadFailedEntries(dataDir).filter(function (e) { return idOf(e) === id; });
  return failed.length ? formatFailed(failed[failed.length - 1]) : null;
}

function parseDumpArgs(argv) {
  const out = { deck: null, audit: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--audit') { out.audit = true; continue; }
    if (argv[i] === '--deck') { out.deck = argv[i + 1] || ''; i += 1; continue; }
    out.rest.push(argv[i]);
  }
  return out;
}

if (require.main === module) {
  const dataDir = process.env.JUDGE_DATA_DIR || path.join(__dirname, '..', 'data');
  const args = parseDumpArgs(process.argv.slice(2));
  if (args.audit) {
    console.log(auditScans(dataDir, args.rest));
  } else {
    const count = Number(args.rest[0]) > 0 ? Number(args.rest[0]) : 10;
    const idPrefix = args.rest[1] || null;
    console.log(formatScans(dataDir, count, idPrefix, args.deck));
  }
}

module.exports = {
  formatScans, formatScanById, formatGraded, formatFailed,
  loadGradedItems, loadFailedEntries, auditScans
};
