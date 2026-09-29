#!/usr/bin/env node
/**
 * scripts/refine_probe.js
 * Why did refineQuadToCut move one scan's edges so far? Re-runs locateCard on
 * the stored upload (read-only) and reports:
 *   - detector quad vs refined quad shape (height/width; a card is 1.400)
 *   - per edge: the refine profile's strongest steps (position relative to
 *     the detector edge in 643×900 px, − = outside the quad, size, and
 *     whether it gets brighter or darker going inward), so a shadow or a
 *     second edge competing with the cut shows up as a close runner-up
 *   - this scan's borderWidthsMm next to the other recent scans' mean
 *
 * Usage:
 *   node scripts/refine_probe.js --app /path/to/live/checkout --id 60DF47B1 [--n 12] [--engine DIR]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const dumpScans = require('./dump_scans');
const compare = require('./compare_finders');
const { edgeFacts, stats } = require('./edge_bias');
const { decodeLikeEngine } = require('./bench_centering');

const EDGES = ['left', 'right', 'top', 'bottom'];

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

function fmt(v, d) { return typeof v === 'number' && isFinite(v) ? v.toFixed(d == null ? 2 : d) : '—'; }
function signed(v, d) { return typeof v === 'number' && isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) : '—'; }
function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }

function shape(q) {
  const d = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const w = (d(q.tl, q.tr) + d(q.bl, q.br)) / 2;
  const h = (d(q.tl, q.bl) + d(q.tr, q.br)) / 2;
  return { w: w, h: h, ratio: h / w };
}

/** Same expanded warp and middle-half mean profile refineQuadToCut uses. */
function refineProfiles(cardQuad, decoded, quad, outW, outH) {
  const ex = Math.max(4, Math.round(outW * cardQuad.REFINE_EXPAND_FRAC));
  const ey = Math.max(4, Math.round(outH * cardQuad.REFINE_EXPAND_FRAC));
  const bigW = outW + 2 * ex;
  const bigH = outH + 2 * ey;
  const Hin = cardQuad.computeHomography(
    [[ex, ey], [ex + outW - 1, ey], [ex + outW - 1, ey + outH - 1], [ex, ey + outH - 1]],
    [quad.tl, quad.tr, quad.br, quad.bl]
  );
  const big = cardQuad.warpWithHomography(decoded, Hin, bigW, bigH);
  const ch = big.channels;
  const grey = function (x, y) {
    const i = (y * bigW + x) * ch;
    return ch >= 3 ? (big.data[i] + big.data[i + 1] + big.data[i + 2]) / 3 : big.data[i];
  };
  const out = {};
  EDGES.forEach(function (edge) {
    const expand = edge === 'left' || edge === 'right' ? ex : ey;
    const length = 2 * expand + 2;
    const alongMax = edge === 'left' || edge === 'right' ? bigH : bigW;
    const a0 = Math.floor(alongMax * 0.25);
    const a1 = Math.floor(alongMax * 0.75);
    const p = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let a = a0; a < a1; a++) {
        if (edge === 'left') sum += grey(i, a);
        else if (edge === 'right') sum += grey(bigW - 1 - i, a);
        else if (edge === 'top') sum += grey(a, i);
        else sum += grey(a, bigH - 1 - i);
      }
      p[i] = sum / (a1 - a0);
    }
    const steps = [];
    for (let i = 0; i < length - 1; i++) steps.push({ i: i, size: p[i + 1] - p[i] });
    steps.sort(function (x, y) { return Math.abs(y.size) - Math.abs(x.size); });
    // Keep local maxima only, so one blurred edge is not listed three times.
    const peaks = [];
    steps.forEach(function (s) {
      if (peaks.length < 3 && peaks.every(function (q) { return Math.abs(q.i - s.i) > 2; })) peaks.push(s);
    });
    out[edge] = { expand: expand, profile: Array.from(p), peaks: peaks };
  });
  return out;
}

async function refineProbe(options) {
  const engineDir = path.resolve(options.engineDir || path.join(__dirname, '..'));
  const appDir = path.resolve(options.appDir || engineDir);
  const dataDir = path.resolve(options.dataDir || path.join(appDir, 'data'));
  const uploadsDir = path.resolve(options.uploadsDir || path.join(appDir, 'uploads'));
  const engine = compare.loadEngine(engineDir);
  const cardQuad = require(path.join(engineDir, 'services', 'card_quad.js'));
  const sharp = require(require.resolve('sharp', { paths: [engineDir] }));
  const prefix = String(options.id || '').toLowerCase();
  const all = dumpScans.loadGradedItems(dataDir);
  const item = all.find(function (it) { return String(it.scanId || it.id || '').toLowerCase().startsWith(prefix); });
  if (!prefix || !item) throw new Error('no graded scan with id starting ' + (options.id || '(none)'));
  const id = String(item.scanId || item.id);
  const file = item.imagePath ? path.join(uploadsDir, path.basename(item.imagePath)) : null;
  if (!file || !fs.existsSync(file)) throw new Error('upload missing for ' + id + ': ' + file);
  const buffer = fs.readFileSync(file);
  const q = compare.quadOptions(item.gradingReport || {});

  const loc = await engine.locateCard(buffer, Object.assign({ centeringResolution: 'native' }, q.opts));
  if (!loc.found) throw new Error('card not found on re-run: ' + loc.detection.reasons.join('; '));
  const det = loc.detection;
  const cw = det.centeringWarp;
  const decoded = await decodeLikeEngine(sharp, buffer, engine.MAX_DECODE_DIM || 2400);
  const sx = decoded.width / decoded.photoWidth;
  const sy = decoded.height / decoded.photoHeight;
  const toDecode = function (qq) {
    const f = function (p) { return [p[0] * sx, p[1] * sy]; };
    return cardQuad.orderQuad([f(qq.tl), f(qq.tr), f(qq.br), f(qq.bl)]);
  };
  const rawQ = toDecode(det.rawQuad);
  const refinedQ = toDecode(det.quad);
  const profiles = refineProfiles(cardQuad, decoded, rawQ, cw.width, cw.height);
  const s = cw.scale;

  const lines = [];
  lines.push('refine_probe  ' + id + '  ' + (item.createdAt || ''));
  lines.push('quad source ' + det.quadSource + '  photo ' + det.photoWidth + '×' + det.photoHeight +
    '  decode ' + decoded.width + '×' + decoded.height + '  centering warp ' + cw.width + '×' + cw.height +
    ' (scale ' + fmt(s, 3) + ')');
  const rs = shape(rawQ);
  const fs2 = shape(refinedQ);
  lines.push('shape h/w (card = 1.400):  detector ' + fmt(rs.ratio, 3) + ' (' + fmt(rs.w, 0) + '×' + fmt(rs.h, 0) +
    ' decode px)   refined ' + fmt(fs2.ratio, 3) + ' (' + fmt(fs2.w, 0) + '×' + fmt(fs2.h, 0) + ')');
  lines.push('refine shift (643 px, − = cut found outside the detector edge): ' + EDGES.map(function (e) {
    return e[0].toUpperCase() + ' ' + signed((det.edgeRefinementPx || {})[e]);
  }).join('  '));
  lines.push('');
  lines.push('Refine profile steps per edge (position vs detector edge in 643 px; size in grey levels; ' +
    'inward: + brighter, − darker):');
  EDGES.forEach(function (e) {
    const pr = profiles[e];
    const peaks = pr.peaks.map(function (pk, n) {
      const pos = (pk.i + 1 - pr.expand) / s;
      return (n === 0 ? 'chosen ' : 'next ') + signed(pos, 1) + ' px (' + signed(pk.size, 1) + ')';
    });
    lines.push('  ' + pad(e, 7) + peaks.join('   '));
  });
  lines.push('  (a real cut is one dominant step; a runner-up ≥60% nearby means a shadow, sleeve, or second edge)');
  const conf = det.edgeCutConfidence;
  if (conf) {
    lines.push('Engine cut confidence (separate peaks only; low = runner-up ≥60% within 3 px):');
    EDGES.forEach(function (e) {
      const c = conf[e];
      lines.push('  ' + pad(e, 7) + 'runner-up ' + pad(Math.round((c.runnerUpRatio || 0) * 100) + '%', 5) + 'at ' +
        pad(signed(c.runnerUpOffsetPx, 1) + ' px', 10) + (c.lowConfidence ? 'LOW CONFIDENCE' : 'ok'));
    });
  }

  const report = await compare.gradeQuietly(engine, buffer, q.opts);
  const here = {};
  EDGES.forEach(function (e) { here[e] = edgeFacts(report, e); });
  const others = [];
  for (const it of all.slice(-(options.n || 12))) {
    const oid = String(it.scanId || it.id || '');
    if (oid === id) continue;
    const of = it.imagePath ? path.join(uploadsDir, path.basename(it.imagePath)) : null;
    if (!of || !fs.existsSync(of)) continue;
    const rep = await compare.gradeQuietly(engine, fs.readFileSync(of), compare.quadOptions(it.gradingReport || {}).opts);
    if (rep.cardNotFound) continue;
    const f = {};
    EDGES.forEach(function (e) { f[e] = edgeFacts(rep, e); });
    others.push(f);
  }
  lines.push('');
  lines.push('borderWidthsMm, photo frame (this scan vs ' + others.length + ' other recent scans; rotated scans swap edges, compare with care):');
  const cmp = {};
  EDGES.forEach(function (e) {
    const st = stats(others.map(function (o) { return o[e].mm; }));
    const refineSt = stats(others.map(function (o) { return o[e].refinePx; }));
    cmp[e] = { mm: here[e].mm, othersMm: st, refinePx: here[e].refinePx, othersRefinePx: refineSt };
    lines.push('  ' + pad(e, 7) + 'this ' + pad(fmt(here[e].mm, 3), 7) + 'others ' + fmt(st.mean, 3) + ' sd ' + fmt(st.sd, 3) +
      '   refine this ' + pad(signed(here[e].refinePx), 7) + 'others ' + signed(refineSt.mean) + ' sd ' + fmt(refineSt.sd));
  });
  return { text: lines.join('\n'), scanId: id, detection: det, profiles: profiles, comparison: cmp };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    console.error('usage: node scripts/refine_probe.js --app <live checkout> --id <scan id prefix> [--n 12]');
    process.exit(2);
  }
  refineProbe({
    engineDir: args.engine,
    appDir: args.app,
    dataDir: args.data,
    uploadsDir: args.uploads,
    id: args.id,
    n: Number(args.n) > 0 ? Number(args.n) : 12
  }).then(function (out) {
    console.log(args.json ? JSON.stringify(out, null, 2) : out.text);
  }).catch(function (err) {
    console.error('refine_probe failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { refineProbe, refineProfiles };
