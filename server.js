/**
 * server.js
 * Phase 1 Express server: serves static frontend and placeholder APIs for auth and grading.
 *
 * Notes:
 * - Phase 1 uses in-memory placeholders. Persistence (DB) should be added in Phase 2.
 * - The grading endpoint uses services/grading_engine.js and memory-buffer uploads via multer 2.x.
 * - Multer 2.x breaking changes: Default export, middleware behavior unchanged for storage config.
 */

require('dotenv').config();
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
const PORT = process.env.PORT || 3000;

/* =========================
   Middlewares
   ========================= */
app.use(helmet());
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
   Upload storage (local, Phase 1)
   ========================= */
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // keep simple, in production use UUIDs
    const ts = Date.now();
    const safe = file.originalname.replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Memory storage for grading route (req.file.buffer expected)
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* =========================
   In-memory store (Phase 1)
   ========================= */
let inventory = []; // Each item: { id, name, imagePath, gradingReport, createdAt }

/* =========================
   Helper: Mock grading function (replace in Phase 2)
   ========================= */
function mockGradeImage(filePath) {
  // Return deterministic-ish mock scores and a computed final grade.
  // In Phase 2, call your CV pipeline here and compute real subgrades.
  const rand = () => Math.floor(75 + Math.random() * 25); // 75..99
  const centering = rand();
  const corners = rand();
  const edges = rand();
  const surface = rand();

  // Weighted formula (example): centering 25%, corners 25%, edges 25%, surface 25%
  const weighted = Math.round((centering + corners + edges + surface) / 4);

  // Map to a "grade" label for Phase 1:
  const label = weighted >= 95 ? 'Gem Mint' : weighted >= 90 ? 'Mint' : weighted >= 80 ? 'Near Mint' : weighted >= 70 ? 'Excellent' : 'Good';

  return {
    centering,
    corners,
    edges,
    surface,
    weighted,
    label,
    notes: 'This is a mock report — replace with the real CV scoring engine in Phase 2.'
  };
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
    // Ensure shape
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
    // Ensure we don't write undefined shapes
    db.inventory = db.inventory || [];
    db.categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    // After saving, broadcast stats to any SSE clients
    broadcastStats();
  } catch (e) {
    console.error('Failed to save database.json', e);
  }
}

/* =========================
   Server-Sent Events (SSE) support
   Clients can connect to /api/events to receive live stats updates
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
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // Send a comment to keep connection alive
  res.write(': connected\n\n');

  // Add to clients
  sseClients.add(res);

  // Send initial stats immediately
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

/* Health */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'development' });
});

/* Auth placeholders */
app.post('/api/auth/signup', (req, res) => {
  // Minimal placeholder: in Phase 2, persist users and hashed passwords.
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  // Return a fake token (in production, return JWT/session)
  return res.json({ ok: true, username, token: `phase1-token-${username}` });
});

app.post('/api/auth/login', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  return res.json({ ok: true, username, token: `phase1-token-${username}` });
});

/* Inventory endpoints (Phase 1: in-memory) */
app.get('/api/inventory', (req, res) => {
  res.json({ ok: true, inventory });
});

/* Category counts endpoint - returns live counters from data/database.json */
app.get('/api/categories', (req, res) => {
  try {
    const db = loadDatabase();
    return res.json({ ok: true, categoryCounts: db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 } });
  } catch (e) {
    return res.status(500).json({ error: 'failed to load category counts' });
  }
});

/* Wallet stats: returns total combined value and breakdown per category */
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

/* Unified stats endpoint: inventory size, categoryCounts, wallet totals */
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

/* New grading endpoint (memory-buffer via multer 2.x)
   This route now saves the uploaded buffer to the local uploads directory,
   runs classification then the grading engine on the buffer, and returns a full `item` object
   (matching the legacy /api/grade/upload response) so the frontend can
   stay consistent. The item will be persisted into data/database.json.
*/
app.post('/api/grade', memoryUpload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'image buffer required' });
    // options: cardType, debug, weights may be provided via body
    const opts = {};
    if (req.body.cardType) opts.cardType = req.body.cardType;
    if (req.body.debug) opts.debug = req.body.debug === 'true' || req.body.debug === '1';
    if (req.body.weights) {
      try { opts.weights = JSON.parse(req.body.weights); } catch (e) { /* ignore */ }
    }

    // Persist the buffer to the uploads dir so the frontend can reference it
    const ts = Date.now();
    const orig = req.file.originalname || 'upload';
    const safe = String(orig).replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    const filename = `${ts}_${safe}`;
    const filePath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(filePath, req.file.buffer);

    // 1) Classify the card (SPORTS | TCG | UNKNOWN)
    const classification = await classifier.classifyBuffer(req.file.buffer, { filename: orig });

    // 2) Run the grading engine on the buffer
    const report = await grading.gradeBuffer(req.file.buffer, opts);

    // 3) Build item metadata and persist to in-memory and database.json
    const item = {
      id: String(Date.now()),
      name: req.body.name || safe || 'Untitled Card',
      imagePath: `/uploads/${filename}`,
      category: classification,
      gradingReport: report,
      createdAt: new Date().toISOString()
    };

    inventory.unshift(item);

    // Persist to data/database.json and update counts
    const db = loadDatabase();
    db.inventory = db.inventory || [];
    db.inventory.unshift(item);
    // increment category count (normalize key)
    const key = (classification && typeof classification === 'string') ? classification.toUpperCase() : 'UNKNOWN';
    db.categoryCounts = db.categoryCounts || { SPORTS: 0, TCG: 0, UNKNOWN: 0 };
    if (!Object.prototype.hasOwnProperty.call(db.categoryCounts, key)) db.categoryCounts[key] = 0;
    db.categoryCounts[key] = (db.categoryCounts[key] || 0) + 1;
    saveDatabase(db);

    // Return the same shape the frontend expects
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('Grading/classification error', err);
    return res.status(500).json({ error: err.message || 'grading failed' });
  }
});

/* Upload & grade endpoint (disk-backed, legacy Phase 1 route kept for compatibility) */
app.post('/api/grade/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image file is required' });

  // Run mock grading (replace with real pipeline in Phase 2)
  const report = mockGradeImage(req.file.path);

  // Create inventory entry
  const item = {
    id: String(Date.now()),
    name: req.body.name || 'Untitled Card',
    imagePath: `/uploads/${path.basename(req.file.path)}`, // note: publicly accessible only if served
    gradingReport: report,
    createdAt: new Date().toISOString()
  };

  inventory.unshift(item); // add to inventory head
  // For Phase 1 we do not persist to DB; in Phase 2 persist to DB and cloud storage.

  res.json({ ok: true, item });
});

/* Serve uploaded images statically (Phase 1). In production, serve from secure storage/CDN. */
app.use('/uploads', express.static(uploadsDir));

/* Fallback: serve index.html for client-side routing */
app.get('*', (req, res) => {
  // If request is for an API route, respond 404 JSON instead
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* Start server */
app.listen(PORT, () => {
  console.log(`Phase 1 server running on http://localhost:${PORT} (env: ${process.env.NODE_ENV || 'dev'})`);
});
