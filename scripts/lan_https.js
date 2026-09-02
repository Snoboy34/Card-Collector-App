/**
 * scripts/lan_https.js
 * =============================================================================
 * LAN HTTPS helpers for `npm run start:lan`.
 * =============================================================================
 *
 * Phone browsers (Safari especially) refuse getUserMedia on plain HTTP.
 * This module:
 *   1. Resolves the Mac's current LAN IPv4 via `ipconfig getifaddr en0`
 *      (never a hardcoded address — en0 changes across networks).
 *   2. Mints a self-signed certificate whose SAN covers that IP, localhost,
 *      and 127.0.0.1 so a phone can load https://<lan-ip>:PORT.
 *
 * Certs land in ./certs (gitignored) and are regenerated when the LAN IP
 * changes so a stale 192.168.x.x from a previous Wi-Fi is never reused.
 *
 * @module scripts/lan_https
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const KEY_PATH = path.join(CERT_DIR, 'lan-key.pem');
const CERT_PATH = path.join(CERT_DIR, 'lan-cert.pem');
const META_PATH = path.join(CERT_DIR, 'lan-meta.json');
const OPENSSL_CNF_PATH = path.join(CERT_DIR, 'lan-openssl.cnf');

function isIPv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every(function (p) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * Primary lookup: macOS Wi-Fi / primary interface.
 * `ipconfig getifaddr en0` is the supported way to read the Mac's current
 * LAN address. Do not substitute a remembered IP.
 *
 * @returns {{ ip: string, source: string }|null}
 */
function getLanIPv4FromEn0() {
  try {
    const ip = execFileSync('ipconfig', ['getifaddr', 'en0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (isIPv4(ip)) {
      return { ip: ip, source: 'ipconfig getifaddr en0' };
    }
  } catch (e) {
    // Not macOS, en0 down, or no IPv4 on Wi-Fi.
  }
  return null;
}

/**
 * Fallback when en0 has no address (Ethernet-only Mac, Linux, etc.).
 * Prefers RFC1918 IPv4 so we still bind a useful phone URL.
 *
 * @returns {{ ip: string, source: string }}
 */
function getLanIPv4Fallback() {
  const nets = os.networkInterfaces();
  const candidates = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      const family = net.family;
      const isV4 = family === 'IPv4' || family === 4;
      if (!isV4 || net.internal) return;
      candidates.push({ ip: net.address, source: 'os.networkInterfaces() ' + name });
    });
  });
  const rfc1918 = candidates.find(function (c) {
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(c.ip);
  });
  return rfc1918 || candidates[0] || { ip: '127.0.0.1', source: 'loopback fallback' };
}

/**
 * @returns {{ ip: string, source: string, usedEn0: boolean }}
 */
function getLanIPv4() {
  const fromEn0 = getLanIPv4FromEn0();
  if (fromEn0) {
    return { ip: fromEn0.ip, source: fromEn0.source, usedEn0: true };
  }
  const fallback = getLanIPv4Fallback();
  return { ip: fallback.ip, source: fallback.source, usedEn0: false };
}

function opensslCnfForIp(lanIp) {
  return [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    'prompt = no',
    '',
    '[dn]',
    'CN = The Judge LAN (' + lanIp + ')',
    'O = The Judge',
    'OU = Local development',
    '',
    '[v3_req]',
    'basicConstraints = critical, CA:true',
    'keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = DNS:localhost,IP:127.0.0.1,IP:' + lanIp
  ].join('\n') + '\n';
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Create (or reuse) a self-signed cert whose SAN includes `lanIp`.
 * Regenerates when the stored IP no longer matches so a previous network's
 * address cannot linger in the certificate.
 *
 * @param {string} lanIp
 * @returns {{ key: Buffer, cert: Buffer, keyPath: string, certPath: string, reused: boolean }}
 */
function ensureLanCertificate(lanIp) {
  if (!isIPv4(lanIp)) {
    throw new Error('ensureLanCertificate: invalid IPv4 ' + lanIp);
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });

  const meta = readMeta();
  const canReuse = Boolean(
    meta &&
    meta.ip === lanIp &&
    fs.existsSync(KEY_PATH) &&
    fs.existsSync(CERT_PATH)
  );
  if (canReuse) {
    return {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
      keyPath: KEY_PATH,
      certPath: CERT_PATH,
      reused: true
    };
  }

  fs.writeFileSync(OPENSSL_CNF_PATH, opensslCnfForIp(lanIp), 'utf8');

  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-sha256',
    '-days', '825',
    '-nodes',
    '-keyout', KEY_PATH,
    '-out', CERT_PATH,
    '-config', OPENSSL_CNF_PATH,
    '-extensions', 'v3_req'
  ], { stdio: 'pipe' });

  fs.writeFileSync(META_PATH, JSON.stringify({
    ip: lanIp,
    createdAt: new Date().toISOString()
  }, null, 2), 'utf8');

  return {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
    keyPath: KEY_PATH,
    certPath: CERT_PATH,
    reused: false
  };
}

module.exports = {
  CERT_DIR,
  KEY_PATH,
  CERT_PATH,
  getLanIPv4,
  getLanIPv4FromEn0,
  ensureLanCertificate,
  isIPv4
};
