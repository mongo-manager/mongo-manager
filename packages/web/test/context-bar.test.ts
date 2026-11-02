import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '../src/router'
import ContextBar from '../src/workspace/ContextBar.vue'
import { i18n } from '../src/i18n'
import { useJobsStore } from '../src/jobs/store'
import { useLayoutStore } from '../src/stores/layout'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'

const CONN = {
  id: 'c1',
  name: 'Production',
  group: null,
  color: 'green',
  favorite: false,
  readOnly: true,
  access: 'editor',
  permissions: [],
  restricted: true,
}
const SCHEDULE = {
  id: 's1',
  name: 'Nightly',
  state: 'paused',
  pause: { reason: 'admin', by: 'admin', byName: 'root' },
  lastRuns: [],
  mine: true,
}
function signIn(mode: 'team' | 'local') {
  const me = {
    mode,
    user: { id: 'u1', username: 'ayse', role: 'admin' },
    permissions: ['users:manage', 'audit:read'],
    csrfToken: 'c',
    readOnly: false,
    twoFactor: {},
  }
  useSessionStore().me = me as never
  useSessionStore().status = { mode, setupRequired: false, authenticated: true }
  useTabsStore().bindUser('u1')
  return me
}
/** Sign-out needs the router, as in the app. */
let router: ReturnType<typeof createAppRouter>
const mountBar = (props: Record<string, unknown> = {}) => {
  router = createAppRouter(createMemoryHistory())
  return mountApp(ContextBar, { plugins: [router], props })
}
const items = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((m) => m.textContent?.trim())

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

describe('ContextBar (spec rev. 2 §3.2)', () => {
  // User report 2026-10-25: the assistant opens from its own floating button, over the page — not
  // from the header.
  it('leaves the assistant to its floating button', async () => {
    signIn('team')
    mockApi({
      'GET connections': () => [200, []],
      'GET backup-schedules': () => [200, { enabled: true, schedules: [] }],
    })
    mountBar()
    await flushPromises()
    expect(document.getElementById('assistant-toggle')).toBeNull()
    expect(document.querySelector('[data-region="topbar"]')!.textContent).not.toContain('Assistant')
  })

  it('shows where the user is with the connection’s badges, and Local mode', async () => {
    signIn('local')
    mockApi({ 'GET connections': () => [200, [CONN]] })
    useTabsStore().open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const { wrapper } = mountBar()
    await flushPromises()
    const bar = wrapper.get('header[data-region="topbar"]')
    expect(bar.get('nav[aria-label="Location"]').text()).toContain('orders')
    for (const word of ['Read-only', 'Personal data hidden', 'editor', 'Local mode'])
      expect(bar.text()).toContain(word)
  })

  // User report 2026-10-27: rules on one database; the badge says "hidden" only where they reach — the
  // connection, that database, a collection of it (or a view of one: the server resolves it), a
  // bucket a rule reaches — never on every database of the connection.
  it('shows "personal data hidden" only where the rules reach', async () => {
    signIn('team')
    let rules = [{ db: 'crm', coll: 'people', field: 'email' }]
    mockApi({
      'GET connections': () => [200, [{ ...CONN, readOnly: false }]],
      'GET backup-schedules': () => [200, { enabled: true, schedules: [] }],
      // As the server answers (its own tests pin how): a database by its rules, a collection by its
      // own (a view of crm.people in reports, followed) or its database's, a bucket by what it reads.
      'GET connections/c1/personal-fields/applied': (_b, url) => {
        const db = url.searchParams.get('db')
        const coll = url.searchParams.get('coll')
        const bucket = url.searchParams.get('bucket')
        const inDb = (d: string) => rules.some((r) => r.db === '*' || r.db === d)
        if (!db) return [200, { rules, reaches: rules.length > 0 }]
        if (bucket)
          return [200, { rules, reaches: rules.some((r) => r.db === db && r.coll.startsWith(`${bucket}.`)) }]
        if (!coll) return [200, { rules, reaches: inDb(db) }]
        const view = db === 'reports' && coll === 'people_view'
        return [200, { rules, patterns: view ? [['email']] : [], reaches: view || inDb(db) }]
      },
    })
    const tabs = useTabsStore()
    const { wrapper, queryClient } = mountBar()
    const badge = async (kind: string, params: Record<string, string>) => {
      tabs.open({ kind, title: kind, params: { connectionId: 'c1', ...params } })
      await flushPromises()
      return wrapper.get('header[data-region="topbar"]').text().includes('Personal data hidden')
    }
    expect(await badge('connection', {})).toBe(true)
    expect(await badge('database', { db: 'crm' })).toBe(true)
    expect(await badge('database', { db: 'gridfs_demo' })).toBe(false)
    expect(await badge('collection', { db: 'crm', coll: 'people' })).toBe(true)
    // In the database the rules reach: a $lookup there reads the hidden values.
    expect(await badge('collection', { db: 'crm', coll: 'orders' })).toBe(true)
    expect(await badge('collection', { db: 'shop', coll: 'orders' })).toBe(false)
    expect(await badge('collection', { db: 'reports', coll: 'people_view' })).toBe(true)
    expect(await badge('gridfs', { db: 'gridfs_demo', bucket: 'fs' })).toBe(false)
    rules = [{ db: 'gridfs_demo', coll: 'fs.files', field: 'metadata.owner' }]
    await queryClient.invalidateQueries()
    expect(await badge('gridfs', { db: 'gridfs_demo', bucket: 'fs' })).toBe(true)
    expect(await badge('gridfs', { db: 'gridfs_demo', bucket: 'photos' })).toBe(false)
  })

  it('rings the bell for running jobs and things that need a person, and lists them', async () => {
    signIn('team')
    mockApi({
      'GET connections': () => [200, []],
      'GET backup-schedules': () => [200, { enabled: true, schedules: [SCHEDULE] }],
    })
    const { wrapper } = mountBar()
    useJobsStore().upsert({
      id: 'j1',
      kind: 'data.export',
      connectionId: 'c1',
      db: 'shop',
      coll: 'orders',
      targetConnectionId: null,
      target: 'shop.orders',
      state: 'running',
      progress: null,
      estimate: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      mine: true,
      cancellable: false,
    } as never)
    await flushPromises()
    const bell = wrapper.get('button[aria-label^="Background jobs"]')
    expect(bell.attributes('aria-label')).toBe('Background jobs, 1 running, 1 schedule needs attention')
    expect(wrapper.get('[data-test="jobs-badge"]').text()).toBe('1')
    ;(bell.element as HTMLButtonElement).click()
    await flushPromises()
    const panel = document.querySelector('[data-test="jobs-panel"]')!
    expect(panel.textContent).toContain('shop.orders')
    const link = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Scheduled backups'),
    )!
    link.click()
    expect(useTabsStore().active?.kind).toBe('schedules')
  })

  it('keeps the account’s own items, and signs out from its menu', async () => {
    const me = signIn('team')
    let signedIn = true
    const { calls } = mockApi({
      'GET connections': () => [200, []],
      'GET auth/me': () => [200, me],
      'POST auth/logout': () => {
        signedIn = false
        return [204]
      },
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: signedIn }],
    })
    const { wrapper } = mountBar()
    await flushPromises()
    ;(wrapper.get('button[aria-label^="Account menu for ayse"]').element as HTMLButtonElement).click()
    await flushPromises()
    expect(items()).toEqual(['Account settings', 'Users', 'Documentation', 'About Mongo Manager', 'Sign out'])
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Sign out')!
      .click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'auth/logout')).toBe(true)
    expect(useSessionStore().me).toBeNull()
    // The sign-in screen loads lazily: the test ends once it is there, not while it is still loading.
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'))
  })

  it('offers a way out of focus mode', async () => {
    signIn('local')
    mockApi({ 'GET connections': () => [200, []] })
    const { wrapper } = mountBar()
    // Its queries settle under the mock, never after it (a request to nowhere).
    await flushPromises()
    expect(wrapper.find('button[aria-label="Exit focus mode"]').exists()).toBe(false)
    useLayoutStore().toggleFocus()
    await nextTick()
    await wrapper.get('button[aria-label="Exit focus mode"]').trigger('click')
    expect(useLayoutStore().focusMode).toBe(false)
  })
})
