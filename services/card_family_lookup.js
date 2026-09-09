/**
 * services/card_family_lookup.js
 * =============================================================================
 * Diagnostic set/family ID from OCR text. Not a grader.
 *
 * Strict all-tokens-present match against the lock-set table in
 * card_families.json. Zero hits or two+ hits → unknown. Never guesses.
 * Does not set incomplete or change Judge scores.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TABLE_PATH = path.join(__dirname, 'card_families.json');
const table = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
const FAMILIES = Array.isArray(table.families) ? table.families : [];

function normalizeBlob(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasToken(blob, token) {
  const t = normalizeBlob(token);
  if (!t || !blob) return false;
  return (' ' + blob + ' ').indexOf(' ' + t + ' ') !== -1;
}

function parseOcrLines(body) {
  if (!body) return [];
  const fromField = coerceLineList(body.ocrLines);
  if (fromField.length) return fromField;
  return coerceLineList(body.ocrText);
}

function coerceLineList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(function (v) { return String(v).trim(); }).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(function (v) { return String(v).trim(); }).filter(Boolean);
    }
  } catch (e) {
    /* plain text */
  }
  return trimmed.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
}

function unknownResult(ocrLines) {
  return {
    familyId: 'unknown',
    match: 'unknown',
    ocrLines: ocrLines || []
  };
}

/**
 * @param {string[]|string|{ocrLines?: any, ocrText?: any}} input
 * @returns {{ familyId: string, match: 'exact'|'unknown', ocrLines: string[] }}
 */
function identify(input) {
  var ocrLines;
  if (Array.isArray(input)) ocrLines = input.map(function (v) { return String(v).trim(); }).filter(Boolean);
  else if (typeof input === 'string') ocrLines = coerceLineList(input);
  else ocrLines = parseOcrLines(input || {});

  const blob = normalizeBlob(ocrLines.join(' '));
  if (!blob) return unknownResult(ocrLines);

  const hits = FAMILIES.filter(function (family) {
    const tokens = family && Array.isArray(family.tokens) ? family.tokens : [];
    return tokens.length > 0 && tokens.every(function (token) { return hasToken(blob, token); });
  });

  if (hits.length === 1) {
    return {
      familyId: hits[0].id,
      match: 'exact',
      ocrLines: ocrLines
    };
  }
  return unknownResult(ocrLines);
}

module.exports = {
  FAMILIES: FAMILIES,
  parseOcrLines: parseOcrLines,
  identify: identify,
  unknownResult: unknownResult
};
