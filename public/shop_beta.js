/**
 * iMac browser controls for the shop beta. Hidden while the switches are off.
 * Sign in with Apple stays on the iPhone. This page is the bench.
 */
(function () {
  var flags = { accounts: false, manualEntry: false, firstRunGuide: false };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function load() {
    return fetch('/api/beta').then(function (res) { return res.json(); }).then(function (body) {
      if (body && body.ok) flags = body;
      return flags;
    }).catch(function () { return flags; });
  }

  function mountScan() {
    var host = document.getElementById('shopBetaGuide');
    if (!host) return;
    load().then(function (current) {
      if (!current.firstRunGuide) {
        host.innerHTML = '';
        return;
      }
      var px = host.getAttribute('data-px');
      var url = '/api/beta/guide' + (px ? ('?pxPerMm=' + encodeURIComponent(px)) : '');
      return fetch(url).then(function (res) { return res.json(); }).then(function (body) {
        host.innerHTML = '<p class="muted">' + esc(body && body.text) + '</p>';
      });
    });
  }

  function noteScan(item) {
    var host = document.getElementById('shopBetaGuide');
    var px = item && item.capture && item.capture.pxPerMm;
    if (host && px) host.setAttribute('data-px', String(px));
    mountScan();
  }

  function mountReport(modal, item) {
    if (!modal || !item) return;
    load().then(function (current) {
      if (!current.manualEntry) return;
      var entry = item.cardEntry || {};
      var box = document.createElement('div');
      box.innerHTML =
        '<h4 style="margin:14px 0 6px 0;">Card</h4>' +
        '<p class="muted">Type the card. This does not change the prediction. It stays Unidentified until it has a name.</p>' +
        field('Name or player', 'name', entry.name) +
        field('Year', 'year', entry.year) +
        field('Set', 'set', entry.set) +
        field('Number', 'number', entry.number) +
        field('Game or sport', 'game', entry.game) +
        field('Notes', 'notes', entry.notes) +
        '<p><button type="button" id="saveCardEntry" class="small">Save card</button> <span id="cardEntryStatus" class="muted"></span></p>';
      var panel = modal.querySelector('.panel');
      if (panel) panel.appendChild(box);
      var button = box.querySelector('#saveCardEntry');
      if (!button) return;
      button.addEventListener('click', function () {
        var body = {};
        ['name', 'year', 'set', 'number', 'game', 'notes'].forEach(function (key) {
          var input = box.querySelector('[data-entry="' + key + '"]');
          body[key] = input ? input.value : '';
        });
        var status = box.querySelector('#cardEntryStatus');
        fetch('/api/scans/' + encodeURIComponent(item.scanId || item.id) + '/card-entry', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (res) { return res.json(); }).then(function (saved) {
          if (!saved || !saved.ok) throw new Error((saved && saved.error) || 'not saved');
          if (status) status.textContent = 'Saved. The prediction is unchanged.';
          var title = modal.querySelector('h3');
          if (title && saved.item) title.textContent = saved.item.name || 'Unidentified';
        }).catch(function (err) {
          if (status) status.textContent = err.message || 'not saved';
        });
      });
    });
  }

  function field(label, key, value) {
    return '<label class="muted" style="display:block; margin-top:6px;">' + esc(label) +
      '<input data-entry="' + key + '" value="' + esc(value || '') +
      '" style="display:block; width:100%; max-width:360px; margin-top:4px; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); background:transparent; color:inherit;" /></label>';
  }

  function mountSettings() {
    var host = document.getElementById('shopBetaSettings');
    if (!host) return;
    load().then(function (current) {
      if (!current.accounts && !current.manualEntry && !current.firstRunGuide) {
        host.innerHTML = '';
        return;
      }
      var lines = [];
      if (current.accounts) {
        lines.push('Sign in with Apple is on the iPhone app. This browser is the bench: scans with no account stay here, and a signed-in shop does not see them.');
      }
      if (current.manualEntry) lines.push('Typed card names are on. A card stays Unidentified until someone types a name.');
      if (current.firstRunGuide) lines.push('The first-scan guide is on. It shows the px/mm this scan measured.');
      host.innerHTML = '<p class="muted">' + lines.map(esc).join(' ') + '</p>';
    });
  }

  window.ShopBeta = {
    mountScan: mountScan,
    mountReport: mountReport,
    mountSettings: mountSettings,
    noteScan: noteScan
  };
})();
