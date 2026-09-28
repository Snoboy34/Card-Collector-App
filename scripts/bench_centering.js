#!/usr/bin/env node
/**
 * scripts/bench_centering.js
 * Time the hi-res (native) centering path against the 643×900 (standard)
 * path on saved scans, on whatever machine runs it. Per scan, medians of
 * --reps runs of:
 *   warp       warpPerspective alone: 643×900 vs the native centering size
 *   refine     refineQuadToCut at 643×900 vs at native size
 *   locate     locateCard (decode + quad + refine + warp[s])
 *   grade      full gradeBuffer, centeringResolution standard vs native
 * Read-only: no scanId/scans root is passed; database.json and uploads are
 * only read.
 *
 * Usage:
 *   node scripts/bench_centering.js --app /path/to/live/checkout [--engine DIR] \
 *     [--n 12] [--reps 3] [--json]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
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

function median(v) {
  const s = v.filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (a, b) { return a - b; });
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function ms(v) { return v == null ? '—' : String(Math.round(v)); }
function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }

async function timeIt(reps, fn) {
  const times = [];
  let last;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    last = await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { ms: median(times), result: last };
}

async function quietly(fn) {
  const log = console.log;
  const warn = console.warn;
  console.log = function () {};
  console.warn = function () {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
}

/** Same decode the engine does (EXIF-upright, capped at MAX_DECODE_DIM). */
async function decodeLikeEngine(sharp, buffer, maxDim) {
  const meta = await sharp(buffer, { failOnError: false }).metadata();
  const swapped = meta.orientation != null && meta.orientation >= 5;
  const pw = (swapped ? meta.height : meta.width) || 1;
  const ph = (swapped ? meta.width : meta.height) || 1;
  let p = sharp(buffer, { failOnError: false }).rotate();
  const scale = Math.min(1, maxDim / Math.max(pw, ph));
  if (scale < 1) p = p.resize({ width: Math.round(pw * scale), height: Math.round(ph * scale), fit: 'fill' });
  const out = await p.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height, channels: out.info.channels, photoWidth: pw, photoHeight: ph };
}

function photoQuadToDecode(q, decoded) {
  const sx = decoded.width / decoded.photoWidth;
  const sy = decoded.height / decoded.photoHeight;
  const f = function (p) { return [p[0] * sx, p[1] * sy]; };
  return { tl: f(q.tl), tr: f(q.tr), br: f(q.br), bl: f(q.bl) };
}

async function benchCentering(options) {
  const engineDir = path.resolve(options.engineDir || path.join(__dirname, '..'));
  const appDir = path.resolve(options.appDir || engineDir);
  const dataDir = path.resolve(options.dataDir || path.join(appDir, 'data'));
  const uploadsDir = path.resolve(options.uploadsDir || path.join(appDir, 'uploads'));
  const reps = options.reps || 3;
  const engine = compare.loadEngine(engineDir);
  const cardQuad = require(path.join(engineDir, 'services', 'card_quad.js'));
  const sharp = require(require.resolve('sharp', { paths: [engineDir] }));
  const items = dumpScans.loadGradedItems(dataDir).slice(-(options.n || 12));

  const rows = [];
  const skipped = [];
  for (const item of items) {
    const id = String(item.scanId || item.id || '');
    const file = item.imagePath ? path.join(uploadsDir, path.basename(item.imagePath)) : null;
    if (!file || !fs.existsSync(file)) { skipped.push({ scanId: id, reason: 'upload missing' }); continue; }
    const buffer = fs.readFileSync(file);
    const q = compare.quadOptions(item.gradingReport || {});
    const optsFor = function (mode) { return Object.assign({ centeringResolution: mode }, q.opts); };

    const locStd = await timeIt(reps, function () { return engine.locateCard(buffer, optsFor('standard')); });
    const locNat = await timeIt(reps, function () { return engine.locateCard(buffer, optsFor('native')); });
    if (!locNat.result || !locNat.result.found) { skipped.push({ scanId: id, reason: 'card not found' }); continue; }
    const cw = locNat.result.detection.centeringWarp;

    const decoded = await decodeLikeEngine(sharp, buffer, engine.MAX_DECODE_DIM || 2400);
    const quad = photoQuadToDecode(locNat.result.detection.quad, decoded);
    const warpStd = await timeIt(reps, function () { return cardQuad.warpPerspective(decoded, quad, cardQuad.WARP_WIDTH, cardQuad.WARP_HEIGHT); });
    const warpNat = await timeIt(reps, function () { return cardQuad.warpPerspective(decoded, quad, cw.width, cw.height); });
    const refStd = await timeIt(reps, function () { return cardQuad.refineQuadToCut(decoded, quad, cardQuad.WARP_WIDTH, cardQuad.WARP_HEIGHT); });
    const refNat = await timeIt(reps, function () { return cardQuad.refineQuadToCut(decoded, quad, cw.width, cw.height); });

    const gradeStd = await timeIt(reps, function () { return quietly(function () { return engine.gradeBuffer(buffer, Object.assign({ alignmentCrop: true, debug: false }, optsFor('standard'))); }); });
    const gradeNat = await timeIt(reps, function () { return quietly(function () { return engine.gradeBuffer(buffer, Object.assign({ alignmentCrop: true, debug: false }, optsFor('native'))); }); });

    rows.push({
      scanId: id,
      decode: decoded.width + '×' + decoded.height,
      warpSize: cw.width + '×' + cw.height,
      warpMs: { standard: warpStd.ms, native: warpNat.ms },
      refineMs: { standard: refStd.ms, native: refNat.ms },
      locateMs: { standard: locStd.ms, native: locNat.ms },
      gradeMs: { standard: gradeStd.ms, native: gradeNat.ms }
    });
  }

  const lines = [];
  lines.push('bench_centering  engine=' + engineDir + '  reps=' + reps);
  lines.push('machine: ' + ((os.cpus()[0] || {}).model || 'unknown cpu') + ' ×' + os.cpus().length + '  ' +
    os.platform() + ' ' + os.release() + '  node ' + process.version);
  lines.push('data=' + dataDir + '  uploads=' + uploadsDir + '  scans=' + rows.length + (skipped.length ? '  skipped=' + skipped.length : ''));
  lines.push('');
  lines.push(pad('scan', 10) + pad('decode', 11) + pad('native warp', 12) + pad('warp ms', 13) + pad('refine ms', 13) +
    pad('locate ms', 13) + pad('grade ms', 13) + 'grade +ms');
  lines.push(pad('', 10) + pad('', 11) + pad('', 12) + pad('std / nat', 13) + pad('std / nat', 13) + pad('std / nat', 13) + pad('std / nat', 13));
  rows.forEach(function (r) {
    lines.push(pad(r.scanId.slice(0, 8).toUpperCase(), 10) + pad(r.decode, 11) + pad(r.warpSize, 12) +
      pad(ms(r.warpMs.standard) + ' / ' + ms(r.warpMs.native), 13) +
      pad(ms(r.refineMs.standard) + ' / ' + ms(r.refineMs.native), 13) +
      pad(ms(r.locateMs.standard) + ' / ' + ms(r.locateMs.native), 13) +
      pad(ms(r.gradeMs.standard) + ' / ' + ms(r.gradeMs.native), 13) +
      '+' + ms(r.gradeMs.native - r.gradeMs.standard));
  });
  skipped.forEach(function (s) { lines.push(pad(s.scanId.slice(0, 8).toUpperCase(), 10) + 'skipped: ' + s.reason); });

  const med = function (k, mode) { return median(rows.map(function (r) { return r[k][mode]; })); };
  const summary = {};
  ['warpMs', 'refineMs', 'locateMs', 'gradeMs'].forEach(function (k) {
    summary[k] = { standard: med(k, 'standard'), native: med(k, 'native') };
  });
  summary.gradeExtraMs = median(rows.map(function (r) { return r.gradeMs.native - r.gradeMs.standard; }));
  summary.warpSize = rows.length ? rows[Math.floor(rows.length / 2)].warpSize : null;
  lines.push('');
  lines.push('MEDIAN over ' + rows.length + ' scans (ms, standard → native):  warp ' + ms(summary.warpMs.standard) + ' → ' +
    ms(summary.warpMs.native) + '   refine ' + ms(summary.refineMs.standard) + ' → ' + ms(summary.refineMs.native) +
    '   locate ' + ms(summary.locateMs.standard) + ' → ' + ms(summary.locateMs.native) +
    '   grade ' + ms(summary.gradeMs.standard) + ' → ' + ms(summary.gradeMs.native) +
    '  (+' + ms(summary.gradeExtraMs) + ' per scan)');
  lines.push('Native locate = standard locate + native-size refine + one extra native-size warp.');
  return { text: lines.join('\n'), rows: rows, skipped: skipped, summary: summary };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  benchCentering({
    engineDir: args.engine,
    appDir: args.app,
    dataDir: args.data,
    uploadsDir: args.uploads,
    n: Number(args.n) > 0 ? Number(args.n) : 12,
    reps: Number(args.reps) > 0 ? Number(args.reps) : 3
  }).then(function (out) {
    console.log(args.json ? JSON.stringify(out, null, 2) : out.text);
  }).catch(function (err) {
    console.error('bench_centering failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { benchCentering };
