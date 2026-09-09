'use strict';

const assert = require('assert');
const lookup = require('../services/card_family_lookup');

function check(name, input, expectedId, expectedMatch) {
  const got = lookup.identify(input);
  assert.strictEqual(got.familyId, expectedId, name + ' familyId');
  assert.strictEqual(got.match, expectedMatch, name + ' match');
}

check('empty array', [], 'unknown', 'unknown');
check('empty body', {}, 'unknown', 'unknown');
check('brand only', ['TOPPS'], 'unknown', 'unknown');
check('year only', ['1984'], 'unknown', 'unknown');
check('2016 Topps without Olympic', ['2016', 'Topps'], 'unknown', 'unknown');
check('UD abbreviation is not a token', ['1991 UD'], 'unknown', 'unknown');

check('1976 Topps', ['1976 Topps Dan Pastorini'], '1976-topps', 'exact');
check('1983 Topps', ['Willie McGee', '1983', 'TOPPS'], '1983-topps', 'exact');
check('1984 Topps', ['Howie Long 1984 Topps'], '1984-topps', 'exact');
check('1989 Pro Set', ['1989 PRO SET Aikman'], '1989-pro-set', 'exact');
check('1991 Upper Deck', ['CHIPPER JONES', '1991 UPPER DECK'], '1991-upper-deck', 'exact');
check('1993 Bowman', ['1993 Bowman David Treadwell'], '1993-bowman', 'exact');
check('1993 Topps', ['Shaq', '1993', 'Topps'], '1993-topps', 'exact');
check('1999 Victory', ['1999 Victory Samsonov'], '1999-victory', 'exact');
check('2016 Topps Olympic', ['2016 Topps Olympic Ryan Lochte'], '2016-topps-olympic', 'exact');

check('ambiguous 1993 Topps+Bowman', ['1993 Topps Bowman'], 'unknown', 'unknown');
check('newline ocrText', { ocrText: '1984\nTopps' }, '1984-topps', 'exact');
check('json ocrLines field', { ocrLines: JSON.stringify(['1999', 'Victory']) }, '1999-victory', 'exact');

const nine = lookup.FAMILIES.map(function (f) { return f.id; }).sort();
assert.deepStrictEqual(nine, [
  '1976-topps',
  '1983-topps',
  '1984-topps',
  '1989-pro-set',
  '1991-upper-deck',
  '1993-bowman',
  '1993-topps',
  '1999-victory',
  '2016-topps-olympic'
].sort(), 'nine lock-set rows');

console.log('card_family_lookup: ' + lookup.FAMILIES.length + ' families, all matcher checks passed');
