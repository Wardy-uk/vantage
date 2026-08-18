'use strict';

/**
 * OpenRouter client.
 *
 * Kept deliberately thin — no retries, no streaming, no model fallback chain.
 * A coaching reply that fails is a message Nick re-sends; a silent retry that
 * doubles a bill or masks a broken key is worse. Failures surface with their
 * real reason.
 */

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
const TIMEOUT_MS = 90_000;

function isConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * One completion. `messages` is the OpenAI-shaped array.
 *
 * Throws with a usable message rather than returning a sentinel: every caller
 * here surfaces the failure to Nick, and a coaching pane that says "I could not
 * reach the model, the key is rejected" is more useful than one that says
 * nothing and looks thoughtful.
 */
async function complete(messages, { model = DEFAULT_MODEL, temperature = 0.7, maxTokens = 2000 } = {}) {
  if (!isConfigured()) {
    throw new Error('OPENROUTER_API_KEY is not set — add it to backend/.env');
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      // OpenRouter uses these for attribution on its dashboard.
      'HTTP-Referer': 'https://vantage.nickward.co.uk',
      'X-Title': 'VANTAGE',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenRouter refused the request: ${detail}`);
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned no content');
  return { text, model: payload?.model || model, usage: payload?.usage || null };
}

module.exports = { complete, isConfigured, DEFAULT_MODEL };
