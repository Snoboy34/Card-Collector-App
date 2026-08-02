/**
 * server.js
 * Phase 1 Express server: serves static frontend and placeholder APIs for auth and grading.
 *
 * Notes:
 * - Phase 1 uses in-memory placeholders. Persistence (DB) should be added in Phase 2.
 * - The grading endpoint uses services/grading_engine.js and memory-buffer uploads via multer.
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const multer = require("multer");
const attributeParser = require("./services/attribute_parser");
const grading = require("./services/grading_engine");
const storage = require("./services/storage_engine");

const app = express();
const PORT = process.env.PORT || 5000;
// ========================================================================
// 💾 DATABASE PERSISTENCE STORAGE LAYER
// ========================================================================
const DB_FILE = path.join(__dirname, "database_vault.json");

function loadDataVault() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(
        DB_FILE,
        JSON.stringify({ users: {}, inventories: {} }, null, 2),
      );
    }
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (err) {
    console.error("[Database Error] Failed to read disk storage vault:", err);
    return { users: {}, inventories: {} };
  }
}

function saveDataVault(currentDataState) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(currentDataState, null, 2));
  } catch (err) {
    console.error(
      "[Database Error] Failed to write updates to disk vault:",
      err,
    );
  }
}

// Initialize our dynamic storage structure in memory
let runtimeDb = loadDataVault();

/* =========================
   Middlewares
   ========================= */
// Disable CSP — Replit proxies requests through a different origin so
// helmet's default "default-src 'self'" blocks all fetch() API calls.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
// Raise limits to 20 MB so base64-encoded card images (300–600 KB) are accepted
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(morgan("dev"));

/* =========================
   Static files
   ========================= */
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

/* =========================
   Upload storage (local, Phase 1)
   ========================= */
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storageDisk = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // keep simple, in production use UUIDs
    const ts = Date.now();
    const safe = file.originalname.replace(/\s+/g, "_").replace(/[^\w.-]/g, "");
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage: storageDisk,
  limits: { fileSize: 10 * 1024 * 1024 },
}); // 10MB

// Memory storage for grading route (req.file.buffer expected)
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* =========================
   In-memory store (Phase 1)
   ========================= */
let inventory = runtimeDb.inventory || []; // Automatically pulls saved records from disk vault

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
  const label =
    weighted >= 95
      ? "Gem Mint"
      : weighted >= 90
        ? "Mint"
        : weighted >= 80
          ? "Near Mint"
          : weighted >= 70
            ? "Excellent"
            : "Good";

  return {
    centering,
    corners,
    edges,
    surface,
    weighted,
    label,
    notes:
      "This is a mock report — replace with the real CV scoring engine in Phase 2.",
  };
}

/* =========================
   API Routes
   ========================= */

/* Health */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "development" });
});

/* Auth placeholders */
app.post("/api/auth/signup", (req, res) => {
  // Minimal placeholder: in Phase 2, persist users and hashed passwords.
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  // Return a fake token (in production, return JWT/session)
  return res.json({ ok: true, username, token: `phase1-token-${username}` });
});

app.post("/api/auth/login", (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  return res.json({ ok: true, username, token: `phase1-token-${username}` });
});

/* Inventory endpoints (Phase 1: in-memory) */
app.get("/api/inventory", (req, res) => {
  res.json({ ok: true, inventory });
});

/* Persisted cards listing */
app.get("/api/cards", async (req, res) => {
  try {
    const cards = await storage.getAllCards();
    return res.json({ ok: true, cards });
  } catch (err) {
    console.error("Error reading cards DB", err);
    return res.status(500).json({ error: "could not read cards" });
  }
});

/* ── Primary grading endpoint ────────────────────────────────────────────────
   Accepts: POST /api/grade  Content-Type: application/json
   Body: { image: <base64 string, with or without data-URL prefix>, name?: string }

   Why JSON instead of multipart FormData:
     The Replit dev-server proxy silently drops multipart/form-data POST bodies
     in certain configurations, causing the browser to receive a TCP reset and
     report "TypeError: Failed to fetch" before any Express middleware runs.
     Sending the image as a plain JSON base64 string goes through the proxy
     identically to every other fetch() call in the app.
   ──────────────────────────────────────────────────────────────────────────── */
app.post("/api/grade", async (req, res) => {
  try {
    // ── Guard: body must contain an image string ──────────────────────────
    const raw = req.body && req.body.image;
    if (!raw || typeof raw !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "body.image (base64 string) is required" });
    }
    // ... Strip optional data-URL prefix (data:image/jpeg;base64,)
    const base64 = raw.includes(",") ? raw.split(",")[1] : raw;

    // -- Run the grading engines --
    const report = await grading.analyzeImageBuffer(base64);

    // -- Persist image to uploads dir so the UI can display a thumbnail --
    const ts = Date.now();
    const safeName = String(req.body.name || "card")
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 80);
    const filename = `${ts}_${safeName}.jpg`;
    const filePath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(filePath, Buffer.from(base64, "base64"));

    // 1. Invoke Copilot's advanced attribute parser engine matching its export shape
    const parsedData = attributeParser.parseAttributes(
      req.body.name || safeName || "",
    );

    // 2. Compute dynamic market pricing matching your existing calculator setup
    const priceReport = walletEngine.pricingReport({
      cardName: req.body.name || safeName || "",
      numericGrade: report.grade || 5,
    });

    // 3. Assemble the updated inventory item object with Copilot's extracted properties
    const item = {
      id: String(ts),
      name: req.body.name || safeName || "Untitled Card",
      imagePath: `/uploads/${filename}`,
      gradingReport: report,
      createdAt: new Date().toISOString(),
      valuation: priceReport.finalValuation,

      // Map safely to Copilot's specific structural output shape arrays and booleans
      year:
        Array.isArray(parsedData.years) && parsedData.years.length > 0
          ? parsedData.years[0]
          : 2026,
      cardNumber:
        Array.isArray(parsedData.cardNumbers) &&
        parsedData.cardNumbers.length > 0
          ? parsedData.cardNumbers[0]
          : "Base",
      isAutographed: parsedData.premium ? parsedData.premium.auto : false,
      attributes: parsedData.premium
        ? Object.keys(parsedData.premium).filter(
            (key) => parsedData.premium[key] === true,
          )
        : [],
    };

    inventory.unshift(item);
    runtimeDb.inventory = inventory;
    saveDataVault(runtimeDb);

    // Persist to JSON DB (best-effort)
    try {
      await storage.saveCard(item);
    } catch (err) {
      console.error("Failed to save card to JSON DB", err);
    }

    res.json({ ok: true, item });
  } catch (globalErr) {
    console.error("Global route error:", globalErr);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});
/* ── Stats endpoint ──────────────────────────────────────────────────────────
   Returns a unified snapshot used by the dashboard: inventory size, wallet
   total value (grade-based modifier × $100 PSA-10 placeholder), and category
   breakdown by centering grade.  Replace the $100 placeholder with a live
   pricing API in Phase 3.
   ─────────────────────────────────────────────────────────────────────────── */
const wallet = require("./services/wallet_engine");

function buildStatsPayload() {
  const PSA10_PLACEHOLDER = 100; // $100 mock PSA-10 reference; replace with live data in Phase 3
  let totalValue = 0;
  const categoryCounts = {};

  inventory.forEach((item) => {
    const report = item.gradingReport || {};
    const grade = report.numericGrade || 0;
    if (grade > 0) {
      totalValue += wallet.getModifierForGrade(grade) * PSA10_PLACEHOLDER;
    }
    const label = report.centeringGrade || report.label || "Ungraded";
    categoryCounts[label] = (categoryCounts[label] || 0) + 1;
  });

  return {
    ok: true,
    stats: {
      inventorySize: inventory.length,
      categoryCounts,
      wallet: { totalValue: Math.round(totalValue * 100) / 100 },
    },
  };
}

app.get("/api/stats", (req, res) => {
  res.json(buildStatsPayload());
});

/* ── Server-Sent Events endpoint ─────────────────────────────────────────────
   Streams live stats updates to the dashboard every 10 seconds.
   Falls back gracefully: if the client can't use EventSource the dashboard
   already has a polling fallback in app.js.
   ─────────────────────────────────────────────────────────────────────────── */
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering if present
  res.flushHeaders();

  // Send initial payload immediately so the dashboard doesn't wait 10 s
  const initial = buildStatsPayload();
  res.write(`event: stats\ndata: ${JSON.stringify(initial)}\n\n`);

  const interval = setInterval(() => {
    const payload = buildStatsPayload();
    res.write(`event: stats\ndata: ${JSON.stringify(payload)}\n\n`);
  }, 10000);

  req.on("close", () => clearInterval(interval));
});

/* Serve uploaded images statically (Phase 1). In production, serve from secure storage/CDN. */
app.use("/uploads", express.static(uploadsDir));

/* Fallback: serve index.html for client-side routing */
app.get("*", (req, res) => {
  // If request is for an API route, respond 404 JSON instead
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API route not found" });
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

/* Start server */
app.listen(PORT, () => {
  console.log(
    `Phase 1 server running on http://localhost:${PORT} (env: ${process.env.NODE_ENV || "dev"})`,
  );
});
