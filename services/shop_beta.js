/**
 * iMac-side shop beta. Flags default off. A signed-in account sees only
 * its own scans. Scans with no account stay on the bench and are not
 * visible to an account. Correction examples are removed with the scan
 * and still never leave this machine.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const betaFlags = require('./beta_flags');
const accounts = require('./accounts');
const apple = require('./apple_identity');
const cardEntry = require('./card_entry');
const captureTier = require('./capture_tier');
const guide = require('./first_run_guide');

function create(options) {
  const dataDir = options.dataDir;
  const uploadsDir = options.uploadsDir;
  const scansDir = options.scansDir;
  const loadDatabase = options.loadDatabase;
  const saveDatabase = options.saveDatabase;
  const store = accounts.createStore(dataDir);

  function flags() {
    return betaFlags.readFlags(dataDir, process.env);
  }

  function readSession(req) {
    if (!flags().accounts) return null;
    return store.readSession(req);
  }

  /**
   * No Authorization header is the bench. A bearer token that does not
   * match a live session is rejected, so a stale login cannot see the bench.
   */
  function sessionOrReject(req) {
    if (!flags().accounts) return { session: null };
    const token = store.bearerFrom(req);
    if (!token) return { session: null };
    const session = store.sessionForToken(token);
    if (!session) return { error: 'sign in required', status: 401 };
    return { session: session };
  }

  /**
   * A bearer token is checked only while accounts are on.
   * No token means the bench. A bad token is rejected.
   */
  function authorizeGrade(req) {
    if (!flags().accounts) return { accountId: null };
    const token = store.bearerFrom(req);
    if (!token) return { accountId: null };
    const session = store.sessionForToken(token);
    if (!session) return { error: 'sign in required', status: 401 };
    return { accountId: session.accountId, session: session };
  }

  function canRead(item, session) {
    if (!flags().accounts) return true;
    if (!item) return false;
    if (session) return item.accountId === session.accountId;
    return !item.accountId;
  }

  function filterItems(items, session) {
    const list = Array.isArray(items) ? items : [];
    if (!flags().accounts) return list;
    return list.filter(function (item) { return canRead(item, session); });
  }

  function inside(root, name) {
    if (!root || !name) return null;
    const base = path.resolve(root);
    const target = path.resolve(base, name);
    if (target !== base && target.indexOf(base + path.sep) !== 0) return null;
    return target;
  }

  function removeUpload(item) {
    const imagePath = item && item.imagePath;
    if (!imagePath || typeof imagePath !== 'string') return;
    const base = path.basename(imagePath);
    const file = inside(uploadsDir, base);
    if (!file || file === path.resolve(uploadsDir)) return;
    fs.rmSync(file, { force: true });
  }

  function removeScanDir(scanId) {
    if (!scanId) return;
    const dir = inside(scansDir, String(scanId));
    if (!dir || dir === path.resolve(scansDir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function examplesPath() {
    return path.join(dataDir, 'centering_examples.jsonl');
  }

  function readExampleRows() {
    const file = examplesPath();
    if (!fs.existsSync(file)) return [];
    const rows = [];
    fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { rows.push(JSON.parse(trimmed)); } catch (e) { rows.push({ __raw: trimmed }); }
    });
    return rows;
  }

  function writeExampleRows(rows) {
    const file = examplesPath();
    if (!rows.length) {
      if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
      return;
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const text = rows.map(function (row) { return JSON.stringify(row); }).join('\n') + '\n';
    fs.writeFileSync(file, text, 'utf8');
  }

  function removeExamples(scanIds) {
    const wanted = {};
    scanIds.forEach(function (id) { if (id) wanted[id] = true; });
    const rows = readExampleRows();
    let removed = 0;
    const kept = rows.filter(function (row) {
      const id = row && (row.scanId || row.id);
      if (wanted[id]) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (removed) writeExampleRows(kept.filter(function (row) { return !row.__raw; }));
    return removed;
  }

  function removeFailedLines(scanIds, accountId) {
    const file = path.join(dataDir, 'failed_scans.jsonl');
    if (!fs.existsSync(file)) return 0;
    const wanted = {};
    scanIds.forEach(function (id) { if (id) wanted[id] = true; });
    const kept = [];
    let removed = 0;
    fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const row = JSON.parse(trimmed);
        const id = row && row.scanId;
        const owns = accountId ? row.accountId === accountId : true;
        if (id && wanted[id] && owns) {
          removed += 1;
          return;
        }
      } catch (e) { /* keep a torn line */ }
      kept.push(trimmed);
    });
    if (removed) {
      fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    }
    return removed;
  }

  function eraseItems(items, accountId) {
    const ids = [];
    items.forEach(function (item) {
      if (!item || !item.scanId) return;
      ids.push(item.scanId);
      removeUpload(item);
      removeScanDir(item.scanId);
    });
    const examples = removeExamples(ids);
    removeFailedLines(ids, accountId || null);
    return { scanIds: ids, deletedExamples: examples };
  }

  function deleteAccount(accountId) {
    const db = loadDatabase();
    const inventory = db.inventory || [];
    const doomed = inventory.filter(function (item) { return item && item.accountId === accountId; });
    const kept = inventory.filter(function (item) { return !item || item.accountId !== accountId; });
    db.inventory = kept;
    saveDatabase(db);
    const erased = eraseItems(doomed, accountId);
    store.removeAccount(accountId);
    return {
      ok: true,
      deletedScans: erased.scanIds.length,
      deletedExamples: erased.deletedExamples,
      scanIds: erased.scanIds
    };
  }

  function deleteScan(item) {
    const db = loadDatabase();
    db.inventory = (db.inventory || []).filter(function (row) {
      return !row || row.scanId !== item.scanId;
    });
    saveDatabase(db);
    const erased = eraseItems([item], item.accountId || null);
    return {
      ok: true,
      deletedScans: erased.scanIds.length,
      deletedExamples: erased.deletedExamples,
      scanIds: erased.scanIds
    };
  }

  function rejectSignIn(message, status) {
    const error = new Error(message);
    error.status = status;
    return Promise.reject(error);
  }

  function signIn(identityToken, nonce) {
    const current = flags();
    if (!current.accounts) return rejectSignIn('accounts are off', 403);
    if (!nonce) return rejectSignIn('nonce required', 400);
    return apple.verifyIdentityToken(identityToken, {
      audience: current.appleAudience,
      nonce: nonce
    }).then(function (identity) {
      const account = store.upsertAppleAccount(identity);
      const token = store.issueSession(account.id);
      return {
        ok: true,
        token: token,
        accountId: account.id,
        email: account.email
      };
    });
  }

  return {
    flags: flags,
    readSession: readSession,
    sessionOrReject: sessionOrReject,
    authorizeGrade: authorizeGrade,
    canRead: canRead,
    filterItems: filterItems,
    attachTier: captureTier.attachTier,
    applyCardEntry: cardEntry.applyCardEntry,
    guideText: guide.guideText,
    tierForPxPerMm: captureTier.tierForPxPerMm,
    signIn: signIn,
    deleteAccount: deleteAccount,
    deleteScan: deleteScan,
    store: store
  };
}

module.exports = { create };
