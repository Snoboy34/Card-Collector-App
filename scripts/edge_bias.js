#!/usr/bin/env node
/**
 * scripts/edge_bias.js
 * Per-edge border bias across saved scans of ONE card. Re-grades each stored
 * upload with --engine (default: this checkout) and its saved quad, then
 * reports, per edge: borderWidthsMm mean/sd, where the voting lines that fall
 * outside the agreeing group sit (index along the edge, shallower or deeper
 * than the group), in-group slope (warp tilt), straight-edge profile vs
 * voted width, and the cut-refinement shift.
 *
 * Bias tests:
 *   --ruler-tb / --ruler-lr   ruler top% / left%: per scan, how far the top
 *                             (or bottom) alone would have to move in mm to
 *                             match, with mean, sd and t = mean / (sd/√n).
 *   --ruler-mm L,R,T,B        loupe widths in mm: direct per-edge error.
 *   --rotated id,id,...       scans taken with the card turned 180° (8-char
 *                             prefixes). Splits bias into photo frame
 *                             (camera, light, pipeline) vs card frame (print
 *                             or ruler) without any ruler.
 * Read-only: no scanId/scans root is passed, so no debug artifacts are
 * written; database.json and uploads are only read.
 *
 * Usage:
 *   node scripts/edge_bias.js --app /path/to/live/checkout [--engine DIR] \
 *     [--n 12] [--ruler-tb 46.2] [--ruler-lr 57.1] [--ruler-mm 3.1,2.4,3.0,3.5] \
 *     [--rotated ab12cd34,ef56ab78] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const dumpScans = require('./dump_scans');
const compare = require('./compare_finders');

const EDGES = ['left', 'right', 'top', 'bottom'];
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
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

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function fmt(v, d) { return num(v) == null ? '—' : v.toFixed(d == null ? 2 : d); }
function signed(v, d) { return num(v) == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d == null ? 2 : d); }
function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }

function stats(values) {
  const v = values.filter(function (x) { return num(x) != null; });
  const n = v.length;
  if (!n) return { n: 0, mean: null, sd: null, t: null, min: null, max: null };
  const mean = v.reduce(function (a, b) { return a + b; }, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1)) : null;
  const t = sd != null && sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
  return { n: n, mean: mean, sd: sd, t: t, min: Math.min.apply(null, v), max: Math.max.apply(null, v) };
}

function statText(s, unit) {
  if (!s.n) return '—';
  return signed(s.mean) + (unit || '') + '  sd ' + fmt(s.sd) + '  n ' + s.n + (s.t != null ? '  t ' + signed(s.t, 1) : '');
}

/** Least-squares slope of in-group line position vs position along the edge. */
function groupSlope(lines) {
  const pts = lines.filter(function (l) { return l.inGroup && num(l.pos) != null; });
  if (pts.length < 3) return null;
  const mx = pts.reduce(function (a, l) { return a + l.at; }, 0) / pts.length;
  const my = pts.reduce(function (a, l) { return a + l.pos; }, 0) / pts.length;
  let sxy = 0;
  let sxx = 0;
  pts.forEach(function (l) { sxy += (l.at - mx) * (l.pos - my); sxx += (l.at - mx) * (l.at - mx); });
  return sxx > 0 ? sxy / sxx : null;
}

/** One edge of one report, in the photo frame (top = top of the photo). */
function edgeFacts(report, edge) {
  const diag = report.centeringDiagnostics || {};
  const metrics = report.centeringMetrics || {};
  const det = report.cardDetection || {};
  const widthPx = num((diag.printBorderWidths || {})[edge]);
  const lines = ((diag.sampleLines || {})[edge]) || [];
  const outliers = [];
  let misses = 0;
  lines.forEach(function (l, k) {
    if (num(l.pos) == null) { misses += 1; return; }
    if (l.inGroup) return;
    outliers.push({ index: k, at: l.at, pos: l.pos, deltaPx: widthPx == null ? null : l.pos - widthPx });
  });
  const inGroup = lines.filter(function (l) { return l.inGroup && num(l.pos) != null; }).map(function (l) { return l.pos; });
  const slope = groupSlope(lines);
  const profile = num(((diag.edgeProfiles || {})[edge] || {}).profileWidth);
  return {
    mm: num((metrics.borderWidthsMm || {})[edge]),
    px: widthPx,
    groupSize: inGroup.length,
    groupSdPx: stats(inGroup).sd,
    outliers: outliers,
    shallow: outliers.filter(function (o) { return o.deltaPx != null && o.deltaPx < 0; }).length,
    deep: outliers.filter(function (o) { return o.deltaPx != null && o.deltaPx > 0; }).length,
    misses: misses,
    slopePxPer100: slope == null ? null : slope * 100,
    profileMinusVotedPx: profile != null && widthPx != null ? profile - widthPx : null,
    refinePx: num((det.edgeRefinementPx || {})[edge])
  };
}

function toCardFrame(facts, rotated) {
  if (!rotated) return facts;
  const out = {};
  EDGES.forEach(function (e) { out[e] = facts[OPPOSITE[e]]; });
  return out;
}

/**
 * How far one edge alone would have to move (mm) for the measured axis to
 * match the ruler share. Positive = the measured edge reads short.
 *   top-only: (T+x)/(T+x+B) = r  →  x = r·B/(1−r) − T
 *   bottom-only: T/(T+B−y) = r   →  y = B − T(1−r)/r  (positive = bottom long)
 */
function impliedShift(first, second, rulerFirstPct) {
  if (first == null || second == null || rulerFirstPct == null) return { firstShort: null, secondLong: null };
  const r = rulerFirstPct / 100;
  return { firstShort: r * second / (1 - r) - first, secondLong: second - first * (1 - r) / r };
}

function indexHistogram(perScan, edge) {
  const counts = {};
  perScan.forEach(function (s) {
    s.photo[edge].outliers.forEach(function (o) {
      const key = 'k' + o.index + (o.deltaPx < 0 ? '−' : '+');
      counts[key] = (counts[key] || 0) + 1;
    });
  });
  const keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  return keys.length ? keys.map(function (k) { return k + '×' + counts[k]; }).join(' ') : 'none';
}

function isRotated(id, prefixes) {
  const up = id.toUpperCase();
  return prefixes.some(function (p) { return p && up.startsWith(p.toUpperCase()); });
}

async function edgeBias(options) {
  const engineDir = path.resolve(options.engineDir || path.join(__dirname, '..'));
  const appDir = path.resolve(options.appDir || engineDir);
  const dataDir = path.resolve(options.dataDir || path.join(appDir, 'data'));
  const uploadsDir = path.resolve(options.uploadsDir || path.join(appDir, 'uploads'));
  const engine = compare.loadEngine(engineDir);
  const rotatedIds = options.rotated || [];
  const items = dumpScans.loadGradedItems(dataDir).slice(-(options.n || 12));

  const perScan = [];
  const skipped = [];
  for (const item of items) {
    const id = String(item.scanId || item.id || '');
    const file = item.imagePath ? path.join(uploadsDir, path.basename(item.imagePath)) : null;
    if (!file || !fs.existsSync(file)) { skipped.push({ scanId: id, reason: 'upload missing' }); continue; }
    const q = compare.quadOptions(item.gradingReport || {});
    const report = await compare.gradeQuietly(engine, fs.readFileSync(file), q.opts);
    if (report.cardNotFound) { skipped.push({ scanId: id, reason: 'card not found' }); continue; }
    const photo = {};
    EDGES.forEach(function (e) { photo[e] = edgeFacts(report, e); });
    const rotated = isRotated(id, rotatedIds);
    perScan.push({
      scanId: id,
      createdAt: item.createdAt || null,
      rotated: rotated,
      warp: (report.centeringMetrics || {}).centeringWarp || null,
      flags: ((report.centeringDiagnostics || {}).edgeFlags) || [],
      photo: photo,
      card: toCardFrame(photo, rotated)
    });
  }

  const lines = [];
  lines.push('edge_bias  engine=' + engineDir);
  lines.push('data=' + dataDir + '  uploads=' + uploadsDir + '  scans=' + perScan.length +
    (skipped.length ? '  skipped=' + skipped.length : '') +
    (rotatedIds.length ? '  rotated=' + perScan.filter(function (s) { return s.rotated; }).length : ''));
  lines.push('Widths in mm; line positions in 643×900 px (10.1 px/mm). Photo frame: top = top of the photo.');
  lines.push('');
  lines.push(pad('scan', 10) + pad('rot', 4) + pad('L mm', 7) + pad('R mm', 7) + pad('T mm', 7) + pad('B mm', 7) +
    pad('T−B', 7) + pad('top outliers (k:pos vs group)', 34) + pad('top slope', 10) + 'refine T/B px');
  perScan.forEach(function (s) {
    const t = s.photo.top;
    const out = t.outliers.map(function (o) { return 'k' + o.index + ':' + signed(o.deltaPx, 1); }).join(' ') || '—';
    lines.push(pad(s.scanId.slice(0, 8).toUpperCase(), 10) + pad(s.rotated ? 'yes' : '', 4) +
      pad(fmt(s.photo.left.mm), 7) + pad(fmt(s.photo.right.mm), 7) + pad(fmt(t.mm), 7) + pad(fmt(s.photo.bottom.mm), 7) +
      pad(signed(t.mm != null && s.photo.bottom.mm != null ? t.mm - s.photo.bottom.mm : null), 7) +
      pad(out, 34) + pad(signed(t.slopePxPer100), 10) + fmt(t.refinePx) + ' / ' + fmt(s.photo.bottom.refinePx));
  });
  skipped.forEach(function (s) { lines.push(pad(s.scanId.slice(0, 8).toUpperCase(), 10) + 'skipped: ' + s.reason); });

  lines.push('');
  lines.push('PER EDGE (photo frame, ' + perScan.length + ' scans)');
  lines.push(pad('edge', 8) + pad('mm mean', 9) + pad('mm sd', 7) + pad('group', 7) + pad('group sd px', 12) +
    pad('outl/scan', 10) + pad('shallow', 8) + pad('deep', 6) + pad('miss', 6) + pad('slope/100px', 12) +
    pad('prof−vote', 10) + 'refine px');
  const summary = {};
  EDGES.forEach(function (e) {
    const f = perScan.map(function (s) { return s.photo[e]; });
    const pick = function (k) { return stats(f.map(function (x) { return x[k]; })); };
    const total = function (k) { return f.reduce(function (a, x) { return a + x[k]; }, 0); };
    const mm = pick('mm');
    summary[e] = {
      mm: mm,
      groupSize: pick('groupSize'),
      groupSdPx: pick('groupSdPx'),
      outliersPerScan: f.length ? f.reduce(function (a, x) { return a + x.outliers.length; }, 0) / f.length : null,
      scansWithOutliers: f.filter(function (x) { return x.outliers.length > 0; }).length,
      shallow: total('shallow'),
      deep: total('deep'),
      misses: total('misses'),
      slope: pick('slopePxPer100'),
      profileMinusVoted: pick('profileMinusVotedPx'),
      refine: pick('refinePx'),
      outlierIndexes: indexHistogram(perScan, e)
    };
    const x = summary[e];
    lines.push(pad(e, 8) + pad(fmt(mm.mean, 3), 9) + pad(fmt(mm.sd, 3), 7) + pad(fmt(x.groupSize.mean, 1), 7) +
      pad(fmt(x.groupSdPx.mean), 12) + pad(fmt(x.outliersPerScan, 1) + ' (' + x.scansWithOutliers + ')', 10) +
      pad(x.shallow, 8) + pad(x.deep, 6) + pad(x.misses, 6) + pad(signed(x.slope.mean), 12) +
      pad(signed(x.profileMinusVoted.mean), 10) + signed(x.refine.mean) + ' sd ' + fmt(x.refine.sd));
  });
  lines.push('Outlier lines by index along the edge (k0–k14, − shallower / + deeper than the group):');
  EDGES.forEach(function (e) { lines.push('  ' + pad(e, 7) + summary[e].outlierIndexes); });

  const tests = {};
  const tb = stats(perScan.map(function (s) { return s.card.top.mm != null && s.card.bottom.mm != null ? s.card.top.mm - s.card.bottom.mm : null; }));
  const lr = stats(perScan.map(function (s) { return s.card.left.mm != null && s.card.right.mm != null ? s.card.left.mm - s.card.right.mm : null; }));
  lines.push('');
  lines.push('REPEATABILITY (card frame)  T−B ' + statText(tb, ' mm') + '   L−R ' + statText(lr, ' mm'));
  tests.repeatability = { topMinusBottomMm: tb, leftMinusRightMm: lr };

  if (options.rulerTb != null || options.rulerLr != null) {
    lines.push('');
    lines.push('RULER RATIO TEST (card frame): mm one edge alone must move to match the ruler; + = measured reads short/long as named');
    if (options.rulerTb != null) {
      const sh = perScan.map(function (s) { return impliedShift(s.card.top.mm, s.card.bottom.mm, Number(options.rulerTb)); });
      const topShort = stats(sh.map(function (x) { return x.firstShort; }));
      const bottomLong = stats(sh.map(function (x) { return x.secondLong; }));
      lines.push('  T/B ruler ' + options.rulerTb + '   top reads short by ' + statText(topShort, ' mm') +
        '   | or bottom reads long by ' + statText(bottomLong, ' mm'));
      tests.rulerTb = { ruler: Number(options.rulerTb), topShortMm: topShort, bottomLongMm: bottomLong };
    }
    if (options.rulerLr != null) {
      const sh = perScan.map(function (s) { return impliedShift(s.card.left.mm, s.card.right.mm, Number(options.rulerLr)); });
      const leftShort = stats(sh.map(function (x) { return x.firstShort; }));
      const rightLong = stats(sh.map(function (x) { return x.secondLong; }));
      lines.push('  L/R ruler ' + options.rulerLr + '   left reads short by ' + statText(leftShort, ' mm') +
        '   | or right reads long by ' + statText(rightLong, ' mm'));
      tests.rulerLr = { ruler: Number(options.rulerLr), leftShortMm: leftShort, rightLongMm: rightLong };
    }
    lines.push('  A ratio cannot say which edge is off; --ruler-mm or --rotated can.');
  }

  if (options.rulerMm) {
    lines.push('');
    lines.push('RULER MM TEST (card frame): measured − ruler');
    tests.rulerMm = {};
    EDGES.forEach(function (e, i) {
      const ruler = options.rulerMm[i];
      if (num(ruler) == null) return;
      const err = stats(perScan.map(function (s) { return s.card[e].mm == null ? null : s.card[e].mm - ruler; }));
      tests.rulerMm[e] = Object.assign({ ruler: ruler }, err);
      lines.push('  ' + pad(e, 7) + 'ruler ' + pad(fmt(ruler), 6) + 'error ' + statText(err, ' mm'));
    });
  }

  const up = perScan.filter(function (s) { return !s.rotated; });
  const rot = perScan.filter(function (s) { return s.rotated; });
  if (rot.length) {
    lines.push('');
    lines.push('ROTATION TEST (' + up.length + ' upright, ' + rot.length + ' rotated 180°)');
    tests.rotation = {};
    [['top', 'bottom', 'T−B'], ['left', 'right', 'L−R']].forEach(function (pair) {
      const diff = function (s) {
        const a = s.card[pair[0]].mm;
        const b = s.card[pair[1]].mm;
        return a == null || b == null ? null : a - b;
      };
      const u = stats(up.map(diff));
      const r = stats(rot.map(diff));
      if (u.mean == null || r.mean == null) return;
      const photo = (u.mean - r.mean) / 2;
      const card = (u.mean + r.mean) / 2;
      const se = u.sd != null && r.sd != null ? Math.sqrt(u.sd * u.sd / u.n + r.sd * r.sd / r.n) / 2 : null;
      tests.rotation[pair[2]] = { upright: u, rotated: r, photoFrameMm: photo, cardFrameMm: card, seMm: se };
      lines.push('  card ' + pad(pair[2], 4) + 'upright ' + signed(u.mean) + '  rotated ' + signed(r.mean) +
        '  → photo-frame (camera/light/pipeline) ' + signed(photo) + ' mm, card-frame (print) ' + signed(card) +
        ' mm' + (se != null ? '  ±' + fmt(se) : ''));
    });
    lines.push('  Photo-frame term: + means the photo top (or left) reads wider than it should, whichever card edge is there.');
  }

  return { text: lines.join('\n'), perScan: perScan, skipped: skipped, summary: summary, tests: tests };
}

function parseList(v) {
  if (v == null || v === true) return null;
  return String(v).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const rulerMm = parseList(args['ruler-mm']);
  if (rulerMm && rulerMm.length !== 4) {
    console.error('--ruler-mm needs four values: L,R,T,B');
    process.exit(2);
  }
  edgeBias({
    engineDir: args.engine,
    appDir: args.app,
    dataDir: args.data,
    uploadsDir: args.uploads,
    n: Number(args.n) > 0 ? Number(args.n) : 12,
    rulerTb: args['ruler-tb'],
    rulerLr: args['ruler-lr'],
    rulerMm: rulerMm ? rulerMm.map(Number) : null,
    rotated: parseList(args.rotated) || []
  }).then(function (out) {
    console.log(args.json ? JSON.stringify(out, null, 2) : out.text);
  }).catch(function (err) {
    console.error('edge_bias failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { edgeBias, edgeFacts, impliedShift, groupSlope, toCardFrame, stats };
