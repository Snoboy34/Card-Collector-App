/**
 * public/app.js
 * Phase 1 client-side: lightweight routing, camera trigger, image upload to /api/grade,
 * inventory rendering, and mock-auth interactions.
 *
 * Guidelines:
 * - Hash-based routing for simple SPA navigation.
 * - Progressive enhancement: works with basic browsers; uses camera when available.
 */

/* -------------------------
   Utilities
   ------------------------- */
const api = {
  // Inventory fetch (keeps legacy behavior if available)
  getInventory: () => fetch('/api/inventory').then(r => r.json()),
  // GET unified stats from the backend
  getStats: () => fetch('/api/stats').then(r => r.json()),
  // Use the memory-buffer grading endpoint so uploads are graded by the real engine.
  uploadImage: (formData) => fetch('/api/grade', { method: 'POST', body: formData }).then(r => r.json()),
  signup: (payload) => fetch('/api/auth/signup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).then(r=>r.json()),
  login: (payload) => fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).then(r=>r.json())
};

const appRoot = document.getElementById('app');
const cameraInput = document.getElementById('cameraInput');
const scanBtn = document.getElementById('scanBtn');
const navBtns = Array.from(document.querySelectorAll('.nav-btn'));
const loginBtn = document.getElementById('loginBtn');

/* -------------------------
   Inject small CSS for SSE badge + badge utility styles
   (so you can paste this single file without editing CSS files)
   ------------------------- */
(function injectSseBadgeStyles() {
  const css = `
/* SSE status badge styles (inserted by public/app.js) */
.sse-badge {
  display:inline-block;
  padding:4px 8px;
  border-radius:999px;
  font-size:0.85rem;
  font-weight:600;
  line-height:1;
  vertical-align:middle;
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
}
.sse-live { background:#10b981; color:#fff; }
.sse-reconnecting { background:#f59e0b; color:#111; }
.sse-polling { background:#fb923c; color:#111; }
.sse-off { background:#6b7280; color:#fff; opacity:0.95; }
.badge { padding:4px 8px; border-radius:999px; background:rgba(255,255,255,0.04); color:inherit; font-size:0.85rem; }
`;
  const s = document.createElement('style');
  s.setAttribute('data-generated-by', 'public-app-sse-badge');
  s.textContent = css;
  document.head.appendChild(s);
})();

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
        <div class="dashboard-top" style="display:flex; align-items:center; gap:12px;">
          <div>
            <h2>Quick Dashboard</h2>
            <p class="muted">Pre-grade scans & quick wallet overview</p>
          </div>
          <div style="margin-left:auto;">
            <span id="sseStatusBadge" class="sse-badge sse-off" title="Realtime status">Realtime: offline</span>
          </div>
        </div>

        <div style="margin-top:12px" class="metrics-row">
          <div class="metrics">
            <div class="metric"><div id="totalCardsValue" class="value">${state.inventory.length}</div><div class="label">Total Cards</div></div>
            <div class="metric"><div id="walletValue" class="value">—</div><div class="label">Wallet Value (USD)</div></div>
            <div class="metric"><div id="pendingUploadsValue" class="value">0</div><div class="label">Pending Uploads</div></div>
          </div>
        </div>

        <div class="panel" id="cardGridWrap" style="margin-top:12px;">
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
      <img src="${item.imagePath}" alt="${escapeHtml(item.name)}" class="thumb" />
      <div class="body">
        <div class="info">
          <div class="name">${escapeHtml(item.name)}</div>
          <div class="sub muted">Added: ${new Date(item.createdAt).toLocaleString()}</div>
        </div>
        <div class="grade">${item.gradingReport ? item.gradingReport.label : '—'}</div>
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
      <img src="${item.imagePath}" alt="${escapeHtml(item.name)}" />
      <div class="meta">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="sub">${item.gradingReport ? item.gradingReport.label + ' • ' + item.gradingReport.weighted : 'Unscanned'}</div>
      </div>
    `;
    row.addEventListener('click', () => openReportModal(item));
    list.appendChild(row);
  });

  // also show wallet totals if available
  if (state.stats && state.stats.stats && state.stats.stats.wallet) {
    const totalElem = document.getElementById('walletValue');
    if (totalElem) {
      const val = (state.stats.stats.wallet.totalValue != null) ? state.stats.stats.wallet.totalValue : 0;
      totalElem.textContent = `$${Number(val).toFixed(2)}`;
    }
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
      <img src="${item.imagePath}" alt="${escapeHtml(item.name)}" style="width:80px; height:64px; object-fit:cover; border-radius:8px;" />
      <div style="flex:1;">
        <div style="font-weight:700">${escapeHtml(item.name)}</div>
        <div class="muted">${item.gradingReport ? item.gradingReport.label + ' • ' + item.gradingReport.weighted : 'Unscanned'}</div>
      </div>
      <div><button class="small" onclick="openReportFromId('${item.id}')">Report</button></div>
    </div>
  `).join('');
}

/* Scan view (for hash navigation) */
function renderScanView() {
  // Fixed truncated template: provide a full input for scanName and preview area
  appRoot.innerHTML = `
    <section class="panel">
      <h2>Scan New Card</h2>
      <p class="muted">Use your device camera or upload a photo. For best results, use a plain background and good lighting.</p>
      <div style="margin-top:12px;">
        <button id="openCamera" class="small">Open Camera</button>
        <input id="scanName" placeholder="Card name (optional)" style="margin-left:12px; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.04); background:transparent; color:inherit;" />
      </div>
      <div id="previewArea" style="margin-top:14px;"></div>
    </section>
  `;

  document.getElementById('openCamera').addEventListener('click', () => cameraInput.click());
}

/* Modal report */
function openReportModal(item) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true" aria-label="Grading Report">
      <button id="closeModal" style="float:right" class="small">Close</button>
      <h3>${escapeHtml(item.name)}</h3>
      <div style="display:flex; gap:12px; margin-top:12px;">
        <img src="${item.imagePath}" alt="${escapeHtml(item.name)}" style="width:180px; height:220px; object-fit:cover; border-radius:8px; flex-shrink:0;" />
        <div>
          <h4 style="margin:0 0 8px 0;">Grade: <span style="color:var(--accent)">${item.gradingReport ? item.gradingReport.label : 'Unscanned'}</span></h4>
          ${item.gradingReport ? `
            <ul>
              <li>Centering: ${item.gradingReport.centering}</li>
              <li>Corners: ${item.gradingReport.corners}</li>
              <li>Edges: ${item.gradingReport.edges}</li>
              <li>Surface: ${item.gradingReport.surface}</li>
              <li><strong>Weighted: ${item.gradingReport.weighted}</strong></li>
            </ul>
            <p class="muted">${escapeHtml(item.gradingReport.notes)}</p>
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
  // Exposes the file input for camera on mobile
  cameraInput.click();
});

/* Camera input handler */
cameraInput.addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  // Show instant preview
  const previewArea = document.getElementById('previewArea') || (function(){ renderScanView(); return document.getElementById('previewArea'); })();
  const nameInput = document.getElementById('scanName');
  const previewUrl = URL.createObjectURL(file);

  previewArea.innerHTML = `
    <div style="display:flex; gap:12px; align-items:flex-start;">
      <img src="${previewUrl}" alt="Preview" style="width:160px; height:200px; object-fit:cover; border-radius:8px;" />
      <div style="flex:1;">
        <p style="margin:0 0 8px 0;"><strong>Ready to upload</strong></p>
        <div style="display:flex; gap:8px;">
          <button id="uploadBtn" class="small">Upload & Grade</button>
          <button id="retakeBtn" class="small">Retake</button>
        </div>
        <div id="uploadStatus" style="margin-top:8px;"></div>
      </div>
    </div>
  `;

  document.getElementById('retakeBtn').addEventListener('click', () => {
    cameraInput.value = '';
    previewArea.innerHTML = '';
  });

  document.getElementById('uploadBtn').addEventListener('click', async () => {
    const fname = (nameInput && nameInput.value) || file.name || 'Scanned Card';
    const fd = new FormData();
    fd.append('image', file, file.name);
    fd.append('name', fname);

    const status = document.getElementById('uploadStatus');
    status.innerHTML = 'Uploading...';

    try {
      const res = await api.uploadImage(fd);
      if (!res.ok) throw new Error(res.error || 'Upload failed');
      // Server returns the full item object; push into state
      state.inventory.unshift(res.item);
      status.innerHTML = 'Upload complete. Report ready.';
      // Re-render dashboard and wallet
      // Fetch fresh stats from server to update wallet totals & counts
      try {
        const s = await api.getStats();
        if (s && s.ok) state.stats = s;
      } catch (e) { /* ignore stats refresh error */ }
      renderDashboard();
      // Open report modal for the freshly uploaded item
      openReportModal(res.item);
      // Clear input
      cameraInput.value = '';
    } catch (err) {
      status.innerHTML = `<span style="color:var(--danger)">Error: ${escapeHtml(err.message || String(err))}</span>`;
    }
  });
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
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'": '&#39;' })[c];
  });
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
  if (walletEl) walletEl.textContent = `$${(stats.wallet && stats.wallet.totalValue ? stats.wallet.totalValue.toFixed(2) : (0).toFixed(2))}`;
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

/* -------------------------
   SSE status badge helper
   ------------------------- */
function updateSseStatus(status) {
  // status: 'live' | 'reconnecting' | 'polling' | 'offline'
  const badge = document.getElementById('sseStatusBadge');
  if (!badge) return;
  badge.classList.remove('sse-live','sse-reconnecting','sse-polling','sse-off');
  switch (status) {
    case 'live':
      badge.textContent = 'Realtime: live';
      badge.classList.add('sse-live');
      badge.title = 'Realtime connection is live';
      break;
    case 'reconnecting':
      badge.textContent = 'Realtime: reconnecting';
      badge.classList.add('sse-reconnecting');
      badge.title = 'Realtime connection is reconnecting';
      break;
    case 'polling':
      badge.textContent = 'Realtime: polling';
      badge.classList.add('sse-polling');
      badge.title = 'Using polling fallback for realtime updates';
      break;
    default:
      badge.textContent = 'Realtime: offline';
      badge.classList.add('sse-off');
      badge.title = 'Realtime connection is offline';
      break;
  }
}

/* -------------------------
   Initialize Server-Sent Events for live stats updates (fallbacks to polling)
   ------------------------- */
function initSse() {
  // Clear any previous
  try { if (window._sseEventSource) { window._sseEventSource.close(); window._sseEventSource = null; } } catch(_) {}
  try { if (window._ssePoller) { clearInterval(window._ssePoller); window._ssePoller = null; } } catch(_) {}

  // If badge exists set offline while we try
  updateSseStatus('reconnecting');

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
            updateSseStatus('live');
          }
        } catch (err) {
          console.warn('Failed to parse SSE stats payload', err);
        }
      });

      es.onopen = () => {
        console.log('SSE connected to /api/events');
        updateSseStatus('live');
      };
      es.onerror = (err) => {
        console.warn('SSE error, will attempt reconnect in 5s', err);
        updateSseStatus('reconnecting');
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
  } else {
    console.warn('EventSource not supported by browser; falling back to polling');
  }

  // Fallback: polling every 10s
  updateSseStatus('polling');
  let consecutiveFail = 0;
  window._ssePoller = setInterval(async () => {
    try {
      const s = await api.getStats();
      if (s && s.ok) {
        state.stats = s;
        updateStatsUI();
        consecutiveFail = 0;
        updateSseStatus('polling');
      } else {
        consecutiveFail++;
      }
    } catch (err) {
      consecutiveFail++;
    }
    if (consecutiveFail >= 6) { // ~1 minute of failures
      updateSseStatus('offline');
    }
  }, 10000);
}
