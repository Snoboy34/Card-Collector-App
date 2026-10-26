/**
 * The shop types the card. These fields do not change the grade, the
 * family id, or the capture clock.
 */
'use strict';

const LIMITS = {
  name: 120,
  year: 16,
  set: 120,
  number: 32,
  game: 64,
  notes: 500
};

function clip(value, max) {
  if (value == null) return '';
  const text = String(value).replace(/[\u0000-\u001F]/g, ' ').trim();
  return text.slice(0, max);
}

function readEntry(body) {
  const source = body && typeof body === 'object' ? body : {};
  return {
    name: clip(source.name, LIMITS.name),
    year: clip(source.year, LIMITS.year),
    set: clip(source.set, LIMITS.set),
    number: clip(source.number, LIMITS.number),
    game: clip(source.game, LIMITS.game),
    notes: clip(source.notes, LIMITS.notes)
  };
}

/**
 * Store the typed fields. Display name stays Unidentified until a name is
 * typed. familyId stays null. The grading report is not touched.
 * @returns {object} the same item
 */
function applyCardEntry(item, body, now) {
  if (!item || typeof item !== 'object') return item;
  const entry = readEntry(body);
  entry.updatedAt = now || new Date().toISOString();
  item.cardEntry = entry;
  item.name = entry.name || 'Unidentified';
  item.setName = entry.set || '—';
  if (!item.cardIdentity || typeof item.cardIdentity !== 'object') item.cardIdentity = {};
  item.cardIdentity.familyId = null;
  item.cardIdentity.match = null;
  return item;
}

module.exports = { applyCardEntry, readEntry, LIMITS };
