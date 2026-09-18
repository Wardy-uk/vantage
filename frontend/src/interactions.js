/**
 * Counting control uses on a view, for NEURO's screen-usage heatmap.
 *
 * ⚠ THIS IS A DELIBERATE COPY of `nuero/shared/interaction-buffer.cjs`, not an
 * import. VANTAGE and NEURO are separate repos with separate deploys — the
 * frontend here builds on Netlify, where a relative path into a sibling
 * checkout does not exist — so it cannot be shared as code, exactly as
 * `ai-cost.PRICES_PER_MTOK` cannot be shared with NOVA's `MODEL_PRICING`.
 * `screen-opens.test.js` pins the values that must agree, so a change on either
 * side is a visible decision rather than drift.
 *
 * ⚠ WHAT COUNTS IS A CONTROL, not a click (Nick, 18 Sep 2026): a button, link,
 * checkbox, input or select. Clicking prose or scrolling is reading, and
 * counting it would make "interacted with" mean "was on screen".
 *
 * ⚠ A VIEW WITH NO INTERACTIONS IS NOT A FAILING VIEW. Radar and Tracker are
 * things to READ; they will sit near zero here and that is them working.
 */

const CONTROL_SELECTOR = [
  'button', 'a[href]', 'input', 'select', 'textarea', 'summary', 'label',
  '[role="button"]', '[role="tab"]', '[role="checkbox"]', '[role="switch"]',
  '[role="link"]', '[role="menuitem"]', '[role="option"]',
].join(',');

const FLUSH_MS = 20000;
const MAX_PER_FLUSH = 500;

export function isControlUse(target) {
  if (!target || typeof target.closest !== 'function') return false;
  try {
    return Boolean(target.closest(CONTROL_SELECTOR));
  } catch {
    // Not knowing is NOT a reason to count it — over-counting would quietly
    // turn this into "clicks anywhere".
    return false;
  }
}

export function createInteractionBuffer({ send, flushMs = FLUSH_MS }) {
  const pending = new Map();
  let timer = null;
  let inFlight = false;

  function schedule() {
    if (timer || !pending.size) return;
    timer = setTimeout(() => { timer = null; flush(); }, flushMs);
  }

  function count(tab, n = 1) {
    if (!tab) return;
    pending.set(tab, Math.min((pending.get(tab) || 0) + n, MAX_PER_FLUSH));
    schedule();
  }

  /**
   * ⚠ Cleared BEFORE the send and restored on failure, so clicks made during
   * the request are not lost to the clear.
   */
  async function flush() {
    if (inFlight || !pending.size) return { sent: 0 };
    const batch = [...pending.entries()];
    pending.clear();
    inFlight = true;
    let sent = 0;
    try {
      for (const [tab, n] of batch) { await send({ tab, count: n }); sent += n; }
      return { sent };
    } catch (e) {
      for (const [tab, n] of batch) {
        pending.set(tab, Math.min((pending.get(tab) || 0) + n, MAX_PER_FLUSH));
      }
      return { sent, failed: true, reason: e && e.message };
    } finally {
      inFlight = false;
      schedule();
    }
  }

  return { count, flush, stop: () => { if (timer) { clearTimeout(timer); timer = null; } } };
}

/**
 * ⚠ SCOPED to the content area as an ALLOWLIST, never a denylist of chrome:
 * clicking the nav is LEAVING a view, not working in one, and counting it
 * would give every view a free interaction on the way out.
 *
 * ⚠ `click` AND `change`, never `input` — the last fires per keystroke, so a
 * text box would win the grid outright. Both CAPTURING, so a handler calling
 * `stopPropagation` cannot hide a click. The tab is read at EVENT TIME.
 */
export function attachInteractionListener({ scope, getTab, buffer }) {
  if (typeof document === 'undefined' || !buffer) return () => {};

  const onEvent = (e) => {
    const target = e && e.target;
    if (!isControlUse(target)) return;
    if (scope && typeof target.closest === 'function' && !target.closest(scope)) return;
    const tab = typeof getTab === 'function' ? getTab() : null;
    if (tab) buffer.count(tab, 1);
  };

  document.addEventListener('click', onEvent, true);
  document.addEventListener('change', onEvent, true);
  const onHide = () => { if (document.visibilityState === 'hidden') buffer.flush(); };
  document.addEventListener('visibilitychange', onHide);

  return () => {
    document.removeEventListener('click', onEvent, true);
    document.removeEventListener('change', onEvent, true);
    document.removeEventListener('visibilitychange', onHide);
    buffer.stop();
  };
}

export const _internals = { CONTROL_SELECTOR, FLUSH_MS, MAX_PER_FLUSH };
