/**
 * Persist per-scan centering debug for the SERVER still path that writes
 * vault L/R and T/B (measurePrintCentering in grading_engine.js).
 * Writes scans/<scanId>/debug.json and oriented.jpg on the Judge host.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

function round2(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return value;
  return Math.round(value * 100) / 100;
}

function innerLines(box, widths) {
  widths = widths || {};
  return {
    leftX: box.left + (Number(widths.left) || 0),
    rightX: box.right - (Number(widths.right) || 0),
    topY: box.top + (Number(widths.top) || 0),
    bottomY: box.bottom - (Number(widths.bottom) || 0)
  };
}

function buildDebugJson(args) {
  const measurement = args.measurement || {};
  const box = args.centeringBox || args.findBox || {};
  const lines = innerLines(box, measurement.widths);
  return {
    scanId: args.scanId,
    writtenAt: new Date().toISOString(),
    source: 'server measurePrintCentering on Capture still',
    shouldRotate: Boolean(args.shouldRotate),
    alignmentCrop: Boolean(args.alignmentCrop),
    processedSize: { width: args.width, height: args.height },
    findCardBoundingBox: args.findBox || null,
    centeringBox: box,
    innerBorderLinesPx: {
      leftX: round2(lines.leftX),
      rightX: round2(lines.rightX),
      topY: round2(lines.topY),
      bottomY: round2(lines.bottomY)
    },
    printBorderWidthsPx: measurement.widths || null,
    sampleLineOffsets: measurement.sampleLineOffsets || null,
    sampleLineResults: measurement.sampleLineResults || measurement.samples || null,
    leftRightRatio: measurement.leftRightRatio || null,
    topBottomRatio: measurement.topBottomRatio || null,
    printCenteringDetected: Boolean(measurement.detected),
    finalScore: args.report && args.report.finalScore != null ? args.report.finalScore : null,
    incomplete: Boolean(args.report && args.report.incomplete),
    subGrades: args.report && args.report.subGrades ? args.report.subGrades : null,
    cornersMeasured: args.report ? args.report.cornersMeasured === true : false,
    familyId: args.familyId || null,
    borderReliability: args.borderReliability || null
  };
}

function drawVLine(rgb, width, height, x, r, g, b) {
  const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
  for (let y = 0; y < height; y++) {
    const i = (y * width + xi) * 3;
    rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
    if (xi + 1 < width) {
      rgb[i + 3] = r; rgb[i + 4] = g; rgb[i + 5] = b;
    }
  }
}

function drawHLine(rgb, width, height, y, r, g, b) {
  const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
  const row = yi * width * 3;
  for (let x = 0; x < width; x++) {
    const i = row + x * 3;
    rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
  }
  if (yi + 1 < height) {
    const row2 = (yi + 1) * width * 3;
    for (let x = 0; x < width; x++) {
      const i = row2 + x * 3;
      rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
    }
  }
}

function greyToRgb(pixels, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const v = pixels[i];
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  return rgb;
}

async function renderOrientedJpeg(pixels, width, height, measurement, centeringBox) {
  if (!sharp) return null;
  const rgb = greyToRgb(pixels, width, height);
  const lines = innerLines(centeringBox, measurement && measurement.widths);
  // Cyan = inner print-border lines that produced the saved L/R T/B.
  if (measurement && measurement.widths) {
    if (measurement.widths.left != null) drawVLine(rgb, width, height, lines.leftX, 0, 220, 255);
    if (measurement.widths.right != null) drawVLine(rgb, width, height, lines.rightX, 0, 220, 255);
    if (measurement.widths.top != null) drawHLine(rgb, width, height, lines.topY, 0, 220, 255);
    if (measurement.widths.bottom != null) drawHLine(rgb, width, height, lines.bottomY, 0, 220, 255);
  }
  return sharp(rgb, { raw: { width: width, height: height, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function persist(args) {
  const scanId = args.scanId;
  if (!args.scansRoot || !scanId) {
    throw new Error('scansRoot and scanId required');
  }
  const dir = path.join(args.scansRoot, scanId);
  fs.mkdirSync(dir, { recursive: true });
  const debug = buildDebugJson(args);
  const debugPath = path.join(dir, 'debug.json');
  fs.writeFileSync(debugPath, JSON.stringify(debug, null, 2));
  let orientedName = null;
  if (args.pixels && args.width && args.height) {
    const jpeg = await renderOrientedJpeg(
      args.pixels, args.width, args.height, args.measurement, args.centeringBox
    );
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
