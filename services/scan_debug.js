/**
 * services/scan_debug.js
 * Per-scan artifacts for the server centering path that produces vault
 * L/R and T/B:
 *   scans/<scanId>/debug.json
 *   oriented.jpg — the 643×900 warped card, inner border, sample hits
 *   overlay.jpg  — the decoded photo with the card quad, every sample
 *                  line, the chosen border, rejected lines in magenta,
 *                  misses in red, and low-confidence edges marked
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
    lowConfidenceEdges: args.lowConfidenceEdges || [],
    borderVoteLowConfidenceEdges: (measurement && measurement.voteLowConfidenceEdges) || [],
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

const OVERLAY_AGREE = '#ffe000';
const OVERLAY_REJECTED = '#ff2bd6';
const OVERLAY_MISS = '#ff2828';
const OVERLAY_CHOSEN = '#00dcff';
const OVERLAY_QUAD = '#ffffff';
const OVERLAY_LOW = '#ff8800';

function warpToPhoto(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (!w) return [x, y];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function edgePoint(edge, along, depth, warpW, warpH) {
  if (edge === 'left') return [depth, along];
  if (edge === 'right') return [warpW - 1 - depth, along];
  if (edge === 'top') return [along, depth];
  return [along, warpH - 1 - depth];
}

function svgNum(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function svgLine(H, a, b, color, width) {
  const p = warpToPhoto(H, a[0], a[1]);
  const q = warpToPhoto(H, b[0], b[1]);
  const halo = width + 2;
  return '<line x1="' + svgNum(p[0]) + '" y1="' + svgNum(p[1]) + '" x2="' + svgNum(q[0]) + '" y2="' + svgNum(q[1]) +
    '" stroke="#000" stroke-width="' + halo + '" stroke-linecap="round"/>' +
    '<line x1="' + svgNum(p[0]) + '" y1="' + svgNum(p[1]) + '" x2="' + svgNum(q[0]) + '" y2="' + svgNum(q[1]) +
    '" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round"/>';
}

function svgPoly(points, color, width) {
  const pts = points.map(function (p) { return svgNum(p[0]) + ',' + svgNum(p[1]); }).join(' ');
  return '<polyline points="' + pts + '" fill="none" stroke="#000" stroke-width="' + (width + 2) + '" stroke-linejoin="round"/>' +
    '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linejoin="round"/>';
}

/**
 * SVG drawn in decoded-photo pixels. Sample-line coordinates are warp
 * pixels (the 643×900 box). `homography` maps those onto the photo.
 * Agreeing hits are yellow, rejected hits (a position outside the chosen
 * group) are magenta, misses are red, the chosen border is cyan, and a
 * low-confidence edge is an orange stroke plus a legend line.
 */
function buildOverlaySvg(args) {
  const width = args.width;
  const height = args.height;
  const H = args.homography;
  const warp = args.warp || { width: 643, height: 900 };
  const warpW = warp.width;
  const warpH = warp.height;
  const measurement = args.measurement || {};
  const widths = measurement.widths || {};
  const perLine = measurement.sampleLines || {};
  const quad = args.quad;
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 420));
  const parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');

  const sides = quad ? {
    top: [quad.tl, quad.tr],
    right: [quad.tr, quad.br],
    bottom: [quad.br, quad.bl],
    left: [quad.bl, quad.tl]
  } : {};
  const cutLow = args.lowConfidenceEdges || [];
  const voteLow = measurement.voteLowConfidenceEdges || [];
  const lowEdges = {};
  cutLow.forEach(function (e) { lowEdges[e] = lowEdges[e] || []; lowEdges[e].push('CUT'); });
  voteLow.forEach(function (e) { lowEdges[e] = lowEdges[e] || []; lowEdges[e].push('VOTE'); });
  Object.keys(lowEdges).forEach(function (edge) {
    const side = sides[edge];
    if (!side) return;
    parts.push(svgPoly(side, OVERLAY_LOW, stroke * 3));
  });
  if (quad) {
    parts.push(svgPoly([quad.tl, quad.tr, quad.br, quad.bl, quad.tl], OVERLAY_QUAD, stroke));
  }

  ['top', 'bottom', 'left', 'right'].forEach(function (edge) {
    (perLine[edge] || []).forEach(function (line) {
      const along = line.at;
      if (line.pos == null) {
        parts.push(svgLine(H, edgePoint(edge, along, 0, warpW, warpH), edgePoint(edge, along, 16, warpW, warpH), OVERLAY_MISS, stroke));
        return;
      }
      const color = line.inGroup ? OVERLAY_AGREE : OVERLAY_REJECTED;
      parts.push(svgLine(H, edgePoint(edge, along, 0, warpW, warpH), edgePoint(edge, along, line.pos, warpW, warpH), color, stroke));
    });
    if (widths[edge] != null) {
      const alongMax = (edge === 'left' || edge === 'right') ? warpH : warpW;
      parts.push(svgLine(H, edgePoint(edge, 0, widths[edge], warpW, warpH), edgePoint(edge, alongMax - 1, widths[edge], warpW, warpH), OVERLAY_CHOSEN, stroke));
    }
  });

  const font = Math.max(14, Math.round(Math.min(width, height) / 48));
  let y = font + 8;
  function legend(text) {
    parts.push('<text x="10" y="' + y + '" font-family="sans-serif" font-size="' + font + '" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">' + text + '</text>');
    y += font + 6;
  }
  legend('quad white · chosen cyan · agree yellow · rejected magenta · miss red');
  Object.keys(lowEdges).forEach(function (edge) {
    legend('LOW ' + lowEdges[edge].join('+') + ' ' + edge);
  });
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Decoded photo with the overlay SVG composited on top. Long edge is capped
 * so a session of overlays stays practical to push.
 */
async function renderPhotoOverlay(args) {
  if (!sharp || !args || !args.photo || !args.quad || !args.homography) return null;
  const photo = args.photo;
  let width = photo.width;
  let height = photo.height;
  const channels = photo.channels || 3;
  const src = photo.data;
  let rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    rgb[i * 3] = src[s];
    rgb[i * 3 + 1] = channels >= 3 ? src[s + 1] : src[s];
    rgb[i * 3 + 2] = channels >= 3 ? src[s + 2] : src[s];
  }
  let quad = args.quad;
  let homography = args.homography;
  const maxEdge = 1600;
  if (Math.max(width, height) > maxEdge) {
    const scale = maxEdge / Math.max(width, height);
    const nextW = Math.max(1, Math.round(width * scale));
    const nextH = Math.max(1, Math.round(height * scale));
    rgb = await sharp(rgb, { raw: { width: width, height: height, channels: 3 } })
      .resize(nextW, nextH, { fit: 'fill' })
      .raw()
      .toBuffer();
    width = nextW;
    height = nextH;
    const s = scale;
    quad = {
      tl: [quad.tl[0] * s, quad.tl[1] * s],
      tr: [quad.tr[0] * s, quad.tr[1] * s],
      br: [quad.br[0] * s, quad.br[1] * s],
      bl: [quad.bl[0] * s, quad.bl[1] * s]
    };
    const H = homography;
    homography = [H[0] * s, H[1] * s, H[2] * s, H[3] * s, H[4] * s, H[5] * s, H[6], H[7], H[8]];
  }
  const svg = buildOverlaySvg({
    width: width,
    height: height,
    quad: quad,
    homography: homography,
    warp: args.warp,
    measurement: args.measurement,
    lowConfidenceEdges: args.lowConfidenceEdges
  });
  // Rasterize to the photo's exact pixel size, then composite. Chaining a
  // resize after composite makes sharp compare the overlay to the shrunk base.
  const svgPng = await sharp(Buffer.from(svg), { density: 72 })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer();
  return sharp(rgb, { raw: { width: width, height: height, channels: 3 } })
    .composite([{ input: svgPng }])
    .jpeg({ quality: 82 })
    .toBuffer();
}

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
  let orientedName = null;
  if (args.warped && args.centeringBox) {
    const jpeg = await renderOrientedJpeg(args.warped, args.measurement, args.centeringBox);
    if (jpeg) {
      orientedName = 'oriented.jpg';
      fs.writeFileSync(path.join(dir, orientedName), jpeg);
    }
  }
  let overlayName = null;
  if (args.photo && args.quad && args.homography) {
    try {
      const overlay = await renderPhotoOverlay({
        photo: args.photo,
        quad: args.quad,
        homography: args.homography,
        warp: args.centeringBox ? { width: args.centeringBox.width, height: args.centeringBox.height } : null,
        measurement: args.measurement,
        lowConfidenceEdges: args.lowConfidenceEdges
      });
      if (overlay) {
        overlayName = 'overlay.jpg';
        fs.writeFileSync(path.join(dir, overlayName), overlay);
      }
    } catch (err) {
      console.error('[scan-debug] overlay failed', scanId, err && err.message);
    }
  }
  const written = buildDebugJson(args);
  if (overlayName) written.overlayJpg = path.join('scans', scanId, overlayName);
  fs.writeFileSync(path.join(dir, 'debug.json'), JSON.stringify(written, null, 2));
  return {
    dir: path.join('scans', scanId),
    debugJson: path.join('scans', scanId, 'debug.json'),
    orientedJpg: orientedName ? path.join('scans', scanId, orientedName) : null,
    overlayJpg: overlayName ? path.join('scans', scanId, overlayName) : null
  };
}

module.exports = {
  innerLines,
  buildDebugJson,
  buildOverlaySvg,
  renderOrientedJpeg,
  renderPhotoOverlay,
  persist
};
