// services/wallet_engine.js
// Wallet summary for the dashboard.
//
// There is no market-price source yet, so no item has a value: totals are
// null ("—"), never a formula price. A card counts as graded only when the
// server produced a final grade for a located card.

function isGraded(item) {
  const report = item && item.gradingReport;
  return Boolean(report) &&
    !report.cardNotFound &&
    !report.incomplete &&
    typeof report.finalScore === 'number' && isFinite(report.finalScore);
}

function valueForItem() {
  return null;
}

function portfolioStats(items) {
  items = Array.isArray(items) ? items : [];
  const byCategory = {};
  let gradedCount = 0;
  for (const it of items) {
    const cat = (it && it.category) ? String(it.category).toUpperCase() : 'UNKNOWN';
    if (!Object.prototype.hasOwnProperty.call(byCategory, cat)) byCategory[cat] = { count: 0, value: null };
    byCategory[cat].count += 1;
    if (isGraded(it)) gradedCount += 1;
  }
  return {
    totalValue: null,
    pricedCount: 0,
    gradedCount: gradedCount,
    savedScanCount: items.length,
    byCategory
  };
}

module.exports = { valueForItem, portfolioStats, isGraded };
