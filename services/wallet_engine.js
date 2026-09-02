// services/wallet_engine.js
// Phase 5: Wallet Financial Engine
// Exports functions to estimate real-world cash value for an inventory item and to summarize a portfolio.

function labelMultiplier(label) {
  if (!label) return 0.7;
  const l = String(label).toLowerCase();
  if (l.includes('gem')) return 1.6;
  if (l.includes('mint')) return 1.3;
  if (l.includes('near mint')) return 1.15;
  if (l.includes('excellent')) return 1.0;
  if (l.includes('good')) return 0.8;
  return 0.75; // unknown/default
}

function basePriceForCategory(category) {
  switch ((category || 'UNKNOWN').toUpperCase()) {
    case 'SPORTS':
      return 120.0; // base USD for sports cards (adjustable)
    case 'TCG':
      return 40.0; // base USD for TCG cards (adjustable)
    default:
      return 10.0; // unknown/other
  }
}

function valueForItem(item) {
  // Defensive getters
  const category = (item && item.category) ? String(item.category).toUpperCase() : 'UNKNOWN';
  const report = item && item.gradingReport ? item.gradingReport : {};
  const weighted = typeof report.weighted === 'number' ? report.weighted : (typeof report.weighted === 'string' ? Number(report.weighted) : 0);
  const centering = typeof report.centering === 'number' ? report.centering : (typeof report.centering === 'string' ? Number(report.centering) : 50);
  const label = report.label || '';

  const base = basePriceForCategory(category);

  // Score factor: maps weighted (0..100) to multiplier roughly in 0.5..1.5
  const scoreFactor = 0.5 + Math.max(0, Math.min(100, weighted)) / 100.0; // 0.5 .. 1.5

  // Centering factor: slight boost for well-centered cards (range ~0.9..1.1)
  const centeringFactor = 1 + ((Math.max(0, Math.min(100, centering)) - 50) / 500); // -0.1 .. +0.1

  // Label multiplier (gem/mint premiums)
  const labelMul = labelMultiplier(label);

  let value = base * scoreFactor * centeringFactor * labelMul;

  // If item explicitly marked as Unknown or ungraded, apply a deeper discount
  if (!report || typeof report.weighted !== 'number' && !report.weighted) {
    value = value * 0.5;
  }

  // Round to cents
  return Math.round(value * 100) / 100;
}

function portfolioStats(items) {
  items = Array.isArray(items) ? items : [];
  const byCategory = {};
  let total = 0;
  for (const it of items) {
    const cat = (it && it.category) ? String(it.category).toUpperCase() : 'UNKNOWN';
    const v = valueForItem(it);
    if (!Object.prototype.hasOwnProperty.call(byCategory, cat)) byCategory[cat] = { count: 0, value: 0 };
    byCategory[cat].count += 1;
    byCategory[cat].value = Math.round((byCategory[cat].value + v) * 100) / 100;
    total += v;
  }
  total = Math.round(total * 100) / 100;
  return { totalValue: total, byCategory };
}

module.exports = { valueForItem, portfolioStats };
