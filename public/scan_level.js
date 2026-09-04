/**
 * public/scan_level.js
 * =============================================================================
 * Pure helpers for the scan-view bubble level + auto-capture gate.
 * Loaded in the browser (script tag) and required from Node tests / server.js.
 *
 * DeviceOrientationEvent mapping (W3C / iOS Safari):
 *   beta  → pitch  (front/back; 0 = phone parallel to the table, camera down)
 *   gamma → roll   (left/right)
 *
 * Frame-fill / distance gating is intentionally NOT here — live
 * findCardBoundingBox on the preview is a separate, larger lift.
 */
'use strict';

var LEVEL_TOLERANCE_DEG = 1.5;
var AUTO_CAPTURE_HOLD_MS = 400;
var SMOOTH_SAMPLE_COUNT = 5;
var DISPLAY_CLAMP_DEG = 12;
var LOG_INTERVAL_MS = 250;

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Both axes must sit inside the tolerance. A null reading is never "level".
 *
 * @param {number} pitchDeg
 * @param {number} rollDeg
 * @param {number} [toleranceDeg]
 * @returns {boolean}
 */
function isDeviceLevel(pitchDeg, rollDeg, toleranceDeg) {
  var tol = toleranceDeg == null ? LEVEL_TOLERANCE_DEG : toleranceDeg;
  if (!isFiniteNumber(pitchDeg) || !isFiniteNumber(rollDeg)) return false;
  return Math.abs(pitchDeg) <= tol && Math.abs(rollDeg) <= tol;
}

/**
 * Mean of the last N {pitch, roll} samples. Light averaging so the bubble
 * and the 400ms hold are not fighting raw gyro jitter.
 *
 * @param {Array<{pitch:number, roll:number}>} buffer
 * @param {number} pitch
 * @param {number} roll
 * @param {number} [maxN]
 * @returns {{ samples: Array, pitch: number, roll: number }}
 */
function pushSmoothedSample(buffer, pitch, roll, maxN) {
  var n = maxN || SMOOTH_SAMPLE_COUNT;
  var next = buffer && buffer.length ? buffer.slice() : [];
  next.push({ pitch: pitch, roll: roll });
  if (next.length > n) next = next.slice(next.length - n);
  var sumP = 0;
  var sumR = 0;
  for (var i = 0; i < next.length; i++) {
    sumP += next[i].pitch;
    sumR += next[i].roll;
  }
  return {
    samples: next,
    pitch: sumP / next.length,
    roll: sumR / next.length
  };
}

/**
 * @param {DeviceOrientationEvent|{beta?:number, gamma?:number}} event
 * @returns {{ pitch: number, roll: number }|null}
 */
function orientationFromDeviceEvent(event) {
  if (!event) return null;
  if (event.beta == null || event.gamma == null) return null;
  var pitch = Number(event.beta);
  var roll = Number(event.gamma);
  if (!isFiniteNumber(pitch) || !isFiniteNumber(roll)) return null;
  return { pitch: pitch, roll: roll };
}

/**
 * Map pitch/roll onto a bubble offset in CSS pixels. Roll → X, pitch → Y.
 * Values beyond DISPLAY_CLAMP_DEG pin at the rim so the dot stays in the target.
 *
 * @param {number} pitchDeg
 * @param {number} rollDeg
 * @param {number} radiusPx
 * @param {number} [clampDeg]
 * @returns {{ x: number, y: number }}
 */
function bubbleOffset(pitchDeg, rollDeg, radiusPx, clampDeg) {
  var clamp = clampDeg || DISPLAY_CLAMP_DEG;
  var pitch = isFiniteNumber(pitchDeg) ? pitchDeg : 0;
  var roll = isFiniteNumber(rollDeg) ? rollDeg : 0;
  pitch = Math.max(-clamp, Math.min(clamp, pitch));
  roll = Math.max(-clamp, Math.min(clamp, roll));
  return {
    x: (roll / clamp) * radiusPx,
    y: (pitch / clamp) * radiusPx
  };
}

/**
 * Auto-capture fires only on a sustained hold, never a one-sample pass-through.
 *
 * @param {boolean} isLevel
 * @param {number} heldMs
 * @param {boolean} alreadyFired
 * @param {number} [holdMs]
 * @returns {boolean}
 */
function shouldAutoCapture(isLevel, heldMs, alreadyFired, holdMs) {
  var need = holdMs == null ? AUTO_CAPTURE_HOLD_MS : holdMs;
  return Boolean(isLevel) && !alreadyFired && Number(heldMs) >= need;
}

/**
 * Multipart fields from public/app.js → grading_engine options.captureTilt.
 *
 * @param {object} body
 * @returns {{ pitchDeg: number|null, rollDeg: number|null, isLevel: boolean, mode: string|null }|null}
 */
function parseCaptureTilt(body) {
  if (!body) return null;
  var pitch = parseFloat(body.capturePitch);
  var roll = parseFloat(body.captureRoll);
  var hasPitch = isFinite(pitch);
  var hasRoll = isFinite(roll);
  if (!hasPitch && !hasRoll) return null;
  var mode = body.captureMode ? String(body.captureMode) : null;
  return {
    pitchDeg: hasPitch ? Math.round(pitch * 100) / 100 : null,
    rollDeg: hasRoll ? Math.round(roll * 100) / 100 : null,
    isLevel: body.captureLevel === 'true' || body.captureLevel === true || body.captureLevel === '1',
    mode: mode
  };
}

var api = {
  LEVEL_TOLERANCE_DEG: LEVEL_TOLERANCE_DEG,
  AUTO_CAPTURE_HOLD_MS: AUTO_CAPTURE_HOLD_MS,
  SMOOTH_SAMPLE_COUNT: SMOOTH_SAMPLE_COUNT,
  DISPLAY_CLAMP_DEG: DISPLAY_CLAMP_DEG,
  LOG_INTERVAL_MS: LOG_INTERVAL_MS,
  isDeviceLevel: isDeviceLevel,
  pushSmoothedSample: pushSmoothedSample,
  orientationFromDeviceEvent: orientationFromDeviceEvent,
  bubbleOffset: bubbleOffset,
  shouldAutoCapture: shouldAutoCapture,
  parseCaptureTilt: parseCaptureTilt
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.ScanLevel = api;
}
