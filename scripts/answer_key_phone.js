#!/usr/bin/env node
/**
 * scripts/answer_key_phone.js
 *
 * For every approved answer-key card, run the phone engine on each saved
 * front scan. An edge passes when the engine withholds it, or when the
 * reported width is within 0.1 mm of the approved flatbed mean. The error
 * is always printed. The 0.1 mm target is not adjustable from this script.
 *
 *   node scripts/answer_key_phone.js [--data DIR] [--uploads DIR] [--all]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const dumpScans = require('./dump_scans');
const compare = require('./compare_finders');

const TOLERANCE_MM = 0.1;
const EDGES = ['left', 'right', 'top', 'bottom'];

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

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmt(v) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(3) : '—';
}

function fmtErr(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(3);
}

function loadKey(file) {
  const key = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cards = {};
  Object.keys(key.cards || {}).forEach(function (id) {
    const sides = (key.cards[id] && key.cards[id].sides) || {};
    const approved = {};
    EDGES.forEach(function (edge) {
      const side = sides[edge];
      if (side && side.approved && side.mm != null && !side.withheld) approved[edge] = side.mm;
    });
    if (Object.keys(approved).length) cards[id] = approved;
  });
  return { file: file, cards: cards };
}

function scanSide(item) {
  return compare.scanSide(item);
}

function uploadFile(uploadsDir, item) {
  const imagePath = item && item.imagePath;
  if (!imagePath) return null;
  const file = path.join(uploadsDir, path.basename(imagePath));
  return fs.existsSync(file) ? file : null;
}

function edgeError(phoneMm, truthMm, withheld) {
  if (truthMm == null) return { error: null, status: 'no-key' };
  if (withheld || phoneMm == null) return { error: phoneMm == null ? null : phoneMm - truthMm, status: 'withheld' };
  const error = phoneMm - truthMm;
  return { error: error, status: Math.abs(error) <= TOLERANCE_MM + 1e-9 ? 'pass' : 'fail' };
}

/**
 * @param {{engineDir?:string, dataDir:string, uploadsDir:string, keyFile?:string, engine?:object}} options
 */
async function checkApproved(options) {
  const engine = options.engine || compare.loadEngine(options.engineDir || path.join(__dirname, '..'));
  const keyFile = options.keyFile || path.join(__dirname, '..', 'reference', 'answer_key.json');
  const key = loadKey(keyFile);
  const labels = dumpScans.loadLabelMap(options.dataDir);
  const items = dumpScans.loadGradedItems(options.dataDir).map(function (item) {
    return dumpScans.applyLabelFields(item, labels);
  });
  const rows = [];
  const failures = [];
  const lines = [];
  lines.push('answer-key phone check  tolerance=' + TOLERANCE_MM.toFixed(1) + ' mm');
  lines.push('key=' + keyFile);
  lines.push('data=' + options.dataDir + '  uploads=' + options.uploadsDir);
  const ids = Object.keys(key.cards).sort();
  if (!ids.length) {
    return { ok: false, lines: lines.concat(['no approved sides']), rows: [], failures: ['no approved sides'], toleranceMm: TOLERANCE_MM };
  }
  lines.push(pad('card', 8) + pad('scan', 10) + pad('edge', 8) + pad('phone', 10) + pad('flatbed', 10) + pad('error', 10) + 'status');
  for (let c = 0; c < ids.length; c++) {
    const id = ids[c];
    const truth = key.cards[id];
    const fronts = items.filter(function (item) {
      return String(item.deckId || '').toUpperCase() === id && scanSide(item) !== 'back';
    });
    if (!fronts.length) {
      failures.push(id + ' has no saved front scan');
      lines.push(id + '  no saved front scan');
      continue;
    }
    for (let i = 0; i < fronts.length; i++) {
      const item = fronts[i];
      const file = uploadFile(options.uploadsDir, item);
      const scanId = String(item.scanId || item.id || '').slice(0, 8);
      if (!file) {
        failures.push(id + ' ' + scanId + ' upload missing');
        lines.push(pad(id, 8) + pad(scanId, 10) + 'upload missing');
        continue;
      }
      const q = compare.quadOptions(item.gradingReport);
      const report = await compare.gradeQuietly(engine, fs.readFileSync(file), q.opts);
      const summary = compare.summarizeRun(report);
      const mm = summary.mm || {};
      const low = ((report.centeringMetrics || {}).borderVoteLowConfidenceEdges) || [];
      EDGES.forEach(function (edge) {
        if (truth[edge] == null) return;
        const phone = mm[edge];
        // A reported width is judged against 0.1 mm. Only a missing width
        // is a withhold. A grade that failed for some other edge does not
        // hide this edge's error.
        const withheld = phone == null || low.indexOf(edge) !== -1;
        const judged = edgeError(phone, truth[edge], withheld);
        rows.push({
          card: id,
          scanId: String(item.scanId || item.id || ''),
          edge: edge,
          phoneMm: phone == null ? null : phone,
          flatbedMm: truth[edge],
          errorMm: judged.error,
          status: judged.status,
          withheld: withheld
        });
        lines.push(
          pad(id, 8) + pad(scanId, 10) + pad(edge, 8) + pad(fmt(phone), 10) +
          pad(fmt(truth[edge]), 10) + pad(fmtErr(judged.error), 10) + judged.status
        );
        if (judged.status === 'fail') {
          failures.push(id + ' ' + scanId + ' ' + edge + ' error ' + fmtErr(judged.error) + ' mm (limit ' + TOLERANCE_MM + ')');
        }
      });
    }
  }
  lines.push(failures.length ? ('FAIL  ' + failures.length + ' edge(s) outside ' + TOLERANCE_MM + ' mm and not withheld') : 'PASS');
  return { ok: failures.length === 0, lines: lines, rows: rows, failures: failures, toleranceMm: TOLERANCE_MM };
}

async function dumpAll(options) {
  const engine = options.engine || compare.loadEngine(options.engineDir || path.join(__dirname, '..'));
  const labels = dumpScans.loadLabelMap(options.dataDir);
  const items = dumpScans.loadGradedItems(options.dataDir).map(function (item) {
    return dumpScans.applyLabelFields(item, labels);
  });
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const file = uploadFile(options.uploadsDir, item);
    const scanId = String(item.scanId || item.id || '');
    if (!file) {
      rows.push({ scanId: scanId, missing: true });
      continue;
    }
    const q = compare.quadOptions(item.gradingReport);
    const opts = Object.assign({}, q.opts);
    if (scanSide(item) === 'back') opts.side = 'back';
    const report = await compare.gradeQuietly(engine, fs.readFileSync(file), opts);
    const summary = compare.summarizeRun(report);
    rows.push({
      scanId: scanId,
      deckId: item.deckId ? String(item.deckId).toUpperCase() : null,
      side: scanSide(item),
      createdAt: item.createdAt || null,
      mm: summary.mm,
      lr: summary.lr,
      tb: summary.tb,
      cen: summary.cen,
      detected: !!(report.centeringMetrics && report.centeringMetrics.detected)
    });
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.data || process.env.JUDGE_DATA_DIR || path.join(__dirname, '..', 'data'));
  const uploadsDir = path.resolve(args.uploads || process.env.JUDGE_UPLOADS_DIR || path.join(dataDir, '..', 'uploads'));
  const result = await checkApproved({ dataDir: dataDir, uploadsDir: uploadsDir, keyFile: args.key });
  console.log(result.lines.join('\n'));
  if (args.all) {
    const rows = await dumpAll({ dataDir: dataDir, uploadsDir: uploadsDir });
    const dest = args['all-out'] || path.join(osTmp(), 'phone-scans-mm.json');
    fs.writeFileSync(dest, JSON.stringify(rows, null, 2));
    console.log('all scans written ' + dest + '  n=' + rows.length);
  }
  if (!result.ok) process.exit(1);
}

function osTmp() {
  return require('os').tmpdir();
}

module.exports = {
  checkApproved: checkApproved,
  dumpAll: dumpAll,
  TOLERANCE_MM: TOLERANCE_MM
};

if (require.main === module) {
  main().catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
