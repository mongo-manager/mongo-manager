import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import OpenLinkView from '../src/views/OpenLinkView.vue'
// Loaded up front: the router's own lazy load of it takes longer than a wait allows.
import '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { api, onUnauthenticated } from '../src/api/client'
import { mockApi, mountApp } from './support/app'

/**
 * Security audit 2026-10-16 (important 2): in local mode a browser that did not come from a launch
 * link is refused by the API; it sees how to open the app, never the workspace.
 */
beforeEach(() => {
  localStorage.clear()
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

describe('local mode without the launch cookie', () => {
  it('shows how to open the app, and nothing else, in the user language', async () => {
    i18n.global.locale.value = 'tr'
    let opened = false
    const unauthenticated = vi.fn()
    onUnauthenticated(unauthenticated)
    const { calls } = mockApi({
      'GET auth/status': () =>
        opened ? [200, { mode: 'local', setupRequired: false, authenticated: true }] : REFUSED,
      'GET auth/me': () => [200, { mode: 'local', user: { id: 'local' }, permissions: [], csrfToken: 'c' }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/c/abc/db/shop')
    expect(router.currentRoute.value.name).toBe('openLink')
    // The status's refusal is its answer: no "session ended" round.
    expect(unauthenticated).not.toHaveBeenCalled()
    expect(calls.some((c) => c.path === 'auth/me')).toBe(false)
    const { wrapper } = mountApp(OpenLinkView, { plugins: [router] })
    expect(wrapper.text()).toContain('Bu tarayıcıya henüz izin verilmedi')
    expect(wrapper.text()).toContain('mongo-manager open')
    // Second review (minor 4): why a browser that was in is asked again.
    expect(wrapper.get('[data-open-link-storage]').text()).toContain('Bu tarayıcı onu unuttu')
    // Opened from a link in another tab meanwhile: Try again goes in.
    opened = true
    await wrapper.get('[data-test="retry"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('workspace'))
  })

  it('says so when the link it came from was used or expired', async () => {
    mockApi({ 'GET auth/status': () => REFUSED })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/open-link?link=expired')
    const { wrapper } = mountApp(OpenLinkView, { plugins: [router] })
    await flushPromises()
    expect(wrapper.text()).toContain('That link has expired or was already used.')
  })

  it('sends a browser refused later (the cookie gone) to the same page', async () => {
    let refused = false
    mockApi({
      'GET auth/status': () =>
        refused ? REFUSED : [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, { mode: 'local', user: { id: 'local' }, permissions: [], csrfToken: 'c' }],
      'GET connections': () => REFUSED,
    })
    const router = createAppRouter(createMemoryHistory())
    onUnauthenticated(() => {
      void router.push({ name: 'login' })
    })
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('workspace')
    refused = true
    const { useSessionStore } = await import('../src/stores/session')
    useSessionStore().ready = false
    await api.get('connections').catch(() => undefined)
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('openLink'))
  })
})
