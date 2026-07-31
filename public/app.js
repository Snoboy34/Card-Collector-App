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
  // Load persisted cards from the server-side JSON DB
  getInventory: () => fetch('/api/cards').then(r => r.json()),
  // Use the new memory-buffer grading endpoint so uploads are graded by the real engine.
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
   Simple client-side state
   ------------------------- */
let state = {
  inventory: [],
  user: null
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
        <div class="dashboard-top">
          <div>
            <h2>Quick Dashboard</h2>
            <p class="muted">Pre-grade scans & quick wallet overview</p>
          </div>
          <div class="metrics">
            <div class="metric"><div class="value">${state.inventory.length}</div><div class="label">Total Cards</div></div>
            <div class="metric"><div class="value">—</div><div class="label">Avg Grade (mock)</div></div>
            <div class="metric"><div class="value">0</div><div class="label">Pending Uploads</div></div>
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
      </aside>
    </section>
  `;

  renderCardGrid();
  renderWallet();
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
      state.inventory.unshift(res.item);
      status.innerHTML = 'Upload complete. Report ready.';
      renderDashboard();
      openReportModal(res.item);
      cameraInput.value = '';
    } catch (err) {
      status.innerHTML = `<span style="color:var(--danger)">Error: ${escapeHtml(err.message || String(err))}</span>`;
    }
  });
});

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

  // load inventory from server
  try {
    const res = await api.getInventory();
    if (res.ok) state.inventory = res.cards || res.inventory || [];
  } catch (err) {
    console.warn('Could not fetch inventory', err);
  }

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
  return String(s).replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;', '"':'&quot;',"'":'&#39;'})[m]; });
}

/* End of app.js */
