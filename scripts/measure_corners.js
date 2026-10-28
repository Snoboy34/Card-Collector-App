#!/usr/bin/env node
/**
 * scripts/measure_corners.js
 *
 * Corner review for flatbed fronts and backs already on disk. Reads the
 * centering finder through measureFile and does not write the centering
 * answer key, the flatbed manifest, or the centering overlays.
 *
 * Run: node scripts/measure_corners.js [--flatbed DIR] [--card TD-01] [--face front|back|both] [--worn]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { measureFile } = require('./measure_flatbed');
const corners = require('../services/corner_measure');

const NAMES = ['tl', 'tr', 'bl', 'br'];
const LABELS = {
  tl: 'Top-left',
  tr: 'Top-right',
  bl: 'Bottom-left',
  br: 'Bottom-right'
};

function parseArgs(argv) {
  const opts = { flatbed: null, card: null, face: 'front', worn: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--flatbed') opts.flatbed = argv[++i];
    else if (arg === '--card') opts.card = String(argv[++i] || '').toUpperCase();
    else if (arg === '--face') opts.face = String(argv[++i] || '').toLowerCase();
    else if (arg === '--worn') opts.worn = true;
    else throw new Error('unknown argument ' + arg);
  }
  if (opts.face !== 'front' && opts.face !== 'back' && opts.face !== 'both') {
    throw new Error('face must be front, back, or both');
  }
  return opts;
}

function flatbedDir(explicit) {
  if (explicit) return explicit;
  if (process.env.JUDGE_FLATBED_DIR) return process.env.JUDGE_FLATBED_DIR;
  const candidates = [];
  if (process.env.JUDGE_SCAN_REPO) candidates.push(path.join(process.env.JUDGE_SCAN_REPO, 'flatbed'));
  candidates.push('/tmp/judge-scans/flatbed');
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

function readPngDpi(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = 8;
    const hdr = Buffer.alloc(8);
    const chunk = Buffer.alloc(16);
    while (pos < 2 * 1024 * 1024) {
      if (fs.readSync(fd, hdr, 0, 8, pos) < 8) break;
      const length = hdr.readUInt32BE(0);
      const typ = hdr.toString('ascii', 4, 8);
      if (typ === 'pHYs' && length >= 9) {
        fs.readSync(fd, chunk, 0, 9, pos + 8);
        const ppmX = chunk.readUInt32BE(0);
        const ppmY = chunk.readUInt32BE(4);
        const unit = chunk.readUInt8(8);
        if (unit !== 1 || !ppmX || !ppmY) return null;
        return { dpiX: ppmX * 0.0254, dpiY: ppmY * 0.0254 };
      }
      if (typ === 'IEND' || typ === 'IDAT') break;
      pos += 12 + length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

function addScan(byCard, name, entry) {
  if (!entry || !entry.deck || (entry.orientation !== 'up' && entry.orientation !== '180')) return;
  const id = String(entry.deck).toUpperCase();
  if (!byCard[id]) byCard[id] = {};
  byCard[id][entry.orientation] = name;
}

function loadManifest() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reference', 'flatbed_manifest.json'), 'utf8'));
  const fronts = {};
  const backs = {};
  const wornFronts = {};
  const wornBacks = {};
  Object.keys(raw).forEach(function (name) {
    if (name === 'backs' && raw.backs && raw.backs.files) {
      Object.keys(raw.backs.files).forEach(function (file) {
        addScan(backs, file, raw.backs.files[file]);
      });
      return;
    }
    if (name === 'worn' && raw.worn && raw.worn.files) {
      Object.keys(raw.worn.files).forEach(function (file) {
        const entry = raw.worn.files[file];
        addScan(entry && entry.face === 'back' ? wornBacks : wornFronts, file, entry);
      });
      return;
    }
    addScan(fronts, name, raw[name]);
  });
  return { fronts: fronts, backs: backs, wornFronts: wornFronts, wornBacks: wornBacks };
}

function centeringWithheld(cardId) {
  const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reference', 'answer_key.json'), 'utf8'));
  const card = key.cards && key.cards[cardId];
  if (!card || !card.sides) return null;
  const out = {};
  ['top', 'bottom', 'left', 'right'].forEach(function (name) {
    const side = card.sides[name];
    out[name] = !!(side && side.withheld);
  });
  return out;
}

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(value) {
  if (value == null || !isFinite(value)) return '—';
  return Number(value).toFixed(3);
}

function roundingPhrase(rounding) {
  if (!rounding) return 'no reading';
  if (rounding.label) return rounding.label;
  const worn = rounding.setbackMm != null && rounding.missingMm2 != null &&
    (rounding.reason === 'not-an-arc' || (rounding.reason === 'unclear' && rounding.missingMm2 >= 0.2));
  if (worn) return 'setback ' + fmt(rounding.setbackMm) + ' mm, missing ' + fmt(rounding.missingMm2) + ' mm²';
  if (rounding.reason) return rounding.reason;
  if (rounding.radiusMm != null) return 'radius ' + fmt(rounding.radiusMm) + ' mm';
  return 'no reading';
}

function captionLines(tag, corner, publishes) {
  const rounding = corner && corner.rounding ? corner.rounding : {};
  const rise = corner && corner.riseMm ? corner.riseMm : {};
  const riseText = Object.keys(rise).map(function (name) {
    return name + ' ' + fmt(rise[name]);
  }).join('  ');
  const white = corner && corner.whitening ? corner.whitening : {};
  const fray = corner && corner.fray ? corner.fray : {};
  const whiteText = white.label === 'not applicable'
    ? 'whitening not applicable'
    : (white.withheld ? 'whitening ' + (white.reason || 'withheld') : 'whitening ' + fmt(white.areaMm2) + ' mm²');
  const frayText = fray.withheld ? 'fray ' + (fray.reason || 'withheld') : 'fray ' + fmt(fray.lengthMm) + ' mm';
  return [
    tag + (publishes ? ' · publishes' : ''),
    'setback ' + fmt(rounding.setbackMm) + ' mm' + (riseText ? '   rise ' + riseText : ''),
    roundingPhrase(rounding),
    whiteText + '    ' + frayText
  ];
}

async function blankCrop(lines) {
  const svg = '<svg width="360" height="448" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="360" height="448" fill="#1b1b1b"/>' +
    '<text x="16" y="180" fill="#ffffff" font-family="sans-serif" font-size="18">' + esc(lines[0]) + '</text>' +
    '<text x="16" y="210" fill="#f0c674" font-family="sans-serif" font-size="16">' + esc(lines[2] || lines[1]) + '</text>' +
    '</svg>';
  return sharp(Buffer.from(svg)).jpeg({ quality: 75 }).toBuffer();
}

async function annotatedCrop(file, corner, ppm, lines) {
  if (!file || !corner || !corner.tip || !ppm) return blankCrop(lines);
  const meta = await sharp(file).rotate().metadata();
  const win = Math.max(80, Math.round(4.6 * ppm));
  const bisector = corner.bisector || { x: 0, y: 1 };
  const cx = corner.tip.x + bisector.x * 1.15 * ppm;
  const cy = corner.tip.y + bisector.y * 1.15 * ppm;
  let left = Math.round(cx - win / 2);
  let top = Math.round(cy - win / 2);
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left + win > meta.width) left = Math.max(0, meta.width - win);
  if (top + win > meta.height) top = Math.max(0, meta.height - win);
  const width = Math.min(win, meta.width - left);
  const height = Math.min(win, meta.height - top);
  if (width < 8 || height < 8) return blankCrop(lines);
  const out = 360;
  const sx = out / width;
  const sy = out / height;
  function X(p) { return ((p.x - left) * sx).toFixed(1); }
  function Y(p) { return ((p.y - top) * sy).toFixed(1); }
  const draw = [];
  (corner.lines || []).forEach(function (line) {
    draw.push('<line x1="' + X(line.a) + '" y1="' + Y(line.a) + '" x2="' + X(line.b) + '" y2="' + Y(line.b) + '" stroke="#3DDC97" stroke-width="2"/>');
  });
  const silhouette = corner.silhouette || {};
  Object.keys(silhouette).forEach(function (name) {
    const pts = silhouette[name] || [];
    if (!pts.length) return;
    const d = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + X(p) + ' ' + Y(p);
    }).join(' ');
    draw.push('<path d="' + d + '" fill="none" stroke="#F5D76E" stroke-width="1.4"/>');
  });
  if (corner.arc && corner.arc.length) {
    const d = corner.arc.map(function (p, i) {
      return (i ? 'L' : 'M') + X(p) + ' ' + Y(p);
    }).join(' ');
    draw.push('<path d="' + d + '" fill="none" stroke="#5FD0E0" stroke-width="2.4"/>');
  }
  draw.push('<circle cx="' + X(corner.tip) + '" cy="' + Y(corner.tip) + '" r="3.2" fill="#ffffff"/>');
  const svg = '<svg width="' + out + '" height="' + out + '" xmlns="http://www.w3.org/2000/svg">' + draw.join('') + '</svg>';
  const photo = await sharp(file).rotate().extract({ left: left, top: top, width: width, height: height })
    .resize(out, out).jpeg({ quality: 78 }).toBuffer();
  const drawn = await sharp(photo).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 78 }).toBuffer();
  const cap = '<svg width="360" height="88" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="360" height="88" fill="#161616"/>' +
    '<text x="8" y="18" fill="#ffffff" font-family="sans-serif" font-size="15">' + esc(lines[0]) + '</text>' +
    '<text x="8" y="36" fill="#d5d5d5" font-family="sans-serif" font-size="12">' + esc(lines[1]) + '</text>' +
    '<text x="8" y="54" fill="#f0c674" font-family="sans-serif" font-size="12">' + esc(lines[2]) + '</text>' +
    '<text x="8" y="74" fill="#d5d5d5" font-family="sans-serif" font-size="12">' + esc(lines[3] || '') + '</text>' +
    '</svg>';
  return sharp({
    create: { width: 360, height: 448, channels: 3, background: { r: 22, g: 22, b: 22 } }
  }).composite([
    { input: drawn, top: 0, left: 0 },
    { input: Buffer.from(cap), top: 360, left: 0 }
  ]).jpeg({ quality: 76 }).toBuffer();
}

async function thumbnail(file, reading, label) {
  const meta = await sharp(file).rotate().metadata();
  const height = 300;
  const width = Math.max(1, Math.round(meta.width * (height / meta.height)));
  const sx = width / meta.width;
  const sy = height / meta.height;
  const order = ['tl', 'tr', 'br', 'bl'];
  const draw = [];
  for (let i = 0; i < order.length; i++) {
    const a = reading.corners[order[i]] && reading.corners[order[i]].tip;
    const b = reading.corners[order[(i + 1) % 4]] && reading.corners[order[(i + 1) % 4]].tip;
    if (!a || !b) continue;
    draw.push('<line x1="' + (a.x * sx).toFixed(1) + '" y1="' + (a.y * sy).toFixed(1) +
      '" x2="' + (b.x * sx).toFixed(1) + '" y2="' + (b.y * sy).toFixed(1) + '" stroke="#3DDC97" stroke-width="2"/>');
  }
  draw.push('<text x="10" y="24" fill="#ffffff" font-family="sans-serif" font-size="18">' + esc(label) + '</text>');
  const photo = await sharp(file).rotate().resize({ height: height }).jpeg({ quality: 68 }).toBuffer();
  const svg = '<svg width="' + width + '" height="' + height + '" xmlns="http://www.w3.org/2000/svg">' + draw.join('') + '</svg>';
  const buffer = await sharp(photo).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 72 }).toBuffer();
  return { buffer: buffer, width: width, height: height };
}

async function writeSheet(dest, cardId, up, down, paired, note) {
  const headerBits = NAMES.map(function (name) {
    const rounding = paired.corners[name].rounding;
    return name.toUpperCase() + ' ' + roundingPhrase(rounding);
  });
  const headerH = note ? 96 : 78;
  const header = '<svg width="780" height="' + headerH + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="780" height="' + headerH + '" fill="#111111"/>' +
    '<text x="16" y="26" fill="#ffffff" font-family="sans-serif" font-size="20">' + esc(cardId + ' corners · unapproved') + '</text>' +
    (note ? '<text x="16" y="46" fill="#f0c674" font-family="sans-serif" font-size="13">' + esc(note) + '</text>' : '') +
    '<text x="16" y="' + (note ? 68 : 50) + '" fill="#d5d5d5" font-family="sans-serif" font-size="12">' + esc(headerBits.slice(0, 2).join('    ')) + '</text>' +
    '<text x="16" y="' + (note ? 86 : 68) + '" fill="#d5d5d5" font-family="sans-serif" font-size="12">' + esc(headerBits.slice(2).join('    ')) + '</text>' +
    '</svg>';
  const composites = [{ input: Buffer.from(header), top: 0, left: 0 }];
  let y = headerH + 8;
  if (up && up.ok) {
    const thumb = await thumbnail(up.path, up.reading, 'up');
    composites.push({ input: thumb.buffer, top: y, left: 16 });
  }
  if (down && down.ok) {
    const thumb = await thumbnail(down.path, down.reading, '180');
    composites.push({ input: thumb.buffer, top: y, left: 400 });
  }
  y += 312;
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[i];
    const upCorner = up && up.ok ? up.reading.corners[name] : null;
    const downCorner = down && down.ok ? down.reading.corners[corners.FROM_180[name]] : null;
    const upCrop = await annotatedCrop(
      up && up.path,
      upCorner,
      up && up.reading.ppm,
      captionLines(LABELS[name] + ' · up', upCorner, name === 'bl' || name === 'br')
    );
    const downCrop = await annotatedCrop(
      down && down.path,
      downCorner,
      down && down.reading.ppm,
      captionLines(LABELS[name] + ' · 180', downCorner, name === 'tl' || name === 'tr')
    );
    composites.push({ input: upCrop, top: y, left: 24 });
    composites.push({ input: downCrop, top: y, left: 396 });
    y += 460;
  }
  const height = y + 16;
  await sharp({
    create: { width: 780, height: height, channels: 3, background: { r: 12, g: 12, b: 12 } }
  }).composite(composites).jpeg({ quality: 74 }).toFile(dest);
  return fs.statSync(dest).size;
}

async function measureOne(file) {
  const dpiInfo = readPngDpi(file);
  const dpi = dpiInfo ? (dpiInfo.dpiX + dpiInfo.dpiY) / 2 : 1200;
  const result = await measureFile(file, dpi);
  if (!result || !result.ok) {
    return { ok: false, error: result && result.error ? result.error : 'no-quad', dpi: dpi, file: path.basename(file), path: file };
  }
  const raw = await sharp(file).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const edges = {};
  ['top', 'bottom', 'left', 'right'].forEach(function (name) {
    const side = result.sides && result.sides[name];
    edges[name] = side && side.edge ? side.edge : null;
  });
  const reading = corners.measureRaster({
    data: raw.data,
    width: raw.info.width,
    height: raw.info.height,
    dpi: dpi,
    paper: result.paper,
    sizeOk: !!result.sizeOk,
    cardMm: result.cardMm,
    corners: result.corners,
    edges: edges
  });
  return {
    ok: true,
    reading: reading,
    dpi: dpi,
    file: path.basename(file),
    path: file,
    cardMm: result.cardMm,
    sizeOk: !!result.sizeOk,
    width: raw.info.width,
    height: raw.info.height,
    corners: result.corners
  };
}

const CLIP_MM = 1.5;

function scanCheck(measured) {
  if (!measured || !measured.ok) {
    return { present: false, sizeOk: false, clipped: false, cardMm: null, minMarginMm: null };
  }
  const ppm = measured.dpi / 25.4;
  let min = null;
  let closest = null;
  const found = measured.corners || {};
  Object.keys(found).forEach(function (name) {
    const point = found[name];
    if (!point) return;
    const margins = [
      ['left', point.x / ppm],
      ['right', (measured.width - 1 - point.x) / ppm],
      ['top', point.y / ppm],
      ['bottom', (measured.height - 1 - point.y) / ppm]
    ];
    margins.forEach(function (pair) {
      if (min == null || pair[1] < min) {
        min = pair[1];
        closest = name + ' ' + pair[0];
      }
    });
  });
  const minMarginMm = min == null ? null : Math.round(min * 1000) / 1000;
  const shortSide = Math.min(measured.width, measured.height);
  const longSide = Math.max(measured.width, measured.height);
  return {
    present: true,
    file: measured.file,
    width: measured.width,
    height: measured.height,
    dpi: Math.round(measured.dpi * 10000) / 10000,
    cardMm: measured.cardMm || null,
    sizeOk: measured.sizeOk === true,
    minMarginMm: minMarginMm,
    closest: closest,
    clipped: minMarginMm != null && minMarginMm < CLIP_MM,
    cropOk: shortSide >= 3900 && longSide >= 5000
  };
}

function publicCard(up, down, paired) {
  const out = {};
  NAMES.forEach(function (name) {
    const corner = paired.corners[name];
    out[name] = {
      approved: false,
      adjacent: corner.adjacent,
      centeringSideWithheld: corner.centeringSideWithheld,
      pickedFrom: corner.pickedFrom,
      rounding: corner.rounding,
      whitening: corner.whitening,
      ding: corner.ding,
      fray: corner.fray,
      up: corner.up,
      '180': corner['180']
    };
  });
  return {
    approved: false,
    files: {
      up: up && up.file ? up.file : null,
      '180': down && down.file ? down.file : null
    },
    cardMm: {
      up: up && up.cardMm ? up.cardMm : null,
      '180': down && down.cardMm ? down.cardMm : null
    },
    sizeOk: paired.sizeOk,
    corners: out
  };
}

function deckOrder(id) {
  if (id === 'KARROS') return 2.5;
  const match = /^TD-(\d+)$/.exec(id);
  if (match) return Number(match[1]);
  return 1000;
}

async function measureSet(ids, manifest, dir, face, overlayDir) {
  const cards = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const names = manifest[id];
    const upPath = names.up ? path.join(dir, names.up) : null;
    const downPath = names['180'] ? path.join(dir, names['180']) : null;
    const up = upPath && fs.existsSync(upPath) ? await measureOne(upPath) : null;
    const down = downPath && fs.existsSync(downPath) ? await measureOne(downPath) : null;
    const paired = corners.pairReadings(
      up && up.ok ? up.reading : null,
      down && down.ok ? down.reading : null,
      face === 'back' ? null : centeringWithheld(id)
    );
    const record = publicCard(up, down, paired);
    record.face = face;
    const meta = corners.WORN_SET[id];
    if (meta) {
      record.role = meta.role;
      record.owner = meta.name;
      record.ownerNote = meta.note;
    }
    const suffix = face === 'back' ? '_back_review.jpg' : '_review.jpg';
    record.overlay = 'reference/corner_overlays/' + id + suffix;
    record.scanCheck = { up: scanCheck(up), '180': scanCheck(down) };
    if (!up && !down) {
      record.missing = true;
      record.note = 'Flatbed ' + face + ' was not on disk. Nothing was measured.';
    }
    cards[id] = record;
    const sheet = path.join(overlayDir, id + suffix);
    const title = (face === 'back' ? id + ' back' : id) + (meta ? ' · ' + meta.name : '');
    const note = meta ? meta.role + ' — ' + meta.note : '';
    const bytes = await writeSheet(sheet, title, up, down, paired, note);
    const tl = record.corners.tl.rounding;
    const rise = record.corners.tl.up && record.corners.tl.up.riseMm;
    console.log(id + '\t' + face + '\t' + (tl.label || tl.reason || tl.radiusMm) + '\t' + JSON.stringify(rise) + '\t' + bytes);
    ['up', '180'].forEach(function (orient) {
      const row = record.scanCheck[orient];
      if (!row || !row.present) {
        console.log('RESCAN\t' + id + '\t' + face + '\t' + orient + '\tmissing');
        return;
      }
      const flags = [];
      if (!row.sizeOk) flags.push('not-card-sized ' + (row.cardMm ? row.cardMm.width + 'x' + row.cardMm.height : '—'));
      if (row.clipped) flags.push('clipped ' + row.closest + ' margin ' + row.minMarginMm + ' mm');
      if (!row.cropOk) flags.push('crop ' + row.width + 'x' + row.height);
      if (flags.length) console.log('RESCAN\t' + id + '\t' + face + '\t' + orient + '\t' + flags.join('; '));
    });
  }
  return cards;
}

function writeReview(face, measured) {
  const jsonPath = path.join(__dirname, '..', 'reference', 'corner_review.json');
  const prev = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
  const cards = Object.assign({}, prev.cards || {}, face === 'back' ? {} : (measured.fronts || {}));
  const backs = Object.assign({}, prev.backs || {}, face === 'front' ? {} : (measured.backs || {}));
  const doc = corners.reviewDocument(cards, backs);
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n');
  console.log('wrote ' + jsonPath);
}

async function main() {
  const opts = parseArgs(process.argv);
  const dir = flatbedDir(opts.flatbed);
  const manifest = loadManifest();
  const overlayDir = path.join(__dirname, '..', 'reference', 'corner_overlays');
  fs.mkdirSync(overlayDir, { recursive: true });
  const measured = { fronts: {}, backs: {} };
  const faces = opts.face === 'both' ? ['front', 'back'] : [opts.face];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const table = opts.worn
      ? (face === 'back' ? manifest.wornBacks : manifest.wornFronts)
      : (face === 'back' ? manifest.backs : manifest.fronts);
    const scanDir = opts.worn
      ? path.join(dir, 'worn')
      : (face === 'back' ? path.join(dir, 'backs') : dir);
    const ids = Object.keys(table).filter(corners.isCornerCard).sort(function (a, b) {
      return deckOrder(a) - deckOrder(b) || (a < b ? -1 : a > b ? 1 : 0);
    }).filter(function (id) { return !opts.card || id === opts.card; });
    const cards = await measureSet(ids, table, scanDir, face, overlayDir);
    if (face === 'back') measured.backs = cards;
    else measured.fronts = cards;
  }
  writeReview(opts.face, measured);
}

if (require.main === module) {
  main().catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
