import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import HomeView from '../src/workspace/HomeView.vue'
import CommandPalette from '../src/workspace/CommandPalette.vue'
import { i18n } from '../src/i18n'
import { queryKeys } from '../src/api/connections'
import { aiKeys } from '../src/api/ai'
import { useAssistantStore } from '../src/ai/chat/store'
import { collectionPlace, usePlacesStore } from '../src/stores/places'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { useDashboardStore } from '../src/stores/dashboard'
import { mockApi, mountApp } from './support/app'

const CONN = {
  id: 'c1',
  name: 'Production',
  group: 'EU',
  color: 'green',
  favorite: true,
  readOnly: false,
  access: 'admin',
  permissions: ['documents:read'],
}
const HISTORY = {
  type: 'history',
  id: 'h1',
  db: 'shop',
  coll: 'orders',
  tags: [],
  kind: 'find',
  preview: '{ status: "A" }',
  body: { filter: { status: 'A' } },
  at: new Date().toISOString(),
  shared: false,
  mine: true,
}
function signIn() {
  useSessionStore().me = {
    mode: 'team',
    user: { id: 'u1', username: 'ayse', role: 'admin' },
    permissions: ['connections:manage'],
    csrfToken: 'c',
    readOnly: false,
    twoFactor: {},
  } as never
  useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
  useTabsStore().bindUser('u1')
  usePlacesStore().bindUser('u1')
}
const menuItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.includes(text))!

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => {
  // A save still waiting would reach the next test's mocked server.
  useDashboardStore().reset()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Overview modules, now widgets (spec rev. 2 §3.5; user review 2026-10-09)', () => {
  it('removes a widget from its menu, and the dashboard keeps that for the user', async () => {
    signIn()
    const { calls } = mockApi({
      'GET connections': () => [200, [CONN]],
      'GET me/dashboard': () => [200, { dashboard: null }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
    })
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    expect(wrapper.find('section[aria-labelledby] h2').exists()).toBe(true)
    ;(wrapper.get('button[aria-label="Activity options"]').element as HTMLButtonElement).click()
    await flushPromises()
    menuItem('Remove').click()
    await nextTick()
    expect(wrapper.findAll('h2').map((h) => h.text())).not.toContain('Activity')
    await useDashboardStore().flush()
    const saved = calls.filter((c) => c.method === 'PUT').at(-1)!.body as { widgets: Array<{ type: string }> }
    expect(saved.widgets.map((w) => w.type)).not.toContain('activity')
  })

  it('continues where the user left off, and lists pins', async () => {
    signIn()
    usePlacesStore().visit(collectionPlace('c1', 'shop', 'orders'))
    usePlacesStore().pin(collectionPlace('c1', 'shop', 'users'))
    mockApi({ 'GET connections': () => [200, [CONN]] })
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    const cont = wrapper.get('[data-widget="continue"]')
    expect(cont.text()).toContain('shop.orders')
    expect(wrapper.get('[data-widget="pinned"]').text()).toContain('shop.users')
    await cont
      .findAll('button')
      .find((b) => b.text().includes('shop.orders'))!
      .trigger('click')
    expect(useTabsStore().active?.params).toEqual({ connectionId: 'c1', db: 'shop', coll: 'orders' })
  })

  it('shows the last opened connection’s recent queries and opens one into its collection', async () => {
    signIn()
    usePlacesStore().visit(collectionPlace('c1', 'shop', 'orders'))
    mockApi({
      'GET connections': () => [200, [CONN]],
      'GET connections/c1/library': (_b, url) => [
        200,
        { items: url.searchParams.get('type') === 'history' ? [HISTORY] : [], truncated: false, tags: [] },
      ],
    })
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    const queries = wrapper.get('[data-widget="queries"]')
    expect(queries.text()).toContain('Production')
    expect(queries.text()).toContain('{ status: "A" }')
    await queries
      .findAll('button')
      .find((b) => b.text().includes('{ status: "A" }'))!
      .trigger('click')
    await flushPromises()
    expect(useTabsStore().active?.params.coll).toBe('orders')
  })

  it('keeps Needs attention where the user put it, saying all is well when nothing needs a person', async () => {
    // User review 2026-10-09: it vanished on "Done" when quiet, and the widgets beside it moved.
    signIn()
    mockApi({
      'GET connections': () => [200, [CONN]],
      'GET backup-schedules': () => [200, { enabled: true, schedules: [] }],
    })
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    const attention = wrapper.get('[data-widget="attention"]')
    expect(attention.text()).toContain('Nothing needs attention now.')
    expect(attention.find('[data-attention-quiet]').exists()).toBe(true)
  })
})

describe('the palette goes anywhere (spec rev. 2 §3.6)', () => {
  it('finds collections the tree has loaded and recent places, and opens them', async () => {
    signIn()
    mockApi({})
    usePlacesStore().visit(collectionPlace('c1', 'shop', 'users'))
    const { queryClient } = mountApp(CommandPalette, { props: { open: true } })
    queryClient.setQueryData(queryKeys.connections, [CONN])
    queryClient.setQueryData(queryKeys.collections('c1', 'shop'), [
      { name: 'orders', type: 'collection', options: {}, readOnly: false },
    ])
    await nextTick()
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    input.value = 'orde'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    const groups = [...document.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))
    expect(groups[0]).toBe('Go to')
    expect(document.querySelector('[role="option"]')!.textContent).toContain('orders')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(useTabsStore().active?.params).toEqual({ connectionId: 'c1', db: 'shop', coll: 'orders' })
  })

  it('asks the assistant in Ask mode, only when it is offered, and sends nothing on its own', async () => {
    signIn()
    const { calls } = mockApi({})
    const { queryClient, wrapper } = mountApp(CommandPalette, { props: { open: true } })
    const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!
    await nextTick()
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(document.querySelector('[data-mode="ask"]')).toBeNull()
    queryClient.setQueryData(aiKeys.status, { enabled: true })
    await nextTick()
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(document.querySelector('[data-mode="ask"]')).not.toBeNull()
    input().value = 'Which customers ordered twice?'
    input().dispatchEvent(new Event('input'))
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    const assistant = useAssistantStore()
    expect(assistant.open).toBe(true)
    expect(assistant.pendingQuestion).toBe('Which customers ordered twice?')
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
