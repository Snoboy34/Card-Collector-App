/**
 * Shop-beta switches. Missing file means every switch is off, so the iMac
 * keeps today's behavior until the owner writes data/beta_flags.json.
 * An environment variable overrides the file for one process.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_AUDIENCE = 'com.cardgrader.thejudge';

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function envBool(env, key) {
  if (!env || env[key] == null || env[key] === '') return null;
  return truthy(env[key]);
}

function readFlags(dataDir, env) {
  const source = env || process.env;
  const flags = {
    accounts: false,
    manualEntry: false,
    firstRunGuide: false,
    appleAudience: DEFAULT_AUDIENCE
  };
  const file = path.join(dataDir, 'beta_flags.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if ('accounts' in parsed) flags.accounts = truthy(parsed.accounts);
      if ('manualEntry' in parsed) flags.manualEntry = truthy(parsed.manualEntry);
      if ('firstRunGuide' in parsed) flags.firstRunGuide = truthy(parsed.firstRunGuide);
      if (typeof parsed.appleAudience === 'string' && parsed.appleAudience.trim()) {
        flags.appleAudience = parsed.appleAudience.trim();
      }
    }
  } catch (e) { /* absent file: stay off */ }
  const accounts = envBool(source, 'JUDGE_ACCOUNTS');
  const manual = envBool(source, 'JUDGE_MANUAL_ENTRY');
  const guide = envBool(source, 'JUDGE_FIRST_RUN');
  if (accounts != null) flags.accounts = accounts;
  if (manual != null) flags.manualEntry = manual;
  if (guide != null) flags.firstRunGuide = guide;
  if (source.JUDGE_APPLE_AUDIENCE && String(source.JUDGE_APPLE_AUDIENCE).trim()) {
    flags.appleAudience = String(source.JUDGE_APPLE_AUDIENCE).trim();
  }
  return flags;
}

module.exports = { readFlags, DEFAULT_AUDIENCE };
