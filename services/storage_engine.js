const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dbDir, 'database.json');

async function ensureDB() {
  try {
    await fs.promises.access(dbPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    // Create directory and file with empty array
    await fs.promises.mkdir(dbDir, { recursive: true });
    await fs.promises.writeFile(dbPath, '[]', 'utf8');
  }
}

async function readDB() {
  await ensureDB();
  const raw = await fs.promises.readFile(dbPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Recover by overwriting with an empty array
    await fs.promises.writeFile(dbPath, '[]', 'utf8');
    return [];
  }
}

async function writeDB(data) {
  await ensureDB();
  await fs.promises.writeFile(dbPath, JSON.stringify(data, null, 2), 'utf8');
}

async function getAllCards() {
  return await readDB();
}

async function saveCard(item) {
  const cards = await readDB();
  // Prepend so newest appear first
  cards.unshift(item);
  await writeDB(cards);
  return item;
}

module.exports = {
  getAllCards,
  saveCard
};
