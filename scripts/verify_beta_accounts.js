#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const flags = require('../services/beta_flags');
const tier = require('../services/capture_tier');
const guide = require('../services/first_run_guide');
const cardEntry = require('../services/card_entry');
const apple = require('../services/apple_identity');
const centeringAssist = require('../services/centering_assist');

let failures = 0;
function assert(name, cond, extra) {
  if (cond) {
    console.log('  PASS ' + name);
    return;
  }
  failures += 1;
  console.error('  FAIL ' + name + (extra ? ' ' + JSON.stringify(extra) : ''));
}

function guideSources() {
  return [
    fs.readFileSync(path.join(__dirname, '..', 'services', 'first_run_guide.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'services', 'capture_tier.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'public', 'shop_beta.js'), 'utf8')
  ].join('\n');
}

async function main() {
  const off = flags.readFlags(os.tmpdir(), {});
  assert('missing flag file leaves accounts off', off.accounts === false && off.manualEntry === false && off.firstRunGuide === false);
  assert('audience defaults to the CardGrade bundle id', off.appleAudience === 'com.cardgrader.thejudge');

  const low = tier.tierForPxPerMm(10);
  const mid = tier.tierForPxPerMm(22.77);
  const high = tier.tierForPxPerMm(45.4);
  assert('a short capture is withheld by the engine tier', low && low.label === 'withheld, resolution' && low.toleranceMm == null, low);
  assert('a mid capture uses the engine 0.2 mm tier', mid && mid.pxPerMm === 22.77 && mid.label === '±0.2 mm' && mid.toleranceMm === 0.2, mid);
  assert('a tall capture uses the engine 0.1 mm tier', high && high.pxPerMm === 45.4 && high.label === '±0.1 mm' && high.toleranceMm === 0.1, high);
  const blank = guide.guideText(null);
  const measured = guide.guideText(mid);
  assert('the guide has no px/mm until a scan is measured', blank.indexOf('px/mm') !== -1 && blank.indexOf('22.77') === -1 && blank.indexOf('27.5') === -1, blank);
  assert('the guide reads the measured px/mm and tier', measured.indexOf('22.77 px/mm') !== -1 && measured.indexOf('±0.2 mm') !== -1, measured);
  assert('a different measurement replaces the tier', guide.guideText(high).indexOf('45.40 px/mm') !== -1 && guide.guideText(high).indexOf('±0.1 mm') !== -1);
  assert('guide sources do not hard-code 27.5', guideSources().indexOf('27.5') === -1);
  assert('correction examples still do not leave', centeringAssist.examplesClearedToLeave().length === 0);

  const sample = {
    name: 'Unidentified',
    setName: '—',
    deckId: 'TD-06',
    side: 'back',
    createdAt: '2026-10-12T21:50:37.000Z',
    capturedAt: '2026-10-12T21:57:08.000Z',
    gradingReport: { finalScore: 8 },
    cardIdentity: { familyId: null, match: null }
  };
  cardEntry.applyCardEntry(sample, {
    name: 'Shohei Ohtani',
    year: '2018',
    set: 'Topps Update',
    number: 'US1',
    game: 'Baseball',
    notes: 'shop copy',
    marketValue: 400
  }, '2026-10-26T12:00:00.000Z');
  assert('typed name is stored and the grade is untouched',
    sample.name === 'Shohei Ohtani' && sample.cardEntry.set === 'Topps Update' &&
    sample.cardEntry.number === 'US1' && sample.cardEntry.game === 'Baseball' &&
    sample.gradingReport.finalScore === 8 && sample.cardIdentity.familyId === null &&
    sample.deckId === 'TD-06' && sample.side === 'back' &&
    sample.createdAt === '2026-10-12T21:50:37.000Z' &&
    sample.capturedAt === '2026-10-12T21:57:08.000Z' &&
    sample.marketValue == null, sample);
  cardEntry.applyCardEntry(sample, { name: '  ' }, '2026-10-26T12:01:00.000Z');
  assert('a blank name stays Unidentified', sample.name === 'Unidentified' && sample.setName === '—');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-beta-'));
  process.env.JUDGE_DATA_DIR = path.join(tmp, 'data');
  process.env.JUDGE_UPLOADS_DIR = path.join(tmp, 'uploads');
  process.env.JUDGE_SCANS_DIR = path.join(tmp, 'scans');
  process.env.JUDGE_ACCOUNTS = '0';
  process.env.JUDGE_MANUAL_ENTRY = '0';
  process.env.JUDGE_FIRST_RUN = '0';
  process.env.JUDGE_APPLE_TEST_JWKS = '1';
  fs.mkdirSync(process.env.JUDGE_DATA_DIR, { recursive: true });
  fs.mkdirSync(process.env.JUDGE_UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(process.env.JUDGE_SCANS_DIR, { recursive: true });

  const { app } = require('../server');
  const server = await new Promise(function (resolve) {
    const listening = app.listen(0, '127.0.0.1', function () { resolve(listening); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  apple.setTestKeys([jwk]);

  function tokenFor(sub, nonce, extra) {
    const now = Math.floor(Date.now() / 1000);
    const payload = Object.assign({
      iss: 'https://appleid.apple.com',
      aud: 'com.cardgrader.thejudge',
      exp: now + 600,
      iat: now,
      sub: sub,
      nonce: apple.sha256Hex(nonce)
    }, extra || {});
    return apple.signTestToken(payload, pair.privateKey, 'test-1');
  }

  async function call(method, urlPath, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(base + urlPath, {
      method: method,
      headers: headers,
      body: body == null ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }

  try {
    const betaOff = await call('GET', '/api/beta');
    assert('beta endpoint reports the switches off', betaOff.status === 200 && betaOff.body.accounts === false &&
      betaOff.body.manualEntry === false && betaOff.body.firstRunGuide === false, betaOff.body);
    const appleOff = await call('POST', '/api/auth/apple', { identityToken: 'x', nonce: 'n' });
    assert('apple sign-in is refused while accounts are off', appleOff.status === 403 && appleOff.body.error === 'accounts are off', appleOff.body);
    const entryOff = await call('PATCH', '/api/scans/abc/card-entry', { name: 'X' });
    assert('manual entry is refused while its switch is off', entryOff.status === 403, entryOff.body);
    const deleteOff = await call('DELETE', '/api/account');
    assert('account deletion is refused while accounts are off', deleteOff.status === 403, deleteOff.body);

    process.env.JUDGE_ACCOUNTS = '1';
    process.env.JUDGE_MANUAL_ENTRY = '1';
    process.env.JUDGE_FIRST_RUN = '1';

    const nonceA = 'nonce-shop-a';
    const nonceB = 'nonce-shop-b';
    const signedA = await call('POST', '/api/auth/apple', { identityToken: tokenFor('shop.a', nonceA), nonce: nonceA });
    const signedB = await call('POST', '/api/auth/apple', { identityToken: tokenFor('shop.b', nonceB, { email: 'b@example.com' }), nonce: nonceB });
    assert('two Apple subjects become two accounts', signedA.status === 200 && signedB.status === 200 &&
      signedA.body.accountId && signedA.body.accountId !== signedB.body.accountId, { a: signedA.body, b: signedB.body });
    const again = await call('POST', '/api/auth/apple', { identityToken: tokenFor('shop.a', 'nonce-again'), nonce: 'nonce-again' });
    assert('the same Apple subject keeps one account', again.status === 200 && again.body.accountId === signedA.body.accountId);
    const bad = await call('POST', '/api/auth/apple', { identityToken: tokenFor('shop.a', nonceA).slice(0, -4) + 'xxxx', nonce: nonceA });
    assert('a bad signature is rejected', bad.status === 401, bad.body);
    const noNonce = await call('POST', '/api/auth/apple', { identityToken: tokenFor('shop.a', nonceA) });
    assert('a token without the phone nonce is rejected', noNonce.status === 400, noNonce.body);

    const dbPath = path.join(process.env.JUDGE_DATA_DIR, 'database.json');
    const benchId = 'BENCH0001';
    const scanA = 'SHOPA0001';
    const scanB = 'SHOPB0001';
    fs.writeFileSync(path.join(process.env.JUDGE_UPLOADS_DIR, 'a.jpg'), 'image-a');
    fs.writeFileSync(path.join(process.env.JUDGE_UPLOADS_DIR, 'b.jpg'), 'image-b');
    fs.writeFileSync(path.join(process.env.JUDGE_UPLOADS_DIR, 'bench.jpg'), 'image-bench');
    fs.mkdirSync(path.join(process.env.JUDGE_SCANS_DIR, scanA), { recursive: true });
    fs.writeFileSync(path.join(process.env.JUDGE_SCANS_DIR, scanA, 'oriented.jpg'), 'warp-a');
    fs.writeFileSync(dbPath, JSON.stringify({
      inventory: [
        {
          id: benchId, scanId: benchId, name: 'Unidentified', deckId: 'TD-06', side: 'back',
          createdAt: '2026-10-12T21:50:37.000Z', imagePath: '/uploads/bench.jpg',
          gradingReport: { finalScore: 7 }
        },
        {
          id: scanA, scanId: scanA, name: 'Unidentified', accountId: signedA.body.accountId,
          imagePath: '/uploads/a.jpg', gradingReport: { finalScore: 9 },
          capture: { pxPerMm: 22.77 }, createdAt: '2026-10-26T00:00:00.000Z'
        },
        {
          id: scanB, scanId: scanB, name: 'Unidentified', accountId: signedB.body.accountId,
          imagePath: '/uploads/b.jpg', gradingReport: { finalScore: 6 },
          createdAt: '2026-10-26T00:00:01.000Z'
        }
      ],
      categoryCounts: { SPORTS: 0, TCG: 0, UNKNOWN: 3 }
    }, null, 2));
    fs.writeFileSync(path.join(process.env.JUDGE_DATA_DIR, 'centering_examples.jsonl'),
      JSON.stringify({ scanId: scanA, consent: false, side: 'front' }) + '\n' +
      JSON.stringify({ scanId: scanB, consent: true, side: 'front' }) + '\n' +
      JSON.stringify({ scanId: benchId, consent: false, side: 'back' }) + '\n');

    const listA = await call('GET', '/api/inventory', null, signedA.body.token);
    const listB = await call('GET', '/api/inventory', null, signedB.body.token);
    const listBench = await call('GET', '/api/inventory');
    assert('an account sees only its scans', listA.status === 200 && listA.body.inventory.length === 1 &&
      listA.body.inventory[0].scanId === scanA, listA.body);
    assert('the other account sees only its scans', listB.body.inventory.length === 1 && listB.body.inventory[0].scanId === scanB);
    assert('the bench list hides both accounts', listBench.body.inventory.length === 1 && listBench.body.inventory[0].scanId === benchId);
    const hidden = await call('GET', '/api/scans/' + scanA);
    assert('the bench cannot open an account scan', hidden.status === 404, hidden.body);
    const opened = await call('GET', '/api/scans/' + scanA, null, signedA.body.token);
    assert('the owner can open the scan and its tier', opened.status === 200 && opened.body.item.capture.pxPerMm === 22.77, opened.body.item && opened.body.item.capture);

    const typed = await call('PATCH', '/api/scans/' + scanA + '/card-entry', {
      name: 'A Card', year: '1999', set: 'Set', number: '12', game: 'Hockey', notes: 'note', price: 10
    }, signedA.body.token);
    assert('manual entry sets the typed fields and leaves the grade',
      typed.status === 200 && typed.body.item.name === 'A Card' && typed.body.item.cardEntry.game === 'Hockey' &&
      typed.body.item.gradingReport.finalScore === 9 && typed.body.item.cardIdentity.familyId === null &&
      typed.body.item.price == null && typed.body.item.marketValue == null, typed.body.item);
    const stolen = await call('PATCH', '/api/scans/' + scanA + '/card-entry', { name: 'Stolen' }, signedB.body.token);
    assert('another account cannot type this card', stolen.status === 404, stolen.body);

    const guideRes = await call('GET', '/api/beta/guide?pxPerMm=45.4');
    assert('the guide route reads the px/mm it was given', guideRes.status === 200 &&
      guideRes.body.tier.label === '±0.1 mm' && guideRes.body.text.indexOf('45.40 px/mm') !== -1, guideRes.body);
    const bareGuide = await call('GET', '/api/beta/guide');
    assert('the guide route without a measurement does not invent one', bareGuide.body.text.indexOf('27.5') === -1 &&
      bareGuide.body.text.indexOf('45.40') === -1, bareGuide.body.text);

    const removed = await call('DELETE', '/api/account', null, signedA.body.token);
    assert('deleting the account removes its scans', removed.status === 200 && removed.body.deletedScans === 1 &&
      removed.body.deletedExamples === 1, removed.body);
    const after = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const leftIds = after.inventory.map(function (item) { return item.scanId; }).sort();
    assert('the other account and the bench remain', leftIds.join(',') === [benchId, scanB].sort().join(','), leftIds);
    const benchLeft = after.inventory.find(function (item) { return item.scanId === benchId; });
    assert('the bench record keeps its deck, side, and time',
      benchLeft.deckId === 'TD-06' && benchLeft.side === 'back' && benchLeft.createdAt === '2026-10-12T21:50:37.000Z');
    assert('the deleted image and warp are gone',
      !fs.existsSync(path.join(process.env.JUDGE_UPLOADS_DIR, 'a.jpg')) &&
      !fs.existsSync(path.join(process.env.JUDGE_SCANS_DIR, scanA)));
    assert('the other image is still on disk', fs.existsSync(path.join(process.env.JUDGE_UPLOADS_DIR, 'b.jpg')));
    const examples = fs.readFileSync(path.join(process.env.JUDGE_DATA_DIR, 'centering_examples.jsonl'), 'utf8');
    assert('the deleted example is gone and the others stay',
      examples.indexOf(scanA) === -1 && examples.indexOf(scanB) !== -1 && examples.indexOf(benchId) !== -1, examples);
    const gone = await call('GET', '/api/inventory', null, signedA.body.token);
    assert('the deleted session is no longer signed in', gone.status === 401, gone.body);

    const badGrade = await call('POST', '/api/grade', {}, 'not-a-session');
    assert('a grade with a bad session is rejected before it is saved', badGrade.status === 401, badGrade.body);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.JUDGE_ACCOUNTS;
    delete process.env.JUDGE_MANUAL_ENTRY;
    delete process.env.JUDGE_FIRST_RUN;
    delete process.env.JUDGE_APPLE_TEST_JWKS;
  }

  if (failures) {
    console.error(failures + ' beta account check(s) failed.');
    process.exit(1);
  }
  console.log('All beta account checks passed.');
}

main().catch(function (err) {
  console.error('FAIL beta accounts run threw', err);
  process.exit(1);
});
