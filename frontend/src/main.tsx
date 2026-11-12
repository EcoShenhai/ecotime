import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Offline (A3): the service worker serves the cached shell; the page itself caches the files it loaded,
// so codes work offline from the second visit. API responses are never cached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const cache = await caches.open('ecotime-shell');
      const urls = new Set(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png']);
      for (const e of performance.getEntriesByType('resource')) {
        const u = new URL(e.name);
        if (u.origin === location.origin && u.pathname.startsWith('/assets/')) urls.add(u.pathname);
      }
      await cache.addAll([...urls]);
      for (const req of await cache.keys()) {
        const p = new URL(req.url).pathname;
        if (p.startsWith('/assets/') && !urls.has(p) && !/\/assets\/[a-z]{2,3}-[\w-]+\.js$/.test(p)) await cache.delete(req);
      }
    } catch { /* offline support is best effort */ }
  });
}
