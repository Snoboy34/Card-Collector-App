// services/classifier_engine.js
// Phase 4: Simple card classification engine.
// Exports: async function classifyBuffer(buffer, options = {}) -> returns one of: 'SPORTS' | 'TCG' | 'UNKNOWN'

let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  // optional dependency - classifier will still try to use filename heuristics if sharp isn't available
  // eslint-disable-next-line no-console
  console.warn('services/classifier_engine: optional dependency `sharp` not available — falling back to filename heuristics.');
}

// Small helpers
function clamp(v, a = 0, b = 1) { return Math.max(a, Math.min(b, v)); }

function mean(arr) { if (!arr || !arr.length) return 0; return arr.reduce((s, x) => s + x, 0) / arr.length; }

function isLikelySportsByName(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  const sportsKeywords = ['baseball','basketball','football','nba','mlb','nfl','hockey','soccer','player','rookie'];
  return sportsKeywords.some(k => n.includes(k));
}

function isLikelyTCGByName(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  const tcgKeywords = ['pokemon','pokémon','mtg','magic','yugioh','trading card','tcg','cardfight','digimon'];
  return tcgKeywords.some(k => n.includes(k));
}

async function classifyBuffer(buffer, options = {}) {
  options = Object.assign({ filename: '' }, options);
  // If filename hints strongly, use that as quick path
  const fname = options.filename || '';
  if (isLikelyTCGByName(fname)) return 'TCG';
  if (isLikelySportsByName(fname)) return 'SPORTS';

  // If sharp is available, use a small resized raw sample to compute simple color heuristics
  if (sharp) {
    try {
      // Resize to small box to speed up processing
      const thumb = await sharp(buffer, { failOnError: false }).resize(64, 64, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
      const { data, info } = thumb;
      const channels = info.channels || 3;
      const pixels = data;
      const total = info.width * info.height;
      // compute per-channel means and a simple colorfulness measure
      let rSum = 0, gSum = 0, bSum = 0;
      let rgDiffSum = 0, ybDiffSum = 0;
      for (let i = 0; i < total; i++) {
        const idx = i * channels;
        const r = pixels[idx] || 0;
        const g = pixels[idx + 1] || 0;
        const b = pixels[idx + 2] || 0;
        rSum += r; gSum += g; bSum += b;
        rgDiffSum += Math.abs(r - g);
        ybDiffSum += Math.abs((r + g) / 2 - b);
      }
      const rMean = rSum / total;
      const gMean = gSum / total;
      const bMean = bSum / total;
      const colorfulness = (rgDiffSum + ybDiffSum) / (total * 255);

      // Heuristics:
      // - TCG images are often more colorful / saturated (higher colorfulness)
      // - Sports photos often contain human skin tones. We'll detect a simple skin-tone presence by
      //   checking if many pixels have R > G > B with R in a plausible skin range.
      let skinCount = 0;
      for (let i = 0; i < total; i++) {
        const idx = i * channels;
        const r = pixels[idx] || 0;
        const g = pixels[idx + 1] || 0;
        const b = pixels[idx + 2] || 0;
        if (r > 90 && r < 255 && g > 40 && g < 200 && b > 20 && b < 180 && r > g && g > b) skinCount++;
      }
      const skinRatio = skinCount / total;

      // Decision rules (tunable):
      // - If skinRatio > 0.04 (4% of pixels) -> SPORTS
      // - Else if colorfulness > 0.08 -> TCG
      // - Fallback: decide by relative mean brightness/color channels
      if (skinRatio > 0.04) return 'SPORTS';
      if (colorfulness > 0.08) return 'TCG';

      // Fallback rule: if green channel strongly dominates -> SPORTS (outdoor photos), else TCG
      if (gMean > rMean + 8 && gMean > bMean + 8) return 'SPORTS';
      return 'TCG';
    } catch (e) {
      // If something fails, fall back to filename heuristics or unknown
      // eslint-disable-next-line no-console
      console.warn('classifier_engine: sharp-based classification failed:', e && e.message);
      if (isLikelyTCGByName(fname)) return 'TCG';
      if (isLikelySportsByName(fname)) return 'SPORTS';
      return 'UNKNOWN';
    }
  }

  // If no sharp, rely on filename heuristics or return UNKNOWN
  if (isLikelyTCGByName(fname)) return 'TCG';
  if (isLikelySportsByName(fname)) return 'SPORTS';
  return 'UNKNOWN';
}

module.exports = { classifyBuffer };
