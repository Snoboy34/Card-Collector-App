/**
 * public/app.js
 * =============================================================================
 * Client for The Judge pre-submission diagnostic.
 * =============================================================================
 *
 * Responsibilities
 * ----------------
 *   - Hash routing (dashboard / inventory / scan)
 *   - High-contrast HTML5 canvas card-alignment guides (BusinessPlan.md Phase 2)
 *   - Live getUserMedia capture with file-upload fallback
 *   - POST /api/grade → services/grading_engine.js (4-phase Judge + 0.5 ceiling)
 *   - Render 10-point sub-grades, ceiling flag, and primary-flaw text
 *
 * The canvas overlay is presentation only. It does not grade. All scoring
 * happens server-side in grading_engine.js so the formula cannot drift
 * between the viewport and The Judge.swift.
 */

/* -------------------------
   Utilities
   ------------------------- */
const api = {
  // Relative URLs so the UI works on whatever port server.js bound (5000 default).
  getInventory: () => fetch('/api/inventory').then(r => r.json()),
  getStats: () => fetch('/api/stats').then(r => r.json()),
  uploadImage: (formData) => fetch('/api/grade', { method: 'POST', body: formData }).then(r => r.json()),
  signup: (payload) => fetch('/api/auth/signup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).then(r=>r.json()),
  login: (payload) => fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).then(r=>r.json())
};

/** Standard sports-card / TCG slab window: 2.5" × 3.5" (width / height). */
const CARD_ASPECT = 2.5 / 3.5;

/** Live camera bookkeeping. Stopped whenever the user leaves the Scan view. */
let scanCameraStream = null;
let scanGuideRaf = 0;

/**
 * Live DeviceOrientationEvent state for the scan bubble-level.
 * pitch = beta (forward/back), roll = gamma (left/right), degrees.
 * sensorActive stays false until a real event arrives so desktop / denied
 * motion permission does not brick the Capture button.
 */
let scanLevelState = {
  listening: false,
  sensorActive: false,
  permission: 'unknown',
  rawPitch: null,
  rawRoll: null,
  pitch: null,
  roll: null,
  samples: [],
  isLevel: false,
  levelSince: 0,
  autoCaptureFired: false,
  lastLogAt: 0,
  watchdog: 0
};
let orientationHandler = null;
let pendingCaptureMeta = null;
let captureInFlight = false;

/**
 * Wallet/report field shim. Server historically used imagePath / gradingReport;
 * keep both spellings readable so older inventory rows still render.
 */
function itemImage(item) {
  return (item && (item.imagePath || item.imagePath)) || '';
}
function itemReport(item) {
  return (item && (item.gradingReport || item.gradingReport)) || null;
}
function itemHeadlineGrade(report) {
  if (!report) return '—';
  if (typeof report.finalScore === 'number') {
    return report.finalScore.toFixed(1) + ' ' + (report.label || '');
  }
  return report.label || '—';
}

const appRoot = document.getElementById('app');
const cameraInput = document.getElementById('cameraInput');
const scanBtn = document.getElementById('scanBtn');
const navBtns = Array.from(document.querySelectorAll('.nav-btn'));
const loginBtn = document.getElementById('loginBtn');

/* -------------------------
   Simple client-side state
   ------------------------- */
let state = {
  inventory: [],
  user: null,
  stats: null
};

/* -------------------------
   Routing (hash-based)
   ------------------------- */
function navigateTo(route) {
  window.location.hash = route;
  renderRoute(route);
  // update nav active
  navBtns.forEach(b => b.setAttribute('aria-pressed', b.dataset.route === route ? 'true' : 'false'));
}

function renderRoute(route) {
  // Always release the camera + motion listener when leaving (or re-entering) Scan.
  stopScanCamera();
  stopLevelSensor();
  if (!route || route === '#dashboard' || route === 'dashboard') {
    renderDashboard();
  } else if (route === '#inventory' || route === 'inventory') {
    renderInventory();
  } else if (route === '#scan' || route === 'scan') {
    renderScanView();
  } else {
    renderDashboard();
  }
}

/* -------------------------
   Renderers
   ------------------------- */
function renderDashboard() {
  appRoot.innerHTML = `
    <section class="grid cols-2">
      <div class="panel">
        <div class="dashboard-top">
          <div>
            <h2>Quick Dashboard</h2>
            <p class="muted">Pre-grade scans & quick wallet overview</p>
          </div>
          <div class="metrics">
            <div class="metric"><div id="totalCardsValue" class="value">${state.inventory.length}</div><div class="label">Total Cards</div></div>
            <div class="metric"><div id="walletValue" class="value">—</div><div class="label">Wallet Value (USD)</div></div>
            <div class="metric"><div id="pendingUploadsValue" class="value">0</div><div class="label">Pending Uploads</div></div>
          </div>
        </div>

        <div class="panel" id="cardGridWrap">
          <h3>Your Cards</h3>
          <div id="cardGrid" class="card-grid" aria-live="polite"></div>
        </div>
      </div>

      <aside class="panel">
        <h3>Wallet</h3>
        <div id="walletList" class="wallet-list"></div>
        <div style="margin-top:12px">
          <h4>Category Breakdown</h4>
          <div id="categoryBadges" style="display:flex; gap:8px; flex-wrap:wrap"></div>
        </div>
      </aside>
    </section>
  `;

  renderCardGrid();
  renderWallet();
  updateStatsUI();
}

function renderCardGrid() {
  const grid = document.getElementById('cardGrid');
  grid.innerHTML = '';
  if (!state.inventory.length) {
    grid.innerHTML = `<div class="panel"><p class="muted">No cards yet. Use Scan to add a card.</p></div>`;
    return;
  }
  state.inventory.forEach(item => {
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <img src="${itemImage(item)}" alt="${escapeHtml(item.name)}" class="thumb" />
      <div class="body">
        <div class="info">
          <div class="name">${escapeHtml(item.name)}</div>
          <div class="sub muted">Added: ${new Date(item.createdAt).toLocaleString()}</div>
        </div>
        <div class="grade">${itemHeadlineGrade(itemReport(item))}</div>
      </div>
    `;
    el.addEventListener('click', () => openReportModal(item));
    grid.appendChild(el);
  });
}

function renderWallet() {
  const list = document.getElementById('walletList');
  list.innerHTML = '';
  if (!state.inventory.length) {
    list.innerHTML = `<div class="muted">Your wallet is empty.</div>`;
    return;
  }
  // show top items
  state.inventory.slice(0, 12).forEach(item => {
    const row = document.createElement('div');
    row.className = 'wallet-item';
    row.innerHTML = `
      <img src="${itemImage(item)}" alt="${escapeHtml(item.name)}" />
      <div class="meta">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="sub">${itemReport(item) ? itemHeadlineGrade(itemReport(item)) : 'Unscanned'}</div>
      </div>
    `;
    row.addEventListener('click', () => openReportModal(item));
    list.appendChild(row);
  });

  // also show wallet totals if available
  if (state.stats && state.stats.stats && state.stats.stats.wallet) {
    const totalElem = document.getElementById('walletValue');
    if (totalElem) totalElem.textContent = `$${(state.stats.stats.wallet.totalValue || 0).toFixed(2)}`;
  }
}

function renderInventory() {
  appRoot.innerHTML = `
    <section>
      <div class="panel">
        <h2>Inventory</h2>
        <p class="muted">Full wallet list</p>
        <div id="inventoryList" style="margin-top:12px;"></div>
      </div>
    </section>
  `;
  const inv = document.getElementById('inventoryList');
  inv.innerHTML = state.inventory.map(item => `
    <div class="panel" style="margin-bottom:10px; display:flex; gap:12px; align-items:center;">
      <img src="${itemImage(item)}" alt="${escapeHtml(item.name)}" style="width:80px; height:64px; object-fit:cover; border-radius:8px;" />
      <div style="flex:1;">
        <div style="font-weight:700">${escapeHtml(item.name)}</div>
        <div class="muted">${itemReport(item) ? itemHeadlineGrade(itemReport(item)) : 'Unscanned'}</div>
      </div>
      <div><button class="small" onclick="openReportFromId('${item.id}')">Report</button></div>
    </div>
  `).join('');
}

/* Scan view (for hash navigation) */
function renderScanView() {
  appRoot.innerHTML = `
    <section class="panel">
      <h2>Scan New Card</h2>
      <p class="muted">Fill the neon 2.5×3.5 frame edge-to-edge. Hold the phone level until the bubble turns green — Capture stays locked until then, and auto-capture fires after a short hold. Lighting should be even — glare fools the surface pass.</p>
      <div style="margin-top:12px;">
        <input id="scanName" placeholder="Card name (optional)" style="padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.04); background:transparent; color:inherit; min-width:200px;" />
      </div>
      <div id="scanViewportMount"></div>
      <div id="previewArea" style="margin-top:14px;"></div>
    </section>
  `;

  const tpl = document.getElementById('scanViewportTemplate');
  const mount = document.getElementById('scanViewportMount');
  if (tpl && mount) {
    mount.appendChild(tpl.content.cloneNode(true));
    wireScanViewport();
  } else {
    mount.innerHTML = '<p class="muted">Alignment viewport unavailable. Use Upload Photo.</p>';
  }
}

/**
 * Bind Start / Capture / Upload / Stop controls on the cloned viewport.
 * Capture draws the current video frame (NOT the overlay) to a JPEG blob
 * and posts it through the same /api/grade path as a file upload.
 */
function wireScanViewport() {
  const startBtn = document.getElementById('startCameraBtn');
  const captureBtn = document.getElementById('captureBtn');
  const uploadBtn = document.getElementById('uploadInsteadBtn');
  const stopBtn = document.getElementById('stopCameraBtn');
  if (startBtn) {
    startBtn.addEventListener('click', function () {
      startLevelSensor();
      startScanCamera();
    });
  }
  if (captureBtn) {
    captureBtn.addEventListener('click', function () { captureFromCamera('manual'); });
  }
  if (uploadBtn) uploadBtn.addEventListener('click', () => cameraInput.click());
  if (stopBtn) stopBtn.addEventListener('click', stopScanCamera);
  // Paint the 2.5×3.5 overlay immediately so L-brackets / crosshair are
  // visible even before (or without) getUserMedia permission.
  sizeGuideCanvas();
  const canvas = document.getElementById('scanGuideCanvas');
  if (canvas) drawCardAlignmentGuides(canvas);
  requestAnimationFrame(function () { sizeGuideCanvas(); });
  window.addEventListener('resize', sizeGuideCanvas);
  updateLevelHud();
  startLevelSensor();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    startScanCamera();
  } else {
    setScanStatus('Live camera is not available in this browser. Use Upload Photo.');
  }
}

function setScanStatus(msg) {
  const el = document.getElementById('scanStatus');
  if (el) el.textContent = msg;
}

function snapshotCaptureTilt(mode) {
  return {
    pitch: scanLevelState.pitch,
    roll: scanLevelState.roll,
    rawPitch: scanLevelState.rawPitch,
    rawRoll: scanLevelState.rawRoll,
    isLevel: scanLevelState.isLevel,
    mode: mode || 'manual'
  };
}

function captureIsAllowed() {
  if (!scanLevelState.sensorActive) return true;
  return scanLevelState.isLevel;
}

function updateCaptureGate() {
  const btn = document.getElementById('captureBtn');
  if (!btn) return;
  const allowed = captureIsAllowed();
  btn.disabled = !allowed;
  btn.setAttribute('aria-disabled', allowed ? 'false' : 'true');
  btn.classList.toggle('is-disabled', !allowed);
  btn.title = allowed ? '' : 'Hold the phone level (green bubble) to capture';
}

function updateLevelHud() {
  const hud = document.getElementById('levelHud');
  const dot = document.getElementById('levelDot');
  const readout = document.getElementById('levelReadout');
  const SL = window.ScanLevel;
  if (!hud || !dot || !SL) {
    updateCaptureGate();
    return;
  }
  const has = scanLevelState.sensorActive && scanLevelState.pitch != null;
  hud.classList.toggle('is-level', Boolean(scanLevelState.isLevel));
  hud.classList.toggle('is-live', Boolean(has));
  if (readout) {
    if (!has) readout.textContent = 'P —°  R —°';
    else {
      readout.textContent =
        'P ' + scanLevelState.pitch.toFixed(1) + '°   R ' +
        scanLevelState.roll.toFixed(1) + '°';
    }
  }
  const radius = 28;
  if (scanLevelState.isLevel) {
    dot.style.transform = 'translate(-50%, -50%)';
  } else if (has) {
    const off = SL.bubbleOffset(scanLevelState.pitch, scanLevelState.roll, radius);
    dot.style.transform = 'translate(calc(-50% + ' + off.x + 'px), calc(-50% + ' + off.y + 'px))';
  } else {
    dot.style.transform = 'translate(-50%, -50%)';
  }
  updateCaptureGate();
}

function maybeAutoCapture(now) {
  const SL = window.ScanLevel;
  if (!SL || !scanCameraStream || captureInFlight) return;
  const held = scanLevelState.levelSince ? now - scanLevelState.levelSince : 0;
  if (!SL.shouldAutoCapture(scanLevelState.isLevel, held, scanLevelState.autoCaptureFired, SL.AUTO_CAPTURE_HOLD_MS)) {
    return;
  }
  scanLevelState.autoCaptureFired = true;
  setScanStatus('Held level — auto-capturing…');
  captureFromCamera('auto');
}

function onDeviceOrientation(event) {
  const SL = window.ScanLevel;
  if (!SL) return;
  const raw = SL.orientationFromDeviceEvent(event);
  if (!raw) return;
  const firstReading = !scanLevelState.sensorActive;
  scanLevelState.sensorActive = true;
  if (firstReading) {
    if (scanLevelState.watchdog) {
      clearTimeout(scanLevelState.watchdog);
      scanLevelState.watchdog = 0;
    }
    setScanStatus('Level sensor live. Hold green to auto-capture.');
  }
  scanLevelState.rawPitch = raw.pitch;
  scanLevelState.rawRoll = raw.roll;
  const smoothed = SL.pushSmoothedSample(
    scanLevelState.samples,
    raw.pitch,
    raw.roll,
    SL.SMOOTH_SAMPLE_COUNT
  );
  scanLevelState.samples = smoothed.samples;
  scanLevelState.pitch = smoothed.pitch;
  scanLevelState.roll = smoothed.roll;
  const now = Date.now();
  const wasLevel = scanLevelState.isLevel;
  scanLevelState.isLevel = SL.isDeviceLevel(
    scanLevelState.pitch,
    scanLevelState.roll,
    SL.LEVEL_TOLERANCE_DEG
  );
  if (scanLevelState.isLevel) {
    if (!wasLevel) scanLevelState.levelSince = now;
  } else {
    scanLevelState.levelSince = 0;
    scanLevelState.autoCaptureFired = false;
  }
  if (now - scanLevelState.lastLogAt >= SL.LOG_INTERVAL_MS) {
    scanLevelState.lastLogAt = now;
    console.log(
      '[The Judge level]',
      'pitch=' + scanLevelState.pitch.toFixed(2),
      'roll=' + scanLevelState.roll.toFixed(2),
      'rawP=' + raw.pitch.toFixed(2),
      'rawR=' + raw.roll.toFixed(2),
      'level=' + scanLevelState.isLevel
    );
  }
  updateLevelHud();
  maybeAutoCapture(now);
}

function attachOrientationListener() {
  if (scanLevelState.listening) return;
  orientationHandler = onDeviceOrientation;
  window.addEventListener('deviceorientation', orientationHandler, true);
  scanLevelState.listening = true;
  scanLevelState.permission = 'granted';
  if (scanLevelState.watchdog) clearTimeout(scanLevelState.watchdog);
  scanLevelState.watchdog = setTimeout(function () {
    if (!scanLevelState.sensorActive) {
      scanLevelState.permission = 'unsupported';
      setScanStatus('Level sensor not reporting. Capture stays manual. On iPhone use HTTPS (npm run start:lan) and allow Motion.');
      updateLevelHud();
    }
  }, 2500);
  updateLevelHud();
}

function startLevelSensor() {
  if (scanLevelState.listening || typeof window === 'undefined') return;
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(function (state) {
      if (state === 'granted') attachOrientationListener();
      else {
        scanLevelState.permission = 'denied';
        setScanStatus('Motion permission denied — capture stays manual. Tap Start Camera to retry.');
        updateLevelHud();
      }
    }).catch(function () {
      scanLevelState.permission = 'denied';
      setScanStatus('Tap Start Camera to enable the level sensor (required on iPhone).');
      updateLevelHud();
    });
    return;
  }
  if (typeof DeviceOrientationEvent === 'undefined') {
    scanLevelState.permission = 'unsupported';
    updateLevelHud();
    return;
  }
  attachOrientationListener();
}

function stopLevelSensor() {
  if (orientationHandler) {
    window.removeEventListener('deviceorientation', orientationHandler, true);
    orientationHandler = null;
  }
  if (scanLevelState.watchdog) {
    clearTimeout(scanLevelState.watchdog);
    scanLevelState.watchdog = 0;
  }
  scanLevelState.listening = false;
  scanLevelState.sensorActive = false;
  scanLevelState.samples = [];
  scanLevelState.pitch = null;
  scanLevelState.roll = null;
  scanLevelState.rawPitch = null;
  scanLevelState.rawRoll = null;
  scanLevelState.isLevel = false;
  scanLevelState.levelSince = 0;
  scanLevelState.autoCaptureFired = false;
  updateLevelHud();
}

window.__judgeSimulateOrientation = function (pitch, roll) {
  onDeviceOrientation({ beta: pitch, gamma: roll });
};
window.__judgeLevelState = function () { return scanLevelState; };

/**
 * Open the environment-facing camera, size the overlay canvas to the video
 * element, and start the rAF loop that redraws the 2.5×3.5 alignment frame.
 */
function startScanCamera() {
  const video = document.getElementById('scanVideo');
  if (!video) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScanStatus('Camera API missing. Use Upload Photo.');
    return;
  }
  stopScanCamera();
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 1720 }
    }
  };
  navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
    scanCameraStream = stream;
    video.srcObject = stream;
    const kick = function () { sizeGuideCanvas(); loopGuideOverlay(); };
    if (video.readyState >= 2) kick();
    else video.onloadedmetadata = kick;
    setScanStatus('Camera live. Hold level (green bubble) to capture — auto-fires after a short hold.');
  }).catch(function (err) {
    setScanStatus('Camera blocked (' + (err && err.message ? err.message : 'permission') + '). Use Upload Photo.');
  });
}

function stopScanCamera() {
  if (scanGuideRaf) {
    cancelAnimationFrame(scanGuideRaf);
    scanGuideRaf = 0;
  }
  if (scanCameraStream) {
    scanCameraStream.getTracks().forEach(function (t) { t.stop(); });
    scanCameraStream = null;
  }
  const video = document.getElementById('scanVideo');
  if (video) video.srcObject = null;
}

function sizeGuideCanvas() {
  const canvas = document.getElementById('scanGuideCanvas');
  const stage = document.getElementById('scanStage');
  if (!canvas || !stage) return;
  const dpr = window.devicePixelRatio || 1;
  const box = stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width) || stage.clientWidth || 320);
  const h = Math.max(1, Math.round(box.height) || stage.offsetHeight || Math.round(w * 4 / 3));
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawCardAlignmentGuides(canvas);
}

function loopGuideOverlay() {
  const canvas = document.getElementById('scanGuideCanvas');
  if (!canvas) return;
  drawCardAlignmentGuides(canvas);
  scanGuideRaf = requestAnimationFrame(loopGuideOverlay);
}

/**
 * High-contrast 2.5×3.5 card frame.
 *
 * Layers (back → front):
 *   1. Dark mask with a punched-out card window (keeps the card bright)
 *   2. Thick white outer stroke (readable on holofoil AND black borders)
 *   3. Cyan inner stroke (brand / neon)
 *   4. L-brackets at the four corners (true edge targets)
 *   5. Dashed 50/50 crosshair (centering)
 *   6. Inner dashed 60/40 PSA window (~10% inset)
 *
 * Coordinates are in CSS pixels (the context is already DPR-scaled).
 */
function drawCardAlignmentGuides(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  ctx.clearRect(0, 0, cssW, cssH);

  const frame = cardFrameRect(cssW, cssH);
  const x = frame.x;
  const y = frame.y;
  const w = frame.w;
  const h = frame.h;

  // 1. Mask outside the card window.
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  // 2. White outer stroke.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 6;
  ctx.strokeRect(x, y, w, h);

  // 3. Cyan inner stroke.
  ctx.strokeStyle = '#00f6ff';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);

  // 4. Corner L-brackets.
  const arm = Math.min(w, h) * 0.12;
  ctx.strokeStyle = '#00f6ff';
  ctx.lineWidth = 5;
  ctx.lineCap = 'square';
  drawL(ctx, x, y, arm, 1, 1);
  drawL(ctx, x + w, y, arm, -1, 1);
  drawL(ctx, x, y + h, arm, 1, -1);
  drawL(ctx, x + w, y + h, arm, -1, -1);

  // 5. 50/50 crosshair.
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w / 2, y + h);
  ctx.moveTo(x, y + h / 2);
  ctx.lineTo(x + w, y + h / 2);
  ctx.stroke();

  // 6. Inner 60/40 PSA window (10% inset on each side).
  const insetX = w * 0.10;
  const insetY = h * 0.10;
  ctx.strokeStyle = 'rgba(0, 246, 255, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + insetX, y + insetY, w - insetX * 2, h - insetY * 2);
  ctx.setLineDash([]);
}

function drawL(ctx, ox, oy, arm, dirX, dirY) {
  ctx.beginPath();
  ctx.moveTo(ox, oy + dirY * arm);
  ctx.lineTo(ox, oy);
  ctx.lineTo(ox + dirX * arm, oy);
  ctx.stroke();
}

function cardFrameRect(canvasW, canvasH) {
  const pad = Math.min(canvasW, canvasH) * 0.08;
  let h = canvasH - pad * 2;
  let w = h * CARD_ASPECT;
  if (w > canvasW - pad * 2) {
    w = canvasW - pad * 2;
    h = w / CARD_ASPECT;
  }
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w: w, h: h };
}

/**
 * Snapshot the live video (guides are overlay-only and are NOT burned in),
 * JPEG-encode, and send through the same grading pipeline as a file upload.
 */
function captureFromCamera(mode) {
  if (captureInFlight) return;
  if (!captureIsAllowed()) {
    setScanStatus('Hold the phone level (green bubble) to capture.');
    return;
  }
  const video = document.getElementById('scanVideo');
  if (!video || !scanCameraStream) {
    setScanStatus('Start the camera first, or use Upload Photo.');
    return;
  }
  captureInFlight = true;
  pendingCaptureMeta = snapshotCaptureTilt(mode || 'manual');
  const snap = document.createElement('canvas');
  snap.width = video.videoWidth || 1280;
  snap.height = video.videoHeight || 1720;
  const ctx = snap.getContext('2d');
  ctx.drawImage(video, 0, 0, snap.width, snap.height);
  setScanStatus(mode === 'auto' ? 'Held level — captured.' : 'Capturing…');
  const onBlob = function (blob) {
    captureInFlight = false;
    if (!blob) {
      setScanStatus('Capture failed. Try Upload Photo.');
      return;
    }
    const file = new File([blob], 'scan-capture.jpg', { type: 'image/jpeg' });
    previewAndOfferUpload(file);
  };
  if (snap.toBlob) snap.toBlob(onBlob, 'image/jpeg', 0.92);
  else {
    const dataUrl = snap.toDataURL('image/jpeg', 0.92);
    const bin = atob(dataUrl.split(',')[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    onBlob(new Blob([arr], { type: 'image/jpeg' }));
  }
}

/* Modal report — 10-point Judge scale, with 0–100 projections as secondary. */
function openReportModal(item) {
  const report = itemReport(item);
  const modal = document.createElement('div');
  modal.className = 'modal';
  const scoreLine = report && typeof report.finalScore === 'number'
    ? report.finalScore.toFixed(1) + ' ' + (report.label || '')
    : (report ? report.label : 'Unscanned');
  const sub = report && report.subGrades ? report.subGrades : null;
  const ceiling = report && report.conditionCeilingApplied
    ? '<p class="ceiling-flag">0.5-point condition ceiling applied (final cannot exceed worst sub-grade + 0.5).</p>'
    : '';
  const diag = report && report.centeringDiagnostics ? report.centeringDiagnostics : null;
  const diagBox = diag && diag.box
    ? diag.box.width + '×' + diag.box.height +
      ' at (' + diag.box.left + ',' + diag.box.top + ')'
    : '—';
  const diagFill = diag && typeof diag.boxFillRatio === 'number'
    ? Math.round(diag.boxFillRatio * 100) + '%'
    : '—';
  const w = diag && diag.printBorderWidths ? diag.printBorderWidths : {};
  const diagWidths = diag
    ? 'L ' + fmtPx(w.left) + ' · R ' + fmtPx(w.right) +
      ' · T ' + fmtPx(w.top) + ' · B ' + fmtPx(w.bottom)
    : '—';
  const tilt = report && report.captureTilt ? report.captureTilt : null;
  const tiltHtml = tilt ? (
    '<p class="muted">Capture tilt: P ' +
    (tilt.pitchDeg != null ? Number(tilt.pitchDeg).toFixed(1) + '°' : '—') +
    ' · R ' +
    (tilt.rollDeg != null ? Number(tilt.rollDeg).toFixed(1) + '°' : '—') +
    (tilt.mode ? ' · ' + escapeHtml(String(tilt.mode)) : '') +
    (tilt.isLevel ? ' · level' : '') +
    '</p>'
  ) : '';
  const diagHtml = diag ? `
    <div class="centering-diag">
      <h4 style="margin:14px 0 6px 0;">Scan diagnostics</h4>
      <p class="diag-hint">${escapeHtml(diag.hint || '')}</p>
      <p class="muted">${escapeHtml(diag.summary || '')}</p>
      <ul>
        <li>Photo: ${diag.imageWidth || '—'}×${diag.imageHeight || '—'}</li>
        <li>Card box: ${escapeHtml(diagBox)} — ${escapeHtml(diagFill)} of photo</li>
        <li>Print borders (px): ${escapeHtml(diagWidths)}</li>
        <li>L/R sample spread: ${fmtPx(diag.leftRightSampleSpreadPx)} · T/B sample spread: ${fmtPx(diag.topBottomSampleSpreadPx)}</li>
      </ul>
      ${diag.axisSpreadNote ? '<p class="muted">' + escapeHtml(diag.axisSpreadNote) + '</p>' : ''}
      ${tiltHtml}
    </div>
  ` : (tiltHtml ? '<div class="centering-diag">' + tiltHtml + '</div>' : '');
  const subLine = report && report.subGradesLabel
    ? '<p><span class="subgrade-pill">' + escapeHtml(report.subGradesLabel) + '</span></p>'
    : (sub
      ? '<p>' +
        '<span class="subgrade-pill">CEN ' + sub.centering + '</span>' +
        '<span class="subgrade-pill">SUR ' + sub.surface + '</span>' +
        '<span class="subgrade-pill">EDG ' + sub.edges + '</span>' +
        '<span class="subgrade-pill">CRN ' + sub.corners + '</span>' +
        '</p>'
      : '');
  modal.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" aria-label="Grading Report">
      <button id="closeModal" style="float:right" class="small">Close</button>
      <h3>${escapeHtml(item.name)}</h3>
      <div style="display:flex; gap:12px; margin-top:12px; flex-wrap:wrap;">
        <img src="${itemImage(item)}" alt="${escapeHtml(item.name)}" style="width:180px; height:220px; object-fit:cover; border-radius:8px; flex-shrink:0;" />
        <div>
          <h4 style="margin:0 0 8px 0;">Judge Grade: <span style="color:var(--accent)">${escapeHtml(scoreLine)}</span></h4>
          ${subLine}
          ${ceiling}
          ${report ? `
            <ul>
              <li>Centering (0–100 projection): ${report.centering}</li>
              <li>Corners (0–100 projection): ${report.corners}</li>
              <li>Edges (0–100 projection): ${report.edges}</li>
              <li>Surface (0–100 projection): ${report.surface}</li>
              <li><strong>Weighted projection: ${report.weighted}</strong></li>
            </ul>
            <p class="muted">${escapeHtml(report.primaryFlawDescription || report.notes || '')}</p>
            ${diagHtml}
          ` : `<p class="muted">No grading report available.</p>`}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#closeModal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

/* For inline onclick in inventory HTML */
window.openReportFromId = (id) => {
  const item = state.inventory.find(i => i.id === id);
  if (item) openReportModal(item);
};

/* -------------------------
   Event wiring
   ------------------------- */
navBtns.forEach(btn => btn.addEventListener('click', (e) => navigateTo(btn.dataset.route)));
window.addEventListener('hashchange', () => renderRoute(location.hash.replace('#','')));

scanBtn.addEventListener('click', () => {
  // Route into the guided camera viewport (file input is the fallback there).
  navigateTo('scan');
});

/**
 * Shared preview + POST /api/grade path used by both live capture and file upload.
 * @param {File} file
 */
function previewAndOfferUpload(file) {
  const captureMeta = pendingCaptureMeta;
  pendingCaptureMeta = null;
  const previewArea = document.getElementById('previewArea') || (function(){ renderScanView(); return document.getElementById('previewArea'); })();
  const nameInput = document.getElementById('scanName');
  const previewUrl = URL.createObjectURL(file);

  previewArea.innerHTML = `
    <div style="display:flex; gap:12px; align-items:flex-start;">
      <img src="${previewUrl}" alt="Preview" style="width:160px; height:200px; object-fit:cover; border-radius:8px;" />
      <div style="flex:1;">
        <p style="margin:0 0 8px 0;"><strong>Ready to grade</strong></p>
        <div style="display:flex; gap:8px;">
          <button id="uploadBtn" class="small">Upload &amp; Grade</button>
          <button id="retakeBtn" class="small">Retake</button>
        </div>
        <div id="uploadStatus" style="margin-top:8px;"></div>
      </div>
    </div>
  `;

  document.getElementById('retakeBtn').addEventListener('click', () => {
    cameraInput.value = '';
    previewArea.innerHTML = '';
    scanLevelState.autoCaptureFired = false;
    scanLevelState.levelSince = 0;
  });

  document.getElementById('uploadBtn').addEventListener('click', async () => {
    const fname = (nameInput && nameInput.value) || file.name || 'Scanned Card';
    const fd = new FormData();
    fd.append('image', file, file.name);
    fd.append('name', fname);
    // Always request metrology dumps while we settle printed-frame vs backdrop
    // and L/R vs T/B drift. The report modal reads centeringDiagnostics even
    // if this flag is later turned off.
    fd.append('debug', 'true');
    if (captureMeta && captureMeta.pitch != null && captureMeta.roll != null) {
      fd.append('capturePitch', String(captureMeta.pitch));
      fd.append('captureRoll', String(captureMeta.roll));
      fd.append('captureLevel', captureMeta.isLevel ? 'true' : 'false');
      fd.append('captureMode', captureMeta.mode || 'manual');
    }

    const status = document.getElementById('uploadStatus');
    status.innerHTML = 'Uploading to The Judge…';

    try {
      const res = await api.uploadImage(fd);
      if (!res.ok) throw new Error(res.error || 'Upload failed');
      state.inventory.unshift(res.item);
      status.innerHTML = 'Grade complete.';
      try {
        const s = await api.getStats();
        if (s && s.ok) state.stats = s;
      } catch (e) { /* ignore stats refresh error */ }
      stopScanCamera();
      renderDashboard();
      openReportModal(res.item);
      cameraInput.value = '';
    } catch (err) {
      status.innerHTML = `<span style="color:var(--danger)">Error: ${escapeHtml(err.message || String(err))}</span>`;
    }
  });
}

/* Camera / file input handler */
cameraInput.addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  previewAndOfferUpload(file);
});

/* Auth mock */
loginBtn.addEventListener('click', async () => {
  const username = prompt('Enter a username for Phase 1 (no password required):');
  if (!username) return;
  const res = await api.login({ username });
  if (res.ok) {
    state.user = { username: res.username, token: res.token };
    localStorage.setItem('phase1_user', JSON.stringify(state.user));
    loginBtn.textContent = `Hi ${state.user.username}`;
  } else {
    alert('Login failed');
  }
});

/* -------------------------
   Boot: load inventory and init route
   ------------------------- */
async function bootstrap() {
  // load cached user
  const stored = localStorage.getItem('phase1_user');
  if (stored) {
    try { state.user = JSON.parse(stored); loginBtn.textContent = `Hi ${state.user.username}`; } catch(e){ /* ignore */ }
  }

  // load inventory from server (port 5000)
  try {
    const res = await api.getInventory();
    if (res && res.ok) state.inventory = res.inventory || [];
  } catch (err) {
    console.warn('Could not fetch inventory', err);
  }

  // load unified stats from server (port 5000) — one-time fetch for immediate UI fill
  try {
    const s = await api.getStats();
    if (s && s.ok) state.stats = s;
  } catch (err) {
    console.warn('Could not fetch stats (initial)', err);
  }

  // Start SSE for live updates (or polling fallback)
  initSse();

  // initial render based on hash
  const route = location.hash.replace('#','') || 'dashboard';
  renderRoute(route);
}

bootstrap();

/* -------------------------
   Small helpers
   ------------------------- */
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>\"']/g, function (c) {
    return ({ '&': '&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'": '&#39;' })[c];
  });
}

function fmtPx(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return (Math.round(n * 10) / 10) + 'px';
}

function updateStatsUI() {
  // state.stats structure: { ok: true, stats: { inventorySize, categoryCounts, wallet } }
  if (!state.stats || !state.stats.stats) return;
  const stats = state.stats.stats;
  // inventory size
  const totalEl = document.getElementById('totalCardsValue');
  if (totalEl) totalEl.textContent = stats.inventorySize != null ? String(stats.inventorySize) : String(state.inventory.length);
  // wallet total
  const walletEl = document.getElementById('walletValue');
  if (walletEl) walletEl.textContent = `$${(stats.wallet && stats.wallet.totalValue ? stats.wallet.totalValue.toFixed(2) : 0.00)}`;
  // category badges
  const badges = document.getElementById('categoryBadges');
  if (badges) {
    badges.innerHTML = '';
    const cc = stats.categoryCounts || {};
    Object.keys(cc).forEach(k => {
      const b = document.createElement('div');
      b.className = 'badge';
      b.textContent = `${k}: ${cc[k]}`;
      badges.appendChild(b);
    });
  }
  // pending uploads (keep placeholder behavior)
  const pendingEl = document.getElementById('pendingUploadsValue');
  if (pendingEl) pendingEl.textContent = '0';
}

// Initialize Server-Sent Events for live stats updates (fallbacks to polling)
function initSse() {
  // Attempt native EventSource first
  if (window.EventSource) {
    try {
      const es = new EventSource('/api/events');

      es.addEventListener('stats', (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload && payload.ok) {
            state.stats = payload;
            updateStatsUI();
          }
        } catch (err) {
          console.warn('Failed to parse SSE stats payload', err);
        }
      });

      es.onopen = () => {
        console.log('SSE connected to /api/events');
      };
      es.onerror = (err) => {
        console.warn('SSE error, will attempt reconnect in 5s', err);
        try { es.close(); } catch (_) {}
        // backoff reconnect
        setTimeout(initSse, 5000);
      };

      // store reference to allow manual close if needed
      window._sseEventSource = es;
      return;
    } catch (e) {
      console.warn('SSE initialization failed, falling back to polling', e);
    }
  }

  // Fallback: polling every 10s
  console.warn('EventSource not available; falling back to polling for stats (10s interval).');
  window._ssePoller = setInterval(async () => {
    try {
      const s = await api.getStats();
      if (s && s.ok) {
        state.stats = s;
        updateStatsUI();
      }
    } catch (err) {
      // ignore poll error
    }
  }, 10000);
}
