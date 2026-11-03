import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AppSidebar from '../src/workspace/AppSidebar.vue'
import { i18n } from '../src/i18n'
import { useLayoutStore } from '../src/stores/layout'
import { collectionPlace, connectionPlace, databasePlace, usePlacesStore } from '../src/stores/places'
import { usePreferencesStore } from '../src/stores/preferences'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'

const CONN = {
  id: 'c1',
  name: 'Production',
  group: null,
  color: 'green',
  favorite: false,
  readOnly: false,
  access: 'admin',
  permissions: [],
}
function signIn(permissions: string[]) {
  useSessionStore().me = {
    mode: 'team',
    user: { id: 'u1', username: 'ayse', role: 'admin' },
    permissions,
    csrfToken: 'c',
    readOnly: false,
    twoFactor: {},
  } as never
  useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
  usePlacesStore().bindUser('u1')
  useTabsStore().bindUser('u1')
}
async function mountSidebar(overlay = false) {
  mockApi({ 'GET connections': () => [200, [CONN]] })
  const mounted = mountApp(AppSidebar, {
    props: { assistantOffered: true, overlay },
  })
  await flushPromises()
  return mounted
}
const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  )

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
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AppSidebar (spec rev. 2 §3.1)', () => {
  // User request 2026-10-13: the assistant is a panel, not a page: its button is in the header.
  it('lists no assistant among its pages, its history still one', async () => {
    signIn([])
    await mountSidebar()
    expect(document.getElementById('assistant-toggle')).toBeNull()
    expect(buttonNamed('Assistant')).toBeUndefined()
    expect(document.querySelector('[data-sidebar-ai-history]')).not.toBeNull()
  })

  it('shows labelled items and collapses to a rail that keeps every item named', async () => {
    signIn(['connections:manage', 'audit:read', 'settings:manage'])
    const { wrapper } = await mountSidebar()
    const nav = wrapper.get('nav[aria-label="Application"]')
    expect(nav.text()).toContain('Overview')
    expect(nav.text()).toContain('Queries')
    expect(nav.text()).toContain('Connections')
    useLayoutStore().toggleSidebar()
    await nextTick()
    for (const name of ['Overview', 'Queries', 'Automations', 'Activity', 'Integrations', 'Expand sidebar'])
      expect(buttonNamed(name), name).toBeTruthy()
    expect(nav.text()).not.toContain('Overview')
    expect(nav.find('[role="tree"]').exists()).toBe(false)
  })

  it('opens after a reload only the group holding the open page, forgetting what was kept before', async () => {
    localStorage.setItem('mm:sidebar-groups', JSON.stringify({ automations: true, integrations: true }))
    signIn(['audit:read'])
    useTabsStore().open({ kind: 'audit', title: '' })
    await mountSidebar()
    expect(buttonNamed('Automations')!.getAttribute('aria-expanded')).toBe('false')
    expect(buttonNamed('Activity')!.getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('mm:sidebar-groups')).toBeNull()
  })

  // Review I4 (2026-10-10): as every other place, Queries closes the narrow screen's overlay.
  it('opens the Queries page from the overlay, closing it', async () => {
    const layout = useLayoutStore()
    layout.overlayOpen = true
    await mountSidebar(true)
    buttonNamed('Queries')!.click()
    await nextTick()
    expect(useTabsStore().active?.kind).toBe('library')
    expect(layout.overlayOpen).toBe(false)
  })

  it('opens groups in place, and as menus in the rail', async () => {
    signIn(['audit:read'])
    const { wrapper } = await mountSidebar()
    // Closed at first, so the connections stay in view; opened, it is remembered.
    const automations = buttonNamed('Automations')!
    expect(automations.getAttribute('aria-expanded')).toBe('false')
    expect(buttonNamed('Scheduled backups')).toBeUndefined()
    automations.click()
    await nextTick()
    expect(automations.getAttribute('aria-expanded')).toBe('true')
    expect(buttonNamed('Scheduled backups')).toBeTruthy()
    // User request 2026-10-10: not kept past a reload — closed again unless it holds the open page.
    expect(localStorage.getItem('mm:sidebar-groups')).toBeNull()
    // A group holding the open place shows it without being asked.
    useTabsStore().open({ kind: 'audit', title: '' })
    await nextTick()
    expect(buttonNamed('Activity')!.getAttribute('aria-expanded')).toBe('true')
    useLayoutStore().toggleSidebar()
    await nextTick()
    const menuButton = wrapper.get('button[aria-label="Activity"]')
    expect(menuButton.attributes('aria-haspopup')).toBe('menu')
    ;(menuButton.element as HTMLButtonElement).click()
    await flushPromises()
    const audit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) =>
      m.textContent?.includes('Audit log'),
    )!
    audit.click()
    expect(useTabsStore().active?.kind).toBe('audit')
  })

  it('shows Integrations to administrators only', async () => {
    signIn([])
    await mountSidebar()
    expect(buttonNamed('Integrations')).toBeUndefined()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    signIn(['settings:manage'])
    await mountSidebar()
    expect(buttonNamed('Integrations')).toBeTruthy()
    buttonNamed('Integrations')!.click()
    await nextTick()
    expect(buttonNamed('Backup destinations')).toBeTruthy()
  })

  it('pins from the tree, lists the pin, opens its place and unpins (spec rev. 2 §3.6)', async () => {
    signIn(['connections:manage'])
    const { wrapper } = await mountSidebar()
    ;(wrapper.get('button[aria-label="Actions for Production"]').element as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Pin')!
      .click()
    await nextTick()
    const pinned = wrapper.get('[data-test="pinned"]')
    expect(pinned.text()).toContain('Production')
    ;(
      pinned.findAll('button').find((b) => b.text().includes('Production'))!.element as HTMLButtonElement
    ).click()
    expect(useTabsStore().active?.params.connectionId).toBe('c1')
    ;(wrapper.get('button[aria-label="Unpin Production"]').element as HTMLButtonElement).click()
    await nextTick()
    expect(wrapper.find('[data-test="pinned"]').exists()).toBe(false)
  })

  // User report 2026-11-02: with four connections, a pinned collection said its database and name
  // only — which connection it was on was nowhere, not even in its tooltip.
  it("names a pinned database's or collection's connection, in the row and its tooltip", async () => {
    signIn([])
    const places = usePlacesStore()
    places.pin(collectionPlace('c1', 'shop', 'orders'))
    places.pin(databasePlace('c1', 'shop'))
    const { wrapper } = await mountSidebar()
    const rows = wrapper.get('[data-test="pinned"]').findAll('li > button:first-child')
    expect(rows.map((r) => r.text())).toEqual(['shop.orders Production', 'shop Production'])
    expect(rows.map((r) => r.attributes('title'))).toEqual(['Production › shop.orders', 'Production › shop'])
    expect(wrapper.find('button[aria-label="Unpin Production › shop.orders"]').exists()).toBe(true)
    // A connection's own pin says its name once.
    places.pin(connectionPlace(CONN))
    await nextTick()
    const own = wrapper.get('[data-test="pinned"]').findAll('li > button:first-child').at(-1)!
    expect(own.text()).toBe('Production')
  })

  it('changes theme, accent and language from Preferences, with no density choice', async () => {
    signIn([])
    await mountSidebar()
    buttonNamed('Preferences')!.click()
    await flushPromises()
    const prefs = usePreferencesStore()
    ;[...document.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((r) => r.textContent?.trim() === 'Dark')!
      .click()
    expect(prefs.theme).toBe('dark')
    document.querySelector<HTMLElement>('[role="radio"][aria-label="Indigo"]')!.click()
    expect(prefs.accent).toBe('indigo')
    // User review 2026-10-30: the density choice is gone.
    expect(document.body.textContent).not.toMatch(/density|compact|comfortable/i)
    const language = document.querySelector<HTMLSelectElement>('[data-test="language"] select')!
    language.value = 'tr'
    language.dispatchEvent(new Event('change'))
    expect(prefs.locale).toBe('tr')
  })

  it('brings Overview back from its item', async () => {
    signIn([])
    useTabsStore().open({ kind: 'audit', title: '' })
    await mountSidebar()
    buttonNamed('Overview')!.click()
    expect(useTabsStore().active?.kind).toBe('welcome')
  })
})
