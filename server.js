require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');

const grading = require('./services/grading_engine');
const classifier = { classifyBuffer: async () => 'SPORTS' };
const wallet = require('./services/wallet_engine');
const attributeParser = require('./services/attribute_parser');
const storage = require('./services/storage_engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storageDisk = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadsDir); },
  filename: function (req, file, cb) {
    const ts = Date.now();
    const orig = file.originalname || 'upload';
    const safe = String(orig).replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({ storage: storageDisk, limits: { fileSize: 10 * 1024 * 1024 } });

let inventory = [];

app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'development' }));

app.get('/api/cards', async (req, res) => {
  try {
    const cards = await storage.getAllCards();
    return res.json({ ok: true, cards });
  } catch (err) {
    return res.status(500).json({ error: 'could not read cards' });
  }
});

app.post('/api/grade', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    const opts = {};
    const ts = Date.now();
    const orig = req.file.originalname || 'upload';
    const safe = String(orig).replace(/\s+/g, '_').replace(/[^\w.-]/g, '');
    const filename = `${ts}_${safe}`;
    const filePath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(filePath, req.file.buffer || fs.readFileSync(req.file.path));

    let classification = 'UNKNOWN';
    try { classification = await classifier.classifyBuffer(req.file.buffer || fs.readFileSync(filePath), { filename }); } catch (err) {}

    const report = await grading.gradeBuffer(req.file.buffer || fs.readFileSync(filePath), opts);

    let parsedAttrs = {};
    try {
      const textToParse = (report && (report.fullText || report.text)) || req.body.name || '';
      if (textToParse && String(textToParse).trim()) {
        parsedAttrs = attributeParser.parseAttributes(textToParse);
      }
    } catch (err) { parsedAttrs = {}; }

    const item = {
      id: String(Date.now()),
      name: req.body.name || safe || 'Untitled Card',
      imagePath: `/uploads/${filename}`,
      category: classification,
      gradingReport: report,
      parsedAttributes: parsedAttrs,
      createdAt: new Date().toISOString()
    };

    inventory.unshift(item);
    try { await storage.saveCard(item); } catch (err) {}

    return res.json({ ok: true, item });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'grading failed' });
  }
});

app.use('/uploads', express.static(uploadsDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Phase 1 server running on http://localhost:${PORT}`));
