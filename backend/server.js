'use strict';

const path = require('path');

// Resolved against THIS file, not the working directory. `npm start` from the
// repo root and `node server.js` from backend/ are both normal ways to launch
// it, and a config that only loads from one of them fails as "PIN not set" —
// which looks like a missing secret rather than a missing file.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const express = require('express');

const db = require('./db');
const coach = require('./services/coach');
const signals = require('./services/signals');
const openrouter = require('./services/openrouter');
const settings = require('./services/settings');
const radar = require('./services/radar');
const findings = require('./services/findings');
const plan = require('./services/plan');
const planTasks = require('./services/plan-tasks');
const self = require('./services/self');
const brief = require('./services/brief');

const PORT = parseInt(process.env.PORT ?? '3006', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Auth. VANTAGE deliberately differs from NEURO here.
 *
 * NEURO's API defaults to fully open when its PIN env var is unset. That is a
 * reasonable dev convenience for a second brain; it is the wrong default for the
 * service holding the coaching layer — reflections on Nick's manager, prep for
 * conversations that have not happened, and a screenshot he was not meant to
 * see. The API is reachable from the internet via Tailscale Funnel.
 *
 * So there is no dev exception: no PIN, no start.
 */
if (!process.env.VANTAGE_PIN) {
  console.error(
    '\n[VANTAGE] Refusing to start: VANTAGE_PIN is not set.\n'
    + '  This service holds the private coaching layer and must never be open.\n'
    + '  Set VANTAGE_PIN in backend/.env (any non-trivial string).\n',
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * CORS, for the Netlify-hosted frontend.
 *
 * The app is served two ways: from this process at /vantage on the Pi (same
 * origin, no CORS needed), and from Netlify at vantage.nickward.co.uk calling
 * back to the Pi's Funnel URL (cross-origin, CORS required).
 *
 * An allowlist, never `*`. The PIN travels in a request header, and a wildcard
 * origin on an API that holds the coaching layer would let any page on the
 * internet make authenticated-looking requests once it had that PIN.
 *
 * The custom `X-Vantage-Pin` header makes every request preflighted, so OPTIONS
 * has to be answered explicitly or the browser never sends the real call.
 */
const ALLOWED_ORIGINS = (process.env.VANTAGE_ALLOWED_ORIGINS
  || 'https://vantage.nickward.co.uk')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Vantage-Pin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(origin && ALLOWED_ORIGINS.includes(origin) ? 204 : 403);
    return;
  }
  next();
});

/** Health is deliberately unauthenticated — it reveals nothing. */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vantage',
    ai: openrouter.isConfigured() ? 'configured' : 'missing OPENROUTER_API_KEY',
    signals: signals.isConfigured() ? 'configured' : 'missing NOVA bridge config',
  });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  // Read PER REQUEST, not captured at startup.
  //
  // The first version held it in a const, so changing the PIN through the admin
  // page updated the .env and the process env but not the comparison — the new
  // PIN was rejected until a restart, which looked exactly like the change
  // having failed. A value that can be changed at runtime must be read at
  // runtime.
  const expected = process.env.VANTAGE_PIN;
  const provided = req.headers['x-vantage-pin'] || req.query.pin;
  if (!expected || provided !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  next();
});

/** Uniform error shape, and never a stack trace to the client. */
const wrap = fn => async (req, res) => {
  try {
    const data = await fn(req, res);
    if (!res.headersSent) res.json({ ok: true, data });
  } catch (err) {
    console.error(`[VANTAGE] ${req.method} ${req.path}:`, err.message);
    if (!res.headersSent) res.status(400).json({ ok: false, error: err.message });
  }
};

// ── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', wrap(() => settings.describe()));
app.put('/api/settings', wrap(req => settings.save(req.body || {})));
app.post('/api/settings/pin', wrap(req => settings.changePin(req.body || {})));

/**
 * Prove a setting actually works, rather than accepting it and failing later in
 * a coaching reply. Both checks are the cheapest real call available — a
 * 1-token completion and the bridge's own status endpoint.
 */
app.post('/api/settings/test/:what', wrap(async req => {
  if (req.params.what === 'openrouter') {
    if (!openrouter.isConfigured()) return { ok: false, message: 'No API key set.' };
    const r = await openrouter.complete(
      [{ role: 'user', content: 'Reply with the single word: ready' }],
      { maxTokens: 8, temperature: 0 },
    );
    return { ok: true, message: `Model answered: "${r.text.trim().slice(0, 40)}"`, model: r.model };
  }

  if (req.params.what === 'nova') {
    const s = await signals.current({ force: true });
    return s.available
      ? { ok: true, message: `Connected. ${s.summary.split('\n').length} signals returned.` }
      : { ok: false, message: s.reason };
  }

  throw new Error(`Unknown test "${req.params.what}"`);
}));

// ── Signals ──────────────────────────────────────────────────────────────────

app.get('/api/signals', wrap(req => signals.current({ force: req.query.refresh === '1' })));
app.get('/api/radar', wrap(req => radar.build({ force: req.query.refresh === '1' })));

// ── Findings register ────────────────────────────────────────────────────────

app.get('/api/findings', wrap(req => findings.list({ status: req.query.status, since: req.query.since })));
app.post('/api/findings', wrap(req => findings.add(req.body || {})));
app.put('/api/findings/:id', wrap(req => findings.update(Number(req.params.id), req.body || {})));
app.delete('/api/findings/:id', wrap(req => { findings.remove(Number(req.params.id)); return { deleted: true }; }));
app.post('/api/findings/:id/draft', wrap(req => findings.draftRaise(Number(req.params.id), req.body || {})));
app.get('/api/findings/markdown', wrap(req => ({ markdown: findings.markdown({ since: req.query.since }) })));

// The one automated step in radar → log → findings → report. Puts a line on
// NEURO's weekly risk report; sending it to Chris stays a decision made in
// NEURO, behind its own approval gate.
app.post('/api/findings/:id/neuro', wrap(req => findings.escalate(Number(req.params.id), req.body || {})));

// Literal path first: Express matches in registration order, and this repo has
// shipped a literal swallowed by a sibling parameter before.
// Pull NEURO's answer back — a ticked task moves its finding to
// resolved_pending, which asks Nick for the sentence NEURO cannot know.
app.post('/api/findings/sync', wrap(() => findings.syncFromNeuro()));
app.post('/api/findings/:id/resolve', wrap(req => findings.resolve(Number(req.params.id), req.body || {})));
app.post('/api/findings/:id/reopen', wrap(req => findings.reopen(Number(req.params.id))));

// ── Improvement plan ─────────────────────────────────────────────────────────

app.get('/api/plan', wrap(() => plan.list()));
app.put('/api/plan/:id', wrap(req => plan.setStatus(req.params.id, req.body || {})));

// The delivery half: which of the 35 actions are real tasks in NEURO, and which
// of those NEURO has merged with Mel's Planner board. Separate from /api/plan
// because it is a network call — the plan must still render with NEURO down.
app.get('/api/plan/tasks', wrap(req => planTasks.overview({ rematch: req.query.rematch === '1' })));
app.post('/api/plan/:id/task', wrap(req => planTasks.createFor(req.params.id, req.body || {})));
app.post('/api/plan/:id/link', wrap(req => planTasks.link(req.params.id, (req.body || {}).taskId)));
app.post('/api/plan/:id/planner', wrap(req => planTasks.adoptMicrosoft(req.params.id, req.body || {})));
app.delete('/api/plan/:id/link', wrap(req => planTasks.unlink(req.params.id)));

// ── Coaching ─────────────────────────────────────────────────────────────────

app.get('/api/coach/modes', wrap(() =>
  Object.entries(coach.MODES).map(([key, m]) => ({ key, label: m.label }))));

app.get('/api/coach/sessions', wrap(() => coach.listSessions()));
app.get('/api/coach/sessions/:id', wrap(req => {
  const s = coach.getSession(Number(req.params.id));
  if (!s) throw new Error('Session not found');
  return s;
}));
app.post('/api/coach/sessions', wrap(req => coach.createSession(req.body || {})));
app.delete('/api/coach/sessions/:id', wrap(req => {
  coach.deleteSession(Number(req.params.id));
  return { deleted: true };
}));

app.post('/api/coach/sessions/:id/messages', wrap(async req => {
  // Signals are pulled per message rather than per session: a conversation
  // spanning an afternoon should not be reasoning about this morning's numbers.
  const current = await signals.current();
  return coach.send({
    sessionId: Number(req.params.id),
    content: req.body?.content,
    signals: current,
    model: req.body?.model,
  });
}));

// ── Coaching brief ───────────────────────────────────────────────────────────

app.get('/api/coach/brief', wrap(req => brief.generate({ force: req.query.refresh === '1' })));
app.post('/api/coach/brief/start', wrap(req => brief.startFrom(req.body || {})));
app.get('/api/self', wrap(() => self.snapshot()));
app.get('/api/self/quick', wrap(() => self.quick()));

// ── Observations ─────────────────────────────────────────────────────────────

app.get('/api/observations', wrap(req => coach.listObservations({ kind: req.query.kind })));
app.post('/api/observations', wrap(req => coach.addObservation(req.body || {})));
app.delete('/api/observations/:id', wrap(req => {
  coach.deleteObservation(Number(req.params.id));
  return { deleted: true };
}));

// ── Frontend ─────────────────────────────────────────────────────────────────

const dist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  app.use('/assets', express.static(path.join(dist, 'assets'), {
    maxAge: '1y', immutable: true,
  }));
  app.use(express.static(dist, {
    maxAge: 0,
    setHeaders: (res, filePath) => {
      // Express does not know this extension, and a manifest served as
      // octet-stream is not reliably installable.
      if (filePath.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json');
      }
      // A cached service worker can pin the app to an old shell permanently.
      // The worker itself must always be revalidated.
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
} else if (IS_PROD) {
  console.warn('[VANTAGE] No frontend build found — run `npm run build` before starting in production.');
}

db.init();
// Saved settings win over the environment, so a value set on the admin page
// survives a restart and is not silently overridden by a stale .env on the box.
settings.apply();

/**
 * Keep the radar warm.
 *
 * Building it takes 60–110 seconds, so the goal is that nobody ever triggers a
 * build by visiting. A refresh runs on a timer, and the result is persisted, so
 * opening the app reads a stored value with a timestamp on it.
 *
 * Working hours only. Each pass costs a set of heavy queries against a database
 * that is also serving the live service desk, plus a model call for the meeting
 * analysis — running that through the night would spend real money and DTUs to
 * keep a screen fresh for nobody.
 *
 * The first warm is delayed: the boot path already has a database to open and a
 * frontend to serve, and racing a two-minute query against startup helps no one.
 */
const WARM_EVERY_MS = 25 * 60 * 1000;
const WARM_FROM_HOUR = 6;
const WARM_UNTIL_HOUR = 20;

async function warm(reason) {
  const hour = new Date().getHours();
  if (reason !== 'startup' && (hour < WARM_FROM_HOUR || hour >= WARM_UNTIL_HOUR)) return;
  try {
    const started = Date.now();
    await radar.build({ force: true });
    console.log(`[VANTAGE] radar warmed (${reason}) in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    // A failed warm is not fatal — the last good value is still on disk, and the
    // app will report its age honestly.
    console.warn(`[VANTAGE] radar warm failed (${reason}):`, err.message);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[VANTAGE] running on 0.0.0.0:${PORT}`);
  if (!openrouter.isConfigured()) console.warn('[VANTAGE] No OpenRouter key — set one on the Admin page. Coaching will fail until then.');
  if (!signals.isConfigured()) console.warn('[VANTAGE] No NOVA bridge config — set it on the Admin page. Signals render as unavailable until then.');

  // Warm on boot only if there is nothing stored — a redeploy should not cost a
  // fresh two-minute run when yesterday's value is perfectly serviceable and
  // the timer will replace it shortly anyway.
  const stored = require('./services/cache').read('radar');
  if (!stored) setTimeout(() => warm('startup'), 20_000);
  else console.log(`[VANTAGE] radar cache restored from ${stored.at}`);
  setInterval(() => warm('timer'), WARM_EVERY_MS);
});
