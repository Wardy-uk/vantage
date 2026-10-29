'use strict';

/**
 * OpenRouter client.
 *
 * Kept deliberately thin — no streaming, no model fallback chain. A coaching
 * reply that fails is a message Nick re-sends; a silent retry that doubles a
 * bill or masks a broken key is worse. Failures surface with their real reason.
 *
 * ⚠ ONE narrow exception to "no retries" — see `retryOnEmpty` below. It is
 * opt-in per call, fires only on an unbilled empty answer, and never applies to
 * anything a person is waiting on.
 */

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
const TIMEOUT_MS = 90_000;

function isConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * Why an answer came back empty.
 *
 * A 200 with no content is NOT self-explanatory, and the client used to throw
 * the bare words "OpenRouter returned no content" — which is the single line the
 * radar's blind-spot banner shows Nick. Three live failures (2 Sep 13:45, 2 Sep
 * 14:46, 4 Sep 06:12) all reported exactly that and nothing else, so the same
 * message covered a stalled upstream, a refusal and a length cut without
 * distinguishing them.
 *
 * OpenRouter puts the reason in one of three places on a 200: an `error` object
 * beside the choices, `finish_reason`, or the provider's own
 * `native_finish_reason`. Read all three, keep whatever answered, and say so.
 * A reason that is itself absent renders as absent — never as "unknown cause"
 * dressed up as a diagnosis.
 */
function emptyReason(payload) {
  const choice = payload?.choices?.[0] || {};
  const parts = [
    payload?.error?.message || payload?.error?.code,
    choice.finish_reason,
    // Only when it adds something — providers routinely echo finish_reason.
    choice.native_finish_reason !== choice.finish_reason ? choice.native_finish_reason : null,
  ].filter(v => v != null && v !== '');
  return parts.length ? parts.join(' / ') : null;
}

/** Marks the empty-answer case so the retry can tell it from a refusal. */
class EmptyCompletion extends Error {}

/**
 * The shared AI gate (22 Oct 2026). Every attempt — a retry included — takes its
 * OWN single-use ticket in the ledger NEURO and VANTAGE share, reserved before
 * the request and settled after it on OpenRouter's own charged cost. Shadow mode:
 * the gate records what it would refuse and never blocks a call; there is no
 * daily cap. The gate never fails a call: an unreadable ledger is reported, not
 * thrown.
 */
function gateOpen({ model, maxTokens, callType, messages }) {
  try {
    const gate = require('./ai-gate');
    const { REGISTRY } = require('./ai-gate-classes');
    const chars = JSON.stringify(messages || []).length;
    const t = gate.reserve({
      app: 'vantage', callClass: callType || null, provider: 'openrouter', model,
      maxInputTokens: Math.ceil(chars / 3.5), maxOutputTokens: maxTokens,
    }, REGISTRY);
    if (!t.admitted) throw new gate.GateRefused(t);
    return t;
  } catch (e) {
    if (e && e.name === 'GateRefused') throw e;
    return null; // the gate itself failed to load — never cost the call
  }
}
function gateClose(ticket, usage) {
  if (!ticket) return;
  try { require('./ai-gate').settle(ticket, usage); } catch { /* bookkeeping never fails a call */ }
}

async function attempt(messages, { model, temperature, maxTokens, json, callType, timeoutMs = TIMEOUT_MS }) {
  const ledger = require('./llm-ledger');
  const started = Date.now();
  const ticket = gateOpen({ model, maxTokens, callType, messages });

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // OpenRouter uses these for attribution on its dashboard.
        'HTTP-Referer': 'https://vantage.nickward.co.uk',
        'X-Title': 'VANTAGE',
      },
      body: JSON.stringify({
        model, messages, temperature, max_tokens: maxTokens,
        // The vendor's OWN charged cost, rather than a local price table that
        // drifts the moment pricing changes.
        usage: { include: true },
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    gateClose(ticket, { ok: false, error: e.message });
    throw e;
  }

  // ⚠ The timeout covers the BODY too. An abort while the answer is still
  // arriving used to be swallowed here into {} and reported as "no content,
  // and no reason given" (29 Oct 2026, a long assessment) — a timeout must say so.
  let bodyError = null;
  const payload = await res.json().catch((e) => { bodyError = e; return {}; });
  if (bodyError && /abort|timeout/i.test(`${bodyError.name} ${bodyError.message}`)) {
    const detail = `timed out after ${Math.round(timeoutMs / 1000)}s while the answer was still arriving`;
    gateClose(ticket, { ok: false, error: detail });
    ledger.record({ model, callType, ok: false, error: detail, latencyMs: Date.now() - started });
    throw new Error(`OpenRouter ${detail} — try again`);
  }
  const usage = payload?.usage || null;
  const served = payload?.model || model;
  // An empty or refused answer can still carry usage; settle on it when it does.
  gateClose(ticket, {
    ok: res.ok && Boolean(payload?.choices?.[0]?.message?.content), model: served,
    promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens,
    costUsd: usage && usage.cost != null ? Number(usage.cost) : undefined,
    error: res.ok ? null : `HTTP ${res.status}`,
  });
  if (!res.ok) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    // Recorded before throwing: a refused call still consumed a slot, and a
    // ledger of successes cannot tell an expensive outage from a quiet week.
    ledger.record({ model, callType, ok: false, error: detail, latencyMs: Date.now() - started });
    throw new Error(`OpenRouter refused the request: ${detail}`);
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (!text) {
    const why = emptyReason(payload);
    const detail = why ? `no content (${why})` : 'no content, and no reason given';
    ledger.record({ model: payload?.model || model, callType, ok: false, error: detail, latencyMs: Date.now() - started });
    throw new EmptyCompletion(`OpenRouter returned ${detail}`);
  }

  ledger.record({
    // The model that ACTUALLY served it, not the one requested — a fallback
    // would otherwise be billed to the wrong name.
    model: payload?.model || model,
    callType,
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    // null when OpenRouter did not report one. Never 0.
    costUsd: usage && usage.cost != null ? Number(usage.cost) : null,
    latencyMs: Date.now() - started,
    ok: true,
  });
  return { text, model: payload?.model || model, usage };
}

/**
 * One completion. `messages` is the OpenAI-shaped array.
 *
 * Throws with a usable message rather than returning a sentinel: every caller
 * here surfaces the failure to Nick, and a coaching pane that says "I could not
 * reach the model, the key is rejected" is more useful than one that says
 * nothing and looks thoughtful.
 */
/**
 * `json: true` asks the provider to constrain the output to valid JSON.
 *
 * The meeting analyser failed twice on malformed output — truncated once, then
 * an unescaped character at position 6748. Prompting for JSON and hoping is not
 * a contract; this is. Where a provider ignores the hint the caller still has to
 * parse defensively, but the failure rate drops from routine to rare.
 */
/**
 * `retryOnEmpty` — one more go, and only for the case that earns it.
 *
 * Measured on the Pi's ledger, 4 Sep 2026: 3 of 27 calls failed, all three the
 * radar's meeting analysis, all three a 200 with an empty body, ZERO usage
 * reported and 72–90 seconds on the clock. Nothing was billed, so a second
 * attempt cannot double a bill; the run is a background warm nobody is sitting
 * in front of, so it cannot cost anyone a wait; and the alternative is the
 * meeting analysis going blind on roughly one build in nine, with the blind-spot
 * banner then served from cache until the next successful rebuild — over three
 * hours, on 4 Sep.
 *
 * Strictly limited, because the reasons this file has no retries are still true:
 *  - ONE extra attempt, never a loop.
 *  - ONLY on an empty answer. A refusal, a bad key, an HTTP error or a timeout
 *    throws on the first try exactly as before — retrying those masks the fault.
 *  - Opt-in per call. `coach` and `brief` do not pass it and must not: a person
 *    is waiting, and a re-send is theirs to decide.
 *
 * Both attempts are recorded in the ledger. A retry that hides the first
 * failure would turn an 11% blank rate into a number nobody could see.
 */
async function complete(messages, { model = DEFAULT_MODEL, temperature = 0.7, maxTokens = 2000, json = false, callType = null, retryOnEmpty = false, timeoutMs = TIMEOUT_MS } = {}) {
  if (!isConfigured()) {
    throw new Error('OPENROUTER_API_KEY is not set — add it to backend/.env');
  }

  const opts = { model, temperature, maxTokens, json, callType, timeoutMs };
  try {
    return await attempt(messages, opts);
  } catch (err) {
    if (!retryOnEmpty || !(err instanceof EmptyCompletion)) throw err;
    console.warn(`[VANTAGE] ${callType || 'model'} call came back empty (${err.message}) — retrying once`);
    return attempt(messages, opts);
  }
}

module.exports = { complete, isConfigured, emptyReason, EmptyCompletion, DEFAULT_MODEL };
