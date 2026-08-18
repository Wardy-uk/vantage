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
const PIN = process.env.VANTAGE_PIN;
if (!PIN) {
  console.error(
    '\n[VANTAGE] Refusing to start: VANTAGE_PIN is not set.\n'
    + '  This service holds the private coaching layer and must never be open.\n'
    + '  Set VANTAGE_PIN in backend/.env (any non-trivial string).\n',
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

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
  const provided = req.headers['x-vantage-pin'] || req.query.pin;
  if (provided !== PIN) {
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
  app.use(express.static(dist, { maxAge: 0 }));
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[VANTAGE] running on 0.0.0.0:${PORT}`);
  if (!openrouter.isConfigured()) console.warn('[VANTAGE] No OpenRouter key — set one on the Admin page. Coaching will fail until then.');
  if (!signals.isConfigured()) console.warn('[VANTAGE] No NOVA bridge config — set it on the Admin page. Signals render as unavailable until then.');
});
