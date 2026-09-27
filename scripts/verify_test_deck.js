/**
 * scripts/verify_test_deck.js
 * Test-deck registry, scan labels (deck / pre-submission / PSA), capture
 * tagging through /api/grade, the deck report, and the /deck pages.
 * Run: node scripts/verify_test_deck.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ''); }
}

const W = 643;
const H = 900;
const PAD = 80;

/** Card on a pink mat with the exact native quad. borders null → borderless art. */
async function cardJpeg(borders, opts) {
  const o = opts || {};
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v;
      if (o.noCard) v = [236, 72, 153];
      else if (!borders) v = ((Math.floor(x / 6) + Math.floor(y / 6)) % 2) ? [190, 60, 40] : [30, 90, 160];
      else {
        const inB = x < borders.left || x >= W - borders.right || y < borders.top || y >= H - borders.bottom;
        v = inB ? [246, 246, 244] : [40, 50, 70];
      }
      const i = (y * W + x) * 3;
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2];
    }
  }
  const jpeg = await sharp(d, { raw: { width: W, height: H, channels: 3 } })
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 236, g: 72, b: 153 } })
    .jpeg({ quality: 92 }).toBuffer();
  const quad = { tl: [PAD, PAD], tr: [PAD + W - 1, PAD], br: [PAD + W - 1, PAD + H - 1], bl: [PAD, PAD + H - 1] };
  return { jpeg: jpeg, cardQuad: o.noCard ? null : JSON.stringify(quad) };
}

async function run() {
  const deck = require('../services/test_deck');

  // ---- store + rules ----
  assert('deck id normalizes (td-7 is rejected, td-07 → TD-07)',
    deck.normalizeDeckId('td-07') === 'TD-07' && deck.normalizeDeckId('td-7') === null && deck.normalizeDeckId('TD-050') === 'TD-050');
  assert('PSA grades 1–10 in 0.5 steps', deck.normalizePsaGrade('9.5') === 9.5 && deck.normalizePsaGrade(9.3) === undefined &&
    deck.normalizePsaGrade(11) === undefined && deck.normalizePsaGrade('') === null);
  assert('expectation rules', deck.judgeExpectation('measured', { measured: true }) === true &&
    deck.judgeExpectation('undetectable', { measured: false }) === true &&
    deck.judgeExpectation('undetectable', { measured: true }) === false &&
    deck.judgeExpectation('offcenter', { measured: true, worstShare: 70 }) === true &&
    deck.judgeExpectation('offcenter', { measured: true, worstShare: 57 }) === false);
  assert('eleven categories from the deck plan', deck.DECK_CATEGORIES.length === 11 &&
    deck.CATEGORY_IDS.indexOf('borderless') !== -1 && deck.CATEGORY_IDS.indexOf('off-center') !== -1);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-deck-'));
  process.env.JUDGE_DATA_DIR = path.join(tmp, 'data');
  process.env.JUDGE_UPLOADS_DIR = path.join(tmp, 'uploads');
  process.env.JUDGE_SCANS_DIR = path.join(tmp, 'scans');
  const store = deck.createStore(process.env.JUDGE_DATA_DIR);
  const bad = store.upsertCard('TD-01', { category: 'not-a-category' });
  assert('unknown category rejected', bad.ok === false && /unknown category/.test(bad.error));

  const g = require('../services/grading_engine');
  const { app } = require('../server');
  const server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const silence = console.log;
  async function post(fields, img) {
    const fd = new FormData();
    fd.append('image', new Blob([img.jpeg], { type: 'image/jpeg' }), 'still.jpg');
    fd.append('alignmentCrop', 'true');
    if (img.cardQuad) {
      fd.append('cardQuad', img.cardQuad);
      fd.append('quadImageWidth', String(W + 2 * PAD));
      fd.append('quadImageHeight', String(H + 2 * PAD));
    }
    Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
    console.log = function () {};
    const res = await fetch(base + '/api/grade', { method: 'POST', body: fd });
    const body = await res.json();
    console.log = silence;
    return { status: res.status, body: body };
  }
  async function putJson(url, body) {
    const res = await fetch(base + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  try {
    const karros = { left: 40, right: 30, top: 30, bottom: 35 };
    const id1 = 'd0000001-0000-4000-8000-000000000001';
    const s1 = await post({ scanId: id1, deckId: 'td-01', preSubmission: 'true' }, await cardJpeg(karros));
    assert('capture tagged TD-01 → 200 and item.deckId', s1.status === 200 && s1.body.item.deckId === 'TD-01', s1.body.item && s1.body.item.deckId);
    assert('item is stamped with the engine version', s1.body.item.engine && s1.body.item.engine.version === g.ENGINE_VERSION,
      s1.body.item.engine);
    assert('report carries engineVersion', s1.body.item.gradingReport.engineVersion === g.ENGINE_VERSION);
    const labels1 = store.loadLabels().scans[id1];
    assert('capture label saved (deck + pre-submission, source capture)',
      labels1 && labels1.deckId === 'TD-01' && labels1.preSubmission === true && labels1.source === 'capture', labels1);
    assert('unknown deck card is auto-created in the registry', Boolean(store.loadDeck().cards['TD-01']));

    const id2 = 'd0000002-0000-4000-8000-000000000002';
    await post({ scanId: id2, deckId: 'TD-02' }, await cardJpeg(null));
    const id3 = 'd0000003-0000-4000-8000-000000000003';
    await post({ scanId: id3, deckId: 'TD-03' }, await cardJpeg({ left: 20, right: 60, top: 30, bottom: 35 }));
    const id4 = 'd0000004-0000-4000-8000-000000000004';
    const s4 = await post({ scanId: id4, deckId: 'TD-04' }, await cardJpeg(null, { noCard: true }));
    assert('card-not-found capture is still labeled for the deck', s4.status === 422 &&
      store.loadLabels().scans[id4] && store.loadLabels().scans[id4].deckId === 'TD-04');
    const failedLog = fs.readFileSync(path.join(process.env.JUDGE_DATA_DIR, 'failed_scans.jsonl'), 'utf8');
    assert('failed-scans log carries deck id and engine', /"deckId":"TD-04"/.test(failedLog) && /"engine":\{"version"/.test(failedLog));

    let r = await putJson('/api/deck/cards/TD-01', {
      category: 'white-80s-90s', title: '1991 Upper Deck Eric Karros',
      physicalMm: { left: 4, right: 3, top: 3, bottom: 3.5 }, knownPsaGrade: null, notes: 'ruler'
    });
    assert('PUT deck card metadata', r.status === 200 && r.body.card.physicalMm.left === 4, r.body);
    await putJson('/api/deck/cards/TD-02', { category: 'borderless', title: 'full-bleed art' });
    await putJson('/api/deck/cards/TD-03', { category: 'off-center', title: '67/33 miscut' });
    await putJson('/api/deck/cards/TD-04', { category: 'white-modern', title: 'shot with no card' });
    r = await putJson('/api/deck/cards/TD-05', { physicalMm: { left: 99 } });
    assert('ruler mm out of range rejected', r.status === 400);
    r = await putJson('/api/scans/' + id1 + '/label', { psaGrade: '8', psaCert: '12345678' });
    assert('PSA grade recorded on the pre-submission scan', r.status === 200 && r.body.label.psaGrade === 8 && r.body.label.preSubmission === true);
    r = await putJson('/api/scans/' + id2 + '/label', { deckId: 'bad' });
    assert('invalid deck id label → 400', r.status === 400);
    r = await putJson('/api/scans/00000000-0000-4000-8000-00000000dead/label', { deckId: 'TD-09' });
    assert('label for an unknown scan → 404', r.status === 404);

    const rep = await (await fetch(base + '/deck/report?format=text')).text();
    const block = function (id) {
      const a = rep.indexOf('\n' + id + '  ');
      const b = rep.indexOf('\n\n', a + 1);
      return a === -1 ? '' : rep.slice(a, b === -1 ? undefined : b);
    };
    assert('report: TD-01 measured, PASS, ruler delta shown', /measured/.test(block('TD-01')) &&
      /PASS/.test(block('TD-01')) && /ruler ΔL\/R/.test(block('TD-01')), block('TD-01'));
    assert('report: TD-02 borderless is undetectable → PASS', /undetectable/.test(block('TD-02')) && /PASS/.test(block('TD-02')),
      block('TD-02'));
    assert('report: TD-03 off-center caught → PASS', /measured/.test(block('TD-03')) && /PASS/.test(block('TD-03')), block('TD-03'));
    assert('report: TD-04 card not found → FAIL for a white-border card', /card not found/.test(block('TD-04')) &&
      /FAIL/.test(block('TD-04')), block('TD-04'));
    assert('report: per-category rates and overall', /\nborderless\s+1\s+1\s+1\/1 100%/.test(rep) &&
      /\nOVERALL\s+4\s+4\s+3\/4 75%/.test(rep), rep.slice(rep.indexOf('CATEGORY')));
    assert('report: PSA ground truth lists the returned grade', /PSA GROUND TRUTH\s+1 returned/.test(rep) &&
      /PSA 8 /.test(rep) && /cert 12345678/.test(rep), rep.slice(rep.indexOf('PSA GROUND')));

    // Previous engine: a second TD-01 scan saved under a different engine version.
    const dbPath = path.join(process.env.JUDGE_DATA_DIR, 'database.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const older = JSON.parse(JSON.stringify(db.inventory.find(function (it) { return it.scanId === id1; })));
    older.scanId = older.id = 'd0000005-0000-4000-8000-000000000005';
    older.createdAt = '2026-09-01T12:00:00.000Z';
    older.engine = { version: '2026.09.01-old', commit: 'abc1234' };
    db.inventory.push(older);
    fs.writeFileSync(dbPath, JSON.stringify(db));
    store.labelScan(older.scanId, { deckId: 'TD-01' }, 'web');
    const dr = require('./deck_report');
    const withPrev = await dr.buildDeckReport({ dataDir: process.env.JUDGE_DATA_DIR });
    const td1 = withPrev.rows.find(function (x) { return x.deckId === 'TD-01'; });
    assert('previous = latest scan from a different engine', td1.previous && td1.previous.engine.version === '2026.09.01-old' &&
      td1.latest.engine.version === g.ENGINE_VERSION, td1);
    assert('previous row printed with its engine', /previous .*engine 2026\.09\.01-old \(abc1234\)/.test(withPrev.text));

    const withCand = await dr.buildDeckReport({
      dataDir: process.env.JUDGE_DATA_DIR, uploadsDir: process.env.JUDGE_UPLOADS_DIR, candidateDir: path.join(__dirname, '..')
    });
    assert('candidate re-grade rows for scanned deck cards', withCand.rows.filter(function (x) { return x.candidate; }).length === 3 &&
      /candidate pass/.test(withCand.text), withCand.text.slice(withCand.text.indexOf('CATEGORY')));

    const page = await fetch(base + '/deck');
    const html = await page.text();
    assert('GET /deck serves the registry page', page.status === 200 && html.indexOf('Test deck') !== -1 && html.indexOf('/api/deck/recent-scans') !== -1);
    const recent = await (await fetch(base + '/api/deck/recent-scans')).json();
    assert('recent scans list includes the card-not-found attempt', recent.scans.some(function (x) { return x.scanId === id4 && x.summary === 'card not found'; }));
    const dump = require('./dump_scans').formatScanById(process.env.JUDGE_DATA_DIR, id1);
    assert('dump block shows the deck card', /deck TD-01/.test(dump), dump.split('\n')[0]);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }

  if (failures) { console.error(failures + ' test-deck check(s) failed.'); process.exit(1); }
  console.log('All test-deck checks passed.');
  process.exit(0);
}

run().catch(function (err) { console.error('FAIL test-deck run threw', err); process.exit(1); });
