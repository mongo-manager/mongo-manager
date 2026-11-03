import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'
import { pick } from './support/pickers'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const entry = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  at: Date.UTC(2026, 8, 26, 10, 0, id % 60),
  userId: 'u1',
  username: 'ada',
  ip: '127.0.0.1',
  action: 'documents.update',
  connectionId: 'c1',
  namespace: 'shop.orders',
  outcome: 'success',
  details: { _id: id },
  ...extra,
})

describe('audit log', () => {
  it('pages with beforeId, filters by action and user, and shows details', async () => {
    const urls: URL[] = []
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ada', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [
        200,
        [
          {
            id: 'c1',
            name: 'Prod',
            group: null,
            color: null,
            favorite: false,
            readOnly: false,
            settings: {},
            uri: '',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: null,
            access: 'admin',
            permissions: [],
          },
        ],
      ],
      'GET users': () => [
        200,
        [
          {
            id: 'u1',
            username: 'ada',
            role: 'admin',
            totpEnabled: false,
            disabled: false,
            createdAt: 0,
            passwordChangedAt: 0,
          },
        ],
      ],
      'GET audit': (_b, url) => {
        urls.push(url)
        const before = Number(url.searchParams.get('beforeId') ?? 1000)
        const list = Array.from({ length: 50 }, (_, i) => entry(before - 1 - i))
        if (url.searchParams.get('action'))
          return [
            200,
            [entry(7, { action: 'users.create', outcome: 'denied', connectionId: null, namespace: null })],
          ]
        return [200, before < 900 ? list.slice(0, 3) : list]
      },
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser('u1')
    tabs.open({ kind: 'audit', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    await vi.waitFor(() => expect(document.querySelectorAll('main tbody tr[data-entry]').length).toBe(50))
    expect(document.querySelector('main tbody')!.textContent).toContain('Prod')
    expect(document.querySelector('main tbody')!.textContent).toContain('shop.orders')
    button('Load more').click()
    await flushPromises()
    expect(urls.at(-1)!.searchParams.get('beforeId')).toBe('950')
    await pick('data-audit-action-filter', 'Add a user')
    await choose(byLabel<HTMLSelectElement>('User'), 'u1')
    button('Filter').click()
    await flushPromises()
    expect(Object.fromEntries(urls.at(-1)!.searchParams)).toEqual({
      limit: '50',
      action: 'users.create',
      userId: 'u1',
    })
    expect(document.querySelector('main tbody')!.textContent).toContain('denied')
    ;(document.querySelector('button[aria-label="Show details"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('main tbody pre')!.textContent).toContain('"_id": 7')

    // Connection and date range (audit minor): whole local days, sent as instants.
    await pick('data-audit-action-filter', 'Any action')
    await choose(byLabel<HTMLSelectElement>('User'), '')
    await choose(byLabel<HTMLSelectElement>('Connection'), 'c1')
    await typeInto(byLabel('From'), '2026-09-01')
    await typeInto(byLabel('To'), '2026-09-26')
    button('Filter').click()
    await flushPromises()
    const params = Object.fromEntries(urls.at(-1)!.searchParams)
    expect(params).toMatchObject({ connectionId: 'c1' })
    expect(Date.parse(params.from!)).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).getTime())
    expect(Date.parse(params.to!)).toBe(new Date(2026, 8, 26, 23, 59, 59, 999).getTime())
    const before = urls.length
    await typeInto(byLabel('From'), '2026-09-27')
    button('Filter').click()
    await flushPromises()
    expect(document.body.textContent).toContain('The start date is after the end date.')
    expect(urls.length).toBe(before)

    // A date the browser lets through but Date cannot represent (final review 1g-3, Minor 8).
    // Chrome accepts years up to 275760 in a date input; happy-dom sanitises them away, so the field
    // is typed as text here to deliver the value a real browser would.
    await typeInto(byLabel('From'), '')
    byLabel('To').type = 'text'
    await typeInto(byLabel('To'), '20260-01-01')
    button('Filter').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Enter a date between the years 1 and 9999.')
    expect(urls.length).toBe(before)
  })
})

// UI redesign R2–R5 spec §2: the log is a named table, and a failure to read it offers a Retry.
describe('audit log page patterns', () => {
  it('names its table, and reads the log again on Retry after a failure', async () => {
    let fail = true
    const { calls } = mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ada', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, []],
      'GET users': () => [200, []],
      'GET audit': () => (fail ? [500, { code: 'INTERNAL', message: 'boom' }] : [200, [entry(1)]]),
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser('u1')
    tabs.open({ kind: 'audit', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    await vi.waitFor(() => expect(document.querySelector('main [role="alert"]')).not.toBeNull())
    expect(document.querySelector('main table')).toBeNull()
    fail = false
    button('Retry').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'GET' && c.path === 'audit')).toHaveLength(2)
    expect(document.querySelector('main table')!.getAttribute('aria-label')).toBe('Audit log')
    expect(document.querySelectorAll('main tbody tr[data-entry]')).toHaveLength(1)
  })
})

// Security audit 2026-10-16: an audit log altered outside the app says where its chain broke.
describe('the audit chain', () => {
  async function auditTab(integrity: unknown) {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ada', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, []],
      'GET users': () => [200, []],
      'GET audit': () => [200, [entry(1)]],
      'GET audit/integrity': () => [200, integrity],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser('u1')
    tabs.open({ kind: 'audit', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    await vi.waitFor(() => expect(document.querySelectorAll('main tbody tr[data-entry]')).toHaveLength(1))
    await flushPromises()
  }

  it('says nothing while the chain checks', async () => {
    await auditTab({ ok: true, brokenAt: null, legacy: 0 })
    expect(document.querySelector('[data-audit-chain-broken]')).toBeNull()
    expect(document.querySelector('[data-audit-chain-legacy]')).toBeNull()
  })

  // Review of the audit fixes (important 4): the entries the chain does not cover are said.
  it('says how many entries were written before the chain', async () => {
    await auditTab({ ok: true, brokenAt: null, legacy: 1200 })
    expect(document.querySelector('[data-audit-chain-legacy]')!.textContent).toContain(
      '1200 entries were written before the audit log was chained',
    )
  })

  it('says where it broke, in the user language', async () => {
    i18n.global.locale.value = 'tr'
    await auditTab({ ok: false, brokenAt: { id: 42, at: Date.UTC(2026, 9, 16, 9) }, legacy: 0 })
    const callout = document.querySelector('[data-audit-chain-broken]')!
    expect(callout.textContent).toContain('Denetim kaydı Mongo Manager dışında değiştirilmiş')
    expect(callout.textContent).toContain('42 numaralı kayıtta')
  })
})
