/**
 * One JSON line per scan that has a measured px/mm. The grade does not read
 * this file. The rows are the set a later pass uses to learn a sharp band
 * for a device that does not have one yet.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCES = ['measured', 'default', 'open'];

function tierLabel(pxPerMm) {
  const g = require('./grading_engine');
  return g.resolutionEdgeLabel(g.resolutionToleranceMm(pxPerMm), false);
}

function recordFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const capture = item.capture && typeof item.capture === 'object' ? item.capture : {};
  const px = Number(capture.pxPerMm);
  if (!(px > 0) || !isFinite(px)) return null;
  const metaCapture = item.captureMetadata && item.captureMetadata.capture;
  const raw = metaCapture && metaCapture.sharpBand;
  const sharpBand = SOURCES.indexOf(raw) >= 0 ? raw : 'unspecified';
  return {
    at: new Date().toISOString(),
    scanId: item.scanId || item.id || null,
    deviceModel: capture.deviceModel || null,
    camera: capture.camera || null,
    captureWidth: capture.captureWidth || null,
    captureHeight: capture.captureHeight || null,
    pxPerMm: px,
    label: tierLabel(px),
    sharpBand: sharpBand,
    side: item.side || null
  };
}

function append(dir, item) {
  const row = recordFromItem(item);
  if (!row || !dir) return null;
  const file = path.join(dir, 'sharp_band_log.jsonl');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    console.error('Failed to append sharp_band_log.jsonl', e);
  }
  console.log('[sharp-band] scanId=' + (row.scanId || '') +
    ' device=' + (row.deviceModel || '') +
    ' camera=' + (row.camera || '') +
    ' ' + (row.captureWidth || '') + 'x' + (row.captureHeight || '') +
    ' ' + row.pxPerMm + ' px/mm ' + row.label +
    ' band=' + row.sharpBand);
  return row;
}

module.exports = { recordFromItem, append, tierLabel, SOURCES };
