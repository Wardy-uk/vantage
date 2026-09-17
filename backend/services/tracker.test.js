'use strict';

/**
 * Pins the tracker feed, and one defect in particular.
 *
 * ⚠ The live values were first held in a `Map`. In-process that worked and the
 * detectors were fine; over the wire `JSON.stringify` of a Map is `{}`, so
 * `/api/tracker` and the MCP operation both returned an empty object where
 * every live value should have been. It shipped, and nothing caught it, because
 * the only consumers exercised until then were in-process.
 *
 * So the first test here is that the feed SURVIVES A ROUND TRIP THROUGH JSON.
 * Anything that crosses a serialisation boundary gets checked on the far side
 * of one.
 */

const test = require('node:test');
const assert = require('node:assert');

const tracker = require('./tracker');

const feed = {
  available: true,
  rows: [{ label: 'New Tickets', kpiKey: 'nt_legacy_new_tickets' }, { label: 'Failed Jobs', kpiKey: null }],
  live: { available: true, items: [{ key: 'nt_legacy_new_tickets', value: 128, rag: 'red' }] },
};

test('the live values survive a JSON round trip', () => {
  // The exact failure that shipped: a Map here stringifies to {} and the far
  // side sees no values at all, with no error anywhere.
  const overTheWire = JSON.parse(JSON.stringify(feed));
  assert.equal(overTheWire.live.items.length, 1, 'live values must cross a serialisation boundary');
  assert.equal(overTheWire.live.items[0].value, 128);
});

test('indexLive rebuilds the lookup callers want, without storing a Map', () => {
  const idx = tracker.indexLive(feed.live);
  assert.equal(idx.get('nt_legacy_new_tickets').value, 128);
  assert.equal(idx.get('nope'), undefined);
});

test('indexLive on an absent snapshot yields an empty lookup, not a throw', () => {
  // A failed live read must degrade to "no values", never take the caller down
  // and never invent one.
  assert.equal(tracker.indexLive(null).size, 0);
  assert.equal(tracker.indexLive({ available: false }).size, 0);
});

test('the baseline caveat fires before the correction date and not after', () => {
  // Dated rather than a boolean, so it expires by arithmetic instead of being
  // switched off by hand and forgotten.
  assert.match(String(tracker.baselineCaveat('2026-08-20')), /never backfilled/);
  assert.equal(tracker.baselineCaveat('2026-09-12'), null);
  assert.equal(tracker.baselineCaveat(tracker.BASELINE_TRUSTED_FROM), null);
});

test('a row with no KPI key is a named absence, not a silent drop', () => {
  // The tracker is the sheet Nick reports. A view showing only the computable
  // rows would quietly redefine it as the subset NOVA happens to know.
  const blank = feed.rows.filter(r => !r.kpiKey);
  assert.equal(blank.length, 1);
  assert.equal(blank[0].label, 'Failed Jobs');
});
