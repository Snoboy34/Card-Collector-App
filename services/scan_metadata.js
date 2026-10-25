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

/** Phone shutter time, UTC ISO-8601. Not the server's persist clock. */
function isCaptureInstant(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}

/**
 * The phone's capture instant. A stored capturedAt wins. Otherwise the
 * instant the upload carried in captureMetadata.capture.capturedAt.
 * createdAt is the server clock and is not a capture time.
 */
function captureInstantFrom(source) {
  if (!source || typeof source !== 'object') return null;
  if (isCaptureInstant(source.capturedAt)) return source.capturedAt;
  const nested = source.captureMetadata && source.captureMetadata.capture && source.captureMetadata.capture.capturedAt;
  if (isCaptureInstant(nested)) return nested;
  const group = source.capture && source.capture.capturedAt;
  if (isCaptureInstant(group)) return group;
  return null;
}

/** Copy the phone capture onto the item once. An existing capturedAt stays. */
function stampCaptureTime(item) {
  if (!item || typeof item !== 'object') return null;
  if (isCaptureInstant(item.capturedAt)) return item.capturedAt;
  const at = captureInstantFrom(item);
  if (at) item.capturedAt = at;
  return at;
}

/**
 * Fill capturedAt on stored rows that already have the phone instant in
 * capture metadata. Does not copy createdAt. A second pass logs nothing.
 */
function stampStoredCaptureTimes(db, emit) {
  const log = typeof emit === 'function' ? emit : function () {};
  let count = 0;
  ((db && db.inventory) || []).forEach(function (item) {
    if (!item || isCaptureInstant(item.capturedAt)) return;
    const at = captureInstantFrom(item);
    if (!at) return;
    item.capturedAt = at;
    count += 1;
    log('[centering-assist] capture scanId=' + (item.scanId || item.id || '') + ' capturedAt ' + at);
  });
  return count;
}

function textField(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, MAX_STRING);
}

/**
 * Machine identifier → the name an operator reads. Apple's identifier is
 * not the marketing generation: iPhone14,2 is the iPhone 13 Pro. A string
 * that is not in this table is stored as the operating system reported it.
 * Android model names (Pixel 8, SM-S911U) are already that report, so they
 * pass through until a code needs a row of its own.
 */
const DEVICE_NAMES = {
  'iPhone14,2': 'iPhone 13 Pro',
  'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,4': 'iPhone 13 mini',
  'iPhone14,5': 'iPhone 13',
  'iPhone14,6': 'iPhone SE (3rd generation)',
  'iPhone14,7': 'iPhone 14',
  'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15',
  'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,3': 'iPhone 16',
  'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,5': 'iPhone 16e'
};

/** Marketing name when the table knows the identifier, otherwise the OS string. */
function deviceName(reported) {
  const raw = textField(reported);
  if (!raw) return null;
  return DEVICE_NAMES[raw] || raw;
}

function positiveInt(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 1) return null;
  return Math.round(n);
}

/**
 * Device, camera, and pixel size for one scan, plus the px/mm the server
 * measured on the card. Flat multipart fields win, then a previously stored
 * `capture`, then captureMetadata. A client-sent px/mm is ignored.
 *
 * @param {object} body
 * @param {object|null} metadata sanitized captureMetadata
 * @param {object|null} report grading report, when the card was measured
 * @param {object|null} stored item.capture already on disk
 * @returns {object|null}
 */
function captureFacts(body, metadata, report, stored) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const device = meta.device && typeof meta.device === 'object' ? meta.device : {};
  const camera = meta.camera && typeof meta.camera === 'object' ? meta.camera : {};
  const capture = meta.capture && typeof meta.capture === 'object' ? meta.capture : {};
  const b = body && typeof body === 'object' ? body : {};
  const keep = stored && typeof stored === 'object' ? stored : {};
  const deviceModel = deviceName(b.deviceModel) || deviceName(keep.deviceModel) ||
    deviceName(device.modelIdentifier) || deviceName(device.model);
  const cameraName = textField(b.camera) || textField(keep.camera) || textField(camera.deviceType);
  const captureWidth = positiveInt(b.captureWidth) || positiveInt(keep.captureWidth) ||
    positiveInt(capture.uploadWidth) || positiveInt(camera.photoWidth);
  const captureHeight = positiveInt(b.captureHeight) || positiveInt(keep.captureHeight) ||
    positiveInt(capture.uploadHeight) || positiveInt(camera.photoHeight);
  let pxPerMm = null;
  if (report) {
    pxPerMm = require('./grading_engine').achievedPxPerMmFromReport(report);
  }
  if (!(pxPerMm > 0) && keep.pxPerMm > 0 && isFinite(Number(keep.pxPerMm))) pxPerMm = Number(keep.pxPerMm);
  if (!deviceModel && !cameraName && captureWidth == null && captureHeight == null && !(pxPerMm > 0)) return null;
  return {
    deviceModel: deviceModel,
    camera: cameraName,
    captureWidth: captureWidth,
    captureHeight: captureHeight,
    pxPerMm: pxPerMm > 0 ? pxPerMm : null
  };
}

/**
 * Store the operator-facing name. A known identifier moves to
 * device.modelIdentifier and device.model becomes the name. item.capture
 * gets that same name. An Android string that is already a name stays.
 * A flat capture.deviceModel that is already a name is left alone.
 * @returns {boolean} true when this item changed
 */
function applyStoredDeviceName(item) {
  if (!item || typeof item !== 'object') return false;
  let changed = false;
  const meta = item.captureMetadata;
  const device = meta && meta.device && typeof meta.device === 'object' ? meta.device : null;
  if (device && DEVICE_NAMES[device.model]) {
    if (!device.modelIdentifier) device.modelIdentifier = device.model;
    const named = deviceName(device.modelIdentifier) || deviceName(device.model);
    if (named && device.model !== named) {
      device.model = named;
      changed = true;
    }
  }
  const reported = (item.capture && item.capture.deviceModel) ||
    (device && (device.modelIdentifier || device.model));
  const name = deviceName(reported);
  if (!name) return changed;
  if (!item.capture || typeof item.capture !== 'object') item.capture = {};
  if (item.capture.deviceModel !== name) {
    item.capture.deviceModel = name;
    changed = true;
  }
  return changed;
}

/**
 * Correct device names already on disk. A second pass logs nothing.
 */
function stampStoredDeviceNames(db, emit) {
  const log = typeof emit === 'function' ? emit : function () {};
  let count = 0;
  ((db && db.inventory) || []).forEach(function (item) {
    if (!applyStoredDeviceName(item)) return;
    count += 1;
    const name = item.capture && item.capture.deviceModel;
    log('[capture] device scanId=' + (item.scanId || item.id || '') + ' model ' + name);
  });
  return count;
}

module.exports = {
  parseCaptureMetadata, buildServerMetadata, normalizeBackground, captureFacts,
  deviceName, applyStoredDeviceName, stampStoredDeviceNames,
  isCaptureInstant, captureInstantFrom, stampCaptureTime, stampStoredCaptureTimes,
  CAPTURE_GROUPS, BACKGROUNDS, MAX_JSON_BYTES, DEVICE_NAMES
};
