/**
 * services/card_outline.js
 *
 * The flatbed outline and the shared frame matcher, called on one phone
 * warp. The functions are the flatbed measurer's. The numeric gates are
 * not retuned. A phone warp's edges are the card cut, so the sampler lives
 * in phone_frame.js and these functions only read the stations it built.
 */
'use strict';

const designOutline = require('./design_outline');
const frameProfile = require('./frame_profile');

const PARTIAL_COVERAGE = 0.32;
const OUTLINE_COVERAGE = 0.20;
const CONTRAST_FLOOR = 12;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort(function (a, b) { return a - b; });
  const m = s.length >> 1;
  if (s.length % 2) return s[m];
  return 0.5 * (s[m - 1] + s[m]);
}

function roundMm(v) {
  if (v == null || !isFinite(v)) return null;
  return Math.round(v * 1000) / 1000;
}

function profileLuma(rgb) {
  if (!rgb) return 0;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

// A thin bright stroke with a darker band just inside it. The wave in a
// refractor is not this: it does not stay one width and it is not followed
// by one dark band. Width stays under 0.5 mm, so a white margin is not a stroke.
function frameMarksFromProfile(profile, stepMm) {
  const n = profile.length;
  if (n < 8) return [];
  const sm = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      acc += profileLuma(profile[j]);
      wsum++;
    }
    sm[i] = wsum ? acc / wsum : 0;
  }
  const marks = [];
  const start = Math.round(0.8 / stepMm);
  const maxWidth = Math.round(0.5 / stepMm);
  const minWidth = Math.max(2, Math.round(0.06 / stepMm));
  // A thin line falls away on both sides within half a millimetre. Try the
  // steeper fall first so a bright wave next to the line does not widen it
  // past 0.5 mm and hide it. A lower line can still use the gentler fall.
  function ridge(i, drop) {
    let lo = i;
    while (lo > 0 && (i - lo) <= maxWidth && sm[i] - sm[lo] < drop) lo--;
    let hi = i;
    while (hi < n - 1 && (hi - i) <= maxWidth && sm[i] - sm[hi] < drop) hi++;
    if (sm[i] - sm[lo] < drop || sm[i] - sm[hi] < drop) return null;
    const widthPx = hi - lo;
    if (widthPx < minWidth || widthPx > maxWidth) return null;
    let dark = 0;
    let darkGap = 0;
    const end = Math.min(n, hi + Math.round(1.6 / stepMm));
    for (let k = hi; k < end; k++) {
      if (sm[k] < 90 && sm[k] <= sm[i] - 60) {
        dark++;
        darkGap = 0;
      } else {
        darkGap++;
        if (dark > 3 && darkGap > 2) break;
      }
    }
    // The black line inside the silver is thicker than the silver. A dark
    // gap in a wave is about as wide as the bright ridge, so it does not count.
    if (dark * stepMm < 0.45) return null;
    // The profile is thin silver, thicker black, thin silver. The inner
    // silver is what separates that frame from a bright ridge in the wave.
    let darkEnd = hi;
    let gap = 0;
    const hunt = Math.min(n - 1, hi + Math.round(2.4 / stepMm));
    for (let k = hi; k <= hunt; k++) {
      if (sm[k] < 90 && sm[k] <= sm[i] - 60) {
        darkEnd = k;
        gap = 0;
      } else {
        gap++;
        if (gap > 2) break;
      }
    }
    let innerOuter = null;
    let innerWidth = null;
    const after = Math.min(n - 2, darkEnd + Math.round(1.4 / stepMm));
    for (let k = darkEnd + 1; k < after; k++) {
      if (!(sm[k] >= sm[k - 1] && sm[k] >= sm[k + 1] && sm[k] >= 130)) continue;
      let lo2 = k;
      while (lo2 > darkEnd && (k - lo2) <= maxWidth && sm[k] - sm[lo2] < 40) lo2--;
      let hi2 = k;
      while (hi2 < n - 1 && (hi2 - k) <= maxWidth && sm[k] - sm[hi2] < 40) hi2++;
      const w2 = hi2 - lo2;
      if (w2 < minWidth || w2 > maxWidth) continue;
      if (sm[k] - sm[lo2] < 40 || sm[k] - sm[hi2] < 40) continue;
      innerOuter = lo2 * stepMm;
      innerWidth = w2 * stepMm;
      break;
    }
    return {
      outer: lo * stepMm,
      width: widthPx * stepMm,
      black: hi * stepMm,
      dark: dark * stepMm,
      blackWidth: Math.max(0, (darkEnd - hi) * stepMm),
      inner: innerOuter,
      innerWidth: innerWidth,
      hi: hi
    };
  }
  for (let i = Math.max(1, start); i < n - 3; i++) {
    if (!(sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] >= 140)) continue;
    const mark = ridge(i, 70) || ridge(i, 40);
    if (!mark) continue;
    const hi = mark.hi;
    delete mark.hi;
    marks.push(mark);
    i = hi;
  }
  return marks.slice(0, 6);
}

// A thin gold line with a black band immediately inside it. Chrome rays are
// bright and neutral, or they are not followed by that black band, so they
// do not count. The outer value is the shallow edge of the gold.
function goldMarksFromProfile(profile, stepMm) {
  const n = profile.length;
  if (n < 8) return [];
  const yel = new Array(n);
  const lum = new Array(n);
  for (let i = 0; i < n; i++) {
    let yacc = 0;
    let lacc = 0;
    let wsum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j < 0 || j >= n || !profile[j]) continue;
      const rgb = profile[j];
      yacc += Math.min(rgb[0], rgb[1]) - rgb[2];
      lacc += profileLuma(rgb);
      wsum++;
    }
    yel[i] = wsum ? yacc / wsum : 0;
    lum[i] = wsum ? lacc / wsum : 0;
  }
  const marks = [];
  const start = Math.round(0.8 / stepMm);
  const maxWidth = Math.round(0.55 / stepMm);
  for (let i = Math.max(1, start); i < n - 3; i++) {
    if (!(yel[i] >= yel[i - 1] && yel[i] >= yel[i + 1] && yel[i] >= 9)) continue;
    if (lum[i] < 26 || lum[i] > 235) continue;
    let lo = i;
    while (lo > 0 && (i - lo) <= maxWidth && yel[i] - yel[lo] < 5) lo--;
    if (yel[i] - yel[lo] < 5) continue;
    let hi = i;
    while (hi < n - 1 && (hi - i) <= maxWidth && lum[hi + 1] >= 42 && yel[i] - yel[hi + 1] < 12) hi++;
    const widthMm = (hi - lo) * stepMm;
    if (widthMm < 0.06 || widthMm > 0.55) continue;
    let dark = 0;
    let gap = 0;
    const lumas = [];
    const hunt = Math.min(n - 1, hi + Math.round(2.0 / stepMm));
    let lastDark = hi;
    for (let k = hi; k <= hunt; k++) {
      if (lum[k] < 45) {
        dark++;
        gap = 0;
        lastDark = k;
        lumas.push(lum[k]);
      } else {
        gap++;
        if (dark > 4 && gap > 2) break;
      }
    }
    const blackWidth = (lastDark - hi) * stepMm;
    if (dark * stepMm < 0.9 || blackWidth < 0.9) continue;
    const blackMed = median(lumas);
    if (blackMed == null || blackMed > 32) continue;
    marks.push({
      outer: lo * stepMm,
      width: widthMm,
      black: hi * stepMm,
      blackWidth: blackWidth
    });
    i = Math.max(hi, lastDark);
  }
  return marks.slice(0, 4);
}

function clusterFrameMarks(stations, opts) {
  opts = opts || {};
  const profileOnly = !!opts.profile;
  const minPoints = opts.minPoints == null ? 6 : opts.minPoints;
  const minSpanFrac = opts.minSpanFrac == null ? 0.48 : opts.minSpanFrac;
  const minCov = opts.minCov == null ? 0.28 : opts.minCov;
  const minSpanMm = opts.minSpanMm == null ? 0 : opts.minSpanMm;
  const n = stations.length;
  const marks = [];
  let sideLen = 0;
  stations.forEach(function (st, i) {
    if (st.alongMm > sideLen) sideLen = st.alongMm;
    (st.frameMarks || []).forEach(function (mk) {
      // The black band is thicker than the silver. A dark gap in the wave is
      // about as wide as the bright ridge, so it stays under 0.7 mm.
      if (profileOnly && (mk.inner == null || !(mk.blackWidth >= 0.7) || !(mk.blackWidth > mk.width + 0.05))) return;
      marks.push({
        i: i,
        depth: mk.outer,
        width: mk.width,
        black: mk.black,
        dark: mk.dark,
        blackWidth: mk.blackWidth,
        inner: mk.inner,
        innerWidth: mk.innerWidth,
        alongMm: st.alongMm,
        x: st.x,
        y: st.y,
        nx: st.nx,
        ny: st.ny
      });
    });
  });
  const items = marks.slice().sort(function (a, b) { return a.depth - b.depth; });
  const groups = [];
  items.forEach(function (item) {
    let g = null;
    for (let gi = 0; gi < groups.length; gi++) {
      if (Math.abs(item.depth - groups[gi].median) <= 0.22 && item.depth <= groups[gi].min + 0.45) {
        g = groups[gi];
        break;
      }
    }
    if (!g) {
      groups.push({ points: [item], median: item.depth, min: item.depth, max: item.depth });
      return;
    }
    g.points.push(item);
    g.min = Math.min(g.min, item.depth);
    g.max = Math.max(g.max, item.depth);
    g.median = median(g.points.map(function (p) { return p.depth; }));
  });
  const usable = [];
  groups.forEach(function (g) {
    if (g.max - g.min > 0.45 || g.points.length < minPoints) return;
    const seen = {};
    const uniq = [];
    g.points.forEach(function (p) {
      if (seen[p.i]) return;
      seen[p.i] = true;
      uniq.push(p);
    });
    if (uniq.length < minPoints) return;
    const along = uniq.map(function (p) { return p.alongMm; });
    const span = Math.max.apply(null, along) - Math.min.apply(null, along);
    const cov = n ? uniq.length / n : 0;
    const width = median(uniq.map(function (p) { return p.width; }));
    if ((minSpanFrac > 0 && span < sideLen * minSpanFrac) || span < minSpanMm) return;
    if (minCov > 0 && cov < minCov) return;
    if (!(width >= 0.06 && width < 0.5)) return;
    const blacks = uniq.map(function (p) { return p.blackWidth; }).filter(function (v) { return v != null; });
    const inners = uniq.map(function (p) { return p.innerWidth; }).filter(function (v) { return v != null; });
    usable.push({
      points: uniq,
      median: median(uniq.map(function (p) { return p.depth; })),
      min: Math.min.apply(null, uniq.map(function (p) { return p.depth; })),
      max: Math.max.apply(null, uniq.map(function (p) { return p.depth; })),
      width: width,
      black: median(uniq.map(function (p) { return p.black; })),
      blackWidth: blacks.length ? median(blacks) : null,
      innerWidth: inners.length ? median(inners) : null,
      cov: cov,
      span: span,
      profile: profileOnly
    });
  });
  usable.sort(function (a, b) { return a.median - b.median; });
  return usable;
}

// Marks shallower than the chosen stroke that still run the side. That is an
// earlier line, so the deeper stroke is not the outline.
function earlierFrameBand(stations, medianMm) {
  let sideLen = 0;
  const marks = [];
  stations.forEach(function (st, i) {
    if (st.alongMm > sideLen) sideLen = st.alongMm;
    (st.frameMarks || []).forEach(function (mk) {
      if (mk.outer <= medianMm - 0.5) marks.push({ depth: mk.outer, along: st.alongMm, i: i });
    });
  });
  if (marks.length < 8 || !sideLen) return null;
  marks.sort(function (a, b) { return a.depth - b.depth; });
  let best = null;
  for (let a = 0; a < marks.length; a++) {
    const win = [];
    for (let b = a; b < marks.length && marks[b].depth <= marks[a].depth + 0.4; b++) win.push(marks[b]);
    const seen = {};
    const uniq = [];
    win.forEach(function (p) {
      if (seen[p.i]) return;
      seen[p.i] = true;
      uniq.push(p);
    });
    if (uniq.length < 6) continue;
    const along = uniq.map(function (p) { return p.along; });
    const span = Math.max.apply(null, along) - Math.min.apply(null, along);
    const cov = uniq.length / stations.length;
    if (cov < 0.2 || span < sideLen * 0.45) continue;
    const med = median(uniq.map(function (p) { return p.depth; }));
    if (!best || med < best.median) best = { median: med, cov: cov };
  }
  return best;
}

// Frame matching lives in services/frame_profile.js. These names stay so
// the measurer publishes the same millimetres.
const outermostReading = frameProfile.outermostReading;
const profileRuns = frameProfile.profileRuns;
const matchedProfileSegments = frameProfile.matchedProfileSegments;
const lineAtBlackEdge = frameProfile.lineAtBlackEdge;
const joinSameStroke = frameProfile.joinSameStroke;


function publishFrameLine(side, line, stations) {
  const reading = outermostReading(
    line.readingPoints && line.readingPoints.length >= 2
      ? { points: line.readingPoints }
      : line
  );
  if (!reading) return false;
  const source = (line.points && line.points.length >= 2) ? line.points : reading.points;
  const pts = source.map(function (p) {
    return {
      i: p.i,
      depth: p.depth,
      x: p.x,
      y: p.y,
      nx: p.nx,
      ny: p.ny,
      alongMm: p.alongMm,
      t: side.lengthMm ? p.alongMm / side.lengthMm : 0,
      strength: 20
    };
  });
  side.frameOuterMm = reading.mm;
  side.blackOuterMm = reading.black;
  side.frameDiffMm = reading.black - reading.mm;
  side.frameWidthMm = line.width;
  side.frameCoverage = line.cov;
  side.frameMatches = true;
  side.mm = reading.mm;
  side.withheld = false;
  side.reason = null;
  side.points = pts;
  side.used = pts;
  side.coverage = line.cov;
  side.shape = 'line';
  side.confidence = Math.round(Math.min(0.86, 0.42 + 0.5 * Math.max(line.cov, 0.2)) * 1000) / 1000;
  side.tiltDeg = designOutline.tiltDegrees(pts);
  side.elements = side.elements || [];
  side.elements.unshift(layerElement(
    { points: pts, median: reading.mm },
    stations.length,
    'outline',
    false,
    null
  ));
  return true;
}

// The shallowest gold-with-black mark in one end of the side. It counts only
// when the same edge continues and deepens toward the middle, which is the
// frame corner sticking out past the angled side. A ray does not.
function goldEndContact(stations, fromStart, lengthMm) {
  const len = lengthMm || 0;
  if (!len || !stations.length) return null;
  const windowMm = Math.min(18, Math.max(12, len * 0.28));
  const marks = [];
  stations.forEach(function (st, i) {
    const mk = st.goldMarks && st.goldMarks[0];
    if (!mk) return;
    marks.push({
      i: i,
      depth: mk.outer,
      black: mk.black,
      width: mk.width,
      blackWidth: mk.blackWidth,
      alongMm: st.alongMm,
      x: st.x,
      y: st.y,
      nx: st.nx,
      ny: st.ny
    });
  });
  if (marks.length < 2) return null;
  const inWindow = marks.filter(function (m) {
    return fromStart ? m.alongMm <= windowMm : m.alongMm >= len - windowMm;
  });
  const kept = inWindow.filter(function (h) {
    return marks.some(function (o) {
      return o !== h && Math.abs(o.alongMm - h.alongMm) <= 2 && Math.abs(o.depth - h.depth) <= 0.8;
    });
  });
  if (!kept.length) return null;
  const minD = Math.min.apply(null, kept.map(function (p) { return p.depth; }));
  const tip = kept.filter(function (p) { return p.depth <= minD + 0.1; });
  const corner = tip.slice().sort(function (a, b) {
    return fromStart ? a.alongMm - b.alongMm : b.alongMm - a.alongMm;
  })[0];
  const towardMid = marks.some(function (m) {
    const past = fromStart ? m.alongMm > corner.alongMm + 1.2 : m.alongMm < corner.alongMm - 1.2;
    const near = Math.abs(m.alongMm - corner.alongMm) <= 14;
    return past && near && m.depth >= corner.depth + 0.3;
  });
  if (!towardMid) return null;
  const use = tip.length >= 2
    ? tip
    : kept.slice().sort(function (a, b) { return a.depth - b.depth; }).slice(0, Math.min(2, kept.length));
  if (!use.length) return null;
  return {
    mm: median(use.map(function (p) { return p.depth; })),
    black: median(use.map(function (p) { return p.black; })),
    width: median(use.map(function (p) { return p.width; })),
    blackWidth: median(use.map(function (p) { return p.blackWidth; })),
    points: use,
    corner: corner
  };
}

function goldCornerOutline(sides) {
  const names = ['top', 'bottom', 'left', 'right'];
  const contacts = {};
  const widths = [];
  for (let n = 0; n < names.length; n++) {
    const name = names[n];
    const side = sides[name];
    const stations = ((side && side.stations) || []).concat((side && side.goldEnds) || []);
    const start = goldEndContact(stations, true, side && side.lengthMm);
    const end = goldEndContact(stations, false, side && side.lengthMm);
    if (!start || !end) return null;
    if (Math.abs(start.corner.alongMm - end.corner.alongMm) < side.lengthMm * 0.35) return null;
    // The two corners of one side are the two ends of the same frame. A
    // reading several millimetres deeper is an interior line, not that corner.
    if (Math.abs(start.mm - end.mm) > 1.5) return null;
    if (start.mm > 8 || end.mm > 8) return null;
    contacts[name] = { start: start, end: end };
    widths.push(start.width, end.width);
  }
  const wRange = Math.max.apply(null, widths) - Math.min.apply(null, widths);
  if (wRange > 0.28) return null;
  if (process.env.TRACE_GOLD) {
    names.forEach(function (name) {
      const c = contacts[name];
      process.stdout.write(name +
        ' start ' + c.start.mm.toFixed(2) + '@' + c.start.corner.alongMm.toFixed(1) +
        ' end ' + c.end.mm.toFixed(2) + '@' + c.end.corner.alongMm.toFixed(1) +
        ' w ' + c.start.width.toFixed(2) + '/' + c.end.width.toFixed(2) + '\n');
    });
  }
  return contacts;
}

function publishGoldSide(side, contact) {
  const raw = contact.start.points.concat(contact.end.points);
  const pts = raw.map(function (p) {
    return {
      i: p.i,
      depth: p.depth,
      black: p.black,
      width: p.width,
      x: p.x,
      y: p.y,
      nx: p.nx,
      ny: p.ny,
      alongMm: p.alongMm,
      t: side.lengthMm ? p.alongMm / side.lengthMm : 0,
      strength: 20
    };
  });
  const reading = outermostReading({ points: pts });
  if (!reading) return false;
  side.cornerContact = true;
  side.cornerDepths = [contact.start.mm, contact.end.mm].map(function (v) {
    return Math.round(v * 1000) / 1000;
  });
  side.frameOuterMm = reading.mm;
  side.blackOuterMm = reading.black;
  side.frameDiffMm = reading.black - reading.mm;
  side.frameWidthMm = median(pts.map(function (p) { return p.width; }));
  side.frameMatches = true;
  side.mm = reading.mm;
  side.withheld = false;
  side.reason = null;
  side.points = pts;
  side.used = pts;
  side.coverage = pts.length / Math.max(1, (side.stations || []).length + (side.goldEnds || []).length);
  side.shape = 'corners';
  side.confidence = 0.62;
  side.tiltDeg = designOutline.tiltDegrees(pts);
  return true;
}

// Patterned colour (a wave, a refractor) is margin. The outline is the outer
// edge of the shared band order when that same profile is on every side,
// even as a segment. A published outline on a plain margin is left alone.
function applyRectangularFrame(sides) {
  const names = ['top', 'bottom', 'left', 'right'];
  const found = {};
  const segments = {};
  const chromaticSide = {};
  names.forEach(function (name) {
    const side = sides[name];
    const stations = side && side.stations ? side.stations : [];
    const clusters = stations.length ? clusterFrameMarks(stations) : [];
    found[name] = clusters[0] || null;
    const rawSegments = stations.length
      ? clusterFrameMarks(stations, { profile: true, minPoints: 2, minSpanFrac: 0, minCov: 0, minSpanMm: 1.2 })
      : [];
    segments[name] = [];
    rawSegments.forEach(function (line) {
      profileRuns(line).forEach(function (run) { segments[name].push(run); });
    });
    segments[name].sort(function (a, b) { return a.median - b.median; });
    chromaticSide[name] = stations.filter(function (st) {
      return (st.marginPattern && !st.marginTextured) || st.marginVaried;
    }).length > stations.length * 0.5;
  });
  const chromaticCount = names.filter(function (name) { return chromaticSide[name]; }).length;
  const allOpen = names.every(function (name) {
    const side = sides[name];
    return !side || side.withheld || side.mm == null;
  });
  if (process.env.TRACE_FRAME) {
    names.forEach(function (name) {
      const list = segments[name] || [];
      process.stdout.write(name + ' chromatic ' + chromaticSide[name] + '\n');
      list.forEach(function (line) {
        if (line.median > 5 || line.points.length < 6) return;
        const along = line.points.map(function (p) { return p.alongMm; }).sort(function (a, b) { return a - b; });
        const runs = [];
        let cur = [along[0]];
        for (let i = 1; i < along.length; i++) {
          if (along[i] - along[i - 1] > 2.4) {
            runs.push(cur);
            cur = [along[i]];
          } else cur.push(along[i]);
        }
        runs.push(cur);
        const brief = runs.filter(function (r) { return r.length >= 2; }).map(function (r) {
          return r.length + '@' + r[0].toFixed(0) + '-' + r[r.length - 1].toFixed(0);
        }).join(',');
        process.stdout.write('  ' + line.median.toFixed(2) + ' w' + line.width.toFixed(2) + ' b' +
          (line.blackWidth == null ? '-' : line.blackWidth.toFixed(2)) + ' runs ' + brief + '\n');
      });
    });
  }
  const profileMatch = matchedProfileSegments(segments);
  if (process.env.TRACE_FRAME) {
    process.stdout.write('match ' + (profileMatch ? names.map(function (name) {
      const line = profileMatch[name];
      return name + ' ' + line.median.toFixed(2) + ' w' + line.width.toFixed(2) + ' b' +
        (line.blackWidth == null ? '-' : line.blackWidth.toFixed(2)) + ' n' + line.points.length;
    }).join(' | ') : 'none') + ' chromatic ' + chromaticCount + ' open ' + allOpen + '\n');
  }
  // One patterned side is enough. A reading in the coloured margin is not
  // an outline outside the frame, so it does not block the matched stroke.
  if (profileMatch && (chromaticCount >= 1 || allOpen)) {
    names.forEach(function (name) {
      const side = sides[name];
      if (!side) return;
      side.marginPatterned = !!chromaticSide[name];
      side.sawProfile = segments[name].length > 0;
      publishFrameLine(side, joinSameStroke(profileMatch[name], segments[name]), side.stations || []);
      delete side.stations;
      delete side.goldEnds;
    });
    return;
  }
  // No shared three-band rectangle. A darker band of the same width on
  // every side is the outline when that is the shared profile. Measure the
  // outer edge of the band, the edge nearest the card edge. A segment is
  // enough. The coloured texture at the cut is not that band.
  if (chromaticCount >= 1 || allOpen) {
    const blackMatch = matchedProfileSegments(segments, {
      requireInner: false,
      wAbs: 0.22,
      wRangeMax: 0.28,
      bAbs: 0.36,
      bRangeMax: 0.52
    });
    if (blackMatch) {
      const blackLines = {};
      let blackReady = true;
      names.forEach(function (name) {
        blackLines[name] = lineAtBlackEdge(joinSameStroke(blackMatch[name], segments[name]));
        if (!blackLines[name]) blackReady = false;
      });
      if (blackReady) {
        names.forEach(function (name) {
          const side = sides[name];
          if (!side) return;
          side.marginPatterned = !!chromaticSide[name];
          side.sawProfile = segments[name].length > 0;
          publishFrameLine(side, blackLines[name], side.stations || []);
          delete side.stations;
          delete side.goldEnds;
        });
        return;
      }
    }
  }
  // No shared three-band rectangle. A gold line with black immediately
  // inside, the same profile at all four outer corners, is the outline when
  // every side is still open. The contact on each side is those two corners.
  // A published outline on any side is left alone.
  if (allOpen) {
    const gold = goldCornerOutline(sides);
    if (gold) {
      let published = true;
      names.forEach(function (name) {
        const side = sides[name];
        if (!side || !publishGoldSide(side, gold[name])) published = false;
      });
      if (published) {
        names.forEach(function (name) {
          const side = sides[name];
          if (!side) return;
          side.marginPatterned = !!chromaticSide[name];
          side.sawProfile = segments[name].length > 0;
          delete side.stations;
          delete side.goldEnds;
        });
        return;
      }
    }
  }
  const widths = [];
  names.forEach(function (name) {
    if (found[name]) widths.push(found[name].width);
  });
  const widthMed = widths.length >= 3 ? median(widths) : null;
  names.forEach(function (name) {
    const side = sides[name];
    if (!side) return;
    const stations = side.stations || [];
    // One dark side of a wave can miss the colour test. The stroke still
    // counts when the other three sides already show the patterned margin.
    const chromatic = chromaticSide[name] || chromaticCount >= 3;
    const line = found[name];
    const matches = !!(line && widthMed != null && Math.abs(line.width - widthMed) <= 0.15);
    if (line) {
      const reading = outermostReading(line);
      side.frameOuterMm = reading ? reading.mm : line.median;
      side.blackOuterMm = reading ? reading.black : line.black;
      side.frameDiffMm = side.blackOuterMm - side.frameOuterMm;
      side.frameWidthMm = line.width;
      side.frameCoverage = line.cov;
      side.frameMatches = matches;
    }
    // A patterned margin has no outline outside this stroke. A plain margin
    // never reaches here, so a border outside an interior line stays.
    // A shallower band that already runs the side is an earlier line. Do not
    // publish a deeper stroke over it.
    const earlier = line ? earlierFrameBand(stations, line.median) : null;
    if (matches && chromatic && line && earlier) {
      side.frameOuterMm = earlier.median;
      side.blackOuterMm = null;
      side.frameDiffMm = null;
      side.frameWidthMm = null;
      side.frameCoverage = earlier.cov;
      side.frameMatches = false;
      side.mm = null;
      side.withheld = true;
      side.reason = 'unclear';
      side.confidence = Math.min(side.confidence || 0, 0.34);
    } else if (chromatic && line && !matches && side.mm != null && !side.withheld) {
      side.mm = null;
      side.withheld = true;
      side.reason = 'unclear';
      side.confidence = Math.min(side.confidence || 0, 0.34);
    } else if (matches && chromatic && line) {
      publishFrameLine(side, line, stations);
    }
    side.marginPatterned = !!chromaticSide[name];
    side.sawProfile = segments[name].length > 0;
    delete side.stations;
    delete side.goldEnds;
  });
}

function strengthAt(st) {
  if (st.designDepth == null) return 0;
  let best = 0;
  let bestD = 1e9;
  (st.candidates || []).forEach(function (c) {
    const dd = Math.abs(c.depth - st.designDepth);
    if (dd < bestD) {
      bestD = dd;
      best = c.strength;
    }
  });
  return bestD <= 0.35 ? best : 0;
}

function clusterDepths(points) {
  const items = points.slice().sort(function (a, b) { return a.depth - b.depth; });
  const layers = [];
  items.forEach(function (item) {
    let best = null;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const dd = Math.abs(item.depth - layer.median);
      if (dd > 0.2) continue;
      const span = Math.max(layer.max, item.depth) - Math.min(layer.min, item.depth);
      if (span > 0.4) continue;
      if (!best || dd < Math.abs(item.depth - best.median)) best = layer;
    }
    if (!best) {
      layers.push({ points: [item], median: item.depth, min: item.depth, max: item.depth });
      return;
    }
    best.points.push(item);
    best.min = Math.min(best.min, item.depth);
    best.max = Math.max(best.max, item.depth);
    best.median = median(best.points.map(function (p) { return p.depth; }));
  });
  layers.sort(function (a, b) { return a.median - b.median; });
  return layers;
}

function denseBody(points) {
  const depths = points.map(function (p) { return p.depth; });
  let mode = median(depths);
  let bestN = -1;
  for (let i = 0; i < depths.length; i++) {
    const d = depths[i];
    let n = 0;
    for (let j = 0; j < depths.length; j++) {
      if (Math.abs(depths[j] - d) <= 0.12) n += 1;
    }
    if (n > bestN || (n === bestN && d < mode)) {
      bestN = n;
      mode = d;
    }
  }
  const body = points.filter(function (p) { return Math.abs(p.depth - mode) <= 0.16; });
  return body.length >= 2 ? body : points.slice();
}

function mergeCloseLayers(layers) {
  const list = layers.map(function (layer) {
    return {
      points: layer.points.slice(),
      median: layer.median,
      min: layer.min,
      max: layer.max
    };
  });
  let changed = true;
  while (changed) {
    changed = false;
    let bestI = -1;
    let bestJ = -1;
    let bestD = 0.32;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.abs(list[i].median - list[j].median);
        const span = Math.max(list[i].max, list[j].max) - Math.min(list[i].min, list[j].min);
        if (d < bestD && span <= 0.55) {
          bestD = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;
    const a = list[bestI];
    const b = list[bestJ];
    const points = a.points.concat(b.points);
    list[bestI] = {
      points: points,
      median: median(points.map(function (p) { return p.depth; })),
      min: Math.min(a.min, b.min),
      max: Math.max(a.max, b.max)
    };
    list.splice(bestJ, 1);
    changed = true;
  }
  list.sort(function (a, b) { return a.median - b.median; });
  return list;
}

function layerRuns(points) {
  const sorted = points.slice().sort(function (a, b) { return a.i - b.i; });
  const runs = [];
  if (!sorted.length) return runs;
  let run = [sorted[0]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].i > run[run.length - 1].i + 2) {
      runs.push(run);
      run = [];
    }
    run.push(sorted[k]);
  }
  runs.push(run);
  return runs.map(function (group) {
    const along = group.map(function (p) { return p.alongMm; });
    return {
      fromMm: roundMm(Math.min.apply(null, along)),
      toMm: roundMm(Math.max.apply(null, along)),
      stations: group.length
    };
  });
}

function layerElement(layer, stationCount, role, refused, why) {
  const along = layer.points.map(function (p) { return p.alongMm; });
  const runs = layerRuns(layer.points);
  return {
    depthMm: roundMm(layer.median),
    fromMm: roundMm(Math.min.apply(null, along)),
    toMm: roundMm(Math.max.apply(null, along)),
    coverage: stationCount ? Math.round((layer.points.length / stationCount) * 1000) / 1000 : null,
    stations: layer.points.length,
    runs: runs.slice(0, 12),
    runCount: runs.length,
    role: role,
    refused: refused,
    why: why
  };
}

function slantFit(points) {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let z0 = 0;
  let z1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = points[i].alongMm;
    const z = points[i].depth;
    s0 += 1;
    s1 += t;
    s2 += t * t;
    z0 += z;
    z1 += z * t;
  }
  const det = s0 * s2 - s1 * s1;
  if (Math.abs(det) < 1e-6) return null;
  const slope = (s0 * z1 - s1 * z0) / det;
  const intercept = (z0 - slope * s1) / s0;
  let err = 0;
  for (let i = 0; i < points.length; i++) {
    const d = points[i].depth - (intercept + slope * points[i].alongMm);
    err += d * d;
  }
  return { slope: slope, intercept: intercept, rms: Math.sqrt(err / points.length) };
}

// A straight border that is not parallel to the card edge spans more than
// the depth window, so the two ends land in two layers. They are one line
// when a single slope fits them. Two different bands do not.
function joinSlantLayers(layers) {
  let changed = true;
  while (changed) {
    changed = false;
    let bestI = -1;
    let bestJ = -1;
    let bestRms = 0.10;
    for (let i = 0; i < layers.length; i++) {
      for (let j = i + 1; j < layers.length; j++) {
        const a = layers[i];
        const b = layers[j];
        if (Math.abs(a.median - b.median) > 0.40) continue;
        const pts = a.points.concat(b.points);
        if (pts.length < 6) continue;
        const fit = slantFit(pts);
        if (process.env.TRACE_SLANT && fit) {
          process.stdout.write('slant ' + a.median.toFixed(3) + '+' + b.median.toFixed(3) +
            ' rms ' + fit.rms.toFixed(3) + ' slope ' + fit.slope.toFixed(4) + '\n');
        }
        if (!fit || fit.rms >= bestRms || Math.abs(fit.slope) > 0.015) continue;
        bestRms = fit.rms;
        bestI = i;
        bestJ = j;
      }
    }
    if (bestI < 0) break;
    const points = layers[bestI].points.concat(layers[bestJ].points);
    const depths = points.map(function (p) { return p.depth; });
    layers[bestI] = {
      points: points,
      median: median(depths),
      min: Math.min.apply(null, depths),
      max: Math.max.apply(null, depths)
    };
    layers.splice(bestJ, 1);
    changed = true;
  }
  layers.sort(function (a, b) { return a.median - b.median; });
}

function summarizeDesign(stations) {
  const empty = {
    mm: null,
    confidence: 0,
    withheld: true,
    reason: 'no-outline',
    points: [],
    used: [],
    shape: null,
    elements: [],
    coverage: 0
  };
  const n = stations.length;
  if (n < 4) return empty;
  const shadow = [];
  const readings = [];
  stations.forEach(function (st, i) {
    if (st.designDepth == null) return;
    const point = {
      i: i,
      depth: st.designDepth,
      strength: strengthAt(st),
      x: st.x,
      y: st.y,
      nx: st.nx,
      ny: st.ny,
      alongMm: st.alongMm,
      t: st.t
    };
    if (st.designDepth < 0.45) shadow.push(point);
    else readings.push(point);
  });
  const layers = mergeCloseLayers(clusterDepths(readings));
  joinSlantLayers(layers);
  layers.forEach(function (layer) {
    layer.cov = layer.points.length / n;
    layer.partial = false;
    layer.why = null;
  });
  layers.forEach(function (layer) {
    let deeper = null;
    for (let li = 0; li < layers.length; li++) {
      const other = layers[li];
      // A short step just outside a boundary that continues along the side
      // is texture in the margin, not a second outline. 0.16 mm still keeps
      // a real nearer element (a frame that only covers part of the side).
      if (other.median <= layer.median + 0.16) continue;
      if (other.cov < 0.28) continue;
      if (!deeper || other.cov > deeper.cov) deeper = other;
    }
    if (!deeper) return;
    if (layer.cov < PARTIAL_COVERAGE && layer.cov < deeper.cov * 0.65) {
      layer.partial = true;
      layer.why = 'covers ' + Math.round(layer.cov * 100) +
        '% of the side and sits outside the outline that continues along the rest';
    }
  });
  const elements = [];
  if (shadow.length >= 3) {
    elements.push(layerElement(
      { points: shadow, median: median(shadow.map(function (p) { return p.depth; })) || 0 },
      n,
      'edge-shadow',
      true,
      'sits in the card-edge transition, not the design block'
    ));
  }
  const eligible = layers.filter(function (layer) { return !layer.partial && layer.points.length >= 2; });
  eligible.sort(function (a, b) { return a.median - b.median; });
  const outline = eligible.length ? eligible[0] : null;
  const isolated = [];
  layers.forEach(function (layer) {
    if (layer === outline) return;
    if (layer.points.length < 2) {
      isolated.push.apply(isolated, layer.points);
      return;
    }
    if (layer.partial) {
      elements.push(layerElement(layer, n, 'partial-margin', true, layer.why));
      return;
    }
    elements.push(layerElement(
      layer, n, 'deeper-element', true,
      'deeper than the outermost points of the design block'
    ));
  });
  if (isolated.length) {
    elements.push(layerElement(
      { points: isolated, median: median(isolated.map(function (p) { return p.depth; })) || 0 },
      n,
      'isolated',
      true,
      'single-station readings, not an outline'
    ));
  }
  if (!outline) {
    return {
      mm: null,
      confidence: 0,
      withheld: true,
      reason: readings.length ? 'partial' : 'no-outline',
      points: readings,
      used: [],
      shape: null,
      elements: elements,
      coverage: readings.length / n
    };
  }
  const extreme = denseBody(outline.points);
  const extDepths = extreme.map(function (p) { return p.depth; });
  const extSpread = Math.max.apply(null, extDepths) - Math.min.apply(null, extDepths);
  const tipMin = Math.min.apply(null, extDepths);
  const tip = extreme.filter(function (p) { return p.depth <= tipMin + 0.08; });
  const useTip = tip.length >= 4 && tip.length >= extreme.length * 0.45;
  const reported = useTip ? median(tip.map(function (p) { return p.depth; })) : median(extDepths);
  const measuredPts = useTip ? tip : extreme;
  const strength = median(measuredPts.map(function (p) { return p.strength; })) || 0;
  const coverage = extreme.length / n;
  const measDepths = measuredPts.map(function (p) { return p.depth; });
  const measSpread = Math.max.apply(null, measDepths) - Math.min.apply(null, measDepths);
  const clear = measuredPts.length >= 2 && measSpread <= 0.36 && coverage >= OUTLINE_COVERAGE && isFinite(reported);
  const covScore = clamp((coverage - 0.15) / 0.6, 0, 1);
  const tightScore = clamp(1 - measSpread / 0.36, 0, 1);
  const strScore = strength > 0 ? clamp((strength - CONTRAST_FLOOR) / 25, 0, 1) : 0.5;
  let conf = (0.48 + 0.52 * covScore) * (0.62 + 0.38 * tightScore) * (0.72 + 0.28 * strScore);
  if (measuredPts.length < 4) conf *= 0.85;
  const withheld = !clear;
  let why = null;
  if (withheld) {
    if (measuredPts.length < 2) why = 'fewer than 2 outermost points';
    else if (measSpread > 0.36) why = 'outermost points disagree by ' + roundMm(measSpread) + ' mm';
    else why = 'the outermost points do not cover enough of the side to be the outline';
  }
  elements.unshift(layerElement({ points: measuredPts, median: reported }, n, 'outline', withheld, why));
  elements.sort(function (a, b) { return a.depthMm - b.depthMm; });
  return {
    mm: withheld ? null : reported,
    confidence: withheld ? Math.min(conf, 0.34) : conf,
    withheld: withheld,
    reason: withheld ? 'unclear' : null,
    points: measuredPts,
    used: measuredPts,
    shape: extSpread <= 0.22 ? 'line' : 'outer',
    elements: elements,
    coverage: coverage,
    rms: extSpread / 2,
    strength: strength
  };
}

module.exports = {
  summarizeDesign: summarizeDesign,
  applyRectangularFrame: applyRectangularFrame,
  frameMarksFromProfile: frameMarksFromProfile,
  goldMarksFromProfile: goldMarksFromProfile
};
