'use strict';

/**
 * Pins the empty-answer path.
 *
 * Three live calls came back HTTP 200 with an empty body, zero usage and 72–90
 * seconds on the clock (2 Sep 13:45, 2 Sep 14:46, 4 Sep 06:12 — all three the
 * radar's meeting analysis). Each one blanked the source and put a blind-spot
 * banner in front of Nick that said only "OpenRouter returned no content",
 * which is true and tells him nothing, and then sat in the cache until the next
 * successful rebuild.
 *
 * Two behaviours came out of that, and both are easy to lose:
 *  - the REASON is read off the payload and carried into the message;
 *  - ONE retry, only on empty, only when the caller asked for it.
 *
 * The second half of this file is the positive control: a refusal, an HTTP
 * error and a caller that did not opt in must all still fail on the first
 * attempt. A retry test with nothing asserting where the retry STOPS passes
 * just as well against a client that retries everything.
 */

const test = require('node:test');
const assert = require('node:assert');

const openrouter = require('./openrouter');
const { emptyReason } = openrouter;

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key';

/** Replace fetch with a scripted queue; returns how many calls were made. */
function withFetch(responses, fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async () => {
    const next = responses[calls.length] ?? responses[responses.length - 1];
    calls.push(1);
    return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body };
  };
  return fn(calls).finally(() => { global.fetch = real; });
}

const EMPTY = { body: { choices: [{ message: {} }] } };
const ok = text => ({ body: { choices: [{ message: { content: text } }], model: 'anthropic/claude-sonnet-4.5' } });

// ── The reason ───────────────────────────────────────────────────────────────

test('emptyReason reads the error object beside the choices', () => {
  assert.strictEqual(
    emptyReason({ error: { message: 'Provider returned error' }, choices: [{ message: {} }] }),
    'Provider returned error',
  );
});

test('emptyReason falls back to finish_reason, and adds a differing native one', () => {
  assert.strictEqual(emptyReason({ choices: [{ finish_reason: 'length' }] }), 'length');
  assert.strictEqual(
    emptyReason({ choices: [{ finish_reason: 'error', native_finish_reason: 'upstream_timeout' }] }),
    'error / upstream_timeout',
  );
});

test('emptyReason does not echo a native reason identical to finish_reason', () => {
  assert.strictEqual(
    emptyReason({ choices: [{ finish_reason: 'stop', native_finish_reason: 'stop' }] }),
    'stop',
  );
});

test('a reason that is absent is absent, not invented', () => {
  // The rule that outranks everything else, one file down: no reason must never
  // render as a diagnosis. `null` is what lets the message say so.
  assert.strictEqual(emptyReason({ choices: [{ message: {} }] }), null);
  assert.strictEqual(emptyReason({}), null);
});

test('the thrown message carries the reason when there is one', async () => {
  await withFetch(
    [{ body: { choices: [{ message: {}, finish_reason: 'error', native_finish_reason: 'upstream_timeout' }] } }],
    async () => {
      await assert.rejects(
        () => openrouter.complete([], { callType: 'test' }),
        /no content \(error \/ upstream_timeout\)/,
      );
    },
  );
});

test('and says the reason was missing when it was', async () => {
  await withFetch([EMPTY], async () => {
    await assert.rejects(
      () => openrouter.complete([], { callType: 'test' }),
      /no content, and no reason given/,
    );
  });
});

// ── The retry, and where it stops ────────────────────────────────────────────

test('retryOnEmpty tries once more, and the second answer is returned', async () => {
  await withFetch([EMPTY, ok('recovered')], async (calls) => {
    const res = await openrouter.complete([], { callType: 'radar', retryOnEmpty: true });
    assert.strictEqual(res.text, 'recovered');
    assert.strictEqual(calls.length, 2);
  });
});

test('the retry is ONE attempt, never a loop', async () => {
  await withFetch([EMPTY, EMPTY, EMPTY], async (calls) => {
    await assert.rejects(() => openrouter.complete([], { callType: 'radar', retryOnEmpty: true }));
    assert.strictEqual(calls.length, 2);
  });
});

test('a caller that did not opt in fails on the first empty answer', async () => {
  // coach and brief: a person is waiting, and the re-send is theirs to decide.
  await withFetch([EMPTY, ok('never reached')], async (calls) => {
    await assert.rejects(() => openrouter.complete([], { callType: 'coach' }), /no content/);
    assert.strictEqual(calls.length, 1);
  });
});

test('an HTTP refusal is not retried, even with retryOnEmpty', async () => {
  // Retrying a bad key or a rejected request masks the fault and bills twice.
  const refused = { ok: false, status: 401, body: { error: { message: 'No auth credentials found' } } };
  await withFetch([refused, ok('never reached')], async (calls) => {
    await assert.rejects(
      () => openrouter.complete([], { callType: 'radar', retryOnEmpty: true }),
      /refused the request: No auth credentials found/,
    );
    assert.strictEqual(calls.length, 1);
  });
});

test('a missing key still fails before any request is made', async () => {
  const real = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await withFetch([ok('x')], async (calls) => {
      await assert.rejects(() => openrouter.complete([], { retryOnEmpty: true }), /OPENROUTER_API_KEY is not set/);
      assert.strictEqual(calls.length, 0);
    });
  } finally {
    process.env.OPENROUTER_API_KEY = real;
  }
});
