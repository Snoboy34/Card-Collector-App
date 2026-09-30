/**
 * services/scan_metadata.js
 * Per-scan metadata, stored with every saved grade and failed attempt.
 *
 *   captureMetadata  what the app says about the capture (multipart field
 *                    `captureMetadata`, JSON): app build, device, camera
 *                    format / photo size / codec / exposure, capture mode.
 *                    Sanitized: known groups only, scalar values, size-capped.
 *   serverMetadata   what the server observed: receive time, route, upload
 *                    bytes + sha256, decoded format / size / orientation,
 *                    grade time, engine stamp, user agent, LAN or not.
 *
 * Metadata is recorded, never graded: gradeBuffer does not read it.
 */
'use strict';

const crypto = require('crypto');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const CAPTURE_GROUPS = ['app', 'device', 'camera', 'capture'];
/** Lab and field surfaces. Pink is the lab baseline, not a user instruction. */
const BACKGROUNDS = ['pink', 'white', 'dark-matte', 'wood', 'pattern', 'glossy', 'other'];
const MAX_JSON_BYTES = 8 * 1024;
const MAX_STRING = 200;
const MAX_ARRAY = 16;
const MAX_DEPTH = 3;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/**
 * Canonical surface token, or null when unset. Undefined when the value is
 * not one of BACKGROUNDS (caller drops it). The grade never reads this.
 * @param {*} v
 * @returns {string|null|undefined}
 */
function normalizeBackground(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  return BACKGROUNDS.indexOf(s) === -1 ? undefined : s;
}

function cleanValue(v, depth) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.slice(0, MAX_STRING);
  if (Array.isArray(v)) {
    return v.slice(0, MAX_ARRAY).map(function (x) { return cleanValue(x, depth + 1); })
      .filter(function (x) { return x !== undefined && (x === null || typeof x !== 'object'); });
  }
  if (typeof v === 'object') {
    if (depth >= MAX_DEPTH) return undefined;
    const out = {};
    Object.keys(v).forEach(function (k) {
      if (!KEY_PATTERN.test(k)) return;
      const c = cleanValue(v[k], depth + 1);
      if (c !== undefined) out[k] = c;
    });
    return out;
  }
  return undefined;
}

/**
 * @param {object} body multipart fields
 * @returns {{ metadata: object|null, error: string|null }}
 */
function parseCaptureMetadata(body) {
  const raw = body && body.captureMetadata;
  if (raw == null || raw === '') return { metadata: null, error: null };
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) return { metadata: null, error: 'captureMetadata over 8 KB, ignored' };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { metadata: null, error: 'captureMetadata is not JSON, ignored' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { metadata: null, error: 'captureMetadata is not an object, ignored' };
  const out = {};
  CAPTURE_GROUPS.forEach(function (g) {
    if (parsed[g] && typeof parsed[g] === 'object' && !Array.isArray(parsed[g])) out[g] = cleanValue(parsed[g], 1);
  });
  if (parsed.schema != null) out.schema = cleanValue(parsed.schema, 1);
  if (out.capture && Object.prototype.hasOwnProperty.call(out.capture, 'background')) {
    const background = normalizeBackground(out.capture.background);
    if (background) out.capture.background = background;
    else delete out.capture.background;
  }
  const dropped = Object.keys(parsed).filter(function (k) { return CAPTURE_GROUPS.indexOf(k) === -1 && k !== 'schema'; });
  if (dropped.length) out.droppedKeys = dropped.slice(0, MAX_ARRAY).map(function (k) { return String(k).slice(0, 40); });
  return { metadata: out, error: null };
}

async function imageFacts(buffer) {
  if (!sharp || !buffer || !buffer.length) return null;
  try {
    const m = await sharp(buffer, { failOnError: false }).metadata();
    return {
      format: m.format || null,
      width: m.width || null,
      height: m.height || null,
      orientation: m.orientation || null,
      space: m.space || null,
      chromaSubsampling: m.chromaSubsampling || null,
      hasExif: Boolean(m.exif),
      hasIccProfile: Boolean(m.icc)
    };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, MAX_STRING) };
  }
}

/**
 * @param {{ buffer: Buffer, file?: object, route: string, receivedAt: string, gradeMs?: number,
 *           engine?: object, userAgent?: string, localNetwork?: boolean, sweepFrames?: number,
 *           captureMetadataError?: string|null }} args
 */
async function buildServerMetadata(args) {
  const buffer = args.buffer;
  const file = args.file || {};
  return {
    schema: 1,
    receivedAt: args.receivedAt,
    route: args.route,
    uploadBytes: buffer ? buffer.length : null,
    uploadSha256: buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null,
    mimeType: file.mimetype || null,
    originalName: file.originalname ? String(file.originalname).slice(0, MAX_STRING) : null,
    image: await imageFacts(buffer),
    gradeMs: args.gradeMs == null ? null : args.gradeMs,
    sweepFrames: args.sweepFrames || 0,
    engine: args.engine || null,
    userAgent: args.userAgent ? String(args.userAgent).slice(0, MAX_STRING) : null,
    localNetwork: args.localNetwork == null ? null : Boolean(args.localNetwork),
    captureMetadataError: args.captureMetadataError || null
  };
}

module.exports = {
  parseCaptureMetadata, buildServerMetadata, normalizeBackground,
  CAPTURE_GROUPS, BACKGROUNDS, MAX_JSON_BYTES
};
