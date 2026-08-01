/**
 * services/storage_engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight JSON-file persistence layer (Phase 2).
 *
 * Stores card inventory to data/cards.json so records survive server restarts.
 * Drop-in replacement path for Phase 3: swap the file read/write calls here
 * for database queries without touching server.js or any other module.
 *
 * Guard clauses:
 *   • Missing data directory  → created automatically on first write
 *   • Corrupt / missing file  → getAllCards() returns [] instead of throwing
 *   • Write failure           → propagates the error so the caller can log it
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'cards.json');

// Ensure the data directory exists at module load time
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * getAllCards() → Promise<Array>
 * Reads and parses the cards JSON file.
 * Returns an empty array if the file does not exist or is malformed.
 */
async function getAllCards() {
  try {
    const raw = await fs.promises.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // File not found or JSON parse error — return empty array (not an error)
    if (err.code !== 'ENOENT') {
      console.warn('[storage_engine] getAllCards read error:', err.message);
    }
    return [];
  }
}

/**
 * saveCard(card) → Promise<void>
 * Upserts a card into the JSON file.
 * If a card with the same id already exists it is replaced; otherwise prepended.
 *
 * @param {Object} card  Card object with at least an `id` property
 * @throws {Error}       If the file cannot be written
 */
async function saveCard(card) {
  if (!card || !card.id) throw new Error('saveCard: card must have an id');
  const cards = await getAllCards();
  const idx   = cards.findIndex(c => c.id === card.id);
  if (idx >= 0) {
    cards[idx] = card;            // update in place
  } else {
    cards.unshift(card);          // prepend so newest is first
  }
  await fs.promises.writeFile(DB_PATH, JSON.stringify(cards, null, 2), 'utf8');
}

/**
 * deleteCard(id) → Promise<boolean>
 * Removes a card by id.  Returns true if a card was removed, false if not found.
 *
 * @param {string} id
 */
async function deleteCard(id) {
  if (!id) throw new Error('deleteCard: id is required');
  const cards  = await getAllCards();
  const before = cards.length;
  const after  = cards.filter(c => c.id !== id);
  if (after.length === before) return false;
  await fs.promises.writeFile(DB_PATH, JSON.stringify(after, null, 2), 'utf8');
  return true;
}

module.exports = { getAllCards, saveCard, deleteCard };
