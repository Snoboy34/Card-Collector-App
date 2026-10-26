/**
 * One Apple account, one inventory. Sessions live on this machine.
 * The username login is not an account and is not stored here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function createStore(dataDir) {
  const root = dataDir;
  const accountsPath = path.join(root, 'accounts.json');
  const sessionsPath = path.join(root, 'sessions.json');

  function readJson(file, fallback) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(file, value) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  }

  function accounts() {
    const doc = readJson(accountsPath, { accounts: [] });
    if (!Array.isArray(doc.accounts)) doc.accounts = [];
    return doc;
  }

  function sessions() {
    const doc = readJson(sessionsPath, { sessions: [] });
    if (!Array.isArray(doc.sessions)) doc.sessions = [];
    return doc;
  }

  function saveAccounts(doc) { writeJson(accountsPath, doc); }
  function saveSessions(doc) { writeJson(sessionsPath, doc); }

  function findBySub(sub) {
    return accounts().accounts.find(function (row) { return row && row.appleSub === sub; }) || null;
  }

  function upsertAppleAccount(identity, now) {
    const doc = accounts();
    const stamp = now || new Date().toISOString();
    let row = doc.accounts.find(function (item) { return item && item.appleSub === identity.sub; });
    if (!row) {
      row = {
        id: newId(),
        appleSub: identity.sub,
        email: identity.email || null,
        createdAt: stamp
      };
      doc.accounts.push(row);
    } else if (identity.email && row.email !== identity.email) {
      row.email = identity.email;
    }
    saveAccounts(doc);
    return { id: row.id, appleSub: row.appleSub, email: row.email || null, createdAt: row.createdAt };
  }

  function issueSession(accountId, nowMs) {
    const now = nowMs != null ? nowMs : Date.now();
    const token = crypto.randomBytes(32).toString('hex');
    const doc = sessions();
    doc.sessions.push({
      token: token,
      accountId: accountId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_MS).toISOString()
    });
    saveSessions(doc);
    return token;
  }

  function sessionForToken(token, nowMs) {
    if (!token) return null;
    const now = nowMs != null ? nowMs : Date.now();
    const doc = sessions();
    const row = doc.sessions.find(function (item) { return item && item.token === token; });
    if (!row) return null;
    if (Date.parse(row.expiresAt) <= now) return null;
    const account = accounts().accounts.find(function (item) { return item && item.id === row.accountId; });
    if (!account) return null;
    return {
      token: row.token,
      accountId: account.id,
      email: account.email || null
    };
  }

  function bearerFrom(req) {
    const header = req && (req.headers && (req.headers.authorization || req.headers.Authorization));
    if (!header || typeof header !== 'string') return null;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    return match ? match[1] : null;
  }

  function readSession(req, nowMs) {
    return sessionForToken(bearerFrom(req), nowMs);
  }

  function removeAccount(accountId) {
    const accountsDoc = accounts();
    accountsDoc.accounts = accountsDoc.accounts.filter(function (row) { return !row || row.id !== accountId; });
    saveAccounts(accountsDoc);
    const sessionsDoc = sessions();
    sessionsDoc.sessions = sessionsDoc.sessions.filter(function (row) { return !row || row.accountId !== accountId; });
    saveSessions(sessionsDoc);
  }

  return {
    findBySub: findBySub,
    upsertAppleAccount: upsertAppleAccount,
    issueSession: issueSession,
    sessionForToken: sessionForToken,
    readSession: readSession,
    bearerFrom: bearerFrom,
    removeAccount: removeAccount
  };
}

module.exports = { createStore, SESSION_MS };
