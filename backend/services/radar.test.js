'use strict';

/**
 * Pins the tolerant JSON extractor.
 *
 * Three consecutive live runs lost the entire meeting analysis to malformed
 * model output — truncated, then an unescaped character, then again despite
 * asking OpenRouter for a JSON response format that Claude models appear to
 * ignore. The extractor exists so a broken tail costs one finding instead of
 * all of them, and these cases are the ones that actually happened.
 */

const test = require('node:test');
const assert = require('node:assert');

const { extractItems } = require('./radar');

const PAYLOAD = JSON.stringify({
  items: [
    { tense: 'could', severity: 'high', title: 'One', detail: 'contains a } brace and a "quote"' },
    { tense: 'happening', severity: 'low', title: 'Two', detail: 'second' },
  ],
});

test('a complete payload yields every item', () => {
  assert.equal(extractItems(PAYLOAD).length, 2);
});

test('a brace inside a quoted string does not end the object early', () => {
  // The scanner is string-aware; without that, "contains a }" would terminate
  // item one mid-object and lose it.
  const items = extractItems(PAYLOAD);
  assert.match(items[0].detail, /\} brace/);
  assert.match(items[0].detail, /"quote"/);
});

test('a truncated payload keeps the items that completed', () => {
  // This is the failure that cost three runs: the whole source returned nothing
  // because the last object was cut off.
  const truncated = PAYLOAD.slice(0, PAYLOAD.length - 40);
  const items = extractItems(truncated);
  assert.equal(items.length, 1, 'the finished item survives');
  assert.equal(items[0].title, 'One');
});

test('code fences and trailing prose are tolerated', () => {
  const fenced = '```json\n' + PAYLOAD + '\n```\nHope that helps!';
  assert.equal(extractItems(fenced).length, 2);
});

test('an object with no title is discarded rather than rendered blank', () => {
  const junk = '{"items":[{"tense":"could","detail":"no title here"},'
    + '{"tense":"could","severity":"low","title":"Real","detail":"x"}]}';
  const items = extractItems(junk);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Real');
});

test('unparseable input yields nothing rather than throwing', () => {
  assert.deepEqual(extractItems('I could not produce JSON, sorry.'), []);
  assert.deepEqual(extractItems(''), []);
});
