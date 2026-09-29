/**
 * scripts/verify_scan_metadata.js
 * Scan metadata: the app's captureMetadata field is sanitized and stored on
 * the saved item and the failed-scans line; the server adds serverMetadata
 * (bytes, sha256, decoded size, grade time, engine, LAN). Neither changes the
 * grade. dump_scans prints both.
 * Run: node scripts/verify_scan_metadata.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const sm = require('../services/scan_metadata');

let failures = 0;
function assert(label, cond, detail) {
  if (cond) console.log('PASS', label);
  else { failures += 1; console.error('FAIL', label, detail !== undefined ? JSON.stringify(detail).slice(0, 800) : ''); }
}

const W = 643;
const H = 900;
const PAD = 80;

async function cardJpeg(noCard) {
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inB = x < 40 || x >= W - 30 || y < 30 || y >= H - 35;
      const v = noCard ? [236, 72, 153] : inB ? [246, 246, 244] : [40, 50, 70];
      const i = (y * W + x) * 3;
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2];
    }
  }
  const jpeg = await sharp(d, { raw: { width: W, height: H, channels: 3 } })
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 236, g: 72, b: 153 } })
    .jpeg({ quality: 92 }).toBuffer();
  const quad = { tl: [PAD, PAD], tr: [PAD + W - 1, PAD], br: [PAD + W - 1, PAD + H - 1], bl: [PAD, PAD + H - 1] };
  return { jpeg: jpeg, cardQuad: noCard ? null : JSON.stringify(quad) };
}

const NATIVE_META = {
  schema: 1,
  app: { version: '1.4', build: '57', bundleId: 'com.example.judge' },
  device: { model: 'iPhone15,2', systemName: 'iOS', systemVersion: '18.1' },
  camera: {
    deviceType: 'builtInWideAngleCamera', position: 'back', photoWidth: 3024, photoHeight: 4032,
    maxPhotoWidth: 6048, maxPhotoHeight: 8064, photoSizeSetting: '12mp', codec: 'jpeg',
    iso: 80, exposureDurationS: 1 / 120, zoomFactor: 1.0, focusMode: 'continuousAutoFocus', lensPosition: 0.82,
    supportedMaxPhotoDimensions: ['4032x3024', '8064x6048'],
    nested: { deeper: { tooDeep: 1 } }
  },
  capture: { mode: 'auto', capturedAt: '2026-09-29T04:00:00Z', stableFrames: 12 },
  sneaky: { password: 'x' },
  'bad key!': 1
};

async function run() {
  // ---- parser ----
  const p = sm.parseCaptureMetadata({ captureMetadata: JSON.stringify(NATIVE_META) });
  assert('known groups kept', p.error === null && p.metadata.app.build === '57' && p.metadata.device.model === 'iPhone15,2' &&
    p.metadata.camera.photoWidth === 3024 && p.metadata.capture.mode === 'auto', p);
  assert('unknown top-level groups dropped and listed', !('sneaky' in p.metadata) &&
    p.metadata.droppedKeys.indexOf('sneaky') !== -1, p.metadata.droppedKeys);
  assert('nesting capped at 3 levels', p.metadata.camera.nested && !('deeper' in p.metadata.camera.nested), p.metadata.camera.nested);
  assert('string arrays kept', Array.isArray(p.metadata.camera.supportedMaxPhotoDimensions) &&
    p.metadata.camera.supportedMaxPhotoDimensions.length === 2);
  assert('absent field → null, no error', JSON.stringify(sm.parseCaptureMetadata({})) === JSON.stringify({ metadata: null, error: null }));
  assert('not JSON → null + error', sm.parseCaptureMetadata({ captureMetadata: '{oops' }).error === 'captureMetadata is not JSON, ignored');
  assert('over 8 KB → null + error', /over 8 KB/.test(sm.parseCaptureMetadata({ captureMetadata: JSON.stringify({ app: { x: 'y'.repeat(9000) } }) }).error));
  const longStr = sm.parseCaptureMetadata({ captureMetadata: JSON.stringify({ app: { version: 'v'.repeat(500) } }) });
  assert('strings capped at 200 chars', longStr.metadata.app.version.length === 200);

  // ---- server ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-meta-'));
  process.env.JUDGE_DATA_DIR = path.join(tmp, 'data');
  process.env.JUDGE_UPLOADS_DIR = path.join(tmp, 'uploads');
  process.env.JUDGE_SCANS_DIR = path.join(tmp, 'scans');
  const { app, FAILED_SCANS_PATH, DB_PATH } = require('../server');
  const server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const log = console.log;
  const warn = console.warn;
  async function post(img, fields) {
    const fd = new FormData();
    fd.append('image', new Blob([img.jpeg], { type: 'image/jpeg' }), 'still.jpg');
    fd.append('alignmentCrop', 'true');
    if (img.cardQuad) {
      fd.append('cardQuad', img.cardQuad);
      fd.append('quadImageWidth', String(W + 2 * PAD));
      fd.append('quadImageHeight', String(H + 2 * PAD));
    }
    Object.keys(fields || {}).forEach(function (k) { fd.append(k, fields[k]); });
    console.log = function () {};
    console.warn = function () {};
    try {
      const r = await fetch(base + '/api/grade', { method: 'POST', body: fd });
      return { status: r.status, body: await r.json() };
    } finally { console.log = log; console.warn = warn; }
  }

  try {
    const card = await cardJpeg(false);
    const withMeta = await post(card, { captureMetadata: JSON.stringify(NATIVE_META) });
    const item = withMeta.body.item;
    assert('graded with metadata → 200', withMeta.status === 200 && item, withMeta.body);
    assert('item.captureMetadata stored (sanitized)', item.captureMetadata && item.captureMetadata.camera.codec === 'jpeg' &&
      item.captureMetadata.device.systemVersion === '18.1' && !('sneaky' in item.captureMetadata), item.captureMetadata);
    const s = item.serverMetadata;
    const sha = crypto.createHash('sha256').update(card.jpeg).digest('hex');
    assert('serverMetadata: route, bytes, sha256', s && s.route === '/api/grade' && s.uploadBytes === card.jpeg.length &&
      s.uploadSha256 === sha, s);
    assert('serverMetadata: decoded jpeg size', s.image && s.image.format === 'jpeg' && s.image.width === W + 2 * PAD &&
      s.image.height === H + 2 * PAD, s.image);
    assert('serverMetadata: grade time, engine, LAN, received time', typeof s.gradeMs === 'number' && s.gradeMs >= 0 &&
      s.engine && s.engine.version && s.localNetwork === true && !isNaN(Date.parse(s.receivedAt)), s);
    const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')).inventory.find(function (x) { return x.scanId === item.scanId; });
    assert('database.json item carries both metadata blocks', saved && saved.captureMetadata && saved.serverMetadata &&
      saved.serverMetadata.uploadSha256 === sha);

    const noMeta = await post(card, {});
    assert('no captureMetadata → item.captureMetadata null, serverMetadata still present',
      noMeta.status === 200 && noMeta.body.item.captureMetadata === null && noMeta.body.item.serverMetadata.uploadBytes > 0);
    const strip = function (r) {
      return JSON.stringify([r.centeringMetrics.leftRightRatio, r.centeringMetrics.topBottomRatio, r.subGrades, r.finalScore]);
    };
    assert('metadata never changes the grade', strip(noMeta.body.item.gradingReport) === strip(item.gradingReport));

    const badMeta = await post(card, { captureMetadata: '{not json' });
    assert('bad metadata → still graded, error noted in serverMetadata', badMeta.status === 200 &&
      badMeta.body.item.captureMetadata === null &&
      badMeta.body.item.serverMetadata.captureMetadataError === 'captureMetadata is not JSON, ignored', badMeta.body.item.serverMetadata);

    const noCard = await post(await cardJpeg(true), { captureMetadata: JSON.stringify(NATIVE_META) });
    const lines = fs.readFileSync(FAILED_SCANS_PATH, 'utf8').trim().split('\n');
    const failed = JSON.parse(lines[lines.length - 1]);
    assert('422 path: failed-scans line carries both metadata blocks', noCard.status === 422 && failed.scanId === noCard.body.scanId &&
      failed.captureMetadata && failed.captureMetadata.app.build === '57' && failed.serverMetadata &&
      failed.serverMetadata.uploadBytes > 0, failed);

    const dump = require('./dump_scans');
    const text = dump.formatGraded(saved);
    assert('dump shows the capture line', /capture iPhone15,2 iOS 18\.1  app 1\.4 \(57\)  photo 3024×4032 of max 6048×8064 \(12mp, jpeg\)  ISO 80 1\/120s/.test(text), text);
    assert('dump shows the server line', /server  \d+\.\d\d MB jpeg 803×1060 .*grade \d+ms  sha [0-9a-f]{12}  LAN/.test(text), text);
    assert('dump of a failed scan shows metadata too', /capture iPhone15,2/.test(dump.formatFailed(failed)));
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures) { console.error(failures + ' scan-metadata check(s) failed.'); process.exit(1); }
  console.log('All scan-metadata checks passed.');
}

run().catch(function (err) { console.error('FAIL scan-metadata run threw', err); process.exit(1); });
