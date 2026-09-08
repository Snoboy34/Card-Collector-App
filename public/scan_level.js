/**
 * public/scan_level.js
 * =============================================================================
 * Pure helpers for the scan-view bubble level + auto-capture gate.
 * Loaded in the browser (script tag) and required from Node tests / server.js.
 *
 * Wrapped in an IIFE so `var CARD_ASPECT` / `function cardFrameRect` do not
 * become globals. A later `const CARD_ASPECT` in public/app.js is a
 * SyntaxError in Safari if this file leaks that name (blank dashboard,
 * dead Scan button, no /api calls).
 *
 * DeviceOrientationEvent mapping (W3C / iOS Safari):
 *   beta  → pitch  (front/back; 0 = phone parallel to the table, camera down)
 *   gamma → roll   (left/right)
 */
'use strict';

(function (root) {
  var CARD_ASPECT = 2.5 / 3.5;
  var LEVEL_TOLERANCE_DEG = 1.5;
  var AUTO_CAPTURE_HOLD_MS = 400;
  var SMOOTH_SAMPLE_COUNT = 5;
  var DISPLAY_CLAMP_DEG = 12;
  var LOG_INTERVAL_MS = 250;

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function isDeviceLevel(pitchDeg, rollDeg, toleranceDeg) {
    var tol = toleranceDeg == null ? LEVEL_TOLERANCE_DEG : toleranceDeg;
    if (!isFiniteNumber(pitchDeg) || !isFiniteNumber(rollDeg)) return false;
    return Math.abs(pitchDeg) <= tol && Math.abs(rollDeg) <= tol;
  }

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

  function orientationFromDeviceEvent(event) {
    if (!event) return null;
    if (event.beta == null || event.gamma == null) return null;
    var pitch = Number(event.beta);
    var roll = Number(event.gamma);
    if (!isFiniteNumber(pitch) || !isFiniteNumber(roll)) return null;
    return { pitch: pitch, roll: roll };
  }

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

  function shouldAutoCapture(isLevel, heldMs, alreadyFired, holdMs) {
    var need = holdMs == null ? AUTO_CAPTURE_HOLD_MS : holdMs;
    return Boolean(isLevel) && !alreadyFired && Number(heldMs) >= need;
  }

  function cardFrameRect(canvasW, canvasH) {
    var pad = Math.min(canvasW, canvasH) * 0.08;
    var h = canvasH - pad * 2;
    var w = h * CARD_ASPECT;
    if (w > canvasW - pad * 2) {
      w = canvasW - pad * 2;
      h = w / CARD_ASPECT;
    }
    return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w: w, h: h };
  }

  function videoCoverCrop(videoW, videoH, viewW, viewH) {
    var srcAspect = videoW / videoH;
    var viewAspect = viewW / viewH;
    if (srcAspect > viewAspect) {
      var cropW = videoH * viewAspect;
      return { x: (videoW - cropW) / 2, y: 0, w: cropW, h: videoH };
    }
    var cropH = videoW / viewAspect;
    return { x: 0, y: (videoH - cropH) / 2, w: videoW, h: cropH };
  }

  function alignmentCropInVideo(videoW, videoH, viewW, viewH) {
    if (!(videoW > 0 && videoH > 0 && viewW > 0 && viewH > 0)) return null;
    var cover = videoCoverCrop(videoW, videoH, viewW, viewH);
    var frame = cardFrameRect(viewW, viewH);
    return {
      x: cover.x + (frame.x / viewW) * cover.w,
      y: cover.y + (frame.y / viewH) * cover.h,
      w: (frame.w / viewW) * cover.w,
      h: (frame.h / viewH) * cover.h
    };
  }

  function parseAlignmentCrop(body) {
    if (!body) return false;
    return body.alignmentCrop === 'true' || body.alignmentCrop === true || body.alignmentCrop === '1';
  }

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

  var scanLevelAPI = {
    LEVEL_TOLERANCE_DEG: LEVEL_TOLERANCE_DEG,
    AUTO_CAPTURE_HOLD_MS: AUTO_CAPTURE_HOLD_MS,
    SMOOTH_SAMPLE_COUNT: SMOOTH_SAMPLE_COUNT,
    DISPLAY_CLAMP_DEG: DISPLAY_CLAMP_DEG,
    LOG_INTERVAL_MS: LOG_INTERVAL_MS,
    CARD_ASPECT: CARD_ASPECT,
    isDeviceLevel: isDeviceLevel,
    pushSmoothedSample: pushSmoothedSample,
    orientationFromDeviceEvent: orientationFromDeviceEvent,
    bubbleOffset: bubbleOffset,
    shouldAutoCapture: shouldAutoCapture,
    cardFrameRect: cardFrameRect,
    videoCoverCrop: videoCoverCrop,
    alignmentCropInVideo: alignmentCropInVideo,
    parseAlignmentCrop: parseAlignmentCrop,
    parseCaptureTilt: parseCaptureTilt
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = scanLevelAPI;
  }
  if (root) {
    root.ScanLevel = scanLevelAPI;
  }
}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
