'use strict';

/**
 * Every task VANTAGE creates says whose it is (item 4).
 *
 * NEURO's `inferOrigin()` reads provenance and recognises three sources — the
 * management log, a meeting note, a Planner board. `vantage-plan` and
 * `vantage-finding` are none of them, so every task VANTAGE has ever written
 * landed UNCLASSIFIED. That is not a cosmetic gap: the weekly risk report going
 * to Chris counts commitments and cannot count those, and VANTAGE's own radar
 * then renders them as "treat the commitment figure as a floor" — the tool
 * manufacturing the ambiguity it reports.
 *
 * The payload is asserted here rather than the wrapper's arguments, because the
 * payload is what NEURO stores. `origin` and `source` are separate fields and
 * neither substitutes for the other: `source` says which door it came in by,
 * `origin` says whether somebody is waiting.
 */

const test = require('node:test');
const assert = require('node:assert');

// A credential the transport will accept, so the payload is what is under test
// rather than the configuration. Nothing here reaches a network — `fetch` is
// replaced for the duration of every call.
process.env.NEURO_URL = process.env.NEURO_URL || 'http://neuro.invalid';
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token';

const neuro = require('./neuro');

/** Capture the body without a network: replace fetch for the duration. */
async function capture(fn) {
  const real = global.fetch;
  let body = null;
  global.fetch = async (url, opts = {}) => {
    body = { url: String(url), ...JSON.parse(opts.body || '{}') };
    return { ok: true, status: 200, json: async () => ({ id: 1, created: true }) };
  };
  try { await fn(); } finally { global.fetch = real; }
  return body;
}

test('a plan action is created as a commitment', async () => {
  const body = await capture(() => neuro.createTask({ text: 'Publish the QA calibration pack' }));
  assert.equal(body.origin, 'commitment');
  assert.equal(body.source, 'vantage-plan');
});

test('an escalated finding is created as a commitment', async () => {
  const body = await capture(() => neuro.createTask({ text: 'Chase the Tier 2 ageing', source: 'vantage-finding' }));
  assert.equal(body.origin, 'commitment');
  assert.equal(body.source, 'vantage-finding');
});

test('origin is never left out, whatever else the caller omits', async () => {
  // The failure being pinned is an ABSENT field, not a wrong one — NEURO reads a
  // missing origin as "nobody has classified this", which is exactly the bucket
  // this change exists to empty.
  const body = await capture(() => neuro.createTask({ text: 'x' }));
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'origin'), 'payload must carry an origin');
  assert.notEqual(body.origin, null);
});

test('an explicit origin still wins — the default is a default, not a policy', async () => {
  // If VANTAGE ever writes something nobody is waiting on, it must be able to
  // say so. Guessing commitment for that would manufacture a broken promise on
  // a report read by the person assessing a PIP.
  const body = await capture(() => neuro.createTask({ text: 'x', origin: 'improvement' }));
  assert.equal(body.origin, 'improvement');
});
