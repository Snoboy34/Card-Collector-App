/**
 * Verify a Sign in with Apple identity token. The iMac uses Apple's public
 * keys. There is no Apple private key on this machine.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');

const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

let cachedKeys = null;
let cachedAt = 0;
let testKeys = null;

function setTestKeys(keys) {
  testKeys = keys && keys.length ? keys : null;
}

function b64urlJson(segment) {
  const text = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(text);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function audienceMatches(aud, expected) {
  if (aud === expected) return true;
  return Array.isArray(aud) && aud.indexOf(expected) >= 0;
}

function fetchAppleKeys() {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < 60 * 60 * 1000) return Promise.resolve(cachedKeys);
  return new Promise(function (resolve, reject) {
    const req = https.get(APPLE_KEYS_URL, { timeout: 5000 }, function (res) {
      let body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        try {
          const parsed = JSON.parse(body);
          const keys = parsed && parsed.keys;
          if (!Array.isArray(keys) || !keys.length) {
            reject(new Error('apple keys missing'));
            return;
          }
          cachedKeys = keys;
          cachedAt = Date.now();
          resolve(keys);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('apple keys timed out'));
    });
  });
}

function keysForRequest() {
  if (process.env.JUDGE_APPLE_TEST_JWKS === '1') {
    if (!testKeys) return Promise.reject(new Error('test keys not set'));
    return Promise.resolve(testKeys);
  }
  return fetchAppleKeys();
}

/**
 * @returns {Promise<{sub: string, email: string|null}>}
 */
function verifyIdentityToken(token, options) {
  const opts = options || {};
  return keysForRequest().then(function (keys) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const header = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    if (!header || header.alg !== 'RS256' || !header.kid) throw new Error('unsupported token');
    const jwk = keys.find(function (key) { return key && key.kid === header.kid; });
    if (!jwk) throw new Error('unknown key');
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signed = Buffer.from(parts[0] + '.' + parts[1]);
    const signature = Buffer.from(parts[2], 'base64url');
    const ok = crypto.verify('RSA-SHA256', signed, publicKey, signature);
    if (!ok) throw new Error('bad signature');
    if (payload.iss !== APPLE_ISSUER) throw new Error('bad issuer');
    if (!audienceMatches(payload.aud, opts.audience)) throw new Error('bad audience');
    const now = opts.now != null ? opts.now : Date.now();
    if (!(payload.exp * 1000 > now)) throw new Error('expired token');
    if (!payload.sub || typeof payload.sub !== 'string') throw new Error('missing subject');
    if (opts.nonce != null) {
      if (payload.nonce !== sha256Hex(opts.nonce)) throw new Error('bad nonce');
    }
    const email = typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim() : null;
    return { sub: payload.sub, email: email };
  });
}

function signTestToken(payload, privateKey, kid) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = header + '.' + body;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  return data + '.' + signature;
}

module.exports = {
  verifyIdentityToken,
  setTestKeys,
  sha256Hex,
  signTestToken,
  APPLE_ISSUER
};
