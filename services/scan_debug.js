/**
 * services/scan_debug.js
 * Per-scan artifacts for the server centering path that produces vault
 * L/R and T/B: scans/<scanId>/debug.json and oriented.jpg (the 643×900
 * warped card with the four inner print-border lines and each sample
 * line's hit drawn on it).
 */
'use strict';

const fs = require('fs');
const path = require('path');

let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const SCAN_DIR_PATTERN = /^[A-Za-z0-9._-]{8,80}$/;

function innerLines(box, widths) {
  widths = widths || {};
  return {
    leftX: box.left + (Number(widths.left) || 0),
    rightX: box.right - (Number(widths.right) || 0),
    topY: box.top + (Number(widths.top) || 0),
    bottomY: box.bottom - (Number(widths.bottom) || 0)
  };
}

function round2(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v;
}

function buildDebugJson(args) {
  const report = args.report || {};
  const measurement = args.measurement || {};
  const box = args.centeringBox || null;
  const lines = box && measurement.widths ? innerLines(box, measurement.widths) : null;
  return {
    scanId: args.scanId,
    writtenAt: new Date().toISOString(),
    source: 'server measurePrintCentering on the warped Capture still',
    cardDetection: report.cardDetection || null,
    cardNotFound: Boolean(report.cardNotFound),
    cardNotFoundReason: report.cardNotFoundReason || null,
    warpSize: box ? { width: box.width, height: box.height } : null,
    innerBorderLinesPx: lines ? {
      leftX: round2(lines.leftX),
      rightX: round2(lines.rightX),
      topY: round2(lines.topY),
      bottomY: round2(lines.bottomY)
    } : null,
    printBorderWidthsPx: measurement.widths || null,
    sampleLines: measurement.sampleLines || null,
    leftRightRatio: measurement.leftRightRatio || null,
    topBottomRatio: measurement.topBottomRatio || null,
    printCenteringDetected: Boolean(measurement.detected),
    borderReliability: args.borderReliability || null,
    subGrades: report.subGrades || null,
    finalScore: report.finalScore != null ? report.finalScore : null,
    incomplete: Boolean(report.incomplete),
    incompleteReason: report.incompleteReason || null,
    captureTilt: report.captureTilt || null
  };
}

function paint(rgb, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 3;
  rgb[i] = color[0]; rgb[i + 1] = color[1]; rgb[i + 2] = color[2];
}

function drawVLine(rgb, width, height, x, color) {
  const xi = Math.round(x);
  for (let y = 0; y < height; y++) {
    paint(rgb, width, height, xi, y, color);
    paint(rgb, width, height, xi + 1, y, color);
  }
}

function drawHLine(rgb, width, height, y, color) {
  const yi = Math.round(y);
  for (let x = 0; x < width; x++) {
    paint(rgb, width, height, x, yi, color);
    paint(rgb, width, height, x, yi + 1, color);
  }
}

/** Short tick across the scan direction at a sample line's hit. */
function drawHit(rgb, width, height, edge, at, pos, color) {
  const len = 9;
  for (let k = -len; k <= len; k++) {
    if (edge === 'top') paint(rgb, width, height, at + k, Math.round(pos), color);
    else if (edge === 'bottom') paint(rgb, width, height, at + k, height - 1 - Math.round(pos), color);
    else if (edge === 'left') paint(rgb, width, height, Math.round(pos), at + k, color);
    else paint(rgb, width, height, width - 1 - Math.round(pos), at + k, color);
  }
}

/** Mark a sample line that found no border with a short stub at the cut. */
function drawMiss(rgb, width, height, edge, at, color) {
  for (let d = 0; d < 14; d++) {
    if (edge === 'top') paint(rgb, width, height, at, d, color);
    else if (edge === 'bottom') paint(rgb, width, height, at, height - 1 - d, color);
    else if (edge === 'left') paint(rgb, width, height, d, at, color);
    else paint(rgb, width, height, width - 1 - d, at, color);
  }
}

const CYAN = [0, 220, 255];
const YELLOW = [255, 220, 0];
const RED = [255, 40, 40];

/**
 * Warped card with cyan inner-border lines (the widths that produced the
 * saved ratios), yellow ticks at each sample line's hit, red stubs for
 * lines that found no border.
 */
async function renderOrientedJpeg(warped, measurement, centeringBox) {
  if (!sharp || !warped) return null;
  const width = warped.width;
  const height = warped.height;
  const src = warped.data;
  const channels = warped.channels;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    rgb[i * 3] = src[s];
    rgb[i * 3 + 1] = channels >= 3 ? src[s + 1] : src[s];
    rgb[i * 3 + 2] = channels >= 3 ? src[s + 2] : src[s];
  }
  const w = (measurement && measurement.widths) || {};
  const lines = innerLines(centeringBox, w);
  if (w.left != null) drawVLine(rgb, width, height, lines.leftX, CYAN);
  if (w.right != null) drawVLine(rgb, width, height, lines.rightX, CYAN);
  if (w.top != null) drawHLine(rgb, width, height, lines.topY, CYAN);
  if (w.bottom != null) drawHLine(rgb, width, height, lines.bottomY, CYAN);
  const perLine = (measurement && measurement.sampleLines) || {};
  ['top', 'bottom', 'left', 'right'].forEach(function (edge) {
    (perLine[edge] || []).forEach(function (l) {
      if (l.pos == null) drawMiss(rgb, width, height, edge, l.at, RED);
      else drawHit(rgb, width, height, edge, l.at, l.pos, YELLOW);
    });
  });
  return sharp(rgb, { raw: { width: width, height: height, channels: 3 } })
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function persist(args) {
  const scanId = args.scanId;
  if (!args.scansRoot || !scanId || !SCAN_DIR_PATTERN.test(scanId)) {
    throw new Error('scansRoot and a safe scanId are required');
  }
  const dir = path.join(args.scansRoot, scanId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'debug.json'), JSON.stringify(buildDebugJson(args), null, 2));
  let orientedName = null;
  if (args.warped && args.centeringBox) {
    const jpeg = await renderOrientedJpeg(args.warped, args.measurement, args.centeringBox);
    if (jpeg) {
      orientedName = 'oriented.jpg';
      fs.writeFileSync(path.join(dir, orientedName), jpeg);
    }
  }
  return {
    dir: path.join('scans', scanId),
    debugJson: path.join('scans', scanId, 'debug.json'),
    orientedJpg: orientedName ? path.join('scans', scanId, orientedName) : null
  };
}

module.exports = {
  innerLines,
  buildDebugJson,
  renderOrientedJpeg,
  persist
};
