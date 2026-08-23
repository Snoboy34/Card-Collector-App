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
 */

try { require('dotenv').config(); } catch (e) { /* .env / dotenv optional in local Phase 1 */ }
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');

const grading = require('./services/grading_engine');
const classifier = require('./services/classifier_engine');
const wallet = require('./services/wallet_engine');

const app = express();
const PORT = process.env.PORT || 5000;

/* =========================
   Middlewares
   ========================= */
app.use(helmet({
  // Allow the HTML5 camera viewport (getUserMedia) and the canvas overlay
  // to load from this origin. Default Helmet CSP would block the inline
  // scan-viewport styles in index.html on some browsers.
  contentSecurityPolicy: false
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
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

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
 * @returns {{ cardType?: string, debug?: boolean }}
 */
function parseGradingOptions(body) {
  const opts = {};
  if (!body) return opts;
  if (body.cardType) opts.cardType = body.cardType;
  if (body.debug) opts.debug = body.debug === 'true' || body.debug === '1';
  return opts;
}

/**
 * Persist a graded item into the in-memory list and data/database.json,
 * incrementing the SPORTS / TCG / UNKNOWN counter used by the dashboard.
 *
 * @param {object} item
 * @param {string} classification
 */
function persistGradedItem(item, classification) {
  inventory.unshift(item);

  const db = loadDatabase();
  db.inventory = db.inventory || [];
  db.inventory.unshift(item);
  const key = (classification && typeof classification === 'string') ? classification.toUpperCase() : 'UNKNOWN';
  db.categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
  if (!Object.prototype.hasOwnProperty.call(db.categoryCounts, key)) db.categoryCounts[key] = 0;
  db.categoryCounts[key] = (db.categoryCounts[key] || 0) + 1;
  saveDatabase(db);
}

/* =========================
   Simple JSON "DB" helpers (data/database.json)
   Maintains db.inventory and db.categoryCounts { SPORTS, TCG, UNKNOWN }
   ========================= */
const DB_PATH = path.join(__dirname, 'data', 'database.json');
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

function broadcastStats() {
  try {
    const db = loadDatabase();
    const inventoryArray = Array.isArray(db.inventory) ? db.inventory : [];
    const categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    const walletStats = wallet.portfolioStats(inventoryArray);
    const payload = { ok: true, stats: { inventorySize: inventoryArray.length, categoryCounts, wallet: walletStats } };
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
    const payload = { ok: true, stats: { inventorySize: inventoryArray.length, categoryCounts, wallet: walletStats } };
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
    return res.json({ ok: true, stats: { inventorySize: inventoryArray.length, categoryCounts, wallet: walletStats } });
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
 *   name      optional display name
 *   cardType  optional SPORTS | TCG (reserved for Phase 3 corner templates)
 *   debug     optional "true" to attach metrology dumps
 *
 * Response: { ok: true, item } where item.gradingReport is the Judge payload
 * from services/grading_engine.js (10-point finalScore + 0–100 projections).
 */
app.post('/api/grade', memoryUpload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'image buffer required' });
    const opts = parseGradingOptions(req.body);

    const ts = Date.now();
    const orig = req.file.originalname || 'upload';
    const safe = String(orig).replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    const filename = `${ts}_${safe}`;
    const filePath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(filePath, req.file.buffer);

    // 1) Classify the card (SPORTS | TCG | UNKNOWN)
    const classification = await classifier.classifyBuffer(req.file.buffer, { filename: orig });

    // 2) Strict 4-phase Judge pipeline (centering / surface / edges / corners + 0.5 ceiling)
    const report = await grading.gradeBuffer(req.file.buffer, opts);

    const item = {
      id: String(Date.now()),
      name: req.body.name || safe || 'Untitled Card',
      imagePath: `/uploads/${filename}`,
      category: classification,
      gradingReport: report,
      createdAt: new Date().toISOString()
    };

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
    if (!req.file) return res.status(400).json({ error: 'image file is required' });
    const opts = parseGradingOptions(req.body);
    const buffer = await fs.promises.readFile(req.file.path);
    const orig = req.file.originalname || path.basename(req.file.path);
    const classification = await classifier.classifyBuffer(buffer, { filename: orig });
    const report = await grading.gradeBuffer(buffer, opts);

    const item = {
      id: String(Date.now()),
      name: req.body.name || 'Untitled Card',
      imagePath: `/uploads/${path.basename(req.file.path)}`,
      category: classification,
      gradingReport: report,
      createdAt: new Date().toISOString()
    };

    persistGradedItem(item, classification);
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('Legacy grade/upload error', err);
    return res.status(500).json({ error: err.message || 'grading failed' });
  }
});

/* Serve uploaded images statically. In production, serve from secure storage/CDN. */
app.use('/uploads', express.static(uploadsDir));

/* Fallback: serve index.html for client-side routing */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running locally at http://localhost:${PORT}`);
  console.log(`Server is accessible on your network at http://192.168.68.77:${PORT}`);
});
