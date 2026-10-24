#!/usr/bin/env node
/**
 * scripts/fetch_flatbed.js
 *
 * List and download flatbed scans from Cloudflare R2 (S3-compatible API)
 * into the folder measure_flatbed.js reads. A file already on disk with
 * the same byte size is left in place.
 *
 * Credentials are read only from the environment. Nothing in this file
 * is a key, a secret, or an account id.
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_ENDPOINT
 *   R2_BUCKET
 *
 * Run: node scripts/fetch_flatbed.js [--dest DIR] [--prefix flatbed/] [--self-test]
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const { defaultFlatbedDir } = require('./measure_flatbed');

const REGION = 'auto';
const SERVICE = 's3';
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (ch) {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
  });
}

function encodePath(segments) {
  return '/' + segments.map(function (part) { return awsEncode(part); }).join('/');
}

function canonicalQuery(params) {
  const names = Object.keys(params).filter(function (name) {
    return params[name] != null && params[name] !== '';
  }).sort();
  return names.map(function (name) {
    return awsEncode(name) + '=' + awsEncode(params[name]);
  }).join('&');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Header-based SigV4. `now` is a Date so the known-answer test can pin it.
 * Returns the headers to send, including Authorization.
 */
function signHeaders(opts) {
  const method = opts.method || 'GET';
  const amzDate = opts.amzDate;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = opts.payloadHash || EMPTY_HASH;
  const signed = {
    host: opts.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  Object.keys(opts.extraHeaders || {}).forEach(function (name) {
    signed[name.toLowerCase()] = opts.extraHeaders[name];
  });
  const headerNames = Object.keys(signed).sort();
  const canonicalHeaders = headerNames.map(function (name) {
    return name + ':' + String(signed[name]).trim().replace(/\s+/g, ' ') + '\n';
  }).join('');
  const signedHeaders = headerNames.join(';');
  const canonical = [
    method,
    opts.canonicalUri,
    opts.canonicalQuery || '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  const scope = dateStamp + '/' + opts.region + '/' + opts.service + '/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonical)
  ].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(opts.secret, dateStamp, opts.region, opts.service))
    .update(stringToSign, 'utf8')
    .digest('hex');
  const headers = {};
  headerNames.forEach(function (name) { headers[name] = signed[name]; });
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + opts.accessKey + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return { headers: headers, signature: signature, canonical: canonical, stringToSign: stringToSign };
}

function amzNow(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error('missing environment variable ' + name);
    err.code = 'MISSING_ENV';
    throw err;
  }
  return value;
}

function r2Config() {
  const endpoint = requireEnv('R2_ENDPOINT').replace(/\/+$/, '');
  const bucket = requireEnv('R2_BUCKET');
  const accessKey = requireEnv('R2_ACCESS_KEY_ID');
  const secret = requireEnv('R2_SECRET_ACCESS_KEY');
  const host = new URL(endpoint).host;
  return { endpoint: endpoint, bucket: bucket, accessKey: accessKey, secret: secret, host: host };
}

function requestBuffer(cfg, method, canonicalUri, query, destStream) {
  const queryString = canonicalQuery(query || {});
  const signed = signHeaders({
    method: method,
    host: cfg.host,
    canonicalUri: canonicalUri,
    canonicalQuery: queryString,
    amzDate: amzNow(new Date()),
    accessKey: cfg.accessKey,
    secret: cfg.secret,
    region: REGION,
    service: SERVICE
  });
  const url = cfg.endpoint + canonicalUri + (queryString ? '?' + queryString : '');
  return new Promise(function (resolve, reject) {
    const req = https.request(url, { method: method, headers: signed.headers }, function (res) {
      if (destStream) {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            reject(httpError(res.statusCode, Buffer.concat(chunks).toString('utf8')));
          });
          return;
        }
        res.pipe(destStream);
        destStream.on('finish', function () { resolve({ statusCode: res.statusCode }); });
        destStream.on('error', reject);
        res.on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const body = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          reject(httpError(res.statusCode, body.toString('utf8')));
          return;
        }
        resolve({ statusCode: res.statusCode, body: body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpError(status, body) {
  const code = /<Code>([^<]*)<\/Code>/.exec(body);
  const message = /<Message>([^<]*)<\/Message>/.exec(body);
  const err = new Error('R2 ' + status + (code ? ' ' + code[1] : '') + (message ? ': ' + message[1] : ''));
  err.statusCode = status;
  return err;
}

function decodeXml(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseList(xml) {
  const objects = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    const key = /<Key>([^<]*)<\/Key>/.exec(block);
    const size = /<Size>([^<]*)<\/Size>/.exec(block);
    if (!key) continue;
    objects.push({
      key: decodeXml(key[1]),
      size: size ? Number(size[1]) : 0
    });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
  return {
    objects: objects,
    truncated: truncated,
    token: token ? decodeXml(token[1]) : null
  };
}

async function listPrefix(cfg, prefix) {
  const objects = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix: prefix };
    if (token) query['continuation-token'] = token;
    const uri = encodePath([cfg.bucket]);
    const res = await requestBuffer(cfg, 'GET', uri, query, null);
    const page = parseList(res.body.toString('utf8'));
    objects.push.apply(objects, page.objects);
    token = page.truncated ? page.token : null;
  } while (token);
  objects.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  return objects;
}

function localPathFor(destDir, key, prefix) {
  let rel = key;
  if (prefix && rel.indexOf(prefix) === 0) rel = rel.slice(prefix.length);
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some(function (part) { return part === '..' || part === '.'; })) return null;
  return path.join(destDir, ...parts);
}

function sameSize(file, size) {
  if (!fs.existsSync(file)) return false;
  return fs.statSync(file).size === size;
}

async function downloadObject(cfg, key, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = dest + '.partial';
  const uri = encodePath([cfg.bucket].concat(key.split('/').filter(Boolean)));
  const stream = fs.createWriteStream(partial);
  try {
    await requestBuffer(cfg, 'GET', uri, null, stream);
  } catch (err) {
    stream.destroy();
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    throw err;
  }
  fs.renameSync(partial, dest);
}

function parseArgs(argv) {
  const opts = { dest: null, prefix: 'flatbed/', selfTest: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--dest') opts.dest = argv[++i];
    else if (arg === '--prefix') opts.prefix = argv[++i];
    else if (arg === '--help') opts.help = true;
    else throw new Error('unknown argument ' + arg);
  }
  if (opts.prefix && opts.prefix.slice(-1) !== '/') opts.prefix += '/';
  return opts;
}

function selfTest() {
  let failed = 0;
  function check(label, cond, detail) {
    if (cond) console.log('PASS', label);
    else {
      failed += 1;
      console.error('FAIL', label, detail !== undefined ? detail : '');
    }
  }
  // AWS docs: GET example, signature
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const known = signHeaders({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    canonicalUri: '/test.txt',
    canonicalQuery: '',
    amzDate: '20130524T000000Z',
    payloadHash: EMPTY_HASH,
    extraHeaders: { range: 'bytes=0-9' },
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3'
  });
  check('sigv4 known signature',
    known.signature === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    known.signature);

  const listed = parseList(
    '<?xml version="1.0"?><ListBucketResult>' +
    '<Contents><Key>flatbed/TD-05_up.png</Key><Size>1200</Size></Contents>' +
    '<Contents><Key>flatbed/TD-05_180.png</Key><Size>900</Size></Contents>' +
    '<IsTruncated>false</IsTruncated></ListBucketResult>'
  );
  check('list parses keys and sizes',
    listed.objects.length === 2 && listed.objects[0].key === 'flatbed/TD-05_up.png' && listed.objects[0].size === 1200 && !listed.truncated,
    listed);

  const dir = path.join('/tmp', 'flatbed-fetch-selftest');
  check('local path strips prefix', localPathFor(dir, 'flatbed/TD-07_up.png', 'flatbed/') === path.join(dir, 'TD-07_up.png'));
  check('local path rejects escape', localPathFor(dir, 'flatbed/../secret.png', 'flatbed/') == null);
  check('same size skips', sameSize(__filename, fs.statSync(__filename).size) === true);
  check('different size downloads', sameSize(__filename, 1) === false);
  check('missing file downloads', sameSize(path.join(dir, 'nope.png'), 10) === false);

  if (failed) {
    console.error(failed + ' self-test failure(s)');
    process.exitCode = 1;
  } else {
    console.log('self-test ok');
  }
  return failed;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: node scripts/fetch_flatbed.js [--dest DIR] [--prefix flatbed/] [--self-test]');
    return;
  }
  if (opts.selfTest) {
    selfTest();
    return;
  }
  const cfg = r2Config();
  const dest = opts.dest || defaultFlatbedDir();
  fs.mkdirSync(dest, { recursive: true });
  const objects = await listPrefix(cfg, opts.prefix);
  console.log('bucket ' + cfg.bucket);
  console.log('prefix ' + opts.prefix);
  console.log('dest ' + dest);
  console.log('objects ' + objects.length);
  let downloaded = 0;
  let skipped = 0;
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const local = localPathFor(dest, obj.key, opts.prefix);
    let action = 'skip-dir';
    if (local) {
      if (sameSize(local, obj.size)) {
        action = 'skip';
        skipped += 1;
      } else {
        await downloadObject(cfg, obj.key, local);
        const got = fs.statSync(local).size;
        if (got !== obj.size) {
          throw new Error(obj.key + ' size ' + got + ' does not match listed ' + obj.size);
        }
        action = 'download';
        downloaded += 1;
      }
    }
    console.log(
      obj.key +
      '\t' + obj.size +
      '\t' + action +
      (local ? '\t' + path.basename(local) : '')
    );
  }
  console.log('downloaded ' + downloaded + '  skipped ' + skipped);
}

if (require.main === module) {
  main().catch(function (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  signHeaders: signHeaders,
  parseList: parseList,
  localPathFor: localPathFor,
  sameSize: sameSize,
  selfTest: selfTest
};
