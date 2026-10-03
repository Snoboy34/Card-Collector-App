#!/usr/bin/env node
/**
 * scripts/gate.js — `npm run gate`
 * One pass/fail for a checkout:
 *   1. every scripts/verify_*.js suite (new suites are picked up automatically)
 *   2. compare_finders on the saved scans: --current (live engine, default
 *      this checkout) vs --candidate (default this checkout). FAIL if the
 *      candidate measures fewer scans; when both are the same checkout the
 *      two runs must also be identical (determinism).
 *   3. deck_report with this candidate re-grading each deck card's latest
 *      upload. FAIL if the candidate passes fewer deck cards than stored.
 * Steps 2–3 need saved scans. Without them they SKIP, or FAIL with
 * --require-data. Read-only on data.
 *
 * Usage:
 *   npm run gate
 *   npm run gate -- --require-data [--data DIR] [--uploads DIR] [--current DIR] [--candidate DIR] [--n 12]
 *   npm run gate -- --skip-suites          # data checks only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }

function listSuites() {
  return fs.readdirSync(__dirname)
    .filter(function (f) { return /^verify_.*\.js$/.test(f); })
    .sort();
}

function runSuite(file) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = (out.match(/^PASS /gm) || []).length;
  const fail = (out.match(/^FAIL /gm) || []).length;
  const ok = r.status === 0 && fail === 0;
  return {
    step: file.replace(/\.js$/, ''),
    status: ok ? 'PASS' : 'FAIL',
    detail: pass + ' passed' + (fail ? ', ' + fail + ' failed' : '') + (r.status !== 0 ? ', exit ' + r.status : '') +
      ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's',
    failures: out.split('\n').filter(function (l) { return /^FAIL /.test(l); }).slice(0, 5)
  };
}

function sameRun(a, b) {
  return JSON.stringify([a.widths, a.lr, a.tb, a.cen, a.mm, a.reasons]) === JSON.stringify([b.widths, b.lr, b.tb, b.cen, b.mm, b.reasons]);
}

async function compareStep(o) {
  const { compareFinders } = require('./compare_finders');
  const out = await compareFinders({
    currentDir: o.currentDir, candidateDir: o.candidateDir, dataDir: o.dataDir, uploadsDir: o.uploadsDir, n: o.n
  });
  const graded = out.results.filter(function (r) { return !r.skipped; });
  const measured = function (k) { return graded.filter(function (r) { return r[k].lr != null && r[k].tb != null; }).length; };
  const cur = measured('current');
  const cand = measured('candidate');
  const self = path.resolve(o.currentDir) === path.resolve(o.candidateDir);
  const diffs = self ? graded.filter(function (r) { return !sameRun(r.current, r.candidate); }) : [];
  const failures = [];
  if (!graded.length) failures.push('no saved scan could be re-graded (' + out.results.length + ' skipped)');
  if (cand < cur) failures.push('candidate measured ' + cand + ' of ' + graded.length + ' scans, current ' + cur);
  if (diffs.length) failures.push('two runs of the same engine differ on ' + diffs.map(function (r) { return r.scanId.slice(0, 8).toUpperCase(); }).join(', '));
  return {
    step: 'compare_finders',
    status: failures.length ? 'FAIL' : 'PASS',
    detail: graded.length + ' scans · measured current ' + cur + ' / candidate ' + cand + (self ? ' · same engine, runs identical' + (diffs.length ? ': NO' : '') : ''),
    failures: failures
  };
}

function loadTdExpectations() {
  const file = path.join(ROOT, 'fixtures', 'td_expectations.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * TD-01..TD-06 outcomes from fixtures/td_expectations.json. Checks stored
 * results already loaded by deck_report (no second re-grade). A data dir
 * that has none of these cards skips, so synthetic gate fixtures are not
 * required to be the phone deck. --require-data fails a missing card.
 */
function tdStep(o) {
  const deck = require('../services/test_deck');
  const seed = loadTdExpectations();
  const rep = o._deckReport;
  const byId = {};
  ((rep && rep.rows) || []).forEach(function (r) { byId[r.deckId] = r; });
  const failures = [];
  const seen = [];
  const missing = [];
  seed.cards.forEach(function (card) {
    const row = byId[card.id];
    const front = row && row.latest;
    const back = row && row.back;
    if (!front && !back) {
      missing.push(card.id);
      if (o.requireData) failures.push(card.id + ' not scanned');
      return;
    }
    seen.push(card.id);
    if (front) {
      const pass = deck.judgeExpectation(card.expect, front.result);
      if (!pass) {
        failures.push(card.id + ' front expected ' + card.expect + ', got ' + front.result.status);
      }
    } else if (o.requireData) {
      failures.push(card.id + ' front not scanned');
    }
    if (back && card.backExpect) {
      const pass = deck.judgeExpectation(card.backExpect, back.result);
      if (!pass) failures.push(card.id + ' back expected ' + card.backExpect + ', got ' + back.result.status);
    } else if (!back && card.backExpect && o.requireData) {
      failures.push(card.id + ' back not scanned');
    }
  });
  if (!seen.length) {
    const status = o.requireData ? 'FAIL' : 'SKIP';
    return {
      step: 'td_deck',
      status: status,
      detail: 'TD-01..TD-06 not in this data',
      failures: o.requireData ? failures : []
    };
  }
  return {
    step: 'td_deck',
    status: failures.length ? 'FAIL' : 'PASS',
    detail: seen.length + ' of ' + seed.cards.length + ' TD cards in this data' +
      (missing.length ? ' · missing ' + missing.join(', ') : ''),
    failures: failures
  };
}

async function deckStep(o) {
  const { buildDeckReport } = require('./deck_report');
  const rep = await buildDeckReport({ dataDir: o.dataDir, uploadsDir: o.uploadsDir, candidateDir: o.candidateDir });
  const scanned = rep.rows.filter(function (r) { return r.latest; });
  if (!scanned.length) {
    return { step: 'deck_report', status: o.requireData ? 'FAIL' : 'SKIP', detail: 'no scanned deck cards', failures: o.requireData ? ['no scanned deck cards'] : [] };
  }
  const judged = scanned.filter(function (r) { return r.latest.pass != null; });
  const stored = judged.filter(function (r) { return r.latest.pass; }).length;
  const cand = judged.filter(function (r) { return r.candidate && r.candidate.pass; }).length;
  const lost = judged.filter(function (r) { return r.latest.pass && !(r.candidate && r.candidate.pass); });
  o._deckReport = rep;
  const failures = [];
  if (cand < stored) failures.push('candidate passes ' + cand + ' of ' + judged.length + ' deck cards, stored ' + stored + ' (lost: ' + lost.map(function (r) { return r.deckId; }).join(', ') + ')');
  return {
    step: 'deck_report',
    status: failures.length ? 'FAIL' : 'PASS',
    detail: scanned.length + ' deck cards scanned · pass stored ' + stored + ' / candidate ' + cand + ' of ' + judged.length +
      ' · low-confidence cut ' + rep.lowConfidenceCut.length,
    failures: failures
  };
}

async function gate(options) {
  const o = Object.assign({}, options);
  o.candidateDir = path.resolve(o.candidateDir || ROOT);
  o.currentDir = path.resolve(o.currentDir || o.candidateDir);
  o.dataDir = path.resolve(o.dataDir || process.env.JUDGE_DATA_DIR || path.join(o.currentDir, 'data'));
  o.uploadsDir = path.resolve(o.uploadsDir || process.env.JUDGE_UPLOADS_DIR || path.join(o.dataDir, '..', 'uploads'));
  o.n = o.n || 12;
  const steps = [];
  if (!o.skipSuites) listSuites().forEach(function (f) { steps.push(runSuite(f)); });

  const hasData = fs.existsSync(path.join(o.dataDir, 'database.json'));
  if (!hasData) {
    const status = o.requireData ? 'FAIL' : 'SKIP';
    const why = 'no saved scans at ' + path.join(o.dataDir, 'database.json');
    steps.push({ step: 'compare_finders', status: status, detail: why, failures: o.requireData ? [why] : [] });
    steps.push({ step: 'deck_report', status: status, detail: why, failures: o.requireData ? [why] : [] });
    steps.push({ step: 'td_deck', status: status, detail: why, failures: o.requireData ? [why] : [] });
  } else {
    const quiet = function (fn) {
      return async function () {
        try { return await fn(o); } catch (err) {
          const step = fn === compareStep ? 'compare_finders' : (fn === deckStep ? 'deck_report' : 'td_deck');
          return { step: step, status: 'FAIL', detail: 'threw', failures: [String(err && err.message || err)] };
        }
      };
    };
    steps.push(await quiet(compareStep)());
    steps.push(await quiet(deckStep)());
    steps.push(await quiet(tdStep)());
  }

  const ok = steps.every(function (s) { return s.status !== 'FAIL'; });
  const lines = [];
  lines.push('gate  candidate=' + o.candidateDir + (o.currentDir !== o.candidateDir ? '  current=' + o.currentDir : ''));
  lines.push('data=' + o.dataDir + '  uploads=' + o.uploadsDir);
  steps.forEach(function (s) {
    // Indented so a suite that prints a gate table is not miscounted as PASS/FAIL lines.
    lines.push('  ' + pad(s.status, 5) + pad(s.step, 28) + s.detail);
    (s.failures || []).forEach(function (f) { lines.push('        ' + f); });
  });
  lines.push(ok ? 'GATE PASS' : 'GATE FAIL');
  return { ok: ok, steps: steps, text: lines.join('\n') };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  gate({
    candidateDir: args.candidate,
    currentDir: args.current,
    dataDir: args.data,
    uploadsDir: args.uploads,
    n: Number(args.n) > 0 ? Number(args.n) : 12,
    requireData: Boolean(args['require-data']),
    skipSuites: Boolean(args['skip-suites'])
  }).then(function (r) {
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  }).catch(function (err) {
    console.error('GATE FAIL (gate threw):', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { gate, listSuites };
