/**
 * server.js
 * =============================================================================
 * Express host for The Judge pre-submission diagnostic API.
 * =============================================================================
 *
 * Grading pipeline (do not score in this file)
 * --------------------------------------------
 *   1. Multer delivers the still as `req.file.buffer` (memory) or a disk path.
 *   2. classifier_engine.js tags SPORTS | TCG | UNKNOWN.
 *   3. grading_engine.js runs still-image metrology, then the strict 4-phase
 *      Judge formula (centering / surface / edges / corners) and the
 *      0.5-point condition ceiling. See services/grading_engine.js and
 *      The Judge.swift.
 *   4. The resulting report is persisted on the inventory item and returned.
 *
 * This file must stay free of scoring math. Weights, penalties, and the
 * ceiling live only in the isolated grading engine (BusinessPlan.md §4
 * Module D / §8). Mock scoring has been removed so /api/grade and
 * /api/grade/upload cannot diverge.
 *
 * LAN HTTPS (`npm run start:lan` / `node server.js --lan`)
 * --------------------------------------------------------
 * Phone Safari blocks getUserMedia on http://. --lan mints a self-signed
 * cert covering the Mac's current `ipconfig getifaddr en0` address and
 * listens with https on 0.0.0.0 so a phone can open https://<lan-ip>:PORT.
 */

try { require('dotenv').config(); } catch (e) { /* .env / dotenv optional in local Phase 1 */ }
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const crypto = require('crypto');

const grading = require('./services/grading_engine');
const classifier = require('./services/classifier_engine');
const wallet = require('./services/wallet_engine');
const lanHttps = require('./scripts/lan_https');
const scanLevel = require('./public/scan_level');
const dumpScans = require('./scripts/dump_scans');
const testDeck = require('./services/test_deck');
const scanMetadata = require('./services/scan_metadata');
const deckReport = require('./scripts/deck_report');
const childProcess = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;
const LAN_HTTPS = process.argv.indexOf('--lan') !== -1 || process.env.LAN_HTTPS === '1';
const lanAddress = lanHttps.getLanIPv4();

/* =========================
   Middlewares
   ========================= */
app.use(helmet({
  // Allow the HTML5 camera viewport (getUserMedia) and the canvas overlay
  // to load from this origin. Default Helmet CSP would block the inline
  // scan-viewport styles in index.html on some browsers.
  contentSecurityPolicy: false,
  // Self-signed LAN certs must not pin HSTS; Safari would then refuse HTTP
  // on the same IP after `npm start` (no TLS).
  hsts: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

/* =========================
   Static files
   ========================= */
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

/* =========================
   Upload storage
   ========================= */
const uploadsDir = process.env.JUDGE_UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ts = Date.now();
    const safe = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Memory storage for the primary grading route (req.file.buffer expected)
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* =========================
   In-memory store (Phase 1)
   ========================= */
let inventory = []; // Each item: { id, name, imagePath, gradingReport, createdAt }

/**
 * Shared options parser for both grading routes.
 * cardType / debug arrive as multipart fields from public/app.js.
 * `weights` is accepted for backward compatibility but is IGNORED — the
 * Judge formula's penalties are hardcoded to The Judge.swift.
 *
 * @param {object} body
 * @returns {{ cardType?: string, debug?: boolean, captureTilt?: object }}
 */
function parseOcrLines(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

function resolveScanId(body) {
  return grading.normalizeScanId(body && body.scanId) || crypto.randomUUID();
}

function honestCardIdentity(body) {
  return {
    name: 'Unidentified',
    setName: '—',
    cardIdentity: {
      familyId: null,
      match: null,
      ocrLines: parseOcrLines(body && body.ocrLines)
    }
  };
}

function parseGradingOptions(body) {
  const opts = {};
  if (!body) return opts;
  if (body.cardType) opts.cardType = body.cardType;
  if (body.debug) opts.debug = body.debug === 'true' || body.debug === '1';
  const tilt = scanLevel.parseCaptureTilt(body);
  if (tilt) opts.captureTilt = tilt;
  if (scanLevel.parseAlignmentCrop(body)) opts.alignmentCrop = true;
  const scanId = grading.normalizeScanId(body.scanId);
  if (scanId) opts.scanId = scanId;
  if (body.cardQuad) opts.cardQuad = body.cardQuad;
  if (body.quadImageWidth) opts.quadImageWidth = Number(body.quadImageWidth);
  if (body.quadImageHeight) opts.quadImageHeight = Number(body.quadImageHeight);
  if (body.quadConfidence) opts.quadConfidence = Number(body.quadConfidence);
  return opts;
}

/**
 * Append one line per rejected scan to data/failed_scans.jsonl. Card-not-found
 * scans are never written to inventory, so this is the only trace of them.
 */
function logFailedScan(entry) {
  try {
    const dir = path.dirname(FAILED_SCANS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(FAILED_SCANS_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('Failed to append failed_scans.jsonl', e);
  }
}

function respondCardNotFound(res, args) {
  const report = args.report;
  const reason = report.cardNotFoundReason || 'card not found';
  const label = labelFromCapture(args.scanId, args.body);
  logFailedScan({
    scanId: args.scanId,
    timestamp: new Date().toISOString(),
    engine: ENGINE,
    deckId: label && label.deckId ? label.deckId : null,
    route: args.route,
    reason: reason,
    imagePath: args.imagePath || null,
    debugDir: report.debugArtifacts && report.debugArtifacts.dir ? report.debugArtifacts.dir : null,
    captureTilt: report.captureTilt || null,
    captureMetadata: args.captureMetadata || null,
    serverMetadata: args.serverMetadata || null,
    diagnostics: report.cardDetection || null
  });
  console.log('[grade] scanId=' + args.scanId + ' card not found: ' + reason);
  return res.status(422).json({
    ok: false,
    error: 'card not found',
    reason: reason,
    scanId: args.scanId,
    report: report
  });
}

/**
 * Persist a graded item into the in-memory list and data/database.json,
 * incrementing the SPORTS / TCG / UNKNOWN counter used by the dashboard.
 *
 * @param {object} item
 * @param {string} classification
 */
function persistGradedItem(item, classification) {
  // One record per scanId: a repeated upload replaces, never duplicates.
  const sameScan = function (other) { return other && item.scanId && other.scanId === item.scanId; };
  inventory = inventory.filter(function (other) { return !sameScan(other); });
  inventory.unshift(item);

  const db = loadDatabase();
  db.inventory = db.inventory || [];
  const replacing = db.inventory.some(sameScan);
  db.inventory = db.inventory.filter(function (other) { return !sameScan(other); });
  db.inventory.unshift(item);
  const key = (classification && typeof classification === 'string') ? classification.toUpperCase() : 'UNKNOWN';
  db.categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
  if (!Object.prototype.hasOwnProperty.call(db.categoryCounts, key)) db.categoryCounts[key] = 0;
  if (!replacing) db.categoryCounts[key] = (db.categoryCounts[key] || 0) + 1;
  saveDatabase(db);
}

/* =========================
   Simple JSON "DB" helpers (data/database.json)
   Maintains db.inventory and db.categoryCounts { SPORTS, TCG, UNKNOWN }
   ========================= */
const DATA_DIR = process.env.JUDGE_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'database.json');
const FAILED_SCANS_PATH = path.join(DATA_DIR, 'failed_scans.jsonl');
const SCANS_DIR = process.env.JUDGE_SCANS_DIR || path.join(__dirname, 'scans');
const deckStore = testDeck.createStore(DATA_DIR);

/** Engine identity stamped on every saved grade and failed attempt. */
const ENGINE = (function () {
  let commit = process.env.JUDGE_ENGINE_COMMIT || null;
  if (!commit) {
    try {
      commit = childProcess.execSync('git rev-parse --short HEAD', {
        cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore']
      }).toString().trim() || null;
    } catch (e) { commit = null; }
  }
  return { version: grading.ENGINE_VERSION, commit: commit };
})();

/** App-reported + server-observed metadata for one upload (recorded, never graded). */
async function scanMetadataFor(req, args) {
  const parsed = scanMetadata.parseCaptureMetadata(req.body);
  if (parsed.error) console.warn('[metadata] ' + parsed.error);
  const serverMetadata = await scanMetadata.buildServerMetadata(Object.assign({}, args, {
    engine: ENGINE,
    userAgent: req.get('user-agent'),
    localNetwork: isLocalNetworkAddress(req.socket && req.socket.remoteAddress),
    captureMetadataError: parsed.error
  }));
  return { captureMetadata: parsed.metadata, serverMetadata: serverMetadata };
}

/** Deck / pre-submission fields sent with a Capture. */
function captureLabelFields(body) {
  const fields = {};
  if (body && body.deckId) fields.deckId = body.deckId;
  if (body && body.preSubmission != null && body.preSubmission !== '') fields.preSubmission = body.preSubmission;
  return fields;
}

function labelFromCapture(scanId, body) {
  const fields = captureLabelFields(body);
  if (!Object.keys(fields).length) return null;
  const res = deckStore.labelScan(scanId, fields, 'capture');
  if (!res.ok) console.warn('[deck] label ignored for ' + scanId + ': ' + res.error);
  return res.ok ? res.label : null;
}
function loadDatabase() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.inventory)) db.inventory = [];
    if (!db.categoryCounts || typeof db.categoryCounts !== 'object') {
      db.categoryCounts = { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    } else {
      db.categoryCounts.SPORTS = db.categoryCounts.SPORTS || 0;
      db.categoryCounts.TCG = db.categoryCounts.TCG || 0;
      db.categoryCounts.UNKNOWN = db.categoryCounts.UNKNOWN || 0;
    }
    return db;
  } catch (e) {
    return { inventory: [], categoryCounts: { SPORTS: 0, TCG: 0, UNKNOWN: 0 } };
  }
}
function saveDatabase(db) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db.inventory = db.inventory || [];
    db.categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    broadcastStats();
  } catch (e) {
    console.error('Failed to save database.json', e);
  }
}

/* =========================
   Server-Sent Events (SSE)
   ========================= */
const sseClients = new Set();

function sendSse(res, eventName, data) {
  try {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // ignore
  }
}

/**
 * Dashboard stats. inventorySize counts graded cards only (a final grade on a
 * located card); savedScans counts every saved scan.
 */
function statsFor(inventoryArray, categoryCounts, walletStats) {
  return {
    inventorySize: walletStats.gradedCount,
    savedScans: inventoryArray.length,
    categoryCounts: categoryCounts,
    wallet: walletStats
  };
}

function broadcastStats() {
  try {
    const db = loadDatabase();
    const inventoryArray = Array.isArray(db.inventory) ? db.inventory : [];
    const categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    const walletStats = wallet.portfolioStats(inventoryArray);
    const payload = { ok: true, stats: statsFor(inventoryArray, categoryCounts, walletStats) };
    for (const client of sseClients) {
      sendSse(client, 'stats', payload);
    }
  } catch (e) {
    console.error('Failed to broadcast stats', e);
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  res.write(': connected\n\n');
  sseClients.add(res);

  try {
    const db = loadDatabase();
    const inventoryArray = Array.isArray(db.inventory) ? db.inventory : [];
    const categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    const walletStats = wallet.portfolioStats(inventoryArray);
    const payload = { ok: true, stats: statsFor(inventoryArray, categoryCounts, walletStats) };
    sendSse(res, 'stats', payload);
  } catch (e) { /* ignore */ }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

/* =========================
   API Routes
   ========================= */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development' });
});

function handleAuth(req, res) {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  return res.json({ ok: true, username, token: `phase1-token-${username}` });
}
app.post('/api/auth/signup', handleAuth);
app.post('/api/auth/login', handleAuth);
// Aliases matching public/app.js field names (signup / login)
app.post('/api/auth/signup', handleAuth);
app.post('/api/auth/login', handleAuth);

app.get('/api/inventory', (req, res) => {
  res.json({ ok: true, inventory });
});

app.get('/api/categories', (req, res) => {
  try {
    const db = loadDatabase();
    return res.json({ ok: true, categoryCounts: db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 } });
  } catch (e) {
    return res.status(500).json({ error: 'failed to load category counts' });
  }
});

app.get('/api/wallet/stats', (req, res) => {
  try {
    const db = loadDatabase();
    const items = Array.isArray(db.inventory) ? db.inventory : [];
    const stats = wallet.portfolioStats(items);
    return res.json({ ok: true, stats });
  } catch (e) {
    console.error('Failed to compute wallet stats', e);
    return res.status(500).json({ error: 'failed to compute wallet stats' });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const db = loadDatabase();
    const inventoryArray = Array.isArray(db.inventory) ? db.inventory : [];
    const categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    const walletStats = wallet.portfolioStats(inventoryArray);
    return res.json({ ok: true, stats: statsFor(inventoryArray, categoryCounts, walletStats) });
  } catch (e) {
    console.error('Failed to compute unified stats', e);
    return res.status(500).json({ error: 'failed to compute stats' });
  }
});

/**
 * POST /api/grade
 * Primary scan route used by the HTML5 camera viewport in public/app.js.
 *
 * Body (multipart/form-data):
 *   image     file buffer (required)
 *   scanId    optional client UUID (echoed on item.scanId and logged)
 *   cardQuad  optional JSON {tl,tr,br,bl} card corners in image pixels
 *             (quadImageWidth / quadImageHeight / quadConfidence alongside)
 *   name      ignored for identity (title is Unidentified until family match)
 *   cardType  optional SPORTS | TCG (reserved for Phase 3 corner templates)
 *   debug     optional "true" to attach metrology dumps
 *   captureMetadata optional JSON {schema, app, device, camera, capture} from
 *             the native app; stored as item.captureMetadata (never graded).
 *             The server adds item.serverMetadata itself.
 *
 * Response: { ok: true, item } where item.gradingReport is the Judge payload
 * from services/grading_engine.js (10-point finalScore + 0–100 projections).
 * No card found: HTTP 422 { ok: false, error: 'card not found', reason,
 * scanId, report } — nothing is saved to inventory; the attempt is appended
 * to data/failed_scans.jsonl.
 */
const gradeUpload = memoryUpload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'sweep', maxCount: 8 }
]);

app.post('/api/grade', gradeUpload, async (req, res) => {
  try {
    const receivedAt = new Date().toISOString();
    const imageFile = req.files && req.files.image && req.files.image[0];
    if (!imageFile || !imageFile.buffer) return res.status(400).json({ error: 'image buffer required' });
    const opts = parseGradingOptions(req.body);
    const scanId = resolveScanId(req.body);
    opts.scanId = scanId;
    opts.scansRoot = SCANS_DIR;

    const ts = Date.now();
    const orig = imageFile.originalname || 'upload';
    const safe = String(orig).replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    const filename = `${ts}_${safe}`;
    const filePath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(filePath, imageFile.buffer);

    // 1) Classify the card (SPORTS | TCG | UNKNOWN)
    const classification = await classifier.classifyBuffer(imageFile.buffer, { filename: orig });

    // 2) Strict 4-phase Judge pipeline (centering / surface / edges / corners + 0.5 ceiling)
    const gradeStart = Date.now();
    const report = await grading.gradeBuffer(imageFile.buffer, opts);
    const meta = await scanMetadataFor(req, {
      buffer: imageFile.buffer, file: imageFile, route: '/api/grade', receivedAt: receivedAt,
      gradeMs: Date.now() - gradeStart, sweepFrames: ((req.files && req.files.sweep) || []).length
    });
    report.scanId = scanId;
    if (report.cardNotFound) {
      return respondCardNotFound(res, Object.assign({
        report: report, scanId: scanId, route: '/api/grade', imagePath: `/uploads/${filename}`, body: req.body
      }, meta));
    }

    const sweepFiles = (req.files && req.files.sweep) || [];
    const sweepMeta = scanLevel.parseSweepMeta(req.body);
    const extraFrames = sweepFiles.map(function (file, i) {
      const meta = sweepMeta[i] || {};
      return {
        buffer: file.buffer,
        bin: meta.bin || null,
        pitch: meta.pitch,
        roll: meta.roll
      };
    });
    await grading.applySurfaceSweep(report, extraFrames, {
      alignmentCrop: Boolean(opts.alignmentCrop),
      levelTilt: opts.captureTilt
    });

    const identity = honestCardIdentity(req.body);
    report.scanId = scanId;
    const item = {
      id: scanId,
      scanId: scanId,
      name: identity.name,
      setName: identity.setName,
      cardIdentity: identity.cardIdentity,
      imagePath: `/uploads/${filename}`,
      category: classification,
      gradingReport: report,
      engine: ENGINE,
      captureMetadata: meta.captureMetadata,
      serverMetadata: meta.serverMetadata,
      createdAt: new Date().toISOString()
    };

    console.log('[grade] scanId=' + scanId + ' finalScore=' + report.finalScore + ' incomplete=' + Boolean(report.incomplete));
    const label = labelFromCapture(scanId, req.body);
    if (label && label.deckId) item.deckId = label.deckId;
    persistGradedItem(item, classification);
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('Grading/classification error', err);
    return res.status(500).json({ error: err.message || 'grading failed' });
  }
});

/**
 * POST /api/grade/upload
 * Legacy disk-backed route. Same Judge pipeline as /api/grade: the file is
 * read back into a buffer and passed to grading_engine.gradeBuffer. Mock
 * scoring has been removed so both routes cannot diverge.
 */
app.post('/api/grade/upload', upload.single('image'), async (req, res) => {
  try {
    const receivedAt = new Date().toISOString();
    if (!req.file) return res.status(400).json({ error: 'image file is required' });
    const opts = parseGradingOptions(req.body);
    const scanId = resolveScanId(req.body);
    opts.scanId = scanId;
    opts.scansRoot = SCANS_DIR;
    const buffer = await fs.promises.readFile(req.file.path);
    const orig = req.file.originalname || path.basename(req.file.path);
    const classification = await classifier.classifyBuffer(buffer, { filename: orig });
    const gradeStart = Date.now();
    const report = await grading.gradeBuffer(buffer, opts);
    const meta = await scanMetadataFor(req, {
      buffer: buffer, file: req.file, route: '/api/grade/upload', receivedAt: receivedAt, gradeMs: Date.now() - gradeStart
    });
    report.scanId = scanId;
    if (report.cardNotFound) {
      return respondCardNotFound(res, Object.assign({
        report: report, scanId: scanId, route: '/api/grade/upload',
        imagePath: `/uploads/${path.basename(req.file.path)}`, body: req.body
      }, meta));
    }
    await grading.applySurfaceSweep(report, [], {
      alignmentCrop: Boolean(opts.alignmentCrop),
      levelTilt: opts.captureTilt
    });

    const identity = honestCardIdentity(req.body);
    report.scanId = scanId;
    const item = {
      id: scanId,
      scanId: scanId,
      name: identity.name,
      setName: identity.setName,
      cardIdentity: identity.cardIdentity,
      imagePath: `/uploads/${path.basename(req.file.path)}`,
      category: classification,
      gradingReport: report,
      engine: ENGINE,
      captureMetadata: meta.captureMetadata,
      serverMetadata: meta.serverMetadata,
      createdAt: new Date().toISOString()
    };

    console.log('[grade] scanId=' + scanId + ' finalScore=' + report.finalScore + ' incomplete=' + Boolean(report.incomplete));
    const label = labelFromCapture(scanId, req.body);
    if (label && label.deckId) item.deckId = label.deckId;
    persistGradedItem(item, classification);
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('Legacy grade/upload error', err);
    return res.status(500).json({ error: err.message || 'grading failed' });
  }
});

/* =========================
   Debug views (read-only, local network only)
   ========================= */

/** Loopback, RFC1918, link-local, or IPv6 ULA/link-local peer. Uses the socket
 *  address, not X-Forwarded-For, so a proxy header cannot widen access. */
function isLocalNetworkAddress(raw) {
  let ip = String(raw || '').toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  return false;
}

function localNetworkOnly(req, res, next) {
  if (isLocalNetworkAddress(req.socket && req.socket.remoteAddress)) return next();
  return res.status(403).type('text/plain').send('Debug views are local-network only.');
}

const DEBUG_ARTIFACT_FILES = { 'oriented.jpg': 'image/jpeg', 'debug.json': 'application/json' };

app.get('/scans/:scanId/:file', localNetworkOnly, (req, res) => {
  const scanId = grading.normalizeScanId(req.params.scanId);
  const type = DEBUG_ARTIFACT_FILES[req.params.file];
  if (!scanId || !type) return res.status(404).type('text/plain').send('not found');
  const filePath = path.join(SCANS_DIR, scanId, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).type('text/plain').send('not found');
  res.type(type);
  return res.sendFile(filePath);
});

app.get('/api/debug/scan/:scanId', localNetworkOnly, (req, res) => {
  const scanId = grading.normalizeScanId(req.params.scanId);
  const text = scanId ? dumpScans.formatScanById(DATA_DIR, scanId) : null;
  if (!text) return res.status(404).json({ ok: false, error: 'scan not found' });
  return res.json({ ok: true, scanId: scanId, text: text });
});

function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

app.get('/debug/recent', localNetworkOnly, (req, res) => {
  const n = Math.max(1, Math.min(50, Number(req.query.n) || 5));
  const text = dumpScans.formatScans(DATA_DIR, n);
  if (req.query.format === 'text') return res.type('text/plain').send(text);
  return res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Judge — last ${n} scans</title>
<style>
  body { background:#0b1220; color:#e6edf3; font-family:-apple-system,system-ui,sans-serif; margin:12px; }
  pre { white-space:pre-wrap; word-break:break-word; font:12px/1.4 ui-monospace,Menlo,monospace; background:#050a14; padding:10px; border-radius:8px; }
  button { font-size:16px; padding:10px 14px; border-radius:8px; border:0; background:#00d4ff; color:#001; }
  a { color:#7dd3fc; }
</style></head><body>
<p>Last ${n} scans · <a href="?n=5">5</a> · <a href="?n=10">10</a> · <a href="?n=25">25</a> · <a href="?n=${n}&format=text">plain text</a></p>
<p><button id="copy">Copy all</button> <span id="status"></span></p>
<pre id="dump">${escapeHtmlText(text)}</pre>
<script>
document.getElementById('copy').addEventListener('click', function () {
  var text = document.getElementById('dump').textContent;
  var status = document.getElementById('status');
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    status.textContent = ok ? 'Copied.' : 'Select the text below and copy.';
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function () { status.textContent = 'Copied.'; }, fallback);
  } else { fallback(); }
});
</script></body></html>`);
});

/* =========================
   Test deck + PSA ground truth (local network only)
   ========================= */

function scanExists(scanId) {
  return Boolean(dumpScans.formatScanById(DATA_DIR, scanId));
}

app.get('/api/deck', localNetworkOnly, (req, res) => {
  return res.json({
    ok: true,
    categories: testDeck.DECK_CATEGORIES,
    cards: deckStore.loadDeck().cards,
    labels: deckStore.loadLabels().scans,
    engine: ENGINE
  });
});

app.put('/api/deck/cards/:deckId', localNetworkOnly, (req, res) => {
  const out = deckStore.upsertCard(req.params.deckId, req.body || {});
  return out.ok ? res.json(out) : res.status(400).json(out);
});

app.put('/api/scans/:scanId/label', localNetworkOnly, (req, res) => {
  const scanId = grading.normalizeScanId(req.params.scanId);
  if (!scanId || !scanExists(scanId)) return res.status(404).json({ ok: false, error: 'scan not found' });
  const out = deckStore.labelScan(scanId, req.body || {}, 'web');
  return out.ok ? res.json(out) : res.status(400).json(out);
});

function copyablePage(title, text, extraHtml) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlText(title)}</title>
<style>
  body { background:#0b1220; color:#e6edf3; font-family:-apple-system,system-ui,sans-serif; margin:12px; }
  pre { white-space:pre-wrap; word-break:break-word; font:12px/1.4 ui-monospace,Menlo,monospace; background:#050a14; padding:10px; border-radius:8px; }
  button { font-size:15px; padding:8px 12px; border-radius:8px; border:0; background:#00d4ff; color:#001; }
  a { color:#7dd3fc; } input, select { font-size:14px; padding:4px; background:#050a14; color:#e6edf3; border:1px solid #334; border-radius:6px; }
  table { border-collapse:collapse; width:100%; font-size:13px; } td, th { border-bottom:1px solid #223; padding:4px; text-align:left; vertical-align:top; }
</style></head><body>
${extraHtml || ''}
${text != null ? `<p><button id="copy">Copy all</button> <span id="status"></span></p><pre id="dump">${escapeHtmlText(text)}</pre>
<script>
document.getElementById('copy').addEventListener('click', function () {
  var text = document.getElementById('dump').textContent, status = document.getElementById('status');
  function fallback() { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta);
    status.textContent = ok ? 'Copied.' : 'Select the text below and copy.'; }
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { status.textContent = 'Copied.'; }, fallback);
  else fallback();
});
</script>` : ''}
</body></html>`;
}

app.get('/deck/report', localNetworkOnly, async (req, res) => {
  try {
    const out = await deckReport.buildDeckReport({ dataDir: DATA_DIR, uploadsDir: uploadsDir });
    if (req.query.format === 'text') return res.type('text/plain').send(out.text);
    return res.type('html').send(copyablePage('The Judge — test deck report', out.text,
      '<p><a href="/deck">Deck registry &amp; scan labels</a> · <a href="/deck/report?format=text">plain text</a></p>'));
  } catch (err) {
    return res.status(500).type('text/plain').send('deck report failed: ' + (err && err.message));
  }
});

app.get('/deck', localNetworkOnly, (req, res) => {
  return res.type('html').send(copyablePage('The Judge — test deck', null, `
<h2>Test deck</h2>
<p><a href="/deck/report">Deck report</a> · <a href="/debug/recent?n=10">Recent scans dump</a></p>
<h3>Recent scans — assign deck card / pre-submission / PSA result</h3>
<table id="scans"><thead><tr><th>Time</th><th>Scan</th><th>Result</th><th>Deck</th><th>Pre-sub</th><th>PSA</th><th>Cert</th><th></th></tr></thead><tbody></tbody></table>
<h3>Deck cards</h3>
<table id="cards"><thead><tr><th>ID</th><th>Category</th><th>Title</th><th>Expect</th><th>Ruler mm L R T B</th><th>Known PSA</th><th>Notes</th><th></th></tr></thead><tbody></tbody></table>
<script>
(async function () {
  const deck = await fetch('/api/deck').then(function (r) { return r.json(); });
  const recent = await fetch('/api/deck/recent-scans').then(function (r) { return r.json(); });
  const cats = deck.categories;
  function el(tag, attrs, text) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (text != null) e.textContent = text; return e; }
  function input(value, size) { return el('input', { value: value == null ? '' : value, size: size || 6 }); }
  const sb = document.querySelector('#scans tbody');
  recent.scans.forEach(function (s) {
    const l = deck.labels[s.scanId] || {};
    const tr = el('tr');
    const deckIn = input(l.deckId, 6); deckIn.placeholder = 'TD-01';
    const pre = el('input', { type: 'checkbox', checked: Boolean(l.preSubmission) });
    const psa = input(l.psaGrade, 4); const cert = input(l.psaCert, 10);
    const status = el('span');
    const save = el('button', {}, 'Save');
    save.addEventListener('click', async function () {
      const body = { deckId: deckIn.value || null, preSubmission: pre.checked, psaGrade: psa.value || null, psaCert: cert.value || null };
      const r = await fetch('/api/scans/' + encodeURIComponent(s.scanId) + '/label', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (x) { return x.json(); });
      status.textContent = r.ok ? ' saved' : ' ' + r.error;
    });
    [s.time, s.scanId.slice(0, 8).toUpperCase(), s.summary].forEach(function (t) { tr.appendChild(el('td', {}, t)); });
    [deckIn, pre, psa, cert].forEach(function (c) { const td = el('td'); td.appendChild(c); tr.appendChild(td); });
    const td = el('td'); td.appendChild(save); td.appendChild(status); tr.appendChild(td);
    sb.appendChild(tr);
  });
  const cb = document.querySelector('#cards tbody');
  function cardRow(id, c) {
    c = c || {};
    const tr = el('tr');
    const idIn = input(id, 6); idIn.placeholder = 'TD-01';
    const cat = el('select'); cat.appendChild(el('option', { value: '' }, '—'));
    cats.forEach(function (k) { cat.appendChild(el('option', { value: k.id, selected: c.category === k.id }, k.label)); });
    const title = input(c.title, 22);
    const exp = el('select'); ['', 'measured', 'undetectable', 'offcenter'].forEach(function (v) { exp.appendChild(el('option', { value: v, selected: (c.expect || '') === v }, v || 'category default')); });
    const mm = c.physicalMm || {};
    const L = input(mm.left, 3), R = input(mm.right, 3), T = input(mm.top, 3), B = input(mm.bottom, 3);
    const known = input(c.knownPsaGrade, 3); const notes = input(c.notes, 22);
    const status = el('span'); const save = el('button', {}, 'Save');
    save.addEventListener('click', async function () {
      const body = { category: cat.value || null, title: title.value || null, expect: exp.value || null,
        physicalMm: { left: L.value, right: R.value, top: T.value, bottom: B.value }, knownPsaGrade: known.value || null, notes: notes.value || null };
      const r = await fetch('/api/deck/cards/' + encodeURIComponent(idIn.value), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (x) { return x.json(); });
      status.textContent = r.ok ? ' saved' : ' ' + r.error;
    });
    const mmTd = el('td'); [L, R, T, B].forEach(function (x) { mmTd.appendChild(x); });
    [idIn, cat, title, exp].forEach(function (x) { const td = el('td'); td.appendChild(x); tr.appendChild(td); });
    tr.appendChild(mmTd);
    [known, notes].forEach(function (x) { const td = el('td'); td.appendChild(x); tr.appendChild(td); });
    const td = el('td'); td.appendChild(save); td.appendChild(status); tr.appendChild(td);
    cb.appendChild(tr);
  }
  Object.keys(deck.cards).sort(function (a, b) { return Number(a.slice(3)) - Number(b.slice(3)); }).forEach(function (id) { cardRow(id, deck.cards[id]); });
  cardRow('', {});
})();
</script>`));
});

app.get('/api/deck/recent-scans', localNetworkOnly, (req, res) => {
  const n = Math.max(1, Math.min(100, Number(req.query.n) || 30));
  const graded = dumpScans.loadGradedItems(DATA_DIR).map(function (item) {
    const r = deckReport.resultFromReport(item.gradingReport);
    return {
      scanId: String(item.scanId || item.id), time: item.createdAt,
      summary: r.measured ? 'L/R ' + r.lr.toFixed(1) + ' T/B ' + r.tb.toFixed(1) + ' CEN ' + (r.cen == null ? '—' : r.cen) : r.status
    };
  });
  const failed = dumpScans.loadFailedEntries(DATA_DIR).map(function (e) {
    return { scanId: String(e.scanId), time: e.timestamp, summary: 'card not found' };
  });
  const all = graded.concat(failed).sort(function (a, b) { return Date.parse(b.time) - Date.parse(a.time); }).slice(0, n);
  return res.json({ ok: true, scans: all });
});

/* Serve uploaded images statically. In production, serve from secure storage/CDN. */
app.use('/uploads', express.static(uploadsDir));

/**
 * iOS/Safari: download the self-signed LAN cert so the phone can trust
 * https://<en0-ip> and grant camera permission. Only present in --lan mode.
 */
app.get('/lan-ca.cer', (req, res) => {
  if (!LAN_HTTPS || !fs.existsSync(lanHttps.CERT_PATH)) {
    return res.status(404).type('text/plain').send('LAN certificate is only available during npm run start:lan');
  }
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="the-judge-lan.cer"');
  return res.sendFile(lanHttps.CERT_PATH);
});

/* Fallback: serve index.html for client-side routing */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

function logHttpReady() {
  console.log(`Server is running locally at http://localhost:${PORT}`);
  console.log(`Server is accessible on your network at http://${lanAddress.ip}:${PORT}`);
  console.log(`LAN address source: ${lanAddress.source}`);
  console.log('Phone camera (Safari) needs HTTPS — use npm run start:lan');
}

function logHttpsReady() {
  const phoneUrl = `https://${lanAddress.ip}:${PORT}`;
  console.log('The Judge LAN HTTPS is running (self-signed).');
  console.log(`  Local:  https://localhost:${PORT}`);
  console.log(`  Phone:  ${phoneUrl}`);
  console.log(`  Cert:   ${lanAddress.source}` + (lanAddress.usedEn0 ? '' : '  (en0 had no IPv4; cert still covers this address)'));
  console.log('Safari will warn about the certificate — tap Advanced → Proceed so getUserMedia can run.');
  console.log(`Optional iOS install: ${phoneUrl}/lan-ca.cer  then Settings → Profile Downloaded → Install,`);
  console.log('then Settings → General → About → Certificate Trust Settings → enable The Judge LAN.');
}

function ensureDatabaseFile() {
  if (fs.existsSync(DB_PATH)) return;
  saveDatabase({ inventory: [], categoryCounts: { SPORTS: 0, TCG: 0, UNKNOWN: 0 } });
  console.log('Created empty ' + DB_PATH);
}

function startServer() {
  ensureDatabaseFile();
  if (LAN_HTTPS) {
    let tls;
    try {
      tls = lanHttps.ensureLanCertificate(lanAddress.ip);
    } catch (err) {
      console.error('Failed to mint the LAN HTTPS certificate:', err && err.message ? err.message : err);
      process.exit(1);
    }
    https.createServer({ key: tls.key, cert: tls.cert }, app).listen(PORT, '0.0.0.0', () => {
      logHttpsReady();
    });
  } else {
    app.listen(PORT, '0.0.0.0', logHttpReady);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, DB_PATH, FAILED_SCANS_PATH, SCANS_DIR, ensureDatabaseFile, isLocalNetworkAddress };
