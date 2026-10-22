/**
 * services/frame_profile.js
 *
 * Shared frame matcher. The flatbed measurer calls this, and the phone
 * engine will call the same functions later. A side matches when its bands
 * agree in width and in order from the card edge. The numeric gates are the
 * current answer key.
 */
'use strict';

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort(function (a, b) { return a - b; });
  const m = s.length >> 1;
  if (s.length % 2) return s[m];
  return 0.5 * (s[m - 1] + s[m]);
}

// The reported width is the outer edge at the points closest to the card
// edge. One stray pixel does not count: at least two points have to agree.
function outermostReading(line) {
  const points = line.points || [];
  if (!points.length) return null;
  const minD = Math.min.apply(null, points.map(function (p) { return p.depth; }));
  const tip = points.filter(function (p) { return p.depth <= minD + 0.08; });
  const use = tip.length >= 2
    ? tip
    : points.slice().sort(function (a, b) { return a.depth - b.depth; }).slice(0, Math.min(2, points.length));
  if (use.length < 2) return null;
  return {
    mm: median(use.map(function (p) { return p.depth; })),
    black: median(use.map(function (p) { return p.black; })),
    points: use
  };
}

// Points at one depth are one segment only while they stay in a run. A
// gap of a few millimetres is a design break. A gap across the side is two
// unrelated marks, and the longer run is the line.
function profileRuns(line) {
  const pts = (line.points || []).slice().sort(function (a, b) { return a.alongMm - b.alongMm; });
  if (pts.length < 2) return [];
  const raw = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].alongMm - pts[i - 1].alongMm > 3.2) {
      raw.push(cur);
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  raw.push(cur);
  const merged = [];
  raw.forEach(function (run) {
    const last = merged[merged.length - 1];
    if (last && run[0].alongMm - last[last.length - 1].alongMm <= 12) {
      run.forEach(function (p) { last.push(p); });
    } else {
      merged.push(run.slice());
    }
  });
  const runs = [];
  merged.forEach(function (run) {
    const span = run[run.length - 1].alongMm - run[0].alongMm;
    // Two samples are enough to measure a line that is already qualified.
    // Qualifying takes a run long enough that a wave speck cannot close
    // the rectangle by itself.
    if (run.length < 6 || span < 4) return;
    const depths = run.map(function (p) { return p.depth; });
    runs.push({
      points: run,
      median: median(depths),
      min: Math.min.apply(null, depths),
      max: Math.max.apply(null, depths),
      width: line.width,
      black: median(run.map(function (p) { return p.black; })),
      blackWidth: line.blackWidth,
      innerWidth: line.innerWidth,
      cov: line.points.length ? line.cov * (run.length / line.points.length) : 0,
      span: span,
      profile: true
    });
  });
  return runs;
}

// The same band order on every side, including a segment that does not run
// the whole side: outer band, thicker band inside it, then the inner band.
// A profile that is missing on any side is not the outline.
function matchedProfileSegments(lists, opts) {
  opts = opts || {};
  const requireInner = opts.requireInner !== false;
  const wAbs = opts.wAbs == null ? 0.12 : opts.wAbs;
  const wRangeMax = opts.wRangeMax == null ? 0.16 : opts.wRangeMax;
  const bAbs = opts.bAbs == null ? 0.36 : opts.bAbs;
  const bRangeMax = opts.bRangeMax == null ? 0.52 : opts.bRangeMax;
  const names = ['top', 'bottom', 'left', 'right'];
  const near = {};
  names.forEach(function (name) {
    const list = lists[name] || [];
    if (!list.length) {
      near[name] = [];
      return;
    }
    // A short dark gap in the pattern is not the thicker band. It must not
    // set the floor, or the real stroke about a millimetre deeper is never
    // tried. The thicker band is wider than that gap.
    const solid = list.filter(function (line) {
      return line.blackWidth >= 1.05 && line.width >= 0.24 && line.points.length >= 8;
    });
    let pool = solid.length ? solid : list;
    // An outer-band piece that sits only in the corners is the corner, not
    // the side. It must not set the floor when the same profile already crosses
    // the middle of that side, or the real stroke a millimetre deeper is
    // never tried.
    let spanLo = Infinity;
    let spanHi = -Infinity;
    pool.forEach(function (line) {
      (line.points || []).forEach(function (p) {
        if (p.alongMm < spanLo) spanLo = p.alongMm;
        if (p.alongMm > spanHi) spanHi = p.alongMm;
      });
    });
    const span = spanHi - spanLo;
    if (span > 8) {
      const midLo = spanLo + span * 0.35;
      const midHi = spanLo + span * 0.65;
      function coversMiddle(line) {
        return (line.points || []).some(function (p) {
          return p.alongMm >= midLo && p.alongMm <= midHi;
        });
      }
      function sameStroke(a, b) {
        return Math.abs(a.width - b.width) <= 0.16 &&
          a.blackWidth != null && b.blackWidth != null &&
          Math.abs(a.blackWidth - b.blackWidth) <= 0.45;
      }
      const middle = pool.filter(coversMiddle);
      if (middle.length) {
        const midFloor = middle[0].median;
        pool = pool.filter(function (line) {
          if (coversMiddle(line) || line.median >= midFloor - 0.15) return true;
          // Only a corner piece sitting just outside the same stroke. An
          // interior frame two millimetres deeper is a different line.
          return !middle.some(function (other) {
            return sameStroke(line, other) &&
              other.median > line.median + 0.35 &&
              other.median <= line.median + 1.5;
          });
        });
      }
    }
    const floor = pool[0].median;
    // The outline is the outer stroke. A line several millimetres deeper
    // is an interior frame, not a second try at the same edge.
    near[name] = pool.filter(function (line) { return line.median <= floor + 1.2; });
    if (process.env.TRACE_POOL) {
      process.stdout.write(name + ' span ' + spanLo.toFixed(1) + '-' + spanHi.toFixed(1) +
        ' mid ' + (span > 8 ? (spanLo + span * 0.35).toFixed(1) + '-' + (spanLo + span * 0.65).toFixed(1) : 'na') +
        ' near ' + near[name].map(function (line) {
          const along = (line.points || []).map(function (p) { return p.alongMm; });
          const lo = along.length ? Math.min.apply(null, along) : 0;
          const hi = along.length ? Math.max.apply(null, along) : 0;
          return line.median.toFixed(2) + 'w' + line.width.toFixed(2) + 'b' +
            (line.blackWidth == null ? '-' : line.blackWidth.toFixed(2)) +
            '@' + lo.toFixed(0) + '-' + hi.toFixed(0) + 'n' + line.points.length;
        }).join(' | ') + '\n');
    }
  });
  const idx = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let attempt = 0; attempt < 16; attempt++) {
    const pick = {};
    let ready = true;
    names.forEach(function (name) {
      const list = near[name] || [];
      if (idx[name] >= list.length) ready = false;
      else pick[name] = list[idx[name]];
    });
    if (!ready) return null;
    const widths = names.map(function (name) { return pick[name].width; });
    const blacks = names.map(function (name) { return pick[name].blackWidth; });
    const inners = names.map(function (name) { return pick[name].innerWidth; });
    const wMed = median(widths);
    const bMed = median(blacks);
    const iMed = median(inners);
    const wRange = Math.max.apply(null, widths) - Math.min.apply(null, widths);
    const bRange = Math.max.apply(null, blacks) - Math.min.apply(null, blacks);
    const same = wRange <= wRangeMax && bRange <= bRangeMax && names.every(function (name) {
      const line = pick[name];
      const innerOk = !requireInner || (
        line.innerWidth != null && iMed != null && Math.abs(line.innerWidth - iMed) <= 0.2
      );
      return line.points.length >= 2 &&
        Math.abs(line.width - wMed) <= wAbs &&
        line.blackWidth != null && Math.abs(line.blackWidth - bMed) <= bAbs &&
        innerOk &&
        line.blackWidth > line.width + 0.05;
    });
    if (same) return pick;
    let worst = names[0];
    let worstD = -1;
    names.forEach(function (name) {
      const line = pick[name];
      const d = Math.abs(line.width - wMed) / wAbs +
        Math.abs((line.blackWidth == null ? 0 : line.blackWidth) - bMed) / bAbs;
      if (d > worstD) {
        worstD = d;
        worst = name;
      }
    });
    idx[worst] += 1;
  }
  return null;
}

// The next band's outer edge is the side of that band nearest the card
// edge. The bright stroke just outside it is only the lead-in.
function lineAtBlackEdge(line) {
  const points = (line.points || []).filter(function (p) {
    return p && p.black != null && isFinite(p.black);
  }).map(function (p) {
    return {
      i: p.i,
      depth: p.black,
      x: p.x,
      y: p.y,
      nx: p.nx,
      ny: p.ny,
      alongMm: p.alongMm,
      black: p.black
    };
  });
  if (points.length < 2) return null;
  const readingPoints = (line.readingPoints || []).map(function (p) {
    return {
      i: p.i,
      depth: p.black,
      x: p.x,
      y: p.y,
      nx: p.nx,
      ny: p.ny,
      alongMm: p.alongMm,
      black: p.black
    };
  }).filter(function (p) { return p && p.depth != null && isFinite(p.depth); });
  const depths = points.map(function (p) { return p.depth; });
  return {
    points: points,
    readingPoints: readingPoints.length >= 2 ? readingPoints : null,
    median: median(depths),
    min: Math.min.apply(null, depths),
    max: Math.max.apply(null, depths),
    width: line.width,
    blackWidth: line.blackWidth,
    innerWidth: line.innerWidth,
    cov: line.cov
  };
}

// The same outer band and the band inside it can break along a side and
// come back. Those runs are one line. A deeper frame, or a different
// width, is not.
function joinSameStroke(chosen, siblings) {
  if (!chosen || !siblings || !siblings.length) return chosen;
  const extra = siblings.filter(function (line) {
    if (!line || line === chosen || !line.points || line.points.length < 2) return false;
    if (Math.abs(line.width - chosen.width) > 0.16) return false;
    if (line.blackWidth == null || chosen.blackWidth == null) return false;
    if (Math.abs(line.blackWidth - chosen.blackWidth) > 0.45) return false;
    if (Math.abs(line.median - chosen.median) > 0.45) return false;
    return true;
  });
  if (!extra.length) return chosen;
  const points = chosen.points.slice();
  let cov = chosen.cov || 0;
  extra.forEach(function (line) {
    line.points.forEach(function (p) { points.push(p); });
    cov += line.cov || 0;
  });
  const depths = points.map(function (p) { return p.depth; });
  return {
    points: points,
    // The matched run is the outer edge the four sides agreed on. A speck
    // on the other run does not move that width. The overlay still follows
    // both runs, so the line is not the slope of one end stretched across
    // the side.
    readingPoints: chosen.points,
    median: median(depths),
    min: Math.min.apply(null, depths),
    max: Math.max.apply(null, depths),
    width: chosen.width,
    black: chosen.black,
    blackWidth: chosen.blackWidth,
    innerWidth: chosen.innerWidth,
    cov: Math.min(1, cov),
    profile: true
  };
}
module.exports = {
  outermostReading: outermostReading,
  profileRuns: profileRuns,
  matchedProfileSegments: matchedProfileSegments,
  lineAtBlackEdge: lineAtBlackEdge,
  joinSameStroke: joinSameStroke
};
