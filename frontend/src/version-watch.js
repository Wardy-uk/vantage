// COPY of nuero/shared/version-watch.mjs (5 Oct 2026). Keep in step.
/**
 * Is a newer build of this app being served than the one running? Plain JS, no
 * React — imported by NEURO, both SAiM shells and (as a copy) VANTAGE, which
 * resolve React from different node_modules.
 *
 * Calls onState({ newer: build|null, reachable: bool }) after each check:
 *   newer      the build the server now holds, when it differs from `current`
 *   reachable  false when version.json could not be read (server down, or a
 *              dev server that never built one) — never treated as "newer"
 *
 * Checks every minute and whenever the tab becomes visible again (the moment
 * someone is about to read it). fetch is no-store with a cache-busting query,
 * so neither the HTTP cache nor a service worker can answer with the old file.
 */
/** The entry script this page loaded with, read once from the document. */
function loadedEntry() {
  try {
    const el = [...document.querySelectorAll('script[type="module"][src]')].find((s) => /\/assets\//.test(s.src));
    return el ? new URL(el.src).pathname.split('/').pop() : null;
  } catch { return null; }
}

export function watchVersion({ current, url = '/version.json', intervalMs = 60000, onState }) {
  let stopped = false;
  const entry = loadedEntry();
  const check = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) { onState({ newer: null, reachable: r.status !== 404 ? false : true, missing: r.status === 404 }); return; }
      const j = await r.json();
      const build = j && typeof j.build === 'string' ? j.build : null;
      // Prefer the entry file (changes only with the app's code); fall back to
      // the build id when either side cannot say. Unknown is never "newer".
      const changed = j && j.entry && entry ? j.entry !== entry : !!(build && current && build !== current);
      onState({ newer: changed ? (build || 'a newer build') : null, reachable: true, builtAt: j && j.builtAt || null });
    } catch {
      onState({ newer: null, reachable: false });
    }
  };
  const onVisible = () => { if (document.visibilityState === 'visible') check(); };
  check();
  const timer = setInterval(check, intervalMs);
  document.addEventListener('visibilitychange', onVisible);
  return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
}
