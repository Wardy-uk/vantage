'use strict';

/**
 * VANTAGE through the shared AI budget gate (22 Oct 2026).
 *
 *  - ai-gate.js is byte-identical to NEURO's copy (when the sibling checkout exists);
 *  - only openrouter.js names a model provider, and it opens a ticket per attempt;
 *  - every callType a caller names is a registered class;
 *  - Radar's meeting analysis lands in the shared ledger as app vantage / class
 *    radar with OpenRouter's own cost, and its single empty-answer retry is a
 *    SECOND ticket (never one ticket settled twice).
 *
 * The ledger is a real SQLite file. VANTAGE's tests otherwise avoid the native
 * driver; where better-sqlite3 cannot be loaded (a laptop without a native
 * build) the ledger checks skip and SAY so — the Pi runs them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AI_GATE_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-gate-')), 'ledger.db');

let driver = true;
try { require.resolve('better-sqlite3'); } catch { driver = false; }
const needsDriver = driver ? {} : { skip: 'better-sqlite3 is not installed in this checkout — run on the Pi (or with NODE_PATH to a build)' };

const SERVICES = __dirname;
const read = (f) => fs.readFileSync(path.join(SERVICES, f), 'utf8');

test('ai-gate.js is byte-identical to NEURO’s copy', (t) => {
  // The sibling NEURO checkout, from this repo's root or from a worktree under .claude/worktrees/.
  const roots = [path.resolve(SERVICES, '..', '..', '..'), path.resolve(SERVICES, '..', '..', '..', '..', '..', '..')];
  const candidates = roots.flatMap((r) => [
    path.join(r, 'nuero', 'backend', 'services', 'ai-gate.js'),
    path.join(r, 'nuero', '.claude', 'worktrees', 'budget-gate', 'backend', 'services', 'ai-gate.js'),
  ]);
  const theirs = candidates.find((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('AI GATE'));
  if (!theirs) return t.skip('no NEURO checkout beside this one; NEURO’s own test pins the other direction');
  const norm = (s) => s.replace(/\r\n/g, '\n');
  assert.equal(norm(read('ai-gate.js')), norm(fs.readFileSync(theirs, 'utf8')));
});

test('only openrouter.js reaches a model provider, and it opens and settles a gate ticket', () => {
  const files = fs.readdirSync(SERVICES).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  assert.ok(files.length > 20, 'positive control');
  const PROVIDERS = [/openrouter\.ai\/api/, /api\.openai\.com/, /api\.anthropic\.com/, /@anthropic-ai\/sdk/, /localhost:11434/, /api\.voyageai\.com/];
  const offenders = files.filter((f) => f !== 'openrouter.js' && PROVIDERS.some((p) => p.test(read(f))));
  assert.deepEqual(offenders, []);
  const server = fs.readFileSync(path.join(SERVICES, '..', 'server.js'), 'utf8');
  assert.ok(!PROVIDERS.some((p) => p.test(server)), 'server.js calls no provider directly');
  const or = read('openrouter.js');
  assert.match(or, /openrouter\.ai\/api/, 'positive control');
  assert.match(or, /const ticket = gateOpen\(/);
  assert.match(or, /gateClose\(ticket/);
});

test('every callType a caller names is a registered gate class', () => {
  const { CLASS_NAMES } = require('./ai-gate-classes');
  const sources = fs.readdirSync(SERVICES).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map(read)
    .concat(fs.readFileSync(path.join(SERVICES, '..', 'server.js'), 'utf8'));
  const named = new Set();
  for (const s of sources) for (const m of s.matchAll(/callType:\s*'([a-z_]+)'/g)) named.add(m[1]);
  assert.ok(named.has('radar') && named.size >= 5, `positive control (${[...named].join(', ')})`);
  assert.deepEqual([...named].filter((c) => !CLASS_NAMES.includes(c)), []);
  // A completion with no callType would be unnamed: the connection test now names itself.
  assert.match(fs.readFileSync(path.join(SERVICES, '..', 'server.js'), 'utf8'), /callType: 'connection_test'/);
});

test('Radar’s meeting analysis goes through the gate; its empty-answer retry is a second ticket', needsDriver, async () => {
  const gate = require('./ai-gate');
  gate._reset();
  const realFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let n = 0;
  global.fetch = async (url) => {
    assert.match(String(url), /openrouter\.ai/);
    n += 1;
    const empty = n === 1; // first attempt comes back empty, the retry answers
    return new Response(JSON.stringify({
      model: 'anthropic/claude-sonnet-4.5',
      choices: [{ message: { content: empty ? '' : '{"items":[{"tense":"could","severity":"medium","title":"t","detail":"d","meeting":"m"}]}' }, finish_reason: empty ? 'stop' : 'stop' }],
      usage: empty ? { prompt_tokens: 0, completion_tokens: 0, cost: 0 } : { prompt_tokens: 9000, completion_tokens: 600, cost: 0.036 },
    }), { status: 200 });
  };
  try {
    const radar = require('./radar');
    const items = await radar.fromMeetings([{ title: 'Team meeting', content: 'Risk discussed.' }], []);
    assert.equal(items.length, 1);
    assert.equal(n, 2, 'one retry, exactly');
    const p = gate.profile();
    const row = p.byClass.find((c) => c.app === 'vantage' && c.callClass === 'radar');
    assert.ok(row, 'radar is in the shared ledger');
    assert.equal(row.calls, 2, 'two attempts, two tickets');
    assert.equal(row.usd, 0.036, 'the vendor cost; the empty attempt cost nothing');
    assert.equal(p.share.usd, 0.036);
    assert.equal(p.events['duplicate-settle'], undefined);
    assert.equal(p.wouldRefuse, 0);
    assert.equal(p.dailyCapUsd, null);
  } finally {
    global.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('the gate never costs VANTAGE a call: an unwritable ledger still admits it', needsDriver, async () => {
  const gate = require('./ai-gate');
  const saved = process.env.AI_GATE_DB_PATH;
  // A ledger whose "directory" is an existing FILE: cannot be created on any OS.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-gate-blk-')), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  process.env.AI_GATE_DB_PATH = path.join(blocker, 'x.db');
  gate._reset();
  const realFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  global.fetch = async () => new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'ok' } }], usage: { cost: 0.001 } }), { status: 200 });
  try {
    const r = await require('./openrouter').complete([{ role: 'user', content: 'x' }], { callType: 'findings', maxTokens: 50 });
    assert.equal(r.text, 'ok');
    assert.equal(gate.profile().known, false);
  } finally {
    global.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_GATE_DB_PATH = saved;
    gate._reset();
  }
});
