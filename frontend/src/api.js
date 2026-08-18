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
 * API calls carry the same base path the app is served under.
 *
 * Under Tailscale's /vantage path the browser must request /vantage/api/…; a
 * bare /api would hit NEURO, which is what sits at the root of this host. Vite
 * substitutes BASE_URL at build time, so one build works at a path and another
 * at a host root without a code change.
 */
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

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
  health: () => fetch(`\/health`).then(r => r.json()),
  signals: (refresh = false) => call(`/signals${refresh ? '?refresh=1' : ''}`),

  modes: () => call('/coach/modes'),
  sessions: () => call('/coach/sessions'),
  session: id => call(`/coach/sessions/${id}`),
  createSession: (title, mode) => call('/coach/sessions', { method: 'POST', body: { title, mode } }),
  deleteSession: id => call(`/coach/sessions/${id}`, { method: 'DELETE' }),
  sendMessage: (id, content) => call(`/coach/sessions/${id}/messages`, { method: 'POST', body: { content } }),

  settings: () => call('/settings'),
  saveSettings: patch => call('/settings', { method: 'PUT', body: patch }),
  testSetting: what => call(`/settings/test/${what}`, { method: 'POST' }),

  observations: kind => call(`/observations${kind ? `?kind=${kind}` : ''}`),
  addObservation: (kind, note, sessionId) =>
    call('/observations', { method: 'POST', body: { kind, note, sessionId } }),
  deleteObservation: id => call(`/observations/${id}`, { method: 'DELETE' }),
};
