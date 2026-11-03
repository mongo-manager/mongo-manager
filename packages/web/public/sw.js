// Mongo Manager service worker: makes the app installable (PWA) and keeps the content-hashed
// assets in a cache. Everything else, the API above all, goes to the server untouched.
import { cacheName, isOwnOldCache, mayStore, shouldCache } from './sw-rules.js'

const scope = self.registration.scope
const CACHE = cacheName(scope)
/** Old builds leave their hashed files behind: the oldest go beyond this many. */
const MAX_ENTRIES = 300

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Cache Storage is shared by the whole origin: only this scope's older caches are removed.
      for (const key of await caches.keys()) if (isOwnOldCache(key, scope)) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.mode === 'navigate' || !shouldCache(request.url, request.method, scope)) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(request)
      if (hit) return hit
      const response = await fetch(request)
      const storable =
        response.ok &&
        response.type === 'basic' &&
        mayStore(request.url, request.mode, response.headers.get('content-type'))
      if (storable) {
        await cache.put(request, response.clone())
        const keys = await cache.keys()
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(old)
      }
      return response
    })(),
  )
})
