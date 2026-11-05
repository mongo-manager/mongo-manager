// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// What the service worker may answer from its cache (phase 1g-2, Review Focus 3): only files
// whose name carries a content hash (Vite's assets/name-HASH.ext), from its own scope, fetched
// with GET and without a query. They never change, so a cached copy can never be stale or hold
// anyone's data. API responses, pages and every other file always go to the server untouched.
const HASHED = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/

/** The cache version: raise it when the rules change, and the older caches of this scope go. */
const VERSION = 'v1'
const PREFIX = 'mm-assets-'

/**
 * @param {string} url the request URL
 * @param {string} method the request method
 * @param {string} scope the worker's scope URL (ends with "/")
 * @returns {boolean}
 */
export function shouldCache(url, method, scope) {
  if (method !== 'GET') return false
  const target = new URL(url)
  const base = new URL(scope)
  if (target.origin !== base.origin || target.search !== '' || !target.pathname.startsWith(base.pathname)) {
    return false
  }
  return HASHED.test(target.pathname.slice(base.pathname.length))
}

/** Content types a hashed asset may have, by extension. */
const TYPES = {
  js: /^(text|application)\/javascript\b/,
  mjs: /^(text|application)\/javascript\b/,
  css: /^text\/css\b/,
  woff2: /^font\/woff2\b/,
  woff: /^font\/woff\b/,
  ttf: /^font\/ttf\b/,
  otf: /^font\/otf\b/,
  svg: /^image\/svg\+xml\b/,
  png: /^image\/png\b/,
  webp: /^image\/webp\b/,
  jpg: /^image\/jpeg\b/,
  jpeg: /^image\/jpeg\b/,
  gif: /^image\/gif\b/,
  avif: /^image\/avif\b/,
  wasm: /^application\/wasm\b/,
  json: /^application\/json\b/,
}

/**
 * Whether a response may be kept: never for a navigation, and only when its type is the one its
 * extension promises. An app page answered in place of a missing asset (an old server, a crafted
 * link) is never stored under a script's name (final review 1g-2, I1).
 * @param {string} url
 * @param {string} mode the request mode
 * @param {string | null} contentType
 * @returns {boolean}
 */
export function mayStore(url, mode, contentType) {
  if (mode === 'navigate' || !contentType) return false
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''
  const expected = TYPES[ext]
  return expected !== undefined && expected.test(contentType.toLowerCase())
}

/**
 * The cache of this worker: Cache Storage is shared by the whole origin, so the name carries the
 * scope, and other apps or other Mongo Manager instances on the same host keep theirs (I2).
 * @param {string} scope
 */
export const cacheName = (scope) => `${PREFIX}${VERSION}:${scope}`

/**
 * An older cache of this same scope, to delete on activation; nothing else is ever deleted.
 * @param {string} key
 * @param {string} scope
 */
export function isOwnOldCache(key, scope) {
  const suffix = `:${scope}`
  return key.startsWith(PREFIX) && key.endsWith(suffix) && key !== cacheName(scope)
}
