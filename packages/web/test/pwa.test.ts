// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldCache } from '../public/sw-rules.js'
import { registerServiceWorker } from '../src/pwa'

const root = join(import.meta.dirname, '..')
const SCOPE = 'https://mm.example/app/'

describe('what the service worker may cache (phase 1g-2, Review Focus 3)', () => {
  it('caches only content-hashed assets of its own scope, fetched with GET', () => {
    expect(shouldCache(`${SCOPE}assets/index-Df0Tjq8B.js`, 'GET', SCOPE)).toBe(true)
    expect(shouldCache(`${SCOPE}assets/outfit-latin-400-normal-Bu5DG3d7.woff2`, 'GET', SCOPE)).toBe(true)
    for (const [url, method] of [
      [`${SCOPE}api/connections`, 'GET'],
      [`${SCOPE}api/auth/me`, 'GET'],
      [`${SCOPE}`, 'GET'],
      [`${SCOPE}index.html`, 'GET'],
      [`${SCOPE}c/c1/db/shop`, 'GET'],
      [`${SCOPE}favicon.svg`, 'GET'],
      [`${SCOPE}assets/index-Df0Tjq8B.js`, 'POST'],
      [`${SCOPE}assets/index-Df0Tjq8B.js?v=1`, 'GET'],
      [`${SCOPE}assets/plain.js`, 'GET'],
      [`${SCOPE}assets/../api/x-Df0Tjq8B.js`, 'GET'],
      ['https://cdn.example/app/assets/index-Df0Tjq8B.js', 'GET'],
      ['https://mm.example/other/assets/index-Df0Tjq8B.js', 'GET'],
    ] as const) {
      expect(shouldCache(url, method, SCOPE), `${method} ${url}`).toBe(false)
    }
  })
})

describe('the web app manifest', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'public', 'manifest.webmanifest'), 'utf8'))

  it('is installable and works under any base path (relative URLs only)', () => {
    expect(manifest).toMatchObject({
      name: 'Mongo Manager',
      start_url: './',
      scope: './',
      display: 'standalone',
    })
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) expect(icon.src).not.toMatch(/^([a-z]+:|\/)/i)
  })

  it('is linked from the page, with the theme colour', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8')
    expect(html).toContain('<link rel="manifest" href="manifest.webmanifest" />')
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" \/>/i)
  })
})

describe('registering the service worker', () => {
  it('registers the module worker for the base path in production builds only', async () => {
    const register = vi.fn(async () => ({}))
    const nav = { serviceWorker: { register } } as unknown as Navigator
    await registerServiceWorker(nav, 'https://mm.example/app/', true)
    expect(register).toHaveBeenCalledWith('https://mm.example/app/sw.js', { type: 'module', scope: '/app/' })
    register.mockClear()
    await registerServiceWorker(nav, 'https://mm.example/app/', false)
    await registerServiceWorker({} as Navigator, 'https://mm.example/app/', true)
    expect(register).not.toHaveBeenCalled()
  })

  it('never lets a failed registration break the app', async () => {
    const nav = { serviceWorker: { register: vi.fn(async () => Promise.reject(new Error('blocked'))) } }
    await expect(
      registerServiceWorker(nav as unknown as Navigator, 'https://mm.example/', true),
    ).resolves.toBe(undefined)
  })
})

describe('service worker: final review 1g-2', () => {
  it('stores a response only when it really is the asset: never a page, never a navigation (I1)', async () => {
    const { mayStore } = await import('../public/sw-rules.js')
    const url = 'https://mm.example/app/assets/index-Df0Tjq8B.js'
    expect(mayStore(url, 'no-cors', 'text/javascript; charset=utf-8')).toBe(true)
    expect(mayStore(url, 'cors', 'application/javascript')).toBe(true)
    expect(mayStore(url, 'no-cors', 'text/html; charset=utf-8')).toBe(false)
    expect(mayStore(url, 'navigate', 'text/javascript')).toBe(false)
    expect(mayStore(url, 'no-cors', null)).toBe(false)
    expect(mayStore('https://mm.example/app/assets/a-Df0Tjq8B.woff2', 'cors', 'font/woff2')).toBe(true)
    expect(mayStore('https://mm.example/app/assets/a-Df0Tjq8B.css', 'no-cors', 'text/css')).toBe(true)
    expect(mayStore('https://mm.example/app/assets/a-Df0Tjq8B.css', 'no-cors', 'text/plain')).toBe(false)
  })

  it('names its cache after its scope and deletes only its own old caches (I2)', async () => {
    const { cacheName, isOwnOldCache } = await import('../public/sw-rules.js')
    const mine = cacheName('https://mm.example/mm/')
    expect(mine).not.toBe(cacheName('https://mm.example/other/'))
    expect(isOwnOldCache('mm-assets-v0:https://mm.example/mm/', 'https://mm.example/mm/')).toBe(true)
    expect(isOwnOldCache(mine, 'https://mm.example/mm/')).toBe(false)
    expect(isOwnOldCache('mm-assets-v1:https://mm.example/other/', 'https://mm.example/mm/')).toBe(false)
    expect(isOwnOldCache('workbox-precache-v2', 'https://mm.example/mm/')).toBe(false)
    expect(isOwnOldCache('mm-assets-v1', 'https://mm.example/mm/')).toBe(false)
  })
})
