/**
 * API client.
 *
 * The PIN is held in localStorage and sent as a header. That is appropriate for
 * a single-user tool on Nick's own devices and would not be for anything
 * multi-user — there is no session, no rotation and no per-user scope, by design.
 */

const PIN_KEY = 'vantage.pin';

export const getPin = () => localStorage.getItem(PIN_KEY) || '';
export const setPin = pin => localStorage.setItem(PIN_KEY, pin);
export const clearPin = () => localStorage.removeItem(PIN_KEY);

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
export { ApiError };

/**
 * Where the API lives, decided at build time.
 *
 * Two deployments, two answers:
 *
 * - Served BY the Pi at /vantage — same origin, so a relative path. It must
 *   carry the base path: a bare /api would hit NEURO, which sits at the root of
 *   that host.
 * - Served by NETLIFY at vantage.nickward.co.uk — the API is still on the Pi, so
 *   VITE_API_BASE is set to the absolute Funnel URL. That makes every call
 *   cross-origin, which is why the backend keeps an origin allowlist.
 */
const API_BASE = import.meta.env.VITE_API_BASE
  ? import.meta.env.VITE_API_BASE.replace(/\/$/, '')
  : `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Vantage-Pin': getPin(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new ApiError(payload?.error || `Request failed (${res.status})`, res.status);
  }
  return payload.data;
}

export const api = {
  health: () => fetch(`${API_BASE}/health`).then(r => r.json()),
  signals: (refresh = false) => call(`/signals${refresh ? '?refresh=1' : ''}`),
  radar: (refresh = false) => call(`/radar${refresh ? '?refresh=1' : ''}`),

  findings: (status) => call(`/findings${status ? '?status=' + status : ''}`),
  addFinding: f => call('/findings', { method: 'POST', body: f }),
  updateFinding: (id, patch) => call(`/findings/${id}`, { method: 'PUT', body: patch }),
  deleteFinding: id => call(`/findings/${id}`, { method: 'DELETE' }),
  findingsMarkdown: since => call(`/findings/markdown${since ? '?since=' + since : ''}`),

  modes: () => call('/coach/modes'),
  sessions: () => call('/coach/sessions'),
  session: id => call(`/coach/sessions/${id}`),
  createSession: (title, mode) => call('/coach/sessions', { method: 'POST', body: { title, mode } }),
  deleteSession: id => call(`/coach/sessions/${id}`, { method: 'DELETE' }),
  sendMessage: (id, content) => call(`/coach/sessions/${id}/messages`, { method: 'POST', body: { content } }),

  settings: () => call('/settings'),
  saveSettings: patch => call('/settings', { method: 'PUT', body: patch }),
  changePin: (current, next) => call('/settings/pin', { method: 'POST', body: { current, next } }),
  testSetting: what => call(`/settings/test/${what}`, { method: 'POST' }),

  observations: kind => call(`/observations${kind ? `?kind=${kind}` : ''}`),
  addObservation: (kind, note, sessionId) =>
    call('/observations', { method: 'POST', body: { kind, note, sessionId } }),
  deleteObservation: id => call(`/observations/${id}`, { method: 'DELETE' }),
};
