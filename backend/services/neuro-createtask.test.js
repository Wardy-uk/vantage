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

// ---------------------------------------------------------------------------
// The funnel (item 13)
// ---------------------------------------------------------------------------

test('a severe, already-happened finding is written straight into the tasks', async () => {
  const body = await capture(() => neuro.proposeWork({
    text: 'Portal contacts unbranded for Nicholas Humphreys',
    severity: 'high', tense: 'happened', source: 'vantage-finding',
  }));
  assert.match(body.url, /\/api\/tasks$/);
  assert.equal(body.criticality, 'high');
  assert.equal(body.origin, 'commitment');
  // The basis travels, so a task that arrived unasked can say why it is here.
  assert.match(body.notes, /already gone wrong/);
});

test('a severe thing that has NOT happened waits in the queue instead', async () => {
  const body = await capture(() => neuro.proposeWork({
    text: 'Tier 2 ageing could breach if the backlog keeps growing',
    severity: 'high', tense: 'could', source: 'vantage-finding',
  }));
  assert.match(body.url, /\/api\/actions$/, 'it must not become a task');
  assert.equal(body.type, 'vantage_suggestion');
  assert.equal(body.criticality, 'high', 'still high — the level and the route are different facts');
  assert.match(body.basis, /has not happened yet/);
});

test('a medium finding waits', async () => {
  const body = await capture(() => neuro.proposeWork({
    text: 'Reason codes slipping', severity: 'medium', tense: 'happening', source: 'vantage-finding',
  }));
  assert.match(body.url, /\/api\/actions$/);
});

test('the route taken is reported, not just the result', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: 7, created: true }) });
  try {
    const direct = await neuro.proposeWork({ text: 'x', severity: 'high', tense: 'happening', source: 'vantage-finding' });
    const waiting = await neuro.proposeWork({ text: 'y', severity: 'low', tense: 'could', source: 'vantage-finding' });
    assert.equal(direct.route, 'direct');
    assert.equal(waiting.route, 'pending');
    // So the card can say "added to your tasks" vs "waiting for you in VANTAGE"
    // rather than reporting a create that did not happen.
    assert.ok(direct.basis && waiting.basis);
  } finally {
    global.fetch = real;
  }
});

test('there is exactly one caller of the weighting', () => {
  // `criticality.assess` having one caller is what makes a grep for it find the
  // whole of the policy. Each call site deciding for itself is how two screens
  // come to disagree about what is urgent.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = __dirname;
  const callers = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
    .filter(f => /criticality\.assess\s*\(/.test(fs.readFileSync(path.join(dir, f), 'utf-8')));
  assert.deepEqual(callers, ['neuro.js']);
});
