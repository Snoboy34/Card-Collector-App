/**
 * public/centering_assist_ui.js
 * Drag a line parallel to one card edge on the warped card. The live
 * readout is millimetres. The grade is whatever the server stores — this
 * file does not score.
 */
'use strict';

(function (root) {
  var SIDES = ['left', 'right', 'top', 'bottom'];
  var SIDE_LABEL = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };
  var LOUPE = 148;
  var ZOOM = 4;

  function geo() {
    return root.CenteringAssist;
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function needsAssist(report) {
    var g = geo();
    if (!report || report.cardNotFound) return false;
    if (!g.warpBox(report)) return false;
    var status = g.sideStatus(report);
    var withheld = SIDES.some(function (side) { return status[side].withheld; });
    return withheld || g.centeringScoreWithheld(report);
  }

  function mount(parent, item, options) {
    options = options || {};
    var report = item && (item.gradingReport || null);
    var g = geo();
    if (!parent || !report || !g) return null;
    var box = g.warpBox(report);
    var scanId = item.scanId || report.scanId || '';
    parent.innerHTML = '';
    var wrap = el('div', 'centering-assist');
    parent.appendChild(wrap);

    var title = el('h4');
    title.textContent = 'Centering lines';
    wrap.appendChild(title);

    var intro = el('p', 'muted');
    if (needsAssist(report)) {
      intro.textContent = 'The engine withheld a side or the centering score. Cyan marks on the card are lines it measured. Drag an amber line, parallel to the card edge, for each side you want to set. The number is millimetres from that edge.';
    } else {
      intro.textContent = 'Drag a line to disagree with a side the engine measured. Your line is kept next to the engine\'s number. Neither replaces the other.';
    }
    wrap.appendChild(intro);

    if (!box || !scanId) {
      var missing = el('p', 'muted');
      missing.textContent = 'This scan has no warped card, so a line cannot be placed.';
      wrap.appendChild(missing);
      return { destroy: function () { parent.innerHTML = ''; } };
    }

    var frame = el('div', 'assist-frame');
    var img = el('img', 'assist-photo');
    img.alt = 'Warped card with the engine border lines';
    img.src = '/scans/' + encodeURIComponent(scanId) + '/oriented.jpg';
    var canvas = el('canvas', 'assist-canvas');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Drag a border line. The line stays parallel to the card edge.');
    var loupe = el('canvas', 'assist-loupe');
    loupe.width = LOUPE;
    loupe.height = LOUPE;
    loupe.hidden = true;
    frame.appendChild(img);
    frame.appendChild(canvas);
    frame.appendChild(loupe);
    wrap.appendChild(frame);

    var chips = el('div', 'assist-sides');
    wrap.appendChild(chips);
    var readout = el('p', 'assist-readout');
    readout.textContent = 'Choose a side, then drag.';
    wrap.appendChild(readout);
    var actions = el('div', 'assist-actions');
    var save = el('button', 'small');
    save.type = 'button';
    save.textContent = 'Save adjustment';
    save.disabled = true;
    var status = el('span', 'muted');
    actions.appendChild(save);
    actions.appendChild(status);
    wrap.appendChild(actions);

    var legend = el('p', 'muted assist-legend');
    legend.textContent = 'Amber is your line. A saved result is labelled assisted. The engine\'s measurement stays as it was.';
    wrap.appendChild(legend);

    var statusMap = g.sideStatus(report);
    var savedSides = report.centeringAssist && report.centeringAssist.sides;
    var selected = SIDES.filter(function (side) { return statusMap[side].withheld; })[0] || 'left';
    var userPx = { left: null, right: null, top: null, bottom: null };
    var dragging = false;
    var dirty = false;

    function imageReady() {
      return img.naturalWidth > 1 && img.naturalHeight > 1;
    }

    function syncCanvasSize() {
      if (!imageReady()) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      SIDES.forEach(function (side) {
        var row = savedSides && savedSides[side];
        if (!row || !g.isFiniteNumber(row.userWidthMm) || userPx[side] != null) return;
        userPx[side] = g.linePxFromWidthMm(side, row.userWidthMm, img.naturalWidth, img.naturalHeight);
      });
      draw();
      updateReadout();
    }

    function pointerToImage(event) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height)
      };
    }

    function axisValue(side, point) {
      if (side === 'left' || side === 'right') return point.x;
      return point.y;
    }

    function draw() {
      if (!canvas.width) return;
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      SIDES.forEach(function (side) {
        if (userPx[side] == null) return;
        strokeLine(ctx, side, userPx[side], '#ffb020', 3);
      });
    }

    function strokeLine(ctx, side, position, color, width) {
      ctx.save();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = width + 2;
      ctx.beginPath();
      trace(ctx, side, position);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      trace(ctx, side, position);
      ctx.stroke();
      ctx.restore();
    }

    function trace(ctx, side, position) {
      if (side === 'left' || side === 'right') {
        ctx.moveTo(position, 0);
        ctx.lineTo(position, canvas.height);
      } else {
        ctx.moveTo(0, position);
        ctx.lineTo(canvas.width, position);
      }
    }

    function drawLoupe(point) {
      if (!imageReady() || userPx[selected] == null) {
        loupe.hidden = true;
        return;
      }
      var src = LOUPE / ZOOM;
      var sx = point.x - src / 2;
      var sy = point.y - src / 2;
      var ctx = loupe.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, LOUPE, LOUPE);
      ctx.drawImage(img, sx, sy, src, src, 0, 0, LOUPE, LOUPE);
      var pos = userPx[selected];
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (selected === 'left' || selected === 'right') {
        var x = (pos - sx) * ZOOM;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, LOUPE);
      } else {
        var y = (pos - sy) * ZOOM;
        ctx.moveTo(0, y);
        ctx.lineTo(LOUPE, y);
      }
      ctx.stroke();
      loupe.hidden = false;
      var rect = frame.getBoundingClientRect();
      var localX = point.x * (rect.width / canvas.width);
      var localY = point.y * (rect.height / canvas.height);
      var left = localX - LOUPE / 2;
      var top = localY - LOUPE - 16;
      if (top < 0) top = localY + 16;
      if (left < 0) left = 0;
      if (left > rect.width - LOUPE) left = Math.max(0, rect.width - LOUPE);
      loupe.style.left = left + 'px';
      loupe.style.top = top + 'px';
    }

    function placedCount() {
      return SIDES.filter(function (side) { return userPx[side] != null && liveMm(side) != null; }).length;
    }

    function liveMm(side) {
      if (userPx[side] == null || !imageReady()) return null;
      return g.widthMmFromLine(side, userPx[side], img.naturalWidth, img.naturalHeight);
    }

    function updateReadout() {
      var mm = liveMm(selected);
      var row = statusMap[selected];
      if (mm == null) {
        readout.textContent = SIDE_LABEL[selected] + (row.withheld
          ? ' is withheld. Drag a line parallel to that edge.'
          : ' — engine ' + formatMm(row.engineWidthMm) + '. Drag to place your line.');
      } else if (row.withheld) {
        readout.textContent = SIDE_LABEL[selected] + ' — you ' + formatMm(mm) + ', assisted.';
      } else {
        readout.textContent = SIDE_LABEL[selected] + ' — you ' + formatMm(mm) + ', engine ' + formatMm(row.engineWidthMm) + '.';
      }
      save.disabled = !dirty || placedCount() === 0;
      paintChips();
    }

    function formatMm(value) {
      if (value == null || !isFinite(value)) return '—';
      return (Math.round(value * 1000) / 1000) + ' mm';
    }

    function paintChips() {
      chips.innerHTML = '';
      SIDES.forEach(function (side) {
        var button = el('button', 'assist-chip' + (side === selected ? ' is-selected' : ''));
        button.type = 'button';
        var row = statusMap[side];
        var mm = liveMm(side);
        var text = SIDE_LABEL[side] + ' — ';
        if (mm != null && row.withheld) text += 'you ' + formatMm(mm) + ' (assisted)';
        else if (mm != null) text += 'you ' + formatMm(mm) + ' (engine ' + formatMm(row.engineWidthMm) + ')';
        else if (row.withheld) text += 'withheld';
        else text += 'engine ' + formatMm(row.engineWidthMm);
        button.textContent = text;
        button.addEventListener('click', function () {
          selected = side;
          updateReadout();
          draw();
        });
        chips.appendChild(button);
      });
    }

    function onPointerDown(event) {
      if (!imageReady()) return;
      var point = pointerToImage(event);
      if (!point) return;
      dragging = true;
      dirty = true;
      canvas.setPointerCapture(event.pointerId);
      userPx[selected] = clampToCard(selected, axisValue(selected, point));
      draw();
      drawLoupe(point);
      updateReadout();
    }

    function clampToCard(side, position) {
      var max = (side === 'left' || side === 'right') ? canvas.width - 1 : canvas.height - 1;
      if (position < 0) return 0;
      if (position > max) return max;
      return position;
    }

    function onPointerMove(event) {
      if (!dragging) return;
      var point = pointerToImage(event);
      if (!point) return;
      userPx[selected] = clampToCard(selected, axisValue(selected, point));
      draw();
      drawLoupe(point);
      updateReadout();
    }

    function onPointerUp() {
      dragging = false;
      loupe.hidden = true;
      updateReadout();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    img.addEventListener('load', syncCanvasSize);
    if (img.complete) syncCanvasSize();

    save.addEventListener('click', function () {
      var lines = {};
      SIDES.forEach(function (side) {
        var mm = liveMm(side);
        if (userPx[side] == null || mm == null) return;
        lines[side] = {
          positionPx: userPx[side],
          warpWidth: img.naturalWidth,
          warpHeight: img.naturalHeight
        };
      });
      if (!Object.keys(lines).length) return;
      save.disabled = true;
      status.textContent = 'Saving…';
      fetch('/api/scans/' + encodeURIComponent(scanId) + '/centering-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: lines, consent: options.consent === true })
      }).then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok || !result.body || !result.body.ok) {
            var message = (result.body && result.body.error) || 'Could not save';
            status.textContent = message;
            save.disabled = !dirty || placedCount() === 0;
            return;
          }
          status.textContent = 'Saved. This centering is assisted.';
          if (options.onSaved) options.onSaved(result.body.item);
        })
        .catch(function () {
          status.textContent = 'Could not save';
          save.disabled = !dirty || placedCount() === 0;
        });
    });

    updateReadout();
    return {
      destroy: function () { parent.innerHTML = ''; }
    };
  }

  root.CenteringAssistUI = {
    mount: mount,
    needsAssist: needsAssist
  };
}(typeof window !== 'undefined' ? window : this));
