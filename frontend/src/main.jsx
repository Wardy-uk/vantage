import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

/**
 * Register the service worker under the app's base path.
 *
 * The scope has to match where the app is served from, and that differs by
 * deployment: `/` on Netlify, `/vantage/` on the Pi. Registering at the origin
 * root from the Pi would claim NEURO's pages too, which sit at `/`.
 *
 * Dev is deliberately excluded — a stale cached shell during development is a
 * confusing hour nobody needs.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch(err => console.warn('[VANTAGE] service worker did not register:', err.message));
  });
}
