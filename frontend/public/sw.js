/* eslint-env serviceworker */

/**
 * VANTAGE service worker.
 *
 * Its job is to make the app open instantly and survive a flaky signal — NOT to
 * work offline in any meaningful sense. A risk radar showing yesterday's picture
 * without saying so is precisely the failure this whole project refuses
 * everywhere else, so:
 *
 *   APP SHELL  — cached. HTML, JS, CSS, icons. Safe: it is code, not data.
 *   /api/*     — NEVER cached, in either direction. Not stored, not served from
 *                cache when the network fails. A failed request must fail, so the
 *                UI can say the source did not answer.
 *
 * The second rule matters twice over here: the API responses contain the private
 * coaching layer, and a Cache Storage copy of those would sit on the device
 * outside the PIN gate.
 */

const VERSION = 'v3';
const SHELL = `vantage-shell-${VERSION}`;

self.addEventListener('install', event => {
  // Take over promptly; there is one user and no tabs worth protecting from a
  // version change mid-session.
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL).then(cache => cache.addAll(['./', './index.html']).catch(() => {})),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Anything API-shaped goes straight to the network and is never stored.
  // Checked on the path rather than the origin because the API may be on the
  // same host (served by the Pi) or a different one (Netlify frontend calling
  // the Pi), and both must be excluded.
  if (url.pathname.includes('/api/')) return;

  // Cross-origin: leave it alone entirely.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, so a deploy is picked up immediately, with the
  // cached shell as the fallback when the network is not there.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || Response.error())),
    );
    return;
  }

  // Hashed build assets are immutable, so cache-first is safe and instant. A new
  // deploy produces new filenames rather than new contents at the same name.
  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok && (url.pathname.includes('/assets/') || url.pathname.includes('/icons/'))) {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(request, copy)).catch(() => {});
      }
      return res;
    })),
  );
});
