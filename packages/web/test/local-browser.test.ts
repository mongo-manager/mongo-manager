// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { api, localKeyNow, setLocalKey } from '../src/api/client'
import { followApiLink, installLocalLinks, setLocalMode } from '../src/api/localLinks'
import { useSessionStore } from '../src/stores/session'
import { mockApi } from './support/app'
// Loaded up front: the router's own lazy load of it takes longer than a wait allows.
import '../src/views/WorkspaceView.vue'

/**
 * Review of the audit fixes (important 1): local mode's cookie goes to every port of the host, so the
 * server wants this browser's page key too. The page claims it once after its launch link, keeps it in
 * its own origin's storage and sends it with every request; a download link carries a one-time ticket.
 */
beforeEach(() => {
  localStorage.clear()
  setLocalKey(undefined)
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const REFUSED = [401, { code: 'UNAUTHENTICATED', message: 'x', details: { reason: 'launch_required' } }] as [
  number,
  unknown,
]
const ME = {
  mode: 'local',
  user: { id: 'local' },
  permissions: [],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: {},
}

describe('the page key', () => {
  it('is claimed once after a launch link, kept in this origin, and sent with every request', async () => {
    const { calls } = mockApi({
      'GET auth/status': (_b, _u) => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'POST auth/local/claim': () => [200, { key: 'page-key-1' }],
      'GET auth/me': () => [200, ME],
    })
    // The first status has no key: refused until the claim.
    let claimed = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = new URL(String(input)).pathname.replace(/^\/api\//, '')
        const headers = (init.headers ?? {}) as Record<string, string>
        calls.push({ method: init.method ?? 'GET', path, body: init.body, headers })
        if (path === 'auth/local/claim') {
          claimed = true
          return new Response(JSON.stringify({ key: 'page-key-1' }), { status: 200 })
        }
        if (headers['x-mm-local'] !== 'page-key-1')
          return new Response(JSON.stringify(REFUSED[1]), { status: 401 })
        if (path === 'auth/me') return new Response(JSON.stringify(ME), { status: 200 })
        return new Response(JSON.stringify({ mode: 'local', setupRequired: false, authenticated: true }), {
          status: 200,
        })
      }),
    )
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(claimed).toBe(true)
    expect(router.currentRoute.value.name).toBe('workspace')
    expect(localStorage.getItem('mm:local-key')).toBe('page-key-1')
    expect(localKeyNow()).toBe('page-key-1')
    const sent = calls.filter((c) => c.path !== 'auth/local/claim').at(-1)!
    expect(sent.headers['x-mm-local']).toBe('page-key-1')
  })

  it('claims once only when the server still refuses the key it gave', async () => {
    let claims = 0
    mockApi({
      'GET auth/status': () => REFUSED,
      'POST auth/local/claim': () => {
        claims++
        return [200, { key: `k${claims}` }]
      },
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(claims).toBe(1)
    expect(router.currentRoute.value.name).toBe('openLink')
  })

  it('shows how to open the app when there is nothing to claim', async () => {
    mockApi({ 'GET auth/status': () => REFUSED, 'POST auth/local/claim': () => REFUSED })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('openLink')
    expect(useSessionStore().status).toMatchObject({ launchRequired: true })
  })
})

describe('a download link in local mode', () => {
  it('asks a one-time ticket for its path with the key, and follows the link with it', async () => {
    setLocalKey('page-key-1')
    const { calls } = mockApi({ 'POST auth/local/link': () => [200, { ticket: 'tkt' }] })
    const followed: string[] = []
    const off = installLocalLinks(
      document,
      () => true,
      () => {},
    )
    const realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.dataset.mmTicketed) followed.push(this.href)
      else realClick.call(this)
    }
    try {
      const link = document.createElement('a')
      link.href = new URL('api/audit/export?format=csv', document.baseURI).href
      link.setAttribute('download', '')
      document.body.append(link)
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      await flushPromises()
      expect(calls.at(-1)).toMatchObject({
        method: 'POST',
        path: 'auth/local/link',
        body: { path: new URL('api/audit/export', document.baseURI).pathname },
      })
      expect(calls.at(-1)!.headers['x-mm-local']).toBe('page-key-1')
      expect(followed).toHaveLength(1)
      expect(new URL(followed[0]!).searchParams.get('mm_link')).toBe('tkt')
      expect(new URL(followed[0]!).searchParams.get('format')).toBe('csv')
      // A link elsewhere is left alone.
      const other = document.createElement('a')
      other.href = 'https://example.com/x'
      document.body.append(other)
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      other.addEventListener('click', (e) => e.preventDefault())
      other.dispatchEvent(event)
      await flushPromises()
      expect(calls.filter((c) => c.path === 'auth/local/link')).toHaveLength(1)
    } finally {
      HTMLAnchorElement.prototype.click = realClick
      off()
    }
  })

  it('leaves links alone in team mode', async () => {
    const { calls } = mockApi({})
    const off = installLocalLinks(
      document,
      () => false,
      () => {},
    )
    const link = document.createElement('a')
    link.href = new URL('api/audit/export', document.baseURI).href
    link.addEventListener('click', (e) => e.preventDefault())
    document.body.append(link)
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    await flushPromises()
    expect(calls).toEqual([])
    off()
  })
})

// Second review (N2): what the app opens itself (a toast's Download) and what the browser opens on its
// own from a link (middle-click, "Open in new tab", "Save link as") carry a ticket too.
describe('API links followed outside a plain click', () => {
  it('follows a link the app opens itself with a ticket, in local mode', async () => {
    setLocalKey('page-key-1')
    const { calls } = mockApi({ 'POST auth/local/link': () => [200, { ticket: 'tkt' }] })
    const followed: Array<{ href: string; attached: boolean; download: string | null }> = []
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      followed.push({ href: this.href, attached: this.isConnected, download: this.getAttribute('download') })
    })
    setLocalMode(() => true)
    await followApiLink(new URL('api/backups/b1/download', document.baseURI).href, { download: '' })
    spy.mockRestore()
    expect(calls.at(-1)).toMatchObject({ path: 'auth/local/link' })
    expect(followed).toHaveLength(1)
    expect(new URL(followed[0]!.href).searchParams.get('mm_link')).toBe('tkt')
    expect(followed[0]).toMatchObject({ attached: true, download: '' })
  })

  it('follows it as it is in team mode', async () => {
    const { calls } = mockApi({})
    const followed: string[] = []
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      followed.push(this.href)
    })
    setLocalMode(() => false)
    await followApiLink(new URL('api/backups/b1/download', document.baseURI).href)
    spy.mockRestore()
    expect(calls).toEqual([])
    expect(followed[0]).toMatch(/\/api\/backups\/b1\/download$/)
  })

  it('puts a ticket in the link just before the browser follows it on its own', async () => {
    setLocalKey('page-key-1')
    let n = 0
    mockApi({ 'POST auth/local/link': () => [200, { ticket: `t${++n}` }] })
    const off = installLocalLinks(
      document,
      () => true,
      () => {},
    )
    const link = document.createElement('a')
    link.href = new URL('api/audit/export?format=csv', document.baseURI).href
    document.body.append(link)
    for (const event of [
      new MouseEvent('contextmenu', { bubbles: true }),
      new MouseEvent('pointerdown', { bubbles: true, button: 1 }),
      new FocusEvent('focusin', { bubbles: true }),
    ]) {
      link.dispatchEvent(event)
      await flushPromises()
      const url = new URL(link.href)
      expect(url.searchParams.get('mm_link'), event.type).toBe(`t${n}`)
      expect(url.searchParams.get('format')).toBe('csv')
    }
    off()
  })
})

describe('the client', () => {
  // Second review (minor 2): a new link opened in another tab gives a new key; this tab uses it.
  it('reads the key another tab claimed since', async () => {
    setLocalKey('old-key')
    localStorage.setItem('mm:local-key', 'new-key')
    const { calls } = mockApi({ 'GET connections': () => [200, []] })
    await api.get('connections')
    expect(calls[0]!.headers['x-mm-local']).toBe('new-key')
  })

  it('sends no key in team mode, where none was claimed', async () => {
    const { calls } = mockApi({ 'GET connections': () => [200, []] })
    await api.get('connections')
    expect(calls[0]!.headers['x-mm-local']).toBeUndefined()
  })
})
