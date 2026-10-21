/* web-pwa service worker.
 *
 * It exists for exactly one reason: Chrome will not offer to install this app
 * without a service worker that has a fetch handler. Verified empirically —
 * `beforeinstallprompt` does not fire without one, on this Chrome.
 *
 * It deliberately does NOT cache. DSH is a live websocket client whose whole
 * value is showing current state, and a cached shell would be worse than no
 * installed app at all.
 *
 * Served from /dsh-pwa/sw.js with `Service-Worker-Allowed: /` so its scope
 * covers the origin, which `start_url: "/"` requires.
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  // Only GET is proxied. Letting a POST fall through to the browser keeps
  // request bodies out of this worker's hands entirely.
  if (event.request.method !== 'GET') return
  // Network-only passthrough. Chrome treats a listener that never calls
  // respondWith as a no-op for installability, so this must actually respond —
  // but resolving to a plain fetch means the request reaches the network
  // exactly as it would have with no worker installed. WebSocket upgrades are
  // not intercepted by service workers, so the live transport is untouched.
  event.respondWith(fetch(event.request))
})
