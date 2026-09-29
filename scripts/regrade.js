#!/usr/bin/env node
/**
 * scripts/regrade.js
 * Re-grade saved uploads with one engine and APPEND the results to that
 * engine's own history file:
 *   <data>/regrades/<ENGINE_VERSION>@<commit>.jsonl
 * One line per scan. A scan already in the file is never graded or written
 * again, so re-running only adds new scans; existing lines are never
 * rewritten or reordered. database.json and uploads are only read, and no
 * debug artifacts are written. An engine with uncommitted edits under
 * services/ gets "<commit>-dirty" so it never shares a file with the
 * committed engine.
 *
 * Usage:
 *   node scripts/regrade.js --app /path/to/live/checkout [--engine DIR] [--n 50] [--id PREFIX] [--summary-only]
 *   node scripts/regrade.js --app DIR --list          # history files and line counts
 */
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const dumpScans = require('./dump_scans');
const compare = require('./compare_finders');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i += 1; }
  }
  return out;
}

function git(dir, args) {
  try {
    return childProcess.execSync('git ' + args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { return null; }
}

function engineStamp(engineDir, engine) {
  let commit = process.env.JUDGE_ENGINE_COMMIT || git(engineDir, 'rev-parse --short HEAD') || 'nocommit';
  const dirty = git(engineDir, 'status --porcelain --untracked-files=no -- services');
  if (dirty) commit += '-dirty';
  return { version: engine.ENGINE_VERSION || 'unknown', commit: commit };
}

function historyFile(regradeDir, stamp) {
  const safe = function (s) { return String(s).replace(/[^0-9A-Za-z._-]/g, '_'); };
  return path.join(regradeDir, safe(stamp.version) + '@' + safe(stamp.commit) + '.jsonl');
}

function readIds(file) {
  const ids = new Set();
  if (!fs.existsSync(file)) return ids;
  fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
    if (!line.trim()) return;
    try { const r = JSON.parse(line); if (r.scanId) ids.add(String(r.scanId)); } catch (e) { /* keep going */ }
  });
  return ids;
}

function summarize(report) {
  const m = report.centeringMetrics || {};
  const diag = report.centeringDiagnostics || {};
  return {
    cardNotFound: Boolean(report.cardNotFound),
    reason: report.cardNotFound ? report.cardNotFoundReason : (report.incomplete ? report.incompleteReason || null : null),
    lr: m.leftRightRatio ? m.leftRightRatio.left : null,
    tb: m.topBottomRatio ? m.topBottomRatio.top : null,
    borderWidthsMm: m.borderWidthsMm || null,
    lowConfidenceEdges: m.lowConfidenceEdges || [],
    subGrades: report.subGrades || null,
    finalScore: report.finalScore == null ? null : report.finalScore,
    edgeFlags: diag.edgeFlags || []
  };
}

async function regrade(options) {
  const engineDir = path.resolve(options.engineDir || path.join(__dirname, '..'));
  const appDir = path.resolve(options.appDir || engineDir);
  const dataDir = path.resolve(options.dataDir || path.join(appDir, 'data'));
  const uploadsDir = path.resolve(options.uploadsDir || path.join(appDir, 'uploads'));
  const regradeDir = path.resolve(options.outDir || path.join(dataDir, 'regrades'));
  const engine = compare.loadEngine(engineDir);
  const stamp = engineStamp(engineDir, engine);
  const file = historyFile(regradeDir, stamp);
  const done = readIds(file);

  let items = dumpScans.loadGradedItems(dataDir);
  if (options.id) {
    const p = String(options.id).toLowerCase();
    items = items.filter(function (it) { return String(it.scanId || it.id || '').toLowerCase().startsWith(p); });
  }
  if (options.n) items = items.slice(-options.n);

  const added = [];
  const already = [];
  const missing = [];
  for (const item of items) {
    const id = String(item.scanId || item.id || '');
    if (done.has(id)) { already.push(id); continue; }
    const upload = item.imagePath ? path.join(uploadsDir, path.basename(item.imagePath)) : null;
    if (!upload || !fs.existsSync(upload)) { missing.push(id); continue; }
    const q = compare.quadOptions(item.gradingReport || {});
    const t0 = Date.now();
    const report = await compare.gradeQuietly(engine, fs.readFileSync(upload), q.opts);
    const record = {
      scanId: id,
      scannedAt: item.createdAt || null,
      regradedAt: new Date().toISOString(),
      engine: stamp,
      storedEngine: item.engine || null,
      upload: path.basename(upload),
      quad: q.label,
      gradeMs: Date.now() - t0,
      summary: summarize(report)
    };
    if (!options.summaryOnly) record.report = report;
    fs.mkdirSync(regradeDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    done.add(id);
    added.push(record);
  }

  const lines = [];
  lines.push('regrade  engine ' + stamp.version + ' @ ' + stamp.commit + '  (' + engineDir + ')');
  lines.push('history ' + file);
  lines.push('added ' + added.length + ' · already in history ' + already.length + ' · upload missing ' + missing.length +
    ' · history now ' + done.size + ' scans');
  added.forEach(function (r) {
    const s = r.summary;
    lines.push('  + ' + r.scanId.slice(0, 8).toUpperCase() + '  ' +
      (s.cardNotFound ? 'card not found: ' + s.reason
        : s.lr == null ? 'centering undetectable' + (s.reason ? ': ' + s.reason : '')
          : 'L/R ' + s.lr.toFixed(1) + '  T/B ' + s.tb.toFixed(1) + '  CEN ' + (s.subGrades && s.subGrades.centering != null ? s.subGrades.centering : '—')) +
      (s.lowConfidenceEdges.length ? '  low-confidence cut: ' + s.lowConfidenceEdges.join(', ') : '') + '  ' + r.gradeMs + 'ms');
  });
  missing.forEach(function (id) { lines.push('  ! ' + id.slice(0, 8).toUpperCase() + '  upload missing (not recorded; re-run once restored)'); });
  return { text: lines.join('\n'), file: file, engine: stamp, added: added, already: already, missing: missing };
}

function listHistories(options) {
  const appDir = path.resolve(options.appDir || path.join(__dirname, '..'));
  const dataDir = path.resolve(options.dataDir || path.join(appDir, 'data'));
  const regradeDir = path.resolve(options.outDir || path.join(dataDir, 'regrades'));
  const files = fs.existsSync(regradeDir) ? fs.readdirSync(regradeDir).filter(function (f) { return /\.jsonl$/.test(f); }).sort() : [];
  const out = files.map(function (f) { return { file: f, scans: readIds(path.join(regradeDir, f)).size }; });
  const text = ['regrade histories in ' + regradeDir].concat(out.length
    ? out.map(function (h) { return '  ' + h.file + '  ' + h.scans + ' scans'; })
    : ['  none yet']).join('\n');
  return { text: text, histories: out };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const opts = {
    engineDir: args.engine, appDir: args.app, dataDir: args.data, uploadsDir: args.uploads, outDir: args.out,
    n: Number(args.n) > 0 ? Number(args.n) : null, id: typeof args.id === 'string' ? args.id : null,
    summaryOnly: Boolean(args['summary-only'])
  };
  if (args.list) {
    console.log(listHistories(opts).text);
  } else {
    regrade(opts).then(function (out) { console.log(out.text); }).catch(function (err) {
      console.error('regrade failed:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
  }
}

module.exports = { regrade, listHistories, engineStamp, historyFile, readIds };
